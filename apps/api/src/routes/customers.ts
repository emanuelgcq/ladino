import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  CreateCustomerRequest,
  UpdateCustomerRequest,
  SetCustomerTaxIdRequest,
  SetCustomerBlockedRequest,
} from "@ladino/schemas";
import {
  createCustomer,
  updateCustomer,
  setCustomerTaxId,
  setCustomerBlocked,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS = `id, tenant_id, company_id, tax_id, legal_name, trade_name, person_type_code,
  taxpayer_type_code, fiscal_address, email, phone, status, default_price_list_id,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

/** El mismo select con alias `cu.` (el join de deuda del listado de Fase C). */
const COLUMNS_CU = `cu.id, cu.tenant_id, cu.company_id, cu.tax_id, cu.legal_name, cu.trade_name,
  cu.person_type_code, cu.taxpayer_type_code, cu.fiscal_address, cu.email, cu.phone, cu.status,
  cu.default_price_list_id, cu.is_system,
  to_char(cu.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

function comoPatron(termino: string): string {
  return `%${termino.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

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

/** Rutas de clientes: la forma de products.ts; tres permisos segregados detrás. */
export function customersRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  app.get("/v1/customers", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const search = c.req.query("search")?.trim() ?? "";
    // Fase C: `with_debt=1` añade lo que CADA cliente debe (suma de saldos
    // positivos de sus facturas emitidas), calculado por el ESQUEMA. La
    // pantalla de Clientes vive de esta cifra; pedirla es opt-in porque el
    // cálculo recorre las facturas abiertas del cliente.
    const conDeuda = c.req.query("with_debt") === "1";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 20) || 20, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, ({ sql: tx }) => {
      const filtro =
        search === ""
          ? tx``
          : tx`and (coalesce(cu.tax_id, '') ilike ${comoPatron(search)} escape '\\'
                 or cu.legal_name ilike ${comoPatron(search)} escape '\\')`;
      const deudaJoin = conDeuda
        ? tx`left join lateral (
              select coalesce(sum(greatest(platform.document_balance(cu.company_id, d.id), 0)), 0)
                     ::text as debt
                from public.documents d
               where d.company_id = cu.company_id and d.customer_id = cu.id
                 and d.kind in ('invoice', 'receipt') and d.status = 'issued'
            ) deuda on true`
        : tx``;
      const deudaCol = conDeuda ? ", deuda.debt" : "";
      return tx<Record<string, unknown>[]>`
        select ${tx.unsafe(COLUMNS_CU)} ${tx.unsafe(deudaCol)},
               count(*) over ()::int as total
          from public.customers cu
          ${deudaJoin}
         where cu.company_id = ${companyId} ${filtro}
         order by cu.legal_name, cu.id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  /**
   * El lookup del mostrador: búsqueda EXACTA por documento normalizado
   * (prefijo + alfanumérico, sin separadores, en mayúsculas) — la misma
   * expresión de la clave natural, así que va por el índice único. 404 idéntico
   * para «no existe» y «no es visible»: la consulta ya viene scoped a la
   * company, no hay canal lateral que distinga los dos casos.
   */
  app.get("/v1/customers/lookup", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const crudo = c.req.query("document")?.trim() ?? "";
    const normalizado = crudo.toUpperCase().replace(/[^A-Z0-9]/g, "");
    // Validación MÍNIMA (VALIDAR-SENIAT, OPEN_QUESTIONS 9: sin regex de
    // formato ni dígito verificador): prefijo del conjunto y el resto dígitos
    // — alfanumérico para P, que es un pasaporte.
    const valido = /^[VEJG]\d{1,17}$/.test(normalizado) || /^P[A-Z0-9]{1,17}$/.test(normalizado);
    if (!valido) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El documento se busca como prefijo (V, E, J, G o P) más el número.",
      });
    }
    const [fila] = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select ${tx.unsafe(COLUMNS_CU)} from public.customers cu
         where cu.company_id = ${companyId} and cu.tax_id is not null
           and upper(regexp_replace(cu.tax_id, '[^a-zA-Z0-9]', '', 'g')) = ${normalizado}`,
    );
    if (!fila) throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(fila, 200);
  });

  app.get("/v1/customers/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const [fila] = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select ${tx.unsafe(COLUMNS)} from public.customers where id = ${id} and company_id = ${companyId}`,
    );
    if (!fila) throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(fila, 200);
  });

  app.post("/v1/customers", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateCustomerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createCustomer(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/customers/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = UpdateCustomerRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => updateCustomer(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // El RIF: endpoint y permiso propios (M4). El trigger del esquema es la red.
  app.put("/v1/customers/:id/tax-id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = SetCustomerTaxIdRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setCustomerTaxId(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // Bloqueo: cobranzas (customer.block), no ventas.
  app.put("/v1/customers/:id/blocked", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = SetCustomerBlockedRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setCustomerBlocked(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // Catálogos fiscales de contraparte: solo lectura, vocabulario VALIDAR-TRIBUTARIO.
  app.get("/v1/taxpayer-types", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select code, name, description from public.taxpayer_types where status = 'active' order by code`,
    );
    return c.json(filas, 200);
  });
  app.get("/v1/person-types", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select code, name, description from public.person_types where status = 'active' order by code`,
    );
    return c.json(filas, 200);
  });
}
