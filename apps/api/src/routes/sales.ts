import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CreateQuoteRequest,
  CreateOrderRequest,
  ConfirmOrderRequest,
  CreateInvoiceRequest,
  AnnulInvoiceRequest,
  RegisterPaymentRequest,
  CreateReturnRequest,
  CreateFiscalRangeRequest,
  CreateExchangeRateRequest,
} from "@ladino/schemas";
import {
  createQuote,
  createOrder,
  confirmOrder,
  createInvoice,
  annulInvoice,
  registerPayment,
  createReturn,
  confirmReturn,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const DOC_COLUMNS = `id, company_id, kind, series,
  document_number::int as document_number, control_number::int as control_number, status,
  to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
  to_char(annulled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as annulled_at,
  annul_reason, customer_id, vendor_id, price_list_id, source_document_id,
  transaction_currency, functional_currency, fx_rate::text as fx_rate, rate_source,
  subtotal_amount::text as subtotal_amount, tax_amount::text as tax_amount,
  total_amount::text as total_amount, regime_version_id, rules_version`;

function idValido(id: string): string {
  if (!UUID_RE.test(id))
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return id;
}

function coherente(companyIdHeader: string, companyIdBody: string): void {
  if (companyIdHeader !== companyIdBody) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

/**
 * Cuentas por cobrar: la RLS ya limita a las empresas del usuario, pero
 * «puede ver la empresa» no es «puede ver lo que se le debe a la empresa».
 * `ar.read` es un permiso propio y se comprueba aquí, en servidor.
 */
async function exigeArRead(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por cobrar exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'ar.read', ${companyId}) as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por cobrar exige el permiso ar.read.",
    });
  }
}

/**
 * Rutas de ventas. La capa es delgada por contrato (apps/api/CLAUDE.md): aquí no
 * se calcula ni un impuesto ni un saldo. Las consultas de solo lectura sí viven
 * aquí, pero **preguntándole al esquema** —`platform.document_balance`,
 * `platform.ar_aging`— nunca sumando en JavaScript. Un saldo calculado en dos
 * sitios se convierte en dos saldos.
 */
export function salesRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // ── Documentos ────────────────────────────────────────────────────────────

  app.get("/v1/documents", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const kind = c.req.query("kind") ?? "";
    const status = c.req.query("status") ?? "";
    const customerId = c.req.query("customer_id") ?? "";
    const desde = c.req.query("from") ?? "";
    const hasta = c.req.query("to") ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(DOC_COLUMNS)}, count(*) over ()::int as total
          from public.documents
         where company_id = ${companyId}
           ${kind === "" ? tx`` : tx`and kind = ${kind}`}
           ${status === "" ? tx`` : tx`and status = ${status}`}
           ${customerId === "" ? tx`` : tx`and customer_id = ${idValido(customerId)}`}
           ${desde === "" ? tx`` : tx`and coalesce(issued_at, created_at) >= ${desde}::date`}
           ${hasta === "" ? tx`` : tx`and coalesce(issued_at, created_at) < (${hasta}::date + 1)`}
         order by coalesce(issued_at, created_at) desc, document_number desc nulls last, id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.get("/v1/documents/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const detalle = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [documento] = await tx<Record<string, unknown>[]>`
        select ${tx.unsafe(DOC_COLUMNS)} from public.documents
         where id = ${id} and company_id = ${companyId}`;
      if (!documento) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select id, line_number, product_id, description, quantity::text as quantity,
               unit_price_transaction::text as unit_price_transaction,
               unit_price_functional::text as unit_price_functional,
               price_list_applied_id, tax_rule_id, tax_rate_snapshot::text as tax_rate_snapshot,
               tax_amount::text as tax_amount,
               line_subtotal_transaction::text as line_subtotal_transaction,
               line_total_transaction::text as line_total_transaction,
               transaction_currency, fx_rate::text as fx_rate,
               functional_amount::text as functional_amount, functional_currency, rate_source,
               cost_snapshot::text as cost_snapshot
          from public.document_lines where document_id = ${id} order by line_number`;
      const payments = await tx<Record<string, unknown>[]>`
        select id, document_id,
               to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
               currency, amount::text as amount, fx_rate::text as fx_rate, rate_source,
               functional_amount::text as functional_amount, instrument, reference,
               customer_credit_id
          from public.payments where document_id = ${id} order by paid_at, id`;
      const diferencias = await tx<Record<string, unknown>[]>`
        select id, document_id, payment_id, amount_transaction::text as amount_transaction,
               transaction_currency, functional_at_issue::text as functional_at_issue,
               functional_at_payment::text as functional_at_payment,
               difference::text as difference, fx_rate_issue::text as fx_rate_issue,
               fx_rate_payment::text as fx_rate_payment, occurred_on::text as occurred_on
          from public.exchange_gain_loss where document_id = ${id} order by occurred_on, id`;
      // El saldo lo dice el esquema, no esta capa.
      const [saldo] = await tx<{ balance: string }[]>`
        select platform.document_balance(${companyId}, ${id})::text as balance`;
      return {
        document: documento,
        lines,
        payments,
        exchange_differences: diferencias,
        balance: saldo?.balance ?? "0",
      };
    });
    if (detalle === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(detalle, 200);
  });

  app.post("/v1/quotes", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateQuoteRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createQuote(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/orders", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateOrderRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createOrder(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/orders/:id/confirm", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = ConfirmOrderRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => confirmOrder(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // La emisión: 201, con los dos números ya asignados (ADR-0037).
  app.post("/v1/invoices", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateInvoiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createInvoice(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // Anular NO es borrar: el correlativo se conserva (regla 1 y ADR-0037).
  app.post("/v1/invoices/:id/annul", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = AnnulInvoiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => annulInvoice(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Cobros ────────────────────────────────────────────────────────────────

  app.post("/v1/payments", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterPaymentRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => registerPayment(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Devoluciones ──────────────────────────────────────────────────────────

  app.post("/v1/returns", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateReturnRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createReturn(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/returns/:id/confirm", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => confirmReturn(uow, id, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Cuentas por cobrar ────────────────────────────────────────────────────

  app.get("/v1/customers/:id/aging", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const referencia = c.req.query("reference_date") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeArRead(tx, actor, companyId);
      const [ref] = await tx<{ d: string }[]>`
        select coalesce(${referencia}::date, current_date)::text as d`;
      const buckets = await tx<Record<string, unknown>[]>`
        select customer_id, bucket, document_count::int as document_count, amount::text as amount
          from platform.ar_aging(${companyId}, ${id}, ${ref!.d}::date)`;
      const [total] = await tx<{ t: string }[]>`
        select coalesce(sum(amount), 0)::text as t
          from platform.ar_aging(${companyId}, ${id}, ${ref!.d}::date)`;
      return { reference_date: ref!.d, buckets, total: total?.t ?? "0" };
    });
    return c.json(cuerpo, 200);
  });

  app.get("/v1/customers/:id/statement", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeArRead(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      if (!empresa) return null;
      const documentos = await tx<Record<string, unknown>[]>`
        select d.id, d.kind, d.series, d.document_number::int as document_number,
               to_char(d.issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
               d.status, d.total_amount::text as total_amount,
               coalesce((select sum(p.functional_amount) from public.payments p
                          where p.document_id = d.id), 0)::text as paid_amount,
               platform.document_balance(${companyId}, d.id)::text as balance,
               greatest(0, (current_date - d.issued_at::date))::int as days_outstanding
          from public.documents d
         where d.company_id = ${companyId} and d.customer_id = ${id}
           and d.status in ('issued', 'paid', 'annulled')
         order by d.issued_at, d.id`;
      const credits = await tx<Record<string, unknown>[]>`
        select id, source_document_id, amount::text as amount,
               applied_amount::text as applied_amount, status
          from public.customer_credits
         where company_id = ${companyId} and customer_id = ${id} order by created_at, id`;
      const [totales] = await tx<{ pendiente: string; credito: string }[]>`
        select coalesce((select sum(platform.document_balance(${companyId}, d.id))
                           from public.documents d
                          where d.company_id = ${companyId} and d.customer_id = ${id}
                            and d.kind = 'invoice' and d.status in ('issued', 'paid')), 0)::text
                 as pendiente,
               coalesce((select sum(cc.amount - cc.applied_amount)
                           from public.customer_credits cc
                          where cc.company_id = ${companyId} and cc.customer_id = ${id}
                            and cc.status = 'available'), 0)::text as credito`;
      const buckets = await tx<Record<string, unknown>[]>`
        select customer_id, bucket, document_count::int as document_count, amount::text as amount
          from platform.ar_aging(${companyId}, ${id}, current_date)`;
      const [ref] = await tx<{ d: string }[]>`select current_date::text as d`;
      const [totalAging] = await tx<{ t: string }[]>`
        select coalesce(sum(amount), 0)::text as t
          from platform.ar_aging(${companyId}, ${id}, current_date)`;
      return {
        customer_id: id,
        currency: empresa.moneda,
        documents: documentos,
        credits,
        total_outstanding: totales?.pendiente ?? "0",
        total_credit_available: totales?.credito ?? "0",
        aging: { reference_date: ref!.d, buckets, total: totalAging?.t ?? "0" },
      };
    });
    if (cuerpo === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(cuerpo, 200);
  });

  // ── Numeración fiscal y tasas ─────────────────────────────────────────────

  app.get("/v1/fiscal-number-ranges", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, kind, series, range_from::int as range_from, range_to::int as range_to,
               next_available::int as next_available, status, printer_source,
               (range_to - next_available + 1)::int as remaining
          from public.fiscal_number_ranges
         where company_id = ${companyId} order by kind, series, range_from`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/fiscal-number-ranges", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateFiscalRangeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const d = parsed.data;
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Cargar un rango autorizado exige un usuario real.",
      });
    }
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ ok: boolean }[]>`
        select platform.ladino_user_has_permission(${actor.userId}, 'fiscal.range.manage',
                                                   ${companyId}) as ok`;
      if (!permiso?.ok) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "Cargar un rango autorizado exige el permiso fiscal.range.manage.",
        });
      }
      const [tenant] = await tx<{ tenant_id: string }[]>`
        select tenant_id from public.companies where id = ${companyId}`;
      const [r] = await tx<Record<string, unknown>[]>`
        insert into public.fiscal_number_ranges
          (tenant_id, company_id, kind, series, range_from, range_to, next_available,
           printer_source, alert_threshold_pct)
        values (${tenant!.tenant_id}, ${companyId}, ${d.kind}, ${d.series}, ${d.range_from},
                ${d.range_to}, ${d.range_from}, ${d.printer_source},
                ${d.alert_threshold_pct ?? 10})
        returning id, kind, series, range_from::int as range_from, range_to::int as range_to,
                  next_available::int as next_available, status, printer_source,
                  (range_to - next_available + 1)::int as remaining`;
      return r!;
    });
    return c.json(fila, 201);
  });

  /** Rangos por agotarse: la alerta llega ANTES de que la caja se pare. */
  app.get("/v1/fiscal-number-ranges/exhaustion", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select range_id, kind, series, remaining::int as remaining, total::int as total,
               pct_remaining::text as pct_remaining
          from platform.range_exhaustion(${companyId})`,
    );
    return c.json(filas, 200);
  });

  app.get("/v1/exchange-rates", async (c) => {
    const { actor } = c.get("ladino.auth");
    const from = c.req.query("from") ?? "USD";
    const to = c.req.query("to") ?? "VES";
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, from_currency, to_currency, rate::text as rate, source,
               rate_date::text as rate_date
          from public.exchange_rates
         where from_currency = ${from} and to_currency = ${to}
         order by rate_date desc limit 60`,
    );
    return c.json(filas, 200);
  });

  /**
   * Carga MANUAL de tasa (ADR-0028). Es el camino que existe hoy porque el
   * adaptador BCV todavía no trae nada: `NullBCVAdapter`. Sin fuente no se
   * persiste, y la fuente queda visible en cada documento que la use.
   */
  app.post("/v1/exchange-rates", idempotencia, async (c) => {
    const parsed = CreateExchangeRateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const d = parsed.data;
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Cargar una tasa exige un usuario real.",
      });
    }
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ ok: boolean }[]>`
        select platform.ladino_user_has_permission(${actor.userId}, 'fx.rate.manage',
                                                   ${companyId}) as ok`;
      if (!permiso?.ok) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "Cargar una tasa exige el permiso fx.rate.manage.",
        });
      }
      // `rate_timestamp` es el instante en que se REGISTRA la tasa, distinto de
      // `rate_date`, que es el día para el que rige. Los dos, porque una tasa
      // cargada tarde sigue rigiendo su día y el desfase tiene que verse.
      const [r] = await tx<Record<string, unknown>[]>`
        insert into public.exchange_rates
          (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
        values (${d.from_currency}, ${d.to_currency}, ${d.rate}, ${d.source}, ${d.rate_date}::date,
                now())
        returning id, from_currency, to_currency, rate::text as rate, source,
                  rate_date::text as rate_date`;
      return r!;
    });
    return c.json(fila, 201);
  });

  /** KPI del panel: diferencial cambiario acumulado del período. */
  app.get("/v1/reports/exchange-difference", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = c.req.query("from") ?? null;
    const hasta = c.req.query("to") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // La moneda viaja con el KPI: un neto sin moneda es un número que el
      // cliente tiene que adivinar, y adivinar moneda es cómo se muestran
      // bolívares con símbolo de dólar.
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const [total] = await tx<{ ganancia: string; perdida: string; neto: string }[]>`
        select coalesce(sum(difference) filter (where difference > 0), 0)::text as ganancia,
               coalesce(sum(difference) filter (where difference < 0), 0)::text as perdida,
               coalesce(sum(difference), 0)::text as neto
          from public.exchange_gain_loss
         where company_id = ${companyId}
           and (${desde}::date is null or occurred_on >= ${desde}::date)
           and (${hasta}::date is null or occurred_on <= ${hasta}::date)`;
      const porMes = await tx<Record<string, unknown>[]>`
        select to_char(date_trunc('month', occurred_on), 'YYYY-MM') as month,
               sum(difference)::text as amount
          from public.exchange_gain_loss
         where company_id = ${companyId}
           and (${desde}::date is null or occurred_on >= ${desde}::date)
           and (${hasta}::date is null or occurred_on <= ${hasta}::date)
         group by 1 order by 1`;
      return { ...total!, currency: empresa?.moneda ?? "", by_month: porMes };
    });
    return c.json(cuerpo, 200);
  });
}
