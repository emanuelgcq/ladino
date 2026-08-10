# Handoff — 2026-08-08

## Estado

**Sprint 0. S0.1 y S0.2 cerrados y en verde. El siguiente es S0.3 — identidad
organizacional y aislamiento multi-tenant.**

Del `SPRINT_0_BOOTSTRAP.md`: S0.1 ✅ · S0.2 ✅ · S0.3 ⬜ · S0.4 ⬜ · S0.5 ⬜ · S0.6 ⬜.
Cero migraciones aplicadas. Cero lógica de negocio.

## Hecho en esta sesión

**S0.1 — esqueleto**

- `git init`, remoto `github.com/emanuelgcq/ladino`, rama `main` con la documentación y los ADR.
- 16 workspaces (pnpm + Turborepo, TS `strict` con `noUncheckedIndexedAccess` y
  `exactOptionalPropertyTypes`). Placeholders sin frameworks: Vite, Hono y Expo entran cada uno
  en su sprint.
- `pnpm verify` de 7 pasos: `format:check` → `boundaries` → `lint` → `typecheck` → `test` →
  `build` → `api-surface`.
- Gate de fronteras con `dependency-cruiser` (ADR-0021), **verificado inyectando tres
  violaciones reales** y comprobando qué regla saltaba: `web` → raíz de `money` (rechazado),
  `web` → `money/format` (permitido), y la transitiva `web → domain → fiscal` (rechazado).
- `packages/core`: `Result`, `DomainError`, `Brand`, `Instant`. Cero dependencias.
- CI en Node 22 LTS con corepack.

**S0.2 — `packages/money`**

Tests primero, en rojo, revisados antes de escribir implementación. **165 propiedades en verde.**

- `Money` (persistible) separado de `ExactMoney` (intermedio de cálculo) — ADR-0023.
- Cuatro redondeos nombrados que devuelven `RoundedMoney` con pre-redondeo estructural.
- `allocate` por mayor resto, con precondición de escala y simetría de signo.
- FX con `{rate, source, timestamp}` obligatorios y `MonetaryFact` con los 7 campos de ADR-0020.
- Subpath `@ladino/money/format` como única entrada para `web`, `mobile` y `ui`.
- Estanqueidad completa: ninguna vía (`JSON.stringify`, spread, `Object.entries`,
  `structuredClone`) publica un valor sin redondear.

**Auditoría posterior.** El subagente `accounting-invariants` encontró **siete defectos que
pasaban las 146 propiedades anteriores**. Los dos peores producían registros indefendibles:
`fx_rate` se persistía sin forma canónica (una tasa derivada daba 33 millones de VES de
diferencia al recalcular) y `RoundedMoney`, al ser una interfaz, se podía fabricar a mano con un
`value` sin relación con su `preRound`. Todos arreglados con test en
`packages/money/test/audit-findings.test.ts`.

**Documentación**

- ADR-0021 (fronteras), ADR-0022 (mobile en el workspace), ADR-0023 (`Money`/`ExactMoney`).
- `MONEY_AND_ROUNDING_SPEC.md` pasó de 26 líneas a spec completa con formulario para el asesor.
- `MONOREPO_STRUCTURE.md`: tabla de fronteras completa (faltaban 5 filas) y `core`.
- `API_SPEC.md`: todo importe viaja como `{ amount, currency }`.
- `CLAUDE.md` §2: *"Ausencia de mecanismo no es prohibición."*

## En vuelo (incompleto)

**Nada de S0.2.** El paquete está cerrado: 165 propiedades verdes, `pnpm verify` verde,
sin `TODO` ni andamios. `not-implemented.ts` fue eliminado.

Lo único abierto es la rama: `s0/skeleton-and-money` **no está mergeada a `main`**. Falta abrir
el PR y mergear.

## Decisiones tomadas

| Decisión | ADR |
|---|---|
| `dependency-cruiser` como gate; `core` como kernel; `money/format` como subpath | ADR-0021 |
| `apps/mobile` dentro del workspace, con criterio de salida escrito | ADR-0022 |
| `Money` separado de `ExactMoney`; solo se sale redondeando | ADR-0023 |

Menores, sin ADR: Node `>=22.11 <27` en local con CI pinneado a 22; sin project references de
TypeScript (Turborepo ordena con `dependsOn: ["^build"]`); paquetes consumidos compilados
(`dist` + `exports`), nunca por `tsconfig.paths`.

## Decisiones pendientes del usuario

1. **`MonetaryFact` no lleva `policy.id`.** `MONEY_AND_ROUNDING_SPEC.md` §5 dice que se persiste
   junto al importe y la regla 3 de `CLAUDE.md` exige versión de reglas, pero ADR-0020 fija
   **siete** campos. Añadir un octavo es decisión de contrato. **Hay que resolverlo antes de
   S0.3**, que es quien creará las tablas.
2. **`allocate` rechaza pesos negativos.** Una factura con línea de descuento es un vector de
   signo mixto. `packages/fiscal` se lo va a encontrar; decidir si se admite o si el descuento
   se modela aparte.
3. **`ResidualAllocation` sin implementar.** `allocate` reparte por mayor resto, que no es
   ninguno de los cuatro modos de §6.3. Con pesos iguales degenera en `FIRST_LINE`; con `[1,2]`
   el céntimo cae en la segunda línea.

## Bloqueantes

`VALIDAR-TRIBUTARIO` abiertos en `MONEY_AND_ROUNDING_SPEC.md` §6 — modo y escala de redondeo por
moneda, impuesto, documento y pago. **No bloquean S0.3 ni S0.4**: la política se inyecta y el
paquete prueba los cinco modos por igual. Bloquean liberar cálculo fiscal productivo.

`VALIDAR-SENIAT` de `OPEN_QUESTIONS.md`: sin efecto sobre Sprint 0.

**Límites conocidos anotados en ADR-0023:** más allá de 50 dígitos significativos `decimal.js`
redondea en silencio y no hay guardia; el oráculo BigInt de P5e compara a 10⁻²⁰.

## Siguiente paso concreto

**Resolver la pregunta de `policy.id` en `MonetaryFact` (arriba, punto 1) y escribir la migración
`0001_create_organizational_identity.sql` con el subagente `migration-author`: `tenants`,
`companies`, `branches`, `warehouses`, `registers`, más `memberships`, `roles`, `permissions`,
`role_permissions`, `user_role_assignments` y `scope_bindings`, con RLS habilitada *y forzada* en
todas y las funciones `platform.ladino_company_ids()` y `platform.ladino_has_permission(perm, company_id)`.**

Lectura obligatoria antes de escribir una línea de SQL (usa `spec-explorer` para no llenar el
contexto principal):

- `docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md` — el modelo de aislamiento y el de permisos
- `docs/04_PLATFORM/SUPABASE_DESIGN.md` — convenciones de RLS y de funciones `auth.*`
- `docs/04_PLATFORM/DATABASE_SCHEMA.md` — nomenclatura y columnas obligatorias
- `docs/03_MODULES/COMPANIES_BRANCHES_WAREHOUSES_SPEC.md` — la jerarquía organizacional
- ADR-0006 (append-only), ADR-0014 (permisos desde memberships, **no** del JWT), ADR-0019
  (expand/contract)
- `docs/00_GOVERNANCE/ENGINEERING_STANDARDS.md` §SQL — FK reales, `CHECK` para todo enumerado,
  índices `(tenant_id, company_id)`, UUID v7

Además, `platform.reject_mutation()` para las tablas append-only que llegan en S0.4, y el test
pgTAP que exige S0.3: **un usuario de la empresa A no ve nada de la empresa B, ni leyendo ni
escribiendo**. Hecho cuando `supabase test db` pasa y `rls-security-auditor` reporta cero tablas
sin RLS.

Nota operativa: `pnpm verify` **no** incluye todavía `migration test` ni `pgTAP`. S0.3 tiene que
añadirlos, y con ellos actualizar `CLAUDE.md` §5, que hoy documenta por qué están fuera.

## Estado del repo

- **Rama:** `s0/skeleton-and-money` (adelantada a `main`; sin PR abierto).
- **Último commit:** `e6a5056` — `feat(s0.2): implement packages/money; split Money from ExactMoney`.
- **`main`:** `411e252` — solo documentación y ADR-0021/0022. ADR-0023 está en la rama.
- **Migraciones aplicadas:** 0.
- **`pnpm verify`:** ✅ verde, 7 pasos, 60 tareas.
- **CI:** verde en los 8 jobs.
- **Tests:** 165 en `packages/money`, 8 en `packages/core`, 13 triviales de placeholder.

### Trampas del entorno, para no volver a tropezar

- `dependency-cruiser` **no lee el campo `exports`** salvo que se le pase
  `enhancedResolveOptions.exportsFields: ["exports"]`. Sin eso el gate da verde con las reglas
  inertes; lo único que lo delata es `no-unresolvable`.
- El heredoc de Git Bash en Windows se come un nivel de escape. Para tocar expresiones regulares
  con `\u`, usa la herramienta de edición, no `node - <<EOF`.
- Node local es 26; CI corre en 22. Si algo diverge, **gana CI**.
