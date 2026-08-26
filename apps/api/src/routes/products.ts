import type { Context, Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  CreateProductRequest,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
} from "@ladino/schemas";
import { createProduct, updateProduct, setProductTaxCategory } from "@ladino/domain";
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
  unit_code, tax_category_code, category_id, barcode,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

export function productsRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // Listado con búsqueda y PAGINACIÓN EN SERVIDOR (WEBAPP_SPEC §Rendimiento):
  // filtros en el query string para que una vista sea compartible.
  app.get("/v1/products", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const search = c.req.query("search")?.trim() ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);

    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      const filtro =
        search === ""
          ? tx``
          : tx`and (sku ilike ${comoPatron(search)} escape '\\'
                 or name ilike ${comoPatron(search)} escape '\\')`;
      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(PRODUCT_SELECT)}, count(*) over ()::int as total
          from public.products
         where company_id = ${companyId} ${filtro}
         order by sku
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
