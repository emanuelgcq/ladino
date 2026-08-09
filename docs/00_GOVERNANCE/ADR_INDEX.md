# ADR Index — Ladino

Los ADR viven en `docs/00_GOVERNANCE/adr/`. Crea uno nuevo ante **cualquier** cambio que afecte
persistencia, fiscalidad, sincronización offline, seguridad o el contrato de la API.
Usa la skill `adr` de Claude Code.

| ADR | Decisión | Estado | Impacto fiscal |
|---|---|---|---|
| [0001](adr/ADR-0001-monorepo-pnpm-turborepo.md) | Monorepo pnpm + Turborepo, solo pnpm | Aceptado | NO |
| [0002](adr/ADR-0002-supabase-gestionado.md) | Supabase gestionado como system of record | Aceptado | SÍ |
| [0003](adr/ADR-0003-fiscal-bounded-context.md) | Fiscal como bounded context con release train propio | Aceptado | SÍ |
| [0004](adr/ADR-0004-contrato-openapi-desde-zod.md) | OpenAPI generado desde Zod | Aceptado | NO |
| [0005](adr/ADR-0005-transactional-outbox.md) | Transactional outbox | Aceptado | SÍ |
| [0006](adr/ADR-0006-ledger-append-only.md) | Append-only con trigger + RLS | Aceptado | SÍ |
| [0007](adr/ADR-0007-expo-mobile.md) | Expo para mobile | Aceptado | SÍ |
| [0008](adr/ADR-0008-docker-hostinger-traefik.md) | Docker en VPS tras Traefik existente | Aceptado | NO |
| [0009](adr/ADR-0009-release-train-fiscal.md) | Release train fiscal con gate automático | Aceptado | SÍ |
| [0010](adr/ADR-0010-claude-no-autoritativo.md) | IA propone, nunca dispone | Aceptado | SÍ |
| [0011](adr/ADR-0011-vite-react-router.md) | Webapp con Vite (no Next.js) | Aceptado | NO |
| [0012](adr/ADR-0012-hono-api.md) | API con Hono sobre Node 22 | Aceptado | NO |
| [0013](adr/ADR-0013-decimal-js.md) | Decimal + numeric(24,8) + JSON string | Aceptado | SÍ |
| [0014](adr/ADR-0014-auth-claims-hook.md) | Permisos resueltos desde memberships, no del JWT | Aceptado | NO |
| [0015](adr/ADR-0015-zod-schemas-compartidos.md) | Zod como definición única | Aceptado | NO |
| [0016](adr/ADR-0016-testing.md) | Estrategia de pruebas por capa, TDD en dominio financiero | Aceptado | SÍ |
| [0017](adr/ADR-0017-observabilidad.md) | OpenTelemetry + logs estructurados | Aceptado | NO |
| [0018](adr/ADR-0018-idempotencia.md) | Idempotencia obligatoria por clave | Aceptado | SÍ |
| [0019](adr/ADR-0019-migraciones-expand-contract.md) | Expand/contract, nunca destructivo en un paso | Aceptado | SÍ |
| [0020](adr/ADR-0020-multimoneda.md) | Multimoneda con moneda funcional y trazabilidad de tasa | Aceptado | SÍ |
| [0021](adr/ADR-0021-fronteras-dependency-cruiser.md) | Fronteras con dependency-cruiser; `core` como kernel; `money/format` como subpath | Aceptado | NO |
| [0022](adr/ADR-0022-mobile-dentro-del-workspace.md) | `apps/mobile` dentro del workspace, con criterio de salida escrito | Aceptado | NO |
| [0023](adr/ADR-0023-money-y-exactmoney.md) | `Money` (persistible) separado de `ExactMoney` (calculado); solo se sale redondeando | Aceptado | SÍ |
| [0024](adr/ADR-0024-politica-de-redondeo-en-el-hecho-monetario.md) | `MonetaryFact` pasa a ocho campos: la política de redondeo se persiste (amplía ADR-0020) | Aceptado | SÍ |

## Decisiones aún abiertas

No tienen ADR porque dependen de respuestas externas. Ver `OPEN_QUESTIONS.md`.

- Proveedor de imprenta digital.
- Residencia de datos exigida para homologación (afecta a ADR-0002).
- Si la frontera de bounded context fiscal es aceptada por SENIAT (afecta a ADR-0003).
- Si un build Expo que emite entra en el alcance de homologación (afecta a ADR-0007).
- Nómina en P1 o P2.
- Soporte de balanzas e impresoras fiscales físicas.
