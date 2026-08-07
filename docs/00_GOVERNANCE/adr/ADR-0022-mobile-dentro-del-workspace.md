# ADR-0022 — `apps/mobile` dentro del workspace de pnpm, con criterio de salida escrito

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO (pero protege una garantía que sí lo tiene)

## Contexto

ADR-0001 dejó abierto que `apps/mobile` pudiera quedar **fuera** del workspace si el hoisting de
pnpm entraba en conflicto con Metro, consumiendo los paquetes compartidos por versión publicada
o `file:`. `MONOREPO_STRUCTURE.md` repetía esa salida. En S0.1 hay que decidir, porque de ello
dependen la forma de empaquetar todos los paquetes compartidos y el alcance de `pnpm verify`.

La restricción que hace que esto no sea una preferencia de tooling: la regla 10 de `CLAUDE.md`
dice que la app móvil no es una vía para saltarse los controles del backend, y la garantía
central de ADR-0001 es que "un cambio de contrato rompe el typecheck de todos los consumidores
en el mismo PR".

## Opciones consideradas

1. **Fuera del workspace, consumo por `file:` o versión publicada** — a favor: cero fricción con
   Metro, la salida ya estaba documentada y aceptada. En contra: lockfile propio, lo que hace
   *posible* que `apps/mobile` quede una versión de contrato por detrás del backend. En un ERP
   fiscal eso no es una molestia de DX: es que la app calcula un total con una versión de reglas
   y el servidor persiste con otra. Además, mobile deja de participar en `pnpm verify` — un gate
   con un agujero conocido en uno de los cuatro `apps/`.
2. **Dentro del workspace con `node-linker=hoisted`** — a favor: elimina de raíz cualquier
   problema de resolución de Metro. En contra: `node-linker` es **global al workspace**. Anula
   la detección de dependencias no declaradas de pnpm en los dieciséis paquetes, para asegurar
   contra un fallo que hoy no tenemos. Se pagaría en disciplina de fronteras, que es el punto
   entero de este repositorio.
3. **Dentro del workspace con el `node-linker` aislado por defecto** — a favor: conserva la
   garantía de ADR-0001 y la estrictez de pnpm. En contra: asume que Metro resuelve symlinks.

## Decisión

**Opción 3: `apps/mobile` es miembro del workspace, con el `node-linker` aislado por defecto.**

El bloqueo técnico histórico ya no existe: Metro resuelve symlinks desde 0.73 (Expo SDK 50+) y
`unstable_enablePackageExports` está disponible. La razón por la que estos montajes fallaban en
2022 desapareció; la salida de ADR-0001 sigue siendo válida como **plan B**, no como default.

Lo que hace barata la equivocación —y es la parte de esta decisión que realmente cuesta dinero
si se hace mal— es cómo se consumen los paquetes compartidos:

> **Los paquetes se consumen compilados: `dist/` + campo `exports`. Nunca por `tsconfig.paths`
> ni `babel-plugin-module-resolver`.**

Metro no lee `tsconfig.paths`. Los montajes que dependen de eso se pudren. Con `dist` + `exports`,
ejectar mobile se reduce a un lockfile propio y cambiar `workspace:*` por `file:../../packages/x`:
una tarde, no un refactor.

Cuando Expo entre (sprint propio, no Sprint 0), `metro.config.js` llevará `watchFolders` con la
raíz del workspace, `resolver.nodeModulesPaths` con ambos `node_modules`,
`disableHierarchicalLookup = true` y `unstable_enablePackageExports = true`.

En Sprint 0, `apps/mobile` es un miembro del workspace con `package.json` placeholder, `tsconfig`
y test trivial, **sin ninguna dependencia de Expo instalada**. Fijar hoy un SDK en un sprint que
no construye mobile solo garantiza que esté desactualizado cuando haga falta.

### Criterio de salida — literal, para no re-litigarlo

> Si al integrar Expo, con la configuración de Metro documentada arriba ya aplicada,
> `expo start --clear` **o** un `eas build` no resuelven los paquetes del workspace, se ejecta
> `apps/mobile` a un lockfile propio con dependencias `file:`.
>
> No se ejecta por lentitud, por un warning de resolución, ni por una incompatibilidad de una
> dependencia concreta que pueda arreglarse con un `public-hoist-pattern` acotado a ese paquete.
> El disparador es "no resuelve", no "molesta".
>
> Ejectar **no** habilita `node-linker=hoisted`: eso queda descartado en cualquier escenario.

## Consecuencias

**Positivas**
- Un cambio en `@ladino/schemas` rompe el typecheck de mobile en el mismo PR. Es exactamente la
  garantía que la regla 10 de `CLAUDE.md` necesita del lado técnico.
- `apps/mobile` participa en `pnpm verify` desde el primer día.
- Un solo lockfile, coherente con la prohibición de mezclar gestores de ADR-0001.

**Negativas y deuda que aceptamos**
- **Estamos apostando** a que Metro resuelve symlinks correctamente en el SDK que acabemos
  usando, sin haberlo probado — porque Expo no se instala en este sprint. La apuesta es
  informada, no verificada. El criterio de salida existe justo por eso.
- **Compilar los paquetes cuesta DX.** Consumir `dist` en vez de `src` obliga a un `build` antes
  de que el typecheck del consumidor vea los cambios. Turborepo lo encadena y lo cachea, pero un
  `pnpm dev` en frío es más lento que con alias de `tsconfig`.
- **La salida está más lejos de lo que sugiere el ADR-0001.** Aunque el cambio de dependencias
  sea mecánico, ejectar también significa un pipeline de CI aparte para mobile y un punto donde
  las versiones pueden divergir. El coste real de la salida es de días, no de horas.
- `apps/mobile` estará semanas siendo un placeholder vacío dentro del workspace. Ruido en el
  grafo de tareas a cambio de no tener que reorganizarlo después.

**Para revertirla:** aplicar el criterio de salida. El coste está acotado *siempre que* la regla
de `dist` + `exports` se haya respetado. Si algún paquete introduce alias de `tsconfig.paths`
entre paquetes, esta reversión deja de ser barata — por eso una regla de `dependency-cruiser`
(ADR-0021) vigila que no aparezcan.

## Verificación

- Momento de la verdad: el primer `eas build` verde con `@ladino/schemas` y
  `@ladino/api-client` resueltos desde el workspace. Hasta entonces la decisión está **sin
  verificar**, y así hay que tratarla.
- Señal temprana, disponible desde S0.1: `node scripts/assert-no-cross-package-paths.mjs` — ningún
  `tsconfig.json` de paquete declara `paths` hacia otro paquete.
- Si al cabo de dos sprints con Expo integrado no se ha disparado el criterio de salida, la
  decisión queda confirmada y la nota de "sin verificar" se retira de `MONOREPO_STRUCTURE.md`.
