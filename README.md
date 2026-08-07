# Ladino

Plataforma administrativa, contable y fiscal **cloud-first** para Venezuela.

- **Webapp** responsive (Vite + React).
- **App móvil** Expo / React Native.
- **Servicios** en contenedores Docker sobre VPS Hostinger, detrás del Traefik existente.
- **Datos** en Supabase gestionado (Postgres, Auth, Storage).
- **Sin cliente desktop.**

## Objetivo

Competir con las capacidades administrativas de Fina/FinaPartner, Gálac, Valery y Stellar, con
arquitectura moderna, UX cloud-first, trazabilidad fiscal fuerte y separación estricta entre:

1. operación administrativa;
2. contabilidad formal de partida doble;
3. motor tributario versionado;
4. emisión fiscal homologable;
5. auditoría e integridad;
6. automatización/IA **no autoritativa**.

## Estado

**Sprint 0 — bootstrap.** No hay código de negocio todavía.
Empieza por [`docs/00_GOVERNANCE/SPRINT_0_BOOTSTRAP.md`](docs/00_GOVERNANCE/SPRINT_0_BOOTSTRAP.md).

> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación
> jurídica queda hard-coded sin una fuente normativa versionada. Los puntos marcados
> `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal
> antes de producción u homologación.

## Principios no negociables

1. Una factura fiscal emitida no se edita ni se elimina.
2. Un asiento `posted` no se modifica: se revierte y se genera uno nuevo.
3. Todo documento fiscal y movimiento contable conserva autor, fecha/hora, origen y versión de reglas.
4. Toda operación crítica es idempotente.
5. Cada registro pertenece explícitamente a un tenant/empresa.
6. La contabilidad siempre cumple `débitos = créditos`.
7. Nunca `float` para dinero: `numeric(24,8)` y `Decimal`.
8. Las tasas tributarias y cambiarias son efectivas por fecha y fuente.
9. Los despliegues que cambien comportamiento fiscal pasan por el gate de homologación.
10. La app móvil no es una vía para emitir documentos fuera de los controles del backend.

## Desarrollo con Claude Code

Este repositorio está preparado para desarrollo asistido. La capa `.claude/` (permisos, hooks,
subagentes y skills) es parte de la ingeniería del proyecto, no un accesorio.

- Instrucciones raíz: [`CLAUDE.md`](CLAUDE.md)
- Cómo se trabaja: [`docs/00_GOVERNANCE/AI_ASSISTED_DEVELOPMENT.md`](docs/00_GOVERNANCE/AI_ASSISTED_DEVELOPMENT.md)
- Qué leer antes de cada tarea: [`docs/00_GOVERNANCE/CONTEXT_MAP.md`](docs/00_GOVERNANCE/CONTEXT_MAP.md)

Los hooks de `.claude/hooks/` **bloquean** (no solo desaconsejan): `float` para dinero,
`service_role` en cliente, edición de migraciones aplicadas, mutación de tablas append-only,
tasas hard-coded en la UI y cualquier comando que toque n8n o Traefik.

## Documentación

| Carpeta | Contenido |
|---|---|
| `docs/00_GOVERNANCE/` | visión, PRD, alcance, roadmap, estándares, ADRs, riesgos, preguntas abiertas |
| `docs/01_RESEARCH/` | competencia, matriz de funcionalidades, benchmarks de UX |
| `docs/02_COMPLIANCE/` | IVA, ISLR, IGTF, retenciones, SENIAT, homologación, libros fiscales |
| `docs/03_MODULES/` | especificaciones funcionales por módulo |
| `docs/04_PLATFORM/` | arquitectura, esquema, API, Supabase, seguridad, mobile, offline |
| `docs/05_INFRA/` | Docker/Hostinger, CI/CD, observabilidad, backups, versionado |
| `docs/06_QA/` | estrategia de pruebas, invariantes contables, escenarios fiscales E2E |
| `docs/07_MIGRATION/` | importación desde sistemas legados |
| `docs/08_UX/` | arquitectura de información, flujos, dashboards por rol |

## Primera decisión de arquitectura

La emisión fiscal es un **bounded context aislado** con release train propio (ADR-0003).
Permite evolucionar UI, CRM, inventario y analítica sin que cada despliegue implique tocar el
componente fiscal homologado. La frontera exacta debe validarse con SENIAT.
