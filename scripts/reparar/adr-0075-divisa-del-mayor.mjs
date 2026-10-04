/**
 * REPARACIÓN ADR-0075 §6 (E-11, J-04): la divisa de las cajas, al mayor. Por empresa, un asiento
 * posteado por el sistema escribe en la subcuenta de cada caja EN DIVISA su saldo original (los
 * dólares que la tesorería dice que tiene), sin cambiar su saldo en bolívares, y deja un acta
 * `treasury.currency_regularized`. Ninguna línea existente se toca (append-only). Después,
 * `platform.treasury_currency_gaps` da cero.
 *
 * Idempotente: la segunda vez no encuentra nada que regularizar.
 *
 * Uso (desde la raíz, con `pnpm build` hecho):
 *   node scripts/reparar/adr-0075-divisa-del-mayor.mjs                 # todas las empresas, base local
 *   node scripts/reparar/adr-0075-divisa-del-mayor.mjs <company_id>    # una sola
 *   LADINO_REPAIR_DB_URL=… node scripts/reparar/adr-0075-divisa-del-mayor.mjs   # otra base (el dueño)
 *
 * Necesita el rol dueño de la base y las migraciones 20261003180000 y 20261003210000 aplicadas.
 * Cada empresa va en su propia transacción y sale en UNA línea: regularizada, sin nada, saltada
 * (con el motivo: el período de hoy cerrado) o con cajas sin tasa. Saltada, sin tasa o con fallo
 * = exit 1, como `adr-0075-centimo.mjs`. La cola de asientos pendiente ya no salta la empresa: el
 * invariante la cuenta (20261003210000 §4). En producción corre DESPUÉS del git pull, con la API
 * nueva ya escribiendo la divisa; ningún agente lo corre contra el remoto.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { repairTreasuryCurrency } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "domain", "dist", "index.js")).href
);

const url =
  process.env["LADINO_REPAIR_DB_URL"] ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const soloUna = process.argv.slice(2).find((a) => !a.startsWith("--"));
const sql = createClient(url);

const MOTIVO = {
  periodo_cerrado:
    "el período contable de hoy está cerrado: reábrelo o corre la reparación el mes siguiente",
  no_company: "la empresa no existe",
};

let fallos = 0;
let regularizadas = 0;
let sinNada = 0;
let saltadas = 0;
let sinTasa = 0;
try {
  const empresas = soloUna
    ? [{ id: soloUna }]
    : await sql`select id, legal_name from public.companies order by created_at, id`;
  for (const { id, legal_name: nombre } of empresas) {
    const quien = nombre ? `${id} (${nombre})` : id;
    try {
      const r = await sql.begin((tx) => repairTreasuryCurrency(tx, id));
      const cuentas = Array.isArray(r.accounts) ? r.accounts : [];
      const huerfanas = Array.isArray(r.without_rate) ? r.without_rate : [];
      // UNA LÍNEA POR EMPRESA, siempre (H5): regularizada / sin nada / saltada con motivo / sin tasa.
      if (r.skipped) {
        saltadas += 1;
        console.log(`✗ ${quien}: SALTADA, ${MOTIVO[r.skipped] ?? r.skipped}`);
      } else if (r.regularized) {
        regularizadas += 1;
        console.log(
          `✓ ${quien}: regularizada, ${cuentas.length} caja(s) en divisa · asiento ${r.entry_id}`,
        );
        console.log(`  ${JSON.stringify(cuentas)}`);
      } else if (huerfanas.length === 0) {
        sinNada += 1;
        console.log(`· ${quien}: sin nada que regularizar`);
      }
      // Una caja sin tasa (ni saldo funcional con que medirla) NO se regulariza: sigue en rojo en
      // treasury_currency_gaps. Se dice, con o sin asiento, y no es un éxito.
      if (huerfanas.length > 0) {
        sinTasa += 1;
        console.log(
          `✗ ${quien}: SIN TASA, ${huerfanas.length} caja(s) en divisa quedan sin regularizar ` +
            `(carga la tasa de hoy y repite): ` +
            huerfanas.map((h) => `«${h.account_name}»`).join(", "),
        );
      }
    } catch (e) {
      fallos += 1;
      console.log(`✗ ${quien}: FALLÓ, ${e instanceof Error ? e.message : String(e)}`);
    }
  }
} finally {
  await sql.end();
}
// Saltada y sin tasa NO son éxito: la empresa sigue con hueco. Exit ≠ 0.
const pendientes = fallos + saltadas + sinTasa;
console.log(
  `${pendientes === 0 ? "✓" : "✗"} reparación ADR-0075 (divisa del mayor): ` +
    `${regularizadas} regularizadas, ${sinNada} sin nada, ${saltadas} saltadas, ` +
    `${sinTasa} con cajas sin tasa, ${fallos} con fallo`,
);
process.exit(pendientes === 0 ? 0 : 1);
