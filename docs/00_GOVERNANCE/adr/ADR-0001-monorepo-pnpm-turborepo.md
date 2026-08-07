# ADR-0001 — Monorepo TypeScript con pnpm workspaces + Turborepo

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Contexto
Web, mobile, API, worker y siete paquetes de dominio comparten tipos, esquemas Zod y
lógica monetaria. Duplicar esos contratos entre repos es la vía más rápida a un descuadre
entre lo que la app calcula y lo que el servidor persiste.

## Opciones
1. **Polirepo** — despliegues independientes, pero sincronizar contratos es manual y frágil.
2. **Monorepo npm workspaces** — simple, sin caché de tareas; los CI se vuelven lentos.
3. **pnpm + Turborepo** — enlaces duros, caché de tareas por hash, grafo de dependencias explícito.

## Decisión
pnpm workspaces + Turborepo. **Solo pnpm**: un único lockfile, `packageManager` fijado en
`package.json` y `engine-strict`. Mezclar gestores de paquetes ya causó problemas en otros
proyectos del equipo y aquí queda prohibido.

`apps/mobile` puede quedar **fuera del workspace** si el hoisting de pnpm entra en conflicto
con Metro; en ese caso consume los paquetes compartidos por versión publicada o `file:`.

## Consecuencias
- (+) Un cambio de contrato rompe el typecheck de todos los consumidores en el mismo PR.
- (+) CI incremental por caché de Turborepo.
- (−) Curva de configuración inicial mayor.
- (−) Riesgo de acoplamiento accidental: se mitiga con `depcruise` en CI que prohíbe que
  `apps/web` importe de `packages/fiscal`.

## Verificación
CI falla si un paquete importa fuera de su frontera declarada.
