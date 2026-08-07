# Mapa de contexto — qué leer antes de cada tarea

Ladino tiene más de 100 documentos. Leerlos todos en una sesión llena el contexto y deja sin
espacio para el trabajo. Esta tabla dice qué es **suficiente** para cada tipo de tarea.

Para investigaciones amplias, delega en el subagente `spec-explorer`: lee en su propio contexto
y devuelve solo la síntesis.

## Siempre

- `/CLAUDE.md` (raíz) — se carga automáticamente.
- El `CLAUDE.md` del paquete que estás tocando — también automático.

## Por tipo de tarea

| Tarea | Lectura mínima |
|---|---|
| Bootstrap / infraestructura inicial | `SPRINT_0_BOOTSTRAP.md`, `MONOREPO_STRUCTURE.md`, `ENGINEERING_STANDARDS.md`, ADR-0001/0002/0011/0012 |
| Nueva tabla o migración | `04_PLATFORM/SUPABASE_DESIGN.md`, `04_PLATFORM/MULTITENANCY_AND_RBAC.md`, `04_PLATFORM/DATABASE_SCHEMA.md`, ADR-0006/0019 |
| Cualquier cosa con montos | `04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md`, `03_MODULES/PRICING_MULTICURRENCY_SPEC.md`, ADR-0013/0020 |
| Asientos, mayor, cierres | `03_MODULES/ACCOUNTING_ENGINE_SPEC.md`, `03_MODULES/JOURNAL_AND_CLOSING_SPEC.md`, `03_MODULES/CHART_OF_ACCOUNTS_SPEC.md`, `06_QA/ACCOUNTING_INVARIANTS_TESTS.md` |
| Facturación, impuestos, libros | **toda** `02_COMPLIANCE/` + `04_PLATFORM/AUDIT_TRAIL_AND_IMMUTABILITY.md` + ADR-0003/0009 |
| Inventario | `03_MODULES/INVENTORY_SPEC.md`, `03_MODULES/WAREHOUSE_OPERATIONS_SPEC.md`, `04_PLATFORM/STATE_MACHINES.md` |
| Ventas / CxC | `03_MODULES/SALES_AND_AR_SPEC.md`, `03_MODULES/QUOTES_ORDERS_DELIVERY_SPEC.md`, `03_MODULES/CREDIT_MANAGEMENT_SPEC.md` |
| Compras / CxP | `03_MODULES/PURCHASES_AND_AP_SPEC.md`, `03_MODULES/SUPPLIERS_SPEC.md`, `03_MODULES/IMPORTS_PURCHASES_SPEC.md` |
| Tesorería | `03_MODULES/TREASURY_BANKING_SPEC.md`, `03_MODULES/CASH_MANAGEMENT_SPEC.md` |
| POS | `03_MODULES/POS_SPEC.md`, `04_PLATFORM/FISCAL_PRINTERS_AND_DIGITAL_PRINTERS.md`, `08_UX/UX_FLOWS.md` |
| Endpoint nuevo | `04_PLATFORM/API_SPEC.md`, `04_PLATFORM/SECURITY.md`, ADR-0004/0018 |
| Pantalla web | `04_PLATFORM/WEBAPP_SPEC.md`, `08_UX/INFORMATION_ARCHITECTURE.md`, `08_UX/ROLE_BASED_DASHBOARDS.md` |
| Pantalla mobile | `04_PLATFORM/MOBILE_EXPO_SPEC.md`, `08_UX/MOBILE_UX_RULES.md`, `04_PLATFORM/OFFLINE_AND_SYNC_SPEC.md` |
| Eventos / worker | `04_PLATFORM/EVENT_CATALOG.md`, ADR-0005 |
| Deploy | `05_INFRA/DOCKER_AND_HOSTINGER_DEPLOYMENT.md`, `05_INFRA/DEVOPS_CI_CD.md`, `05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md` |
| Importar datos de un sistema legado | `07_MIGRATION/` completo |
| Cerrar una historia | `DEFINITION_OF_DONE.md` |

## Señal de parada

Si la tarea requiere un dato tributario que no encuentras en `02_COMPLIANCE/` con su fuente
citada: **para**. Emite `VALIDAR-SENIAT` o `VALIDAR-TRIBUTARIO` y pregunta.
Un supuesto plausible sobre una alícuota es peor que un bloqueo declarado.
