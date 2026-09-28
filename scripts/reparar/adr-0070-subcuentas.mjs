/**
 * REPARACIÓN ADR-0070 (J-01): cada cuenta de tesorería que todavía apunta a la cuenta de su
 * familia (1.1.01 / 1.1.02) recibe su subcuenta contable, y su saldo se reclasifica con un
 * asiento por empresa, fechado el día de Caracas en que corre. Idempotente: se puede volver a
 * correr, y una empresa ya reparada no se toca. Deja acta en `audit_events`.
 *
 * Uso (desde la raíz, con `pnpm build` hecho):
 *   node scripts/reparar/adr-0070-subcuentas.mjs                 # todas las empresas, base local
 *   node scripts/reparar/adr-0070-subcuentas.mjs <company_id>    # una sola
 *   LADINO_REPAIR_DB_URL=… node scripts/reparar/adr-0070-subcuentas.mjs   # otra base (el dueño)
 *
 * Necesita el rol dueño de la base (las funciones `platform.treasury_subaccounts_repair_*` no
 * tienen GRANT a nadie). Cada empresa va en su propia transacción: si una falla, las demás
 * quedan como estaban o reparadas, nunca a medias. En producción corre DESPUÉS del git pull
 * (RESPUESTA §7); ningún agente lo corre contra el remoto.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { repairTreasurySubaccounts } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "domain", "dist", "index.js")).href
);

const url =
  process.env["LADINO_REPAIR_DB_URL"] ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const sql = createClient(url);
const soloUna = process.argv[2];

let fallos = 0;
const saltadas = new Map();
let huecos = 0;
try {
  const empresas = soloUna
    ? [{ id: soloUna }]
    : await sql`select id from public.companies order by created_at, id`;
  for (const { id } of empresas) {
    try {
      const r = await sql.begin((tx) => repairTreasurySubaccounts(tx, id));
      if (r.skipped) {
        // Una empresa saltada NO es éxito: sus cajas siguen en la cuenta de familia.
        saltadas.set(r.skipped, [...(saltadas.get(r.skipped) ?? []), id]);
        console.log(`· saltada ${id}: ${r.skipped}`);
      } else if (r.repaired > 0) {
        const { accounts, ...resumen } = r;
        console.log(JSON.stringify(resumen));
        console.log(`  ${JSON.stringify(accounts)}`);
      }
    } catch (e) {
      fallos += 1;
      console.log(`✗ ${id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  // Y el veredicto lo da el invariante, no la ausencia de errores.
  const ids = empresas.map((e) => e.id);
  const [g] = await sql`
    select count(*)::int as n from unnest(${ids}::uuid[]) as c(id)
     cross join lateral platform.treasury_ledger_gaps(c.id)`;
  huecos = g.n;
} finally {
  await sql.end();
}
const nSaltadas = [...saltadas.values()].reduce((n, l) => n + l.length, 0);
console.log(
  `treasury_ledger_gaps: ${huecos} fila(s) en ${soloUna ? "la empresa" : "todas las empresas"}`,
);
if (fallos > 0) console.log(`✗ ${fallos} empresa(s) con error`);
if (nSaltadas > 0) {
  console.log(
    `✗ ${nSaltadas} empresa(s) saltadas: ${[...saltadas].map(([razon, l]) => `${razon} (${l.length})`).join(", ")}`,
  );
}
const ok = fallos === 0 && nSaltadas === 0 && huecos === 0;
if (ok) console.log("✓ reparación ADR-0070 terminada, invariante en 0");
process.exit(ok ? 0 : 1);
