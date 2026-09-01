/**
 * `pnpm demo:seed` — deja el entorno local con la empresa de demostración
 * lista para entrar por la webapp. Tres pasos, en orden:
 *
 *   1. crea el usuario demo en el Auth local (GoTrue) si no existe;
 *   2. aplica seed-demo.sql (tenant, empresa, RBAC, catálogo, existencias)
 *      vía psql dentro del contenedor de la base local;
 *   3. lanza seed-demo.mjs, que crea rangos, tasas, plan contable y los
 *      documentos POR LA API — la misma vía que usa la webapp.
 *
 * Requiere: `pnpm db:start` hecho y la API corriendo en :3000 (ver el bloque
 * «entorno de demo local» de docs/00_GOVERNANCE/HANDOFF.md). Idempotente: si
 * ya hay documentos, el paso 3 se retira solo.
 *
 * ⚠ `pnpm verify` BORRA la demo: su paso 10 es `db:reset`, y es lo correcto —
 * el gate reconstruye la base desde cero. Relanzar esto la repone.
 *
 * SOLO entorno local. Las claves de abajo son las públicas del stack demo de
 * la CLI de Supabase — no hay ningún secreto aquí.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AQUI = dirname(fileURLToPath(import.meta.url));
const SUPA = "http://127.0.0.1:54321";
const ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const EMAIL = "demo@ladino.dev";
const PASS = "LadinoDemo2026!";

// 1. Usuario en el Auth local. Si ya existe, GoTrue responde 400/422 y no pasa
//    nada: el login del paso 3 es quien confirma que las credenciales valen.
const signup = await fetch(`${SUPA}/auth/v1/signup`, {
  method: "POST",
  headers: { "Content-Type": "application/json", apikey: ANON },
  body: JSON.stringify({ email: EMAIL, password: PASS }),
}).catch(() => null);
if (signup === null) {
  console.error("!! el Auth local no responde — ¿está el stack levantado (pnpm db:start)?");
  process.exit(1);
}
console.log(`== usuario demo: signup ${signup.status}`);

// 2. El SQL, dentro del contenedor de la base local.
const sql = spawnSync(
  "docker",
  [
    "exec",
    "-i",
    "supabase_db_ladino",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
  ],
  {
    input: readFileSync(join(AQUI, "seed-demo.sql"), "utf8"),
    stdio: ["pipe", "inherit", "inherit"],
    encoding: "utf8",
  },
);
if (sql.status !== 0) {
  console.error("!! el SQL de la semilla falló — ¿está el stack local levantado (pnpm db:start)?");
  process.exit(1);
}

// 3. Los documentos, por la API.
const http = spawnSync(process.execPath, [join(AQUI, "seed-demo.mjs")], { stdio: "inherit" });
process.exit(http.status ?? 1);
