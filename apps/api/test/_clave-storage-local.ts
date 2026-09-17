import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/**
 * La clave SECRETA del stack local de Supabase (formato nuevo, `sb_secret_…`), leída al correr la
 * prueba con `supabase status`. No se escribe en el repo: aunque la de la CLI es pública y la
 * misma en toda instalación, el push protection de GitHub la trata como secreto (2026-09-17) —
 * y no tiene forma de distinguirla de una real, así que tiene razón.
 *
 * `SUPABASE_LOCAL_SECRET_KEY` la da sin lanzar la CLI (CI). Si no hay stack, la prueba FALLA con
 * el motivo: una prueba que se salta sola se leería como verde.
 */
export function claveSecretaLocal(): string {
  const deEntorno = process.env["SUPABASE_LOCAL_SECRET_KEY"];
  if (deEntorno) return deEntorno;
  const raiz = fileURLToPath(new URL("../../../", import.meta.url));
  const r = spawnSync("npx", ["supabase", "status", "-o", "json"], {
    cwd: raiz,
    shell: true,
    encoding: "utf8",
    timeout: 60_000,
  });
  const salida = r.stdout ?? "";
  const inicio = salida.indexOf("{");
  if (inicio < 0) {
    throw new Error("No se pudo leer `supabase status`: ¿está levantado el stack local?");
  }
  const clave = (JSON.parse(salida.slice(inicio)) as { SECRET_KEY?: string }).SECRET_KEY;
  if (clave === undefined || !clave.startsWith("sb_secret_")) {
    throw new Error("El stack local no expone una SECRET_KEY de formato sb_secret_.");
  }
  return clave;
}
