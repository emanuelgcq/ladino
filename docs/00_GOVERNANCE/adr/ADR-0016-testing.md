# ADR-0016 — Estrategia de pruebas por capa

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Decisión

| Capa | Herramienta | Bloqueante en CI |
|---|---|---|
| Dominio puro (money, accounting, fiscal) | Vitest + fast-check (property-based) | sí |
| Migraciones y RLS | pgTAP (`supabase test db`) | sí |
| API | Vitest + Postgres efímero en contenedor | sí |
| Web E2E | Playwright | sí en flujos críticos |
| Mobile | Maestro | sí en flujos críticos |
| Carga | k6 contra objetivos de `PERFORMANCE_TEST_PLAN.md` | previo a release |

**Regla:** en `packages/money`, `packages/accounting` y `packages/fiscal` **el test se escribe
antes que la implementación**. No es una preferencia de estilo: es la única forma de que los
invariantes contables sean verificables y no aspiracionales.

Cobertura no es la métrica. La métrica es: cada invariante documentado tiene un test que lo
falsaría si se rompiera.
