import type { Context, Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  CreateProductRequest,
  CreateProductSimpleRequest,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
} from "@ladino/schemas";
import {
  createProduct,
  createProductSimple,
  updateProduct,
  setProductTaxCategory,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { CTX } from "../middleware/context.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Rutas de productos — la forma de companies.ts (handler delgado, errores
 * LANZADOS al onError, rutas sobre la app principal), con la novedad de este
 * módulo: TODO exige `X-Company-Id` ya validado por el middleware de scope.
 * El `company_id` del cuerpo tiene que COINCIDIR con el del header: dos
 * fuentes para el mismo hecho solo se aceptan si dicen lo mismo.
 */
export function requireCompany(c: Context): { companyId: string; tenantId: string } {
  const ctx = c.get(CTX);
  if (ctx.companyId === null || ctx.tenantId === null) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "Esta operación exige el header X-Company-Id.",
    });
  }
  return { companyId: ctx.companyId, tenantId: ctx.tenantId };
}

function exigirCoherencia(companyIdHeader: string, companyIdBody: string): void {
  if (companyIdHeader !== companyIdBody) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

/** Escapa los comodines de LIKE: un término de búsqueda es dato, no patrón. */
function comoPatron(termino: string): string {
  return `%${termino.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

const PRODUCT_SELECT = `id, tenant_id, company_id, sku, name, kind, status,
  unit_code, tax_category_code, category_id, barcode, image_path,
  is_composed, tracks_lots, tracks_serials, is_manufactured, tracks_expiry,
  template_id, attributes,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

/** El mismo select, con el alias `p.` del listado (los joins de la cuadrícula). */
const PRODUCT_SELECT_P = `p.id, p.tenant_id, p.company_id, p.sku, p.name, p.kind, p.status,
  p.unit_code, p.tax_category_code, p.category_id, p.barcode, p.image_path,
  p.is_composed, p.tracks_lots, p.tracks_serials, p.is_manufactured, p.tracks_expiry,
  p.template_id, p.attributes,
  to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

export function productsRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // Listado con búsqueda y PAGINACIÓN EN SERVIDOR (WEBAPP_SPEC §Rendimiento):
  // filtros en el query string para que una vista sea compartible.
  app.get("/v1/products", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const search = c.req.query("search")?.trim() ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    // Los extras de la CUADRÍCULA de Vender (Fase C): precio de lista, stock
    // total y solo-activos. Opt-in por query para que el listado admin no
    // pague joins que no muestra.
    const soloActivos = c.req.query("only_active") === "1";
    const conPrecio = c.req.query("with_price") === "1";
    const conStock = c.req.query("with_stock") === "1";
    const listaPedida = c.req.query("price_list_id") ?? null;

    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // La búsqueda incluye el código de barras: la cuadrícula tiene lector.
      const filtro =
        search === ""
          ? tx``
          : tx`and (p.sku ilike ${comoPatron(search)} escape '\\'
                 or p.name ilike ${comoPatron(search)} escape '\\'
                 or p.barcode ilike ${comoPatron(search)} escape '\\')`;
      const activos = soloActivos ? tx`and p.status = 'active'` : tx``;

      // La lista de precios: la pedida, o «detal» de la empresa (la del alta
      // simple). Resolverla aquí y no en el cliente es lo que permite que la
      // cuadrícula funcione sin saber de listas.
      let listaId: string | null = null;
      if (conPrecio) {
        if (listaPedida !== null && UUID_RE.test(listaPedida)) {
          listaId = listaPedida;
        } else {
          const [l] = await tx<{ id: string }[]>`
            select id from public.price_lists
             where company_id = ${companyId} and status = 'active'
             order by (name = 'detal') desc, (name like 'detal%') desc, created_at
             limit 1`;
          listaId = l?.id ?? null;
        }
      }

      const precioJoin = conPrecio
        ? tx`left join lateral (
              select i.amount::text as price_amount, l.currency_code as price_currency,
                     l.id as price_list_id
                from public.price_list_items i
                join public.price_lists l on l.id = i.price_list_id
               where i.price_list_id = ${listaId} and i.product_id = p.id
                 and i.effective_from <= now()
                 and (i.effective_to is null or i.effective_to > now())
               order by i.effective_from desc limit 1
            ) precio on true`
        : tx``;
      const stockJoin = conStock
        ? tx`left join lateral (
              select coalesce(sum(b.quantity), 0)::text as stock_quantity
                from public.stock_balances b
               where b.company_id = p.company_id and b.product_id = p.id
            ) existencia on true`
        : tx``;
      const extras = `${conPrecio ? ", precio.price_amount, precio.price_currency, precio.price_list_id" : ""}${conStock ? ", existencia.stock_quantity" : ""}`;

      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(PRODUCT_SELECT_P)} ${tx.unsafe(extras)}, count(*) over ()::int as total
          from public.products p
          ${precioJoin}
          ${stockJoin}
         where p.company_id = ${companyId} ${filtro} ${activos}
         order by p.name
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });

    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    const items = filas.map(({ total: _total, ...resto }) => resto);
    return c.json({ items, total }, 200);
  });

  app.get("/v1/products/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const [fila] = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select ${tx.unsafe(PRODUCT_SELECT)} from public.products
         where id = ${id} and company_id = ${companyId}`,
    );
    if (!fila) throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(fila, 200);
  });

  app.post("/v1/products", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateProductRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) => createProduct(uow, parsed.data));
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  /** El ALTA SIMPLE de la Fase C: nombre + precio (+ stock inicial) en un paso. */
  app.post("/v1/products/simple", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateProductSimpleRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      createProductSimple(uow, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });

  app.patch("/v1/products/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = UpdateProductRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      updateProduct(uow, id, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 200);
  });

  // El mapeo tributario tiene endpoint y PERMISO propios (D-10, segregación):
  // que exista PATCH no significa que cualquiera reclasifique impuestos.
  app.put("/v1/products/:id/tax-category", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = SetProductTaxCategoryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    exigirCoherencia(companyId, parsed.data.company_id);

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) =>
      setProductTaxCategory(uow, id, parsed.data),
    );
    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 200);
  });
}
