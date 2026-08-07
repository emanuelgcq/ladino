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

- `tenants`, `companies`, `branches`, `warehouses`, `registers`.
- `memberships`, `roles`, `permissions`, `role_permissions`, `user_role_assignments`, `scope_bindings`.
- Funciones `auth.ladino_company_ids()` y `auth.ladino_has_permission(perm, company_id)`.
- RLS habilitado **y forzado** en todas.
- Función `public.reject_mutation()` para las append-only que vendrán.

Tests pgTAP: un usuario de la empresa A no ve nada de la empresa B, ni leyendo ni escribiendo.

**Hecho cuando:** `supabase test db` pasa y el subagente `rls-security-auditor` reporta cero
tablas sin RLS.

## S0.4 — Audit log y outbox

Migración `0002`:

- `audit_events` append-only con trigger de rechazo.
- `outbox` con estado, intentos y `available_at`.
- `idempotency_keys` con índice único por `(company_id, key)`.

Test pgTAP: un `update` sobre `audit_events` como `service_role` lanza excepción.

**Hecho cuando:** la inmutabilidad es estructural, no depende del código de aplicación.

## S0.5 — Esqueleto de API y del caso de uso transaccional

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
