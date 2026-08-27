import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal, type Decimal, type RoundingPolicy } from "@ladino/money";
import { listedPriceOf, resolvePrice } from "@ladino/pricing";
import {
  calculateLine,
  calculateTotals,
  exchangeDifference,
  type CalculatedLine,
} from "@ladino/sales";
import type {
  CreateQuoteRequest,
  CreateOrderRequest,
  ConfirmOrderRequest,
  CreateInvoiceRequest,
  AnnulInvoiceRequest,
  RegisterPaymentRequest,
  RegisterPaymentResponse,
  CreateReturnRequest,
  DocumentResponse,
  ReturnResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { issueStock, receiveStock } from "./inventory.js";

/**
 * Casos de uso de VENTAS — RIGOR MÁXIMO. Aquí convergen dinero, fiscal,
 * inventario y auditoría, y es la plantilla que copiarán compras, tesorería y
 * devoluciones.
 *
 * Lo que este módulo NO decide, y por eso no aparece escrito en ningún número:
 *   · la alícuota la resuelve `platform.resolve_tax()` (ADR-0038) y la línea la
 *     COPIA. Sin regla vigente, no hay emisión;
 *   · el correlativo y el número de control los asignan funciones del esquema
 *     (ADR-0037), atómicas, y el trigger vuelve a comprobarlas al emitir;
 *   · la tasa sale de `exchange_rates` con su fuente. Sin tasa, no hay emisión.
 *
 * El orden de la emisión importa y está elegido: se construye el documento en
 * `draft`, se calculan las líneas, y solo al final se pasa a `issued` — que es
 * cuando el trigger valida numeración y régimen. Emitir primero y calcular
 * después dejaría un documento fiscal a medio hacer si algo falla.
 */
export type SalesError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "FISCAL_NUMBERING_INVALID"; message: string }
  | { code: "TAX_RULE_MISSING"; message: string }
  | { code: "EXCHANGE_RATE_MISSING"; message: string }
  | { code: "NEGATIVE_STOCK"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string };

/** Política de redondeo del documento. Se persiste con cada línea (ADR-0024). */
const DOC_POLICY: RoundingPolicy = { id: "sales:document:8:HALF_UP", scale: 8, mode: "HALF_UP" };
const JURISDICTION = "VE";
const TAX_CODE = "iva";

const DOC_COLUMNS = `id, company_id, kind, series,
  document_number::int as document_number, control_number::int as control_number,
  status,
  to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
  to_char(annulled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as annulled_at,
  annul_reason, customer_id, vendor_id, price_list_id, source_document_id,
  transaction_currency, functional_currency, fx_rate::text as fx_rate, rate_source,
  subtotal_amount::text as subtotal_amount, tax_amount::text as tax_amount,
  total_amount::text as total_amount, regime_version_id, rules_version`;

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
  readonly regimeVersionId: string;
  readonly numberingMode: string;
}

function traducir(e: unknown): SalesError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD49") return { code: "FISCAL_NUMBERING_INVALID", message };
  if (code === "LAD50") {
    // El mensaje de la función se PROPAGA tal cual: dice qué jurisdicción, qué
    // fecha y qué categoría no tienen regla, y eso es lo que hace falta para
    // cargarla. Un «no se pudo resolver el impuesto» genérico no lo dice.
    return { code: "TAX_RULE_MISSING", message };
  }
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "LAD39") return { code: "NEGATIVE_STOCK", message };
  if (code === "23505") {
    return { code: "DUPLICATE", message: "Ya existe un documento con ese número en esa serie." };
  }
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  return null;
}

/** Autorización + el contexto fiscal de la empresa a la fecha del documento. */
async function autorizar(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
  fecha: string,
): Promise<Result<Contexto, SalesError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [cfg] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const [regimen] = await sql<{ regime_version_id: string; numbering_mode: string }[]>`
    select regime_version_id, numbering_mode from platform.regime_at(${companyId}, ${fecha})`;
  return ok({
    tenantId: scope.value.tenantId,
    functionalCurrency: cfg.moneda,
    regimeVersionId: regimen?.regime_version_id ?? "",
    numberingMode: regimen?.numbering_mode ?? "",
  });
}

interface LineaCalculada {
  readonly calc: CalculatedLine;
  readonly productId: string;
  readonly description: string;
  readonly priceListId: string;
  readonly unitPriceList: Money;
  readonly taxRuleId: string | null;
  readonly costSnapshot: string | null;
}

/**
 * A funcional: importe × tasa, redondeado a la escala del documento (8, HALF_UP).
 *
 * La conversión se hace UNA vez por importe y se persiste; no se recalcula al
 * leer. Un documento que se reinterpreta con la tasa de hoy cada vez que se
 * abre no es un documento, es una estimación.
 */
function aFuncional(m: Money, tasa: Decimal, funcional: string): Result<Money, SalesError> {
  const convertido = Money.of(m.multiply(tasa).amount.toDecimalPlaces(8, 4).toFixed(8), funcional);
  if (!convertido.ok) return err({ code: "VALIDATION_FAILED", message: convertido.error.message });
  return ok(convertido.value);
}

/**
 * Precia y calcula las líneas. Es lo que comparten cotización, pedido y factura,
 * y por eso vive en un sitio: tres copias divergirían en el tercer cambio de
 * regla, y la que divergiera sería la que factura.
 */
async function calcularLineas(
  sql: TransactionSql,
  input: {
    companyId: string;
    customerId: string;
    priceListId: string;
    warehouseId: string | null;
    lines: readonly { product_id: string; quantity: string; description?: string | undefined }[];
    fecha: string;
    functionalCurrency: string;
    conImpuesto: boolean;
  },
): Promise<
  Result<
    { lineas: LineaCalculada[]; fxRate: Decimal; rateSource: string; transactionCurrency: string },
    SalesError
  >
> {
  const [lista] = await sql<{ currency_code: string }[]>`
    select currency_code from public.price_lists
     where id = ${input.priceListId} and company_id = ${input.companyId} and status = 'active'`;
  if (!lista) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La lista de precios no existe en esta empresa o está inactiva.",
    });
  }

  // La tasa. Si la lista ya está en moneda funcional, la identidad; si no, la
  // vigente A LA FECHA del documento, con su fuente. Sin tasa NO se emite: no
  // se inventa una, ni se usa la de otro día.
  let fxRate = parseDecimal("1");
  let rateSource = "identidad";
  if (lista.currency_code !== input.functionalCurrency) {
    const [tasa] = await sql<{ rate: string | null; source: string | null }[]>`
      select r.rate::text as rate, r.source
        from public.exchange_rates r
       where r.from_currency = ${lista.currency_code}
         and r.to_currency = ${input.functionalCurrency}
         and r.rate_date <= ${input.fecha}::date
       order by r.rate_date desc, r.created_at desc limit 1`;
    if (!tasa?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa de ${lista.currency_code} a ${input.functionalCurrency} vigente para esa fecha. Cárgala con su fuente antes de emitir.`,
      });
    }
    fxRate = parseDecimal(tasa.rate);
    rateSource = tasa.source ?? "manual";
  }
  if (!fxRate.ok) return err({ code: "VALIDATION_FAILED", message: fxRate.error.message });
  const tasaDecimal = fxRate.value;

  const [contraparte] = await sql<{ taxpayer_type_code: string }[]>`
    select taxpayer_type_code from public.customers
     where id = ${input.customerId} and company_id = ${input.companyId}`;
  if (!contraparte) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  const salida: LineaCalculada[] = [];
  for (const l of input.lines) {
    const [producto] = await sql<
      { id: string; name: string; tax_category_code: string; kind: string; is_composed: boolean }[]
    >`select id, name, tax_category_code, kind, is_composed from public.products
       where id = ${l.product_id} and company_id = ${input.companyId} and status = 'active'`;
    if (!producto) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Un producto de la venta no existe en esta empresa o no está activo.",
      });
    }

    const [precio] = await sql<{ amount: string | null }[]>`
      select platform.price_at(${input.priceListId}, ${l.product_id}, ${input.fecha})::text as amount`;
    const listado = listedPriceOf(input.priceListId, precio?.amount ?? null, lista.currency_code);
    if (!listado.ok) return err({ code: "VALIDATION_FAILED", message: listado.error.message });

    const cantidad = parseDecimal(l.quantity);
    if (!cantidad.ok) return err({ code: "VALIDATION_FAILED", message: cantidad.error.message });

    // El documento se calcula EN LA MONEDA DE LA LISTA, no en la funcional. Es
    // la diferencia entre tener diferencial cambiario y no tenerlo: si la
    // factura naciera ya convertida a bolívares, la tasa quedaría cocida dentro
    // del total y el cobro posterior no tendría contra qué compararse. Por eso
    // la conversión va en los siete campos de ADR-0020, no en el importe.
    const identidad = parseDecimal("1");
    if (!identidad.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    const resuelto = resolvePrice({
      listed: listado.value,
      quantity: cantidad.value,
      documentCurrency: lista.currency_code,
      fxRate: identidad.value,
      roundingPolicy: DOC_POLICY,
    });
    if (!resuelto.ok) {
      return err({
        code: resuelto.error.code === "NO_PRICE_FOR_PRODUCT" ? "VALIDATION_FAILED" : "MONEY_ERROR",
        message: resuelto.error.message,
      } as SalesError);
    }

    // La alícuota: del catálogo, o no hay línea (ADR-0038). Una cotización no
    // paga impuesto pero SÍ lo muestra, así que también la resuelve.
    let taxRuleId: string | null = null;
    let taxRate = parseDecimal("0");
    if (input.conImpuesto) {
      try {
        // SAVEPOINT, y no es decorativo: `resolve_tax` LEVANTA una excepción
        // cuando no hay regla o el catálogo es ambiguo, y un error de Postgres
        // CONDENA la transacción. Sin savepoint, capturarlo aquí sería código
        // muerto que parece funcionar —la transacción rechaza igual con el
        // error crudo— y el 409 lo acabaría produciendo la tabla de SQLSTATE
        // con un mensaje genérico. Es la lección de S0.5, otra vez.
        const [regla] = await sql.savepoint(
          (sp) => sp<{ tax_rule_id: string; rate: string }[]>`
            select tax_rule_id, rate::text as rate
              from platform.resolve_tax(${input.fecha}::date, ${JURISDICTION}, ${TAX_CODE},
                                        ${contraparte.taxpayer_type_code},
                                        ${producto.tax_category_code})`,
        );
        taxRuleId = regla!.tax_rule_id;
        taxRate = parseDecimal(regla!.rate);
      } catch (e) {
        const conocido = traducir(e);
        if (conocido) return err(conocido);
        throw e;
      }
    }
    if (!taxRate.ok) return err({ code: "VALIDATION_FAILED", message: taxRate.error.message });

    const calc = calculateLine({
      quantity: cantidad.value,
      unitPrice: resuelto.value.unitPriceDocumentCurrency,
      taxRate: taxRate.value,
      basePolicy: DOC_POLICY,
      taxPolicy: DOC_POLICY,
    });
    if (!calc.ok) return err({ code: "VALIDATION_FAILED", message: calc.error.message });

    // Costo del kardex AL EMITIR, para margen. Snapshot: el costo de hoy no
    // reinterpreta el margen de una venta de hace tres meses.
    let costSnapshot: string | null = null;
    if (input.warehouseId !== null && producto.kind === "good" && !producto.is_composed) {
      const [saldo] = await sql<{ last_unit_cost: string }[]>`
        select last_unit_cost::text from public.stock_balances
         where company_id = ${input.companyId} and warehouse_id = ${input.warehouseId}
           and product_id = ${l.product_id} and lot_id is null`;
      costSnapshot = saldo?.last_unit_cost ?? null;
    }

    salida.push({
      calc: calc.value,
      productId: l.product_id,
      description: l.description ?? producto.name,
      priceListId: resuelto.value.priceListApplied,
      unitPriceList: resuelto.value.unitPriceListCurrency,
      taxRuleId,
      costSnapshot,
    });
  }
  return ok({
    lineas: salida,
    fxRate: tasaDecimal,
    rateSource,
    transactionCurrency: lista.currency_code,
  });
}

/** La lista que aplica: la del cuerpo si se mandó, si no la preferida del cliente. */
async function resolverLista(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  customerId: string,
  pedida: string | undefined,
): Promise<Result<string, SalesError>> {
  const [cliente] = await sql<{ default_price_list_id: string | null; status: string }[]>`
    select default_price_list_id, status from public.customers
     where id = ${customerId} and company_id = ${companyId}`;
  if (!cliente) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (cliente.status === "blocked") {
    return err({
      code: "VALIDATION_FAILED",
      message: "El cliente está bloqueado por cobranzas: no se le puede vender.",
    });
  }
  if (pedida === undefined) {
    if (cliente.default_price_list_id === null) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "El cliente no tiene lista de precios preferida y no se indicó ninguna: elige una explícitamente.",
      });
    }
    return ok(cliente.default_price_list_id);
  }
  // Cambiar la lista de una venta es una ATRIBUCIÓN, no una preferencia de
  // pantalla: exige permiso propio, y solo cuando de verdad cambia.
  if (pedida !== cliente.default_price_list_id) {
    const [permiso] = await sql<{ autorizado: boolean }[]>`
      select platform.ladino_user_has_permission(${userId}, 'sales.price_list.override', ${companyId})
             as autorizado`;
    if (!permiso?.autorizado) {
      return err({
        code: "PERMISSION_REQUIRED",
        message:
          "Cambiar la lista de precios de una venta exige el permiso sales.price_list.override.",
      });
    }
  }
  return ok(pedida);
}

async function insertarDocumento(
  sql: TransactionSql,
  ctx: Contexto,
  d: {
    companyId: string;
    kind: string;
    series: string;
    customerId: string;
    vendorId: string | null;
    branchId: string | null;
    priceListId: string;
    sourceDocumentId: string | null;
    lineas: LineaCalculada[];
    fxRate: Decimal;
    rateSource: string;
    transactionCurrency: string;
    notes: string | null;
  },
): Promise<Result<DocumentResponse, SalesError>> {
  const totales = calculateTotals(d.lineas.map((l) => l.calc));
  if (!totales.ok) return err({ code: "VALIDATION_FAILED", message: totales.error.message });

  /**
   * Los totales del PIE van en moneda funcional, porque es contra ellos que
   * `platform.document_balance` resta los cobros —también funcionales— y una
   * comparación entre monedas distintas es un saldo inventado. El total en
   * moneda de transacción vive en `amount_transaction_currency`, que es
   * exactamente para lo que ADR-0020 lo puso ahí.
   *
   * El impuesto funcional se DERIVA como total − subtotal en vez de convertirse
   * aparte: convertir los tres por separado produce redondeos que no cuadran, y
   * `documents_amounts_chk` exige que cuadren. Restar no puede desbalancear.
   */
  const funcionales = d.lineas.map((l) => ({
    sub: aFuncional(l.calc.subtotal, d.fxRate, ctx.functionalCurrency),
    tot: aFuncional(l.calc.total, d.fxRate, ctx.functionalCurrency),
  }));
  const fallo = funcionales.find((f) => !f.sub.ok || !f.tot.ok);
  if (fallo !== undefined) {
    if (!fallo.sub.ok) return fallo.sub;
    if (!fallo.tot.ok) return fallo.tot;
  }
  const cero = parseDecimal("0");
  if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
  let subFunc = cero.value;
  let totFunc = cero.value;
  for (const f of funcionales) {
    if (!f.sub.ok || !f.tot.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    subFunc = subFunc.plus(f.sub.value.amount);
    totFunc = totFunc.plus(f.tot.value.amount);
  }
  const taxFunc = totFunc.minus(subFunc);

  const [doc] = await sql<DocumentResponse[]>`
    insert into public.documents
      (tenant_id, company_id, branch_id, kind, series, customer_id, vendor_id, price_list_id,
       source_document_id, transaction_currency, functional_currency, fx_rate, rate_source,
       rate_timestamp, rounding_policy_id, amount_transaction_currency, functional_amount,
       subtotal_amount, tax_amount, total_amount, notes)
    values (${ctx.tenantId}, ${d.companyId}, ${d.branchId}, ${d.kind}, ${d.series},
            ${d.customerId}, ${d.vendorId}, ${d.priceListId === "" ? null : d.priceListId},
            ${d.sourceDocumentId},
            ${d.transactionCurrency}, ${ctx.functionalCurrency}, ${d.fxRate.toFixed()},
            ${d.rateSource}, now(),
            ${DOC_POLICY.id}, ${totales.value.total.toAmountString()}, ${totFunc.toFixed(8)},
            ${subFunc.toFixed(8)}, ${taxFunc.toFixed(8)}, ${totFunc.toFixed(8)}, ${d.notes})
    returning ${sql.unsafe(DOC_COLUMNS)}`;

  let n = 0;
  for (const l of d.lineas) {
    const f = funcionales[n]!;
    if (!f.sub.ok || !f.tot.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    const precioFunc = aFuncional(l.calc.unitPrice, d.fxRate, ctx.functionalCurrency);
    if (!precioFunc.ok) return precioFunc;
    n += 1;
    await sql`
      insert into public.document_lines
        (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
         unit_price_transaction, unit_price_functional, price_list_applied_id,
         tax_rule_id, tax_rate_snapshot, tax_amount,
         line_subtotal_transaction, line_subtotal_functional,
         line_total_transaction, line_total_functional,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, rounding_policy_id, cost_snapshot)
      values (${ctx.tenantId}, ${d.companyId}, ${doc!.id}, ${n}, ${l.productId}, ${l.description},
              ${l.calc.quantity.toFixed()},
              ${l.calc.unitPrice.toAmountString()}, ${precioFunc.value.toAmountString()},
              ${l.priceListId === "" ? null : l.priceListId},
              ${l.taxRuleId}, ${l.calc.taxRate.toFixed()},
              ${l.calc.taxAmount.toAmountString()},
              ${l.calc.subtotal.toAmountString()}, ${f.sub.value.toAmountString()},
              ${l.calc.total.toAmountString()}, ${f.tot.value.toAmountString()},
              ${l.calc.total.toAmountString()}, ${d.transactionCurrency},
              ${d.fxRate.toFixed()}, ${f.tot.value.toAmountString()},
              ${ctx.functionalCurrency}, ${d.rateSource}, now(), ${DOC_POLICY.id},
              ${l.costSnapshot})`;
  }
  return ok(doc!);
}

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  doc: DocumentResponse,
  evento: string,
  extra: Record<string, JSONValue> = {},
): Promise<void> {
  const payload: Record<string, JSONValue> = {
    kind: doc.kind,
    series: doc.series,
    document_number: doc.document_number,
    control_number: doc.control_number,
    customer_id: doc.customer_id,
    total_amount: doc.total_amount,
    functional_currency: doc.functional_currency,
    fx_rate: doc.fx_rate,
    rate_source: doc.rate_source,
    regime_version_id: doc.regime_version_id,
    ...extra,
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${doc.company_id}, 'document', ${doc.id}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${doc.company_id}, 'document', ${doc.id}, ${evento}, 1,
            ${sql.json({ document_id: doc.id, ...payload })})`;
}

function ahora(fecha: string | undefined): string {
  return fecha ?? new Date().toISOString();
}

// ── Cotización y pedido ────────────────────────────────────────────────────

async function crearBorrador(
  uow: UnitOfWork,
  input: CreateQuoteRequest | CreateOrderRequest,
  kind: "quote" | "order",
  permiso: string,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso, fecha);
  if (!ctx.ok) return ctx;

  const lista = await resolverLista(
    sql,
    actor.userId,
    input.company_id,
    input.customer_id,
    input.price_list_id,
  );
  if (!lista.ok) return lista;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const calculadas = await calcularLineas(sql, {
    companyId: input.company_id,
    customerId: input.customer_id,
    priceListId: lista.value,
    warehouseId: null,
    lines: input.lines,
    fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    conImpuesto: true,
  });
  if (!calculadas.ok) return calculadas;

  try {
    const doc = await sql.savepoint((sp) =>
      insertarDocumento(sp, ctx.value, {
        companyId: input.company_id,
        kind,
        series: input.series ?? "A",
        customerId: input.customer_id,
        vendorId: input.vendor_id ?? null,
        branchId: input.branch_id ?? null,
        priceListId: lista.value,
        sourceDocumentId: "source_document_id" in input ? (input.source_document_id ?? null) : null,
        lineas: calculadas.value.lineas,
        fxRate: calculadas.value.fxRate,
        rateSource: calculadas.value.rateSource,
        transactionCurrency: calculadas.value.transactionCurrency,
        notes: input.notes ?? null,
      }),
    );
    if (!doc.ok) return doc;
    await auditar(sql, ctx.value.tenantId, doc.value, `sales.${kind}.created`);
    return ok(doc.value);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

export const createQuote = (uow: UnitOfWork, input: CreateQuoteRequest) =>
  crearBorrador(uow, input, "quote", "sales.quote.manage");

export const createOrder = (uow: UnitOfWork, input: CreateOrderRequest) =>
  crearBorrador(uow, input, "order", "sales.order.manage");

/**
 * Confirma un pedido y RESERVA existencias. La reserva no es un movimiento de
 * kardex (ADR-0034 §Alcance y la decisión del encargo): es un compromiso, y el
 * kardex sigue diciendo «lo que hay». Caduca según `reservation_ttl_days`.
 */
export async function confirmOrder(
  uow: UnitOfWork,
  documentId: string,
  input: ConfirmOrderRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Confirmar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.order.manage", fecha);
  if (!ctx.ok) return ctx;

  const [doc] = await sql<{ id: string; status: string; kind: string }[]>`
    select id, status, kind from public.documents
     where id = ${documentId} and company_id = ${input.company_id}`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.kind !== "order") {
    return err({ code: "VALIDATION_FAILED", message: "Solo un pedido se confirma." });
  }
  if (doc.status !== "draft") {
    return err({
      code: "VALIDATION_FAILED",
      message: `El pedido está en estado ${doc.status}: solo se confirma un borrador.`,
    });
  }

  const [cfg] = await sql<{ ttl: number }[]>`
    select coalesce(s.reservation_ttl_days, 30) as ttl
      from public.companies c
      left join public.inventory_settings s on s.company_id = c.id
     where c.id = ${input.company_id}`;
  const ttl = cfg?.ttl ?? 30;

  const lineas = await sql<{ product_id: string; quantity: string }[]>`
    select product_id, quantity::text as quantity from public.document_lines
     where document_id = ${documentId} order by line_number`;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  for (const l of lineas) {
    // El disponible descuenta lo YA reservado por otros pedidos: reservar dos
    // veces la misma unidad es exactamente lo que esta tabla evita.
    const [disp] = await sql<{ available: string }[]>`
      select available::text from platform.available_stock(
        ${input.company_id}, ${input.warehouse_id}, ${l.product_id}, null)`;
    const disponible = parseDecimal(disp?.available ?? "0");
    const pedida = parseDecimal(l.quantity);
    if (!disponible.ok || !pedida.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad no interpretable." });
    }
    if (pedida.value.greaterThan(disponible.value)) {
      return err({
        code: "NEGATIVE_STOCK",
        message: `No hay disponible suficiente para reservar: quedan ${disponible.value.toFixed()} y el pedido exige ${pedida.value.toFixed()}.`,
      });
    }
    await sql`
      insert into public.stock_reservations
        (tenant_id, company_id, document_id, warehouse_id, product_id, quantity, expires_at)
      values (${ctx.value.tenantId}, ${input.company_id}, ${documentId}, ${input.warehouse_id},
              ${l.product_id}, ${l.quantity}, now() + (${ttl} || ' days')::interval)`;
  }

  const [actualizado] = await sql<DocumentResponse[]>`
    update public.documents set status = 'confirmed'
     where id = ${documentId} and company_id = ${input.company_id}
    returning ${sql.unsafe(DOC_COLUMNS)}`;
  await auditar(sql, ctx.value.tenantId, actualizado!, "sales.order.confirmed", {
    warehouse_id: input.warehouse_id,
    reservation_ttl_days: ttl,
  });
  return ok(actualizado!);
}

/**
 * EMITE una factura. Es el caso de uso más cargado del sistema y el orden está
 * elegido: primero se calcula todo en `draft`, y solo al final se pasa a
 * `issued` — que es cuando el trigger valida numeración y régimen. Al revés
 * quedaría un documento fiscal a medio hacer si algo falla después.
 */
export async function createInvoice(
  uow: UnitOfWork,
  input: CreateInvoiceRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Emitir exige un usuario real." });
  }
  const fecha = ahora(input.issued_at);
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.issue", fecha);
  if (!ctx.ok) return ctx;
  if (ctx.value.regimeVersionId === "") {
    return err({
      code: "FISCAL_NUMBERING_INVALID",
      message:
        "La empresa no tiene régimen fiscal vigente a esa fecha: asígnalo antes de emitir (ADR-0029).",
    });
  }

  const lista = await resolverLista(
    sql,
    actor.userId,
    input.company_id,
    input.customer_id,
    input.price_list_id,
  );
  if (!lista.ok) return lista;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const calculadas = await calcularLineas(sql, {
    companyId: input.company_id,
    customerId: input.customer_id,
    priceListId: lista.value,
    warehouseId: input.warehouse_id,
    lines: input.lines,
    fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    conImpuesto: true,
  });
  if (!calculadas.ok) return calculadas;

  const serie = input.series ?? "A";
  try {
    const doc = await sql.savepoint(async (sp) => {
      const creado = await insertarDocumento(sp, ctx.value, {
        companyId: input.company_id,
        kind: "invoice",
        series: serie,
        customerId: input.customer_id,
        vendorId: input.vendor_id ?? null,
        branchId: input.branch_id ?? null,
        priceListId: lista.value,
        sourceDocumentId: input.source_document_id ?? null,
        lineas: calculadas.value.lineas,
        fxRate: calculadas.value.fxRate,
        rateSource: calculadas.value.rateSource,
        transactionCurrency: calculadas.value.transactionCurrency,
        notes: input.notes ?? null,
      });
      if (!creado.ok) return creado;

      // Los DOS números, cada uno por su función atómica (ADR-0037). El de
      // control solo cuando el régimen lo usa: pedirlo cuando no toca sería
      // consumir un número autorizado para nada.
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_document_number(${input.company_id}, 'invoice', ${serie})::text as n`;
      let control: string | null = null;
      if (ctx.value.numberingMode === "range") {
        const [c] = await sp<{ n: string }[]>`
          select platform.claim_control_number(${input.company_id}, 'invoice', ${serie})::text as n`;
        control = c!.n;
      }

      const [emitido] = await sp<DocumentResponse[]>`
        update public.documents
           set status = 'issued', issued_at = ${fecha},
               document_number = ${num!.n}::bigint,
               control_number = ${control}::bigint,
               regime_version_id = ${ctx.value.regimeVersionId},
               rules_version = ${RULES_VERSION}
         where id = ${creado.value.id}
        returning ${sp.unsafe(DOC_COLUMNS)}`;
      return ok(emitido!);
    });
    if (!doc.ok) return doc;

    // El kardex, DESPUÉS de emitir y en la misma transacción: si el stock no
    // alcanza, la factura entera no ocurrió. Cada salida lleva el documento como
    // origen, así que el kardex y la factura se pueden cruzar.
    for (const l of calculadas.value.lineas) {
      const [p] = await sql<{ kind: string; is_composed: boolean }[]>`
        select kind, is_composed from public.products where id = ${l.productId}`;
      if (p?.kind !== "good" || p.is_composed) continue;
      const mov = await issueStock(uow, {
        company_id: input.company_id,
        warehouse_id: input.warehouse_id,
        product_id: l.productId,
        quantity: l.calc.quantity.toFixed(),
        sourceDocumentId: doc.value.id,
      });
      if (!mov.ok) {
        return err(
          mov.error.code === "NEGATIVE_STOCK"
            ? { code: "NEGATIVE_STOCK", message: mov.error.message }
            : { code: "VALIDATION_FAILED", message: mov.error.message },
        );
      }
    }

    await auditar(sql, ctx.value.tenantId, doc.value, "fiscal.invoice.issued", {
      warehouse_id: input.warehouse_id,
      line_count: calculadas.value.lineas.length,
    });
    return ok(doc.value);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/** Anula una factura emitida. El correlativo SE CONSERVA (ADR-0037). */
export async function annulInvoice(
  uow: UnitOfWork,
  documentId: string,
  input: AnnulInvoiceRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Anular exige un usuario real." });
  }
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    "sales.invoice.annul",
    new Date().toISOString(),
  );
  if (!ctx.ok) return ctx;

  const [doc] = await sql<{ status: string }[]>`
    select status from public.documents where id = ${documentId} and company_id = ${input.company_id}`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.status !== "issued") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se anula una factura emitida; esta está en ${doc.status}.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const [anulada] = await sql<DocumentResponse[]>`
      update public.documents
         set status = 'annulled', annulled_at = now(), annul_reason = ${input.reason}
       where id = ${documentId} and company_id = ${input.company_id}
      returning ${sql.unsafe(DOC_COLUMNS)}`;
    await auditar(sql, ctx.value.tenantId, anulada!, "fiscal.invoice.annulled", {
      reason: input.reason,
    });
    return ok(anulada!);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * Registra un cobro y, si la tasa del día difiere de la de emisión, el
 * DIFERENCIAL CAMBIARIO. No es «cobró de más»: el cliente entregó lo pactado en
 * su moneda, y lo que cambió es cuántos bolívares vale eso.
 */
export async function registerPayment(
  uow: UnitOfWork,
  input: RegisterPaymentRequest,
): Promise<Result<RegisterPaymentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cobrar exige un usuario real." });
  }
  const fecha = ahora(input.paid_at);
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.payment.register", fecha);
  if (!ctx.ok) return ctx;

  const [doc] = await sql<
    {
      id: string;
      status: string;
      total_amount: string;
      transaction_currency: string;
      fx_rate: string;
      functional_currency: string;
      customer_id: string;
    }[]
  >`select id, status, total_amount::text as total_amount, transaction_currency,
           fx_rate::text as fx_rate, functional_currency, customer_id
      from public.documents where id = ${input.document_id} and company_id = ${input.company_id}`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.status !== "issued") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se cobra una factura emitida; esta está en ${doc.status}.`,
    });
  }

  // La tasa del DÍA DEL COBRO. Si el cobro es en moneda funcional, la identidad.
  let tasaCobro = "1";
  let fuenteCobro = "identidad";
  if (input.currency !== ctx.value.functionalCurrency) {
    const [t] = await sql<{ rate: string | null; source: string | null }[]>`
      select r.rate::text as rate, r.source from public.exchange_rates r
       where r.from_currency = ${input.currency} and r.to_currency = ${ctx.value.functionalCurrency}
         and r.rate_date <= ${fecha}::date
       order by r.rate_date desc, r.created_at desc limit 1`;
    if (!t?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa de ${input.currency} a ${ctx.value.functionalCurrency} para la fecha del cobro.`,
      });
    }
    tasaCobro = t.rate;
    fuenteCobro = t.source ?? "manual";
  }
  const tasaCobroDec = parseDecimal(tasaCobro);
  const importe = Money.of(input.amount, input.currency);
  if (!tasaCobroDec.ok || !importe.ok) {
    return err({ code: "VALIDATION_FAILED", message: "Importe o tasa no interpretables." });
  }
  const funcionalCobro = importe.value.multiply(tasaCobroDec.value);
  const funcionalRedondeado = Money.of(
    funcionalCobro.amount.toDecimalPlaces(8, 4).toFixed(8),
    ctx.value.functionalCurrency,
  );
  if (!funcionalRedondeado.ok) {
    return err({ code: "VALIDATION_FAILED", message: funcionalRedondeado.error.message });
  }

  // El saldo se CALCULA, nunca se lee de una columna.
  const [saldoAntes] = await sql<{ saldo: string }[]>`
    select platform.document_balance(${input.company_id}, ${input.document_id})::text as saldo`;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  if (input.instrument === "saldo_a_favor") {
    if (input.customer_credit_id === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Pagar con saldo a favor exige indicar cuál.",
      });
    }
    const [credito] = await sql<
      { amount: string; applied_amount: string; status: string; currency: string }[]
    >`select amount::text as amount, applied_amount::text as applied_amount, status, currency
        from public.customer_credits
       where id = ${input.customer_credit_id} and company_id = ${input.company_id}
         and customer_id = ${doc.customer_id} for update`;
    if (!credito) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    // Un saldo a favor se aplica EN SU MONEDA. Comparar 100 USD contra un
    // crédito de 100 Bs porque los dos «son 100» es exactamente el error que
    // esta comprobación existe para impedir.
    if (credito.currency !== input.currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El saldo a favor está en ${credito.currency} y el cobro se registró en ${input.currency}.`,
      });
    }
    const disponible = parseDecimal(credito.amount);
    const aplicado = parseDecimal(credito.applied_amount);
    const pedido = parseDecimal(input.amount);
    if (!disponible.ok || !aplicado.ok || !pedido.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    const resto = disponible.value.minus(aplicado.value);
    if (pedido.value.greaterThan(resto)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El saldo a favor disponible es ${resto.toFixed()} y se intentó aplicar ${pedido.value.toFixed()}.`,
      });
    }
    const nuevo = aplicado.value.plus(pedido.value);
    await sql`
      update public.customer_credits
         set applied_amount = ${nuevo.toFixed()},
             status = case when ${nuevo.equals(disponible.value)} then 'applied' else status end
       where id = ${input.customer_credit_id}`;
  }

  let pago;
  try {
    pago = await sql.savepoint(async (sp) => {
      const [p] = await sp<Record<string, unknown>[]>`
        insert into public.payments
          (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
           rate_timestamp, functional_amount, instrument, reference, customer_credit_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id}, ${fecha},
                ${input.currency}, ${input.amount}, ${tasaCobro}, ${fuenteCobro}, now(),
                ${funcionalRedondeado.value.toAmountString()}, ${input.instrument},
                ${input.reference ?? null}, ${input.customer_credit_id ?? null})
        returning id, document_id,
                  to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
                  currency, amount::text as amount, fx_rate::text as fx_rate, rate_source,
                  functional_amount::text as functional_amount, instrument, reference,
                  customer_credit_id`;
      return p!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  // El DIFERENCIAL, solo si el documento se emitió en otra moneda y la tasa
  // cambió. Si no hay diferencia, no se escribe una fila de cero: un hecho que
  // no ocurrió no se registra.
  let diferencial: Record<string, unknown> | null = null;
  if (
    doc.transaction_currency === input.currency &&
    doc.transaction_currency !== doc.functional_currency
  ) {
    const tasaEmision = parseDecimal(doc.fx_rate);
    if (tasaEmision.ok) {
      const dif = exchangeDifference({
        amountTransaction: importe.value,
        functionalCurrency: ctx.value.functionalCurrency,
        rateAtIssue: tasaEmision.value,
        rateAtPayment: tasaCobroDec.value,
        policy: DOC_POLICY,
      });
      if (!dif.ok) return err({ code: "VALIDATION_FAILED", message: dif.error.message });
      if (!dif.value.difference.isZero()) {
        const [eg] = await sql<Record<string, unknown>[]>`
          insert into public.exchange_gain_loss
            (tenant_id, company_id, document_id, payment_id, amount_transaction,
             transaction_currency, functional_at_issue, functional_at_payment, difference,
             fx_rate_issue, fx_rate_payment, occurred_on)
          values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id},
                  ${pago["id"] as string}, ${importe.value.toAmountString()}, ${input.currency},
                  ${dif.value.functionalAtIssue.toAmountString()},
                  ${dif.value.functionalAtPayment.toAmountString()},
                  ${dif.value.difference.toAmountString()},
                  ${tasaEmision.value.toFixed()}, ${tasaCobroDec.value.toFixed()}, ${fecha}::date)
          returning id, document_id, payment_id, amount_transaction::text as amount_transaction,
                    transaction_currency, functional_at_issue::text as functional_at_issue,
                    functional_at_payment::text as functional_at_payment,
                    difference::text as difference, fx_rate_issue::text as fx_rate_issue,
                    fx_rate_payment::text as fx_rate_payment, occurred_on::text as occurred_on`;
        diferencial = eg!;
      }
    }
  }

  const [saldoDespues] = await sql<{ saldo: string }[]>`
    select platform.document_balance(${input.company_id}, ${input.document_id})::text as saldo`;
  const saldo = parseDecimal(saldoDespues?.saldo ?? "0");
  let estado = doc.status;
  if (saldo.ok && (saldo.value.isZero() || saldo.value.isNegative())) {
    await sql`update public.documents set status = 'paid' where id = ${input.document_id}`;
    estado = "paid";
  }

  const [docActual] = await sql<DocumentResponse[]>`
    select ${sql.unsafe(DOC_COLUMNS)} from public.documents where id = ${input.document_id}`;
  await auditar(sql, ctx.value.tenantId, docActual!, "ar.payment_applied", {
    payment_id: pago["id"] as string,
    amount: input.amount,
    currency: input.currency,
    instrument: input.instrument,
    balance_before: saldoAntes?.saldo ?? null,
    balance_after: saldoDespues?.saldo ?? null,
    exchange_difference: diferencial === null ? null : (diferencial["difference"] as string),
  });

  return ok({
    payment: pago as never,
    exchange_difference: diferencial as never,
    balance: saldoDespues?.saldo ?? "0",
    document_status: estado as never,
  });
}

/**
 * Devolución referida a su documento origen. Al confirmarla: reingreso al
 * inventario **al costo ORIGINAL** —el `cost_snapshot` de la línea de origen, no
 * el costo de hoy— y nota de crédito con saldo a favor.
 */
export async function createReturn(
  uow: UnitOfWork,
  input: CreateReturnRequest,
): Promise<Result<ReturnResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Devolver exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.return.manage", fecha);
  if (!ctx.ok) return ctx;

  const [origen] = await sql<
    {
      id: string;
      status: string;
      kind: string;
      customer_id: string;
      price_list_id: string | null;
    }[]
  >`select id, status, kind, customer_id, price_list_id from public.documents
     where id = ${input.source_document_id} and company_id = ${input.company_id}`;
  if (!origen) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (origen.kind !== "invoice" || !["issued", "paid"].includes(origen.status)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo se devuelve contra una factura emitida.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  const [dev] = await sql<{ id: string }[]>`
    insert into public.returns
      (tenant_id, company_id, source_document_id, warehouse_id, reason)
    values (${ctx.value.tenantId}, ${input.company_id}, ${input.source_document_id},
            ${input.warehouse_id}, ${input.reason})
    returning id`;

  const lineas: ReturnResponse["lines"] = [];
  for (const l of input.lines) {
    const [origenLinea] = await sql<
      {
        id: string;
        product_id: string;
        quantity: string;
        cost_snapshot: string | null;
        unit_price_transaction: string;
      }[]
    >`select id, product_id, quantity::text as quantity, cost_snapshot::text as cost_snapshot,
             unit_price_transaction::text as unit_price_transaction
        from public.document_lines
       where id = ${l.source_line_id} and document_id = ${input.source_document_id}`;
    if (!origenLinea) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Una línea devuelta no pertenece al documento origen.",
      });
    }
    const pedida = parseDecimal(l.quantity);
    const vendida = parseDecimal(origenLinea.quantity);
    if (!pedida.ok || !vendida.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad no interpretable." });
    }
    if (pedida.value.greaterThan(vendida.value)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `No se puede devolver más de lo vendido: la línea tiene ${vendida.value.toFixed()}.`,
      });
    }
    // EL COSTO ORIGINAL, copiado. Si la línea no lo tenía (servicio, o venta sin
    // almacén), se devuelve a cero y se dice: inventar uno sería peor.
    const costo = origenLinea.cost_snapshot ?? "0";
    await sql`
      insert into public.return_lines
        (tenant_id, company_id, return_id, source_line_id, product_id, quantity,
         unit_cost_original, unit_price_transaction)
      values (${ctx.value.tenantId}, ${input.company_id}, ${dev!.id}, ${l.source_line_id},
              ${origenLinea.product_id}, ${l.quantity}, ${costo},
              ${origenLinea.unit_price_transaction})`;
    lineas.push({
      source_line_id: l.source_line_id,
      product_id: origenLinea.product_id,
      quantity: l.quantity,
      unit_cost_original: costo,
      unit_price_transaction: origenLinea.unit_price_transaction,
    });
  }

  return ok({
    id: dev!.id,
    source_document_id: input.source_document_id,
    credit_note_id: null,
    status: "draft",
    reason: input.reason,
    warehouse_id: input.warehouse_id,
    lines: lineas,
    customer_credit_id: null,
  });
}

/**
 * Confirma la devolución: reingresa al COSTO ORIGINAL, emite la nota de crédito
 * y crea el saldo a favor. Los tres en la misma transacción — una devolución a
 * medias dejaría mercancía en el almacén sin nota de crédito, o al revés.
 */
export async function confirmReturn(
  uow: UnitOfWork,
  returnId: string,
  companyId: string,
): Promise<Result<ReturnResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Confirmar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, companyId, "sales.return.manage", fecha);
  if (!ctx.ok) return ctx;

  const [dev] = await sql<
    {
      id: string;
      status: string;
      source_document_id: string;
      warehouse_id: string;
      reason: string;
    }[]
  >`select id, status, source_document_id, warehouse_id, reason from public.returns
     where id = ${returnId} and company_id = ${companyId}`;
  if (!dev) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (dev.status !== "draft") {
    return err({ code: "VALIDATION_FAILED", message: "La devolución ya no está en borrador." });
  }

  const [origen] = await sql<{ customer_id: string; price_list_id: string | null }[]>`
    select customer_id, price_list_id from public.documents where id = ${dev.source_document_id}`;
  const lineas = await sql<
    {
      product_id: string;
      quantity: string;
      unit_cost_original: string;
      unit_price_transaction: string;
    }[]
  >`select product_id, quantity::text as quantity,
           unit_cost_original::text as unit_cost_original,
           unit_price_transaction::text as unit_price_transaction
      from public.return_lines where return_id = ${returnId}`;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // 1. Reingreso al COSTO ORIGINAL. `receiveStock` recibe el costo TOTAL, así
  //    que se multiplica cantidad × costo unitario original — nunca el vigente.
  for (const l of lineas) {
    const [p] = await sql<{ kind: string; is_composed: boolean }[]>`
      select kind, is_composed from public.products where id = ${l.product_id}`;
    if (p?.kind !== "good" || p.is_composed) continue;
    const cantidad = parseDecimal(l.quantity);
    const costoUnit = parseDecimal(l.unit_cost_original);
    if (!cantidad.ok || !costoUnit.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    const total = cantidad.value.times(costoUnit.value).toDecimalPlaces(8, 4);
    const mov = await receiveStock(uow, {
      company_id: companyId,
      warehouse_id: dev.warehouse_id,
      product_id: l.product_id,
      quantity: l.quantity,
      amount: total.toFixed(8),
      currency: ctx.value.functionalCurrency,
      sourceDocumentId: returnId,
    });
    if (!mov.ok) return err({ code: "VALIDATION_FAILED", message: mov.error.message });
  }

  // 2. La nota de crédito, emitida como cualquier documento fiscal — y por eso
  //    exige SU PROPIO rango autorizado: una NC no se numera con los números de
  //    control de las facturas. Va en savepoint porque la numeración levanta
  //    excepciones de Postgres, y sin él la transacción quedaría condenada y el
  //    409 lo produciría la tabla de SQLSTATE con un mensaje genérico.
  let nc: Result<DocumentResponse, SalesError>;
  try {
    nc = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx.value, {
        companyId,
        customerId: origen!.customer_id,
        priceListId: origen!.price_list_id,
        sourceDocumentId: dev.source_document_id,
        lineas,
        fecha,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nc.ok) return nc;

  // 3. El saldo a favor.
  const [credito] = await sql<{ id: string }[]>`
    insert into public.customer_credits
      (tenant_id, company_id, customer_id, source_document_id, amount, currency)
    values (${ctx.value.tenantId}, ${companyId}, ${origen!.customer_id}, ${nc.value.id},
            ${nc.value.total_amount}, ${ctx.value.functionalCurrency})
    returning id`;

  await sql`
    update public.returns set status = 'confirmed', confirmed_at = now(), credit_note_id = ${nc.value.id}
     where id = ${returnId}`;
  await auditar(sql, ctx.value.tenantId, nc.value, "fiscal.credit_note.issued", {
    return_id: returnId,
    customer_credit_id: credito!.id,
  });

  return ok({
    id: returnId,
    source_document_id: dev.source_document_id,
    credit_note_id: nc.value.id,
    status: "confirmed",
    reason: dev.reason,
    warehouse_id: dev.warehouse_id,
    lines: lineas.map((l) => ({
      source_line_id: "",
      product_id: l.product_id,
      quantity: l.quantity,
      unit_cost_original: l.unit_cost_original,
      unit_price_transaction: l.unit_price_transaction,
    })),
    customer_credit_id: credito!.id,
  });
}

/** La nota de crédito: mismo camino fiscal que una factura, otro `kind`. */
async function createInvoiceLike(
  uow: UnitOfWork,
  ctx: Contexto,
  d: {
    companyId: string;
    customerId: string;
    priceListId: string | null;
    sourceDocumentId: string;
    lineas: readonly { product_id: string; quantity: string; unit_price_transaction: string }[];
    fecha: string;
  },
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql } = uow;
  if (ctx.regimeVersionId === "") {
    return err({
      code: "FISCAL_NUMBERING_INVALID",
      message: "La empresa no tiene régimen fiscal vigente: no puede emitir la nota de crédito.",
    });
  }
  // La NC hereda la MONEDA Y LA TASA del documento origen, no las de hoy. Si
  // tomara la tasa de hoy, el crédito no cancelaría la deuda que dice cancelar:
  // quedaría un resto en bolívares que nadie debe y que nadie cobra.
  const [origen] = await sql<
    { transaction_currency: string; fx_rate: string; rate_source: string }[]
  >`
    select transaction_currency, fx_rate::text as fx_rate, rate_source
      from public.documents where id = ${d.sourceDocumentId}`;
  if (!origen) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const tasaOrigen = parseDecimal(origen.fx_rate);
  if (!tasaOrigen.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La tasa del documento origen no es legible.",
    });
  }

  const calculadas: LineaCalculada[] = [];
  for (const l of d.lineas) {
    const cantidad = parseDecimal(l.quantity);
    const precio = Money.of(l.unit_price_transaction, origen.transaction_currency);
    if (!cantidad.ok || !precio.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    // La NC hereda el precio del documento origen; el impuesto se recalcula con
    // la regla vigente a SU fecha, que es lo correcto: es un documento nuevo.
    const [producto] = await sql<{ name: string; tax_category_code: string }[]>`
      select name, tax_category_code from public.products where id = ${l.product_id}`;
    const [cliente] = await sql<{ taxpayer_type_code: string }[]>`
      select taxpayer_type_code from public.customers where id = ${d.customerId}`;
    let taxRuleId: string | null = null;
    let tasa = parseDecimal("0");
    try {
      const [regla] = await sql<{ tax_rule_id: string; rate: string }[]>`
        select tax_rule_id, rate::text as rate
          from platform.resolve_tax(${d.fecha}::date, ${JURISDICTION}, ${TAX_CODE},
                                    ${cliente!.taxpayer_type_code}, ${producto!.tax_category_code})`;
      taxRuleId = regla!.tax_rule_id;
      tasa = parseDecimal(regla!.rate);
    } catch (e) {
      const conocido = traducir(e);
      if (conocido) return err(conocido);
      throw e;
    }
    if (!tasa.ok) return err({ code: "VALIDATION_FAILED", message: tasa.error.message });
    const calc = calculateLine({
      quantity: cantidad.value,
      unitPrice: precio.value,
      taxRate: tasa.value,
      basePolicy: DOC_POLICY,
      taxPolicy: DOC_POLICY,
    });
    if (!calc.ok) return err({ code: "VALIDATION_FAILED", message: calc.error.message });
    calculadas.push({
      calc: calc.value,
      productId: l.product_id,
      description: producto!.name,
      priceListId: d.priceListId ?? "",
      unitPriceList: precio.value,
      taxRuleId,
      costSnapshot: null,
    });
  }

  const creado = await insertarDocumento(sql, ctx, {
    companyId: d.companyId,
    kind: "credit_note",
    series: "A",
    customerId: d.customerId,
    vendorId: null,
    branchId: null,
    priceListId: d.priceListId ?? "",
    sourceDocumentId: d.sourceDocumentId,
    lineas: calculadas,
    fxRate: tasaOrigen.value,
    rateSource: origen.rate_source,
    transactionCurrency: origen.transaction_currency,
    notes: null,
  });
  if (!creado.ok) return creado;

  const [num] = await sql<{ n: string }[]>`
    select platform.claim_document_number(${d.companyId}, 'credit_note', 'A')::text as n`;
  let control: string | null = null;
  if (ctx.numberingMode === "range") {
    const [c] = await sql<{ n: string }[]>`
      select platform.claim_control_number(${d.companyId}, 'credit_note', 'A')::text as n`;
    control = c!.n;
  }
  const [emitida] = await sql<DocumentResponse[]>`
    update public.documents
       set status = 'issued', issued_at = ${d.fecha}, document_number = ${num!.n}::bigint,
           control_number = ${control}::bigint, regime_version_id = ${ctx.regimeVersionId},
           rules_version = ${RULES_VERSION}
     where id = ${creado.value.id}
    returning ${sql.unsafe(DOC_COLUMNS)}`;
  return ok(emitida!);
}
