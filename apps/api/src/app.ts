import { Hono } from "hono";
import type { Sql } from "@ladino/db";
import { authMiddleware, type AuthConfig } from "./middleware/auth.js";
import { contextMiddleware } from "./middleware/scope.js";
import { onErrorResponder } from "./middleware/errors.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { companiesRoutes } from "./routes/companies.js";

export interface AppConfig {
  readonly sql: Sql;
  readonly auth: AuthConfig;
}

/**
 * Composición de la API. EL ORDEN DE LOS MIDDLEWARES ES CONTRATO (la decisión
 * D3 de S0.5 — ADR-0012 los enumeraba como lista, no como orden):
 *
 *   onError(mapeo) ⊃ auth → contexto → [idempotencia]* → handler
 *
 *   · el mapeo vive en app.onError — el único sitio donde Hono entrega las
 *     excepciones. Un handler nunca mapea sus propios errores.
 *   · auth ANTES que el contexto: el contexto se construye sobre un actor ya
 *     VERIFICADO. Un contexto pre-auth sería un contexto con datos del cliente
 *     sin comprobar.
 *   · idempotencia SOLO en rutas mutantes críticas, y DESPUÉS del contexto:
 *     necesita actor y alcance resueltos para la clave.
 *   · El middleware NUNCA toca la base para el GUC: resuelve el actor y lo
 *     deja en el contexto; `withTransaction` lo aterriza como primera
 *     sentencia de la transacción. Dos responsabilidades, dos sitios.
 *
 * `POST /v1/companies` está en la lista de operaciones con `Idempotency-Key`
 * OBLIGATORIA — la lista de ADR-0018 ampliada por decisión de S0.5: una
 * plantilla que no ejercita idempotencia no sirve de plantilla.
 */
export function buildApp(cfg: AppConfig): Hono {
  const app = new Hono();

  // onError y no un middleware: en Hono, next() NO propaga excepciones — un
  // try/catch alrededor de next() nunca las ve. Ver middleware/errors.ts.
  app.onError(onErrorResponder);
  app.use("/v1/*", authMiddleware(cfg.auth));
  app.use("/v1/*", contextMiddleware());
  app.use("/v1/companies", idempotencyMiddleware({ sql: cfg.sql }));

  // Registradas SOBRE esta app, nunca con app.route(): una sub-app gestiona
  // sus errores con su propio onError y se saltaría el errorMapper de arriba.
  // El porqué completo está en routes/companies.ts.
  companiesRoutes(app, cfg.sql);

  return app;
}
