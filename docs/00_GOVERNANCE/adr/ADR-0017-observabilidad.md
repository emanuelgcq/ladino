# ADR-0017 — Observabilidad con OpenTelemetry y logs estructurados

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** NO

## Decisión
Trazas OTel en `api`, `worker` y `fiscal`. Logs JSON con `request_id`, `tenant_id`, `company_id`,
`user_id`, `use_case`, `entity_id`, `duration`, `result`. Sentry para errores.

**Nunca** se loguea el payload fiscal completo ni datos personales innecesarios.

Alertas P1: emisión fiscal caída, fallo de integrity check, backup fallido, conflicto de
secuencia fiscal, DLQ creciendo.

## Consecuencias
- (+) Un incidente fiscal se reconstruye sin adivinar.
- (−) Coste de almacenamiento y de disciplina en redacción de logs. La alternativa —depurar a
  ciegas un descuadre contable de hace tres semanas— es peor.
