# Ladino — instrucciones de trabajo

Ladino es una plataforma administrativa, contable y fiscal **cloud-first** para Venezuela.
Webapp + app Expo + servicios en contenedores. **No existe cliente desktop.**

Idioma: **código, identificadores y commits en inglés; comentarios, docs y UI en español.**

---

## 1. Las 10 reglas que no se negocian

1. Una factura fiscal emitida **no se edita ni se borra**. Se corrige con nota de crédito/débito.
2. Un asiento `posted` **no se actualiza**. Se revierte y se genera uno nuevo.
3. Todo documento fiscal y movimiento contable guarda autor, timestamp, origen y **versión de reglas**.
4. Toda operación crítica es **idempotente** (`Idempotency-Key` obligatorio).
5. Todo registro pertenece explícitamente a un `tenant_id`. Sin excepción.
6. La contabilidad siempre cumple `sum(debit) = sum(credit)` por asiento.
7. **Nunca `float`/`number` para dinero.** Postgres `numeric(24,8)`, TypeScript `Decimal`, JSON `string`.
8. Tasas tributarias y cambiarias son **efectivas por fecha y fuente**. Nunca hard-coded.
9. Cambios de comportamiento fiscal pasan por el gate de homologación antes de producción.
10. La app móvil **no** es una vía para saltarse los controles del backend.

## 2. Prohibiciones duras (hay hooks que las bloquean)

- `service_role` key en `apps/web`, `apps/mobile` o cualquier bundle de cliente.
- Editar una migración ya aplicada en `supabase/migrations/`.
- `UPDATE`/`DELETE` sobre `journal_lines`, `fiscal_events`, `inventory_moves`, `audit_events`.
- Lógica tributaria dentro de componentes React o pantallas Expo.
- Inventar una tasa, alícuota, formato de archivo SENIAT u obligación legal. Si no está en
  `docs/02_COMPLIANCE/` con fuente citada, **se marca `VALIDAR-SENIAT` y se para**.
- Tocar, reiniciar o reconfigurar el contenedor **n8n** del VPS. Es infraestructura ajena a Ladino.
- `docker compose down` global, `docker system prune`, `docker network rm` en el VPS.
- `git push --force`, `git commit` o deploy sin aprobación explícita del usuario en el mensaje.

**Ausencia de mecanismo no es prohibición.** Si algo no debe poder hacerse, tiene que fallar
activamente, no depender de que el método no exista.

## 3. Cómo trabajar en este repo

**Siempre en este orden. No saltes pasos.**

1. **Investigar primero.** Lee las specs relevantes antes de escribir código.
   Usa el subagente `spec-explorer` para no llenar el contexto principal.
2. **Plan mode.** Presenta plan: archivos, migraciones, tests, riesgos, `HOMOLOGATION_IMPACT`.
3. **Esperar aprobación explícita.** No implementes hasta que el usuario diga que sí.
4. **Test primero** en todo lo que toque dinero, stock o documentos fiscales.
5. **Implementar** en incrementos verificables.
6. **Verificar**: `pnpm verify` debe pasar en verde.
7. **Reportar** con el formato de entrega (sección 6).

### Qué leer según la tarea

| Si tocas… | Lee obligatoriamente |
|---|---|
| Cualquier cosa | Este archivo + `docs/00_GOVERNANCE/CONTEXT_MAP.md` |
| Dinero / montos | `docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md`, `docs/06_QA/ACCOUNTING_INVARIANTS_TESTS.md` |
| Asientos / cierres | `docs/03_MODULES/ACCOUNTING_ENGINE_SPEC.md`, `docs/03_MODULES/JOURNAL_AND_CLOSING_SPEC.md` |
| Facturación / impuestos | `docs/02_COMPLIANCE/` completo + `docs/02_COMPLIANCE/SENIAT_COMPLIANCE_AND_HOMOLOGATION.md` |
| Migraciones / RLS | `docs/04_PLATFORM/SUPABASE_DESIGN.md`, `docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md` |
| Inventario | `docs/03_MODULES/INVENTORY_SPEC.md`, `docs/03_MODULES/WAREHOUSE_OPERATIONS_SPEC.md` |
| Mobile | `docs/04_PLATFORM/MOBILE_EXPO_SPEC.md`, `docs/08_UX/MOBILE_UX_RULES.md` |
| Deploy | `docs/05_INFRA/DOCKER_AND_HOSTINGER_DEPLOYMENT.md` |
| Decisiones estructurales | `docs/00_GOVERNANCE/adr/` — y **crea un ADR nuevo** |

## 4. Stack (ver `docs/00_GOVERNANCE/adr/` para el porqué)

| Capa | Elección |
|---|---|
| Monorepo | pnpm workspaces + Turborepo, TypeScript `strict` |
| Web | Vite + React + React Router (data mode) + TanStack Query |
| Mobile | Expo (SDK actual) + React Native, New Architecture ON |
| API | Hono sobre Node 22, contrato OpenAPI generado desde Zod |
| Datos | Supabase gestionado (Postgres, Auth, Storage, Realtime) |
| Servicios | Docker en VPS Hostinger detrás del **Traefik ya existente** |
| Dinero | `decimal.js` en TS, `numeric(24,8)` en Postgres |
| Validación | Zod, esquemas compartidos en `packages/schemas` |
| Tests | Vitest, pgTAP (RLS), Playwright (E2E), Maestro (mobile) |
| Observabilidad | OpenTelemetry + Sentry + logs estructurados |

## 5. Comandos

```bash
pnpm install              # instalar (lockfile obligatorio, solo pnpm)
pnpm dev                  # entorno local completo
pnpm verify               # el gate real. 7 pasos, en este orden:
                          #   1. format:check   prettier --check
                          #   2. boundaries     dependency-cruiser (ADR-0021)
                          #   3. lint           eslint
                          #   4. typecheck      tsc -b --noEmit
                          #   5. test           vitest (property-based de money incluido)
                          #   6. build          tsc -b
                          #   7. api-surface    ningún `number` en la API pública de money
pnpm test:rls             # pgTAP contra la base local
pnpm db:new <nombre>      # nueva migración (nunca editar una aplicada)
pnpm db:reset             # reset local + seed
pnpm openapi              # regenerar openapi.json desde los schemas
```

`verify` reproduce el **núcleo** del pipeline de `DEVOPS_CI_CD.md`, no el pipeline entero.
`migration test`, `pgTAP`, `integration` y `openapi:check` son bloqueantes en CI pero quedan
fuera de `verify` hasta que S0.3 y S0.5 los hagan existir: un gate que falla por algo que
todavía no se construyó solo entrena a ignorarlo.

## 6. Formato de entrega (todas las tareas)

```
RESUMEN        — qué se hizo, en 3 líneas
ARCHIVOS       — creados / modificados / eliminados
MIGRACIONES    — nombre + reversibilidad
TESTS          — qué se agregó y qué cubre
RIESGOS        — qué puede romperse
HOMOLOGATION_IMPACT = YES | NO
VALIDAR-*      — puntos que requieren confirmación humana antes de producción
```

## 7. Fronteras del código

- `packages/core` — `Result`, `DomainError`, `Brand`, `Instant`. **Cero dependencias.** Todos pueden importarlo.
- `packages/accounting` — invariantes de partida doble. Puro. Sin I/O.
- `packages/fiscal` — documentos, numeración, eventos, adapters de imprenta. **Release train propio.**
- `packages/money` — Decimal, redondeo, FX. Puro. Solo importa `core`.
- `packages/domain` — casos de uso administrativos transaccionales.
- `apps/api` — orquestación, permisos, idempotencia. No contiene reglas de negocio.
- `apps/worker` — outbox, jobs, reintentos.
- `apps/web` / `apps/mobile` — **cero reglas tributarias**. Solo presentación y llamadas a la API.
  De dinero solo pueden importar `@ladino/money/format`, nunca la raíz `@ladino/money`.

La tabla completa y su gate (`dependency-cruiser`) están en
`docs/00_GOVERNANCE/MONOREPO_STRUCTURE.md` y ADR-0021.

Ninguna UI persiste "estado final" de dinero, stock o documentos fiscales. Siempre invoca un caso
de uso de dominio transaccional que valide permisos → bloquee → calcule → persista → audite →
emita evento outbox → confirme commit.

## 8. Subagentes disponibles

`spec-explorer` · `migration-author` · `accounting-invariants` · `fiscal-reviewer` ·
`rls-security-auditor` · `mobile-expo`

Delega a ellos las tareas de lectura amplia y revisión. El contexto principal es para decidir.

## 9. Estado del proyecto

Fase actual: **Sprint 0 — bootstrap.** Nada está construido todavía.
Antes de escribir la primera línea de código de negocio, revisa
`docs/00_GOVERNANCE/SPRINT_0_BOOTSTRAP.md` y `docs/00_GOVERNANCE/OPEN_QUESTIONS.md`.

Los bloqueantes SENIAT de `OPEN_QUESTIONS.md` **no impiden** construir Fases 1–3.
Sí impiden liberar emisión fiscal productiva.
