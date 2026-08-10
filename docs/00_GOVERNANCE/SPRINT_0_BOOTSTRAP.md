# Sprint 0 — Bootstrap

Objetivo: que exista un esqueleto que compile, se pruebe y despliegue, con el aislamiento
multi-tenant y el modelo monetario verificados **antes** de escribir un solo módulo de negocio.

No se construye ninguna funcionalidad de ERP en este sprint. Se construye el suelo.

## S0.1 — Esqueleto del monorepo

- pnpm workspaces + Turborepo, TypeScript `strict`, `packageManager` fijado.
- Todos los `apps/*` y `packages/*` creados con su `package.json`, `tsconfig` y un test trivial.
- ESLint + Prettier + reglas de frontera de import (`apps/web` no puede importar `packages/fiscal`).
- Script `pnpm verify` = lint + typecheck + test + build. Es el gate real.
- `.github/workflows/ci.yml` con ese pipeline.

**Hecho cuando:** `pnpm verify` pasa en verde en un repo vacío de lógica.

## S0.2 — `packages/money`

Primero los tests, después la implementación. Es el paquete del que depende todo lo demás.

- Tipo `Money`, `Decimal` de `decimal.js`, serialización a string.
- Redondeos nombrados: `roundForCurrency`, `roundForTax`, `roundForDocument`, `roundForPayment`.
- Conversión FX que exige `{ rate, source, timestamp }`.
- Property-based tests, incluido `0.1 + 0.2 === 0.3` exacto.

**Hecho cuando:** ningún `number` aparece en una firma pública del paquete.

## S0.3 — Identidad organizacional y aislamiento

Migración `0001`:

- `tenants`, `companies`, `branches`, `warehouses`, `cash_registers`.
- `memberships`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `scope_bindings`.
- Funciones `platform.ladino_company_ids()` y `platform.ladino_has_permission(perm, company_id)`.
- RLS habilitado **y forzado** en todas.
- Función `platform.reject_mutation()` para las append-only que vendrán.

Tests pgTAP: un usuario de la empresa A no ve nada de la empresa B, ni leyendo ni escribiendo.

**Hecho cuando:** `supabase test db` pasa y el subagente `rls-security-auditor` reporta cero
tablas sin RLS.

### Bloqueante heredado para S0.4

**Toda tabla de S0.4 tiene que nacer con `created_by`, `created_at` y `version` gobernados por
`platform.set_row_provenance()`.** No es opcional ni cosmético.

La auditoría de S0.3 encontró que esas tres columnas eran ordinarias y el cliente podía fijarlas
a lo que quisiera: insertó una fila **atribuida a otro usuario y fechada en 1999**. En tablas de
estructura el daño es acotado. **El mismo DDL sobre `audit_events` o `fiscal_events` es
falsificación de la pista de auditoría** — exactamente lo que la regla 3 de `CLAUDE.md` existe
para impedir: *"todo documento fiscal y movimiento contable guarda autor, timestamp, origen y
versión de reglas"*. Un autor que el propio actor elige no es un autor, y un log que se puede
antedatar no prueba nada.

Se arregló en la migración 5/5 para las cinco tablas de la jerarquía. **S0.4 no puede repetir el
DDL sin el trigger.**

Igual con `platform.reject_mutation()`: engancharlo `before update or delete` **y**
`before truncate ... for each statement`. `TRUNCATE` ignora la RLS y no dispara el primero.

## S0.4 — Audit log y outbox

Migración `0002`:

- `audit_events` append-only con trigger de rechazo.
- `outbox` con estado, intentos y `available_at`.
- `idempotency_keys` con índice único por `(company_id, key)`.

Test pgTAP: un `update` sobre `audit_events` como `service_role` lanza excepción.

**Hecho cuando:** la inmutabilidad es estructural, no depende del código de aplicación.

## S0.5 — Esqueleto de API y del caso de uso transaccional

### Contrato heredado de S0.3: la API declara el actor

Toda transacción que escriba fija `set local ladino.actor_id = '<uuid>'` antes del primer
`INSERT`. Sin eso, `created_by` queda `NULL` **en silencio** — no hay error, la fila se escribe,
y el vacío aparece en una auditoría meses después, sobre datos que ya no se pueden reconstruir.

Existe porque `tenants`, `companies` y todo el bloque RBAC solo se escriben con `service_role`
(ADR-0025 §9), y ahí `auth.uid()` es `NULL`.

El detalle y los cuatro puntos de verificación están en `04_PLATFORM/API_SPEC.md` §Procedencia.
El que cuenta es el test de integración: un caso de uso ejecutado sin GUC tiene que fallar,
porque es el único que recorre el mismo camino que producción.

- Hono con middleware de auth, autorización, idempotencia, request-id y logging estructurado.
- **Un** caso de uso completo de ejemplo (crear empresa) que recorra los 10 pasos del patrón.
- OpenAPI generado desde Zod y job `openapi:check` bloqueante.

**Hecho cuando:** el patrón está encarnado en código y sirve de plantilla para todo lo demás.

## S0.6 — Contenedores y despliegue

- `Dockerfile` multi-stage para `api` y `worker`.
- `infra/compose/docker-compose.ladino.yml` con project name `ladino`, red externa del proxy,
  labels de Traefik, healthchecks, `restart: unless-stopped` y **límites de CPU/memoria**.
- Nada que toque n8n ni la configuración estática de Traefik.

**Hecho cuando:** existe un `/healthz` respondiendo por HTTPS a través del Traefik existente,
y `docker stats` muestra que Ladino respeta sus límites.

## Fuera de alcance de Sprint 0

Ventas, compras, inventario, contabilidad, fiscal, webapp completa y mobile.
Nada de eso empieza hasta que S0.1–S0.6 estén en verde.

## Qué NO bloquea este sprint

Las preguntas abiertas de SENIAT en `OPEN_QUESTIONS.md` no impiden nada aquí, ni en las
Fases 1 a 3. Bloquean la liberación de emisión fiscal productiva, que está muy lejos.
Avanzar mientras se gestionan esas respuestas es lo correcto.
