#!/usr/bin/env node
// =============================================================================
// Ladino — autotest del gate de fronteras
//
// POR QUÉ EXISTE ESTE FICHERO
//
// En S0.5 se descubrió que `pure-packages-no-io-libs` —la regla que garantiza
// que money, accounting, fiscal e inventory no tocan un cliente de base de
// datos ni HTTP— llevaba INERTE desde que se escribió. `node_modules` estaba en
// `exclude`, así que esos módulos no entraban en el grafo, ninguna arista npm
// existía, y la regla daba verde por no tener nada que mirar.
//
// La lección que obliga a este arnés: **un gate compuesto no está vivo porque
// el conjunto pase.** Veintidós reglas en verde pueden ser veintiuna vivas y
// una muerta, o al revés, y desde fuera se ven igual. Cada regla tiene que
// demostrar que dispara.
//
// CÓMO FUNCIONA
//
// Para cada regla, se escribe una violación a propósito, se corre el gate, y se
// exige que salte ESA regla por su nombre. Que salte otra no cuenta: fue
// exactamente lo que pasó al escribir `db-client-only-in-db-package`, donde la
// violación la cazó `no-unresolvable` y la regla nueva no se enteró.
//
// Uso: node scripts/boundaries-selftest.mjs [--solo <nombre-de-regla>]
// =============================================================================

import { execFileSync } from "node:child_process";
import { writeFileSync, rmSync, readFileSync, mkdirSync } from "node:fs";

const args = process.argv.slice(2);
const soloIdx = args.indexOf("--solo");
const SOLO = soloIdx >= 0 ? args[soloIdx + 1] : null;

/** Corre el gate y devuelve su salida completa (no lanza si hay violaciones). */
function correrGate() {
  try {
    return execFileSync(
      "npx",
      ["depcruise", "--config", ".dependency-cruiser.cjs", "apps", "packages"],
      { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], shell: true },
    );
  } catch (e) {
    return String(e.stdout ?? "") + String(e.stderr ?? "");
  }
}

/**
 * Dependencias que hay que DECLARAR para que los fixtures resuelvan.
 *
 * Sin esto, el import de un fixture no resuelve y lo caza `no-unresolvable` en
 * vez de la regla que se quiere probar — el resultado parece «regla inerte» y
 * en realidad es «fixture mal montado». Distinguir las dos cosas es el trabajo
 * de este arnés, así que la preparación se hace bien y de una vez.
 *
 * Declarar una dependencia SIN importarla es inocuo para el gate:
 * dependency-cruiser mira los imports del código, no los package.json.
 */
const DEPENDENCIAS_FIXTURE = {
  core: { "@ladino/money": "workspace:*", postgres: "^3.4.5", "@ladino/no-existe": undefined },
  money: { "@ladino/accounting": "workspace:*", postgres: "^3.4.5" },
  schemas: { "@ladino/money": "workspace:*" },
  accounting: { "@ladino/fiscal": "workspace:*" },
  fiscal: { "@ladino/inventory": "workspace:*" },
  inventory: { "@ladino/fiscal": "workspace:*" },
  authz: { "@ladino/money": "workspace:*" },
  "api-client": { "@ladino/money": "workspace:*" },
  observability: { "@ladino/schemas": "workspace:*" },
  ui: { "@ladino/authz": "workspace:*" },
  domain: { "@ladino/api": "workspace:*", postgres: "^3.4.5" },
};
const DEPENDENCIAS_FIXTURE_APPS = {
  api: { "@ladino/worker": "workspace:*" },
  web: { "@ladino/fiscal": "workspace:*", "@ladino/money": "workspace:*" },
};
/** `no-dev-dep-in-src` exige que la dependencia sea devDependency DEL paquete. */
const DEV_FIXTURE = { core: { vitest: "^3.2.7" } };

const MANIFIESTOS = ["package.json", "packages/*/package.json", "apps/*/package.json"];

/**
 * Detecta restos de una corrida anterior que muriera a mitad.
 *
 * NO exige el árbol limpio en git —los cambios en curso son legítimos— sino que
 * ninguna dependencia de fixture esté YA declarada. Si lo está, la corrida
 * anterior no restauró, y tomar ese estado por «original» lo fijaría para
 * siempre: pasó una vez y dejó `@ladino/money` clavado como dependencia de
 * `core`, con el ciclo de build que turbo detectó.
 */
function exigirSinRestos(manifiestos) {
  const restos = [];
  for (const { ruta, deps, dev } of manifiestos) {
    const j = JSON.parse(readFileSync(ruta, "utf8"));
    for (const n of Object.keys(deps ?? {})) if (j.dependencies?.[n]) restos.push(`${ruta}: ${n}`);
    for (const n of Object.keys(dev ?? {}))
      if (j.devDependencies?.[n]) restos.push(`${ruta}: ${n}`);
  }
  if (restos.length) {
    console.error(
      "FALLA: quedan dependencias de fixture de una corrida anterior.\n" +
        "Restáuralas antes de volver a ejecutar, o este arnés las tomará por originales:\n\n  " +
        restos.join("\n  ") +
        "\n",
    );
    process.exit(1);
  }
}

/** Snapshot en memoria de los manifiestos tocados, para restaurar exactamente. */
const originales = new Map();

/**
 * Restaura el contenido EXACTO que había antes, no el que hay en git: los
 * cambios en curso del árbol de trabajo son legítimos y no deben perderse.
 * Idempotente, para poder llamarlo desde el hook de salida sin miedo.
 */
function restaurar() {
  if (originales.size === 0) return;
  for (const [ruta, orig] of originales) writeFileSync(ruta, orig);
  originales.clear();
  execFileSync("pnpm", ["install", "--silent"], { stdio: "ignore", shell: true });
}

function prepararTodo() {
  const escribir = (ruta, mut) => {
    const actual = readFileSync(ruta, "utf8");
    // Solo la PRIMERA vez: `core` se escribe dos veces —dependencies y
    // devDependencies— y guardar el snapshot en la segunda fijaría la versión
    // ya modificada como «original». Eso dejaba a `core` con `@ladino/money`
    // clavado y turbo detectando un ciclo de build.
    if (!originales.has(ruta)) originales.set(ruta, actual);
    const j = JSON.parse(actual);
    mut(j);
    writeFileSync(ruta, JSON.stringify(j, null, 2) + "\n");
  };

  for (const [pkg, deps] of Object.entries(DEPENDENCIAS_FIXTURE)) {
    escribir(`packages/${pkg}/package.json`, (j) => {
      j.dependencies = { ...(j.dependencies ?? {}) };
      for (const [n, v] of Object.entries(deps)) if (v) j.dependencies[n] = v;
    });
  }
  for (const [app, deps] of Object.entries(DEPENDENCIAS_FIXTURE_APPS)) {
    escribir(`apps/${app}/package.json`, (j) => {
      j.dependencies = { ...(j.dependencies ?? {}), ...deps };
    });
  }
  for (const [pkg, deps] of Object.entries(DEV_FIXTURE)) {
    escribir(`packages/${pkg}/package.json`, (j) => {
      j.devDependencies = { ...(j.devDependencies ?? {}), ...deps };
    });
  }

  execFileSync("pnpm", ["install", "--silent"], { stdio: "ignore", shell: true });

  return restaurar;
}

/**
 * Las violaciones, una por regla.
 *
 * `archivos`: ficheros temporales a crear.
 * `preparar`: opcional, para las reglas que necesitan una dependencia npm
 *             declarada — sin ella el import no resuelve y lo caza
 *             `no-unresolvable` en vez de la regla que se quiere probar.
 */
const CASOS = [
  {
    regla: "core-is-the-kernel",
    archivos: {
      "packages/core/src/_st.ts": `import { x } from "@ladino/money";\nexport const y = x;\n`,
    },
  },
  {
    regla: "core-has-no-dependencies",
    archivos: { "packages/core/src/_st.ts": `import p from "postgres";\nexport const y = p;\n` },
  },
  // Las nueve `*-scope` las genera only(). Se prueba cada una con un import
  // que su tabla de fronteras no permite.
  {
    regla: "money-scope",
    archivos: {
      "packages/money/src/_st.ts": `import { x } from "@ladino/accounting";\nexport const y = x;\n`,
    },
  },
  {
    regla: "schemas-scope",
    archivos: {
      "packages/schemas/src/_st.ts": `import { x } from "@ladino/money";\nexport const y = x;\n`,
    },
  },
  {
    regla: "accounting-scope",
    archivos: {
      "packages/accounting/src/_st.ts": `import { x } from "@ladino/fiscal";\nexport const y = x;\n`,
    },
  },
  {
    regla: "fiscal-scope",
    archivos: {
      "packages/fiscal/src/_st.ts": `import { x } from "@ladino/inventory";\nexport const y = x;\n`,
    },
  },
  {
    regla: "inventory-scope",
    archivos: {
      "packages/inventory/src/_st.ts": `import { x } from "@ladino/fiscal";\nexport const y = x;\n`,
    },
  },
  {
    regla: "authz-scope",
    archivos: {
      "packages/authz/src/_st.ts": `import { x } from "@ladino/money";\nexport const y = x;\n`,
    },
  },
  {
    regla: "api-client-scope",
    archivos: {
      "packages/api-client/src/_st.ts": `import { x } from "@ladino/money";\nexport const y = x;\n`,
    },
  },
  {
    regla: "observability-scope",
    archivos: {
      "packages/observability/src/_st.ts": `import { x } from "@ladino/schemas";\nexport const y = x;\n`,
    },
  },
  {
    regla: "ui-scope",
    archivos: {
      "packages/ui/src/_st.ts": `import { x } from "@ladino/authz";\nexport const y = x;\n`,
    },
  },
  {
    regla: "pure-packages-no-node-builtins",
    archivos: {
      "packages/money/src/_st.ts": `import { readFileSync } from "node:fs";\nexport const y = readFileSync;\n`,
    },
  },
  {
    regla: "pure-packages-no-io-libs",
    archivos: { "packages/money/src/_st.ts": `import p from "postgres";\nexport const y = p;\n` },
  },
  {
    regla: "domain-not-apps",
    archivos: {
      "packages/domain/src/_st.ts": `import { PACKAGE_NAME } from "@ladino/api";\nexport const y = PACKAGE_NAME;\n`,
    },
  },
  {
    regla: "apps-dont-cross",
    archivos: {
      "apps/api/src/_st.ts": `import { PACKAGE_NAME } from "@ladino/worker";\nexport const y = PACKAGE_NAME;\n`,
    },
  },
  {
    regla: "client-no-fiscal",
    archivos: {
      "apps/web/src/_st.ts": `import { x } from "@ladino/fiscal";\nexport const y = x;\n`,
    },
  },
  {
    regla: "client-money-format-only",
    archivos: {
      "apps/web/src/_st.ts": `import { x } from "@ladino/money";\nexport const y = x;\n`,
    },
  },
  {
    regla: "db-client-only-in-db-package",
    archivos: { "packages/domain/src/_st.ts": `import p from "postgres";\nexport const y = p;\n` },
  },
  {
    regla: "no-circular",
    archivos: {
      "packages/core/src/_st_a.ts": `import { b } from "./_st_b.js";\nexport const a = b;\n`,
      "packages/core/src/_st_b.ts": `import { a } from "./_st_a.js";\nexport const b = a;\n`,
    },
  },
  {
    regla: "no-unresolvable",
    archivos: {
      "packages/core/src/_st.ts": `import { x } from "@ladino/no-existe";\nexport const y = x;\n`,
    },
  },
  {
    regla: "no-dev-dep-in-src",
    archivos: {
      "packages/core/src/_st.ts": `import { describe } from "vitest";\nexport const y = describe;\n`,
    },
  },
  {
    regla: "no-orphans",
    // Un fichero que nadie importa y que no es index.ts ni .d.ts.
    archivos: { "packages/core/src/_st_huerfano.ts": `export const solo = 1;\n` },
  },
];

// -----------------------------------------------------------------------------

const reglasConfiguradas = (await import("../.dependency-cruiser.cjs")).default.forbidden.map(
  (r) => r.name,
);
const cubiertas = new Set(CASOS.map((c) => c.regla));
const sinCaso = reglasConfiguradas.filter((r) => !cubiertas.has(r));

console.log(`\n=== Autotest del gate de fronteras ===`);
console.log(
  `Reglas configuradas: ${reglasConfiguradas.length} · con caso de prueba: ${cubiertas.size}\n`,
);

if (sinCaso.length) {
  console.error(`FALLA: ${sinCaso.length} reglas SIN caso de prueba: ${sinCaso.join(", ")}`);
  console.error(`Una regla sin autotest es una regla de la que no se sabe si dispara.\n`);
  process.exit(1);
}

const casos = SOLO ? CASOS.filter((c) => c.regla === SOLO) : CASOS;
exigirSinRestos([
  ...Object.entries(DEPENDENCIAS_FIXTURE).map(([p, deps]) => ({
    ruta: `packages/${p}/package.json`,
    deps,
  })),
  ...Object.entries(DEPENDENCIAS_FIXTURE_APPS).map(([a, deps]) => ({
    ruta: `apps/${a}/package.json`,
    deps,
  })),
  ...Object.entries(DEV_FIXTURE).map(([p, dev]) => ({ ruta: `packages/${p}/package.json`, dev })),
]);
console.log("Declarando dependencias de fixture (una sola instalación)…");
const deshacerPreparacion = prepararTodo();
// Pase lo que pase —excepción, exit temprano, Ctrl-C— los manifiestos vuelven.
process.on("exit", () => {
  try {
    restaurar();
  } catch {
    /* nada que hacer si git falla al salir */
  }
});
const inertes = [];
const cazadasPorOtra = [];

for (const caso of casos) {
  try {
    for (const [ruta, contenido] of Object.entries(caso.archivos)) {
      mkdirSync(ruta.slice(0, ruta.lastIndexOf("/")), { recursive: true });
      writeFileSync(ruta, contenido);
    }

    const salida = correrGate();
    const disparo = salida.includes(`${caso.regla}:`);

    if (disparo) {
      console.log(`  OK    ${caso.regla}`);
    } else {
      // ¿La cazó alguna OTRA regla? Es lo que pasó con db-client-only, donde
      // no-unresolvable tapó que la regla nueva no se enteraba.
      const otras = reglasConfiguradas.filter((r) => r !== caso.regla && salida.includes(`${r}:`));
      if (otras.length) {
        cazadasPorOtra.push({ regla: caso.regla, otras });
        console.log(`  FALLA ${caso.regla}  -> no disparó; lo cazó: ${otras.join(", ")}`);
      } else {
        inertes.push(caso.regla);
        console.log(`  FALLA ${caso.regla}  -> INERTE: nada la detectó`);
      }
    }
  } finally {
    for (const ruta of Object.keys(caso.archivos)) rmSync(ruta, { force: true });
  }
}

deshacerPreparacion();

console.log("");
if (inertes.length || cazadasPorOtra.length) {
  if (inertes.length) {
    console.error(`INERTES (${inertes.length}): ${inertes.join(", ")}`);
    console.error(`  No las detecta nada. Dan verde por no tener qué mirar.\n`);
  }
  if (cazadasPorOtra.length) {
    console.error(`TAPADAS (${cazadasPorOtra.length}):`);
    for (const { regla, otras } of cazadasPorOtra) {
      console.error(`  ${regla} — la violación la caza ${otras.join(", ")}, no ella.`);
    }
    console.error(
      `  El conjunto pasa y la regla concreta no funciona. Es la forma más\n` +
        `  engañosa de este fallo: parece cubierto.\n`,
    );
  }
  process.exit(1);
}

console.log(`RESULTADO: las ${casos.length} reglas disparan. El gate está vivo.\n`);
