import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  ReceiveStockRequest,
  IssueStockRequest,
  AdjustStockRequest,
  TransferStockRequest,
  CreateWarehouseRequest,
} from "@ladino/schemas";
import { receiveStock, issueStock, adjustStock, transferStock } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MOVE_SELECT = `m.id, m.company_id, m.warehouse_id, m.product_id, m.lot_id, m.kind,
  m.quantity::text as quantity,
  m.functional_amount::text as functional_amount, m.functional_currency,
  m.amount_transaction_currency::text as amount_transaction_currency, m.transaction_currency,
  m.fx_rate::text as fx_rate, m.rate_source,
  to_char(m.rate_timestamp at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as rate_timestamp,
  m.rounding_policy_id, m.unit_cost::text as unit_cost,
  m.quantity_after::text as quantity_after, m.value_after::text as value_after,
  to_char(m.occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as occurred_at,
  m.reference, m.reason, m.transfer_id`;

function coherente(header: string, body: string): void {
  if (header !== body) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

function uuidValido(valor: string | undefined, campo: string): string | undefined {
  if (valor === undefined) return undefined;
  if (!UUID_RE.test(valor)) {
    throw new DominioError({ code: "VALIDATION_FAILED", message: `${campo} malformado.` });
  }
  return valor;
}

/**
 * Rutas de inventario. La forma de products.ts: handler delgado, errores LANZADOS
 * al onError, y `X-Company-Id` validado por el middleware de scope. Las cuatro
 * operaciones que mueven stock son mutantes críticas: `Idempotency-Key` obligatoria.
 */
export function inventoryRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // Existencias: el kardex MATERIALIZADO, que es lo que consulta el POS.
  app.get("/v1/inventory/stock", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const warehouseId = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const productId = uuidValido(c.req.query("product_id"), "product_id");
    const search = c.req.query("search")?.trim() ?? "";
    const conStock = c.req.query("with_stock") === "true";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);

    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      const porAlmacen = warehouseId === undefined ? tx`` : tx`and b.warehouse_id = ${warehouseId}`;
      const porProducto = productId === undefined ? tx`` : tx`and b.product_id = ${productId}`;
      const porTexto =
        search === ""
          ? tx``
          : tx`and (p.sku ilike ${`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} escape '\\'
                 or p.name ilike ${`%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`} escape '\\')`;
      const conSaldo = conStock ? tx`and b.quantity <> 0` : tx``;
      return tx<Record<string, unknown>[]>`
        select b.warehouse_id, w.code as warehouse_code, b.product_id, p.sku as product_sku,
               p.name as product_name, b.lot_id, l.code as lot_code,
               b.quantity::text as quantity, b.value::text as value,
               b.currency_code as currency, b.last_unit_cost::text as last_unit_cost,
               count(*) over ()::int as total
          from public.stock_balances b
          join public.products p on p.id = b.product_id
          join public.warehouses w on w.id = b.warehouse_id
          left join public.lots l on l.id = b.lot_id
         where b.company_id = ${companyId} ${porAlmacen} ${porProducto} ${porTexto} ${conSaldo}
         order by w.code, p.sku, l.code nulls first
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  // Kardex paginado, con filtro por producto y por fecha.
  app.get("/v1/inventory/moves", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const productId = uuidValido(c.req.query("product_id"), "product_id");
    const warehouseId = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const desde = c.req.query("from");
    const hasta = c.req.query("to");
    for (const [nombre, valor] of [
      ["from", desde],
      ["to", hasta],
    ] as const) {
      if (valor !== undefined && Number.isNaN(Date.parse(valor))) {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message: `\`${nombre}\` debe ser una fecha ISO 8601.`,
        });
      }
    }
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);

    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      const porProducto = productId === undefined ? tx`` : tx`and m.product_id = ${productId}`;
      const porAlmacen = warehouseId === undefined ? tx`` : tx`and m.warehouse_id = ${warehouseId}`;
      const desdeF = desde === undefined ? tx`` : tx`and m.occurred_at >= ${desde}`;
      const hastaF = hasta === undefined ? tx`` : tx`and m.occurred_at <= ${hasta}`;
      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(MOVE_SELECT)}, count(*) over ()::int as total
          from public.inventory_moves m
         where m.company_id = ${companyId} ${porProducto} ${porAlmacen} ${desdeF} ${hastaF}
         order by m.occurred_at desc, m.id desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.post("/v1/inventory/receipts", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ReceiveStockRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => receiveStock(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/inventory/issues", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = IssueStockRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => issueStock(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // Ajuste: permiso propio (inventory.adjust) y motivo obligatorio en el esquema.
  app.post("/v1/inventory/adjustments", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = AdjustStockRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => adjustStock(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/inventory/transfers", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = TransferStockRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => transferStock(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/warehouses", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, tenant_id, company_id, branch_id, code, name, status
          from public.warehouses where company_id = ${companyId} order by code`,
    );
    return c.json(filas, 200);
  });

  // Alta de almacén: `warehouse.manage` (NO acotado — crear un almacén no puede
  // exigir alcance sobre un almacén que todavía no existe).
  app.post("/v1/warehouses", idempotencia, async (c) => {
    const { companyId, tenantId } = requireCompany(c);
    const parsed = CreateWarehouseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Crear un almacén exige un usuario real.",
      });
    }
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ autorizado: boolean }[]>`
        select platform.ladino_user_has_permission(${actor.userId}, 'warehouse.manage', ${companyId})
               as autorizado`;
      if (!permiso?.autorizado) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "La operación exige el permiso warehouse.manage sobre esta empresa.",
        });
      }
      const [creado] = await tx<Record<string, unknown>[]>`
        insert into public.warehouses (tenant_id, company_id, branch_id, code, name)
        values (${tenantId}, ${companyId}, ${parsed.data.branch_id ?? null},
                ${parsed.data.code}, ${parsed.data.name})
        returning id, tenant_id, company_id, branch_id, code, name, status`;
      return creado!;
    });
    return c.json(fila, 201);
  });
}
