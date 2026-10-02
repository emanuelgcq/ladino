/**
 * `pnpm recorrido <orden>` — la regresión del recorrido 2026-09-24 (RESPUESTA del dueño, §5.1.4).
 *
 *   pnpm recorrido restaurar        deja la base LOCAL en el escenario del recorrido
 *   pnpm recorrido <B>              restaura y corre las comprobaciones del bloque B (A…P)
 *   pnpm recorrido todos            restaura y corre las comprobaciones de los 16 bloques
 *   pnpm recorrido <B> --sin-restaurar   corre sobre la base tal como está
 *   pnpm recorrido <B> --sin-build       no reconstruye la API antes de comprobar
 *   pnpm recorrido <B> --guion      además vuelve a correr los guiones de exploración del bloque
 *
 * Restaurar, en este orden (el volcado es de la migración 73; las nuevas se aplican encima, que es
 * justo lo que harán en producción):
 *   1. `supabase db reset --version <la del volcado> --no-seed`: el esquema exacto del volcado;
 *   2. vaciar public, platform, auth, storage y supabase_migrations, y cargar sus DATOS del volcado
 *      con `pg_restore --data-only --disable-triggers` como supabase_admin;
 *   3. `corregir-escenario.sql`: lo que el escenario trae mal por los defectos del recorrido y que
 *      una migración nueva rechazaría (se corrige en el escenario, nunca en producción);
 *   4. `supabase migration up --local`: las migraciones posteriores al volcado.
 *
 * Las comprobaciones viven en `verificar/<B>.mjs`: una por hallazgo cerrado (sus pasos de
 * REPRODUCIR, que ya no deben reproducir) y las de «Lo que se comprobó y está bien». Los guiones
 * de exploración (`a-registro.mjs`…) quedan como historia: se escribieron para el estado de cada
 * bloque al empezar, no para el escenario final, y no aseveran nada.
 *
 * Solo toca la base LOCAL. El volcado vive fuera de git, en `.recorrido/2026-09-24/`.
 */
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FECHA = "2026-09-24";
const VOLCADO = path.join(RAIZ, ".recorrido", FECHA, "escenario.dump");
const CONTENEDOR = "supabase_db_ladino";
const VERSION_DEL_VOLCADO = "20260918231832";
const EMPRESAS = {
  E1: "01a0d547-9c92-7121-9d82-438e2e322415",
  E2: "01a0d548-82bb-783e-909e-643fc473d458",
  E3: "01a0d549-6587-703a-be13-da740c2750d3",
};
const BLOQUES = "ABCDEFGHIJKLMNOP".split("");
/** Filas de invariante (no INFORME) que `invariantes.sql` devuelve por empresa: súbela al añadir una. */
const INVARIANTES_ESPERADOS = 15;
const ESQUEMAS = ["public", "platform", "auth", "storage", "supabase_migrations"];

function correr(cmd, args, { entrada, silencioso = false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: RAIZ,
    input: entrada,
    encoding: "utf8",
    shell: process.platform === "win32" && cmd === "npx",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (!silencioso || r.status !== 0) {
    if (r.stdout?.trim()) process.stdout.write(r.stdout);
    if (r.stderr?.trim()) process.stderr.write(r.stderr);
  }
  return r;
}
function obligatorio(r, que) {
  if (r.status !== 0) {
    console.error(`\n✗ ${que} falló (exit ${r.status}).`);
    process.exit(1);
  }
}
const psql = (sql, usuario = "postgres") =>
  correr(
    "docker",
    [
      "exec",
      "-i",
      CONTENEDOR,
      "psql",
      "-U",
      usuario,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ],
    {
      entrada: sql,
      silencioso: true,
    },
  );

export function restaurar() {
  if (!fs.existsSync(VOLCADO)) {
    console.error(`✗ No está el volcado del escenario: ${VOLCADO}`);
    process.exit(1);
  }
  console.log(`· 1/4 reset al esquema del volcado (migración ${VERSION_DEL_VOLCADO})`);
  obligatorio(
    correr(
      "npx",
      ["supabase", "db", "reset", "--local", "--version", VERSION_DEL_VOLCADO, "--no-seed"],
      {
        silencioso: true,
      },
    ),
    "supabase db reset",
  );
  console.log("· 2/4 datos del escenario");
  obligatorio(
    correr("docker", ["cp", VOLCADO, `${CONTENEDOR}:/tmp/escenario.dump`], { silencioso: true }),
    "docker cp",
  );
  // Las tablas append-only rechazan TRUNCATE con un trigger (bien hecho): en esta sesión LOCAL de
  // superusuario los triggers se apagan con session_replication_role, igual que pg_restore.
  const vaciar = `set session_replication_role = replica;
  do $$ declare t text; begin
    select string_agg(format('%I.%I', schemaname, tablename), ', ') into t
      from pg_tables where schemaname in (${ESQUEMAS.map((e) => `'${e}'`).join(", ")});
    execute 'truncate table ' || t || ' restart identity cascade';
  end $$;`;
  obligatorio(psql(vaciar, "supabase_admin"), "vaciar tablas");
  // La lista del volcado SIN supabase_migrations.seed_files: esa tabla la crea la semilla de la CLI,
  // y el reset va sin semilla.
  const esquemas = ESQUEMAS.map((e) => "-n " + e).join(" ");
  const r = correr(
    "docker",
    [
      "exec",
      CONTENEDOR,
      "sh",
      "-c",
      "pg_restore -l /tmp/escenario.dump | grep -v seed_files > /tmp/escenario.toc && " +
        "pg_restore -U supabase_admin -d postgres --data-only --disable-triggers " +
        esquemas +
        " -L /tmp/escenario.toc /tmp/escenario.dump",
    ],
    { silencioso: true },
  );
  obligatorio(r, "pg_restore de los datos");
  console.log("· 3/4 corregir el escenario");
  obligatorio(
    psql(
      fs.readFileSync(path.join(RAIZ, "scripts", "recorrido", "corregir-escenario.sql"), "utf8"),
      "supabase_admin",
    ),
    "corregir-escenario.sql",
  );
  console.log("· 4/4 migraciones posteriores al volcado");
  obligatorio(
    correr("npx", ["supabase", "migration", "up", "--local"], { silencioso: true }),
    "supabase migration up",
  );
  // Correcciones del escenario que necesitan el esquema NUEVO (p. ej. reclasificar un producto con
  // una columna que añade una migración): solo si el fichero existe.
  const post = path.join(RAIZ, "scripts", "recorrido", "corregir-escenario-post.sql");
  if (fs.existsSync(post)) {
    obligatorio(
      psql(fs.readFileSync(post, "utf8"), "supabase_admin"),
      "corregir-escenario-post.sql",
    );
  }
  // La semilla local (solo las contraseñas de ladino_api y ladino_worker): el reset fue sin ella.
  obligatorio(
    psql(fs.readFileSync(path.join(RAIZ, "supabase", "seed.sql"), "utf8"), "supabase_admin"),
    "seed.sql",
  );
  // Las reparaciones que en producción corren DESPUÉS del git pull (HANDOFF, despliegue): el
  // escenario es una empresa real de hace días y tiene que quedar como quedará la de producción.
  console.log("· reparaciones posteriores al pull");
  obligatorio(
    psql("select platform.grant_invited_owner_warehouse_ops();", "supabase_admin"),
    "grant_invited_owner_warehouse_ops",
  );
  obligatorio(
    correr(process.execPath, [path.join(RAIZ, "scripts", "reparar", "adr-0070-subcuentas.mjs")], {
      silencioso: true,
    }),
    "reparación ADR-0070 (subcuentas de tesorería)",
  );
  obligatorio(
    correr(process.execPath, [path.join(RAIZ, "scripts", "reparar", "p-02-rif-normalizado.mjs")], {
      silencioso: true,
    }),
    "reparación P-02 (RIF normalizado)",
  );
  const docs = psql("select count(*) from public.documents").stdout.trim();
  console.log(`✓ escenario restaurado (${docs} documentos)`);
}

/** Invariantes de cada empresa: toda línea que no sea INFORME debe dar 0 o vacío. */
export function invariantes() {
  const sql = fs.readFileSync(path.join(RAIZ, "scripts", "recorrido", "invariantes.sql"), "utf8");
  let fallos = 0;
  for (const [e, cid] of Object.entries(EMPRESAS)) {
    const r = correr(
      "docker",
      [
        "exec",
        "-i",
        CONTENEDOR,
        "psql",
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-v",
        `cid=${cid}`,
      ],
      { entrada: sql, silencioso: true },
    );
    // Una empresa que no existe da «0» en todo: sin escenario, los invariantes no dicen nada.
    const existe = psql(`select count(*) from public.companies where id = '${cid}'`).stdout.trim();
    if (existe !== "1") {
      fallos += 1;
      console.log(`  ✗ ${e} · la empresa no existe en la base: ¿se restauró el escenario?`);
      continue;
    }
    // Si psql falla o no llegan las filas, NO es un cero: es un invariante que no se midió.
    if (r.status !== 0) {
      fallos += 1;
      console.log(`  ✗ ${e} · invariantes.sql no corrió (exit ${r.status})`);
      continue;
    }
    // Solo las filas de resultado («nombre | valor»): psql añade «Field separator is …».
    const filas = r.stdout
      .split("\n")
      .filter((l) => l.includes(" | ") && !l.startsWith("Field separator"));
    const medidas = filas.filter((l) => !l.startsWith("INFORME")).length;
    if (medidas < INVARIANTES_ESPERADOS) {
      fallos += 1;
      console.log(`  ✗ ${e} · solo ${medidas} de ${INVARIANTES_ESPERADOS} invariantes dieron fila`);
    }
    for (const linea of filas) {
      const [nombre, valor = ""] = linea.split(" | ").map((s) => s.trim());
      if (nombre.startsWith("INFORME")) continue;
      const cero = valor === "" || valor === "(vacío)" || Number(valor) === 0;
      if (!cero) {
        fallos += 1;
        console.log(`  ✗ ${e} · ${nombre} = ${valor}`);
      }
    }
  }
  console.log(
    fallos === 0 ? "✓ invariantes en 0 (E1, E2, E3)" : `✗ ${fallos} invariante(s) distintos de 0`,
  );
  return fallos;
}

/**
 * Las comprobaciones escriben de verdad y dejan eventos en el outbox; sin worker quedarían
 * «pending» y el invariante del outbox daría rojo por eso. Se levanta el worker LOCAL (el mismo de
 * producción, con su rol ladino_worker) hasta que no quede nada pendiente o pase un minuto: un
 * evento que el worker no puede despachar sigue dando rojo, que es lo que el invariante mide.
 */
function drenarOutbox() {
  const pendientes = () =>
    Number(
      psql(
        "select count(*) from public.outbox where status in ('pending', 'in_flight')",
      ).stdout.trim() || "0",
    );
  if (pendientes() === 0) return;
  console.log("· vaciando el outbox con el worker local");
  const worker = spawn(process.execPath, [path.join(RAIZ, "apps", "worker", "dist", "main.js")], {
    cwd: RAIZ,
    env: {
      ...process.env,
      DATABASE_URL: "postgres://ladino_worker:ladino_worker@127.0.0.1:54322/postgres",
      WORKER_INTERVAL_MS: "300",
    },
    stdio: "ignore",
  });
  const limite = Date.now() + 60_000;
  while (pendientes() > 0 && Date.now() < limite) {
    spawnSync(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
  }
  worker.kill();
}

async function bloque(b, { guion }) {
  let fallos = 0;
  if (guion) {
    for (const g of fs
      .readdirSync(path.join(RAIZ, "scripts", "recorrido"))
      .filter((f) => f.startsWith(b.toLowerCase()) && f.endsWith(".mjs"))
      .sort()) {
      console.log(`· guion ${g}`);
      const r = correr("node", [path.join("scripts", "recorrido", g)], { silencioso: true });
      if (r.status !== 0) fallos += 1;
    }
  }
  const archivo = path.join(RAIZ, "scripts", "recorrido", "verificar", `${b}.mjs`);
  if (!fs.existsSync(archivo)) {
    // Sin comprobaciones NO es verde (ausencia de fallo leída como éxito, familia F4).
    console.log(`✗ ${b}: SIN COMPROBACIONES (falta scripts/recorrido/verificar/${b}.mjs)`);
    return fallos + 1;
  }
  const { default: comprobar } = await import(pathToFileURL(archivo).href);
  return fallos + (await comprobar());
}

const [orden, ...resto] = process.argv.slice(2);
if (!orden) {
  console.log(
    "uso: pnpm recorrido restaurar | <A…P> | todos  [--sin-restaurar] [--sin-build] [--guion]",
  );
  process.exit(2);
}
process.env.RECORRIDO_FECHA = FECHA;
if (orden === "restaurar") {
  restaurar();
  process.exit(invariantes() === 0 ? 0 : 1);
}
const lista = orden === "todos" ? BLOQUES : [orden.toUpperCase()];
if (!lista.every((b) => BLOQUES.includes(b))) {
  console.error(`✗ bloque desconocido: ${orden}`);
  process.exit(2);
}
if (!resto.includes("--sin-restaurar")) restaurar();
// Las comprobaciones montan la API EN PROCESO desde apps/api/dist (verificar/_app.mjs): se
// construye antes, para no comprobar un build viejo.
if (!resto.includes("--sin-build")) {
  console.log("· construyendo la API (apps/api/dist)");
  obligatorio(
    correr(
      "npx",
      ["pnpm", "--filter", "@ladino/api...", "--filter", "@ladino/worker...", "build"],
      {
        silencioso: true,
      },
    ),
    "build de la API",
  );
}
let fallos = 0;
for (const b of lista) fallos += await bloque(b, { guion: resto.includes("--guion") });
drenarOutbox();
fallos += invariantes();
console.log(
  fallos === 0 ? `\nRECORRIDO ${orden}: VERDE` : `\nRECORRIDO ${orden}: ROJO (${fallos})`,
);
process.exit(fallos === 0 ? 0 : 1);
