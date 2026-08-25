/**
 * Fronteras de import de Ladino — el gate real (ADR-0021).
 *
 * Traducción 1:1 de la tabla de docs/00_GOVERNANCE/MONOREPO_STRUCTURE.md.
 * Si cambias una regla aquí, cambia la tabla. Son el mismo hecho escrito dos veces.
 *
 * Resuelve por la condición "ladino-source" (ver el campo `exports` de cada paquete), así que
 * analiza CÓDIGO FUENTE y no necesita un build previo. Eso es lo que permite que `boundaries`
 * sea el paso 2 de `pnpm verify`, antes de gastar CPU en lint, typecheck y tests.
 */

/** Rutas del repo que NO son el propio paquete. Base de las reglas de "solo puede importar X". */
const repo = "^(packages|apps)/";

/**
 * Genera la regla "el paquete `name` solo puede importar los paquetes de `allowed`".
 * `allowed` no incluye al propio paquete: importarse a sí mismo siempre vale.
 */
function only(name, allowed, comment) {
  const permitted = [name, ...allowed].join("|");
  return {
    name: `${name}-scope`,
    severity: "error",
    comment,
    from: { path: `^packages/${name}/` },
    to: { path: repo, pathNot: `^packages/(${permitted})/` },
  };
}

module.exports = {
  forbidden: [
    // ---------------------------------------------------------------- kernel
    {
      name: "core-is-the-kernel",
      severity: "error",
      comment:
        "packages/core no importa NADA del repo ni ninguna dependencia externa. Es lo que " +
        "impide que money acabe siendo el kernel por accidente (ADR-0021).",
      from: { path: "^packages/core/" },
      to: {
        path: repo,
        pathNot: "^packages/core/",
      },
    },
    {
      name: "core-has-no-dependencies",
      severity: "error",
      comment:
        "core no puede tener dependencias externas. En cuanto tenga una deja de ser el kernel. " +
        "Los tests sí pueden importar vitest: la regla es sobre lo que se publica, no sobre cómo se prueba.",
      from: { path: "^packages/core/", pathNot: "\\.test\\.tsx?$" },
      to: { dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "core"] },
    },

    // ------------------------------------------------- paquetes puros: alcance
    only("money", ["core"], "money solo importa core. Ver ADR-0021."),
    only("schemas", ["core"], "schemas es la fuente única de contratos: solo core."),
    only("accounting", ["core", "money", "schemas"], "ADR-0003, tabla de fronteras."),
    only("fiscal", ["core", "money", "accounting", "schemas"], "ADR-0003."),
    only("inventory", ["core", "money", "schemas"], "Tabla de fronteras."),
    only("authz", ["core", "schemas"], "authz no toca dinero ni fiscal."),
    only("api-client", ["core", "schemas"], "Cliente tipado: solo contratos."),
    only("observability", ["core"], "OTel y logger. Ningún paquete de dominio."),
    only(
      "ui",
      ["core", "schemas", "money"],
      "El subpath de money lo restringe la regla client-money-format-only.",
    ),

    // ------------------------------------------------- paquetes puros: sin I/O
    {
      name: "pure-packages-no-node-builtins",
      severity: "error",
      comment:
        "core, money, accounting, fiscal, inventory y schemas son puros: ni fs, ni http, ni " +
        "crypto, ni process. ENGINEERING_STANDARDS.md §Estructura del código.",
      from: {
        path: "^packages/(core|money|accounting|fiscal|inventory|schemas)/",
        pathNot: "\\.test\\.tsx?$",
      },
      to: { dependencyTypes: ["core"] },
    },
    {
      name: "pure-packages-no-io-libs",
      severity: "error",
      comment:
        "Sin cliente de base de datos ni cliente HTTP en un paquete puro. Si un cálculo " +
        "necesita datos, se le pasan como argumento.",
      from: {
        path: "^packages/(core|money|accounting|fiscal|inventory|schemas)/",
        pathNot: "\\.test\\.tsx?$",
      },
      to: {
        path: "node_modules/(pg|postgres|@supabase|undici|axios|node-fetch|ioredis|redis|knex|drizzle-orm|@prisma)",
      },
    },

    // ------------------------------------------------------------ domain y apps
    {
      name: "domain-not-apps",
      severity: "error",
      comment: "domain son casos de uso; no puede alcanzar ninguna app.",
      from: { path: "^packages/domain/" },
      to: { path: "^apps/", reachable: true },
    },
    {
      name: "apps-dont-cross",
      severity: "error",
      comment: "Ninguna app importa de otra app. Comparten a través de packages.",
      from: { path: "^apps/([^/]+)/" },
      to: { path: "^apps/([^/]+)/", pathNot: "^apps/$1/" },
    },

    // ---------------------------------------------------- clientes: lo que importa
    {
      name: "client-no-fiscal",
      severity: "error",
      comment:
        "REGLA CENTRAL. web, mobile y ui no pueden ALCANZAR fiscal, accounting ni domain, " +
        "ni siquiera de forma transitiva. El modo real en que la lógica tributaria se filtra a " +
        "un bundle de cliente es web → domain → fiscal, no un import directo que se ve en review. " +
        "CLAUDE.md §7 y regla 10.",
      from: { path: "^(apps/(web|mobile)|packages/ui)/" },
      to: { path: "^packages/(fiscal|accounting|domain|inventory)/", reachable: true },
    },
    {
      name: "client-money-format-only",
      severity: "error",
      comment:
        'La tabla decía "money (solo formateo)". Ningún analizador distingue formateo de ' +
        "cálculo dentro de un módulo, así que la restricción es un subpath: web, mobile y ui " +
        "solo pueden importar @ladino/money/format, nunca la raíz @ladino/money (ADR-0021).",
      from: { path: "^(apps/(web|mobile)|packages/ui)/" },
      to: {
        path: "^packages/money/",
        pathNot: "^packages/money/(src|dist)/format\\.(ts|js|d\\.ts)$",
      },
    },

    {
      name: "db-client-only-in-db-package",
      severity: "error",
      comment:
        "El helper de @ladino/db es el ÚNICO punto de entrada a Postgres, porque es quien fija " +
        "`set local ladino.actor_id` como primera sentencia de la transacción. Si otro módulo " +
        "abre su propia conexión, escribe sin autor: `set_row_provenance()` deja created_by en " +
        "NULL EN SILENCIO, sin error y con 201 de vuelta, y el vacío aparece meses después en " +
        "una auditoría. Un contrato documentado no basta (CLAUDE.md §2: ausencia de mecanismo " +
        "no es prohibición); esta regla lo convierte en imposible. ADR-0027 §3-bis y " +
        "API_SPEC.md §Procedencia.",
      from: { pathNot: "^packages/db/" },
      to: { path: "node_modules/postgres/" },
    },

    // ------------------------------------------------------------------ higiene
    {
      name: "no-circular",
      severity: "error",
      comment: "Ciclos entre módulos.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-unresolvable",
      severity: "error",
      comment:
        "Un import que no resuelve haría que las reglas de ruta no coincidan y el gate pasara " +
        "en silencio. Un gate que se apaga solo no es un gate.",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "no-dev-dep-in-src",
      severity: "error",
      comment: "Código de producción no depende de una devDependency.",
      from: { path: "^(packages|apps)/[^/]+/src/", pathNot: "\\.(test|spec)\\.tsx?$" },
      to: { dependencyTypes: ["npm-dev"] },
    },
    {
      name: "no-orphans",
      severity: "warn",
      comment: "Módulo que nadie importa. Suele ser código muerto.",
      // Los `*-cli.ts` son puntos de entrada (los invoca node, no un import).
      // `server.ts` y `main.ts` son los puntos de entrada de los contenedores.
      from: {
        orphan: true,
        pathNot: "\\.d\\.ts$|(^|/)index\\.ts$|(^|/)[a-z-]+-cli\\.ts$|(^|/)(server|main)\\.ts$",
      },
      to: {},
    },
  ],

  options: {
    doNotFollow: { path: "node_modules" },
    // ⚠ `node_modules` NO va en `exclude`, y la diferencia con `doNotFollow` es
    // la que decide si media docena de reglas funcionan o son decorativas:
    //
    //   · `doNotFollow` conserva el módulo en el grafo pero no lo atraviesa —la
    //     arista `mi-código → node_modules/postgres` EXISTE y se puede prohibir;
    //   · `exclude` lo borra del grafo, así que esa arista no existe y toda
    //     regla con `to: { path: "node_modules/..." }` no coincide con nada.
    //
    // Con `node_modules` en `exclude` estaban INERTES `pure-packages-no-io-libs`
    // —la que garantiza que money, accounting y fiscal no tocan un cliente de
    // base de datos ni HTTP— y `db-client-only-in-db-package`. Las dos daban
    // verde por no encontrar nada que mirar, que es el caso 1 del patrón de
    // ADR-0023. Detectado en S0.5 al escribir la segunda y comprobar, con la
    // variante rota, que no se disparaba.
    // Y el patrón va ANCLADO a nuestros paquetes. `(^|/)(dist|coverage)/` sin
    // anclar excluía también el `dist/` INTERNO de las dependencias npm, que es
    // donde casi todas publican su entry point: `postgres` se salvaba por
    // exponer `src/index.js`, pero `vitest` y compañía desaparecían del grafo y
    // `no-dev-dep-in-src` no tenía nada que mirar. Mismo fallo que el de
    // `node_modules`, un nivel más abajo y más difícil de ver.
    exclude: { path: "^(packages|apps)/[^/]+/(dist|coverage)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      // OBLIGATORIO y no evidente: sin esto dependency-cruiser NO consulta el campo `exports`
      // del package.json, cada import a un @ladino/* queda sin resolver y solo la regla
      // `no-unresolvable` evita que el gate pase en silencio.
      exportsFields: ["exports"],
      // "ladino-source" hace que depcruise lea src/*.ts en vez de dist/*.js.
      // Node, TypeScript y Metro ignoran las condiciones que no conocen.
      conditionNames: ["ladino-source", "types", "import", "require", "node", "default"],
      extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
      mainFields: ["module", "main", "types"],
    },
    // false = resolver symlinks a su ruta real. Necesario: pnpm enlaza los paquetes del
    // workspace, y sin esto las reglas de ruta no verían `packages/<x>/...`.
    preserveSymlinks: false,
    reporterOptions: {
      dot: { collapsePattern: "^(packages|apps)/[^/]+" },
      text: { highlightFocused: true },
    },
  },
};
