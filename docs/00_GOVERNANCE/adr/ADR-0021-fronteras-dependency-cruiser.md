# ADR-0021 — Fronteras de import verificadas con dependency-cruiser, y `core` como kernel

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto

`MONOREPO_STRUCTURE.md` define una tabla de fronteras entre paquetes. ADR-0001 la declara
verificada en CI y menciona `depcruise`; `MONOREPO_STRUCTURE.md` decía "eslint-plugin-boundaries
(o dependency-cruiser)". Al implementar S0.1 hubo que elegir, y al elegir aparecieron dos
huecos en la tabla que la elección de herramienta no resolvía por sí sola:

1. **`Result` no tenía dónde vivir.** `ENGINEERING_STANDARDS.md` exige errores como valores con
   códigos estables que "forman parte del contrato". Pero la tabla decía que `money` no importa
   nada del repo. `money` no podía importar un `Result` compartido, y definirlo dentro de `money`
   convertía al paquete de dinero en el kernel de facto del monorepo.
2. **`money` (solo formateo)** para `web`/`mobile` no es verificable. Ningún analizador de
   imports distingue "formateo" de "cálculo" dentro de un mismo módulo.

Además, el riesgo que la tabla previene no es de una arista, sino de alcance: lo peligroso no es
que `web` importe `fiscal` —eso lo ve cualquiera en review— sino que `web` importe `domain` que
importa `fiscal`, y que la lógica tributaria acabe en un bundle de cliente sin que nadie lo note.

## Opciones consideradas

1. **`eslint-plugin-boundaries`** — a favor: feedback en el editor, una sola herramienta, ya
   tenemos ESLint. En contra: evalúa **un archivo a la vez**. Ve `web → domain` y lo aprueba,
   sin saber que `domain → fiscal`. Depende del programa de TypeScript, así que se apaga solo
   si un paquete queda fuera del `tsconfig` raíz. No ve `package.json`.
2. **`dependency-cruiser`** — a favor: trabaja sobre el **grafo resuelto**, y sus reglas
   `reachable`/`noDependents` expresan alcanzabilidad transitiva, que es el concepto correcto
   para una tabla cuya primera fila es "no puede importar nada del repo". Verifica también las
   dependencias declaradas en `package.json` (declaradas y no usadas, usadas y no declaradas).
   No depende del compilador. En contra: una herramienta más; su feedback no aparece al escribir.
3. **Solo revisión humana** — descartada sin discusión. La tabla existe precisamente porque la
   disciplina no puede depender de que alguien recuerde.

## Decisión

**`dependency-cruiser` es el gate bloqueante** (`pnpm boundaries`, paso 2 de `pnpm verify`, y
job propio en CI). ESLint conserva un `no-restricted-imports` corto sobre las dos aristas más
frecuentes (`web`/`mobile` → `fiscal`/`accounting`/`domain`) **solo como feedback en el editor**,
nunca como el gate. Se ejecuta antes de lint, typecheck y tests: una violación de arquitectura
debe abortar antes de gastar CPU en verificar código que no debería existir.

Con la herramienta elegida, los dos huecos se cierran así:

**`packages/core` como kernel explícito.** `Result`, `DomainError`, `Brand`, `Instant`. Cero
dependencias, ni siquiera `decimal.js`. Todos pueden importarlo; él no importa a nadie. La fila
de `money` pasa de "nada del repo" a "solo `core`". Regla de admisión: algo entra en `core` solo
si lo necesitan al menos dos paquetes que no pueden importarse entre sí.

**`@ladino/money/format` como subpath.** `packages/money` expone dos entradas: la raíz con
aritmética, redondeo y FX, y `/format` con solo presentación. `web`, `mobile` y `ui` tienen
prohibido alcanzar la raíz. "Solo formateo" deja de ser un comentario en una tabla y pasa a ser
una regla mecánica.

## Consecuencias

**Positivas**
- Las violaciones transitivas se detectan. Es el modo real en que la lógica fiscal se filtra a
  un cliente, y el único que la revisión humana pierde de forma sistemática.
- El gate sobrevive a cambios de configuración del compilador y a que `apps/mobile` salga del
  workspace (ADR-0022). Un gate que se apaga solo cuando tocas el `tsconfig` no es un gate.
- `.dependency-cruiser.cjs` es una traducción 1:1 de la tabla de `MONOREPO_STRUCTURE.md`:
  una sola fuente de verdad, y `--output-type dot` regenera el diagrama de la doc.

**Negativas y deuda que aceptamos**
- **Dos herramientas que dicen cosas parecidas.** Si alguien añade una regla en ESLint y no en
  depcruise, pasa; al revés, no. Mitigación: el `eslint.config.js` lleva un comentario que
  remite a este ADR y limita su alcance a las dos aristas de conveniencia.
- **Sin feedback en el editor** para la mayoría de las reglas. Te enteras al ejecutar `verify`,
  no al escribir el import.
- **Un paquete más que mantener** (`core`), con el riesgo clásico: que se convierta en el cajón
  de sastre. La regla de admisión es la única defensa y depende de aplicarla en review.
- **El subpath obliga a partir el código de `money` en dos entradas** y a mantener la disciplina
  de que `format` nunca importe aritmética. Una regla de depcruise lo vigila, pero es una
  restricción real sobre cómo se organiza el paquete.
- Depcruise se queda corto en dos casos que **no cubre nadie**: imports dinámicos con
  especificador calculado, y código que llega por un `eval` o una plantilla. Aceptado: no
  escribimos eso.

**Para revertirla** bastaría borrar `.dependency-cruiser.cjs` y el paso de `verify`. Revertir
`core` y el subpath es más caro: son cambios de superficie de API con consumidores. Por eso
ambos se hacen ahora, en S0.1/S0.2, cuando no hay consumidores.

## Consecuencia descubierta al implementar: un gate que no resuelve da verde

Al montar el gate en S0.1, la configuración inicial pasaba en verde con **todas** las reglas
inertes. La causa: `dependency-cruiser` **no consulta el campo `exports` del `package.json`
salvo que se le pase `enhancedResolveOptions.exportsFields: ["exports"]` de forma explícita**.
Sin esa línea, cada `import ... from "@ladino/core"` quedaba sin resolver; como las reglas de
frontera coinciden sobre la **ruta resuelta**, ninguna coincidía con nada, y el informe decía
"no dependency violations found".

Lo que lo delató no fue una revisión ni una sospecha, sino la regla `no-unresolvable`, incluida
precisamente para esto. Se comprobó inyectando tres violaciones reales (`web` → raíz de `money`;
`web` → `money/format`, que debe permitirse; y la transitiva `web → domain → fiscal`) y
verificando que el gate señalaba la regla correcta en cada caso.

La lección, que debe sobrevivir a cualquier reescritura del fichero de configuración:

> **Un analizador de fronteras que no resuelve los imports no falla: aprueba.** Su modo de
> avería por defecto es el falso verde, y el falso verde en un gate de arquitectura es peor que
> no tener gate, porque además genera confianza.

De ahí tres reglas operativas, no negociables:

1. **`no-unresolvable` es obligatoria y de severidad `error`.** No es higiene: es el detector de
   avería del propio gate. Si algún día estorba, se arregla la resolución, nunca la regla.
2. **Toda regla de frontera nueva se acompaña de una violación de prueba** que se inyecta, se
   comprueba que falla con el nombre de regla esperado, y se revierte. Una regla que nunca se
   ha visto fallar es una hipótesis, no un control.
3. **Cualquier cambio en `enhancedResolveOptions`, en el campo `exports` de un paquete o en el
   `node-linker` de pnpm invalida esas comprobaciones** y obliga a repetirlas. Son exactamente
   los tres sitios donde la resolución se rompe en silencio.

El mismo razonamiento aplica al resto de gates del repositorio: `assert-no-number-in-dts.mjs`
sale con código 2 si no encuentra ni un `.d.ts`, en vez de felicitarse por no haber encontrado
ningún `number`.

## Verificación

- Un PR de prueba que añada `import { issueInvoice } from '@ladino/fiscal'` en `apps/web` debe
  fallar en CI en el paso `boundaries`, no más tarde.
- Lo mismo para la versión transitiva vía `domain`, y para
  `import { Money } from '@ladino/money'` (raíz) en `apps/web`.
- Revisión a los seis meses: si en ese plazo ninguna regla ha disparado nunca, el candidato a
  eliminar es la capa de ESLint, no depcruise.
