import type { Context, Next } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { type RequestContext, CTX } from "./context.js";

const REQUEST_ID_RE = /^[\w.-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Construye el RequestContext sobre un actor YA verificado (va después de
 * auth, y ese orden es contrato — app.ts).
 *
 * `X-Company-Id` SE VALIDA AQUÍ contra `platform.ladino_user_company_ids()`
 * (migración 15) — la misma copia del JOIN de visibilidad que usan las
 * policies del camino authenticated, parametrizada por el actor del GUC. Hasta
 * S0.6a el header se rechazaba activamente (`COMPANY_SCOPE_NOT_IMPLEMENTED`):
 * la validación exigía esa función y no existía. Escribir el JOIN a mano aquí
 * habría sido la segunda copia de la resolución RBAC (ADR-0027 §3-bis), y la
 * primera copia parcial ya tuvo una escalada por un filtro omitido.
 *
 * Cuesta UNA consulta por petición con header — es el precio de que el alcance
 * sea dato del servidor y no un claim del cliente (ADR-0014). El detector de
 * coste de pgTAP 015 vigila esa consulta sobre 20.000 filas.
 *
 * Una company que existe pero NO es visible responde 404, no 403: responder
 * distinto confirmaría su existencia (la regla de ERROR_CATALOG.md §404/403).
 * El middleware NO fija el GUC: lo aterriza `withTransaction` como primera
 * sentencia de su transacción, aquí y en todas partes.
 */
export function contextMiddleware(sql: Sql) {
  return async (c: Context, next: Next): Promise<Response | void> => {
    const auth = c.get("ladino.auth");
    // `X-Request-Id` es texto del cliente que acaba en logs y en la base: se
    // acepta solo con forma acotada; si no, se genera uno. Nunca se rechaza la
    // petición por esto — es correlación, no contrato.
    const pedido = c.req.header("X-Request-Id");
    const requestId = pedido && REQUEST_ID_RE.test(pedido) ? pedido : crypto.randomUUID();

    let companyId: string | null = null;
    let tenantId: string | null = null;

    const header = c.req.header("X-Company-Id");
    if (header !== undefined) {
      // Forma UUID antes de tocar la base (la lección H-5: un valor malformado
      // no puede convertirse en un 500 disparable por cualquier autenticado).
      if (!UUID_RE.test(header)) {
        return c.json(
          {
            code: "VALIDATION_FAILED",
            message: "X-Company-Id no tiene forma de UUID.",
            request_id: requestId,
          },
          422,
        );
      }
      const [fila] = await withTransaction(
        sql,
        auth.actor,
        ({ sql: tx }) =>
          tx<{ tenant_id: string }[]>`
          select c.tenant_id
            from public.companies c
           where c.id = ${header}
             and c.id in (select platform.ladino_user_company_ids(${auth.userId}))`,
      );
      if (!fila) {
        // Inexistente, de otro tenant, o del tenant pero sin asignación que la
        // alcance: LOS TRES indistinguibles, cuerpo incluido.
        return c.json(
          { code: "NOT_FOUND", message: "Recurso no encontrado.", request_id: requestId },
          404,
        );
      }
      companyId = header;
      tenantId = fila.tenant_id;
    }

    const ctx: RequestContext = {
      requestId,
      actor: auth.actor,
      userId: auth.userId,
      companyId,
      // Con header: el tenant REAL de la company validada. Sin header: null —
      // el tenant viene del cuerpo y lo resuelve quien lo necesita (la
      // idempotencia lo extrae del body; el caso de uso lo autoriza). El
      // contexto no adivina.
      tenantId,
      idempotencyKey: c.req.header("Idempotency-Key") ?? null,
    };
    c.set(CTX, ctx);
    await next();
  };
}
