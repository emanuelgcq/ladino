import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  ReceiveStockRequest,
  IssueStockRequest,
  AdjustStockRequest,
  TransferStockRequest,
  CreateWarehouseRequest,
  SetRecipeRequest,
  ConsumeRecipeRequest,
  CreateProductTemplateRequest,
  SetStockThresholdRequest,
} from "@ladino/schemas";
import {
  receiveStock,
  issueStock,
  adjustStock,
  transferStock,
  consumeRecipe,
} from "@ladino/domain";
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
  m.reference, m.reason, m.transfer_id, m.source_document_id`;

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

/**
 * Rutas de la segunda vuelta (migración 20): recetas de compuestos, plantillas
 * de variantes, umbrales de reposición y vencimientos.
 *
 * Las consultas (bajo stock, por vencer, stock por plantilla) leen funciones de
 * `platform` en vez de armar el SQL aquí: la regla de qué está bajo mínimo vive
 * en un sitio, y un reporte y una alerta futura del worker responden lo mismo.
 */
export function inventoryExtensionsRoutes(
  app: Hono,
  sql: Sql,
  idempotencia: MiddlewareHandler,
): void {
  // ── Recetas ───────────────────────────────────────────────────────────────
  app.get("/v1/products/:id/recipe", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = uuidValido(c.req.param("id"), "id")!;
    const almacen = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const respuesta = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [producto] = await tx<{ is_composed: boolean }[]>`
        select is_composed from public.products where id = ${id} and company_id = ${companyId}`;
      if (!producto) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select r.child_product_id, hijo.sku as child_sku, hijo.name as child_name,
               r.quantity::text as quantity, r.unit_code,
               hijo.unit_code as product_unit_code,
               platform.convert_quantity(r.quantity, r.unit_code, hijo.unit_code)::text
                 as quantity_in_product_unit
          from public.product_recipes r
          join public.products hijo on hijo.id = r.child_product_id
         where r.company_id = ${companyId} and r.parent_product_id = ${id}
         order by hijo.sku`;
      const [costo] = await tx<{ estimado: string | null; moneda: string }[]>`
        select platform.recipe_cost(${companyId}, ${almacen ?? null}, ${id})::text as estimado,
               (select functional_currency_code from public.companies where id = ${companyId})
                 as moneda`;
      return {
        product_id: id,
        lines,
        estimated_unit_cost: costo?.estimado ?? null,
        currency: costo?.moneda ?? "VES",
      };
    });
    if (respuesta === null) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    return c.json(respuesta, 200);
  });

  // La receta se REEMPLAZA entera: una receta a medias no es una receta, y
  // parchear línea a línea deja estados intermedios que sí se pueden vender.
  app.put("/v1/products/:id/recipe", idempotencia, async (c) => {
    const { companyId, tenantId } = requireCompany(c);
    const id = uuidValido(c.req.param("id"), "id")!;
    const parsed = SetRecipeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Definir una receta exige un usuario real.",
      });
    }
    const userId = actor.userId;
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ autorizado: boolean }[]>`
        select platform.ladino_user_has_permission(${userId}, 'product.recipe.manage', ${companyId})
               as autorizado`;
      if (!permiso?.autorizado) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "La operación exige el permiso product.recipe.manage sobre esta empresa.",
        });
      }
      await tx`delete from public.product_recipes
                where company_id = ${companyId} and parent_product_id = ${id}`;
      for (const l of parsed.data.lines) {
        await tx`
          insert into public.product_recipes
            (tenant_id, company_id, parent_product_id, child_product_id, quantity, unit_code)
          values (${tenantId}, ${companyId}, ${id}, ${l.child_product_id},
                  ${l.quantity}, ${l.unit_code})`;
      }
      return tx<Record<string, unknown>[]>`
        select r.child_product_id, r.quantity::text as quantity, r.unit_code
          from public.product_recipes r
         where r.company_id = ${companyId} and r.parent_product_id = ${id}
         order by r.child_product_id`;
    });
    return c.json({ product_id: id, lines: filas }, 200);
  });

  // Consumir el compuesto: N salidas de ingredientes, un solo hecho.
  app.post("/v1/inventory/recipe-consumptions", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ConsumeRecipeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => consumeRecipe(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Plantillas de variantes ───────────────────────────────────────────────
  app.get("/v1/product-templates", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, company_id, name, attribute_keys, status
          from public.product_templates where company_id = ${companyId} order by name`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/product-templates", idempotencia, async (c) => {
    const { companyId, tenantId } = requireCompany(c);
    const parsed = CreateProductTemplateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Crear una plantilla exige un usuario real.",
      });
    }
    const userId = actor.userId;
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ autorizado: boolean }[]>`
        select platform.ladino_user_has_permission(${userId}, 'product.variant.manage', ${companyId})
               as autorizado`;
      if (!permiso?.autorizado) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "La operación exige el permiso product.variant.manage sobre esta empresa.",
        });
      }
      const [creada] = await tx<Record<string, unknown>[]>`
        insert into public.product_templates (tenant_id, company_id, name, attribute_keys)
        values (${tenantId}, ${companyId}, ${parsed.data.name}, ${parsed.data.attribute_keys})
        returning id, company_id, name, attribute_keys, status`;
      return creada!;
    });
    return c.json(fila, 201);
  });

  app.get("/v1/inventory/stock-by-template", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const almacen = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const items = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select template_id, template_name, product_id, sku, attributes, warehouse_id,
               quantity::text as quantity, value::text as value,
               template_quantity::text as template_quantity
          from platform.stock_by_template(${companyId}, ${almacen ?? null})`,
    );
    return c.json({ items }, 200);
  });

  // ── Umbrales y alertas ────────────────────────────────────────────────────
  app.put("/v1/inventory/thresholds", idempotencia, async (c) => {
    const { companyId, tenantId } = requireCompany(c);
    const parsed = SetStockThresholdRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    if (actor.kind !== "user") {
      throw new DominioError({
        code: "PERMISSION_REQUIRED",
        message: "Definir umbrales exige un usuario real.",
      });
    }
    const userId = actor.userId;
    const fila = await withTransaction(sql, actor, async ({ sql: tx }) => {
      const [permiso] = await tx<{ autorizado: boolean }[]>`
        select platform.ladino_user_has_permission(${userId}, 'inventory.threshold.manage', ${companyId})
               as autorizado`;
      if (!permiso?.autorizado) {
        throw new DominioError({
          code: "PERMISSION_REQUIRED",
          message: "La operación exige el permiso inventory.threshold.manage sobre esta empresa.",
        });
      }
      const [guardada] = await tx<Record<string, unknown>[]>`
        insert into public.product_stock_thresholds
          (tenant_id, company_id, warehouse_id, product_id, stock_min, stock_max)
        values (${tenantId}, ${companyId}, ${parsed.data.warehouse_id}, ${parsed.data.product_id},
                ${parsed.data.stock_min}, ${parsed.data.stock_max ?? null})
        on conflict on constraint product_stock_thresholds_key do update
          set stock_min = excluded.stock_min, stock_max = excluded.stock_max
        returning warehouse_id, product_id, stock_min::text as stock_min,
                  stock_max::text as stock_max`;
      return guardada!;
    });
    return c.json(fila, 200);
  });

  app.get("/v1/inventory/low-stock", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const almacen = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const items = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select l.warehouse_id, l.product_id, p.sku as product_sku, p.name as product_name,
               l.quantity::text as quantity, l.stock_min::text as stock_min,
               l.stock_max::text as stock_max, l.missing::text as missing
          from platform.low_stock_products(${companyId}, ${almacen ?? null}) l
          join public.products p on p.id = l.product_id`,
    );
    return c.json({ items }, 200);
  });

  app.get("/v1/inventory/expiring-lots", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const dias = Math.min(Math.max(Number(c.req.query("days") ?? 30) || 30, 0), 3650);
    const items = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select e.lot_id, e.lot_code, e.product_id, p.sku as product_sku, e.warehouse_id,
               e.expires_at::text as expires_at, e.days_left, e.quantity::text as quantity
          from platform.expiring_lots(${companyId}, ${dias}) e
          join public.products p on p.id = e.product_id`,
    );
    return c.json({ items }, 200);
  });

  // FEFO como SUGERENCIA (ADR-0035): la UI la usa para preseleccionar el lote;
  // el servidor no obliga. Lo que sí impone es que un vencido no salga sin
  // inventory.expired, y eso está en el trigger, no aquí.
  app.get("/v1/inventory/suggest-lot", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const almacen = uuidValido(c.req.query("warehouse_id"), "warehouse_id");
    const producto = uuidValido(c.req.query("product_id"), "product_id");
    if (almacen === undefined || producto === undefined) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "warehouse_id y product_id son obligatorios.",
      });
    }
    const [fila] = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<{ lot_id: string | null }[]>`
        select platform.suggest_lot_fefo(${companyId}, ${almacen}, ${producto}) as lot_id`,
    );
    return c.json({ lot_id: fila?.lot_id ?? null }, 200);
  });
}
