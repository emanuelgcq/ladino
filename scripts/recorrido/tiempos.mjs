/**
 * TIEMPO (dimensión 12) de un bloque: las peticiones a la API más lentas, sacadas del campo `api`
 * de la evidencia (ms reales de cada petición, sin las esperas del guion).
 *   node scripts/recorrido/tiempos.mjs <BLOQUE> [n=10]
 */
import fs from "node:fs";
import path from "node:path";

const [bloque, nStr] = process.argv.slice(2);
const n = Number(nStr ?? 10);
const dir = path.join(".recorrido", process.env.RECORRIDO_FECHA ?? "2026-09-24", bloque ?? "");
if (!bloque || !fs.existsSync(dir)) {
  console.error(`uso: node scripts/recorrido/tiempos.mjs <BLOQUE>  (no existe ${dir})`);
  process.exit(2);
}
const filas = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json") && /^\d{3}-/.test(x))) {
  let r;
  try {
    r = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
  } catch {
    continue;
  }
  for (const a of r.api ?? [])
    filas.push({ ms: a.ms, peticion: `${a.m} ${a.ruta}`, paso: f.replace(/\.json$/, "") });
}
filas.sort((a, b) => b.ms - a.ms);
const lentas = filas.filter((f) => f.ms > 3000);
console.log(
  `Bloque ${bloque}: ${filas.length} peticiones medidas · ${lentas.length} por encima de 3 s`,
);
for (const f of filas.slice(0, n))
  console.log(`${String(f.ms).padStart(6)} ms  ${f.peticion}  (${f.paso})`);
