import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { CreateCompanyRequest } from "@ladino/schemas";
import { createCompany } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";

/**
 * PLANTILLA DE HANDLER. Esto es TODO lo que un handler hace (API_SPEC.md §La
 * capa es delgada): validar la forma con Zod, abrir la transacción por el
 * helper, delegar al caso de uso, y devolver el éxito. Los errores NO se
 * mapean aquí: se LANZAN, y el errorMapper —el middleware de cierre— los
 * convierte al contrato. Un handler que mapea sus propios errores es un
 * handler que diverge del contrato en el tercer módulo.
 *
 * Las rutas se registran SOBRE la app principal, no como sub-app montada con
 * `app.route()`. No es estilo: una sub-app de Hono gestiona sus errores con su
 * PROPIO onError, así que una excepción lanzada aquí dentro moriría en el 500
 * por defecto de la sub-app SIN pasar por el errorMapper del padre — todos los
 * caminos de error devolvían «Internal Server Error» con el mapeo intacto y
 * sin usar. Lo encontró el test E2E; quien copie esta plantilla, que copie
 * también esta forma.
 *
 * Lo que NO hay aquí, y quien copie no debe añadir: reglas de negocio
 * (packages/domain), transacciones a mano (withTransaction es el único
 * camino), GUC (lo fija el helper), idempotencia (T1/T2 del middleware,
 * montado en app.ts).
 */
export function companiesRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // Lectura: las companies VISIBLES para el actor — la misma función de la
  // migración 15 que usa el middleware de scope, así que lo que este endpoint
  // lista y lo que X-Company-Id acepta no pueden divergir. Sin idempotencia
  // (es GET) y sin reglas de negocio: un select con la visibilidad como
  // predicado y la RLS de ladino_api como segunda capa.
  app.get("/v1/companies", async (c) => {
    const { actor, userId } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select id, tenant_id, legal_name, trade_name, tax_id, status,
               to_char(created_at at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
          from public.companies
         where id in (select platform.ladino_user_company_ids(${userId}))
         order by legal_name, id`,
    );
    return c.json(filas, 200);
  });

  // La idempotencia se monta POR RUTA Y MÉTODO, no por path con app.use (H-6):
  // montada por path, un `DELETE /v1/companies` sin handler atravesaba T1,
  // reservaba la clave, recibía el 404 de Hono y T2 la marcaba failed —
  // escritura en la tabla por un método que no existe.
  app.post("/v1/companies", idempotencia, async (c) => {
    // Validar la FORMA. Los invariantes de negocio (tenant activo, RIF
    // duplicado) son del caso de uso: Zod no puede saberlos.
    const parsed = CreateCompanyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      throw new ValidacionError(parsed.error.issues);
    }

    const { actor } = c.get("ladino.auth");
    const resultado = await withTransaction(sql, actor, (uow) => createCompany(uow, parsed.data));

    if (!resultado.ok) throw new DominioError(resultado.error);
    return c.json(resultado.value, 201);
  });
}
