import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CreateSupplierRequest,
  CreatePurchaseOrderRequest,
  ReceiveGoodsRequest,
  RegisterSupplierInvoiceRequest,
  ApplyLandedCostRequest,
  RegisterSupplierCreditNoteRequest,
  RegisterSupplierPaymentRequest,
  SimplePurchaseRequest,
  CreateRetentionRuleRequest,
} from "@ladino/schemas";
import {
  createSupplier,
  createPurchaseOrder,
  receiveGoods,
  registerSupplierInvoice,
  applyLandedCost,
  registerSupplierCreditNote,
  registerSupplierPayment,
  simplePurchase,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Cuentas por pagar: ver lo que se le debe a un proveedor es un permiso propio,
 * no una consecuencia de ver la empresa. Simétrico a `ar.read` en ventas.
 */
async function exigeApRead(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por pagar exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'ap.read', ${companyId}) as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar cuentas por pagar exige el permiso ap.read.",
    });
  }
}

/**
 * Rutas de compras. La capa es delgada: aquí no se calcula ni un prorrateo ni
 * una retención. Las lecturas preguntan al ESQUEMA —`purchase_matching`,
 * `supplier_invoice_balance`, `ap_aging`— y no suman en JavaScript.
 */
export function purchasesRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // ── Proveedores ───────────────────────────────────────────────────────────

  app.get("/v1/suppliers", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const search = c.req.query("search")?.trim() ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      const filtro =
        search === ""
          ? tx``
          : tx`and (coalesce(tax_id, '') ilike ${`%${search}%`} or legal_name ilike ${`%${search}%`})`;
      return tx<Record<string, unknown>[]>`
        select id, company_id, tax_id, legal_name, trade_name, supplier_kind, person_type_code,
               taxpayer_type_code, fiscal_address, email, phone, status,
               payment_terms_days::int as payment_terms_days, count(*) over ()::int as total
          from public.suppliers
         where company_id = ${companyId} ${filtro}
         order by legal_name, id limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.post("/v1/suppliers", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateSupplierRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createSupplier(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Órdenes de compra ─────────────────────────────────────────────────────

  app.get("/v1/purchase-orders", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const status = c.req.query("status") ?? "";
    const supplierId = c.req.query("supplier_id") ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      return tx<Record<string, unknown>[]>`
        select o.id, o.company_id, o.supplier_id, o.warehouse_id,
               o.order_number::int as order_number, o.status,
               to_char(o.ordered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ordered_at,
               o.expected_at::text as expected_at, o.transaction_currency, o.functional_currency,
               o.fx_rate::text as fx_rate, o.rate_source,
               o.amount_transaction_currency::text as amount_transaction_currency,
               o.functional_amount::text as functional_amount,
               -- El estado DERIVADO de las recepciones, no la columna: una orden
               -- cerrada a mano y tres recepciones parciales son dos verdades.
               case when o.status in ('draft', 'closed', 'cancelled') then o.status
                    else platform.purchase_order_status(o.company_id, o.id) end as derived_status,
               count(*) over ()::int as total
          from public.purchase_orders o
         where o.company_id = ${companyId}
           ${status === "" ? tx`` : tx`and o.status = ${status}`}
           ${supplierId === "" ? tx`` : tx`and o.supplier_id = ${idValido(supplierId)}`}
         order by o.ordered_at desc nulls last, o.order_number desc nulls last, o.id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.get("/v1/purchase-orders/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const detalle = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [orden] = await tx<Record<string, unknown>[]>`
        select id, company_id, supplier_id, warehouse_id, order_number::int as order_number,
               status,
               to_char(ordered_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ordered_at,
               expected_at::text as expected_at, transaction_currency, functional_currency,
               fx_rate::text as fx_rate, rate_source,
               amount_transaction_currency::text as amount_transaction_currency,
               functional_amount::text as functional_amount
          from public.purchase_orders where id = ${id} and company_id = ${companyId}`;
      if (!orden) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select id, line_number, product_id, description, quantity::text as quantity,
               unit_price_transaction::text as unit_price_transaction,
               line_total_transaction::text as line_total_transaction,
               unit_weight::text as unit_weight
          from public.purchase_order_lines where purchase_order_id = ${id} order by line_number`;
      const progress = await tx<Record<string, unknown>[]>`
        select order_line_id, product_id, quantity_ordered::text as quantity_ordered,
               quantity_received::text as quantity_received,
               quantity_pending::text as quantity_pending
          from platform.purchase_order_progress(${companyId}, ${id})`;
      const receipts = await tx<Record<string, unknown>[]>`
        select id, receipt_number::int as receipt_number, status,
               to_char(received_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at,
               functional_amount::text as functional_amount
          from public.goods_receipts where purchase_order_id = ${id} order by receipt_number`;
      const invoices = await tx<Record<string, unknown>[]>`
        select id, supplier_document_number, invoice_date::text as invoice_date, status,
               total_amount::text as total_amount
          from public.supplier_invoices where purchase_order_id = ${id} order by invoice_date`;
      const [derivado] = await tx<{ s: string }[]>`
        select platform.purchase_order_status(${companyId}, ${id}) as s`;
      return {
        order: orden,
        lines,
        progress,
        receipts,
        invoices,
        derived_status: derivado?.s ?? "pending",
      };
    });
    if (detalle === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(detalle, 200);
  });

  app.post("/v1/purchase-orders", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreatePurchaseOrderRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createPurchaseOrder(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Recepciones ───────────────────────────────────────────────────────────

  app.post("/v1/goods-receipts", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ReceiveGoodsRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => receiveGoods(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/goods-receipts/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const detalle = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [r] = await tx<Record<string, unknown>[]>`
        select id, company_id, supplier_id, purchase_order_id, warehouse_id,
               receipt_number::int as receipt_number, status,
               to_char(received_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as received_at,
               delivery_note_ref, transaction_currency, functional_currency,
               fx_rate::text as fx_rate, rate_source,
               functional_amount::text as functional_amount
          from public.goods_receipts where id = ${id} and company_id = ${companyId}`;
      if (!r) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select id, line_number, product_id, quantity::text as quantity,
               unit_price_transaction::text as unit_price_transaction,
               unit_cost_functional::text as unit_cost_functional,
               platform.line_landed_cost(company_id, id)::text as landed_cost_functional,
               unit_weight::text as unit_weight
          from public.goods_receipt_lines where goods_receipt_id = ${id} order by line_number`;
      const landed = await tx<Record<string, unknown>[]>`
        select id, concept, allocation_method, status,
               functional_amount::text as functional_amount, incurred_on::text as incurred_on
          from public.landed_costs where goods_receipt_id = ${id} order by incurred_on, id`;
      return { receipt: r, lines, landed_costs: landed };
    });
    if (detalle === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(detalle, 200);
  });

  // ── Facturas del proveedor ────────────────────────────────────────────────

  app.get("/v1/supplier-invoices", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const status = c.req.query("status") ?? "";
    const supplierId = c.req.query("supplier_id") ?? "";
    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      return tx<Record<string, unknown>[]>`
        select i.id, i.company_id, i.supplier_id, i.purchase_order_id,
               i.supplier_document_number, i.supplier_control_number, i.supplier_document_ref,
               i.invoice_date::text as invoice_date, i.due_date::text as due_date, i.status,
               i.subtotal_amount::text as subtotal_amount, i.tax_amount::text as tax_amount,
               i.total_amount::text as total_amount, i.tax_is_recoverable,
               i.retention_total::text as retention_total, i.transaction_currency,
               i.functional_currency, i.fx_rate::text as fx_rate, i.rate_source,
               platform.supplier_invoice_balance(i.company_id, i.id)::text as balance,
               count(*) over ()::int as total
          from public.supplier_invoices i
         where i.company_id = ${companyId}
           ${status === "" ? tx`` : tx`and i.status = ${status}`}
           ${supplierId === "" ? tx`` : tx`and i.supplier_id = ${idValido(supplierId)}`}
         order by i.invoice_date desc, i.id limit 100`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.post("/v1/supplier-invoices", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterSupplierInvoiceRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => registerSupplierInvoice(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /** El matching de tres vías, tal como lo ve el esquema. Informa, no decide. */
  app.get("/v1/purchases/matching", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const invoiceId = idValido(c.req.query("supplier_invoice_id") ?? "");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [cfg] = await tx<{ tol: string }[]>`
        select coalesce(s.price_tolerance_pct, 5)::numeric(24,8)::text as tol
          from public.companies c
          left join public.purchase_settings s on s.company_id = c.id
         where c.id = ${companyId}`;
      const rows = await tx<Record<string, unknown>[]>`
        select invoice_line_id, product_id, qty_ordered::text as qty_ordered,
               qty_received::text as qty_received, qty_invoiced::text as qty_invoiced,
               price_ordered::text as price_ordered, price_invoiced::text as price_invoiced,
               price_diff_pct::text as price_diff_pct
          from platform.purchase_matching(${companyId}, ${invoiceId})`;
      return {
        supplier_invoice_id: invoiceId,
        price_tolerance_pct: cfg?.tol ?? "5",
        rows,
      };
    });
    return c.json(cuerpo, 200);
  });

  // ── Landed cost ───────────────────────────────────────────────────────────

  app.post("/v1/landed-costs", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ApplyLandedCostRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => applyLandedCost(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /** Las variaciones del período: lo que el landed cost tardío NO capitalizó. */
  app.get("/v1/landed-costs/variances", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = c.req.query("from") ?? null;
    const hasta = c.req.query("to") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const items = await tx<Record<string, unknown>[]>`
        select v.id, v.product_id, v.amount_functional::text as amount_functional,
               v.account_code, v.occurred_on::text as occurred_on, v.reason,
               l.concept, l.allocation_method
          from public.landed_cost_variances v
          join public.landed_costs l on l.id = v.landed_cost_id
         where v.company_id = ${companyId}
           and (${desde}::date is null or v.occurred_on >= ${desde}::date)
           and (${hasta}::date is null or v.occurred_on <= ${hasta}::date)
         order by v.occurred_on desc, v.id`;
      const [total] = await tx<{ t: string }[]>`
        select coalesce(sum(amount_functional), 0)::text as t
          from public.landed_cost_variances
         where company_id = ${companyId}
           and (${desde}::date is null or occurred_on >= ${desde}::date)
           and (${hasta}::date is null or occurred_on <= ${hasta}::date)`;
      return { items, total: total?.t ?? "0", currency: empresa?.moneda ?? "" };
    });
    return c.json(cuerpo, 200);
  });

  // ── Notas de crédito recibidas y pagos ────────────────────────────────────

  app.post("/v1/supplier-credit-notes", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterSupplierCreditNoteRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      registerSupplierCreditNote(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/supplier-payments", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterSupplierPaymentRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => registerSupplierPayment(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /** La COMPRA SIMPLE de la Fase C: orden + recepción + factura (+ pago) en un paso. */
  app.post("/v1/purchases/simple", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SimplePurchaseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => simplePurchase(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/retention-receipts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, supplier_id, supplier_invoice_id, series,
               receipt_number::int as receipt_number, control_number::int as control_number,
               status,
               to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
               fiscal_period, total_retained::text as total_retained, functional_currency
          from public.retention_receipts where company_id = ${companyId}
         order by series, receipt_number desc nulls last limit 200`,
    );
    return c.json(filas, 200);
  });

  // ── Reglas de retención: el catálogo que nace vacío ───────────────────────

  app.get("/v1/retention-concepts", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select code, retention_code, name, description from public.retention_concepts
         where status = 'active' order by retention_code, code`,
    );
    return c.json(filas, 200);
  });

  app.get("/v1/retention-rules", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, jurisdiction, retention_code, concept_code, taxpayer_type,
               supplier_person_type, formula_kind, rate::text as rate,
               subtrahend::text as subtrahend, minimum_exempt::text as minimum_exempt,
               effective_from::text as effective_from, effective_to::text as effective_to,
               legal_source, priority, status
          from public.retention_rules order by retention_code, concept_code, effective_from desc`,
    );
    return c.json(filas, 200);
  });

  /**
   * Cargar una regla de retención. Es el acto por el que una empresa PUEDE
   * retener: el catálogo nace vacío a propósito (ADR-0039) y esto es lo que lo
   * llena, con la norma citada, que es obligatoria.
   */
  app.post("/v1/retention-rules", idempotencia, async (c) => {
    const parsed = CreateRetentionRuleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const d = parsed.data;
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Cargar una regla de retención exige un usuario real.",
      });
    }
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ ok: boolean }[]>`
        select platform.ladino_user_has_permission(${actor.userId}, 'retention.rules.manage',
                                                   ${companyId}) as ok`;
      if (!permiso?.ok) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "Cargar una regla de retención exige el permiso retention.rules.manage.",
        });
      }
      const [r] = await tx<Record<string, unknown>[]>`
        insert into public.retention_rules
          (jurisdiction, retention_code, concept_code, taxpayer_type, supplier_person_type,
           formula_kind, rate, subtrahend, minimum_exempt, effective_from, effective_to,
           legal_source, priority)
        values (${d.jurisdiction}, ${d.retention_code}, ${d.concept_code},
                ${d.taxpayer_type ?? null}, ${d.supplier_person_type ?? null}, ${d.formula_kind},
                ${d.rate}, ${d.subtrahend ?? null}, ${d.minimum_exempt ?? null},
                ${d.effective_from}::date, ${d.effective_to ?? null}, ${d.legal_source},
                ${d.priority ?? 100})
        returning id, jurisdiction, retention_code, concept_code, formula_kind, rate::text as rate,
                  subtrahend::text as subtrahend, minimum_exempt::text as minimum_exempt,
                  effective_from::text as effective_from, legal_source, priority, status`;
      return r!;
    });
    return c.json(fila, 201);
  });

  // ── Cuentas por pagar ─────────────────────────────────────────────────────

  app.get("/v1/suppliers/:id/aging", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const referencia = c.req.query("reference_date") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeApRead(tx, actor, companyId);
      const [ref] = await tx<{ d: string }[]>`
        select coalesce(${referencia}::date, current_date)::text as d`;
      const buckets = await tx<Record<string, unknown>[]>`
        select supplier_id, bucket, document_count::int as document_count, amount::text as amount
          from platform.ap_aging(${companyId}, ${id}, ${ref!.d}::date)`;
      const [total] = await tx<{ t: string }[]>`
        select coalesce(sum(amount), 0)::text as t
          from platform.ap_aging(${companyId}, ${id}, ${ref!.d}::date)`;
      return { reference_date: ref!.d, buckets, total: total?.t ?? "0" };
    });
    return c.json(cuerpo, 200);
  });

  app.get("/v1/suppliers/:id/statement", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeApRead(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      if (!empresa) return null;
      const invoices = await tx<Record<string, unknown>[]>`
        select i.id, i.supplier_document_number, i.invoice_date::text as invoice_date,
               i.due_date::text as due_date, i.status, i.total_amount::text as total_amount,
               coalesce((select sum(p.gross_amount) from public.supplier_payments p
                          where p.supplier_invoice_id = i.id), 0)::text as paid_amount,
               coalesce(platform.supplier_invoice_balance(${companyId}, i.id), 0)::text as balance,
               greatest(0, (current_date - coalesce(i.due_date, i.invoice_date)))::int
                 as days_outstanding
          from public.supplier_invoices i
         where i.company_id = ${companyId} and i.supplier_id = ${id}
           and i.status in ('posted', 'paid', 'annulled')
         order by i.invoice_date, i.id`;
      const [totales] = await tx<{ pendiente: string; retenido: string }[]>`
        select coalesce((select sum(platform.supplier_invoice_balance(${companyId}, i.id))
                           from public.supplier_invoices i
                          where i.company_id = ${companyId} and i.supplier_id = ${id}
                            and i.status in ('posted', 'paid')), 0)::text as pendiente,
               coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                          where r.company_id = ${companyId} and r.supplier_id = ${id}
                            and r.status <> 'cancelled'), 0)::text as retenido`;
      const buckets = await tx<Record<string, unknown>[]>`
        select supplier_id, bucket, document_count::int as document_count, amount::text as amount
          from platform.ap_aging(${companyId}, ${id}, current_date)`;
      const [ref] = await tx<{ d: string }[]>`select current_date::text as d`;
      const [totalAging] = await tx<{ t: string }[]>`
        select coalesce(sum(amount), 0)::text as t
          from platform.ap_aging(${companyId}, ${id}, current_date)`;
      return {
        supplier_id: id,
        currency: empresa.moneda,
        invoices,
        total_outstanding: totales?.pendiente ?? "0",
        total_retained: totales?.retenido ?? "0",
        aging: { reference_date: ref!.d, buckets, total: totalAging?.t ?? "0" },
      };
    });
    if (cuerpo === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(cuerpo, 200);
  });
}
