import { serve } from "@hono/node-server";
import { createClient } from "@ladino/db";
import { buildApp } from "./app.js";
import { ConfigError, configServidor } from "./config.js";

/**
 * Punto de entrada del contenedor `ladino-api`. Toda la configuración entra
 * por variables de entorno del host (nunca en la imagen ni en git), y lo que
 * falta o es inválido hace fallar el arranque: un proceso que arranca a
 * medias es peor que uno que no arranca. Las reglas viven en config.ts, puro
 * y probado.
 */
function log(nivel: "info" | "error", evento: string, extra: Record<string, unknown> = {}) {
  const linea = JSON.stringify({ nivel, evento, ...extra });
  if (nivel === "error") console.error(linea);
  else console.log(linea);
}

let cfg;
try {
  cfg = configServidor(process.env);
} catch (e) {
  if (e instanceof ConfigError) {
    log("error", "api.config_invalid", { error: e.message });
    process.exit(1);
  }
  throw e;
}

const sql = createClient(cfg.databaseUrl);
const app = buildApp({
  sql,
  auth: cfg.auth,
  rateLimitPorMinuto: cfg.rateLimitPorMinuto,
  requestTimeoutMs: cfg.requestTimeoutMs,
});

const server = serve({ fetch: app.fetch, port: cfg.port, hostname: "0.0.0.0" }, () => {
  log("info", "api.listening", { port: cfg.port });
});

// Un rechazo sin manejar o una excepción fuera de Hono NO se ignoran: se
// registran y el proceso sale, para que `restart: unless-stopped` actúe. Un
// proceso vivo en estado desconocido es el peor de los modos de fallo.
process.on("unhandledRejection", (razon) => {
  log("error", "api.unhandled_rejection", { error: String(razon) });
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  log("error", "api.uncaught_exception", { error: String(e) });
  process.exit(1);
});

// Apagado ordenado: Docker manda SIGTERM y espera `stop_grace_period` (20 s en
// el compose). Cerrar el listener deja terminar las peticiones en vuelo y
// devolver las conexiones al pool antes de salir. Y con PLAZO: si una
// petición no termina, se sale igual a los 8 s, antes de que Docker mande
// SIGKILL — un SIGKILL corta transacciones a medias; un exit(1) tras 8 s con
// el log escrito, no.
let cerrando = false;
for (const señal of ["SIGTERM", "SIGINT"] as const) {
  process.on(señal, () => {
    if (cerrando) return; // una segunda señal no dispara un segundo cierre
    cerrando = true;
    log("info", "api.shutdown", { señal });
    const respaldo = setTimeout(() => {
      log("error", "api.shutdown_timeout", { ms: 8000 });
      process.exit(1);
    }, 8000);
    respaldo.unref();
    server.close(() => {
      void sql
        .end({ timeout: 5 })
        .catch((e: unknown) => log("error", "api.pool_close_failed", { error: String(e) }))
        .finally(() => process.exit(0));
    });
  });
}
