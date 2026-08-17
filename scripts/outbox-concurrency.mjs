#!/usr/bin/env node
// =============================================================================
// Ladino — prueba de concurrencia real del outbox (S0.4)
//
// pgTAP corre en UNA conexión. La toma de trabajo del outbox es, por
// definición, un problema de varias. Esta prueba usa `pgbench` DENTRO del
// contenedor de Postgres para abrir N sesiones de verdad —backends distintos,
// snapshots distintos, locks reales— y comprobar que dos workers no se llevan
// la misma fila.
//
// LO QUE ESTA PRUEBA DESCARTA Y LO QUE NO está escrito en el informe que
// imprime al final, y también aquí arriba porque es donde se lee:
//
//   DESCARTA los fallos determinantes de la toma de trabajo: un pickup sin
//   `FOR UPDATE SKIP LOCKED`, o sin volver a filtrar por estado tras tomar el
//   lock. Son los que de verdad se escriben por error, y `--roto` demuestra
//   que esta prueba los caza.
//
//   QUIÉN AVISA no es lo que yo suponía al escribirla, y conviene saberlo: en
//   `--roto` el primero en disparar es el CHECK `outbox_published_coherence_chk`
//   del esquema, no el contador `attempts` de esta prueba. Una segunda toma
//   sobre una fila ya publicada intenta devolverla a `in_flight` con
//   `published_at` puesto, y el constraint aborta la transacción antes de que
//   el estado corrupto llegue a existir. El contador solo delata el entrelazado
//   en que las dos tomas ocurren ANTES de que ninguna publique. La defensa
//   principal está en el ESQUEMA; esta prueba comprueba que sigue ahí.
//
//   NO DEMUESTRA la ausencia de carrera. Muestrea un espacio de entrelazados,
//   no lo agota: que N clientes durante T segundos no encuentren una ventana
//   no significa que no exista. Un verde aquí es "no encontré doble entrega",
//   nunca "no puede haberla".
//
//   NO CUBRE la doble entrega que el contrato SÍ permite. ADR-0005 promete
//   at-least-once: un worker que muere después de entregar y antes de marcar
//   `published` reentrega, y eso es CORRECTO por diseño. Esa prueba —matar el
//   worker a media faena— necesita un worker, y el worker es S0.6.
//
// Uso: node scripts/outbox-concurrency.mjs [--clients 8] [--seconds 10] [--rows 20000] [--roto]
// =============================================================================

import { execFileSync } from "node:child_process";

const CONTENEDOR = "supabase_db_ladino";

const args = process.argv.slice(2);
const opcion = (nombre, pordefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : pordefecto;
};

const CLIENTES = opcion("clients", 8);
const SEGUNDOS = opcion("seconds", 10);
const FILAS = opcion("rows", 20000);

// --roto ejecuta el pickup SIN `for update skip locked`, a propósito.
//
// Sin esto, esta prueba nunca habría fallado, y una prueba que nunca ha fallado
// no se sabe si detecta algo — es el patrón que ADR-0023 documenta ocho veces.
// Con --roto se comprueba lo contrario: el detector se dispara cuando hay
// carrera de verdad. Es el control que existe para desconfiar del control.
const ROTO = args.includes("--roto");

const TENANT = "cccccccc-cccc-4ccc-8ccc-000000000001";
const COMPANY = "cccccccc-cccc-4ccc-8ccc-000000000002";

function psql(sql, { silencioso = true } = {}) {
  return execFileSync(
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
      "-v",
      "ON_ERROR_STOP=1",
      "-tA",
      "-c",
      sql,
    ],
    { encoding: "utf8", stdio: silencioso ? ["pipe", "pipe", "pipe"] : "inherit" },
  ).trim();
}

function comprobarEntorno() {
  try {
    execFileSync("docker", ["exec", CONTENEDOR, "sh", "-c", "command -v pgbench"], {
      stdio: "pipe",
    });
  } catch {
    console.error(
      `\nERROR: no hay pgbench en el contenedor ${CONTENEDOR}, o el contenedor no está levantado.\n` +
        `Levanta el stack local con \`pnpm db:start\` y vuelve a intentarlo.\n`,
    );
    process.exit(2);
  }
}

// -----------------------------------------------------------------------------
// El escenario. Se limpia primero: una corrida anterior dejaría filas y el
// recuento final mezclaría dos experimentos.
// -----------------------------------------------------------------------------
function sembrar() {
  // Se limpia el OUTBOX y se REUTILIZAN tenant y company.
  //
  // No se borran: desde la migración 5/5, dar de alta una company deja un evento
  // `company.tax_id_established` en audit_events, y `audit_events_company_fk` es
  // NO ACTION — una company con auditoría NO se puede borrar. Es una propiedad
  // deseable (conservación) que apareció como efecto colateral de la FK, y este
  // script fue lo primero que se topó con ella. La respuesta correcta es
  // adaptar el sembrado, no relajar la restricción: si borrar una company
  // arrastrase su auditoría, la pista de auditoría no valdría nada.
  psql(`
    delete from public.outbox where tenant_id = '${TENANT}';

    insert into public.tenants (id, name) values ('${TENANT}', 'Tenant de carga')
      on conflict (id) do nothing;
    insert into public.companies (id, tenant_id, tax_id, legal_name)
      values ('${COMPANY}', '${TENANT}', 'J-CARGA', 'Empresa de carga')
      on conflict (id) do nothing;

    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       schema_version, payload)
    select '${TENANT}', '${COMPANY}', 'invoice', platform.uuidv7(),
           'invoice.issued', 1, jsonb_build_object('n', g)
      from generate_series(1, ${FILAS}) g;
  `);
}

// -----------------------------------------------------------------------------
// La transacción que ejecuta cada cliente. Es el pickup REAL que usará el
// worker: CTE que toma una fila con SKIP LOCKED, la marca in_flight e
// incrementa attempts; una pausa que simula la entrega; y el marcado final.
//
// `attempts` es el detector: cada toma lo incrementa. Si dos sesiones se
// llevan la misma fila, esa fila acaba con attempts = 2. No hace falta
// instrumentar nada más.
// -----------------------------------------------------------------------------
// NOTA sobre pgbench: sus variables NO son las de psql. `\set` solo admite
// expresiones —no literales entrecomillados— y la sustitución de `:var` es
// TEXTUAL y cruda, sin comillas. Por eso el `\gset` devuelve el id ya pasado
// por `quote_literal`: así `:tomado_id` se expande a 'uuid' con sus comillas.
// El uuid de relleno cubre el caso "no quedaban filas pendientes", en el que
// `marcado` no devuelve nada y sin coalesce el `\gset` fallaría.
const CLAUSULA_LOCK = ROTO ? "" : "for update skip locked";

const GUION_PICKUP = `
begin;

with tomado as (
  select id from public.outbox
   where status = 'pending' and available_at <= now()
   order by available_at, id
   ${CLAUSULA_LOCK}
   limit 1
),
marcado as (
  update public.outbox o
     set status = 'in_flight', attempts = o.attempts + 1
    from tomado t
   where o.id = t.id
  returning o.id
)
select quote_literal(coalesce(
         (select id::text from marcado),
         '00000000-0000-4000-8000-000000000000')) as tomado_id \\gset

-- La entrega tarda. Sin esta pausa la transacción es tan corta que la ventana
-- de carrera casi no se abre y la prueba se vuelve decorativa.
select pg_sleep(0.002);

update public.outbox
   set status = 'published', published_at = now()
 where id = :tomado_id::uuid
   and status = 'in_flight';

commit;
`;

function correrPgbench() {
  execFileSync("docker", ["exec", "-i", CONTENEDOR, "sh", "-c", "cat > /tmp/pickup.sql"], {
    input: GUION_PICKUP,
    stdio: ["pipe", "pipe", "pipe"],
  });

  // pgbench aborta con código != 0 si una transacción revienta. Con el pickup
  // correcto no debería pasar; con --roto pasa, y la razón es interesante (ver
  // abajo). En los dos casos queremos llegar a la verificación, así que el
  // fallo se captura en vez de tumbar el script.
  try {
    return {
      salida: execFileSync(
        "docker",
        [
          "exec",
          CONTENEDOR,
          "pgbench",
          "-h",
          "127.0.0.1",
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-n", // sin vacuum: la tabla es nuestra y recién sembrada
          "-c",
          String(CLIENTES),
          "-j",
          String(Math.min(CLIENTES, 4)),
          "-T",
          String(SEGUNDOS),
          "-f",
          "/tmp/pickup.sql",
        ],
        { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
      ),
      abortado: false,
      motivo: "",
    };
  } catch (e) {
    const err = String(e.stderr ?? "");
    // Primer motivo distinto, sin repetir la misma línea ocho veces.
    const motivo = [
      ...new Set(
        err
          .split("\n")
          .filter((l) => l.includes("ERROR:"))
          .map((l) => l.slice(l.indexOf("ERROR:"))),
      ),
    ].join(" | ");
    return { salida: String(e.stdout ?? ""), abortado: true, motivo };
  }
}

// -----------------------------------------------------------------------------
// Las invariantes. Cada una nombra qué fallo detecta.
// -----------------------------------------------------------------------------
function verificar() {
  const fila = psql(`
    select
      count(*) filter (where attempts > 1),
      count(*) filter (where status = 'in_flight'),
      count(*) filter (where status = 'published'),
      count(*) filter (where status = 'pending'),
      count(*) filter (where status = 'published' and published_at is null),
      coalesce(sum(attempts), 0),
      count(*)
    from public.outbox where tenant_id = '${TENANT}';
  `)
    .split("|")
    .map(Number);

  const [tomadasDosVeces, colgadas, publicadas, pendientes, sinFecha, sumaIntentos, total] = fila;

  const invariantes = [
    {
      ok: tomadasDosVeces === 0,
      texto: `ninguna fila fue tomada dos veces (attempts > 1): ${tomadasDosVeces}`,
      detecta: "pickup sin FOR UPDATE SKIP LOCKED, o sin refiltrar por estado tras tomar el lock",
    },
    {
      ok: colgadas === 0,
      texto: `ninguna fila quedó colgada en in_flight: ${colgadas}`,
      detecta: "transacción que marca in_flight y no cierra el ciclo",
    },
    {
      ok: sumaIntentos === publicadas,
      texto: `sum(attempts) == publicadas: ${sumaIntentos} == ${publicadas}`,
      detecta: "trabajo repetido: cada publicación costó exactamente una toma",
    },
    {
      ok: publicadas + pendientes === total,
      texto: `publicadas + pendientes == total: ${publicadas} + ${pendientes} == ${total}`,
      detecta: "filas perdidas o duplicadas por la cola",
    },
    {
      ok: sinFecha === 0,
      texto: `ninguna publicada sin published_at: ${sinFecha}`,
      detecta: "incoherencia estado/dato que el CHECK debería impedir",
    },
  ];

  return { invariantes, publicadas, pendientes, total };
}

// -----------------------------------------------------------------------------

comprobarEntorno();

console.log(`\n=== Concurrencia del outbox ===`);
console.log(`Sembrando ${FILAS} filas pendientes…`);
sembrar();

console.log(
  `Corriendo pgbench: ${CLIENTES} clientes durante ${SEGUNDOS}s` +
    (ROTO ? "  [MODO ROTO: pickup SIN for update skip locked]" : "") +
    `…\n`,
);
const { salida, abortado, motivo } = correrPgbench();

const tps = /tps = ([\d.]+)/.exec(salida)?.[1] ?? "?";
const transacciones = /number of transactions actually processed: (\d+)/.exec(salida)?.[1] ?? "?";

const { invariantes, publicadas, pendientes, total } = verificar();

console.log(`--- Invariantes ---`);
let fallo = false;
for (const inv of invariantes) {
  console.log(`  ${inv.ok ? "OK  " : "FALLA"} ${inv.texto}`);
  if (!inv.ok) {
    fallo = true;
    console.log(`        detecta: ${inv.detecta}`);
  }
}

if (abortado) {
  // Una transacción que revienta también es señal, y en el caso de --roto es
  // LA señal: el CHECK de coherencia estado/dato convierte una doble toma
  // silenciosa en un fallo duro. Cuenta como detección.
  fallo = true;
  console.log(`  FALLA pgbench abortó transacciones`);
  console.log(`        motivo: ${motivo || "(sin ERROR: en stderr)"}`);
}

// La cola vacía no produce contención: esas transacciones no compiten por nada.
// Si se vació antes de acabar, la ventana REAL de concurrencia fue más corta
// que la corrida, y decir "10 segundos de concurrencia" sería inflar el
// resultado. Se calcula y se dice.
const productivas = publicadas;
const improductivas = Number(transacciones) - productivas;
const seVacio = pendientes === 0;
const ventanaEfectiva =
  tps !== "?" && productivas > 0 ? (productivas / Number(tps)).toFixed(2) : "?";

console.log(`
--- Alcance REAL de esta corrida ---
  sesiones concurrentes         : ${CLIENTES}
  duración nominal              : ${SEGUNDOS}s
  transacciones                 : ${transacciones}  (${tps} tps)
  de ellas, PRODUCTIVAS         : ${productivas}   (${improductivas} encontraron la cola vacía)
  filas sembradas / publicadas  : ${total} / ${publicadas}   (quedan ${pendientes} pendientes)${
    seVacio
      ? `

  ⚠  LA COLA SE VACIÓ antes de terminar. Solo hubo contención mientras quedaban
     filas: ~${ventanaEfectiva}s de los ${SEGUNDOS}s nominales. El resto de la corrida
     no probó nada — sesiones compitiendo por una cola vacía no compiten.
     Para un muestreo honesto, sube --rows hasta que queden pendientes al final.`
      : `

  ✓  La cola NO se vació: hubo trabajo disponible durante toda la corrida, así
     que la contención duró los ${SEGUNDOS}s completos.`
  }

--- Qué significa este resultado ---
  DESCARTA los fallos determinantes de la toma de trabajo: un pickup sin
  SKIP LOCKED, o que no vuelve a filtrar por estado tras tomar el lock. Con
  ${productivas} transacciones productivas y ${CLIENTES} sesiones compitiendo, esa clase
  queda cubierta. Y está comprobado en el sentido contrario: \`--roto\` quita el
  SKIP LOCKED y la corrida falla. No es un test que nunca haya fallado.

  QUIÉN AVISA, medido y no supuesto: en \`--roto\` el que se dispara primero es el
  CHECK del esquema (outbox_published_coherence_chk), no el contador attempts de
  esta prueba. El contador solo delata el entrelazado en que las dos tomas
  ocurren antes de que ninguna publique; en los demás, el estado corrupto ni
  llega a existir porque el constraint aborta la transacción. Conviene tenerlo
  claro: la defensa principal contra la doble toma está en el ESQUEMA, y esta
  prueba es la que comprueba que sigue ahí.

  NO DEMUESTRA que no exista carrera. Esto muestrea entrelazados, no los agota.
  Un verde dice "no encontré doble entrega", nunca "no puede haberla". La
  diferencia importa: si mañana aparece una, este resultado no la contradice.

  NO CUBRE la doble entrega que el contrato SÍ permite. ADR-0005 promete
  at-least-once: un worker que muere tras entregar y antes de marcar published
  reentrega, y eso es correcto por diseño. Probar eso exige matar el worker a
  media faena, y el worker llega en S0.6.

  NO CUBRE tampoco la contención entre tenants: toda la carga es de un solo
  tenant. El vecino ruidoso sigue en el handoff, sin probar.
`);

if (ROTO) {
  // En modo --roto lo ESPERADO es fallar. Un verde aquí significa que el
  // detector no detecta, y eso es peor noticia que la carrera.
  if (fallo) {
    const porInvariante = invariantes.filter((i) => !i.ok).map((i) => i.texto);
    console.log(`RESULTADO --roto: correcto, la carrera SE DETECTA. Qué la detectó:`);
    if (abortado) {
      console.log(
        `  · el CHECK del esquema (outbox_published_coherence_chk). Una segunda toma\n` +
          `    sobre una fila ya publicada intenta devolverla a in_flight con published_at\n` +
          `    puesto, y el constraint lo rechaza. NO es higiene: es un detector de\n` +
          `    carrera activo, y aborta la transacción antes de que el estado corrupto\n` +
          `    sea observable.`,
      );
    }
    if (porInvariante.length) {
      console.log(`  · invariantes de esta prueba: ${porInvariante.join("; ")}`);
    } else {
      console.log(
        `  · las invariantes de esta prueba NO se dispararon. Conviene saberlo: el\n` +
          `    contador attempts solo delata el entrelazado en que ambas tomas ocurren\n` +
          `    ANTES de que ninguna publique. En los demás, quien avisa es el CHECK.`,
      );
    }
    console.log("");
    process.exit(0);
  }
  console.error(
    "RESULTADO --roto: ALARMA. Se quitó el SKIP LOCKED y la prueba siguió en verde:\n" +
      "el detector no detecta, y el verde de la corrida normal no vale nada.\n",
  );
  process.exit(1);
}

if (fallo) {
  console.error("RESULTADO: FALLA — hay carrera en la toma de trabajo.\n");
  process.exit(1);
}
console.log("RESULTADO: sin doble toma observada en este muestreo.\n");
