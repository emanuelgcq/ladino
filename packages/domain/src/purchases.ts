import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
import { mensajeFaltaTasa } from "./tasa-oficial.js";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import {
  minorUnitsOf,
  Money,
  parseDecimal,
  toCents,
  type Decimal,
  type RoundingPolicy,
} from "@ladino/money";
import {
  allocateLandedCost,
  computeRetention,
  matchThreeWay,
  type AllocatableLine,
  type MatchInput,
  type RetentionFormula,
} from "@ladino/purchases";
import type {
  RegisterExpenseRequest,
  ExpenseResponse,
  ExpensePreviewResponse,
  SupplierPaymentPreviewResponse,
} from "@ladino/schemas";
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
  ClosePurchaseOrderRequest,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { fechaContableDe } from "./fecha-contable.js";
import { clasificacionPorPrefijo } from "./customers.js";
import { registrarDigitoDudoso, validarRif, type DocumentoLeido } from "./documento-identidad.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { tipoVigente } from "./tipo-contribuyente.js";
import {
  issueStockBatchForSupplierReturn,
  receiveStockFor,
  revalueStock,
  revalorizar,
} from "./inventory.js";
import { comprobanteAjeno, exigeSaldo, resolverCuentaEfectivo } from "./treasury.js";
import { generateJournalFromDocument } from "./journal-generator.js";
import { emitirComprobanteDeRetencion } from "./retention-vouchers.js";
import { toleranciaDeCaja } from "./tolerancia-de-caja.js";

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
  | { code: "OVER_INVOICED"; message: string }
  | { code: "INSUFFICIENT_FUNDS"; message: string }
  // ADR-0075 §4 (regla 4): el pago que cierra dejaría un diferencial fuera del redondeo.
  | { code: "SETTLEMENT_MISMATCH"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string };

const POLICY: RoundingPolicy = { id: "purchases:document:8:HALF_UP", scale: 8, mode: "HALF_UP" };
const JURISDICTION = "VE";

/** Una unidad mínima de la moneda (0,01 en VES y USD), para las cotas de redondeo. */
function unidadMinimaDe(moneda: string): Decimal {
  const escala = minorUnitsOf(moneda);
  const u = parseDecimal(escala === 0 ? "1" : `0.${"0".repeat(escala - 1)}1`);
  if (!u.ok) throw new Error(`unidad mínima de ${moneda} no interpretable`);
  return u.value;
}

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
}

/**
 * D-04 (ola 3, migración 20261003160000): el proveedor sin RIF se guarda y se le compra sin
 * factura; la compra CON factura lo exige, porque va al libro de compras y a la retención. El
 * mismo mensaje sale del caso de uso y, si otro camino llegara a la base, del trigger (LAD96).
 *
 * AF3-14 (auditoría fiscal de la ola): el mensaje NO propone registrarla como «no va a haber
 * factura». Esa salida sacaría del libro de compras una compra que SÍ trae factura solo porque al
 * maestro le falta un dato que la factura lleva impreso. Lo que falta es el RIF, y eso se pide.
 */
const PROVEEDOR_SIN_RIF =
  "Esta factura necesita el RIF del proveedor, que viene impreso en ella, y este proveedor está guardado sin RIF. Agrégalo como proveedor con su RIF y vuelve a registrar la factura.";

function traducir(e: unknown): PurchaseError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD53") return { code: "RETENTION_RULE_MISSING", message };
  if (code === "LAD54" || code === "LAD49") return { code: "FISCAL_NUMBERING_INVALID", message };
  if (code === "LAD50") return { code: "TAX_RULE_MISSING", message };
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "LAD67") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD39") return { code: "NEGATIVE_STOCK", message };
  if (code === "LAD96") return { code: "VALIDATION_FAILED", message: PROVEEDOR_SIN_RIF };
  // H-09 (migración 20261004170100): una línea sin producto fuera de la factura de un gasto.
  if (code === "LADH9") {
    return {
      code: "VALIDATION_FAILED",
      message:
        "Cada línea de una factura de mercancía lleva su producto. Una línea sin producto solo va en un gasto con factura fiscal.",
    };
  }
  // H-03 (migración 20261005110000): la línea de nota sin producto que no corrige un servicio.
  if (code === "LADH3") {
    return {
      code: "VALIDATION_FAILED",
      message:
        "Una línea de la nota sin producto solo corrige una línea de servicio de su propia factura.",
    };
  }
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
  const [cfg] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok({
    tenantId: scope.value.tenantId,
    functionalCurrency: cfg.moneda,
  });
}

/** La tasa vigente a una fecha, con su fuente. Sin tasa NO se compra. */
async function tasaA(
  sql: TransactionSql,
  companyId: string,
  desde: string,
  hasta: string,
  fecha: string,
): Promise<Result<{ rate: Decimal; source: string }, PurchaseError>> {
  if (desde === hasta) {
    const uno = parseDecimal("1");
    if (!uno.ok) return err({ code: "VALIDATION_FAILED", message: uno.error.message });
    return ok({ rate: uno.value, source: "identidad" });
  }
  // La tasa vigente: solo existe la del BCV (ADR-0064 §1, migración 66).
  const [t] = await sql<{ rate: string | null; source: string | null }[]>`
    select f.rate::text as rate, f.source
      from platform.rate_for(${companyId}, ${desde}, ${hasta}, ${diaNegocio(fecha)}::date) f`;
  if (!t?.rate) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: mensajeFaltaTasa(diaNegocio(fecha), diaNegocio(new Date())),
    });
  }
  const d = parseDecimal(t.rate);
  if (!d.ok) return err({ code: "VALIDATION_FAILED", message: d.error.message });
  return ok({ rate: d.value, source: t.source ?? "manual" });
}

/** Lo mismo que `aFuncional`, al céntimo half-up (ADR-0075 §7): lo que sale de una caja. */
function aFuncionalAlCentimo(
  m: Money,
  tasa: Decimal,
  funcional: string,
): Result<Money, PurchaseError> {
  const c = Money.of(toCents(m.multiply(tasa).amount).toFixed(2), funcional);
  if (!c.ok) return err({ code: "VALIDATION_FAILED", message: c.error.message });
  return ok(c.value);
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

/**
 * CERRAR UN PEDIDO QUE NO VA A LLEGAR. El distribuidor no lo trajo, se canceló, se pidió a
 * otro: el pedido sale de «Por recibir» y deja escrito POR QUÉ. Lo recibido a medias no se
 * toca —eso ya entró al kardex y tiene su costo—; lo que se cierra es la expectativa.
 *
 * No hay borrado: un pedido que desaparece sin rastro es una decisión que nadie puede revisar
 * después, y el estado 'closed' con su motivo es exactamente lo que el esquema ya preveía.
 */
export async function closePurchaseOrder(
  uow: UnitOfWork,
  orderId: string,
  input: ClosePurchaseOrderRequest,
): Promise<Result<PurchaseOrderResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cerrar un pedido exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "purchase.order.manage");
  if (!ctx.ok) return ctx;

  const [orden] = await sql<{ status: string }[]>`
    select status from public.purchase_orders
     where id = ${orderId} and company_id = ${input.company_id} for update`;
  if (!orden) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (orden.status === "closed" || orden.status === "cancelled") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Ese pedido ya está cerrado: no se cierra dos veces.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    await sql.savepoint(
      (sp) => sp`
        update public.purchase_orders
           set status = 'closed', closed_at = now(), close_reason = ${input.reason}
         where id = ${orderId} and company_id = ${input.company_id}`,
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "purchase_order",
    orderId,
    "ap.order_closed",
    { reason: input.reason, previous_status: orden.status },
  );

  const [detalle] = await sql<PurchaseOrderResponse[]>`
    select id, company_id, supplier_id, warehouse_id, order_number::int as order_number, status,
           to_char(ordered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ordered_at,
           expected_at::text as expected_at, transaction_currency, functional_currency,
           fx_rate::text as fx_rate, rate_source,
           amount_transaction_currency::text as amount_transaction_currency,
           functional_amount::text as functional_amount
      from public.purchase_orders
     where id = ${orderId} and company_id = ${input.company_id}`;
  if (!detalle) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok(detalle);
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
  // D-04 (ola 3): el proveedor nacional SIN RIF se guarda —«Cédula o RIF: puede quedar vacío»—
  // y se le compra sin factura. La compra CON factura es la que exige el RIF (libro y retención),
  // y la exige `registerSupplierInvoice` con el trigger LAD96 detrás.
  const sinRif = !extranjero && (input.tax_id ?? null) === null;
  // El RIF del proveedor nacional: estructura validada y NORMALIZADO (A-08, P-02); el dígito
  // verificador que no cuadra se acepta y queda en la auditoría.
  let documento: DocumentoLeido | null = null;
  if (!extranjero && !sinRif) {
    const leido = validarRif(input.tax_id!);
    if (!leido.ok) return leido;
    documento = leido.value;
  }
  const taxId = documento?.normalizado ?? null;
  // Sin tipo de persona o de contribuyente, se INFIEREN del prefijo del RIF (la misma regla
  // que los clientes, ADR-0033). La compra simple solo pide nombre y RIF, y el servidor
  // respondía 422 con cualquier formato: una bodega no podía registrar ni una compra
  // (QA de pantalla 2026-09-15, h. 48). Quien compra a un proveedor con una V vende con
  // factura, así que su clasificación por defecto es «ordinario», no «consumidor_final».
  // VALIDAR-SENIAT: un proveedor formal o especial se corrige en su ficha.
  let personType = input.person_type_code ?? null;
  let taxpayerType = input.taxpayer_type_code ?? null;
  // Sin RIF no hay inscripción: persona natural y no contribuyente, salvo que se diga otra cosa
  // (decidido por criterio, ADR-0066 nota de la ola 3; la alternativa era pedirlos en la pantalla).
  if (sinRif) {
    personType ??= "natural";
    taxpayerType ??= "no_contribuyente";
  }
  if (!extranjero && (personType === null || taxpayerType === null)) {
    const inferida = clasificacionPorPrefijo(taxId);
    personType ??= inferida.persona;
    taxpayerType ??=
      inferida.contribuyente === "consumidor_final" ? "ordinario" : inferida.contribuyente;
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
                ${taxId}, ${input.legal_name},
                ${input.trade_name ?? null}, ${input.supplier_kind},
                ${extranjero ? null : personType},
                ${extranjero ? null : taxpayerType},
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
    if (documento !== null) {
      await registrarDigitoDudoso(sql, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        aggregateType: "supplier",
        aggregateId: fila.id,
        documento,
        rulesVersion: RULES_VERSION,
      });
    }
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
  const tasa = await tasaA(
    sql,
    input.company_id,
    input.currency,
    ctx.value.functionalCurrency,
    hoy,
  );
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
      // El correlativo se reclama en la base, bajo candado consultivo por
      // empresa: dos confirmaciones simultáneas se serializan en vez de chocar
      // contra el índice único (auditoría 2026-09-11, M-16; migración 51).
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_purchase_order_number(${input.company_id})::text as n`;
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
  const tasa = await tasaA(
    sql,
    input.company_id,
    input.currency,
    ctx.value.functionalCurrency,
    fecha,
  );
  if (!tasa.ok) return tasa;

  // No se recibe más de lo pendiente: la recepción parcial es legítima, recibir
  // de más es un error que después nadie sabe si fue robo o dedo.
  for (const l of input.lines) {
    if (l.purchase_order_line_id === undefined) continue;
    // `for update` sobre la línea de la orden: dos recepciones simultáneas de
    // la misma línea se serializan y la segunda ve lo pendiente REAL
    // (auditoría 2026-09-11, M-16).
    const [linea] = await sql<{ purchase_order_id: string }[]>`
      select purchase_order_id from public.purchase_order_lines
       where id = ${l.purchase_order_line_id} and company_id = ${input.company_id}
       for update`;
    if (!linea) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    const [prog] = await sql<{ pendiente: string }[]>`
      select quantity_pending::text as pendiente
        from platform.purchase_order_progress(${input.company_id}, ${linea.purchase_order_id})
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
             functional_currency, rate_source, rate_timestamp, rounding_policy_id,
             capture_currency, capture_mode)
          values (${ctx.value.tenantId}, ${input.company_id}, ${r!.id}, ${n},
                  ${l.purchase_order_line_id ?? null}, ${l.product_id}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${costoUnitFunc.value.toAmountString()},
                  ${l.unit_weight ?? null}, ${totalLinea.value.toAmountString()},
                  ${input.currency}, ${tasa.value.rate.toFixed()},
                  ${totalFunc.value.toAmountString()}, ${ctx.value.functionalCurrency},
                  ${tasa.value.source}, now(), ${POLICY.id},
                  ${l.capture_currency ?? null}, ${l.capture_mode ?? null})`;
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
        select platform.claim_goods_receipt_number(${input.company_id})::text as n`;
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
  // `receiveStock` recibe el importe TOTAL, no el unitario. El asiento va UNA
  // vez por recepción, con la suma (ADR-0060 §2).
  let recibido = parseDecimal("0");
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
    // La entrada la autoriza LA RECEPCIÓN (`purchase.receive`, ya exigido arriba con el
    // alcance del almacén), no `inventory.move` (ADR-0068 §1).
    const mov = await receiveStockFor(
      uow,
      {
        company_id: input.company_id,
        warehouse_id: input.warehouse_id,
        product_id: l.product_id,
        quantity: l.quantity,
        amount: totalFunc.toFixed(8),
        currency: ctx.value.functionalCurrency,
        ...(l.lot_code !== undefined ? { lot_code: l.lot_code } : {}),
        ...(l.lot_expires_at !== undefined ? { lot_expires_at: l.lot_expires_at } : {}),
        // Lo que la persona escribió viaja hasta el kardex (migración 71): el movimiento guarda
        // en qué moneda lo puso y si dio el de cada uno o el total, no solo lo derivado.
        ...(l.capture_currency !== undefined ? { capture_currency: l.capture_currency } : {}),
        ...(l.capture_mode !== undefined ? { capture_mode: l.capture_mode } : {}),
        sourceDocumentId: recepcion.id,
        accounting: "document",
      },
      "purchase.receive",
    );
    if (!mov.ok) {
      return err(
        mov.error.code === "PERMISSION_REQUIRED"
          ? { code: "PERMISSION_REQUIRED", message: mov.error.message }
          : { code: "VALIDATION_FAILED", message: mov.error.message },
      );
    }
    const v = parseDecimal(mov.value.functional_amount);
    if (recibido.ok && v.ok) recibido = { ok: true, value: recibido.value.plus(v.value) };
  }
  if (!recibido.ok) return err({ code: "VALIDATION_FAILED", message: recibido.error.message });
  if (!recibido.value.isZero()) {
    // Inventario contra «mercancía recibida por facturar»: la factura del
    // proveedor, cuando llegue, debita ese puente.
    const contableRecepcion = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId: input.company_id,
      sourceKind: "goods_receipt",
      sourceEvent: "stock.received",
      sourceId: recepcion.id,
      // K-04: una recepción fechada en un mes cerrado se asienta en el período en curso; el
      // kardex y la recepción conservan su fecha.
      postingDate: await fechaContableDe(
        sql,
        input.company_id,
        diaNegocio(input.received_at ?? new Date().toISOString()),
      ),
      postedBy: actor.userId,
      description: `Recepción de compra ${recepcion.receipt_number ?? ""}`,
      functionalCurrency: ctx.value.functionalCurrency,
      amounts: { functional_amount: recibido.value.toFixed(8) },
      backlink: { table: "goods_receipts", id: recepcion.id },
    });
    if (!contableRecepcion.ok) {
      return err({ code: "VALIDATION_FAILED", message: contableRecepcion.error.message });
    }
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

/**
 * Lo facturado (acumulado, facturas no anuladas) más lo que se pide no puede pasar de lo
 * recibido. Devuelve el error listo para responder, o null si cabe.
 */
async function topeDeFacturacion(
  sql: TransactionSql,
  input: RegisterSupplierInvoiceRequest,
): Promise<PurchaseError | null> {
  const porRecepcion = new Map<string, Decimal>();
  const porProducto = new Map<string, Decimal>();
  for (const l of input.lines) {
    const q = parseDecimal(l.quantity);
    if (!q.ok) continue;
    if (l.goods_receipt_line_id !== undefined) {
      const previo = porRecepcion.get(l.goods_receipt_line_id);
      porRecepcion.set(
        l.goods_receipt_line_id,
        previo === undefined ? q.value : previo.plus(q.value),
      );
    } else if (input.purchase_order_id !== undefined) {
      const previo = porProducto.get(l.product_id);
      porProducto.set(l.product_id, previo === undefined ? q.value : previo.plus(q.value));
    }
  }
  for (const [lineaRecepcion, pedida] of porRecepcion) {
    const [f] = await sql<{ recibida: string; facturada: string; producto: string }[]>`
      select rl.quantity::text as recibida,
             coalesce((select sum(il.quantity) from public.supplier_invoice_lines il
                         join public.supplier_invoices i on i.id = il.supplier_invoice_id
                        where il.goods_receipt_line_id = rl.id and i.status <> 'annulled'), 0)::text
               as facturada,
             p.name as producto
        from public.goods_receipt_lines rl
        join public.products p on p.id = rl.product_id
       where rl.id = ${lineaRecepcion} and rl.company_id = ${input.company_id}`;
    if (!f) return { code: "NOT_FOUND", message: "Recurso no encontrado." };
    const recibida = parseDecimal(f.recibida);
    const facturada = parseDecimal(f.facturada);
    if (!recibida.ok || !facturada.ok) continue;
    if (facturada.value.plus(pedida).greaterThan(recibida.value)) {
      return {
        code: "OVER_INVOICED",
        message: `De «${f.producto}» se recibieron ${recibida.value.toFixed()} y ya hay ${facturada.value.toFixed()} facturadas: esta factura llevaría el total a ${facturada.value.plus(pedida).toFixed()}. Una misma mercancía no se factura dos veces.`,
      };
    }
  }
  for (const [producto, pedida] of porProducto) {
    const [f] = await sql<{ recibida: string; facturada: string; nombre: string }[]>`
      select coalesce((select sum(rl.quantity) from public.goods_receipt_lines rl
                         join public.goods_receipts r on r.id = rl.goods_receipt_id
                        where r.purchase_order_id = ${input.purchase_order_id!}
                          and r.status = 'confirmed' and rl.product_id = ${producto}), 0)::text
               as recibida,
             coalesce((select sum(il.quantity) from public.supplier_invoice_lines il
                         join public.supplier_invoices i on i.id = il.supplier_invoice_id
                        where i.purchase_order_id = ${input.purchase_order_id!}
                          and i.status <> 'annulled' and il.product_id = ${producto}), 0)::text
               as facturada,
             (select name from public.products where id = ${producto}) as nombre`;
    const recibida = parseDecimal(f?.recibida ?? "0");
    const facturada = parseDecimal(f?.facturada ?? "0");
    if (!recibida.ok || !facturada.ok) continue;
    if (facturada.value.plus(pedida).greaterThan(recibida.value)) {
      return {
        code: "OVER_INVOICED",
        message: `De «${f?.nombre ?? "ese producto"}» la orden tiene ${recibida.value.toFixed()} recibidas y ${facturada.value.toFixed()} ya facturadas: esta factura llevaría el total a ${facturada.value.plus(pedida).toFixed()}. Una misma mercancía no se factura dos veces.`,
      };
    }
  }
  return null;
}

/**
 * H-09 (recorrido 2026-09-24): LA FACTURA DE UN GASTO. Un gasto con factura fiscal (la luz, el
 * teléfono, el alquiler) es una compra de SERVICIO, y se registra por `registerSupplierInvoice`
 * —el mismo libro, el mismo crédito fiscal, la misma retención y su comprobante—, no por una
 * rama fiscal paralela dentro de gastos. Lo único que cambia respecto de la mercancía:
 *   · las líneas no llevan producto: llevan la categoría tributaria y la base tal como vienen
 *     impresas (migración 20261004170000);
 *   · no hay orden ni recepción que cruzar (el matching de tres vías no aplica);
 *   · el asiento debita GASTO y no «mercancía recibida por facturar» (`ap.expense_invoice_posted`);
 *   · lo autoriza `expense.register`: el paso interior lo autoriza el permiso de la operación
 *     que lo contiene (RESPUESTA §2.8, familia «permiso anidado»).
 * No viaja por el contrato público de `POST /v1/supplier-invoices`: solo lo pasa
 * `registerInvoicedExpense`.
 */
export interface FacturaDeGasto {
  readonly categoria: string;
  readonly lineas: readonly { readonly tax_category_code: string; readonly base: string }[];
  readonly adjunto?: string | undefined;
  readonly recurrente?: boolean | undefined;
  /**
   * La cuenta de la que sale el dinero, que en el gasto se conoce en el mismo acto (AF4-01): la
   * exclusión que la norma condiciona al medio de pago se comprueba contra ella.
   */
  readonly cuentaDePago?: { readonly kind: string; readonly name: string } | undefined;
}

/**
 * EXCLUSIONES QUE LA NORMA CONDICIONA AL MEDIO DE PAGO (AF4-01, auditoría fiscal 2026-10-04).
 * PA SNAT/2025/000054 art. 3 num. 8 (reproducción no oficial, ivecofi, leída el 2026-10-04;
 * cotejo con la Gaceta pendiente): no se retiene en electricidad, agua, aseo y telefonía
 * «pagados mediante domiciliación a cuentas bancarias de los agentes de retención». Son dos
 * condiciones, la clase de servicio y el MEDIO DE PAGO. Aquí solo se comprueba lo que el texto
 * dice y el sistema sabe: que la cuenta de la que sale el dinero es bancaria. La clase de
 * servicio y qué cuenta como «domiciliación» NO se validan: son criterio (VALIDAR-TRIBUTARIO P-95).
 *
 * Decidido por criterio: el código va aquí y no como columna del catálogo `retention_exclusions`.
 * Alternativa: una columna «exige cuenta bancaria» en el catálogo (migración, y el hash de reglas
 * de ADR-0079 cambiaría); se deja para cuando haya una segunda exclusión con medio de pago.
 */
export const EXCLUSIONES_CON_CUENTA_BANCARIA: readonly string[] = ["servicio_publico_domiciliado"];

/** `company_accounts.kind` de una cuenta bancaria: ni caja (`cash`) ni monedero (`wallet`). */
export const CUENTA_BANCARIA = "bank";

/**
 * Las exclusiones que NO se ofrecen cuando el dinero sale de esta cuenta (AF4-01): la pantalla
 * pregunta al servidor con la cuenta elegida y no decide nada. `null` si la cuenta no es de la
 * empresa. Es la misma regla que aplica `registerSupplierInvoice` al registrar el gasto.
 */
export async function retentionExclusionsNotOfferedFor(
  sql: TransactionSql,
  companyId: string,
  accountId: string,
): Promise<readonly string[] | null> {
  const [cuenta] = await sql<{ kind: string }[]>`
    select kind from public.company_accounts
     where id = ${accountId} and company_id = ${companyId}`;
  if (!cuenta) return null;
  return cuenta.kind === CUENTA_BANCARIA ? [] : EXCLUSIONES_CON_CUENTA_BANCARIA;
}

interface LineaDeFactura {
  readonly product_id: string | null;
  readonly tax_category_code: string | null;
  readonly goods_receipt_line_id?: string | undefined;
  readonly description?: string | undefined;
  readonly quantity: string;
  readonly unit_price: string;
  readonly capture_currency?: string | undefined;
  readonly capture_mode?: "unit" | "total" | undefined;
}

export async function registerSupplierInvoice(
  uow: UnitOfWork,
  input: RegisterSupplierInvoiceRequest,
  gasto?: FacturaDeGasto,
): Promise<Result<SupplierInvoiceResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar exige un usuario real." });
  }
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    gasto === undefined ? "purchase.invoice.register" : "expense.register",
  );
  if (!ctx.ok) return ctx;
  if (gasto !== undefined && (input.lines.length > 0 || input.fiscal_support === false)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La factura de un gasto lleva líneas de servicio y soporte fiscal.",
    });
  }
  // Una sola forma de línea para el bucle de abajo: la de mercancía trae su producto; la de
  // servicio, su categoría tributaria y su base (cantidad 1).
  const lineas: readonly LineaDeFactura[] =
    gasto === undefined
      ? input.lines.map((l) => ({ ...l, tax_category_code: null }))
      : gasto.lineas.map((l) => ({
          product_id: null,
          tax_category_code: l.tax_category_code,
          description: gasto.categoria,
          quantity: "1",
          unit_price: l.base,
        }));

  const [prov] = await sql<
    {
      supplier_kind: string;
      taxpayer_type_code: string | null;
      person_type_code: string | null;
      tax_id: string | null;
    }[]
  >`select supplier_kind, taxpayer_type_code, person_type_code, tax_id from public.suppliers
     where id = ${input.supplier_id} and company_id = ${input.company_id}`;
  if (!prov) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  /**
   * CON O SIN SOPORTE FISCAL (ADR-0066 §2). Una compra sin factura es una compra: entra al
   * inventario y mueve dinero. Lo que no hace es entrar al libro ni generar crédito fiscal, y
   * por eso no se le pide identificación del emisor — no la hay.
   */
  const conSoporte = input.fiscal_support !== false;

  // D-04: con factura, el proveedor nacional necesita RIF (libro de compras y retención). Va
  // antes que todo lo demás: es lo primero que la persona tiene que corregir.
  if (conSoporte && prov.supplier_kind === "nacional" && prov.tax_id === null) {
    return err({ code: "VALIDATION_FAILED", message: PROVEEDOR_SIN_RIF });
  }

  // La identificación del emisor: o control (nacional) o referencia (extranjero). Se exige a lo
  // que VA AL LIBRO, que es el motivo con el que se escribió esta regla.
  if (
    conSoporte &&
    input.supplier_control_number === undefined &&
    input.supplier_document_ref === undefined
  ) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La factura necesita el número de control del proveedor o, si es extranjero, la referencia de su documento origen: sin ninguno no es asentable en el libro de compras.",
    });
  }

  /**
   * La retención sobre una compra SIN soporte está abierta con el asesor (PENDIENTES_ASESOR,
   * P-28): la norma retiene al pago o al abono en cuenta, y si nace también sin factura, sobre
   * qué base lo hace no es algo que Ladino pueda decidir. Hasta que se responda no se retiene, y
   * pedirlo FALLA en vez de ignorarse en silencio.
   */
  if (!conSoporte && (input.retention_concepts?.length ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Una compra sin factura no practica retención: sin documento no hay base declarable. Está consultado con el asesor (P-28).",
    });
  }

  /**
   * ADR-0040 §7 · VALIDAR-TRIBUTARIO. Para contribuyente ORDINARIO el IVA
   * soportado es crédito fiscal y NO entra al costo del inventario; para
   * FORMAL no es recuperable y sí lo es. Se DERIVA del régimen de la empresa,
   * no se configura: ofrecerlo como opción invitaría a marcarlo mal, y
   * marcarlo mal cambia el costo de todo lo comprado.
   */
  // El tipo VIGENTE EN LA FECHA DE LA FACTURA, por la única lectura (ADR-0072 §1): una compra
  // fechada antes de un cambio se lee con el tipo de entonces.
  const tipoEmpresa = await tipoVigente(sql, input.company_id, input.invoice_date);
  // D-01 (ola 3): el tipo decide si el IVA de la factura es crédito o costo, así que solo hace
  // falta CON factura. Sin soporte fiscal no hay IVA que discriminar —lo pagado es el costo— y
  // exigirlo dejaba sin comprar a quien todavía no lo declaró (y sin salida a la empresa sin RIF).
  if (tipoEmpresa === null && conSoporte) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Falta el tipo de contribuyente de la empresa: sin él no se sabe si el IVA de la compra es crédito fiscal o costo. Decláralo en Configuración → Mi empresa → Tipo de contribuyente, y vuelve a registrar la compra.",
    });
  }
  // El contribuyente ESPECIAL es un contribuyente ordinario de IVA designado agente de
  // retención: recupera el crédito fiscal igual. Antes solo «ordinario» lo recuperaba y la
  // compra de una empresa especial dejaba el IVA atrapado en «Mercancía recibida por
  // facturar» (QA de pantalla 2026-09-15, h. 75; R-34). VALIDAR-TRIBUTARIO: P-17 sigue
  // abierta para que el asesor lo confirme con su artículo.
  // Y sin documento no hay crédito fiscal que recuperar, sea cual sea el contribuyente: el
  // costo entra entero al inventario (rama `if_tax_not_recoverable` del preset, ADR-0066 §2).
  const ivaRecuperable = conSoporte && (tipoEmpresa === "ordinario" || tipoEmpresa === "especial");

  /**
   * LA RETENCIÓN DE IVA SE PRACTICA SOLA (ADR-0072 §3, H-01; contrato 2026-10-02). La empresa es
   * AGENTE si es `especial` el día del REGISTRO, día de Caracas (P-72: retener es al abono en
   * cuenta, que es el registro; la fecha de la factura solo decide si el IVA es crédito). Antes el
   * servidor solo retenía si el cuerpo traía `retention_concepts`, y ninguna pantalla lo enviaba:
   * un especial con su regla cargada registraba compras sin retener, en verde.
   *
   * Nace al REGISTRAR (abono en cuenta, criterio R-3 ratificado el 2026-09-28), por cualquier
   * camino —/admin/compras, «Ya llegó la factura», la llegada de mercancía—, porque todos pasan
   * por aquí. El 75 % (`iva_compras`) o el 100 % del art. 5 (`iva_compras_total`) son FILAS de
   * `retention_rules`: sin regla vigente, LAD53 → RETENTION_RULE_MISSING (ADR-0039 §2).
   *
   * `retention_concepts` sigue valiendo (contrato N-1): lo que el cuerpo pide se practica como
   * antes, y si ya pide un concepto de IVA no se le añade otro.
   */
  // H12 (auditoría fiscal, decidido por criterio): retener es al abono en cuenta (PA 000054 arts. 1
  // y 13 con R-3), que es el REGISTRO. La empresa es agente según su tipo el día del registro (día
  // de Caracas), no el de la factura. VALIDAR-TRIBUTARIO P-72. Alternativa: el día de la factura.
  // El IVA crédito o costo sigue leyéndose por la fecha de la factura (tipoEmpresa).
  const [diaRegistro] = await sql<{ d: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as d`;
  const esAgente = (await tipoVigente(sql, input.company_id, diaRegistro!.d)) === "especial";
  const exclusion = input.retention_exclusion;
  const motivo100 = input.iva_retention_full_reason;
  if ((exclusion !== undefined || motivo100 !== undefined) && !esAgente) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La empresa no es agente de retención hoy, el día del registro (no es contribuyente especial): quita la exclusión o el 100 % de «Retención de IVA» y vuelve a registrar. Si sí es especial, decláralo en Configuración → Mi empresa → Tipo de contribuyente.",
    });
  }
  if (
    (exclusion !== undefined || motivo100 !== undefined) &&
    (!conSoporte || prov.supplier_kind !== "nacional")
  ) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La exclusión y el 100 % son de la retención de IVA a un proveedor nacional con factura: aquí no hay retención que marcar.",
    });
  }
  let topeExclusion: { unidades: string; ut: string } | null = null;
  if (exclusion !== undefined) {
    const [ex] = await sql<{ applies: string; max_tax_units: string | null; ut: string | null }[]>`
      select applies, max_tax_units::text as max_tax_units,
             platform.tax_unit_at(${input.invoice_date}::date)::text as ut
        from public.retention_exclusions
       where code = ${exclusion.code} and effective_from <= ${input.invoice_date}::date
         and (effective_to is null or effective_to > ${input.invoice_date}::date)`;
    if (!ex || ex.applies !== "marked") {
      return err({
        code: "VALIDATION_FAILED",
        message: !ex
          ? `La exclusión «${exclusion.code}» no está en el catálogo del art. 3 vigente en esa fecha.`
          : ex.applies === "not_markable"
            ? `La exclusión «${exclusion.code}» es de compras hechas por órganos o entes públicos (art. 3 num. 11 y 12): una empresa privada no la marca.`
            : `La exclusión «${exclusion.code}» la aplica el servidor solo; no se marca.`,
      });
    }
    // AF4-01 (art. 3 num. 8): la exclusión vale para lo pagado por domiciliación a una cuenta
    // BANCARIA del agente. En el gasto con factura la cuenta se conoce aquí: si no es de banco,
    // se rechaza y el gasto se registra reteniendo. La factura registrada SIN pago no trae
    // cuenta (`gasto` o `cuentaDePago` ausentes) y no se comprueba: queda en P-95.
    const cuentaDePago = gasto?.cuentaDePago;
    if (
      cuentaDePago !== undefined &&
      cuentaDePago.kind !== CUENTA_BANCARIA &&
      EXCLUSIONES_CON_CUENTA_BANCARIA.includes(exclusion.code)
    ) {
      return err({
        code: "VALIDATION_FAILED",
        message: `Esa exclusión es para servicios pagados por domiciliación desde una cuenta bancaria. Este gasto sale de «${cuentaDePago.name}», que no es una cuenta de banco: se le retiene. Quita la exclusión, o elige la cuenta del banco si de verdad se pagó por domiciliación.`,
      });
    }
    // H7 (art. 3 num. 6 y 7): hasta N UT por operación, contra la UT vigente en la fecha de la
    // factura. Sin UT cargada con su fuente no se marca: nunca un tope supuesto.
    if (ex.max_tax_units !== null && ex.ut === null) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La exclusión «${exclusion.code}» vale hasta ${ex.max_tax_units.replace(/\.0+$/, "")} UT por operación, y no hay unidad tributaria cargada para esa fecha. Hasta que se cargue con su fuente no se puede marcar (VALIDAR-TRIBUTARIO P-71).`,
      });
    }
    if (ex.max_tax_units !== null && ex.ut !== null) {
      topeExclusion = { unidades: ex.max_tax_units, ut: ex.ut };
    }
  }
  const explicitos = input.retention_concepts ?? [];
  const [ivaPedido] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.retention_concepts
     where code = any(${explicitos}::text[]) and retention_code = 'iva'`;
  const traeIva = (ivaPedido?.n ?? 0) > 0;
  if (traeIva && (exclusion !== undefined || motivo100 !== undefined)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El cuerpo pide un concepto de retención de IVA y a la vez una exclusión o el 100 %: elige uno.",
    });
  }
  let conceptoIvaAuto: string | null = null;
  let faltaEleccion: PurchaseError | null = null;
  if (
    esAgente &&
    conSoporte &&
    prov.supplier_kind === "nacional" &&
    exclusion === undefined &&
    !traeIva
  ) {
    const tipoProv = prov.taxpayer_type_code;
    if (tipoProv === "formal") {
      // Art. 3 num. 2: al proveedor formal no se le retiene (exclusión automática, data).
      conceptoIvaAuto = null;
    } else if (
      tipoProv === null ||
      tipoProv === "ordinario" ||
      tipoProv === "especial" ||
      motivo100 !== undefined
    ) {
      // Sin tipo declarado se presume contribuyente (lado conservador: no retener cuando se debía
      // deja al agente respondiendo solidariamente, COT arts. 27 y 115).
      conceptoIvaAuto = motivo100 !== undefined ? "iva_compras_total" : "iva_compras";
    } else {
      // H6 (art. 3 num. 1): sin IVA no hay qué retener ni qué preguntar. El 422 se decide en el
      // savepoint, cuando se conoce el IVA de la factura.
      faltaEleccion = {
        code: "VALIDATION_FAILED",
        message: `El proveedor está declarado como «${tipoProv}». Una empresa agente tiene que decir qué hace con la retención: en «Retención de IVA» de la factura, marca «se retiene el 100 %» con su motivo (art. 5: proveedor no inscrito en el RIF, factura sin requisitos…) o elige la exclusión del art. 3 que aplica.`,
      };
    }
  }

  const tasa = await tasaA(
    sql,
    input.company_id,
    input.currency,
    ctx.value.functionalCurrency,
    input.invoice_date,
  );
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
  // NUNCA MÁS DE LO RECIBIDO (QA de pantalla 2026-09-15, h. 86): una orden recibida y ya
  // facturada aceptaba una SEGUNDA factura por lo mismo, y la deuda con el proveedor se
  // duplicaba. El matching de tres vías solo informaba; el tope acumulado no existía. Se
  // comprueba por línea de recepción cuando viene, y por producto de la orden cuando no.
  // H-09: la factura de un gasto no tiene orden ni recepción: no hay nada que cruzar.
  const sobre = gasto === undefined ? await topeDeFacturacion(sql, input) : null;
  if (sobre !== null) return err(sobre);

  const match = matchThreeWay({
    lines: gasto === undefined ? entradas : [],
    priceTolerancePct: tolerancia.value,
  });
  if (!match.ok && gasto === undefined) {
    return err({ code: "VALIDATION_FAILED", message: match.error.message });
  }

  const fuera = match.ok ? match.value.filter((r) => r.requiresApproval) : [];
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

  // ADR-0069 §4 (K-04): si la fecha del documento cae en un período CERRADO (o antes del inicio
  // de actividades), se registra en el período abierto —hoy en Caracas— y guarda su fecha
  // original. Lo decide `platform.accounting_date_for`, en un solo sitio. La ventana legal para
  // deducir el crédito de una factura vieja (LIVA art. 33) NO se aplica: pendiente de fuente (P-35).
  const [fechaFactura] = await sql<{ d: string }[]>`
    select platform.accounting_date_for(${input.company_id}, ${input.invoice_date}::date)::text as d`;
  const fechaContable = fechaFactura!.d;

  let facturaId = "";
  let falloRetencion: PurchaseError | null = null;
  try {
    facturaId = await sql.savepoint(async (sp) => {
      const [f] = await sp<{ id: string }[]>`
        insert into public.supplier_invoices
          (tenant_id, company_id, supplier_id, purchase_order_id, supplier_document_number,
           supplier_control_number, supplier_document_ref, invoice_date, due_date, status,
           posted_at, tax_is_recoverable, fiscal_support, transaction_currency,
           functional_currency, fx_rate,
           rate_source, rate_timestamp, rounding_policy_id, rules_version, notes,
           accounting_date, supplier_tax_id_snapshot, supplier_name_snapshot,
           retention_exclusion_code, retention_exclusion_reason, iva_retention_full_reason,
           expense_category, expense_attachment_path, expense_is_recurring)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.supplier_id},
                ${input.purchase_order_id ?? null}, ${input.supplier_document_number ?? null},
                ${input.supplier_control_number ?? null}, ${input.supplier_document_ref ?? null},
                ${input.invoice_date}::date, ${input.due_date ?? null}, 'draft', null,
                ${ivaRecuperable}, ${conSoporte}, ${input.currency},
                ${ctx.value.functionalCurrency},
                ${tasa.value.rate.toFixed()}, ${tasa.value.source}, now(), ${POLICY.id},
                ${RULES_VERSION}, ${input.notes ?? null},
                ${fechaContable === input.invoice_date ? null : fechaContable}::date,
                -- El proveedor COMO ERA al registrar la factura (hallazgo 1 de la revisión
                -- 2026-09-28, migración 20260928170100): el libro de compras reproduce el
                -- documento, no el maestro vivo.
                (select s.tax_id from public.suppliers s
                  where s.id = ${input.supplier_id} and s.company_id = ${input.company_id}),
                (select s.legal_name from public.suppliers s
                  where s.id = ${input.supplier_id} and s.company_id = ${input.company_id}),
                ${exclusion?.code ?? null}, ${exclusion?.reason ?? null}, ${motivo100 ?? null},
                ${gasto?.categoria ?? null}, ${gasto?.adjunto ?? null},
                ${gasto?.recurrente ?? false})
        returning id`;

      let n = 0;
      const subtotal = parseDecimal("0");
      const impuesto = parseDecimal("0");
      if (!subtotal.ok || !impuesto.ok) throw new Error("imposible");
      let sub = subtotal.value;
      let imp = impuesto.value;

      for (const l of lineas) {
        n += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        if (!cantidad.ok || !precio.ok) throw new Error("importe no interpretable");

        // La línea de mercancía toma nombre y categoría de su producto; la de servicio (H-09)
        // trae la categoría, que tiene que ser una del catálogo.
        const [producto] =
          l.product_id !== null
            ? await sp<{ name: string; tax_category_code: string }[]>`
                select name, tax_category_code from public.products where id = ${l.product_id}`
            : await sp<{ name: string; tax_category_code: string }[]>`
                select ${l.description ?? "Gasto"}::text as name, code as tax_category_code
                  from public.product_tax_categories where code = ${l.tax_category_code}`;
        if (!producto) {
          throw new Error(
            l.product_id !== null
              ? "producto no encontrado"
              : `La categoría tributaria «${l.tax_category_code}» no está en el catálogo.`,
          );
        }

        // La alícuota de COMPRA sale del mismo motor que la de venta, con
        // transaction_type='purchase' (ADR-0038). Sin regla no hay factura.
        let taxRuleId: string | null = null;
        let tasaImp = parseDecimal("0");
        // Sin soporte fiscal no se resuelve alícuota: lo que se pagó ES el costo, y el CHECK de
        // la base exige impuesto cero (migración 69).
        if (prov.supplier_kind === "nacional" && conSoporte) {
          const [regla] = await sp<{ tax_rule_id: string; rate: string }[]>`
            select tax_rule_id, rate::text as rate
              from platform.resolve_tax(${input.company_id}, ${input.invoice_date}::date,
                                        ${JURISDICTION}, 'iva',
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
             rounding_policy_id, tax_category_snapshot, tax_treatment, operation_type,
             capture_currency, capture_mode)
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
                  ${prov.supplier_kind === "nacional" ? "interna" : null},
                  ${l.capture_currency ?? null}, ${l.capture_mode ?? null})`;
      }

      // Y aquí pasa a `posted`: hasta este UPDATE es un borrador editable, y
      // desde él es un hecho que el trigger congela. Al pasar a `posted` DECLARA DE NUEVO su
      // versión de reglas (ADR-0079, quinta pasada, B2): se congela en el hecho, no en el borrador.
      await sp`
        update public.supplier_invoices
           set status = 'posted', posted_at = now(), rules_version = ${RULES_VERSION},
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
      // La retención automática del agente (ADR-0072 §3). Una factura sin IVA (todo exento,
      // exonerado o no sujeto) no tiene qué retener: exclusión automática del art. 3.
      const conceptos = [...explicitos];
      if (conceptoIvaAuto !== null && !imp.isZero()) conceptos.push(conceptoIvaAuto);
      if (faltaEleccion !== null && !imp.isZero()) {
        falloRetencion = faltaEleccion;
        throw new Error("falta decidir la retención");
      }
      // H7: el tope de la exclusión, contra el TOTAL de la factura en Bs (lo más estricto mientras
      // P-71 no diga si es el total o la base; decidido por criterio).
      if (topeExclusion !== null) {
        const totalBs = sub.plus(imp).times(tasa.value.rate);
        const tope = parseDecimal(topeExclusion.unidades);
        const ut = parseDecimal(topeExclusion.ut);
        if (tope.ok && ut.ok && totalBs.greaterThan(tope.value.times(ut.value))) {
          falloRetencion = {
            code: "VALIDATION_FAILED",
            message: `La exclusión «${exclusion!.code}» vale hasta ${tope.value.toFixed()} UT por operación (${tope.value.times(ut.value).toFixed(2)} Bs con la UT de ${ut.value.toFixed(2)} Bs), y esta factura suma ${totalBs.toFixed(2)} Bs: se retiene. Quita la exclusión en «Retención de IVA».`,
          };
          throw new Error("exclusión por encima del tope");
        }
      }
      if (prov.supplier_kind === "nacional" && conceptos.length > 0) {
        for (const concepto of conceptos) {
          const r = await practicarRetencion(sp, ctx.value, {
            companyId: input.company_id,
            supplierId: input.supplier_id,
            invoiceId: f!.id,
            conceptCode: concepto,
            taxpayerType: prov.taxpayer_type_code,
            personType: prov.person_type_code,
            fecha: input.invoice_date,
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
        // EL COMPROBANTE, al practicar la retención (ADR-0072 §4, H-04; P-26 cerrada): dentro del
        // mismo savepoint, porque una retención sin su documento es la que nadie entrega.
        await emitirComprobanteDeRetencion(sp, {
          tenantId: ctx.value.tenantId,
          companyId: input.company_id,
          supplierId: input.supplier_id,
          invoiceId: f!.id,
          functionalCurrency: ctx.value.functionalCurrency,
        });
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
    // El hecho contable y el evento del outbox llevan EL MISMO nombre (pgTAP 026): la factura de
    // un gasto publica y audita `ap.expense_invoice_posted`, que es también su plantilla.
    gasto === undefined ? "ap.invoice_posted" : "ap.expense_invoice_posted",
    {
      supplier_id: input.supplier_id,
      supplier_document_number: input.supplier_document_number ?? null,
      supplier_control_number: input.supplier_control_number ?? null,
      fiscal_support: conSoporte,
      total_amount: detalle.value.total_amount,
      retention_total: detalle.value.retention_total,
      tax_is_recoverable: ivaRecuperable,
      expense_category: gasto?.categoria ?? null,
      retention_voucher_number: detalle.value.retention_voucher_number,
      iva_retention_full_reason: motivo100 ?? null,
    },
  );
  // La exclusión marcada, con su motivo, como hecho propio de auditoría (ADR-0072 §3).
  if (exclusion !== undefined) {
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "supplier_invoice",
      facturaId,
      "ap.retention_excluded",
      { exclusion_code: exclusion.code, reason: exclusion.reason },
    );
  }

  /**
   * LOS IMPORTES DEL ASIENTO, EN MONEDA FUNCIONAL (hallado al probar ADR-0060,
   * 2026-09-15). El asiento recibía subtotal, IVA y total en la moneda de la
   * FACTURA con `functionalCurrency` VES: una factura de 23,20 USD acreditaba
   * cuentas por pagar con 23,20 «Bs» en vez de 928, y el pago en dólares la
   * debitaba después por 928. Se convierten con la tasa de la factura, y el
   * total funcional es la SUMA de las dos partes convertidas: redondeadas por
   * separado podrían diferir del total redondeado y descuadrar el asiento.
   */
  const aFunc = (v: string): Result<Decimal, PurchaseError> => {
    const d = parseDecimal(v);
    if (!d.ok) return err({ code: "VALIDATION_FAILED", message: d.error.message });
    return ok(d.value.times(tasa.value.rate).toDecimalPlaces(8, 4));
  };
  const subtotalFunc = aFunc(detalle.value.subtotal_amount);
  if (!subtotalFunc.ok) return subtotalFunc;
  const impuestoFunc = aFunc(detalle.value.tax_amount);
  if (!impuestoFunc.ok) return impuestoFunc;
  const totalFunc = subtotalFunc.value.plus(impuestoFunc.value);

  /**
   * LO RETENIDO, POR TRIBUTO (ADR-0065 §3, migración 68). Registrar la factura como cuenta
   * por pagar ES el abono en cuenta, y la PA SNAT/2025/000054 (G.O. 43.171, vigente desde
   * 2025-08-01) retiene «al pago o al abono en cuenta, lo que ocurra primero»: el pasivo con
   * el fisco nace AQUÍ, no cuando se le pague al proveedor. Al proveedor se le acredita el
   * neto. Los importes ya vienen en moneda funcional: `supplier_retentions` guarda la base y
   * lo retenido convertidos (migración 65).
   */
  const [retenido] = await sql<{ iva: string; islr: string }[]>`
    select coalesce(sum(retained_amount) filter (where retention_code = 'iva'), 0)::text as iva,
           coalesce(sum(retained_amount) filter (where retention_code = 'islr'), 0)::text as islr
      from public.supplier_retentions where supplier_invoice_id = ${facturaId}`;
  const ivaRetenido = parseDecimal(retenido?.iva ?? "0");
  if (!ivaRetenido.ok) {
    return err({ code: "VALIDATION_FAILED", message: ivaRetenido.error.message });
  }
  const islrRetenido = parseDecimal(retenido?.islr ?? "0");
  if (!islrRetenido.ok) {
    return err({ code: "VALIDATION_FAILED", message: islrRetenido.error.message });
  }
  const retenidoTotal = ivaRetenido.value.plus(islrRetenido.value);
  // El neto SALE del total, no se añade: el asiento cuadra por construcción.
  const netoFunc = totalFunc.minus(retenidoTotal);

  // El asiento de la compra. `taxRecoverable` es la bandera que decide si el
  // IVA va a crédito fiscal o al costo (ADR-0040 §7): la plantilla tiene las
  // dos ramas y este booleano elige, sin que nadie escriba una cuenta aquí.
  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "purchase_invoice",
    // H-09: la factura de un gasto debita gasto, no el puente de mercancía por facturar.
    sourceEvent: gasto === undefined ? "ap.invoice_posted" : "ap.expense_invoice_posted",
    sourceId: facturaId,
    postingDate: fechaContable,
    postedBy: actor.userId,
    description:
      gasto === undefined
        ? `Factura de compra ${input.supplier_document_number}`
        : `Gasto con factura: ${gasto.categoria} (${input.supplier_document_number})`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      subtotal: subtotalFunc.value.toFixed(8),
      tax_amount: impuestoFunc.value.toFixed(8),
      total: totalFunc.toFixed(8),
      net_amount: netoFunc.toFixed(8),
      retained_iva: ivaRetenido.value.toFixed(8),
      retained_islr: islrRetenido.value.toFixed(8),
      retained_total: retenidoTotal.toFixed(8),
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

  // Un servicio no pasó por el almacén: no hay recepción que revalorizar.
  if (gasto !== undefined) return detalle;
  const revalorizada = await revalorizarContraRecepcion(uow, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    functionalCurrency: ctx.value.functionalCurrency,
    facturaId,
    tasa: tasa.value.rate,
    ivaRecuperable,
    fecha: fechaContable,
    documento: input.supplier_document_number ?? "sin número",
  });
  if (!revalorizada.ok) return revalorizada;
  return detalle;
}

/**
 * LA FACTURA DISTINTA DE LO RECIBIDO (ADR-0060 §2). La recepción metió la
 * mercancía al kardex —y al mayor, contra «mercancía recibida por facturar»— a
 * su valor; la factura debita ese puente por lo que de verdad cuesta. Si
 * difieren (precio, tasa del día, IVA no recuperable), la diferencia de cada
 * línea ligada a una recepción:
 *   · revaloriza lo que QUEDA de esa mercancía en el kardex (valor sin cantidad);
 *   · va a «variación de costo de compras» por lo que ya salió, porque una salida
 *     emitida no se reescribe;
 *   · y sale del puente por el total, en un hecho propio, para que kardex y mayor
 *     se muevan juntos. Las líneas sin recepción no tocan el kardex.
 *
 * Lo que queda se estima como en el landed cost: la existencia actual de la
 * posición, acotada por lo facturado (ADR-0034 descartó el costeo por capas).
 */
async function revalorizarContraRecepcion(
  uow: UnitOfWork,
  d: {
    tenantId: string;
    companyId: string;
    functionalCurrency: string;
    facturaId: string;
    tasa: Decimal;
    ivaRecuperable: boolean;
    fecha: string;
    documento: string;
  },
): Promise<Result<true, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") return ok(true);
  const lineas = await sql<
    {
      quantity: string;
      subtotal: string;
      tax: string;
      recibida: string;
      valor_recibido: string;
      product_id: string;
      lot_id: string | null;
      warehouse_id: string;
      en_stock: string;
      q_previa: string;
      costo_previo: string;
    }[]
  >`select il.quantity::text as quantity, il.line_subtotal_transaction::text as subtotal,
           il.tax_amount::text as tax, rl.quantity::text as recibida,
           rl.functional_amount::text as valor_recibido, rl.product_id, rl.lot_id,
           gr.warehouse_id,
           coalesce((select b.quantity from public.stock_balances b
                      where b.company_id = ${d.companyId} and b.warehouse_id = gr.warehouse_id
                        and b.product_id = rl.product_id
                        and b.lot_id is not distinct from rl.lot_id), 0)::text as en_stock,
           -- C8: lo que OTRAS facturas vigentes ya facturaron de esta misma línea de recepción
           -- (cantidad, y costo al céntimo a la tasa de cada una).
           coalesce(prev.q, 0)::text as q_previa, coalesce(prev.costo, 0)::text as costo_previo
      from public.supplier_invoice_lines il
      join public.goods_receipt_lines rl on rl.id = il.goods_receipt_line_id
      join public.goods_receipts gr on gr.id = rl.goods_receipt_id
      left join lateral (
        select sum(il2.quantity) as q,
               sum(round((case when i2.tax_is_recoverable then il2.line_subtotal_transaction
                               else il2.line_subtotal_transaction + il2.tax_amount end)
                         * i2.fx_rate, 2)) as costo
          from public.supplier_invoice_lines il2
          join public.supplier_invoices i2 on i2.id = il2.supplier_invoice_id
         where il2.goods_receipt_line_id = rl.id and il2.company_id = ${d.companyId}
           and i2.id <> ${d.facturaId} and i2.status in ('posted', 'paid')
      ) prev on true
     where il.supplier_invoice_id = ${d.facturaId} and il.company_id = ${d.companyId}
     order by il.line_number`;
  if (lineas.length === 0) return ok(true);

  const cero = parseDecimal("0");
  if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: cero.error.message });
  let aInventario = cero.value;
  let aVariacion = cero.value;
  for (const l of lineas) {
    const q = parseDecimal(l.quantity);
    const sub = parseDecimal(l.subtotal);
    const tax = parseDecimal(l.tax);
    const qr = parseDecimal(l.recibida);
    const vr = parseDecimal(l.valor_recibido);
    const st = parseDecimal(l.en_stock);
    const qPrev = parseDecimal(l.q_previa);
    const cPrev = parseDecimal(l.costo_previo);
    if (
      !q.ok ||
      !sub.ok ||
      !tax.ok ||
      !qr.ok ||
      !vr.ok ||
      !st.ok ||
      !qPrev.ok ||
      !cPrev.ok ||
      qr.value.isZero()
    ) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Datos de la recepción no interpretables.",
      });
    }
    const costoTxn = d.ivaRecuperable ? sub.value : sub.value.plus(tax.value);
    // C5: UN solo redondeo, de lo exacto al céntimo. Antes iba a 8 decimales y de ahí al
    // céntimo, mientras el acumulado previo de la misma línea sale de SQL con round(x × tasa, 2)
    // directo: en el borde (10,004999995 → 10,00500000 → 10,01) esta factura se medía con 10,01
    // y la siguiente la veía como 10,00.
    const costoFunc = toCents(costoTxn.times(d.tasa));
    // C8 (revisión de la ola 3): LA DIFERENCIA SE MIDE CONTRA EL ACUMULADO DE LA LÍNEA. Con
    // facturación parcial (100,00 recibido por 3 unidades, tres facturas de 33,33) cada factura
    // difería de su tercio en −0,0033, que al céntimo es cero, y «mercancía recibida por
    // facturar» se quedaba con 0,01 para siempre. Ahora la diferencia de esta factura es lo
    // acumulado hasta ella menos lo acumulado hasta la anterior, y la que CIERRA la línea
    // (cantidad facturada ≥ recibida) compara contra el valor recibido ENTERO, al céntimo, que es
    // lo que el kardex y el puente recibieron: se lleva el residuo.
    const recibidoHasta = (qAcum: Decimal): Decimal =>
      qAcum.greaterThanOrEqualTo(qr.value)
        ? toCents(vr.value)
        : vr.value.times(qAcum).dividedBy(qr.value).toDecimalPlaces(8, 4);
    const diferenciaHasta = (costoAcum: Decimal, qAcum: Decimal): Decimal =>
      toCents(costoAcum.minus(recibidoHasta(qAcum)));
    // ADR-0075 §7: la diferencia se mide AL CÉNTIMO. Una diferencia de menos de medio céntimo
    // no es un hecho contable: antes se escribía a 8 decimales, y con el asiento al céntimo sus
    // líneas quedaban en cero y el hecho se encolaba para siempre («no produjo dos líneas»).
    // Lo que sí es céntimo se reparte entero entre kardex (inv) y variación (vari = dif − inv):
    // si la parte del kardex redondea a cero, todo va a variación; nada se omite.
    const diferencia = diferenciaHasta(
      cPrev.value.plus(costoFunc),
      qPrev.value.plus(q.value),
    ).minus(qPrev.value.isZero() ? cero.value : diferenciaHasta(cPrev.value, qPrev.value));
    if (diferencia.isZero()) continue;
    const queda = st.value.isNegative()
      ? cero.value
      : st.value.greaterThan(q.value)
        ? q.value
        : st.value;
    // ADR-0075 §7: lo que va al kardex va al céntimo, y el asiento suma ESOS céntimos.
    const inv = toCents(diferencia.times(queda).dividedBy(q.value));
    const vari = diferencia.minus(inv);
    if (!inv.isZero()) {
      const mov = await revalorizar(sql, d.tenantId, {
        company_id: d.companyId,
        warehouse_id: l.warehouse_id,
        product_id: l.product_id,
        lot_id: l.lot_id,
        amount: inv.toFixed(8),
        currency: d.functionalCurrency,
        reason: `Factura de proveedor ${d.documento} distinta de lo recibido`,
        sourceDocumentId: d.facturaId,
      });
      if (!mov.ok) return err({ code: "VALIDATION_FAILED", message: mov.error.message });
    }
    aInventario = aInventario.plus(inv);
    aVariacion = aVariacion.plus(vari);
  }
  const total = aInventario.plus(aVariacion);
  if (total.isZero()) return ok(true);

  const hecho = await generateJournalFromDocument(sql, {
    tenantId: d.tenantId,
    companyId: d.companyId,
    sourceKind: "purchase_revaluation",
    sourceEvent: "ap.invoice_posted",
    sourceId: d.facturaId,
    postingDate: d.fecha,
    postedBy: actor.userId,
    description: `Factura de compra ${d.documento}: diferencia con lo recibido`,
    functionalCurrency: d.functionalCurrency,
    amounts: {
      revaluation_to_inventory: aInventario.toFixed(8),
      revaluation_to_variance: aVariacion.toFixed(8),
      functional_amount: total.toFixed(8),
    },
  });
  if (!hecho.ok) return err({ code: "VALIDATION_FAILED", message: hecho.error.message });
  return ok(true);
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
  //
  // Y la base va en BOLÍVARES (regla del dueño, 2026-09-16: retenciones y libros siempre en
  // moneda funcional). La factura guarda sus cifras en SU moneda: una de USD 23,20 retenía
  // sobre «3,20» como si fueran bolívares y guardaba la fila rotulada VES. Se convierten con
  // la tasa de la factura, la misma con la que se asentó (VALIDAR-TRIBUTARIO P-19).
  const [f] = await sql<{ subtotal: string; iva: string }[]>`
    select round(subtotal_amount * fx_rate, 8)::text as subtotal,
           round(tax_amount * fx_rate, 8)::text as iva
      from public.supplier_invoices where id = ${d.invoiceId}`;
  const baseRaw = concepto.retention_code === "iva" ? (f?.iva ?? "0") : (f?.subtotal ?? "0");
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
          from platform.resolve_retention(${d.companyId}, ${diaNegocio(d.fecha)}::date,
                                          ${JURISDICTION},
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
           tax_is_recoverable, fiscal_support,
           retention_total::text as retention_total, transaction_currency,
           functional_currency, fx_rate::text as fx_rate, rate_source,
           accounting_date::text as accounting_date,
           retention_exclusion_code, retention_exclusion_reason, iva_retention_full_reason,
           (select v.id from public.retention_voucher_lines l
              join public.retention_vouchers v on v.id = l.retention_voucher_id
             where l.supplier_invoice_id = ${invoiceId}
               and not exists (select 1 from public.retention_vouchers n
                                where n.replaces_voucher_id = v.id)
             order by v.sequence desc limit 1) as retention_voucher_id,
           (select v.voucher_number from public.retention_voucher_lines l
              join public.retention_vouchers v on v.id = l.retention_voucher_id
             where l.supplier_invoice_id = ${invoiceId}
               and not exists (select 1 from public.retention_vouchers n
                                where n.replaces_voucher_id = v.id)
             order by v.sequence desc limit 1) as retention_voucher_number
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

  const tasa = await tasaA(
    sql,
    input.company_id,
    input.currency,
    ctx.value.functionalCurrency,
    input.incurred_on,
  );
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
  // ADR-0069 §4 (K-04): si la fecha del documento cae en un período CERRADO (o antes del inicio
  // de actividades), se registra en el período abierto —hoy en Caracas— y guarda su fecha
  // original. Lo decide `platform.accounting_date_for`, en un solo sitio. La ventana legal para
  // deducir el crédito de una factura vieja (LIVA art. 33) NO se aplica: pendiente de fuente (P-35).
  const [fechaGasto] = await sql<{ d: string }[]>`
    select platform.accounting_date_for(${input.company_id}, ${input.incurred_on}::date)::text as d`;
  const contableLanded = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "landed_cost",
    sourceEvent: "purchase.landed_cost_applied",
    sourceId: costo!.id,
    postingDate: fechaGasto!.d,
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

/**
 * LO QUE UNA FACTURA DE PROVEEDOR TODAVÍA CARGA EN CUENTAS POR PAGAR, CALCULADO DESDE SUS FILAS
 * (moneda funcional): el respaldo de `platform.settlement_ledger_open` cuando el mayor no se
 * puede leer porque la factura o algo de lo que la salda espera en la cola contable. Cada pieza
 * a SU tasa de registro: la factura por lo que cargó (menos lo retenido), cada pago por lo que
 * canceló (`functional_amount − exchange_difference`) y cada nota vigente por lo que bajó.
 *
 * Un solo cálculo para los dos que cierran una factura —el pago (`registerSupplierPayment`) y la
 * nota de crédito (`registerSupplierCreditNote`)—: es un fragmento SQL sobre el alias `i` de
 * `public.supplier_invoices`. Si cambia aquí, cambia para los dos.
 */
const cuentaPorPagarCalculada = (sql: TransactionSql) => sql`
  (round(i.functional_amount, 2) - coalesce(i.retention_total, 0)
   - coalesce((select sum(p.functional_amount - p.exchange_difference)
                 from public.supplier_payments p
                where p.supplier_invoice_id = i.id), 0)
   - coalesce((select sum(n.functional_amount)
                 from public.supplier_credit_notes n
                where n.supplier_invoice_id = i.id and n.status = 'posted'), 0))`;

// ── Nota de crédito recibida ────────────────────────────────────────────────

export async function registerSupplierCreditNote(
  uow: UnitOfWork,
  input: RegisterSupplierCreditNoteRequest,
): Promise<
  Result<
    {
      id: string;
      total_amount: string;
      balance: string;
      accounting_date: string | null;
      is_fiscal: boolean;
      document_incomplete: boolean;
      retention_untouched: boolean;
      left_credit_in_favor: boolean;
    },
    PurchaseError
  >
> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar exige un usuario real." });
  }
  // La nota de la factura de un GASTO la autoriza `expense.register`, el permiso de la operación
  // que registró esa factura (ADR-0080 §5; RESPUESTA §2.8): quien lleva los gastos corrige los
  // suyos sin permisos de compras. La de mercancía, `purchase.credit_note.register`. La clase de
  // la factura se mira antes de autorizar SOLO para elegir el permiso; nada sale sin él.
  const [clase] = await sql<{ gasto: boolean }[]>`
    select expense_category is not null as gasto from public.supplier_invoices
     where id = ${input.supplier_invoice_id} and company_id = ${input.company_id}`;
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    clase?.gasto === true ? "expense.register" : "purchase.credit_note.register",
  );
  if (!ctx.ok) return ctx;

  // La factura se BLOQUEA: dos notas a la vez sobre la misma factura medirían el mismo tope.
  const [factura] = await sql<
    {
      supplier_id: string;
      status: string;
      tax_is_recoverable: boolean;
      fiscal_support: boolean;
      expense_category: string | null;
      transaction_currency: string;
      total_amount: string;
      ya_abonado: string;
      retenida: boolean;
      saldo: string | null;
      mayor: string | null;
      calculado: string | null;
      fx_rate: string;
      nota_futura: boolean;
      nota_anterior: boolean;
    }[]
  >`
    select i.supplier_id, i.status, i.tax_is_recoverable, i.fiscal_support, i.expense_category,
           -- AF5-11: las dos fechas, date contra date; «hoy» es el día de Caracas.
           ${input.note_date}::date > platform.caracas_day(now()) as nota_futura,
           ${input.note_date}::date < i.invoice_date as nota_anterior,
           i.transaction_currency, i.total_amount::text as total_amount,
           coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                      where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)::text
             as ya_abonado,
           exists (select 1 from public.supplier_retentions r
                    where r.supplier_invoice_id = i.id and r.status <> 'cancelled') as retenida,
           -- Lo que todavía se le debe de la factura según el AUXILIAR, en su moneda. De aquí
           -- sale cuánto de la nota es saldo a favor. NO se lee del mayor a propósito: lo que
           -- el mayor dice lo comprueba después supplier_credit_ledger_gap, y un invariante
           -- que lee la misma cifra que lo alimenta nace verde por construcción.
           platform.supplier_invoice_balance(i.company_id, i.id)::text as saldo,
           -- Lo que el mayor le carga hoy en cuentas por pagar. SOLO para el diferencial de la
           -- nota que CIERRA la factura (como el pago que cierra, ADR-0075 §4); el saldo a favor
           -- no se calcula con esto.
           platform.settlement_ledger_open(i.company_id, 'ap', i.id)::text as mayor,
           -- Cuarta ronda: el respaldo cuando el mayor no se puede leer (alguna pieza espera en
           -- la cola contable). El MISMO cálculo que usa el pago que cierra.
           ${cuentaPorPagarCalculada(sql)}::text as calculado,
           i.fx_rate::text as fx_rate
      from public.supplier_invoices i
     where i.id = ${input.supplier_invoice_id} and i.company_id = ${input.company_id}
       for update of i`;
  if (!factura) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!["posted", "paid"].includes(factura.status)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo se abona contra una factura asentada.",
    });
  }
  if (input.currency !== factura.transaction_currency) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La nota de crédito va en la moneda de su factura (${factura.transaction_currency}).`,
    });
  }
  // AF5-11: una nota fechada en el futuro caería en un período futuro, y una anterior a su
  // factura corrige un documento que todavía no existía.
  if (factura.nota_futura) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La nota no puede tener fecha futura: escribe la fecha que trae el papel.",
    });
  }
  if (factura.nota_anterior) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La nota no puede ser anterior a la factura que corrige: revisa la fecha del papel.",
    });
  }
  // H-03 (ADR-0083): la factura de un GASTO (compra de servicio, ADR-0080) no pasó por el
  // almacén; la de mercancía tiene que decir si la mercancía VOLVIÓ o si solo bajó el precio.
  const esGasto = factura.expense_category !== null;
  if (!esGasto && input.kind === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Di qué es la nota: una devolución de mercancía al proveedor o una rebaja de precio sin devolución.",
    });
  }
  if (esGasto && input.kind === "devolucion") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La factura de un gasto no tiene mercancía que devolver: la nota corrige su importe.",
    });
  }
  // H-03 (RESPUESTA §3): la nota sigue a su factura. Sin soporte fiscal (ADR-0066 §2) no es una
  // nota fiscal y no va al libro; con soporte, el número de control se pide (PA 00071 art. 23 →
  // art. 13) pero su falta NO impide registrarla: reduce el crédito y queda «incompleta».
  const esFiscal = factura.fiscal_support;
  // AF5-14: SIN número de control ⇒ incompleta. Una referencia cualquiera no exime (la letra
  // del dueño: «si viene sin control… queda marcada»); el esquema lo repite (20261005110700).
  const incompleta = esFiscal && input.supplier_control_number === undefined;

  const lineasFactura = await sql<
    {
      id: string;
      product_id: string | null;
      description: string;
      quantity: string;
      tasa_iva: string;
      warehouse_id: string | null;
      lot_id: string | null;
      devuelto: string;
      tracks_lots: boolean;
    }[]
  >`
    select il.id, il.product_id, il.description, il.quantity::text as quantity,
           il.tax_rate_snapshot::text as tasa_iva, gr.warehouse_id, rl.lot_id,
           coalesce((select sum(cl.quantity)
                       from public.supplier_credit_note_lines cl
                       join public.supplier_credit_notes n on n.id = cl.supplier_credit_note_id
                      where cl.supplier_invoice_line_id = il.id and n.status = 'posted'
                        and n.correction_kind = 'devolucion'), 0)::text as devuelto,
           coalesce((select p.tracks_lots from public.products p where p.id = il.product_id),
                    false) as tracks_lots
      from public.supplier_invoice_lines il
      left join public.goods_receipt_lines rl on rl.id = il.goods_receipt_line_id
      left join public.goods_receipts gr on gr.id = rl.goods_receipt_id
     where il.supplier_invoice_id = ${input.supplier_invoice_id}
       and il.company_id = ${input.company_id}
     order by il.line_number`;
  /** Cada línea de la nota, con la línea de la factura que corrige. */
  const resueltas: (typeof lineasFactura)[number][] = [];
  for (const l of input.lines) {
    const candidatas =
      l.supplier_invoice_line_id !== undefined
        ? lineasFactura.filter((f) => f.id === l.supplier_invoice_line_id)
        : lineasFactura.filter((f) => f.product_id !== null && f.product_id === l.product_id);
    if (candidatas.length === 0) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Una línea de la nota no corresponde a ninguna línea de esa factura.",
      });
    }
    if (candidatas.length > 1) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "La factura trae ese producto en más de una línea: indica cuál corrige la nota (supplier_invoice_line_id).",
      });
    }
    const linea = candidatas[0]!;
    if (l.product_id !== undefined && linea.product_id !== l.product_id) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "El producto de la línea de la nota no es el de la línea de la factura que corrige.",
      });
    }
    // Una línea de la factura se abona UNA vez por nota: dos líneas de la nota sobre la misma
    // pasarían cada una el tope de lo facturado (3 + 3 sobre 4). El esquema lo repite con un
    // índice único.
    if (resueltas.some((r) => r.id === linea.id)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La nota abona «${linea.description}» más de una vez: junta esa línea en una sola.`,
      });
    }
    resueltas.push(linea);
  }

  const tasa = await tasaA(
    sql,
    input.company_id,
    input.currency,
    ctx.value.functionalCurrency,
    input.note_date,
  );
  if (!tasa.ok) return tasa;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  // ADR-0069 §4 (K-04): si la fecha del documento cae en un período CERRADO (o antes del inicio
  // de actividades), se registra en el período abierto —hoy en Caracas— y guarda su fecha
  // original. Lo decide `platform.accounting_date_for`, en un solo sitio. La ventana legal para
  // deducir el crédito de una factura vieja (LIVA art. 33) NO se aplica: pendiente de fuente (P-35).
  const [fechaNota] = await sql<{ d: string }[]>`
    select platform.accounting_date_for(${input.company_id}, ${input.note_date}::date)::text as d`;
  const fechaContableNota = fechaNota!.d;
  try {
    const registrada = await sql.savepoint(async (sp) => {
      const [n] = await sp<{ id: string }[]>`
        insert into public.supplier_credit_notes
          (tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
           supplier_control_number, supplier_document_ref, note_date, status, posted_at, reason,
           transaction_currency, functional_currency, fx_rate, rate_source, rate_timestamp,
           rounding_policy_id, accounting_date, correction_kind, is_fiscal,
           document_incomplete)
        values (${ctx.value.tenantId}, ${input.company_id}, ${factura.supplier_id},
                ${input.supplier_invoice_id}, ${input.supplier_document_number},
                ${input.supplier_control_number ?? null}, ${input.supplier_document_ref ?? null},
                ${input.note_date}::date, 'draft', null, ${input.reason}, ${input.currency},
                ${ctx.value.functionalCurrency}, ${tasa.value.rate.toFixed()},
                ${tasa.value.source}, now(), ${POLICY.id},
                ${fechaContableNota === input.note_date ? null : fechaContableNota}::date,
                ${esGasto ? null : (input.kind ?? null)}, ${esFiscal}, ${incompleta})
        returning id`;

      const sub = parseDecimal("0");
      const imp = parseDecimal("0");
      if (!sub.ok || !imp.ok) throw new Error("imposible");
      let subtotal = sub.value;
      let impuesto = imp.value;
      let k = 0;
      for (const l of input.lines) {
        const origen = resueltas[k]!;
        k += 1;
        const cantidad = parseDecimal(l.quantity);
        const precio = Money.of(l.unit_price, input.currency);
        const tasaIva = parseDecimal(origen.tasa_iva);
        if (!cantidad.ok || !precio.ok || !tasaIva.ok) throw new Error("importe no interpretable");
        const base = Money.of(
          precio.value.multiply(cantidad.value).amount.toDecimalPlaces(8, 4).toFixed(8),
          input.currency,
        );
        if (!base.ok) throw new Error("base fuera de rango");
        // H-03: el IVA de la línea NO se teclea. Sale de la alícuota CONGELADA en la línea de la
        // factura que se corrige; antes, la pantalla no lo mandaba y la nota tenía IVA 0 (no
        // revertía el crédito fiscal). Si el cliente lo manda (el papel lo trae), se respeta.
        // Sin soporte fiscal la factura no discriminó IVA: la nota tampoco.
        const ivaCalculado = esFiscal ? toCents(base.value.amount.times(tasaIva.value)) : sub.value;
        if (l.tax_amount !== undefined) {
          const enviado = parseDecimal(l.tax_amount);
          if (!enviado.ok) throw new Error("importe no interpretable");
          if (!esFiscal && !enviado.value.isZero()) {
            throw new Error(
              "Esta compra se registró sin factura fiscal: su nota de crédito no lleva IVA.",
            );
          }
          // El IVA de la nota lo calcula el SERVIDOR. Lo que mande el cliente solo se admite si
          // coincide (un céntimo de holgura por el redondeo del papel): nunca manda sobre la
          // alícuota congelada de la línea, tampoco en una línea exenta.
          const dif = enviado.value.minus(ivaCalculado);
          if ((dif.isNegative() ? dif.negated() : dif).greaterThan("0.01")) {
            throw new Error(
              `El IVA de «${origen.description}» no cuadra: con la alícuota de su factura son ${ivaCalculado.toFixed(2)} y la nota trae ${enviado.value.toFixed(2)}. Revisa la base o el papel del proveedor.`,
            );
          }
        }
        const impLinea = Money.of(ivaCalculado.toFixed(8), input.currency);
        if (!impLinea.ok) throw new Error("importe no interpretable");
        if (!esGasto && input.kind === "devolucion") {
          const facturado = parseDecimal(origen.quantity);
          const devuelto = parseDecimal(origen.devuelto);
          if (!facturado.ok || !devuelto.ok) throw new Error("importe no interpretable");
          if (devuelto.value.plus(cantidad.value).greaterThan(facturado.value)) {
            throw new Error(
              `No se puede devolver más de lo facturado: «${origen.description}» trae ${facturado.value.toFixed()} y ya se devolvieron ${devuelto.value.toFixed()}.`,
            );
          }
        }
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
        await sp`
          insert into public.supplier_credit_note_lines
            (tenant_id, company_id, supplier_credit_note_id, line_number,
             supplier_invoice_line_id, product_id, description, quantity,
             unit_price_transaction, tax_amount, line_subtotal_transaction,
             line_total_transaction, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             rounding_policy_id)
          values (${ctx.value.tenantId}, ${input.company_id}, ${n!.id}, ${k},
                  ${origen.id}, ${origen.product_id},
                  ${l.description ?? origen.description}, ${l.quantity},
                  ${precio.value.toAmountString()}, ${impLinea.value.toAmountString()},
                  ${base.value.toAmountString()}, ${total.toFixed(8)},
                  ${base.value.toAmountString()}, ${input.currency},
                  ${tasa.value.rate.toFixed()},
                  ${totalFunc.ok ? totalFunc.value.toAmountString() : total.toFixed(8)},
                  ${ctx.value.functionalCurrency}, ${tasa.value.source}, now(), ${POLICY.id})`;
      }
      // EL TOPE: lo abonado a una factura no pasa de su total. Una nota mayor que su factura no
      // corrige esa factura: es otro documento.
      const totalFactura = parseDecimal(factura.total_amount);
      const yaAbonado = parseDecimal(factura.ya_abonado);
      if (!totalFactura.ok || !yaAbonado.ok) throw new Error("importe no interpretable");
      if (yaAbonado.value.plus(subtotal).plus(impuesto).greaterThan(totalFactura.value)) {
        throw new Error(
          `La nota (${subtotal.plus(impuesto).toFixed(2)}) más lo ya abonado (${yaAbonado.value.toFixed(2)}) pasa del total de la factura (${totalFactura.value.toFixed(2)} ${input.currency}).`,
        );
      }
      // EL SALDO A FAVOR (ADR-0083 §5): lo que la nota abona POR ENCIMA de lo que el mayor todavía
      // le debía al proveedor por esta factura. Sobre una factura ya pagada es la nota entera. Se
      // guarda al registrar y se asienta en SU cuenta (`supplier_credit_receivable`, un activo):
      // la cuenta por pagar de la factura baja solo por lo que se debía y queda en cero.
      const saldoAntes = parseDecimal(factura.saldo ?? "0");
      const debia = saldoAntes.ok && saldoAntes.value.greaterThan(0) ? saldoAntes.value : sub.value;
      const totalNota = subtotal.plus(impuesto);
      const totalFuncional = toCents(
        subtotal
          .times(tasa.value.rate)
          .toDecimalPlaces(8, 4)
          .plus(impuesto.times(tasa.value.rate).toDecimalPlaces(8, 4)),
      );
      // En la moneda de la FACTURA: lo que la nota pasa de lo que se debía. Así una nota a otra
      // tasa sobre una factura en divisa a medio pagar no llama «saldo a favor» a lo que es
      // diferencia de cambio (esa la reconoce el pago que cierra, ADR-0075 §4).
      const excede = totalNota.greaterThan(debia) ? totalNota.minus(debia) : sub.value;
      const convertido = toCents(excede.times(tasa.value.rate));
      const aFavor = excede.equals(totalNota)
        ? totalFuncional
        : convertido.greaterThan(totalFuncional)
          ? totalFuncional
          : convertido;
      await sp`
        update public.supplier_credit_notes
           set status = 'posted', posted_at = now(),
               subtotal_amount = ${subtotal.toFixed(8)}, tax_amount = ${impuesto.toFixed(8)},
               total_amount = ${subtotal.plus(impuesto).toFixed(8)},
               amount_transaction_currency = ${subtotal.plus(impuesto).toFixed(8)},
               functional_amount = ${subtotal.plus(impuesto).times(tasa.value.rate).toDecimalPlaces(8, 4).toFixed(8)},
               credit_in_favor_functional = ${aFavor.toFixed(8)},
               -- Lo mismo en la moneda de la FACTURA: es lo que compara
               -- supplier_credit_subledger_gaps contra el auxiliar recalculado (20261005110600).
               credit_in_favor_transaction = ${excede.toFixed(8)}
         where id = ${n!.id}`;
      // LA NOTA QUE CIERRA (deja el saldo de la factura en cero) a otra tasa: lo que el mayor
      // todavía cargaba en cuentas por pagar y lo que la nota le baja difieren por la tasa. Esa
      // diferencia es DIFERENCIAL CAMBIARIO, igual que en el pago que cierra, y se reconoce
      // aquí: la cuenta por pagar del documento queda en cero. Positivo = pérdida.
      const cierra =
        saldoAntes.ok && saldoAntes.value.greaterThan(0) && !totalNota.lessThan(saldoAntes.value);
      // CON EL MAYOR SIN LEER (cuarta ronda). `settlement_ledger_open` calla si la factura, un
      // pago u otra nota esperan en la cola contable —en la empresa sin contabilidad, siempre—.
      // Antes el diferencial valía entonces 0, la nota se asentaba o se encolaba sin él, y al
      // procesarse la cola quedaba un residuo PERMANENTE en cuentas por pagar. Ahora hace lo que
      // el pago que cierra: sin mayor, lo que la factura todavía carga se calcula con las tasas
      // de registro de sus piezas (`cuentaPorPagarCalculada`), que es lo que esos asientos
      // llevarán al mayor cuando se procesen.
      const mayor = parseDecimal(factura.mayor ?? factura.calculado ?? "");
      const diferencial =
        cierra && mayor.ok ? totalFuncional.minus(aFavor).minus(toCents(mayor.value)) : sub.value;
      return { id: n!.id, aFavor, diferencial };
    });
    const nota = registrada.id;

    // EL ASIENTO DE LA NOTA (ADR-0065 §1, migración 67). La nota devuelve mercancía: baja la
    // deuda con el proveedor y revierte lo que la factura cargó — inventario y crédito fiscal
    // (LIVA art. 37: el impuesto de la operación anulada se deduce del crédito fiscal), o
    // inventario por el total si el IVA no era recuperable. Antes NO generaba asiento: la deuda
    // bajaba en el auxiliar y el mayor seguía debiendo el bruto, y ningún control lo veía.
    const [importes] = await sql<{ sub: string; imp: string; tot: string }[]>`
      select subtotal_amount::text as sub, tax_amount::text as imp, total_amount::text as tot
        from public.supplier_credit_notes where id = ${nota}`;
    const aFunc = (v: string): Result<Decimal, PurchaseError> => {
      const d = parseDecimal(v);
      if (!d.ok) return err({ code: "VALIDATION_FAILED", message: d.error.message });
      return ok(d.value.times(tasa.value.rate).toDecimalPlaces(8, 4));
    };
    const subFunc = aFunc(importes?.sub ?? "0");
    if (!subFunc.ok) return subFunc;
    const impFunc = aFunc(importes?.imp ?? "0");
    if (!impFunc.ok) return impFunc;
    // El total funcional es la SUMA de las dos partes convertidas, no el total convertido:
    // redondeados por separado podrían diferir y descuadrar el asiento (misma regla que la
    // factura de compra).
    const totFunc = subFunc.value.plus(impFunc.value);
    const eventoNota = esGasto ? "ap.expense_credit_note_received" : "ap.credit_note_received";
    const contable = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId: input.company_id,
      sourceKind: "purchase_credit_note",
      // La nota de un GASTO revierte gasto, no inventario: su plantilla y su evento son propios,
      // como los de su factura (ADR-0080 §3 y §4).
      sourceEvent: eventoNota,
      sourceId: nota,
      postingDate: fechaContableNota,
      postedBy: actor.userId,
      description: `Nota de crédito del proveedor ${input.supplier_document_number}`,
      functionalCurrency: ctx.value.functionalCurrency,
      amounts: {
        subtotal: subFunc.value.toFixed(8),
        tax_amount: impFunc.value.toFixed(8),
        total: totFunc.toFixed(8),
        // ADR-0083 §5: débito al saldo a favor y crédito a cuentas por pagar, por este importe.
        credit_surplus: registrada.aFavor.toFixed(8),
        exchange_difference: registrada.diferencial.toFixed(8),
      },
      // AF-M03 (ADR-0075 §4): a la tasa de la factura no hay diferencial; lo que quede es redondeo.
      ...(tasa.value.rate.equals(factura.fx_rate) ? { differenceIsRounding: true } : {}),
      conditions: { taxRecoverable: factura.tax_is_recoverable },
      backlink: { table: "supplier_credit_notes", id: nota },
    });
    if (!contable.ok) {
      return err({ code: "VALIDATION_FAILED", message: contable.error.message });
    }

    // EL KARDEX (H-03, ADR-0083 §2; ADR-0060). El asiento de arriba acredita `inventory_general`
    // por la base de la nota (o por el total, si el IVA fue al costo). Antes el kardex no se
    // enteraba y `inventory_ledger_gap` crecía por el importe de cada nota. Ahora:
    //   · devolución → la mercancía SALE del depósito a su costo de kardex;
    //   · rebaja     → se revaloriza a la baja lo que siga en existencia;
    // y la diferencia entre lo que el asiento acreditó y lo que el kardex bajó —lo ya vendido,
    // o un costo de kardex distinto del precio abonado— va a variación de costo de compras.
    if (!esGasto) {
      const cero = parseDecimal("0");
      if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: cero.error.message });
      const acreditado = toCents(factura.tax_is_recoverable ? subFunc.value : totFunc);
      let bajado = cero.value;
      if (input.kind === "devolucion") {
        const porDeposito = new Map<
          string,
          { product_id: string; quantity: string; lot_id?: string | null }[]
        >();
        for (let i = 0; i < input.lines.length; i += 1) {
          const origen = resueltas[i]!;
          // Con recepción MANDA el depósito de la recepción; el enviado solo vale para la línea
          // que no viene de una (lo que dicen el contrato y ADR-0083).
          const deposito = origen.warehouse_id ?? input.warehouse_id;
          if (deposito === null || deposito === undefined || origen.product_id === null) {
            return err({
              code: "VALIDATION_FAILED",
              message: `Di de qué depósito sale «${origen.description}»: su línea de factura no viene de una recepción.`,
            });
          }
          // El LOTE lo dice la recepción o la persona, nunca FEFO: FEFO excluye lo vencido, y
          // devolverle al proveedor la mercancía vencida es justo el caso.
          const lote = origen.lot_id ?? input.lines[i]!.lot_id ?? null;
          if (origen.tracks_lots && lote === null) {
            return err({
              code: "VALIDATION_FAILED",
              message: `Di de qué lote sale «${origen.description}»: se lleva por lotes y su línea de factura no viene de una recepción.`,
            });
          }
          // El lote que dice la PERSONA se comprueba antes de mover nada: que sea de ese
          // producto y que esté en ese depósito. Sin esto la salida respondía «Recurso no
          // encontrado», que no dice qué corregir.
          if (origen.lot_id === null && lote !== null) {
            const [elegido] = await sql<{ del_producto: boolean; en_deposito: boolean }[]>`
              select l.product_id = ${origen.product_id} as del_producto,
                     exists (select 1 from public.stock_balances b
                              where b.company_id = l.company_id and b.warehouse_id = ${deposito}
                                and b.product_id = l.product_id and b.lot_id = l.id) as en_deposito
                from public.lots l
               where l.id = ${lote} and l.company_id = ${input.company_id}`;
            if (!elegido?.del_producto) {
              return err({
                code: "VALIDATION_FAILED",
                message: `El lote elegido no es de «${origen.description}»: elige uno de los lotes de ese producto.`,
              });
            }
            if (!elegido.en_deposito) {
              return err({
                code: "VALIDATION_FAILED",
                message: `Ese lote de «${origen.description}» no está en el depósito elegido: cambia el depósito o el lote.`,
              });
            }
          }
          const lista = porDeposito.get(deposito) ?? [];
          lista.push({
            product_id: origen.product_id,
            quantity: input.lines[i]!.quantity,
            ...(lote === null ? {} : { lot_id: lote }),
          });
          porDeposito.set(deposito, lista);
        }
        for (const [deposito, lineas] of porDeposito) {
          const salida = await issueStockBatchForSupplierReturn(uow, {
            company_id: input.company_id,
            warehouse_id: deposito,
            lines: lineas,
            note: `Devolución al proveedor · nota de crédito ${input.supplier_document_number}`,
            sourceDocumentId: nota,
          });
          if (!salida.ok) {
            if (salida.error.code === "NEGATIVE_STOCK") {
              return err({
                code: "NEGATIVE_STOCK",
                message:
                  "Ya no tienes esa mercancía para devolverla; si el proveedor te la abonó igual, regístrala como rebaja.",
              });
            }
            if (salida.error.code === "PERMISSION_REQUIRED") {
              return err({ code: "PERMISSION_REQUIRED", message: salida.error.message });
            }
            return err({ code: "VALIDATION_FAILED", message: salida.error.message });
          }
          for (const m of salida.value) {
            const v = parseDecimal(m.functional_amount);
            if (!v.ok) return err({ code: "VALIDATION_FAILED", message: v.error.message });
            bajado = bajado.minus(v.value);
          }
        }
      } else {
        // LOS CANDADOS, ANTES DE REPARTIR Y EN ORDEN ESTABLE. El reparto de abajo recorre las
        // posiciones por PRIORIDAD (la de la recepción primero), que no es un orden global: dos
        // notas simultáneas sobre el mismo producto podían tomarlas cruzadas e interbloquearse.
        // Aquí se toman todas las de los productos de la nota en un único orden (producto,
        // depósito, lote); el reparto las vuelve a pedir ya dentro de la transacción.
        //
        // EL ORDEN LO PONE EL CÓDIGO (cuarta ronda). Antes iba en un `order by` dentro de una
        // subconsulta, que SQL no obliga a respetar al recorrer el LATERAL, y solo tomaba las
        // posiciones con existencia: una que estuviera en cero y recibiera mercancía antes del
        // reparto se bloqueaba después, fuera de orden. Ahora: se leen las claves de TODAS las
        // posiciones de esos productos (también las que están en cero), se ordenan aquí y se
        // bloquean en una sentencia que las recorre por su ordinal, como `issueStockBatch`
        // («claves ordenadas, una sentencia») y con su mismo orden dentro de un depósito.
        const productosDeLaNota = [
          ...new Set(resueltas.map((r) => r.product_id).filter((p): p is string => p !== null)),
        ];
        if (productosDeLaNota.length > 0) {
          const claves = await sql<
            { product_id: string; warehouse_id: string; lot_id: string | null }[]
          >`
            select b.product_id, b.warehouse_id, b.lot_id
              from public.stock_balances b
             where b.company_id = ${input.company_id}
               and b.product_id = any(${productosDeLaNota}::uuid[])`;
          const enOrden = claves
            .map((c) => `${c.product_id}|${c.warehouse_id}|${c.lot_id ?? ""}`)
            .sort()
            .map((c) => c.split("|"));
          if (enOrden.length > 0) {
            await sql`
              select p.quantity
                from unnest(${enOrden.map((c) => c[0]!)}::uuid[],
                            ${enOrden.map((c) => c[1]!)}::uuid[],
                            ${enOrden.map((c) => (c[2] === "" ? null : c[2]!))}::uuid[])
                       with ordinality as u(product_id, warehouse_id, lot_id, orden),
                     lateral platform.lock_stock_position(${input.company_id}, u.warehouse_id,
                                                          u.product_id, u.lot_id) p
               order by u.orden`;
          }
        }
        for (let i = 0; i < input.lines.length; i += 1) {
          const origen = resueltas[i]!;
          if (origen.product_id === null) continue;
          const [linea] = await sql<{ sub: string; imp: string }[]>`
            select line_subtotal_transaction::text as sub, tax_amount::text as imp
              from public.supplier_credit_note_lines
             where supplier_credit_note_id = ${nota} and line_number = ${i + 1}`;
          const q = parseDecimal(input.lines[i]!.quantity);
          const sub = parseDecimal(linea?.sub ?? "0");
          const imp = parseDecimal(linea?.imp ?? "0");
          if (!q.ok || !sub.ok || !imp.ok || q.value.isZero()) {
            return err({
              code: "VALIDATION_FAILED",
              message: "Línea de la nota no interpretable.",
            });
          }
          // DÓNDE ESTÁ LA MERCANCÍA HOY. La rebaja baja el costo de lo que QUEDE del producto en
          // la empresa, esté donde esté: la posición de su recepción primero (depósito y lote),
          // luego el depósito indicado, luego las demás de mayor a menor existencia. Antes solo
          // miraba el depósito y el lote de la recepción: una línea sin recepción, un producto
          // por lotes o mercancía trasladada mandaban TODA la rebaja a variación con la
          // existencia delante. Lo que no quede en ninguna posición —lo ya vendido— sí es
          // variación.
          const posiciones = await sql<{ warehouse_id: string; lot_id: string | null }[]>`
            select b.warehouse_id, b.lot_id
              from public.stock_balances b
             where b.company_id = ${input.company_id} and b.product_id = ${origen.product_id}
               and b.quantity > 0
             order by (b.warehouse_id = ${origen.warehouse_id}::uuid
                       and b.lot_id is not distinct from ${origen.lot_id}::uuid) desc nulls last,
                      (b.warehouse_id = ${input.warehouse_id ?? null}::uuid) desc nulls last,
                      b.quantity desc, b.warehouse_id, b.lot_id`;
          const costoUnidad = (factura.tax_is_recoverable ? sub.value : sub.value.plus(imp.value))
            .times(tasa.value.rate)
            .dividedBy(q.value);
          let porRepartir = q.value;
          for (const p of posiciones) {
            if (!porRepartir.greaterThan(0)) break;
            // La posición se lee CON SU CANDADO: una venta a la vez no la mueve entre la lectura
            // y la revalorización.
            const [pos] = await sql<{ q: string; v: string }[]>`
              select quantity::text as q, value::text as v
                from platform.lock_stock_position(${input.company_id}, ${p.warehouse_id},
                                                  ${origen.product_id}, ${p.lot_id})`;
            const enStock = parseDecimal(pos?.q ?? "0");
            const valor = parseDecimal(pos?.v ?? "0");
            if (!enStock.ok || !valor.ok) {
              return err({ code: "VALIDATION_FAILED", message: "Existencia no interpretable." });
            }
            if (!enStock.value.greaterThan(0)) continue;
            const toma = enStock.value.greaterThan(porRepartir) ? porRepartir : enStock.value;
            porRepartir = porRepartir.minus(toma);
            // Al céntimo (ADR-0075 §7), y nunca más de lo que la posición vale: una rebaja no
            // deja existencias con valor negativo.
            let inv = toCents(costoUnidad.times(toma));
            const tope = valor.value.toDecimalPlaces(2, 1);
            if (inv.greaterThan(tope)) inv = tope.isNegative() ? cero.value : tope;
            if (inv.isZero()) continue;
            const mov = await revalorizar(sql, ctx.value.tenantId, {
              company_id: input.company_id,
              warehouse_id: p.warehouse_id,
              product_id: origen.product_id,
              lot_id: p.lot_id,
              amount: cero.value.minus(inv).toFixed(8),
              currency: ctx.value.functionalCurrency,
              reason: `Rebaja de precio · nota de crédito ${input.supplier_document_number} del proveedor`,
              sourceDocumentId: nota,
            });
            if (!mov.ok) return err({ code: "VALIDATION_FAILED", message: mov.error.message });
            bajado = bajado.plus(inv);
          }
        }
      }
      // Lo que el asiento acreditó a inventario y el kardex NO bajó (o bajó de más).
      const aVariacion = acreditado.minus(bajado);
      if (!aVariacion.isZero()) {
        const ajuste = await generateJournalFromDocument(sql, {
          tenantId: ctx.value.tenantId,
          companyId: input.company_id,
          sourceKind: "purchase_revaluation",
          sourceEvent: "ap.credit_note_received",
          sourceId: nota,
          postingDate: fechaContableNota,
          postedBy: actor.userId,
          description: `Nota de crédito ${input.supplier_document_number}: diferencia entre lo abonado y el kardex`,
          functionalCurrency: ctx.value.functionalCurrency,
          amounts: {
            revaluation_to_inventory: aVariacion.toFixed(8),
            revaluation_to_variance: cero.value.minus(aVariacion).toFixed(8),
            functional_amount: "0",
          },
        });
        if (!ajuste.ok) return err({ code: "VALIDATION_FAILED", message: ajuste.error.message });
      }
    }

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
      eventoNota,
      {
        supplier_invoice_id: input.supplier_invoice_id,
        supplier_document_number: input.supplier_document_number,
        total_amount: total?.t ?? "0",
        balance_after: saldo?.s ?? "0",
        journal_entry_id: contable.value.kind === "posted" ? contable.value.entryId : null,
        kind: esGasto ? null : (input.kind ?? null),
        is_fiscal: esFiscal,
        document_incomplete: incompleta,
        // VALIDAR-SENIAT (P-103): la nota NO ajusta la retención practicada ni su comprobante.
        retention_untouched: factura.retenida,
        credit_in_favor_functional: registrada.aFavor.toFixed(8),
      },
    );
    return ok({
      id: nota,
      total_amount: total?.t ?? "0",
      balance: saldo?.s ?? "0",
      // K-04: la fecha en que se registró si la suya cae en un período cerrado; si no, null.
      accounting_date: fechaContableNota === input.note_date ? null : fechaContableNota,
      is_fiscal: esFiscal,
      document_incomplete: incompleta,
      retention_untouched: factura.retenida,
      left_credit_in_favor: !registrada.aFavor.isZero(),
    });
  } catch (e) {
    // LAD46 (trigger del kardex): el lote que sale está VENCIDO y quien registra no tiene el
    // permiso de despacharlo. Devolverle al proveedor lo vencido es justo el caso: el mensaje
    // dice qué permiso falta, no un «no tienes permiso» sin nombre.
    if ((e as { code?: string }).code === "LAD46") {
      return err({
        code: "PERMISSION_REQUIRED",
        message:
          "Ese lote está vencido: sacarlo del depósito para devolverlo al proveedor exige el permiso de despachar mercancía vencida (inventory.expired). Pídeselo a quien administra los permisos.",
      });
    }
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
  /**
   * H-09: el pago de la factura de un gasto lo autoriza `expense.register`, el permiso de la
   * operación que lo contiene (RESPUESTA §2.8). Solo lo pasa `registerInvoicedExpense`.
   */
  permiso: "purchase.payment.register" | "expense.register" = "purchase.payment.register",
  /**
   * SOLO PARA LA VISTA PREVIA (que se deshace siempre): si la cuenta no alcanza, el pago sigue
   * y el mensaje del control de saldo queda aquí, para enseñar el resumen JUNTO al «no alcanza».
   * El camino real no lo pasa nunca: sin él, la falta de saldo detiene el pago como siempre.
   */
  ensayo?: { sinSaldo: string | null },
): Promise<Result<SupplierPaymentResponse, PurchaseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Pagar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso);
  if (!ctx.ok) return ctx;

  const [factura] = await sql<
    { supplier_id: string; status: string; transaction_currency: string; fx_rate: string }[]
  >`select supplier_id, status, transaction_currency, fx_rate::text as fx_rate
       from public.supplier_invoices
     where id = ${input.supplier_invoice_id} and company_id = ${input.company_id}
     for update`;
  // `for update`: dos pagos simultáneos del mismo saldo pasaban ambos el tope
  // (auditoría 2026-09-11, M-16). El segundo espera y ve el saldo real.
  if (!factura) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (factura.status !== "posted") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se paga una factura asentada; esta está en ${factura.status}.`,
    });
  }
  /**
   * EL PAGO CRUZADO (ADR-0075 §3, D-02). El saldo de la factura vive en SU moneda, y un pago en
   * otra se convierte a la tasa BCV del día del pago — nunca se resta sin convertir (100 Bs
   * «pagaban» una factura de USD 100: revisión fiscal de la migración 65). Dos formas de decirlo:
   *   · `currency` es la de la factura y la cuenta elegida vive en otra moneda: `gross_amount`
   *     es lo que se CANCELA, y de la cuenta sale su equivalente a la tasa del día
   *     («pagué la factura en dólares desde el banco en bolívares»);
   *   · `currency` es otra moneda: `gross_amount` es el DINERO que salió, y cancela su
   *     equivalente en la moneda de la factura.
   * La fila del pago va siempre en la moneda del dinero (la de la cuenta: LAD67); lo cancelado
   * va aparte, en `settled_amount`, en la moneda de la factura.
   */
  const monedaFactura = factura.transaction_currency;
  let monedaDinero = input.currency;
  if (input.account_id !== undefined && input.currency === monedaFactura) {
    const [c] = await sql<{ currency: string }[]>`
      select currency from public.company_accounts
       where id = ${input.account_id} and company_id = ${input.company_id}`;
    if (c) monedaDinero = c.currency;
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
  // La tasa del DINERO que sale, del día del pago; y, si el pago es cruzado, la de la moneda de
  // la factura ese mismo día.
  const tasa = await tasaA(
    sql,
    input.company_id,
    monedaDinero,
    ctx.value.functionalCurrency,
    fecha,
  );
  if (!tasa.ok) return tasa;
  const cruzado = monedaDinero !== monedaFactura;
  const tasaFacturaHoy = cruzado
    ? await tasaA(sql, input.company_id, monedaFactura, ctx.value.functionalCurrency, fecha)
    : tasa;
  if (!tasaFacturaHoy.ok) return tasaFacturaHoy;

  const declarado = Money.of(input.gross_amount, input.currency);
  if (!declarado.ok) return err({ code: "VALIDATION_FAILED", message: declarado.error.message });
  const tasaRegistro = parseDecimal(factura.fx_rate);
  if (!tasaRegistro.ok) {
    return err({ code: "VALIDATION_FAILED", message: tasaRegistro.error.message });
  }
  // El saldo en la moneda de la factura y lo que el MAYOR todavía le carga en cuentas por pagar
  // (si la factura o algo de lo que la salda está en la cola, lo mismo calculado desde las
  // filas). Con ellos van lo que la regla 4 necesita: líneas, pagos previos y lo que las notas
  // de crédito del proveedor bajaron a OTRA tasa que la de la factura.
  const [antes] = await sql<
    {
      s: string | null;
      mayor: string | null;
      calculado: string | null;
      lineas: number;
      pagos: number;
      notas: string;
    }[]
  >`
    select platform.supplier_invoice_balance(${input.company_id},
             ${input.supplier_invoice_id})::text as s,
           platform.settlement_ledger_open(
             ${input.company_id}, 'ap', ${input.supplier_invoice_id})::text as mayor,
           (select ${cuentaPorPagarCalculada(sql)}
              from public.supplier_invoices i
             where i.id = ${input.supplier_invoice_id})::text as calculado,
           (select count(*)::int from public.supplier_invoice_lines l
             where l.supplier_invoice_id = ${input.supplier_invoice_id}) as lineas,
           (select count(*)::int from public.supplier_payments p
             where p.supplier_invoice_id = ${input.supplier_invoice_id}) as pagos,
           (select coalesce(sum(n.total_amount * i.fx_rate - n.functional_amount), 0)
              from public.supplier_credit_notes n
              join public.supplier_invoices i on i.id = n.supplier_invoice_id
             where n.supplier_invoice_id = ${input.supplier_invoice_id}
               and n.status = 'posted')::text as notas`;
  const saldo = parseDecimal(antes?.s ?? "0");
  const quedaLeida = parseDecimal(antes?.mayor ?? antes?.calculado ?? "");
  const queda = quedaLeida.ok ? quedaLeida.value : null;
  /**
   * UN SOLO TOTAL (ADR-0063 §1; ADR-0075, nota «el cobro y el cierre», reglas 2 y 3). A LA TASA
   * DE LA FACTURA, lo que se debe en moneda funcional es lo que el mayor carga, y el pago
   * cruzado salda en PROPORCIÓN: pagar esa cifra cancela el saldo en divisa exacto, sin
   * diferencial. A otra tasa, la conversión del día.
   */
  const notasLeidas = parseDecimal(antes?.notas ?? "0");
  const notas = notasLeidas.ok ? notasLeidas.value : null;
  // La cota del redondeo (regla 4), a una tasa: por línea, media unidad mínima de la divisa ×
  // tasa + un céntimo (cubre el redondeo de `retention_total / fx_rate` al céntimo de la
  // divisa); más la media unidad del pago que cierra, y un céntimo por pago.
  const cota = (tasaMayor: Decimal): Decimal => {
    const media = unidadMinimaDe(monedaFactura).dividedBy(2).times(tasaMayor);
    const centimo = unidadMinimaDe(ctx.value.functionalCurrency);
    return media
      .plus(centimo)
      .times(Math.max(antes?.lineas ?? 1, 1))
      .plus(media)
      .plus(centimo.times((antes?.pagos ?? 0) + 1));
  };
  // Al mayor se le cree como «lo que se debe en Bs» solo si cuadra con el saldo en divisa a la
  // tasa de la factura dentro del redondeo; si no, se convierte a la tasa y el cierre falla.
  const proporcion =
    cruzado &&
    monedaDinero === ctx.value.functionalCurrency &&
    tasaFacturaHoy.value.rate.equals(tasaRegistro.value) &&
    saldo.ok &&
    saldo.value.greaterThan(0) &&
    queda !== null &&
    queda.greaterThan(0) &&
    notas !== null &&
    queda
      .minus(saldo.value.times(tasaRegistro.value).plus(notas))
      .abs()
      .lessThanOrEqualTo(cota(tasaRegistro.value))
      ? { saldo: saldo.value, queda }
      : null;
  // `bruto`: el dinero que sale, en su moneda. `saldado`: lo que cancela, en la de la factura.
  let saldado = declarado.value.amount;
  let brutoTexto = declarado.value.toAmountString();
  if (cruzado && input.currency === monedaFactura) {
    const escala = minorUnitsOf(monedaDinero);
    brutoTexto = (
      proporcion !== null
        ? proporcion.queda.times(declarado.value.amount).dividedBy(proporcion.saldo)
        : declarado.value.amount.times(tasaFacturaHoy.value.rate).dividedBy(tasa.value.rate)
    )
      .toDecimalPlaces(escala, 4)
      .toFixed(8);
  } else if (cruzado) {
    saldado = (
      proporcion !== null
        ? proporcion.saldo.times(declarado.value.amount).dividedBy(proporcion.queda)
        : declarado.value.amount.times(tasa.value.rate).dividedBy(tasaFacturaHoy.value.rate)
    ).toDecimalPlaces(8, 4);
  }
  const bruto = Money.of(brutoTexto, monedaDinero);
  if (!bruto.ok) return err({ code: "VALIDATION_FAILED", message: bruto.error.message });
  if (!bruto.value.amount.greaterThan(0) || !saldado.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El pago convertido a la tasa del día no llega a un céntimo.",
    });
  }
  /**
   * LA TOLERANCIA DE CAJA DEL PAGO CRUZADO (ADR-0063 §2; ADR-0075, nota «el pago cruzado a tasa
   * real»; D-02, H-09). Espejo del cobro de ventas. De una cuenta en dólares salen céntimos de
   * dólar: lo redondeado se aparta de lo debido hasta media unidad mínima de la moneda del
   * DINERO, valorada en la de la factura a la tasa del pago (4,27 Bs a 854,4637). Con medio
   * céntimo fijo de la moneda de la factura, una factura en Bs pagada desde una cuenta en USD no
   * cerraba a ninguna tasa real: los E2E usaban 40, donde todo cae exacto.
   */
  const toleranciaCaja = toleranciaDeCaja({
    monedaDinero,
    monedaDocumento: monedaFactura,
    tasaDinero: tasa.value.rate,
    tasaDocumento: tasaFacturaHoy.value.rate,
  });
  // El tope. En la moneda de la factura es exacto, como siempre. Cruzado y escrito en la moneda
  // del dinero, la conversión del dinero real no cae exacta: se tolera el redondeo de caja.
  const holgura = parseDecimal(
    cruzado && input.currency !== monedaFactura ? toleranciaCaja.toFixed() : "0",
  );
  // H-03 (ADR-0083 §5): una factura `posted` con saldo cero o a favor la cerró una nota de
  // crédito. Pagarla movería el auxiliar por debajo de lo que sus notas declararon a favor.
  if (saldo.ok && !saldo.value.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message: saldo.value.isZero()
        ? "Esta factura ya no debe nada: la cerró una nota de crédito del proveedor."
        : `Esta factura ya no debe nada: tiene ${saldo.value.negated().toFixed(2)} ${monedaFactura} a tu favor con el proveedor.`,
    });
  }
  if (saldo.ok && holgura.ok && saldado.minus(saldo.value).greaterThan(holgura.value)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El pago (${saldado.toDecimalPlaces(2, 4).toFixed(2)} ${monedaFactura}) supera el saldo pendiente de la factura (${saldo.value.toFixed()}).`,
    });
  }
  // El pago que CIERRA salda exactamente lo que faltaba (ADR-0075 §4): ni polvo de conversión
  // en el saldo, ni una factura «pagada» que debe 0,003.
  const cierra =
    saldo.ok && holgura.ok && saldo.value.minus(saldado).abs().lessThanOrEqualTo(holgura.value);
  if (cierra && saldo.ok) saldado = saldo.value;

  /**
   * LA RETENCIÓN YA ESTÁ PRACTICADA (ADR-0065 §3, migración 68). Se calculó y se asentó al
   * REGISTRAR la factura: registrarla como cuenta por pagar es el abono en cuenta, y la
   * PA SNAT/2025/000054 retiene «al pago o al abono en cuenta, lo que ocurra primero». Lo que
   * queda por pagarle al PROVEEDOR es el neto, que es justo lo que devuelve
   * `supplier_invoice_balance`. Aquí no se descuenta nada más: hacerlo se la cobraría dos
   * veces, una al fisco en el asiento de la factura y otra al proveedor en el pago.
   *
   * Lo que sí ocurre al pagar es que las retenciones pasan a `applied`. El comprobante de IVA
   * YA EXISTE: se emitió al registrar la factura (ADR-0072 §4, H-04; P-26 cerrada), también para
   * una factura a crédito pagada en partes. `issue_retention_receipt` sigue emitiendo el
   * comprobante viejo (`retention_receipts`), que hoy solo documenta el ISLR (contrato N-1).
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
  const cancelaTodo = cierra;
  // El pago no retiene nada: lo retenido se le acreditó al fisco al registrar la factura.
  const aRetener = totalRetenido.times(0);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  // P-03 (ADR-0075 §7): el equivalente funcional del pago va al céntimo, half-up — el mismo
  // importe sale de la caja, entra al mayor y baja la CxP. Antes 42.783,125.
  let funcional = aFuncionalAlCentimo(bruto.value, tasa.value.rate, ctx.value.functionalCurrency);
  if (!funcional.ok) return funcional;
  /**
   * LO FUNCIONAL DEL PAGO CRUZADO QUE CIERRA ES LO QUE SE SALDA (ADR-0063 §2, como el cobro que
   * cierra de ventas). La factura vive en la moneda funcional y el dinero sale en divisa,
   * redondeado a su unidad mínima: «lo que salió × tasa» se aparta de lo saldado hasta la
   * tolerancia de caja. Dentro de ella, el valor funcional del pago QUE CIERRA es lo saldado: la
   * cuenta baja por lo que salió EN SU MONEDA (el original, intacto), la cuenta por pagar por lo
   * que se debía, y no nace una línea de diferencial por el redondeo de caja del último pago — la
   * valoración de la caja en divisa la recoge la revaluación al cierre (P-100, VALIDAR-CONTABLE).
   *
   * SOLO EL QUE CIERRA, igual que ventas. Un ABONO que no cierra se asienta por lo que de verdad
   * salió («lo que salió × tasa»), y su diferencia con lo cancelado va al diferencial en el acto:
   * alinearlo dejaba hasta media unidad mínima × tasa (4,27 Bs a 854,4637) POR ABONO, sin límite
   * de abonos, fuera del mayor hasta el cierre.
   *
   * Fuera de la tolerancia no se toca nada y decide el tope de abajo. El descuadre entre el saldo
   * y el MAYOR no entra aquí: se compara contra lo saldado, no contra lo que el mayor carga, y la
   * regla 4 lo sigue rechazando.
   */
  if (cierra && cruzado && monedaFactura === ctx.value.functionalCurrency) {
    const saldadoFuncional = toCents(saldado);
    if (funcional.value.amount.minus(saldadoFuncional).abs().lessThanOrEqualTo(toleranciaCaja)) {
      const alineado = Money.of(saldadoFuncional.toFixed(2), ctx.value.functionalCurrency);
      if (!alineado.ok) return err({ code: "VALIDATION_FAILED", message: alineado.error.message });
      funcional = alineado;
    }
  }

  /**
   * LAS DOS MONEDAS, SIN MEZCLAR (hallado por e2e-cuenta-de-caja, 2026-09-15). El neto era
   * «bruto en la moneda del pago − retención en funcional», y el asiento recibía ese neto en
   * dólares contra un total en bolívares: todo pago a proveedor en divisa moría con 422
   * «asiento descuadrado». Desde la migración 68 el pago no resta retención ninguna —lo
   * retenido salió del saldo al registrar la factura—, así que las dos monedas ya no se
   * cruzan: lo que sale del banco es lo que se paga, y su conversión es una sola.
   */
  const neto = bruto.value.amount.minus(aRetener);
  const netoFuncional = funcional.value.amount.minus(aRetener);

  /**
   * EL DIFERENCIAL AL PAGAR (ADR-0075 §4; D-07, H-02). La cuenta por pagar se registró a la tasa
   * de la FACTURA; el dinero sale a la tasa de HOY. Antes el pago debitaba la CxP por lo que
   * salía, y la diferencia se quedaba para siempre en 2.1.01 con el saldo en divisa en cero.
   * Ahora la CxP se debita por lo que este pago cancela A LA TASA DE LA FACTURA, y la diferencia
   * con lo que salió es pérdida (positiva) o ganancia (negativa) en diferencial cambiario.
   * El pago que cierra cancela EXACTAMENTE lo que el mayor todavía le carga a la factura: el
   * céntimo de los redondeos va al diferencial, no se queda en la cartera.
   */
  let cancelado = toCents(saldado.times(tasaRegistro.value));
  if (cierra && queda !== null) {
    // Con cualquier signo: con la cuenta por pagar ya en cero o sobre-cargada, el último pago la
    // devuelve a cero igual (antes solo si era > 0, y quedaba negativa en una factura pagada).
    cancelado = toCents(queda);
    /**
     * EL TOPE DEL DIFERENCIAL (regla 4). Lo que el cierre lleva al diferencial —lo que salió −
     * lo que el mayor carga— tiene que parecerse al ESPERADO: lo saldado × (tasa de hoy − tasa
     * de la factura), menos lo que las notas de crédito del proveedor bajaron a otra tasa (se
     * valoran a la de su fecha: es diferencia cambiaria y se reconoce aquí). La cota es la del
     * redondeo (arriba). Fuera de ella NO se asienta.
     */
    const tasaHoy = tasaFacturaHoy.value.rate;
    const cambiario = saldado.times(tasaHoy.minus(tasaRegistro.value));
    const esperado = notas === null ? cambiario : cambiario.minus(notas);
    const real = netoFuncional.minus(cancelado);
    const tasaMayor = tasaHoy.greaterThan(tasaRegistro.value) ? tasaHoy : tasaRegistro.value;
    if (real.minus(esperado).abs().greaterThan(cota(tasaMayor))) {
      return err({
        code: "SETTLEMENT_MISMATCH",
        message:
          "Este pago no cuadra con lo que la factura todavía debe. No se registró: revisa la factura.",
      });
    }
  }
  const diferencial = netoFuncional.minus(cancelado);

  // La cuenta de la que SALE el efectivo (migración 29): la explícita si el
  // llamante la eligió, si no la forma de pago configurada → «Sin asignar».
  // Una nota de crédito no mueve efectivo y va sin cuenta (CHECK de la tabla).
  let cuentaId: string | null;
  if (input.account_id !== undefined) {
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
    if (cuenta.currency !== monedaDinero) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El pago es en ${monedaDinero} y la cuenta «${cuenta.name}» vive en ${cuenta.currency}.`,
      });
    }
    cuentaId = input.account_id;
  } else {
    cuentaId = await resolverCuentaEfectivo(
      sql,
      ctx.value.tenantId,
      input.company_id,
      input.instrument,
      monedaDinero,
    );
  }
  // El NETO es lo que sale de la cuenta: sin saldo, se confirma o no se registra
  // (ADR-0062 §4; QA de pantalla 2026-09-15, h. 77).
  if (cuentaId !== null) {
    // D-11: sobregirar exige el permiso, el motivo y deja acta (lo hace `exigeSaldo`).
    const alcanza = await exigeSaldo(sql, cuentaId, neto.toFixed(8), {
      permitir: input.allow_negative_balance,
      motivo: input.overdraft_reason,
      operacion: "supplier_payment",
    });
    if (!alcanza.ok) {
      if (ensayo === undefined || alcanza.error.code !== "INSUFFICIENT_FUNDS") {
        return err(alcanza.error);
      }
      ensayo.sinSaldo = alcanza.error.message;
    }
  }

  let pago: Record<string, unknown>;
  try {
    pago = await sql.savepoint(async (sp) => {
      const [p] = await sp<Record<string, unknown>[]>`
        insert into public.supplier_payments
          (tenant_id, company_id, supplier_id, supplier_invoice_id, bank_account_id, paid_at,
           instrument, reference, gross_amount, retained_amount, net_amount,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id, account_id,
           settled_amount, settled_currency, exchange_difference)
        values (${ctx.value.tenantId}, ${input.company_id}, ${factura.supplier_id},
                ${input.supplier_invoice_id}, ${input.bank_account_id ?? null}, ${fecha},
                ${input.instrument}, ${input.reference ?? null}, ${bruto.value.toAmountString()},
                ${aRetener.toFixed(8)}, ${neto.toFixed(8)}, ${bruto.value.toAmountString()},
                ${monedaDinero}, ${tasa.value.rate.toFixed()},
                ${funcional.value.toAmountString()}, ${ctx.value.functionalCurrency},
                ${tasa.value.source}, now(), ${POLICY.id}, ${cuentaId},
                ${saldado.toFixed(8)}, ${monedaFactura}, ${diferencial.toFixed(8)})
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
                    ${totalRetenido.toFixed(8)}, ${ctx.value.functionalCurrency})
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
      currency: monedaDinero,
      settled_amount: saldado.toFixed(8),
      settled_currency: monedaFactura,
      exchange_difference: diferencial.toFixed(8),
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
    // K-04: un pago fechado en un mes cerrado se asienta en el período en curso; el pago
    // conserva su fecha (paid_at).
    postingDate: await fechaContableDe(sql, input.company_id, diaNegocio(fecha)),
    postedBy: actor.userId,
    description: "Pago a proveedor",
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      // Lo que se CANCELA de la cuenta por pagar (a la tasa de la factura), lo que SALE de la
      // caja (a la de hoy) y su diferencia: el asiento cuadra por construcción.
      total: cancelado.toFixed(8),
      net_amount: netoFuncional.toFixed(8),
      exchange_difference: diferencial.toFixed(8),
      retained_iva: cancelaTodo ? (porTributo?.iva ?? "0") : "0",
      retained_islr: cancelaTodo ? (porTributo?.islr ?? "0") : "0",
      retained_total: aRetener.toFixed(8),
    },
    // AF-M03 (ADR-0075 §4): a la tasa con que se registró la factura no hay diferencial; lo que
    // el cierre deje es redondeo y va a «Diferencias por redondeo». `exchange_difference` de la
    // fila conserva el importe (es aritmética: lo que salió − lo cancelado).
    // Revisión final: SOLO si además cabe en la cota del redondeo. El pago que cierra reconoce
    // también lo que las notas de crédito del proveedor bajaron a OTRA tasa (`notas`, arriba): con
    // la tasa de hoy igual a la de la factura eso es NC × (R' − R), diferencial REAL, y va a
    // ganancia o pérdida cambiaria como siempre.
    ...(tasaFacturaHoy.value.rate.equals(tasaRegistro.value) &&
    diferencial.abs().lessThanOrEqualTo(cota(tasaRegistro.value))
      ? { differenceIsRounding: true }
      : {}),
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
async function lineasFacturaDeRecepcion(
  sql: TransactionSql,
  companyId: string,
  recepcionId: string,
  lineasOrden: readonly { id: string; product_id: string }[],
  lineas: readonly { product_id: string; quantity: string; unit_price: string }[],
): Promise<
  { product_id: string; quantity: string; unit_price: string; goods_receipt_line_id?: string }[]
> {
  const recibidas = await sql<{ id: string; purchase_order_line_id: string | null }[]>`
    select id, purchase_order_line_id from public.goods_receipt_lines
     where goods_receipt_id = ${recepcionId} and company_id = ${companyId}`;
  const porLineaOrden = new Map(recibidas.map((r) => [r.purchase_order_line_id, r.id]));
  return lineas.map((l, i) => {
    const lineaRecepcion = porLineaOrden.get(lineasOrden[i]?.id ?? null);
    return {
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: l.unit_price,
      ...(lineaRecepcion === undefined ? {} : { goods_receipt_line_id: lineaRecepcion }),
    };
  });
}

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
    // ADR-0072 §3 (H7): la exclusión marcada y el 100 % viajan igual que en la factura suelta.
    ...(input.retention_exclusion === undefined
      ? {}
      : { retention_exclusion: input.retention_exclusion }),
    ...(input.iva_retention_full_reason === undefined
      ? {}
      : { iva_retention_full_reason: input.iva_retention_full_reason }),
    // Cada línea de factura, atada a SU línea de recepción: es lo que deja correr la
    // revalorización contra lo recibido y el tope de facturación (QA 2026-09-15, h. 75/86).
    lines: await lineasFacturaDeRecepcion(
      sql,
      input.company_id,
      recibo.value.id,
      lineasOrden,
      input.lines,
    ),
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
      ...(input.payment.allow_negative_balance === undefined
        ? {}
        : { allow_negative_balance: input.payment.allow_negative_balance }),
      ...(input.payment.overdraft_reason === undefined
        ? {}
        : { overdraft_reason: input.payment.overdraft_reason }),
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

// ── La vista previa del pago (D-02) ──────────────────────────────────────────

/**
 * LA VISTA PREVIA DE UN PAGO A PROVEEDOR (D-02, ola 4). Corre `registerSupplierPayment` dentro de
 * un savepoint que SIEMPRE se deshace —el patrón de `previewArrival`—: las cifras que enseña la
 * pantalla son las que el registro escribiría, no las de una copia que pueda divergir. Lo que
 * falla al pagar falla aquí con el mismo código (sin tasa, sin saldo, por encima del saldo).
 */
export async function previewSupplierPayment(
  uow: UnitOfWork,
  input: RegisterSupplierPaymentRequest,
): Promise<Result<SupplierPaymentPreviewResponse, PurchaseError>> {
  const DESHACER = new Error("vista previa: se deshace siempre");
  let vista: Result<SupplierPaymentPreviewResponse, PurchaseError> | null = null;
  try {
    await uow.sql.savepoint(async (sp) => {
      // El sobregiro NO se confirma en la vista previa: se ensaya, y si la cuenta no alcanza
      // el resumen sale igual con su «no alcanza» (el permiso y el motivo son del registro).
      const ensayo = { sinSaldo: null as string | null };
      const r = await registerSupplierPayment(
        { ...uow, sql: sp },
        sinConfirmarSobregiro(input),
        "purchase.payment.register",
        ensayo,
      );
      if (!r.ok) {
        vista = r;
      } else {
        const p = await pagoEnsayado(sp, r.value.payment.id);
        vista = ok({ ...p, balance_after: r.value.balance, insufficient_funds: ensayo.sinSaldo });
      }
      throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
  }
  return vista ?? err({ code: "VALIDATION_FAILED", message: "No se pudo calcular el pago." });
}

/** El cuerpo de un pago, sin la confirmación del sobregiro: una vista previa no lo confirma. */
function sinConfirmarSobregiro(
  input: RegisterSupplierPaymentRequest,
): RegisterSupplierPaymentRequest {
  const copia: RegisterSupplierPaymentRequest = { ...input };
  delete copia.allow_negative_balance;
  delete copia.overdraft_reason;
  return copia;
}

/** Las cifras de un pago recién ensayado: lo que sale, lo que cancela y, si cruza, la tasa. */
async function pagoEnsayado(
  sp: TransactionSql,
  paymentId: string,
): Promise<{
  money_amount: string;
  money_currency: string;
  settled_amount: string;
  settled_currency: string;
  crossed: boolean;
  fx_rate: string | null;
  fx_rate_currency: string | null;
  fx_rate_date: string | null;
}> {
  const [p] = await sp<
    {
      money_amount: string;
      money_currency: string;
      settled_amount: string;
      settled_currency: string;
      crossed: boolean;
      divisa: string | null;
      fx_rate: string | null;
      fx_rate_date: string | null;
    }[]
  >`
    select sp.net_amount::text as money_amount, sp.transaction_currency as money_currency,
           coalesce(sp.settled_amount, sp.gross_amount)::numeric(24,8)::text as settled_amount,
           i.transaction_currency as settled_currency,
           sp.transaction_currency <> i.transaction_currency as crossed,
           x.divisa, f.rate::text as fx_rate, f.rate_date::text as fx_rate_date
      from public.supplier_payments sp
      join public.supplier_invoices i on i.id = sp.supplier_invoice_id
      cross join lateral (
        select case when i.transaction_currency <> i.functional_currency
                    then i.transaction_currency
                    when sp.transaction_currency <> i.functional_currency
                    then sp.transaction_currency end as divisa) x
      left join lateral platform.rate_for(
        sp.company_id, x.divisa, i.functional_currency,
        (sp.paid_at at time zone 'America/Caracas')::date) f on x.divisa is not null
     where sp.id = ${paymentId}`;
  return {
    money_amount: p!.money_amount,
    money_currency: p!.money_currency,
    settled_amount: p!.settled_amount,
    settled_currency: p!.settled_currency,
    crossed: p!.crossed,
    fx_rate: p!.fx_rate,
    fx_rate_currency: p!.divisa,
    fx_rate_date: p!.fx_rate_date,
  };
}

// ── El gasto con factura fiscal (H-09) ──────────────────────────────────────

/**
 * UN GASTO CON FACTURA FISCAL ES UNA COMPRA DE SERVICIO (H-09, recorrido 2026-09-24; RESPUESTA
 * §3 H-09; LIVA art. 33). `POST /v1/expenses` con el bloque `invoice` llega aquí, y aquí NO hay
 * regla fiscal: se compone de los dos casos de uso que ya la tienen, en la misma transacción.
 *
 *   1. `registerSupplierInvoice` registra la factura —libro de compras, crédito fiscal o costo
 *      según el tipo de la empresa, la retención del agente con sus exclusiones como DATA y su
 *      comprobante—, con líneas de servicio y el asiento a gasto;
 *   2. `registerSupplierPayment` paga el saldo entero desde la cuenta elegida: el mismo control
 *      de saldo y de sobregiro, el mismo diferencial, el mismo asiento.
 *
 * No se escribe una fila en `expenses`: el dinero saldría dos veces de la cuenta (el trigger de
 * `expenses` mueve el saldo) y el gasto estaría dos veces en el mayor. El gasto ES la factura,
 * marcada con `expense_category`, y el historial de gastos la lista junto a los gastos llanos.
 *
 * La empresa sin RIF no lleva libro: su tipo vigente es `no_contribuyente`, el IVA va al costo
 * y `purchases_book` no la lista. Lo decide `registerSupplierInvoice`, no este envoltorio.
 *
 * Si cualquiera de los dos pasos devuelve `err`, `withTransaction` revierte todo: no queda una
 * factura sin pagar por un saldo que no alcanzó.
 */
export async function registerInvoicedExpense(
  uow: UnitOfWork,
  input: RegisterExpenseRequest,
): Promise<Result<ExpenseResponse, PurchaseError>> {
  const { sql } = uow;
  const registrada = await facturaDelGasto(uow, input);
  if (!registrada.ok) return registrada;
  const { factura, cuenta, saldo } = registrada.value;
  if (saldo.positivo) {
    const pagado = await registerSupplierPayment(
      uow,
      {
        company_id: input.company_id,
        supplier_invoice_id: factura.id,
        gross_amount: saldo.importe,
        // En la moneda de la FACTURA: si la cuenta vive en otra, `gross_amount` es lo que se
        // cancela y de la cuenta sale su equivalente a la tasa BCV del día (ADR-0075 §3).
        currency: factura.transaction_currency,
        // Decidido por criterio: el gasto no pregunta el instrumento (pregunta la cuenta), y
        // «otro» es el único que no presume una moneda ni una forma de pago que nadie eligió.
        instrument: "otro",
        account_id: input.account_id,
        ...(input.paid_at === undefined ? {} : { paid_at: input.paid_at }),
        ...(input.allow_negative_balance === undefined
          ? {}
          : { allow_negative_balance: input.allow_negative_balance }),
        ...(input.overdraft_reason === undefined
          ? {}
          : { overdraft_reason: input.overdraft_reason }),
      },
      "expense.register",
    );
    if (!pagado.ok) return pagado;
  }

  const [g] = await sql<Record<string, unknown>[]>`
    select i.id, i.expense_category as category, i.notes as description,
           to_char(coalesce(p.paid_at, i.posted_at) at time zone 'utc',
                   'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
           ${input.account_id}::uuid as account_id,
           coalesce(p.net_amount, 0)::numeric(24,8)::text as amount,
           ${cuenta.currency}::text as currency,
           coalesce(p.functional_amount, 0)::numeric(24,8)::text as functional_amount,
           i.functional_currency,
           coalesce(p.fx_rate, i.fx_rate)::text as fx_rate,
           i.expense_is_recurring as is_recurring, i.supplier_id, null::uuid as branch_id,
           i.expense_attachment_path as attachment_path, i.journal_entry_id
      from public.supplier_invoices i
      -- El pago del gasto: el más reciente, la MISMA regla que el listado (GET /v1/expenses).
      left join lateral (
        select sp.paid_at, sp.net_amount, sp.functional_amount, sp.fx_rate
          from public.supplier_payments sp
         where sp.supplier_invoice_id = i.id
         order by sp.created_at desc, sp.id desc limit 1) p on true
     where i.id = ${factura.id} and i.company_id = ${input.company_id}`;
  return ok({
    ...(g as object),
    accounting: g!["journal_entry_id"] === null ? "queued" : "posted",
    supplier_invoice_id: factura.id,
    invoice: {
      document_number: factura.supplier_document_number,
      control_number: factura.supplier_control_number,
      invoice_date: factura.invoice_date,
      currency: factura.transaction_currency,
      subtotal_amount: factura.subtotal_amount,
      tax_amount: factura.tax_amount,
      total_amount: factura.total_amount,
      retention_total: factura.retention_total,
      retention_voucher_number: factura.retention_voucher_number,
      tax_is_recoverable: factura.tax_is_recoverable,
    },
  } as ExpenseResponse);
}

/**
 * LA VISTA PREVIA DEL GASTO CON FACTURA (`POST /v1/expenses/preview`). Toda acción irreversible
 * resume sus consecuencias antes de confirmar: registra la factura del gasto dentro de un
 * savepoint que SIEMPRE se deshace —el patrón de `previewArrival` y `previewSupplierPayment`— y
 * devuelve sus cifras. El pago no se ensaya: lo que saldría de la cuenta es el saldo de la
 * factura, y si la cuenta alcanza se pregunta al confirmar (ADR-0062 §4).
 */
export async function previewInvoicedExpense(
  uow: UnitOfWork,
  input: RegisterExpenseRequest,
): Promise<Result<ExpensePreviewResponse, PurchaseError>> {
  const DESHACER = new Error("vista previa: se deshace siempre");
  let vista: Result<ExpensePreviewResponse, PurchaseError> | null = null;
  try {
    await uow.sql.savepoint(async (sp) => {
      const r = await facturaDelGasto({ ...uow, sql: sp }, input);
      if (!r.ok) {
        vista = r;
      } else {
        const lineas = await sp<
          { tax_category_code: string; base: string; tax_rate: string; tax_amount: string }[]
        >`
          select tax_category_snapshot as tax_category_code,
                 line_subtotal_transaction::text as base,
                 tax_rate_snapshot::text as tax_rate, tax_amount::text as tax_amount
            from public.supplier_invoice_lines
           where supplier_invoice_id = ${r.value.factura.id}
           order by line_number`;
        // El pago, ensayado: cuánto sale de la cuenta EN SU MONEDA (si cruza, a la tasa del día)
        // y si alcanza. El sobregiro no se confirma aquí.
        const ensayo = { sinSaldo: null as string | null };
        let pago: Awaited<ReturnType<typeof pagoEnsayado>> | null = null;
        let fallo: PurchaseError | null = null;
        if (r.value.saldo.positivo) {
          const pagado = await registerSupplierPayment(
            { ...uow, sql: sp },
            {
              company_id: input.company_id,
              supplier_invoice_id: r.value.factura.id,
              gross_amount: r.value.saldo.importe,
              currency: r.value.factura.transaction_currency,
              instrument: "otro",
              account_id: input.account_id,
              ...(input.paid_at === undefined ? {} : { paid_at: input.paid_at }),
            },
            "expense.register",
            ensayo,
          );
          if (!pagado.ok) fallo = pagado.error;
          else pago = await pagoEnsayado(sp, pagado.value.payment.id);
        }
        vista =
          fallo !== null
            ? err(fallo)
            : ok({
                currency: r.value.factura.transaction_currency,
                lines: [...lineas],
                subtotal_amount: r.value.factura.subtotal_amount,
                tax_amount: r.value.factura.tax_amount,
                total_amount: r.value.factura.total_amount,
                retention_total: r.value.factura.retention_total,
                retention_currency: r.value.factura.functional_currency,
                tax_is_recoverable: r.value.factura.tax_is_recoverable,
                amount: pago?.money_amount ?? "0.00000000",
                account_currency: pago?.money_currency ?? r.value.cuenta.currency,
                fx_rate: pago?.crossed === true ? pago.fx_rate : null,
                fx_rate_currency: pago?.crossed === true ? pago.fx_rate_currency : null,
                fx_rate_date: pago?.crossed === true ? pago.fx_rate_date : null,
                insufficient_funds: ensayo.sinSaldo,
              });
      }
      throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
  }
  return vista ?? err({ code: "VALIDATION_FAILED", message: "No se pudo calcular el gasto." });
}

/**
 * La factura del gasto y su saldo: lo que comparten el registro y su vista previa. Valida el
 * cuerpo, registra la factura por `registerSupplierInvoice` y lee lo que se le debe al proveedor.
 */
async function facturaDelGasto(
  uow: UnitOfWork,
  input: RegisterExpenseRequest,
): Promise<
  Result<
    {
      factura: SupplierInvoiceResponse;
      cuenta: { currency: string; name: string };
      saldo: { importe: string; positivo: boolean };
    },
    PurchaseError
  >
> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar un gasto exige un usuario." });
  }
  // El permiso, ANTES de leer nada (familia «permiso anidado», A-07).
  const ctx = await autorizar(sql, actor.userId, input.company_id, "expense.register");
  if (!ctx.ok) return ctx;
  const inv = input.invoice;
  if (inv === undefined) {
    return err({ code: "VALIDATION_FAILED", message: "Falta la factura del gasto." });
  }
  if (input.amount !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Con factura fiscal no se escribe el importe: sale de las bases de la factura, su IVA y lo que se retiene. Quita el importe o registra el gasto sin factura.",
    });
  }
  if (input.supplier_id !== undefined && input.supplier_id !== inv.supplier_id) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El proveedor del gasto y el de su factura no coinciden.",
    });
  }
  if (input.branch_id !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Un gasto con factura fiscal todavía no se asigna a una sucursal: regístralo sin sucursal.",
    });
  }
  const [cuenta] = await sql<
    { currency: string; name: string; is_active: boolean; kind: string }[]
  >`
    select currency, name, is_active, kind from public.company_accounts
     where id = ${input.account_id} and company_id = ${input.company_id}`;
  if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!cuenta.is_active) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${cuenta.name}» está desactivada.`,
    });
  }

  const ajeno = comprobanteAjeno(input.company_id, input.attachment_path);
  if (ajeno !== null) return err(ajeno);

  // LA MONEDA DE LA FACTURA ES LA IMPRESA (ADR-0080; revisión de la ola 4): la dice quien
  // registra y, si calla, es la funcional. NO se hereda de la cuenta: una factura de luz en
  // bolívares pagada desde una cuenta en dólares entraba al libro como factura en dólares, y
  // el libro llevaba base × tasa en vez de lo impreso. El pago cruza por su cuenta.
  const monedaFactura = inv.currency ?? ctx.value.functionalCurrency;
  const factura = await registerSupplierInvoice(
    uow,
    {
      company_id: input.company_id,
      supplier_id: inv.supplier_id,
      supplier_document_number: inv.document_number,
      supplier_control_number: inv.control_number,
      invoice_date: inv.invoice_date,
      currency: monedaFactura,
      lines: [],
      ...(input.description === undefined ? {} : { notes: input.description }),
      ...(inv.retention_exclusion === undefined
        ? {}
        : { retention_exclusion: inv.retention_exclusion }),
      ...(inv.iva_retention_full_reason === undefined
        ? {}
        : { iva_retention_full_reason: inv.iva_retention_full_reason }),
    },
    {
      categoria: input.category,
      lineas: inv.lines,
      adjunto: input.attachment_path,
      recurrente: input.is_recurring,
      cuentaDePago: { kind: cuenta.kind, name: cuenta.name },
    },
  );
  if (!factura.ok) return factura;

  // EL SALDO: el total menos lo retenido, que es lo que se le debe al proveedor y lo que sale
  // de la cuenta. La cifra la da la misma función que usa toda la cartera, no una resta aquí.
  const [saldo] = await sql<{ s: string | null; positivo: boolean }[]>`
    select b.s::numeric(24,8)::text as s, coalesce(b.s, 0) > 0 as positivo
      from (select platform.supplier_invoice_balance(${input.company_id}, ${factura.value.id})
                     as s) b`;
  return ok({
    factura: factura.value,
    cuenta: { currency: cuenta.currency, name: cuenta.name },
    saldo: {
      importe: saldo?.s ?? "0.00000000",
      positivo: saldo?.positivo === true && saldo.s !== null,
    },
  });
}
