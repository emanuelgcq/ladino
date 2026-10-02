/**
 * REPARACIÓN P-02 (recorrido 2026-09-24, §7.6): el documento de identidad de clientes,
 * proveedores y empresas pasa a la forma que se guarda desde A-08 — mayúsculas y sin
 * separadores (`J-40888777-6` → `J408887776`). El marcador `PEND-…` no se toca. Cada fila
 * cambiada deja su acta (`<agregado>.tax_id_normalized`, con `from` y `to`). Los snapshots de
 * los documentos emitidos NO se tocan (regla 1): el formateador compartido los enseña igual.
 *
 * Idempotente: la segunda vez no cambia nada. Si normalizar crea un duplicado dentro de una
 * empresa (o dos empresas del mismo tenant), FALLA con la lista y no cambia NADA: se fusionan a
 * mano y se vuelve a correr.
 *
 * Uso (desde la raíz):
 *   node scripts/reparar/p-02-rif-normalizado.mjs            # repara la base local
 *   node scripts/reparar/p-02-rif-normalizado.mjs --ensayo   # solo cuenta, no cambia nada
 *   LADINO_REPAIR_DB_URL=… node scripts/reparar/p-02-rif-normalizado.mjs [--ensayo]   # el dueño
 *
 * Necesita el rol dueño de la base (`platform.tax_id_normalization_repair` no tiene GRANT a
 * nadie) y la migración 20260928170000 aplicada. Todo va en UNA transacción. En producción
 * corre DESPUÉS del git pull, cuando la API nueva ya normaliza al guardar; ningún agente lo
 * corre contra el remoto.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);

const url =
  process.env["LADINO_REPAIR_DB_URL"] ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const ensayo = process.argv.includes("--ensayo");
const sql = createClient(url);

let ok = false;
try {
  const filas = await sql.begin(
    (tx) => tx`select entity, changed from platform.tax_id_normalization_repair(${ensayo})`,
  );
  for (const f of filas) {
    console.log(`${ensayo ? "· cambiaría" : "· normalizados"} ${f.entity}: ${f.changed}`);
  }
  ok = true;
} catch (e) {
  console.log(`✗ ${e instanceof Error ? e.message : String(e)}`);
} finally {
  await sql.end();
}
if (ok)
  console.log(ensayo ? "✓ ensayo P-02 terminado, nada cambió" : "✓ reparación P-02 terminada");
process.exit(ok ? 0 : 1);
