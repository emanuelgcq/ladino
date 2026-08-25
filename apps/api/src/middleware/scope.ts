import type { Context, Next } from "hono";
import type { RequestContext } from "./context.js";

/**
 * Construye el RequestContext tras la autenticación.
 *
 * `X-Request-Id`: se honra el del cliente si viene (trazabilidad de extremo a
 * extremo); si no, se genera. Va en TODA respuesta de error.
 *
 * ⚠ `X-Company-Id` SE RECHAZA MIENTRAS NO EXISTA SU VALIDACIÓN.
 *
 * La validación real —«esta company está en el alcance del usuario»— necesita
 * una función parametrizada por usuario equivalente a `ladino_company_ids()`,
 * que hoy no existe (las `ladino_*` resuelven sobre auth.uid(), y la API entra
 * con service_role, sin claims). Escribir aquí la resolución con un join sobre
 * memberships sería LA SEGUNDA COPIA de la lógica RBAC, y dos copias divergen
 * (ADR-0027 §3-bis).
 *
 * Aceptar el header sin validar sería peor: fluiría hasta el alcance de la
 * clave de idempotencia CONTROLADO POR EL ATACANTE. Así que, hasta que la
 * función exista, el header presente falla ACTIVAMENTE (CLAUDE.md §2: si algo
 * no debe poder hacerse, tiene que fallar, no depender de que nadie lo use).
 * Ningún endpoint de S0.5 lo necesita: crear company es de nivel tenant.
 */
const REQUEST_ID_RE = /^[\w.-]{1,64}$/;

export function contextMiddleware() {
  return async (c: Context, next: Next): Promise<Response | void> => {
    if (c.req.header("X-Company-Id") !== undefined) {
      return c.json(
        {
          code: "COMPANY_SCOPE_NOT_IMPLEMENTED",
          message:
            "X-Company-Id aún no se valida contra el alcance del usuario y por eso se rechaza. " +
            "Llega con el primer endpoint de alcance company.",
        },
        422,
      );
    }

    const auth = c.get("ladino.auth");
    // `X-Request-Id` es texto del cliente que acaba en logs y en la base: se
    // acepta solo con forma acotada; si no, se genera uno. Nunca se rechaza la
    // petición por esto — es correlación, no contrato.
    const pedido = c.req.header("X-Request-Id");
    const ctx: RequestContext = {
      requestId: pedido && REQUEST_ID_RE.test(pedido) ? pedido : crypto.randomUUID(),
      actor: auth.actor,
      userId: auth.userId,
      companyId: null,
      // De nivel tenant: el tenant viene del CUERPO y lo resuelve quien lo
      // necesita (la idempotencia lo extrae del body; el caso de uso lo
      // autoriza). El contexto no adivina.
      tenantId: null,
      idempotencyKey: c.req.header("Idempotency-Key") ?? null,
    };
    c.set("ladino.ctx", ctx);
    await next();
  };
}
