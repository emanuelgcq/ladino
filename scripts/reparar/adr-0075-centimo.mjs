/**
 * REPARACIÓN ADR-0075 §7 (P-01, P-03, K-08): la regularización del céntimo al corte. Por empresa,
 * lleva a «Diferencias por redondeo» la fracción de céntimo que arrastran el kardex (una
 * revalorización de cantidad 0 por posición) y el mayor (una línea por cuenta), con un asiento
 * posteado por el sistema y un acta `accounting.cent_regularized`. Ningún movimiento ni asiento
 * existente se toca (append-only). Deja `inventory_ledger_gap` donde estaba, en cero.
 *
 * Idempotente: la segunda vez no encuentra nada que regularizar.
 *
 * Imprime UNA línea por empresa, siempre: regularizada (con su asiento o con su fila de la cola
 * si no lleva contabilidad), sin nada que regularizar, o FALLÓ con su motivo. Ninguna se salta en
 * silencio. Lista además las posiciones vacías que quedan con valor (diferencia de costo, no
 * redondeo: ADR-0034). Sale con código ≠ 0 si alguna empresa falla.
 *
 * Uso (desde la raíz, con `pnpm build` hecho):
 *   node scripts/reparar/adr-0075-centimo.mjs                 # todas las empresas, base local
 *   node scripts/reparar/adr-0075-centimo.mjs <company_id>    # una sola
 *   node scripts/reparar/adr-0075-centimo.mjs --ensayo        # solo cuenta, no cambia nada
 *   LADINO_REPAIR_DB_URL=… node scripts/reparar/adr-0075-centimo.mjs   # otra base (el dueño)
 *
 * Necesita el rol dueño de la base (`platform.cent_regularization_*` no tienen GRANT a nadie) y la
 * migración 20261003190000 aplicada (y las 140000-140200). Cada empresa va en su propia transacción. En producción
 * corre DESPUÉS del git pull, con la API nueva ya escribiendo al céntimo; ningún agente lo corre
 * contra el remoto.
 */
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const desdeApi = createRequire(path.join(RAIZ, "apps", "api", "package.json"));
const { createClient } = await import(pathToFileURL(desdeApi.resolve("@ladino/db")).href);
const { repairCents } = await import(
  pathToFileURL(path.join(RAIZ, "packages", "domain", "dist", "index.js")).href
);

const url =
  process.env["LADINO_REPAIR_DB_URL"] ?? "postgres://postgres:postgres@127.0.0.1:54322/postgres";
const ensayo = process.argv.includes("--ensayo");
const soloUna = process.argv.slice(2).find((a) => !a.startsWith("--"));
const sql = createClient(url);

let fallos = 0;
let regularizadas = 0;
let regularizarian = 0;
let sinNada = 0;
try {
  const empresas = soloUna
    ? [{ id: soloUna }]
    : await sql`select id, legal_name from public.companies order by created_at, id`;
  for (const { id, legal_name: nombre } of empresas) {
    const quien = nombre ? `${id} (${nombre})` : id;
    try {
      const r = await sql.begin((tx) => repairCents(tx, id, ensayo));
      const { kardex, ledger, visible_empty_positions: visibles, ...resumen } = r;
      const nK = Array.isArray(kardex) ? kardex.length : 0;
      const nL = Array.isArray(ledger) ? ledger.length : 0;
      if (r.dry_run && r.period_closed) {
        // El ensayo no postea, así que LAD61 no saltaría: lo dice aquí, como fallo.
        fallos += 1;
        console.log(
          `✗ ${quien}: ENSAYO, FALLARÍA: el período de hoy está CERRADO y la regularización no asienta en un período cerrado (LAD61). Reábrelo o corre al abrir el siguiente.`,
        );
      } else if (r.dry_run) {
        regularizarian += 1;
        console.log(
          `~ ${quien}: ENSAYO, regularizaría ${nK} posiciones y ${nL} cuentas` +
            (r.would_queue ? " (sin asiento: dejaría una fila de cola descartada con acta)" : ""),
        );
        console.log(`  kardex ${JSON.stringify(kardex)} · mayor ${JSON.stringify(ledger)}`);
      } else if (r.regularized) {
        regularizadas += 1;
        const donde = r.entry_id
          ? `asiento ${r.entry_id}` + (r.queue_id ? ` y cola ${r.queue_id}` : "")
          : `SIN ASIENTO: kardex regularizado; fila de cola descartada con acta (${r.queue_id})`;
        console.log(`✓ ${quien}: regularizada, ${nK} posiciones y ${nL} cuentas · ${donde}`);
        console.log(`  ${JSON.stringify(resumen)}`);
      } else {
        sinNada += 1;
        console.log(`· ${quien}: sin nada que regularizar`);
      }
      for (const v of Array.isArray(visibles) ? visibles : []) {
        console.log(
          `  ! posición vacía con valor (no es redondeo, queda visible): producto ${v.product} «${v.product_name}» · depósito ${v.warehouse} · ${v.value}`,
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
console.log(
  `${fallos === 0 ? "✓" : "✗"} ${ensayo ? "ensayo" : "reparación"} ADR-0075 (céntimo): ` +
    `${ensayo ? regularizarian + " por regularizar" : regularizadas + " regularizadas"}, ` +
    `${sinNada} sin nada, ${fallos} con fallo${ensayo ? " · nada cambió" : ""}`,
);
process.exit(fallos === 0 ? 0 : 1);
