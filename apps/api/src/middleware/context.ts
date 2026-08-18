import type { Actor } from "@ladino/db";

/**
 * Lo que el middleware resuelve y deja disponible para el handler.
 *
 * NO estaba tipado en ninguna parte: solo aparecía como pseudocódigo en la
 * skill `caso-de-uso`. Los campos son la unión de lo que nombran
 * `API_SPEC.md` §Headers (`X-Request-Id`, `X-Company-Id`, `Idempotency-Key`) y
 * ADR-0017 §logs (`request_id`, `tenant_id`, `company_id`, `user_id`,
 * `use_case`, `duration`, `result`).
 *
 * `actor` es lo único que viaja hasta la base, y lo aterriza `withTransaction`
 * como `set local ladino.actor_id`. El middleware NO abre transacción y NO
 * fija el GUC: `set local` tiene alcance de transacción, así que fijarlo aquí
 * sería inútil o —con `set` de sesión sobre un pool— peligroso.
 */
export interface RequestContext {
  readonly requestId: string;
  readonly actor: Actor;
  /** Del JWT verificado. `null` en el camino de sistema. */
  readonly userId: string | null;
  /** De `X-Company-Id`, ya validada contra el alcance del usuario. */
  readonly companyId: string | null;
  readonly tenantId: string | null;
  readonly idempotencyKey: string | null;
}

/** Claves del contexto de Hono, para no escribir strings sueltos. */
export const CTX = "ladino.ctx" as const;

declare module "hono" {
  interface ContextVariableMap {
    [CTX]: RequestContext;
  }
}
