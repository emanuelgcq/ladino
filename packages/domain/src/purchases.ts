import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal, type Decimal, type RoundingPolicy } from "@ladino/money";
import {
  allocateLandedCost,
  computeRetention,
  matchThreeWay,
  type AllocatableLine,
  type MatchInput,
  type RetentionFormula,
} from "@ladino/purchases";
import type {
  CreateSupplierRequest,
  SupplierResponse,
  CreatePurchaseOrderRequest,
  PurchaseOrderResponse,
  ReceiveGoodsRequest,
  GoodsReceiptResponse,
  RegisterSupplierInvoiceRequest,
  SupplierInvoiceResponse,
  ApplyLandedCostRequest,
  LandedCostResponse,
  RegisterSupplierCreditNoteRequest,
  RegisterSupplierPaymentRequest,
  SupplierPaymentResponse,
  SimplePurchaseRequest,
  SimplePurchaseResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { receiveStock, revalueStock } from "./inventory.js";
import { resolverCuentaEfectivo } from "./treasury.js";
import { generateJournalFromDocument } from "./journal-generator.js";

/**
 * Casos de uso de COMPRAS — RIGOR MÁXIMO. Es la contraparte de ventas y toca el
 * costeo real: **un costo unitario mal calculado aquí se propaga a todas las
 * ventas posteriores de ese producto y no falla nada**, solo el margen sale mal
 * para siempre. De ahí que el prorrateo esté en un paquete puro con property
 * tests y que la retención tenga oráculo en SQL.
 *
 * Lo que este módulo NO decide:
 *   · el porcentaje de retención lo resuelve `platform.resolve_retention()`
 *     (ADR-0039) y la retención lo COPIA. Sin regla, no se retiene: se para;
 *   · si el IVA es crédito o costo lo dice el `taxpayer_type_code` de la
 *     EMPRESA, no una preferencia (ADR-0040 §7);
 *   · la tasa sale de `exchange_rates` con su fuente, a la fecha de la
 *     RECEPCIÓN — no de la orden ni de la factura.
 */
export type PurchaseError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "RETENTION_RULE_MISSING"; message: string }
  | { code: "TAX_RULE_MISSING"; message: string }
  | { code: "EXCHANGE_RATE_MISSING"; message: string }
  | { code: "MISSING_WEIGHT"; message: string }
  | { code: "PRICE_ABOVE_TOLERANCE"; message: string }
  | { code: "FISCAL_NUMBERING_INVALID"; message: string }
  | { code: "NEGATIVE_STOCK"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string };

const POLICY: RoundingPolicy = { id: "purchases:document:8:HALF_UP", scale: 8, mode: "HALF_UP" };
const JURISDICTION = "VE";

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
  readonly companyTaxpayerType: string | null;
}

function traducir(e: unknown): PurchaseError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD53") return { code: "RETENTION_RULE_MISSING", message };
  if (code === "LAD54" || code === "LAD49") return { code: "FISCAL_NUMBERING_INVALID", message };
  if (code === "LAD50") return { code: "TAX_RULE_MISSING", message };
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "LAD67") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD39") return { code: "NEGATIVE_STOCK", message };
  if (code === "23505") {
    return {
      code: "DUPLICATE",
      message:
        "Ese documento de ese proveedor ya está cargado: cargarlo dos veces sería pagarlo dos veces.",
    };
  }
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  return null;
}

async function autorizar(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
  almacenes: readonly string[] = [],
): Promise<Result<Contexto, PurchaseError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  // El alcance por ALMACÉN, cuando el permiso es acotado (LAD25). `purchase.receive`
  // lo es: recibir mueve stock, y se recibe donde se tiene binding.
  for (const almacen of almacenes) {
    const [alcance] = await sql<{ autorizado: boolean }[]>`
      select platform.ladino_user_has_scope(${userId}, ${permiso}, 'warehouse', ${almacen})
             as autorizado`;
    if (!alcance?.autorizado) {
      return err({
        code: "PERMISSION_REQUIRED",
        message: `La operación exige el permiso ${permiso} sobre ese almacén concreto.`,
      });
    }
  }
  const [cfg] = await sql<{ moneda: string; tipo: string | null }[]>`
    select functional_currency_code as moneda, taxpayer_type_code as tipo
      from public.companies where id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok({
    tenantId: scope.value.tenantId,
    functionalCurrency: cfg.moneda,
    companyTaxpayerType: cfg.tipo,
  });
}

/** La tasa vigente a una fecha, con su fuente. Sin tasa NO se compra. */
async function tasaA(
  sql: TransactionSql,
  desde: string,
  hasta: string,
  fecha: string,
): Promise<Result<{ rate: Decimal; source: string }, PurchaseError>> {
  if (desde === hasta) {
    const uno = parseDecimal("1");
    if (!uno.ok) return err({ code: "VALIDATION_FAILED", message: uno.error.message });
    return ok({ rate: uno.value, source: "identidad" });
  }
  const [t] = await sql<{ rate: string | null; source: string | null }[]>`
    select r.rate::text as rate, r.source from public.exchange_rates r
     where r.from_currency = ${desde} and r.to_currency = ${hasta}
       and r.rate_date <= ${fecha}::date
     order by r.rate_date desc, r.created_at desc limit 1`;
  if (!t?.rate) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: `No hay tasa de ${desde} a ${hasta} vigente para esa fecha. Cárgala con su fuente antes de continuar.`,
    });
  }
  const d = parseDecimal(t.rate);
  if (!d.ok) return err({ code: "VALIDATION_FAILED", message: d.error.message });
  return ok({ rate: d.value, source: t.source ?? "manual" });
}

function aFuncional(m: Money, tasa: Decimal, funcional: string): Result<Money, PurchaseError> {
  const c = Money.of(m.multiply(tasa).amount.toDecimalPlaces(8, 4).toFixed(8), funcional);
  if (!c.ok) return err({ code: "VALIDATION_FAILED", message: c.error.message });
  return ok(c.value);
}

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  aggregateType: string,
  aggregateId: string,
  evento: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, ${aggregateType}, ${aggregateId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${companyId}, ${aggregateType}, ${aggregateId}, ${evento}, 1,
            ${sql.json({ id: aggregateId, ...payload })})`;
}

// ── Proveedores ─────────────────────────────────────────────────────────────

export async function createSupplier(
  uow: UnitOfWork,
  input: CreateSupplierRequest,
): Promise<Result<SupplierResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Crear proveedores exige un usuario real.",
    });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "supplier.manage");
  if (!ctx.ok) return ctx;

  const extranjero = input.supplier_kind === "extranjero";
  // La forma fiscal la impone el esquema con dos CHECK; aquí se traduce a un
  // mensaje que dice QUÉ falta, en vez de dejar salir un 23514 opaco.
  if (!extranjero && (input.tax_id ?? null) === null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Un proveedor nacional necesita RIF: sin él no se puede llevar al libro de compras ni practicarle retención.",
    });
  }
  if (!extranjero && (!input.person_type_code || !input.taxpayer_type_code)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un proveedor nacional necesita tipo de persona y clasificación de contribuyente.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [s] = await sp<SupplierResponse[]>`
        insert into public.suppliers
          (tenant_id, company_id, tax_id, legal_name, trade_name, supplier_kind,
           person_type_code, taxpayer_type_code, fiscal_address, email, phone,
           payment_terms_days)
        values (${ctx.value.tenantId}, ${input.company_id},
                ${extranjero ? null : (input.tax_id ?? null)}, ${input.legal_name},
                ${input.trade_name ?? null}, ${input.supplier_kind},
                ${extranjero ? null : (input.person_type_code ?? null)},
                ${extranjero ? null : (input.taxpayer_type_code ?? null)},
                ${input.fiscal_address ?? null}, ${input.email ?? null}, ${input.phone ?? null},
                ${input.payment_terms_days ?? 0})
        returning id, company_id, tax_id, legal_name, trade_name, supplier_kind,
                  person_type_code, taxpayer_type_code, fiscal_address, email, phone, status,
                  payment_terms_days::int as payment_terms_days`;
      return s!;
    });
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "supplier",
      fila.id,
      "supplier.created",
      {
        legal_name: fila.legal_name,
        tax_id: fila.tax_id,
        supplier_kind: fila.supplier_kind,
      },
    );
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) {
      return err(
        conocido.code === "DUPLICATE"
          ? { code: "DUPLICATE", message: "Ya existe un proveedor con ese RIF en esta empresa." }
          : conocido,
      );
    }
    throw e;
  }
}

// ── Orden de compra ─────────────────────────────────────────────────────────

export async function createPurchaseOrder(
  uow: UnitOfWork,
  input: CreatePurchaseOrderRequest,
): Promise<Result<PurchaseOrderResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ordenar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.order.manage");
  if (!ctx.ok) return ctx;

  const hoy = new Date().toISOString();
  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, hoy);
  if (!tasa.ok) return tasa;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const orden = await sql.savepoint(async (sp) => {
      // NACE EN BORRADOR y se confirma al final, con los totales, en un solo
      // UPDATE. No es cosmética: `assert_purchase_doc_immutable()` bloquea
      // cualquier edición de un documento ya confirmado, y eso incluye el
      // UPDATE con el que este mismo caso de uso rellena los importes. Crear
      // confirmado y corregir después es exactamente lo que el trigger existe
      // para impedir — y tiene razón.
      const [o] = await sp<{ id: string }[]>`
        insert into public.purchase_orders
          (tenant_id, company_id, branch_id, supplier_id, warehouse_id, status,
           expected_at, transaction_currency, functional_currency, fx_rate,
           rate_source, rate_timestamp, rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.branch_id ?? null},
                ${input.supplier_id}, ${input.warehouse_id}, 'draft',
                ${input.expected_at ?? null}, ${input.currency}, ${ctx.value.functionalCurrency},
                ${tasa.value.rate.toFixed()}, ${tasa.value.source}, now(), ${POLICY.id})
        returning id`;

      let n = 0;
      const totalTxn = parseDecimal("0");
      if (!totalTxn.ok) throw new Error("imposible");
      let acumulado = totalTxn.value;
      for (const l of input.lines) {
        n += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        if (!cantidad.ok || !precio.ok) throw new Error("importe no interpretable");
        const totalLinea = precio.value.multiply(cantidad.value);
        const totalRedondeado = Money.of(
          totalLinea.amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!totalRedondeado.ok) throw new Error("importe fuera de rango");
        const func = aFuncional(
          totalRedondeado.value,
          tasa.value.rate,
          ctx.value.functionalCurrency,
        );
        const precioFunc = aFuncional(precio.value, tasa.value.rate, ctx.value.functionalCurrency);
        if (!func.ok || !precioFunc.ok) throw new Error("conversión fuera de rango");
        acumulado = acumulado.plus(totalRedondeado.value.amount);

        const [p] = await sp<{ name: string }[]>`
          select name from public.products
           where id = ${l.product_id} and company_id = ${input.company_id}`;
        if (!p) throw new Error("producto no encontrado");

        await sp`
          insert into public.purchase_order_lines
            (tenant_id, company_id, purchase_order_id, line_number, product_id, description,
             quantity, unit_price_transaction, unit_price_functional, line_total_transaction,
             line_total_functional, unit_weight, amount_transaction_currency,
             transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
             rate_timestamp, rounding_policy_id)
          values (${ctx.value.tenantId}, ${input.company_id}, ${o!.id}, ${n}, ${l.product_id},
                  ${l.description ?? p.name}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${precioFunc.value.toAmountString()},
                  ${totalRedondeado.value.toAmountString()}, ${func.value.toAmountString()},
                  ${l.unit_weight ?? null}, ${totalRedondeado.value.toAmountString()},
                  ${input.currency}, ${tasa.value.rate.toFixed()}, ${func.value.toAmountString()},
                  ${ctx.value.functionalCurrency}, ${tasa.value.source}, now(), ${POLICY.id})`;
      }

      const totalMoney = Money.of(acumulado.toFixed(8), input.currency);
      if (!totalMoney.ok) throw new Error("total fuera de rango");
      const totalFunc = aFuncional(totalMoney.value, tasa.value.rate, ctx.value.functionalCurrency);
      if (!totalFunc.ok) throw new Error("total funcional fuera de rango");
      const [num] = await sp<{ n: string }[]>`
        select (coalesce(max(order_number), 0) + 1)::text as n
          from public.purchase_orders where company_id = ${input.company_id}`;
      const [actualizada] = await sp<PurchaseOrderResponse[]>`
        update public.purchase_orders
           set amount_transaction_currency = ${totalMoney.value.toAmountString()},
               functional_amount = ${totalFunc.value.toAmountString()},
               status = 'pending', ordered_at = now(), order_number = ${num!.n}::bigint
         where id = ${o!.id}
        returning id, company_id, supplier_id, warehouse_id,
                  order_number::int as order_number, status,
                  to_char(ordered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ordered_at,
                  expected_at::text as expected_at, transaction_currency, functional_currency,
                  fx_rate::text as fx_rate, rate_source,
                  amount_transaction_currency::text as amount_transaction_currency,
                  functional_amount::text as functional_amount`;
      return actualizada!;
    });
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "purchase_order",
      orden.id,
      "purchase.order.created",
      {
        supplier_id: input.supplier_id,
        order_number: orden.order_number,
        total: orden.amount_transaction_currency,
        currency: orden.transaction_currency,
      },
    );
    return ok(orden);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    if (e instanceof Error && !("code" in e)) {
      return err({ code: "VALIDATION_FAILED", message: e.message });
    }
    throw e;
  }
}

// ── Recepción ───────────────────────────────────────────────────────────────

/**
 * Recibe mercancía, total o parcialmente. Es el documento que MUEVE STOCK y
 * FIJA EL COSTO: la tasa es la vigente a la fecha de la recepción (ADR-0040 §4),
 * no la de la orden ni la de la factura, porque este es el momento en que el
 * inventario incorpora costo.
 */
export async function receiveGoods(
  uow: UnitOfWork,
  input: ReceiveGoodsRequest,
): Promise<Result<GoodsReceiptResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Recibir exige un usuario real." });
  }
  // ACOTADO por almacén: se recibe donde se tiene binding (LAD25).
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.receive", [
    input.warehouse_id,
  ]);
  if (!ctx.ok) return ctx;

  const fecha = input.received_at ?? new Date().toISOString();
  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, fecha);
  if (!tasa.ok) return tasa;

  // No se recibe más de lo pendiente: la recepción parcial es legítima, recibir
  // de más es un error que después nadie sabe si fue robo o dedo.
  for (const l of input.lines) {
    if (l.purchase_order_line_id === undefined) continue;
    const [prog] = await sql<{ pendiente: string }[]>`
      select quantity_pending::text as pendiente
        from platform.purchase_order_progress(${input.company_id},
             (select purchase_order_id from public.purchase_order_lines
               where id = ${l.purchase_order_line_id}))
       where order_line_id = ${l.purchase_order_line_id}`;
    const pendiente = parseDecimal(prog?.pendiente ?? "0");
    const recibiendo = parseDecimal(l.quantity);
    if (!pendiente.ok || !recibiendo.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad no interpretable." });
    }
    if (recibiendo.value.greaterThan(pendiente.value)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `Se intenta recibir ${recibiendo.value.toFixed()} y solo quedan ${pendiente.value.toFixed()} pendientes en esa línea de la orden.`,
      });
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  let recepcion: GoodsReceiptResponse;
  try {
    recepcion = await sql.savepoint(async (sp) => {
      // Borrador primero, confirmada al final: el trigger de inmutabilidad no
      // deja rellenar los totales de una recepción ya confirmada.
      const [r] = await sp<{ id: string }[]>`
        insert into public.goods_receipts
          (tenant_id, company_id, supplier_id, purchase_order_id, warehouse_id,
           status, delivery_note_ref, transaction_currency, functional_currency,
           fx_rate, rate_source, rate_timestamp, rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.supplier_id},
                ${input.purchase_order_id ?? null}, ${input.warehouse_id},
                'draft', ${input.delivery_note_ref ?? null}, ${input.currency},
                ${ctx.value.functionalCurrency}, ${tasa.value.rate.toFixed()},
                ${tasa.value.source}, now(), ${POLICY.id})
        returning id`;

      let n = 0;
      const acumulado = parseDecimal("0");
      if (!acumulado.ok) throw new Error("imposible");
      let total = acumulado.value;
      for (const l of input.lines) {
        n += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        if (!cantidad.ok || !precio.ok) throw new Error("importe no interpretable");
        const costoUnitFunc = aFuncional(
          precio.value,
          tasa.value.rate,
          ctx.value.functionalCurrency,
        );
        if (!costoUnitFunc.ok) throw new Error("conversión fuera de rango");
        const totalLinea = Money.of(
          precio.value.multiply(cantidad.value).amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!totalLinea.ok) throw new Error("importe fuera de rango");
        const totalFunc = aFuncional(
          totalLinea.value,
          tasa.value.rate,
          ctx.value.functionalCurrency,
        );
        if (!totalFunc.ok) throw new Error("conversión fuera de rango");
        total = total.plus(totalLinea.value.amount);

        await sp`
          insert into public.goods_receipt_lines
            (tenant_id, company_id, goods_receipt_id, line_number, purchase_order_line_id,
             product_id, quantity, unit_price_transaction, unit_cost_functional, unit_weight,
             amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
             functional_currency, rate_source, rate_timestamp, rounding_policy_id)
          values (${ctx.value.tenantId}, ${input.company_id}, ${r!.id}, ${n},
                  ${l.purchase_order_line_id ?? null}, ${l.product_id}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${costoUnitFunc.value.toAmountString()},
                  ${l.unit_weight ?? null}, ${totalLinea.value.toAmountString()},
                  ${input.currency}, ${tasa.value.rate.toFixed()},
                  ${totalFunc.value.toAmountString()}, ${ctx.value.functionalCurrency},
                  ${tasa.value.source}, now(), ${POLICY.id})`;
      }

      const totalMoney = Money.of(total.toFixed(8), input.currency);
      if (!totalMoney.ok) throw new Error("total fuera de rango");
      const totalFuncional = aFuncional(
        totalMoney.value,
        tasa.value.rate,
        ctx.value.functionalCurrency,
      );
      if (!totalFuncional.ok) throw new Error("total funcional fuera de rango");
      const [num] = await sp<{ n: string }[]>`
        select (coalesce(max(receipt_number), 0) + 1)::text as n
          from public.goods_receipts where company_id = ${input.company_id}`;
      const [actualizada] = await sp<GoodsReceiptResponse[]>`
        update public.goods_receipts
           set amount_transaction_currency = ${totalMoney.value.toAmountString()},
               functional_amount = ${totalFuncional.value.toAmountString()},
               status = 'confirmed', received_at = ${fecha},
               receipt_number = ${num!.n}::bigint
         where id = ${r!.id}
        returning id, company_id, supplier_id, purchase_order_id, warehouse_id,
                  receipt_number::int as receipt_number, status,
                  to_char(received_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at,
                  delivery_note_ref, transaction_currency, functional_currency,
                  fx_rate::text as fx_rate, rate_source,
                  functional_amount::text as functional_amount`;
      return actualizada!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    if (e instanceof Error && !("code" in e)) {
      return err({ code: "VALIDATION_FAILED", message: e.message });
    }
    throw e;
  }

  // El kardex, en la MISMA transacción y al costo funcional de la recepción.
  // `receiveStock` recibe el importe TOTAL, no el unitario.
  for (const l of input.lines) {
    const [p] = await sql<{ kind: string; is_composed: boolean }[]>`
      select kind, is_composed from public.products where id = ${l.product_id}`;
    if (p?.kind !== "good" || p.is_composed) continue;
    const cantidad = parseDecimal(l.quantity);
    const precio = Money.of(l.unit_price, input.currency);
    if (!cantidad.ok || !precio.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe no interpretable." });
    }
    const totalTxn = precio.value.multiply(cantidad.value);
    const totalFunc = totalTxn.amount.times(tasa.value.rate).toDecimalPlaces(8, 4);
    const mov = await receiveStock(uow, {
      company_id: input.company_id,
      warehouse_id: input.warehouse_id,
      product_id: l.product_id,
      quantity: l.quantity,
      amount: totalFunc.toFixed(8),
      currency: ctx.value.functionalCurrency,
      ...(l.lot_code !== undefined ? { lot_code: l.lot_code } : {}),
      ...(l.lot_expires_at !== undefined ? { lot_expires_at: l.lot_expires_at } : {}),
      sourceDocumentId: recepcion.id,
    });
    if (!mov.ok) return err({ code: "VALIDATION_FAILED", message: mov.error.message });
  }

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "goods_receipt",
    recepcion.id,
    "purchase.goods_received",
    {
      supplier_id: input.supplier_id,
      warehouse_id: input.warehouse_id,
      purchase_order_id: input.purchase_order_id ?? null,
      receipt_number: recepcion.receipt_number,
      fx_rate: recepcion.fx_rate,
      rate_source: recepcion.rate_source,
    },
  );
  return ok(recepcion);
}

// ── Factura del proveedor y retenciones ─────────────────────────────────────

export async function registerSupplierInvoice(
  uow: UnitOfWork,
  input: RegisterSupplierInvoiceRequest,
): Promise<Result<SupplierInvoiceResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.invoice.register");
  if (!ctx.ok) return ctx;

  const [prov] = await sql<
    { supplier_kind: string; taxpayer_type_code: string | null; person_type_code: string | null }[]
  >`select supplier_kind, taxpayer_type_code, person_type_code from public.suppliers
     where id = ${input.supplier_id} and company_id = ${input.company_id}`;
  if (!prov) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  // La identificación del emisor: o control (nacional) o referencia (extranjero).
  if (input.supplier_control_number === undefined && input.supplier_document_ref === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La factura necesita el número de control del proveedor o, si es extranjero, la referencia de su documento origen: sin ninguno no es asentable en el libro de compras.",
    });
  }

  /**
   * ADR-0040 §7 · VALIDAR-TRIBUTARIO. Para contribuyente ORDINARIO el IVA
   * soportado es crédito fiscal y NO entra al costo del inventario; para
   * FORMAL no es recuperable y sí lo es. Se DERIVA del régimen de la empresa,
   * no se configura: ofrecerlo como opción invitaría a marcarlo mal, y
   * marcarlo mal cambia el costo de todo lo comprado.
   */
  if (ctx.value.companyTaxpayerType === null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La empresa no tiene clasificación tributaria propia y sin ella no se sabe si el IVA de la compra es crédito fiscal o costo. Asígnala antes de registrar facturas.",
    });
  }
  const ivaRecuperable = ctx.value.companyTaxpayerType === "ordinario";

  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, input.invoice_date);
  if (!tasa.ok) return tasa;

  // Matching de tres vías ANTES de asentar. La política llega de la empresa.
  const [cfg] = await sql<{ tol: string }[]>`
    select coalesce(s.price_tolerance_pct, 5)::numeric(24,8)::text as tol
      from public.companies c
      left join public.purchase_settings s on s.company_id = c.id
     where c.id = ${input.company_id}`;
  const tolerancia = parseDecimal(cfg?.tol ?? "5");
  if (!tolerancia.ok) return err({ code: "VALIDATION_FAILED", message: tolerancia.error.message });

  const entradas: MatchInput[] = [];
  for (const [i, l] of input.lines.entries()) {
    const cantidad = parseDecimal(l.quantity);
    const precio = parseDecimal(l.unit_price);
    if (!cantidad.ok || !precio.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe no interpretable." });
    }
    let qOrdenada: Decimal | null = null;
    let qRecibida: Decimal | null = null;
    let pOrdenado: Decimal | null = null;
    if (l.goods_receipt_line_id !== undefined) {
      const [rl] = await sql<
        { recibida: string; ordenada: string | null; precio_orden: string | null }[]
      >`select rl.quantity::text as recibida, ol.quantity::text as ordenada,
               ol.unit_price_transaction::text as precio_orden
          from public.goods_receipt_lines rl
          left join public.purchase_order_lines ol on ol.id = rl.purchase_order_line_id
         where rl.id = ${l.goods_receipt_line_id} and rl.company_id = ${input.company_id}`;
      if (!rl) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
      const r = parseDecimal(rl.recibida);
      if (r.ok) qRecibida = r.value;
      if (rl.ordenada !== null) {
        const o = parseDecimal(rl.ordenada);
        if (o.ok) qOrdenada = o.value;
      }
      if (rl.precio_orden !== null) {
        const p = parseDecimal(rl.precio_orden);
        if (p.ok) pOrdenado = p.value;
      }
    }
    entradas.push({
      lineId: `L${i + 1}`,
      quantityOrdered: qOrdenada,
      quantityReceived: qRecibida,
      quantityInvoiced: cantidad.value,
      priceOrdered: pOrdenado,
      priceInvoiced: precio.value,
    });
  }
  const match = matchThreeWay({ lines: entradas, priceTolerancePct: tolerancia.value });
  if (!match.ok) return err({ code: "VALIDATION_FAILED", message: match.error.message });

  const fuera = match.value.filter((r) => r.requiresApproval);
  if (fuera.length > 0) {
    // Fuera del umbral hace falta un permiso propio Y decirlo explícitamente en
    // el cuerpo. Que la pantalla lo pida no basta: se comprueba en servidor.
    const [permiso] = await sql<{ ok: boolean }[]>`
      select platform.ladino_user_has_permission(${actor.userId},
             'purchase.price_variance.approve', ${input.company_id}) as ok`;
    if (input.approve_price_variance !== true || !permiso?.ok) {
      return err({
        code: "PRICE_ABOVE_TOLERANCE",
        message: `${fuera.length} línea(s) tienen un precio fuera del ${tolerancia.value.toFixed()} % acordado en la orden. Requiere el permiso purchase.price_variance.approve y aprobarlo explícitamente.`,
      });
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let facturaId = "";
  let falloRetencion: PurchaseError | null = null;
  try {
    facturaId = await sql.savepoint(async (sp) => {
      const [f] = await sp<{ id: string }[]>`
        insert into public.supplier_invoices
          (tenant_id, company_id, supplier_id, purchase_order_id, supplier_document_number,
           supplier_control_number, supplier_document_ref, invoice_date, due_date, status,
           posted_at, tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
           rate_source, rate_timestamp, rounding_policy_id, rules_version, notes)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.supplier_id},
                ${input.purchase_order_id ?? null}, ${input.supplier_document_number},
                ${input.supplier_control_number ?? null}, ${input.supplier_document_ref ?? null},
                ${input.invoice_date}::date, ${input.due_date ?? null}, 'draft', null,
                ${ivaRecuperable}, ${input.currency}, ${ctx.value.functionalCurrency},
                ${tasa.value.rate.toFixed()}, ${tasa.value.source}, now(), ${POLICY.id},
                ${RULES_VERSION}, ${input.notes ?? null})
        returning id`;

      let n = 0;
      const subtotal = parseDecimal("0");
      const impuesto = parseDecimal("0");
      if (!subtotal.ok || !impuesto.ok) throw new Error("imposible");
      let sub = subtotal.value;
      let imp = impuesto.value;

      for (const l of input.lines) {
        n += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        if (!cantidad.ok || !precio.ok) throw new Error("importe no interpretable");

        const [producto] = await sp<{ name: string; tax_category_code: string }[]>`
          select name, tax_category_code from public.products where id = ${l.product_id}`;
        if (!producto) throw new Error("producto no encontrado");

        // La alícuota de COMPRA sale del mismo motor que la de venta, con
        // transaction_type='purchase' (ADR-0038). Sin regla no hay factura.
        let taxRuleId: string | null = null;
        let tasaImp = parseDecimal("0");
        if (prov.supplier_kind === "nacional") {
          const [regla] = await sp<{ tax_rule_id: string; rate: string }[]>`
            select tax_rule_id, rate::text as rate
              from platform.resolve_tax(${input.invoice_date}::date, ${JURISDICTION}, 'iva',
                                        ${prov.taxpayer_type_code},
                                        ${producto.tax_category_code}, 'purchase')`;
          taxRuleId = regla!.tax_rule_id;
          tasaImp = parseDecimal(regla!.rate);
        }
        if (!tasaImp.ok) throw new Error("alícuota no interpretable");

        const base = Money.of(
          precio.value.multiply(cantidad.value).amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!base.ok) throw new Error("base fuera de rango");
        const impLinea = Money.of(
          base.value.multiply(tasaImp.value).amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!impLinea.ok) throw new Error("impuesto fuera de rango");
        const totalLinea = base.value.amount.plus(impLinea.value.amount);
        sub = sub.plus(base.value.amount);
        imp = imp.plus(impLinea.value.amount);

        const precioFunc = aFuncional(precio.value, tasa.value.rate, ctx.value.functionalCurrency);
        const totalFunc = aFuncional(
          Money.of(totalLinea.toFixed(8), input.currency).ok
            ? (Money.of(totalLinea.toFixed(8), input.currency) as { ok: true; value: Money }).value
            : base.value,
          tasa.value.rate,
          ctx.value.functionalCurrency,
        );
        if (!precioFunc.ok || !totalFunc.ok) throw new Error("conversión fuera de rango");

        await sp`
          insert into public.supplier_invoice_lines
            (tenant_id, company_id, supplier_invoice_id, line_number, goods_receipt_line_id,
             product_id, description, quantity, unit_price_transaction, unit_price_functional,
             tax_rule_id, tax_rate_snapshot, tax_amount, line_subtotal_transaction,
             line_total_transaction, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             rounding_policy_id, tax_category_snapshot, tax_treatment, operation_type)
          values (${ctx.value.tenantId}, ${input.company_id}, ${f!.id}, ${n},
                  ${l.goods_receipt_line_id ?? null}, ${l.product_id},
                  ${l.description ?? producto.name}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${precioFunc.value.toAmountString()},
                  ${taxRuleId}, ${tasaImp.value.toFixed()}, ${impLinea.value.toAmountString()},
                  ${base.value.toAmountString()}, ${totalLinea.toFixed(8)},
                  ${base.value.toAmountString()}, ${input.currency},
                  ${tasa.value.rate.toFixed()}, ${totalFunc.value.toAmountString()},
                  ${ctx.value.functionalCurrency}, ${tasa.value.source}, now(), ${POLICY.id},
                  -- ADR-0044 §1. El tratamiento lo deriva la función de la base
                  -- —una sola definición para los dos libros— y el tipo de
                  -- operación queda SIN CLASIFICAR en el proveedor extranjero:
                  -- Ladino no implementa el régimen de importación, y escribir
                  -- «interna» sobre una importación es declarar mal.
                  -- VALIDAR-SENIAT.
                  ${producto.tax_category_code},
                  platform.tax_treatment_of(${producto.tax_category_code}),
                  ${prov.supplier_kind === "nacional" ? "interna" : null})`;
      }

      // Y aquí pasa a `posted`: hasta este UPDATE es un borrador editable, y
      // desde él es un hecho que el trigger congela.
      await sp`
        update public.supplier_invoices
           set status = 'posted', posted_at = now(),
               subtotal_amount = ${sub.toFixed(8)}, tax_amount = ${imp.toFixed(8)},
               total_amount = ${sub.plus(imp).toFixed(8)},
               amount_transaction_currency = ${sub.plus(imp).toFixed(8)},
               functional_amount = ${sub.plus(imp).times(tasa.value.rate).toDecimalPlaces(8, 4).toFixed(8)}
         where id = ${f!.id}`;

      /**
       * Las retenciones, DENTRO del mismo savepoint que la factura. Al
       * proveedor EXTRANJERO no se le practican: no le aplican las locales, y
       * el eje `supplier_person_type` de retention_rules está para cuando
       * exista la norma de no domiciliados (ADR-0039 §6, VALIDAR-TRIBUTARIO).
       *
       * Estaban fuera, y eso dejaba un documento fantasma: `withTransaction`
       * COMMITEA aunque el caso de uso devuelva `err` —solo revierte si algo
       * LANZA—, así que devolver el error de la retención escribía la factura
       * después de haber respondido 409, sin asiento y sin fila en la cola. Lo
       * destapó `accounting_coverage_gaps()` contándolo como `missing`; el
       * defecto llevaba ahí desde que se construyó compras y ningún test de
       * compras lo veía, porque todos miraban la respuesta y no la tabla.
       *
       * Una factura cuya retención no se pudo calcular NO EXISTE: la retención
       * es parte de registrarla, no un paso posterior.
       */
      if (prov.supplier_kind === "nacional" && (input.retention_concepts?.length ?? 0) > 0) {
        for (const concepto of input.retention_concepts!) {
          const r = await practicarRetencion(sp, ctx.value, {
            companyId: input.company_id,
            supplierId: input.supplier_id,
            invoiceId: f!.id,
            conceptCode: concepto,
            taxpayerType: prov.taxpayer_type_code,
            personType: prov.person_type_code,
            fecha: input.invoice_date,
            baseIva: imp.toFixed(8),
          });
          if (!r.ok) {
            // Se guarda ANTES de lanzar: lo que sale del savepoint es el error
            // de Postgres, no este, y sin guardarlo el 409 perdería su mensaje.
            falloRetencion = r.error;
            throw new Error("retención rechazada");
          }
        }
        const [suma] = await sp<{ t: string }[]>`
          select coalesce(sum(retained_amount), 0)::text as t from public.supplier_retentions
           where supplier_invoice_id = ${f!.id} and status <> 'cancelled'`;
        await sp`
          update public.supplier_invoices set retention_total = ${suma?.t ?? "0"}
           where id = ${f!.id}`;
      }
      return f!.id;
    });
  } catch (e) {
    if (falloRetencion !== null) return err(falloRetencion);
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    if (e instanceof Error && !("code" in e)) {
      return err({ code: "VALIDATION_FAILED", message: e.message });
    }
    throw e;
  }

  const detalle = await leerFactura(sql, input.company_id, facturaId);
  if (!detalle.ok) return detalle;
  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "supplier_invoice",
    facturaId,
    "ap.invoice_posted",
    {
      supplier_id: input.supplier_id,
      supplier_document_number: input.supplier_document_number,
      supplier_control_number: input.supplier_control_number ?? null,
      total_amount: detalle.value.total_amount,
      retention_total: detalle.value.retention_total,
      tax_is_recoverable: ivaRecuperable,
    },
  );

  // El asiento de la compra. `taxRecoverable` es la bandera que decide si el
  // IVA va a crédito fiscal o al costo (ADR-0040 §7): la plantilla tiene las
  // dos ramas y este booleano elige, sin que nadie escriba una cuenta aquí.
  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "purchase_invoice",
    sourceEvent: "ap.invoice_posted",
    sourceId: facturaId,
    postingDate: input.invoice_date,
    postedBy: actor.userId,
    description: `Factura de compra ${input.supplier_document_number}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      subtotal: detalle.value.subtotal_amount,
      tax_amount: detalle.value.tax_amount,
      total: detalle.value.total_amount,
    },
    conditions: {
      taxRecoverable: ivaRecuperable,
      supplierForeign: prov.supplier_kind === "extranjero",
    },
    backlink: { table: "supplier_invoices", id: facturaId },
  });
  if (!contable.ok) {
    return err({ code: "VALIDATION_FAILED", message: contable.error.message });
  }
  return detalle;
}

/**
 * Practica UNA retención sobre la factura. El porcentaje sale del esquema con
 * su fuente legal y se COPIA en la fila (R-05): cambiar el catálogo mañana no
 * altera lo retenido hoy.
 *
 * `resolve_retention` levanta excepción y un error de Postgres condena la
 * transacción, así que va en savepoint. Sin él, el catch sería código muerto y
 * el 409 lo produciría la tabla de SQLSTATE con mensaje genérico — la lección
 * de S0.5, que ya se pagó dos veces.
 */
async function practicarRetencion(
  sql: TransactionSql,
  ctx: Contexto,
  d: {
    companyId: string;
    supplierId: string;
    invoiceId: string;
    conceptCode: string;
    taxpayerType: string | null;
    personType: string | null;
    fecha: string;
    baseIva: string;
  },
): Promise<Result<null, PurchaseError>> {
  const [concepto] = await sql<{ retention_code: string }[]>`
    select retention_code from public.retention_concepts
     where code = ${d.conceptCode} and status = 'active'`;
  if (!concepto) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El concepto de retención ${d.conceptCode} no existe en el catálogo.`,
    });
  }

  // La BASE depende del tributo: el IVA se retiene sobre el impuesto de la
  // factura; el ISLR, sobre el subtotal. No es un detalle — retener ISLR sobre
  // el total con IVA infla la retención y se la quita al proveedor.
  const [f] = await sql<{ subtotal: string }[]>`
    select subtotal_amount::text as subtotal from public.supplier_invoices where id = ${d.invoiceId}`;
  const baseRaw = concepto.retention_code === "iva" ? d.baseIva : (f?.subtotal ?? "0");
  const base = Money.of(baseRaw, ctx.functionalCurrency);
  if (!base.ok) return err({ code: "VALIDATION_FAILED", message: base.error.message });

  let regla: {
    retention_rule_id: string;
    formula_kind: string;
    rate: string;
    subtrahend: string | null;
    minimum_exempt: string | null;
    legal_source: string;
  };
  try {
    const [fila] = await sql.savepoint(
      (sp) => sp<
        {
          retention_rule_id: string;
          formula_kind: string;
          rate: string;
          subtrahend: string | null;
          minimum_exempt: string | null;
          legal_source: string;
        }[]
      >`select retention_rule_id, formula_kind, rate::text as rate,
               subtrahend::text as subtrahend, minimum_exempt::text as minimum_exempt,
               legal_source
          from platform.resolve_retention(${d.fecha}::date, ${JURISDICTION},
                                          ${concepto.retention_code}, ${d.conceptCode},
                                          ${d.taxpayerType}, ${d.personType})`,
    );
    regla = fila!;
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  const rate = parseDecimal(regla.rate);
  const sustraendo = regla.subtrahend === null ? null : parseDecimal(regla.subtrahend);
  const minimo = regla.minimum_exempt === null ? null : parseDecimal(regla.minimum_exempt);
  if (!rate.ok || (sustraendo !== null && !sustraendo.ok) || (minimo !== null && !minimo.ok)) {
    return err({ code: "VALIDATION_FAILED", message: "Parámetros de la regla no interpretables." });
  }

  const retenido = computeRetention({
    base: base.value,
    rule: {
      formulaKind: regla.formula_kind as RetentionFormula,
      rate: rate.value,
      subtrahend: sustraendo === null || !sustraendo.ok ? null : sustraendo.value,
      minimumExempt: minimo === null || !minimo.ok ? null : minimo.value,
    },
    policy: POLICY,
  });
  if (!retenido.ok) {
    return err({ code: "VALIDATION_FAILED", message: retenido.error.message });
  }

  // El ORÁCULO: el mismo cálculo en SQL. Dos implementaciones que tienen que
  // coincidir, como el costeo con LAD41. Si divergen, lo dice el test y no una
  // fiscalización.
  const [oraculo] = await sql<{ r: string }[]>`
    select platform.compute_retention(${base.value.toAmountString()}::numeric,
                                      ${regla.formula_kind},
                                      ${regla.rate}::numeric,
                                      ${regla.subtrahend}::numeric,
                                      ${regla.minimum_exempt}::numeric)::text as r`;
  const oraculoDec = parseDecimal(oraculo?.r ?? "0");
  if (!oraculoDec.ok || !oraculoDec.value.equals(retenido.value.amount)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El cálculo de la retención no coincide con el del esquema (TS ${retenido.value.toAmountString()} vs SQL ${oraculo?.r ?? "?"}). No se retiene con dos respuestas distintas.`,
    });
  }

  try {
    await sql.savepoint(
      (sp) => sp`
        insert into public.supplier_retentions
          (tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
           retention_rule_id, formula_kind, rate_snapshot, subtrahend_snapshot,
           minimum_exempt_snapshot, legal_source_snapshot, base_amount, retained_amount,
           functional_currency, status, rules_version)
        values (${ctx.tenantId}, ${d.companyId}, ${d.supplierId}, ${d.invoiceId},
                ${concepto.retention_code}, ${d.conceptCode}, ${regla.retention_rule_id},
                ${regla.formula_kind}, ${regla.rate}, ${regla.subtrahend},
                ${regla.minimum_exempt}, ${regla.legal_source}, ${base.value.toAmountString()},
                ${retenido.value.toAmountString()}, ${ctx.functionalCurrency}, 'calculated',
                ${RULES_VERSION})`,
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido?.code === "DUPLICATE") {
      return err({
        code: "DUPLICATE",
        message: `Ya hay una retención de ${concepto.retention_code} por el concepto ${d.conceptCode} sobre esa factura: doble retención sobre la misma base.`,
      });
    }
    if (conocido) return err(conocido);
    throw e;
  }
  return ok(null);
}

async function leerFactura(
  sql: TransactionSql,
  companyId: string,
  invoiceId: string,
): Promise<Result<SupplierInvoiceResponse, PurchaseError>> {
  const [f] = await sql<SupplierInvoiceResponse[]>`
    select id, company_id, supplier_id, purchase_order_id, supplier_document_number,
           supplier_control_number, supplier_document_ref, invoice_date::text as invoice_date,
           due_date::text as due_date, status, subtotal_amount::text as subtotal_amount,
           tax_amount::text as tax_amount, total_amount::text as total_amount,
           tax_is_recoverable, retention_total::text as retention_total, transaction_currency,
           functional_currency, fx_rate::text as fx_rate, rate_source
      from public.supplier_invoices where id = ${invoiceId} and company_id = ${companyId}`;
  if (!f) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const retenciones = await sql<Record<string, unknown>[]>`
    select id, retention_code, concept_code, formula_kind, rate_snapshot::text as rate_snapshot,
           subtrahend_snapshot::text as subtrahend_snapshot, base_amount::text as base_amount,
           retained_amount::text as retained_amount, legal_source_snapshot, status
      from public.supplier_retentions where supplier_invoice_id = ${invoiceId}
     order by retention_code, concept_code`;
  return ok({ ...f, retentions: retenciones as never });
}

// ── Landed cost ─────────────────────────────────────────────────────────────

/**
 * Aplica un gasto de importación al costo de una recepción ya confirmada.
 *
 * La parte que corresponde a lo que SIGUE EN EXISTENCIA revaloriza el
 * inventario; la de lo ya vendido es VARIACIÓN DE COSTO (ADR-0040 §6). No se
 * prorratea sobre lo que queda: eso encarecería unidades que no incurrieron en
 * el gasto y ensuciaría el margen de todas las ventas siguientes de ese
 * producto, en silencio.
 */
export async function applyLandedCost(
  uow: UnitOfWork,
  input: ApplyLandedCostRequest,
): Promise<Result<LandedCostResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Costear exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.landed_cost.apply");
  if (!ctx.ok) return ctx;

  const [recepcion] = await sql<{ status: string; warehouse_id: string }[]>`
    select status, warehouse_id from public.goods_receipts
     where id = ${input.goods_receipt_id} and company_id = ${input.company_id}`;
  if (!recepcion) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (recepcion.status !== "confirmed") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Solo se costea una recepción confirmada: en borrador todavía no hay costo que ajustar.",
    });
  }

  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, input.incurred_on);
  if (!tasa.ok) return tasa;
  const gasto = Money.of(input.amount, input.currency);
  if (!gasto.ok) return err({ code: "VALIDATION_FAILED", message: gasto.error.message });
  const gastoFunc = aFuncional(gasto.value, tasa.value.rate, ctx.value.functionalCurrency);
  if (!gastoFunc.ok) return gastoFunc;

  const lineas = await sql<
    {
      id: string;
      product_id: string;
      lot_id: string | null;
      quantity: string;
      functional_amount: string;
      unit_weight: string | null;
    }[]
  >`select id, product_id, lot_id, quantity::text as quantity,
           functional_amount::text as functional_amount, unit_weight::text as unit_weight
      from public.goods_receipt_lines
     where goods_receipt_id = ${input.goods_receipt_id} order by line_number`;
  if (lineas.length === 0) {
    return err({ code: "VALIDATION_FAILED", message: "La recepción no tiene líneas." });
  }

  /**
   * Cuánto queda de lo recibido. Se aproxima con la existencia ACTUAL de la
   * posición, acotada por lo recibido en la línea: el kardex no rastrea qué
   * unidad vino de qué recepción —eso exigiría costeo por capas, que ADR-0034
   * descartó— y esta es la mejor información disponible.
   *
   * Consecuencia declarada: si entre medias entró mercancía de OTRA compra, el
   * disponible puede cubrir lo recibido aunque estas unidades concretas ya se
   * hayan ido. Se prefiere errar hacia el inventario antes que hacia la
   * variación: revalorizar de más es visible en el costo, y una variación
   * inflada desaparece en resultados sin que nadie la mire.
   */
  const allocatables: AllocatableLine[] = [];
  for (const l of lineas) {
    const [saldo] = await sql<{ q: string }[]>`
      select coalesce(quantity, 0)::text as q from public.stock_balances
       where company_id = ${input.company_id} and warehouse_id = ${recepcion.warehouse_id}
         and product_id = ${l.product_id}
         and lot_id is not distinct from ${l.lot_id}`;
    const recibida = parseDecimal(l.quantity);
    const enStock = parseDecimal(saldo?.q ?? "0");
    const valor = Money.of(l.functional_amount, ctx.value.functionalCurrency);
    const peso = l.unit_weight === null ? null : parseDecimal(l.unit_weight);
    if (!recibida.ok || !enStock.ok || !valor.ok || (peso !== null && !peso.ok)) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Datos de la recepción no interpretables.",
      });
    }
    const queda = enStock.value.greaterThan(recibida.value) ? recibida.value : enStock.value;
    allocatables.push({
      lineId: l.id,
      quantityReceived: recibida.value,
      quantityRemaining: queda.isNegative() ? recibida.value.times(0) : queda,
      valueFunctional: valor.value,
      unitWeight: peso === null || !peso.ok ? null : peso.value,
    });
  }

  const reparto = allocateLandedCost({
    amount: gastoFunc.value,
    method: input.allocation_method,
    lines: allocatables,
    policy: POLICY,
  });
  if (!reparto.ok) {
    return err(
      reparto.error.code === "MISSING_WEIGHT"
        ? { code: "MISSING_WEIGHT", message: reparto.error.message }
        : { code: "VALIDATION_FAILED", message: reparto.error.message },
    );
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [costo] = await sql<{ id: string }[]>`
    insert into public.landed_costs
      (tenant_id, company_id, goods_receipt_id, concept, allocation_method, supplier_id,
       reference, incurred_on, status, applied_at, amount_transaction_currency,
       transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
       rate_timestamp, rounding_policy_id)
    values (${ctx.value.tenantId}, ${input.company_id}, ${input.goods_receipt_id},
            ${input.concept}, ${input.allocation_method}, ${input.supplier_id ?? null},
            ${input.reference ?? null}, ${input.incurred_on}::date, 'draft', null,
            ${gasto.value.toAmountString()}, ${input.currency}, ${tasa.value.rate.toFixed()},
            ${gastoFunc.value.toAmountString()}, ${ctx.value.functionalCurrency},
            ${tasa.value.source}, now(), ${POLICY.id})
    returning id`;

  const alojado = new Map(allocatables.map((a) => [a.lineId, a]));
  const detalleLineas = new Map(lineas.map((l) => [l.id, l]));
  for (const a of reparto.value.lines) {
    const info = alojado.get(a.lineId)!;
    const fila = detalleLineas.get(a.lineId)!;
    await sql`
      insert into public.landed_cost_allocations
        (tenant_id, company_id, landed_cost_id, goods_receipt_line_id, allocated_functional,
         to_inventory_functional, to_variance_functional, quantity_remaining, quantity_received,
         allocation_base)
      values (${ctx.value.tenantId}, ${input.company_id}, ${costo!.id}, ${a.lineId},
              ${a.allocated.toAmountString()}, ${a.toInventory.toAmountString()},
              ${a.toVariance.toAmountString()}, ${info.quantityRemaining.toFixed()},
              ${info.quantityReceived.toFixed()}, ${a.base.toFixed()})`;

    // La REVALORIZACIÓN: valor sin cantidad, por el KARDEX (migración 23). El
    // promedio se recalcula hacia adelante; las unidades ya vendidas conservan
    // el costo con el que salieron, porque una salida emitida no se reescribe.
    if (!a.toInventory.amount.isZero()) {
      const mov = await revalueStock(uow, {
        company_id: input.company_id,
        warehouse_id: recepcion.warehouse_id,
        product_id: fila.product_id,
        lot_id: fila.lot_id,
        amount: a.toInventory.toAmountString(),
        currency: ctx.value.functionalCurrency,
        reason: `Landed cost: ${input.concept}`,
        sourceDocumentId: costo!.id,
      });
      if (!mov.ok) return err({ code: "VALIDATION_FAILED", message: mov.error.message });
    }

    if (!a.toVariance.amount.isZero()) {
      await sql`
        insert into public.landed_cost_variances
          (tenant_id, company_id, landed_cost_id, goods_receipt_line_id, product_id,
           amount_functional, functional_currency, occurred_on, reason)
        values (${ctx.value.tenantId}, ${input.company_id}, ${costo!.id}, ${a.lineId},
                ${fila.product_id}, ${a.toVariance.toAmountString()},
                ${ctx.value.functionalCurrency}, ${input.incurred_on}::date,
                ${`Gasto llegado después de la recepción: ${info.quantityReceived.minus(info.quantityRemaining).toFixed()} de ${info.quantityReceived.toFixed()} unidades ya habían salido`})`;
    }
  }

  // El gasto pasa a `applied` cuando ya está todo repartido y revalorizado:
  // marcarlo antes lo congelaría y el propio caso de uso no podría terminar.
  await sql`
    update public.landed_costs set status = 'applied', applied_at = now()
     where id = ${costo!.id}`;

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "landed_cost",
    costo!.id,
    "purchase.landed_cost_applied",
    {
      goods_receipt_id: input.goods_receipt_id,
      concept: input.concept,
      method: input.allocation_method,
      total: gastoFunc.value.toAmountString(),
      to_inventory: reparto.value.totalToInventory.toAmountString(),
      to_variance: reparto.value.totalToVariance.toAmountString(),
    },
  );

  // El asiento del landed cost. Las dos partes van por separado —lo que
  // capitaliza y lo que es gasto del período— porque son dos hechos distintos
  // (ADR-0040 §6) y meterlos en una sola línea los volvería indistinguibles.
  const contableLanded = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "landed_cost",
    sourceEvent: "purchase.landed_cost_applied",
    sourceId: costo!.id,
    postingDate: input.incurred_on,
    postedBy: actor.userId,
    description: `Landed cost: ${input.concept}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      landed_to_inventory: reparto.value.totalToInventory.toAmountString(),
      landed_to_variance: reparto.value.totalToVariance.toAmountString(),
      functional_amount: gastoFunc.value.toAmountString(),
    },
    backlink: { table: "landed_costs", id: costo!.id },
  });
  if (!contableLanded.ok) {
    return err({ code: "VALIDATION_FAILED", message: contableLanded.error.message });
  }

  const asignaciones = await sql<Record<string, unknown>[]>`
    select goods_receipt_line_id, allocated_functional::text as allocated_functional,
           to_inventory_functional::text as to_inventory_functional,
           to_variance_functional::text as to_variance_functional,
           quantity_remaining::text as quantity_remaining,
           quantity_received::text as quantity_received
      from public.landed_cost_allocations where landed_cost_id = ${costo!.id}`;
  return ok({
    id: costo!.id,
    goods_receipt_id: input.goods_receipt_id,
    concept: input.concept,
    allocation_method: input.allocation_method,
    status: "applied",
    functional_amount: gastoFunc.value.toAmountString(),
    functional_currency: ctx.value.functionalCurrency,
    allocations: asignaciones as never,
    total_variance: reparto.value.totalToVariance.toAmountString(),
  });
}

// ── Nota de crédito recibida ────────────────────────────────────────────────

export async function registerSupplierCreditNote(
  uow: UnitOfWork,
  input: RegisterSupplierCreditNoteRequest,
): Promise<Result<{ id: string; total_amount: string; balance: string }, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.credit_note.register");
  if (!ctx.ok) return ctx;

  const [factura] = await sql<{ supplier_id: string; status: string }[]>`
    select supplier_id, status from public.supplier_invoices
     where id = ${input.supplier_invoice_id} and company_id = ${input.company_id}`;
  if (!factura) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!["posted", "paid"].includes(factura.status)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo se abona contra una factura asentada.",
    });
  }
  if (input.supplier_control_number === undefined && input.supplier_document_ref === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La nota de crédito necesita número de control o referencia del documento origen.",
    });
  }

  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, input.note_date);
  if (!tasa.ok) return tasa;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const nota = await sql.savepoint(async (sp) => {
      const [n] = await sp<{ id: string }[]>`
        insert into public.supplier_credit_notes
          (tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
           supplier_control_number, supplier_document_ref, note_date, status, posted_at, reason,
           transaction_currency, functional_currency, fx_rate, rate_source, rate_timestamp,
           rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${factura.supplier_id},
                ${input.supplier_invoice_id}, ${input.supplier_document_number},
                ${input.supplier_control_number ?? null}, ${input.supplier_document_ref ?? null},
                ${input.note_date}::date, 'draft', null, ${input.reason}, ${input.currency},
                ${ctx.value.functionalCurrency}, ${tasa.value.rate.toFixed()},
                ${tasa.value.source}, now(), ${POLICY.id})
        returning id`;

      const sub = parseDecimal("0");
      const imp = parseDecimal("0");
      if (!sub.ok || !imp.ok) throw new Error("imposible");
      let subtotal = sub.value;
      let impuesto = imp.value;
      let k = 0;
      for (const l of input.lines) {
        k += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        const impLinea = Money.of(l.tax_amount ?? "0", input.currency);
        if (!cantidad.ok || !precio.ok || !impLinea.ok) throw new Error("importe no interpretable");
        const base = Money.of(
          precio.value.multiply(cantidad.value).amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!base.ok) throw new Error("base fuera de rango");
        const total = base.value.amount.plus(impLinea.value.amount);
        subtotal = subtotal.plus(base.value.amount);
        impuesto = impuesto.plus(impLinea.value.amount);
        // El `as never` que había aquí pasaba un Result donde se esperaba un
        // Money y el fallo salía como «m.multiply is not a function» en tiempo
        // de ejecución. Un cast que silencia al compilador es exactamente el
        // sitio donde el compilador tenía razón.
        const totalMoney = Money.of(total.toFixed(8), input.currency);
        if (!totalMoney.ok) throw new Error("total de línea fuera de rango");
        const totalFunc = aFuncional(
          totalMoney.value,
          tasa.value.rate,
          ctx.value.functionalCurrency,
        );
        const [producto] = await sp<{ name: string }[]>`
          select name from public.products where id = ${l.product_id}`;
        await sp`
          insert into public.supplier_credit_note_lines
            (tenant_id, company_id, supplier_credit_note_id, line_number,
             supplier_invoice_line_id, product_id, description, quantity,
             unit_price_transaction, tax_amount, line_subtotal_transaction,
             line_total_transaction, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             rounding_policy_id)
          values (${ctx.value.tenantId}, ${input.company_id}, ${n!.id}, ${k},
                  ${l.supplier_invoice_line_id ?? null}, ${l.product_id},
                  ${l.description ?? producto?.name ?? "línea"}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${impLinea.value.toAmountString()},
                  ${base.value.toAmountString()}, ${total.toFixed(8)},
                  ${base.value.toAmountString()}, ${input.currency},
                  ${tasa.value.rate.toFixed()},
                  ${totalFunc.ok ? totalFunc.value.toAmountString() : total.toFixed(8)},
                  ${ctx.value.functionalCurrency}, ${tasa.value.source}, now(), ${POLICY.id})`;
      }
      await sp`
        update public.supplier_credit_notes
           set status = 'posted', posted_at = now(),
               subtotal_amount = ${subtotal.toFixed(8)}, tax_amount = ${impuesto.toFixed(8)},
               total_amount = ${subtotal.plus(impuesto).toFixed(8)},
               amount_transaction_currency = ${subtotal.plus(impuesto).toFixed(8)},
               functional_amount = ${subtotal.plus(impuesto).times(tasa.value.rate).toDecimalPlaces(8, 4).toFixed(8)}
         where id = ${n!.id}`;
      return n!.id;
    });

    const [total] = await sql<{ t: string }[]>`
      select total_amount::text as t from public.supplier_credit_notes where id = ${nota}`;
    const [saldo] = await sql<{ s: string }[]>`
      select platform.supplier_invoice_balance(${input.company_id},
             ${input.supplier_invoice_id})::text as s`;
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "supplier_credit_note",
      nota,
      "ap.credit_note_received",
      {
        supplier_invoice_id: input.supplier_invoice_id,
        supplier_document_number: input.supplier_document_number,
        total_amount: total?.t ?? "0",
        balance_after: saldo?.s ?? "0",
      },
    );
    return ok({ id: nota, total_amount: total?.t ?? "0", balance: saldo?.s ?? "0" });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    if (e instanceof Error && !("code" in e)) {
      return err({ code: "VALIDATION_FAILED", message: e.message });
    }
    throw e;
  }
}

// ── Pago al proveedor, con la retención aplicada ────────────────────────────

export async function registerSupplierPayment(
  uow: UnitOfWork,
  input: RegisterSupplierPaymentRequest,
): Promise<Result<SupplierPaymentResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Pagar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.payment.register");
  if (!ctx.ok) return ctx;

  const [factura] = await sql<
    { supplier_id: string; status: string; transaction_currency: string }[]
  >`select supplier_id, status, transaction_currency from public.supplier_invoices
     where id = ${input.supplier_invoice_id} and company_id = ${input.company_id}`;
  if (!factura) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (factura.status !== "posted") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se paga una factura asentada; esta está en ${factura.status}.`,
    });
  }

  // Cuenta bancaria: si se indica, tiene que estar APROBADA (SUPPLIERS_SPEC).
  if (input.bank_account_id !== undefined) {
    const [cuenta] = await sql<{ status: string }[]>`
      select status from public.supplier_bank_accounts
       where id = ${input.bank_account_id} and company_id = ${input.company_id}`;
    if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    if (cuenta.status !== "approved") {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Esa cuenta bancaria no está aprobada para pagos. Aprobarla es un acto propio, con su permiso y su auditoría.",
      });
    }
  }

  const fecha = input.paid_at ?? new Date().toISOString();
  const tasa = await tasaA(sql, input.currency, ctx.value.functionalCurrency, fecha);
  if (!tasa.ok) return tasa;

  const bruto = Money.of(input.gross_amount, input.currency);
  if (!bruto.ok) return err({ code: "VALIDATION_FAILED", message: bruto.error.message });
  const [saldoAntes] = await sql<{ s: string }[]>`
    select platform.supplier_invoice_balance(${input.company_id},
           ${input.supplier_invoice_id})::text as s`;
  const saldo = parseDecimal(saldoAntes?.s ?? "0");
  if (saldo.ok && bruto.value.amount.greaterThan(saldo.value)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El pago (${bruto.value.toAmountString()}) supera el saldo pendiente de la factura (${saldo.value.toFixed()}).`,
    });
  }

  /**
   * La retención se APLICA aquí: fue calculada al registrar la factura, con la
   * regla vigente entonces, y se descuenta del pago. El proveedor cobra el
   * NETO; el bruto es lo que cancela la deuda.
   *
   * VALIDAR-TRIBUTARIO: la norma retiene «al pago o al abono en cuenta, lo que
   * ocurra primero», y el abono en cuenta puede ser el registro mismo de la
   * factura. Si el asesor confirma esa lectura, lo que cambia es CUÁNDO se
   * entera al fisco, no el cálculo — que ya está congelado desde el registro.
   */
  const pendientes = await sql<{ id: string; retained_amount: string }[]>`
    select id, retained_amount::text as retained_amount from public.supplier_retentions
     where supplier_invoice_id = ${input.supplier_invoice_id} and status = 'calculated'
     for update`;
  const retenido = parseDecimal("0");
  if (!retenido.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
  let totalRetenido = retenido.value;
  for (const r of pendientes) {
    const d = parseDecimal(r.retained_amount);
    if (d.ok) totalRetenido = totalRetenido.plus(d.value);
  }
  // La retención solo se aplica cuando se cancela la factura entera: aplicarla
  // en un abono parcial exigiría prorratearla, y una retención prorrateada no
  // se corresponde con ninguna base declarable.
  const cancelaTodo = saldo.ok && bruto.value.amount.equals(saldo.value);
  const aRetener = cancelaTodo ? totalRetenido : totalRetenido.times(0);
  const neto = bruto.value.amount.minus(aRetener);
  if (neto.isNegative()) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La retención supera el pago: el proveedor no puede cobrar un importe negativo.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const funcional = aFuncional(bruto.value, tasa.value.rate, ctx.value.functionalCurrency);
  if (!funcional.ok) return funcional;

  // La cuenta de la que SALE el efectivo (migración 29): la explícita si el
  // llamante la eligió, si no la forma de pago configurada → «Sin asignar».
  // Una nota de crédito no mueve efectivo y va sin cuenta (CHECK de la tabla).
  let cuentaId: string | null;
  if (input.account_id !== undefined) {
    if (input.instrument === "nota_credito") {
      return err({
        code: "VALIDATION_FAILED",
        message: "Aplicar una nota de crédito no saca dinero de ninguna cuenta: quita la cuenta.",
      });
    }
    const [cuenta] = await sql<{ currency: string; name: string; is_active: boolean }[]>`
      select currency, name, is_active from public.company_accounts
       where id = ${input.account_id} and company_id = ${input.company_id}`;
    if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    if (!cuenta.is_active) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La cuenta «${cuenta.name}» está desactivada.`,
      });
    }
    if (cuenta.currency !== input.currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El pago es en ${input.currency} y la cuenta «${cuenta.name}» vive en ${cuenta.currency}.`,
      });
    }
    cuentaId = input.account_id;
  } else {
    cuentaId = await resolverCuentaEfectivo(
      sql,
      ctx.value.tenantId,
      input.company_id,
      input.instrument,
      input.currency,
    );
  }

  let pago: Record<string, unknown>;
  try {
    pago = await sql.savepoint(async (sp) => {
      const [p] = await sp<Record<string, unknown>[]>`
        insert into public.supplier_payments
          (tenant_id, company_id, supplier_id, supplier_invoice_id, bank_account_id, paid_at,
           instrument, reference, gross_amount, retained_amount, net_amount,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id, account_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${factura.supplier_id},
                ${input.supplier_invoice_id}, ${input.bank_account_id ?? null}, ${fecha},
                ${input.instrument}, ${input.reference ?? null}, ${bruto.value.toAmountString()},
                ${aRetener.toFixed(8)}, ${neto.toFixed(8)}, ${bruto.value.toAmountString()},
                ${input.currency}, ${tasa.value.rate.toFixed()},
                ${funcional.value.toAmountString()}, ${ctx.value.functionalCurrency},
                ${tasa.value.source}, now(), ${POLICY.id}, ${cuentaId})
        returning id, supplier_invoice_id,
                  to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
                  instrument, gross_amount::text as gross_amount,
                  retained_amount::text as retained_amount, net_amount::text as net_amount,
                  transaction_currency as currency, reference`;
      return p!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  let comprobante: Record<string, unknown> | null = null;
  if (cancelaTodo && pendientes.length > 0) {
    for (const r of pendientes) {
      await sql`
        update public.supplier_retentions set status = 'applied', applied_at = now()
         where id = ${r.id}`;
    }
    if (input.issue_retention_receipt === true) {
      const [permiso] = await sql<{ ok: boolean }[]>`
        select platform.ladino_user_has_permission(${actor.userId}, 'retention.receipt.issue',
                                                   ${input.company_id}) as ok`;
      if (!permiso?.ok) {
        return err({
          code: "PERMISSION_REQUIRED",
          message: "Emitir el comprobante de retención exige el permiso retention.receipt.issue.",
        });
      }
      const serie = input.retention_receipt_series ?? "A";
      try {
        comprobante = await sql.savepoint(async (sp) => {
          const [num] = await sp<{ n: string }[]>`
            select platform.claim_retention_receipt_number(${input.company_id}, ${serie})::text as n`;
          const [c] = await sp<Record<string, unknown>[]>`
            insert into public.retention_receipts
              (tenant_id, company_id, supplier_id, supplier_invoice_id, series, receipt_number,
               status, issued_at, fiscal_period, total_retained, functional_currency)
            values (${ctx.value.tenantId}, ${input.company_id}, ${factura.supplier_id},
                    ${input.supplier_invoice_id}, ${serie}, ${num!.n}::bigint, 'issued',
                    ${fecha}, to_char(${fecha}::timestamptz, 'YYYY-MM'),
                    ${aRetener.toFixed(8)}, ${ctx.value.functionalCurrency})
            returning id, supplier_id, supplier_invoice_id, series,
                      receipt_number::int as receipt_number, control_number::int as control_number,
                      status,
                      to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
                      fiscal_period, total_retained::text as total_retained, functional_currency`;
          return c!;
        });
      } catch (e) {
        const conocido = traducir(e);
        if (conocido) return err(conocido);
        throw e;
      }
    }
  }

  const [saldoDespues] = await sql<{ s: string }[]>`
    select platform.supplier_invoice_balance(${input.company_id},
           ${input.supplier_invoice_id})::text as s`;
  const restante = parseDecimal(saldoDespues?.s ?? "0");
  let estado = factura.status;
  if (restante.ok && (restante.value.isZero() || restante.value.isNegative())) {
    await sql`update public.supplier_invoices set status = 'paid'
               where id = ${input.supplier_invoice_id}`;
    estado = "paid";
  }

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "supplier_payment",
    pago["id"] as string,
    "ap.payment_made",
    {
      supplier_invoice_id: input.supplier_invoice_id,
      gross_amount: pago["gross_amount"] as string,
      retained_amount: pago["retained_amount"] as string,
      net_amount: pago["net_amount"] as string,
      instrument: input.instrument,
      balance_after: saldoDespues?.s ?? "0",
      retention_receipt_id: comprobante === null ? null : (comprobante["id"] as string),
    },
  );

  // El asiento del pago. El BRUTO cancela la deuda, el NETO sale del banco y
  // la diferencia son dos deudas con el fisco. Las retenciones van desglosadas
  // por tributo porque se enteran por separado y con formularios distintos.
  const [porTributo] = await sql<{ iva: string; islr: string }[]>`
    select coalesce(sum(retained_amount) filter (where retention_code = 'iva'), 0)::text as iva,
           coalesce(sum(retained_amount) filter (where retention_code = 'islr'), 0)::text as islr
      from public.supplier_retentions
     where supplier_invoice_id = ${input.supplier_invoice_id} and status = 'applied'`;
  const contablePago = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "payment_made",
    sourceEvent: "ap.payment_made",
    sourceId: pago["id"] as string,
    postingDate: fecha.slice(0, 10),
    postedBy: actor.userId,
    description: "Pago a proveedor",
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      total: funcional.value.toAmountString(),
      net_amount: neto.toFixed(8),
      retained_iva: cancelaTodo ? (porTributo?.iva ?? "0") : "0",
      retained_islr: cancelaTodo ? (porTributo?.islr ?? "0") : "0",
      retained_total: aRetener.toFixed(8),
    },
    backlink: { table: "supplier_payments", id: pago["id"] as string },
  });
  if (!contablePago.ok) {
    return err({ code: "VALIDATION_FAILED", message: contablePago.error.message });
  }

  return ok({
    payment: pago as never,
    retention_receipt: comprobante as never,
    balance: saldoDespues?.s ?? "0",
    invoice_status: estado,
  });
}

// ── La COMPRA SIMPLE de la Fase C ───────────────────────────────────────────

/**
 * «Llegó mercancía con su factura», en UN paso: orden → recepción completa →
 * factura del proveedor → pago del total (si se pidió). El detrás de cámaras
 * es el flujo COMPLETO de compras — matching, costeo a la tasa de recepción,
 * IVA por regla, asiento o cola — con cada pieza validando sus permisos.
 * Una transacción: si la factura falla, tampoco quedan orden ni recepción.
 */
export async function simplePurchase(
  uow: UnitOfWork,
  input: SimplePurchaseRequest,
): Promise<Result<SimplePurchaseResponse, PurchaseError>> {
  const { sql } = uow;

  const orden = await createPurchaseOrder(uow, {
    company_id: input.company_id,
    supplier_id: input.supplier_id,
    warehouse_id: input.warehouse_id,
    branch_id: input.branch_id ?? null,
    currency: input.currency,
    lines: input.lines,
  });
  if (!orden.ok) return orden;

  // Las líneas de la orden, con su id: la recepción y la factura se atan a
  // ellas para que el matching de tres vías tenga contra qué comparar.
  const lineasOrden = await sql<
    { id: string; product_id: string; quantity: string; unit_price: string }[]
  >`
    select id, product_id, quantity::text as quantity,
           unit_price_transaction::text as unit_price
      from public.purchase_order_lines
     where purchase_order_id = ${orden.value.id} and company_id = ${input.company_id}
     order by line_number`;

  const recibo = await receiveGoods(uow, {
    company_id: input.company_id,
    supplier_id: input.supplier_id,
    purchase_order_id: orden.value.id,
    warehouse_id: input.warehouse_id,
    currency: input.currency,
    lines: lineasOrden.map((l) => ({
      purchase_order_line_id: l.id,
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
    })),
  });
  if (!recibo.ok) return recibo;

  // La fecha de la factura: la del papel si vino; si no, el día de Venezuela
  // (a las 8 pm de Caracas el UTC ya va por mañana — CLAUDE.md §3).
  let fechaFactura = input.invoice_date;
  if (fechaFactura === undefined) {
    const [hoy] = await sql<{ d: string }[]>`
      select (now() at time zone 'America/Caracas')::date::text as d`;
    fechaFactura = hoy!.d;
  }

  const factura = await registerSupplierInvoice(uow, {
    company_id: input.company_id,
    supplier_id: input.supplier_id,
    purchase_order_id: orden.value.id,
    supplier_document_number: input.supplier_document_number,
    ...(input.supplier_control_number === undefined
      ? {}
      : { supplier_control_number: input.supplier_control_number }),
    invoice_date: fechaFactura,
    currency: input.currency,
    lines: input.lines.map((l) => ({
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
    })),
  });
  if (!factura.ok) return factura;

  let pago: SupplierPaymentResponse | null = null;
  if (input.payment !== undefined) {
    const pagado = await registerSupplierPayment(uow, {
      company_id: input.company_id,
      supplier_invoice_id: factura.value.id,
      gross_amount: factura.value.total_amount,
      currency: input.currency,
      instrument: input.payment.instrument,
      ...(input.payment.reference === undefined ? {} : { reference: input.payment.reference }),
      ...(input.payment.account_id === undefined ? {} : { account_id: input.payment.account_id }),
    });
    if (!pagado.ok) return pagado;
    pago = pagado.value;
  }

  return ok({
    order: orden.value,
    receipt: recibo.value,
    invoice: factura.value,
    payment: pago,
  });
}
