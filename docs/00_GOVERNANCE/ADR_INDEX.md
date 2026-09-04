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
| [0025](adr/ADR-0025-modelo-rbac-y-aislamiento.md) | Modelo RBAC con `requires_scope`; `permissions` global; por qué la inmutabilidad es un trigger y no una policy | **Propuesto** | NO |
| [0026](adr/ADR-0026-auditoria-outbox-e-idempotencia.md) | Esquema de `audit_events`, `outbox` e `idempotency_keys` | Aceptado | SÍ |
| [0027](adr/ADR-0027-la-regulacion-es-dato.md) | La regulación es dato, no código | Aceptado | SÍ |
| [0028](adr/ADR-0028-transmision-seniat-como-consumidor-de-outbox.md) | Transmisión SENIAT como consumidor de outbox tras interfaz (`NullTransmitter` hoy) | Aceptado | SÍ |
| [0029](adr/ADR-0029-regimen-fiscal-como-dato-por-empresa.md) | Régimen fiscal como dato versionado por empresa | Aceptado | SÍ |
| [0030](adr/ADR-0030-operador-de-plataforma-y-soporte.md) | Operador de plataforma con alcance acotado | Aceptado | NO |
| [0031](adr/ADR-0031-roles-de-servicio-sin-bypassrls.md) | Roles de servicio sin `BYPASSRLS`: la RLS también contiene a la API y al worker | Aceptado | NO |
| [0032](adr/ADR-0032-precios-append-por-vigencia.md) | Precios por vigencia, append-only estructural, la fecha como parámetro | Aceptado | NO |
| [0033](adr/ADR-0033-contrapartes-clasificacion-fiscal-y-rif.md) | Contrapartes: clasificación fiscal por catálogos globales y RIF auditado con valor anterior | Aceptado | NO |
| [0034](adr/ADR-0034-inventario-costeo-promedio-y-kardex-materializado.md) | Inventario: promedio ponderado móvil, kardex append-only materializado y transferencia atómica | Aceptado | NO |
| [0035](adr/ADR-0035-recetas-y-unidades-fraccionadas.md) | Productos compuestos: recetas de ingredientes y unidades fraccionadas | Aceptado | NO |
| [0036](adr/ADR-0036-variantes-como-productos-derivados.md) | Variantes de producto como productos derivados, no como dimensión de existencias | Aceptado | NO |
| [0037](adr/ADR-0037-numeracion-fiscal-correlativo-y-numero-de-control.md) | Numeración fiscal: el correlativo del emisor y el número de control son dos campos | Aceptado | SÍ |
| [0038](adr/ADR-0038-motor-tributario-con-catalogo-vacio.md) | Motor tributario: reglas como dato, catálogo vacío, sin emisión sin regla | Aceptado | SÍ |
| [0039](adr/ADR-0039-retenciones-con-catalogo-vacio-y-formulas-cerradas.md) | Retenciones con catálogo vacío y fórmulas cerradas | Aceptado | SÍ |
| [0040](adr/ADR-0040-compras-tablas-propias-y-landed-cost-con-variacion.md) | Compras con tablas propias; landed cost tardío genera variación | Aceptado | SÍ |
| [0041](adr/ADR-0041-mapeo-contable-como-vocabulario-cerrado.md) | Mapeo contable como vocabulario cerrado de propósitos | Aceptado | SÍ |
| [0042](adr/ADR-0042-cola-de-contabilizacion-pendiente.md) | Cola de contabilización pendiente: documento posteado ⇒ asiento o cola | Aceptado | SÍ |
| [0043](adr/ADR-0043-chart-templates-como-catalogo-global-importable.md) | Plantillas de plan de cuentas como catálogo global importable | Aceptado | SÍ |
| [0044](adr/ADR-0044-libros-fiscales-como-vista-sobre-snapshot-ampliado.md) | Libros fiscales como consulta sobre snapshot ampliado, nunca tabla | Aceptado | SÍ |
| [0045](adr/ADR-0045-adaptador-de-imprenta-digital-como-puerto.md) | Adaptador de imprenta digital como puerto; hoy NullDigitalPrintShop que rechaza | Aceptado | SÍ |

## Decisiones aún abiertas

No tienen ADR porque dependen de respuestas externas. Ver `OPEN_QUESTIONS.md`.

- Proveedor de imprenta digital.
- Residencia de datos exigida para homologación (afecta a ADR-0002).
- Si la frontera de bounded context fiscal es aceptada por SENIAT (afecta a ADR-0003).
- Si un build Expo que emite entra en el alcance de homologación (afecta a ADR-0007).
- Nómina en P1 o P2.
- Soporte de balanzas e impresoras fiscales físicas.
