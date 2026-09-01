import { writeFileSync } from "node:fs";
import { assertServiceRole, createClient } from "@ladino/db";
import { NullTransmitter } from "@ladino/fiscal";
import { crearBucle } from "./loop.js";
import { procesarLote } from "./outbox.js";
import { purgarIdempotencia, reaperIdempotencia, reaperOutbox } from "./reapers.js";

/**
 * Punto de entrada del contenedor `ladino-worker`. Un bucle, cuatro tareas:
 * consumir el outbox, los dos reapers y la purga. Sin HTTP: el healthcheck de
 * Docker lee un fichero de latido que cada vuelta SANA del bucle refresca.
 *
 * El transmisor montado es `NullTransmitter` — la implementación correcta del
 * estado regulatorio actual (ADR-0028). Cambiarlo es cambiar UNA línea aquí,
 * no tocar el dominio ni el consumo: el test del worker lo demuestra con un
 * transmisor falso.
 *
 * MODO DE FALLO RUIDOSO (F-11 de la auditoría de S0.6a). Docker NO reinicia
 * un contenedor `unhealthy`: la política `restart` reacciona a la SALIDA del
 * proceso, no a su salud. Un healthcheck sin actuador es un detector que
 * parece proteger y no protege (CLAUDE.md §2). Por eso el worker se mata a sí
 * mismo tras N ciclos fallidos consecutivos o un ciclo que no termina en su
 * plazo, y deja que `restart: unless-stopped` haga su trabajo. El healthcheck
 * queda como segunda señal, para el panel, no como única defensa.
 */
function log(nivel: "info" | "error", evento: string, extra: Record<string, unknown> = {}) {
  const linea = JSON.stringify({ nivel, evento, ...extra });
  if (nivel === "error") console.error(linea);
  else console.log(linea);
}

const url = process.env["DATABASE_URL"];
if (!url) {
  log("error", "worker.config_invalid", { error: "falta DATABASE_URL" });
  process.exit(1);
}
const sql = createClient(url);
const transmitter = new NullTransmitter((linea) => console.log(linea));
const intervaloMs = Number(process.env["WORKER_INTERVAL_MS"] ?? 2000);
const latido = process.env["WORKER_HEARTBEAT_FILE"] ?? "/tmp/ladino-worker.heartbeat";
const MAX_FALLOS_SEGUIDOS = 5;
// Plazo de un ciclo entero: la entrega tiene 5 min por fila y el lote es de
// 50, pero un ciclo que supera esto está colgado, no ocupado.
const PLAZO_CICLO_MS = 10 * 60_000;

let vuelta = 0;

async function ciclo(): Promise<void> {
  vuelta += 1;
  // Los reapers y la purga cada 30 vueltas (~1 min con el intervalo por
  // defecto), y ANTES del lote: si el lote revienta, el mantenimiento ya se
  // hizo y no se pierde la ventana hasta la vuelta 60.
  const mantenimiento =
    vuelta % 30 === 0
      ? {
          outbox: await reaperOutbox(sql),
          idem: await reaperIdempotencia(sql),
          purga: await purgarIdempotencia(sql),
        }
      : null;
  const out = await procesarLote(sql, transmitter);
  if (out.publicados || out.reintentos || out.muertos || out.reservasPerdidas || mantenimiento) {
    log("info", "worker.ciclo", { vuelta, out, mantenimiento });
  }
}

/**
 * La MÁQUINA del bucle vive en loop.ts con sus dependencias inyectadas y sus
 * tests (R-10 cerrado): latido solo tras vuelta sana, suicidio ruidoso al 5.º
 * fallo seguido, plazo por ciclo. Aquí queda solo el CABLEADO real.
 */
const maquina = crearBucle({
  ciclo,
  latir: () => writeFileSync(latido, String(Date.now())),
  log,
  salir: (codigo) => process.exit(codigo),
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
  intervaloMs,
  plazoCicloMs: PLAZO_CICLO_MS,
  maxFallosSeguidos: MAX_FALLOS_SEGUIDOS,
});

let parando = false;

async function bucle(): Promise<void> {
  // ADR-0031: con un rol SUPERUSER/BYPASSRLS no se arranca. Ruidoso, no un aviso.
  try {
    await assertServiceRole(sql);
  } catch (e) {
    log("error", "worker.privileged_role_refused", { error: String((e as Error).message ?? e) });
    process.exit(1);
  }
  log("info", "worker.start", { intervaloMs, maxFallosSeguidos: MAX_FALLOS_SEGUIDOS });
  await maquina.run();
  await sql.end({ timeout: 5 });
  log("info", "worker.stopped");
}

process.on("unhandledRejection", (razon) => {
  log("error", "worker.unhandled_rejection", { error: String(razon) });
  process.exit(1);
});
process.on("uncaughtException", (e) => {
  log("error", "worker.uncaught_exception", { error: String(e) });
  process.exit(1);
});

for (const señal of ["SIGTERM", "SIGINT"] as const) {
  process.on(señal, () => {
    if (parando) return;
    parando = true;
    maquina.parar();
    log("info", "worker.shutdown", { señal });
    // Respaldo: si el ciclo en curso no termina, salir antes del SIGKILL.
    setTimeout(() => {
      log("error", "worker.shutdown_timeout", { ms: 15000 });
      process.exit(1);
    }, 15000).unref();
  });
}

bucle().catch((e: unknown) => {
  log("error", "worker.loop_crashed", { error: String(e) });
  process.exit(1);
});
