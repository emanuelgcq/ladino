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
  RegisterArrivalRequest,
  ClosePurchaseOrderRequest,
  normalizarDocumento,
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
  registerArrival,
  previewArrival,
  previewSupplierPayment,
  ventasIntermedias,
  closePurchaseOrder,
  cargarReglaDeRetencion,
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
 * CONVENCIÓN de lectura de compras (cierre RBAC del 2026-09-08): el lado del
 * dinero se abre con `ap.read`; el lado OPERATIVO se abre además con el
 * permiso mutante del mismo objeto — quien puede recibir mercancía puede ver
 * las órdenes contra las que recibe, quien registra la factura puede ver el
 * matching. Así el encargado (sin ap.read) sigue operando y el cajero queda
 * fuera. La misma convención vale para cualquier GET de compras futuro.
 */
async function exigeLecturaDeCompras(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  ademas: readonly string[],
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar compras exige un usuario real.",
    });
  }
  const permisos = ["ap.read", ...ademas];
  const [permiso] = await tx<{ ok: boolean }[]>`
    select bool_or(platform.ladino_user_has_permission(${actor.userId}, p, ${companyId})) as ok
      from unnest(${permisos}::text[]) as p`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `Consultar esto exige ap.read o ${ademas.join(" / ")}.`,
    });
  }
}

/**
 * Lo que SÍ se conoce cuando falta la tasa: lo que se le debe a un proveedor en cada moneda,
 * sin convertir (las facturas asentadas con saldo; `fecha` acota a las fechadas hasta ese día).
 * La suma la hace el esquema. Solo se pregunta cuando el total en bolívares viene en NULL.
 */
async function nominalPorMonedaDeProveedor(
  tx: TransactionSql,
  companyId: string,
  supplierId: string,
  fecha: string | null,
): Promise<{ currency: string; nominal: string }[]> {
  return tx<{ currency: string; nominal: string }[]>`
    select s.currency,
           round(sum(s.saldo), platform.currency_minor_units(s.currency))::text as nominal
      from (select i.transaction_currency as currency,
                   platform.supplier_invoice_balance(${companyId}, i.id) as saldo
              from public.supplier_invoices i
             where i.company_id = ${companyId} and i.supplier_id = ${supplierId}
               and i.status = 'posted'
               and (${fecha}::date is null or i.invoice_date <= ${fecha}::date)) s
     where s.saldo > 0
     group by s.currency
     order by s.currency`;
}

/**
 * La antigüedad de lo que se le debe a un proveedor (`platform.ap_aging`). UNA LISTA NUNCA SE
 * CAE (migración 20261004200000): sin tasa dentro del margen, el tramo con una factura en divisa
 * trae `amount` en NULL. NULL no es cero —`sum()` lo descartaría en silencio—, así que el total
 * es NULL con su motivo (`sin_tasa`) y el nominal por moneda, como el resumen del negocio.
 */
async function antiguedadDeProveedor(
  tx: TransactionSql,
  companyId: string,
  supplierId: string,
  fecha: string,
): Promise<{
  reference_date: string;
  buckets: Record<string, unknown>[];
  total: string | null;
  total_motivo: "sin_tasa" | null;
  total_por_moneda: { currency: string; nominal: string }[];
}> {
  const buckets = await tx<Record<string, unknown>[]>`
    select supplier_id, bucket, document_count::int as document_count, amount::text as amount
      from platform.ap_aging(${companyId}, ${supplierId}, ${fecha}::date)`;
  const [total] = await tx<{ t: string | null }[]>`
    select (case when bool_or(amount is null) then null
                 else coalesce(sum(amount), 0) end)::text as t
      from platform.ap_aging(${companyId}, ${supplierId}, ${fecha}::date)`;
  const sinTasa = total !== undefined && total.t === null;
  return {
    reference_date: fecha,
    buckets,
    total: total === undefined ? "0" : total.t,
    total_motivo: sinTasa ? "sin_tasa" : null,
    total_por_moneda: sinTasa
      ? await nominalPorMonedaDeProveedor(tx, companyId, supplierId, fecha)
      : [],
  };
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
    const buscado = normalizarDocumento(search);
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // Antes sin ningún permiso: cualquier miembro listaba RIF, dirección y
      // correo de los proveedores (auditoría 2026-09-11, M-31).
      await exigeLecturaDeCompras(tx, actor, companyId, [
        "purchase.order.manage",
        "purchase.invoice.register",
        "purchase.payment.register",
        "purchase.receive",
        "supplier.manage",
        "expense.register",
      ]);
      const filtro =
        search === ""
          ? tx``
          : // P-02 «en todos los caminos»: el documento también se compara NORMALIZADO por los
            // dos lados, así «J40555123» encuentra «J-40555123-4» y al revés.
            tx`and (coalesce(tax_id, '') ilike ${`%${search}%`} or legal_name ilike ${`%${search}%`}
                 or (${buscado} <> ''
                     and upper(regexp_replace(coalesce(tax_id, ''), '[^a-zA-Z0-9]', '', 'g'))
                         like ${`%${buscado}%`}))`;
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
    // «Por recibir» (ADR-0066, entrega iii): los pedidos que siguen esperando mercancía. El
    // estado se DERIVA de las recepciones —una orden cerrada a mano y tres recepciones parciales
    // son dos verdades—, así que el filtro pregunta a la función, no a la columna.
    const soloPendientes = c.req.query("pending") === "1";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLecturaDeCompras(tx, actor, companyId, [
        "purchase.order.manage",
        "purchase.receive",
      ]);
      return tx<Record<string, unknown>[]>`
        select o.id, o.company_id, o.supplier_id, s.legal_name as supplier_name, o.warehouse_id,
               ((now() at time zone 'America/Caracas')::date
                - (o.ordered_at at time zone 'America/Caracas')::date)::int as age_days,
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
          join public.suppliers s on s.id = o.supplier_id
         where o.company_id = ${companyId}
           ${
             soloPendientes
               ? // «Por recibir» pregunta por lo que el negocio ESPERA, y eso son dos
                 // condiciones, no una: que el pedido siga vivo (la columna) y que le falte
                 // mercancía (las recepciones). El estado derivado ignora a propósito lo
                 // cerrado a mano, así que filtrar solo por él dejaba en la bandeja los
                 // pedidos que alguien acababa de cerrar — con su motivo escrito y todo.
                 tx`and o.status not in ('draft', 'closed', 'cancelled')
                    and platform.purchase_order_status(o.company_id, o.id) in ('pending', 'partial')`
               : tx``
           }
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
      await exigeLecturaDeCompras(tx, actor, companyId, [
        "purchase.order.manage",
        "purchase.receive",
      ]);
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
      // Lo facturado y lo que falta por facturar, por línea (QA 2026-09-15, h. 86): la pantalla
      // proponía facturar lo PEDIDO aunque ya estuviera facturado, y el servidor lo aceptaba.
      const progress = await tx<Record<string, unknown>[]>`
        select pr.order_line_id, pr.product_id, pr.quantity_ordered::text as quantity_ordered,
               pr.quantity_received::text as quantity_received,
               pr.quantity_pending::text as quantity_pending,
               f.facturada::text as quantity_invoiced,
               greatest(pr.quantity_received - f.facturada, 0)::text as quantity_to_invoice
          from platform.purchase_order_progress(${companyId}, ${id}) pr
          cross join lateral (
            select coalesce(sum(il.quantity), 0) as facturada
              from public.supplier_invoice_lines il
              join public.supplier_invoices i on i.id = il.supplier_invoice_id
             where i.purchase_order_id = ${id} and i.status <> 'annulled'
               and il.product_id = pr.product_id
          ) f`;
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

  /**
   * «NO VA A LLEGAR»: el pedido sale de la bandeja con su motivo escrito (ADR-0066, entrega
   * iii). Lo recibido a medias se queda: cerrar no devuelve mercancía.
   */
  app.post("/v1/purchase-orders/:id/close", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ClosePurchaseOrderRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const id = idValido(c.req.param("id"));
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => closePurchaseOrder(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

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

  /**
   * «FALTA LA FACTURA» (ADR-0066 §8). Lo recibido que todavía no está facturado, con su
   * antigüedad: la misma consulta que alimenta el aviso de los 30 días, para que la pantalla y
   * el control no puedan decir cosas distintas.
   */
  app.get("/v1/goods-receipts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const pendientes = c.req.query("pending_invoice") === "1";
    const items = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLecturaDeCompras(tx, actor, companyId, ["purchase.receive"]);
      if (!pendientes) return [];
      return tx<Record<string, unknown>[]>`
        select receipt_id as id, received_on::text as received_on, age_days,
               supplier_id, supplier_name, delivery_note_ref,
               quantity_received::text as quantity_received,
               quantity_invoiced::text as quantity_invoiced,
               pending_amount::text as pending_amount
          from platform.receipts_pending_invoice(${companyId})`;
    });
    return c.json({ items }, 200);
  });

  app.get("/v1/goods-receipts/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const detalle = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLecturaDeCompras(tx, actor, companyId, ["purchase.receive"]);
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
    // PAGINADO (2026-09-10). Antes: `limit 100` a secas — con más de cien
    // facturas de proveedor, las siguientes no existían para la pantalla y
    // nada lo decía. El `total` ya se calculaba; solo faltaba poder pedir
    // la página siguiente.
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLecturaDeCompras(tx, actor, companyId, [
        "purchase.invoice.register",
        "purchase.payment.register",
      ]);
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
         order by i.invoice_date desc, i.id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
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
      await exigeLecturaDeCompras(tx, actor, companyId, ["purchase.invoice.register"]);
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
      await exigeLecturaDeCompras(tx, actor, companyId, ["purchase.landed_cost.apply"]);
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

  /**
   * H-03: lo que la pantalla de la nota de crédito necesita de la factura que corrige. Solo
   * lee: la clase de la factura, si retuvo y sus líneas con la alícuota congelada.
   */
  app.get("/v1/supplier-invoices/:id/lines", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // `expense.register` solo abre la factura de un GASTO: quien solo lleva gastos no lee las
      // facturas de mercancía. La clase se mira antes SOLO para elegir el permiso.
      const [clase] = await tx<{ gasto: boolean }[]>`
        select expense_category is not null as gasto from public.supplier_invoices
         where id = ${id} and company_id = ${companyId}`;
      try {
        await exigeLecturaDeCompras(tx, actor, companyId, [
          "purchase.credit_note.register",
          "purchase.invoice.register",
          ...(clase?.gasto === true ? ["expense.register"] : []),
        ]);
      } catch (e) {
        if (clase !== undefined && !clase.gasto && e instanceof DominioError) {
          throw new DominioError({
            code: "PERMISSION_REQUIRED",
            message:
              "Esta factura es de mercancía: con el permiso de registrar gastos solo se abren las facturas de un gasto.",
          });
        }
        throw e;
      }
      const [f] = await tx<Record<string, unknown>[]>`
        select i.id as supplier_invoice_id, i.transaction_currency,
               i.expense_category is not null as is_expense, i.fiscal_support,
               exists (select 1 from public.supplier_retentions r
                        where r.supplier_invoice_id = i.id and r.status <> 'cancelled')
                 as has_retention
          from public.supplier_invoices i
         where i.id = ${id} and i.company_id = ${companyId}`;
      if (!f) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select il.id, il.line_number, il.description, il.product_id,
               il.quantity::text as quantity,
               il.goods_receipt_line_id is not null as has_receipt,
               coalesce((select p.tracks_lots from public.products p
                          where p.id = il.product_id), false) as tracks_lots,
               coalesce((select sum(cl.quantity)
                           from public.supplier_credit_note_lines cl
                           join public.supplier_credit_notes n
                             on n.id = cl.supplier_credit_note_id
                          where cl.supplier_invoice_line_id = il.id and n.status = 'posted'
                            and n.correction_kind = 'devolucion'), 0)::text as returned_quantity
          from public.supplier_invoice_lines il
         where il.supplier_invoice_id = ${id} and il.company_id = ${companyId}
         order by il.line_number`;
      // H-03, tercera ronda: la devolución de un producto por lotes cuya línea no viene de una
      // recepción pregunta el LOTE. Aquí van los lotes con existencia de esos productos, con su
      // depósito y su vencimiento; los vencidos INCLUIDOS y marcados (devolverlos es el caso).
      // «Vencido» con la misma granularidad que LAD46 (20261005130100): el día de Caracas.
      const lots = await tx<Record<string, unknown>[]>`
        select b.product_id, b.warehouse_id, l.id as lot_id, l.code,
               l.expires_at::text as expires_at,
               coalesce(l.expires_at < platform.caracas_day(now()), false) as expired,
               b.quantity::text as quantity
          from public.stock_balances b
          join public.lots l on l.id = b.lot_id and l.company_id = b.company_id
         where b.company_id = ${companyId} and b.quantity > 0
           and b.product_id in (
                 select il.product_id
                   from public.supplier_invoice_lines il
                   join public.products p on p.id = il.product_id and p.tracks_lots
                  where il.supplier_invoice_id = ${id} and il.company_id = ${companyId}
                    and il.goods_receipt_line_id is null)
         order by b.product_id, l.expires_at nulls last, l.code, b.warehouse_id`;
      return { ...f, lines, lots };
    });
    if (cuerpo === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(cuerpo, 200);
  });

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

  /**
   * La vista previa del pago (D-02): el MISMO caso de uso, deshecho al terminar. Sin
   * idempotencia: no crea nada (como `/v1/arrivals/preview`).
   */
  app.post("/v1/supplier-payments/preview", async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterSupplierPaymentRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => previewSupplierPayment(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
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

  /**
   * LA LLEGADA DE MERCANCÍA (ADR-0066) — la única puerta. Un solo caso de uso transaccional
   * decide cuál de las cuatro salidas contables le toca al hecho que la persona describió;
   * los permisos los comprueba cada pieza que se compone, con su alcance de almacén.
   */
  app.post("/v1/arrivals", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterArrivalRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => registerArrival(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /**
   * La vista previa de la llegada (D-05): el MISMO caso de uso, deshecho al terminar. Sin
   * idempotencia: no crea nada (como `/v1/pos/tender`).
   */
  app.post("/v1/arrivals/preview", async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterArrivalRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => previewArrival(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  /**
   * Lo que se vendió desde una fecha: la pantalla lo muestra ANTES de confirmar una llegada
   * fechada hacia atrás, porque ese costo ya quedó registrado y no se corrige (ADR-0066 §5).
   */
  app.get("/v1/arrivals/impact", async (c) => {
    const { companyId } = requireCompany(c);
    const desde = c.req.query("from") ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "«from» debe ser una fecha YYYY-MM-DD.",
      });
    }
    const productos = (c.req.query("product_ids") ?? "")
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p !== "")
      .map((p) => idValido(p));
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(sql, actor, ({ sql: tx }) =>
      ventasIntermedias(tx, companyId, desde, productos),
    );
    return c.json({ sales_since: filas }, 200);
  });

  app.get("/v1/retention-receipts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // Antes sin permiso y con un tope de 200 sin total (auditoría
      // 2026-09-11, M-31). Sigue devolviendo el ARRAY (la web lo lee así);
      // el total viaja en la cabecera X-Total-Count.
      await exigeLecturaDeCompras(tx, actor, companyId, [
        "purchase.payment.register",
        "retention.receipt.issue",
        "fiscal_book.read",
      ]);
      return tx<Record<string, unknown>[]>`
        select id, supplier_id, supplier_invoice_id, series,
               receipt_number::int as receipt_number, control_number::int as control_number,
               status,
               to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
               fiscal_period, total_retained::text as total_retained, functional_currency,
               count(*) over ()::int as total
          from public.retention_receipts where company_id = ${companyId}
         order by series, receipt_number desc nulls last, id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    c.header("X-Total-Count", String(total));
    return c.json(
      filas.map(({ total: _t, ...r }) => r),
      200,
    );
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
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, jurisdiction, retention_code, concept_code, taxpayer_type,
               supplier_person_type, formula_kind, rate::text as rate,
               subtrahend::text as subtrahend, minimum_exempt::text as minimum_exempt,
               effective_from::text as effective_from, effective_to::text as effective_to,
               legal_source, priority, status,
               case when company_id is null then 'plataforma' else 'propia' end as scope
          from public.retention_rules
         -- Lo que esta empresa VE: la plataforma y lo suyo (ADR-0057).
         where company_id is null or company_id = ${companyId}
         order by (company_id is not null) desc, retention_code, concept_code, effective_from desc`,
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
      // Cargar la regla y dejar su acta es una regla del dominio (§2.15): aquí, solo el permiso.
      return cargarReglaDeRetencion(tx, companyId, d);
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
      return antiguedadDeProveedor(tx, companyId, id, ref!.d);
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
               i.due_date::text as due_date, i.status, i.transaction_currency,
               i.total_amount::text as total_amount,
               coalesce((select sum(p.gross_amount) from public.supplier_payments p
                          where p.supplier_invoice_id = i.id), 0)::text as paid_amount,
               coalesce(platform.supplier_invoice_balance(${companyId}, i.id), 0)::text as balance,
               -- La deuda de hoy en bolívares; NULL en una anulada (no hay deuda).
               platform.supplier_debt_today(${companyId}, i.id)::text as balance_today,
               greatest(0, (current_date - coalesce(i.due_date, i.invoice_date)))::int
                 as days_outstanding
          from public.supplier_invoices i
         where i.company_id = ${companyId} and i.supplier_id = ${id}
           and i.status in ('posted', 'paid', 'annulled')
         order by i.invoice_date, i.id`;
      const [totales] = await tx<{ pendiente: string | null; retenido: string }[]>`
        -- En moneda funcional, como balance_today y la antigüedad (migración 65); las filas
        -- conservan además su saldo en la moneda de la factura.
        -- UNA LISTA NUNCA SE CAE (20261004200000): sin tasa dentro del margen,
        -- supplier_debt_today devuelve NULL para lo que se debe en divisa. NULL no es cero y
        -- sum() lo descartaría en silencio: si alguna factura QUE SE DEBE no se pudo valorar, el
        -- total es NULL.
        -- LA MISMA PREGUNTA QUE ap_aging: «sin tasa» es DEUDA sin valorar (deuda NULL y saldo
        -- nominal > 0). Una factura en divisa de saldo NEGATIVO (retenida o pagada de más) y
        -- sin tasa también da NULL, pero no se le debe nada: no hace al total NULL —antes sí, con
        -- el nominal vacío, mientras la antigüedad de esta misma respuesta no la contaba—. Su
        -- saldo a favor queda en su fila, en su moneda; sin tasa no resta del total.
        -- H-03, tercera ronda (C2): LO QUE SE DEBE son solo los saldos POSITIVOS, como ap_aging y
        -- el resumen del Inicio. Una factura con saldo negativo (su nota de crédito abonó de
        -- más) no es deuda negativa: su saldo a favor va APARTE (credit_in_favor) y no se
        -- descuenta solo. Antes se sumaba sin acotar y el total salía por debajo de la
        -- antigüedad de esta misma respuesta. El filtro va en el sum(), no con greatest(): así el
        -- NULL de «sin tasa» de una factura CON saldo sigue haciendo NULL el total.
        select (select case when bool_or(d.deuda is null and d.nominal > 0) then null
                            -- Sin ninguna con saldo, el cero conserva la escala de la moneda
                            -- (sum(deuda * 0) = 0.00), como cuando se sumaba todo.
                            else coalesce(sum(d.deuda) filter (where d.nominal > 0),
                                          sum(d.deuda * 0), 0) end
                  from (select platform.supplier_debt_today(${companyId}, i.id) as deuda,
                               platform.supplier_invoice_balance(${companyId}, i.id) as nominal
                          from public.supplier_invoices i
                         where i.company_id = ${companyId} and i.supplier_id = ${id}
                           and i.status in ('posted', 'paid')) d)::text as pendiente,
               coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                          where r.company_id = ${companyId} and r.supplier_id = ${id}
                            and r.status <> 'cancelled'), 0)::text as retenido`;
      // EL SALDO A FAVOR, APARTE. En la moneda de cada factura sale del AUXILIAR (lo que hoy
      // dice supplier_invoice_balance); en bolívares, solo lo que el mayor declara: lo que las
      // notas vigentes de este proveedor asentaron en la cuenta de saldos a favor.
      const aFavor = await tx<{ currency: string; nominal: string }[]>`
        select s.currency,
               round(sum(-s.saldo), platform.currency_minor_units(s.currency))::text as nominal
          from (select i.transaction_currency as currency,
                       platform.supplier_invoice_balance(${companyId}, i.id) as saldo
                  from public.supplier_invoices i
                 where i.company_id = ${companyId} and i.supplier_id = ${id}
                   and i.status in ('posted', 'paid')) s
         where s.saldo < 0
         group by s.currency
         order by s.currency`;
      const [aFavorBs] = await tx<{ v: string }[]>`
        select round(coalesce(sum(n.credit_in_favor_functional), 0), 2)::text as v
          from public.supplier_credit_notes n
         where n.company_id = ${companyId} and n.supplier_id = ${id} and n.status = 'posted'`;
      // Las notas de crédito del proveedor, con lo que dice su papel. `document_incomplete`:
      // nota fiscal que llegó sin número de control, aunque traiga una referencia (PA 00071
      // art. 23 → art. 13; 20261005110700).
      const creditNotes = await tx<Record<string, unknown>[]>`
        select n.id, n.supplier_invoice_id, n.supplier_document_number,
               n.supplier_control_number, n.note_date::text as note_date,
               n.transaction_currency, n.total_amount::text as total_amount,
               n.correction_kind as kind, n.is_fiscal, n.document_incomplete
          from public.supplier_credit_notes n
         where n.company_id = ${companyId} and n.supplier_id = ${id} and n.status = 'posted'
         order by n.note_date, n.id`;
      const [ref] = await tx<{ d: string }[]>`select current_date::text as d`;
      const pendiente = totales?.pendiente ?? null;
      const sinTasa = totales !== undefined && pendiente === null;
      return {
        supplier_id: id,
        currency: empresa.moneda,
        invoices,
        total_outstanding: totales === undefined ? "0" : pendiente,
        total_outstanding_motivo: sinTasa ? ("sin_tasa" as const) : null,
        total_outstanding_por_moneda: sinTasa
          ? await nominalPorMonedaDeProveedor(tx, companyId, id, null)
          : [],
        total_retained: totales?.retenido ?? "0",
        credit_in_favor: aFavor,
        credit_in_favor_functional: aFavorBs?.v ?? "0.00",
        credit_notes: creditNotes,
        aging: await antiguedadDeProveedor(tx, companyId, id, ref!.d),
      };
    });
    if (cuerpo === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(cuerpo, 200);
  });
}
