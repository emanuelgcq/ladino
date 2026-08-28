import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { Sql } from "@ladino/db";
import { authMiddleware, type AuthConfig } from "./middleware/auth.js";
import { contextMiddleware } from "./middleware/scope.js";
import { onErrorResponder } from "./middleware/errors.js";
import { idempotencyMiddleware } from "./middleware/idempotency.js";
import { rateLimitMiddleware } from "./middleware/rate-limit.js";
import { timeoutMiddleware } from "./middleware/timeout.js";
import { companiesRoutes } from "./routes/companies.js";
import { productsRoutes } from "./routes/products.js";
import { pricingRoutes, catalogRoutes } from "./routes/pricing.js";
import { customersRoutes } from "./routes/customers.js";
import { inventoryRoutes, inventoryExtensionsRoutes } from "./routes/inventory.js";
import { salesRoutes } from "./routes/sales.js";
import { accountingRoutes } from "./routes/accounting.js";
import { purchasesRoutes } from "./routes/purchases.js";

export interface AppConfig {
  readonly sql: Sql;
  readonly auth: AuthConfig;
  /** Por defecto 300; los tests bajan la cifra para ejercer el 429. */
  readonly rateLimitPorMinuto?: number;
  /** Por defecto 30 s. Ver middleware/timeout.ts para el invariante con el reaper. */
  readonly requestTimeoutMs?: number;
  /** Plazo de la sonda de readiness. Por defecto 2 s. */
  readonly readyTimeoutMs?: number;
  /** Origen permitido para CORS. Por defecto, el dev server de Vite local. */
  readonly corsOrigin?: string;
}

/**
 * Composición de la API. EL ORDEN DE LOS MIDDLEWARES ES CONTRATO (la decisión
 * D3 de S0.5 — ADR-0012 los enumeraba como lista, no como orden):
 *
 *   onError(mapeo) ⊃ bodyLimit → timeout → auth → rateLimit → contexto → [idempotencia]* → handler
 *
 *   · el mapeo vive en app.onError — el único sitio donde Hono entrega las
 *     excepciones. Un handler nunca mapea sus propios errores.
 *   · timeout envuelve a todo lo de /v1: es el tope que hace seguro al reaper
 *     de idempotencia (middleware/timeout.ts).
 *   · auth ANTES que el contexto: el contexto se construye sobre un actor ya
 *     VERIFICADO. Un contexto pre-auth sería un contexto con datos del cliente
 *     sin comprobar.
 *   · rateLimit justo DESPUÉS de auth: necesita el usuario y debe cortar antes
 *     de que nada abra transacción.
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
  // Cota de cuerpo ANTES de auth: la idempotencia lee el cuerpo entero a
  // memoria para hashearlo, y sin cota cualquiera fuerza reserva de memoria
  // arbitraria. 1 MB sobra para todo contrato de S0.5; los ficheros no van
  // por aquí. Observación del auditor de S0.5, fuera de su ámbito pero real.
  app.use("*", bodyLimit({ maxSize: 1024 * 1024 }));
  // CORS con UN origen explícito, nunca "*": la webapp manda Authorization y
  // headers propios, y el navegador exige el preflight. En producción es el
  // dominio de la webapp (CORS_ORIGIN); en local, el dev server de Vite.
  app.use(
    "*",
    cors({
      origin: cfg.corsOrigin ?? "http://127.0.0.1:5174",
      allowHeaders: [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "X-Company-Id",
        "X-Request-Id",
      ],
      allowMethods: ["GET", "POST", "OPTIONS"],
      maxAge: 600,
    }),
  );

  // Sondas para el orquestador, FUERA de /v1 y sin auth. Liveness no toca la
  // base (un pool agotado no debe hacer que Docker mate el proceso y empeore
  // el pool); readiness sí, porque «listo» significa «puedo servir».
  //
  // Las dos sondas NO se publican en Traefik (el router las excluye): las lee
  // el healthcheck del contenedor, desde dentro. Y readiness tiene PLAZO: una
  // sonda que puede colgarse no es una sonda — el orquestador leería
  // «timeout», no «not ready». La respuesta no dice qué falló: eso va al log.
  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", async (c) => {
    const plazoMs = cfg.readyTimeoutMs ?? 2000;
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        cfg.sql`select 1`,
        new Promise((_, reject) => {
          temporizador = setTimeout(
            () => reject(new Error(`readyz: sin respuesta en ${plazoMs} ms`)),
            plazoMs,
          );
        }),
      ]);
      return c.json({ ok: true });
    } catch (e) {
      console.error(
        JSON.stringify({
          nivel: "error",
          evento: "api.not_ready",
          error: String((e as Error).message ?? e),
        }),
      );
      return c.json({ ok: false }, 503);
    } finally {
      clearTimeout(temporizador);
    }
  });

  app.use("/v1/*", timeoutMiddleware(cfg.requestTimeoutMs ?? 30_000));
  app.use("/v1/*", authMiddleware(cfg.auth));
  app.use("/v1/*", rateLimitMiddleware({ porMinuto: cfg.rateLimitPorMinuto ?? 300 }));
  app.use("/v1/*", contextMiddleware(cfg.sql));

  // La idempotencia se pasa a cada ruta crítica y se monta POR MÉTODO (H-6),
  // no con app.use por path: así un método sin handler no reserva claves.
  const idempotencia = idempotencyMiddleware({ sql: cfg.sql });

  // Registradas SOBRE esta app, nunca con app.route(): una sub-app gestiona
  // sus errores con su propio onError y se saltaría el errorMapper de arriba.
  // El porqué completo está en routes/companies.ts.
  companiesRoutes(app, cfg.sql, idempotencia);
  productsRoutes(app, cfg.sql, idempotencia);
  pricingRoutes(app, cfg.sql, idempotencia);
  catalogRoutes(app, cfg.sql);
  customersRoutes(app, cfg.sql, idempotencia);
  inventoryRoutes(app, cfg.sql, idempotencia);
  salesRoutes(app, cfg.sql, idempotencia);
  accountingRoutes(app, cfg.sql, idempotencia);
  purchasesRoutes(app, cfg.sql, idempotencia);
  inventoryExtensionsRoutes(app, cfg.sql, idempotencia);

  return app;
}
