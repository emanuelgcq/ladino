/**
 * REPARACIÓN J-02 (recorrido 2026-09-24): los cierres de una caja en SOBREGIRO que ya se
 * asentaron como ingreso. Por cada uno, la reversa del asiento viejo (D caja / H «Faltantes y
 * sobrantes de caja») y el asiento nuevo, con el origen `cash_closing_overdraft` (D caja / H «Cuentas por pagar a socios (aportes del
 * dueño)», y lo contado por encima de cero a sobrantes), con un acta
 * `treasury.overdraft_closing_reclassified`. Ningún asiento posteado se edita (regla 2) y el
 * saldo de la caja no cambia: cambia la contrapartida, de resultado a pasivo.
 *
 * Los dos asientos van al día del cierre si su período sigue abierto; si está cerrado, a hoy.
 *
 * También trata el cierre en sobregiro que la API anterior dejó EN LA COLA: descarta esa fila con
 * su acta y genera el hecho con el origen del sobregiro (asentado, o encolado otra vez si a la
 * empresa le falta una cuenta). Al terminar cada empresa comprueba que
 * `platform.overdraft_closing_gaps` da cero.
 *
 * Idempotente: la segunda vez no encuentra nada que reclasificar.
 *
 * Uso (desde la raíz, con `pnpm build` hecho):
 *   node scripts/reparar/j-02-sobregiro-al-cierre.mjs                 # todas las empresas, base local
 *   node scripts/reparar/j-02-sobregiro-al-cierre.mjs <company_id>    # una sola
 *   LADINO_REPAIR_DB_URL=… node scripts/reparar/j-02-sobregiro-al-cierre.mjs   # otra base (el dueño)
 *
 * Necesita el rol dueño de la base y las migraciones 20261004180000 a 20261004180300 aplicadas. Cada empresa va en su
 * propia transacción y sale en UNA línea: reclasificada, sin nada, o con fallo (la empresa sin la
 * cuenta del papel `owner_payable`, o con el período de hoy cerrado: se deshace entera). Con
 * fallo = exit 1. En producción corre DESPUÉS del git pull y es LA ÚLTIMA de las reparaciones
 * (paso 8 de R-71: después del céntimo, las subcuentas y la divisa); ningún agente lo corre
 * contra el remoto.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { repairOverdraftClosings } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "domain", "dist", "index.js")).href
);

const url =
  process.env["LADINO_REPAIR_DB_URL"] ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const soloUna = process.argv.slice(2).find((a) => !a.startsWith("--"));
const sql = createClient(url);

let fallos = 0;
let reclasificadas = 0;
let sinNada = 0;
try {
  const empresas = soloUna
    ? [{ id: soloUna }]
    : await sql`select id, legal_name from public.companies order by created_at, id`;
  for (const { id, legal_name: nombre } of empresas) {
    const quien = nombre ? `${id} (${nombre})` : id;
    try {
      const r = await sql.begin((tx) => repairOverdraftClosings(tx, id));
      if (r.reclassified.length === 0 && r.requeued.length === 0) {
        sinNada += 1;
        console.log(`· ${quien}: sin cierres en sobregiro que reclasificar`);
      } else {
        reclasificadas += 1;
        console.log(
          `✓ ${quien}: ${r.reclassified.length} cierre(s) reclasificado(s), ` +
            `${r.requeued.length} sacado(s) de la cola`,
        );
        if (r.reclassified.length > 0) console.log(`  ${JSON.stringify(r.reclassified)}`);
        if (r.requeued.length > 0) console.log(`  cola: ${JSON.stringify(r.requeued)}`);
      }
    } catch (e) {
      fallos += 1;
      console.log(`✗ ${quien}: FALLÓ, ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} finally {
  await sql.end();
}
console.log(
  `${fallos === 0 ? "✓" : "✗"} reparación J-02 (sobregiro al cierre): ` +
    `${reclasificadas} reclasificadas, ${sinNada} sin nada, ${fallos} con fallo`,
);
process.exit(fallos === 0 ? 0 : 1);
