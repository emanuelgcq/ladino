import type { Hono } from "hono";
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
export function companiesRoutes(app: Hono, sql: Sql): void {
  app.post("/v1/companies", async (c) => {
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
