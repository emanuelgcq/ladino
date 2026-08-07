# ADR-0009 — Release train fiscal independiente con gate de homologación

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Decisión
Cada release publica un manifest: semver, git SHA, digest de imagen, rango de migraciones,
`fiscal_protocol_version`, versión mínima de mobile y `homologation_status`
(`development → QA → candidate → submitted → homologated → production → retired`).

Si `fiscal_behavior_changed = true`, la promoción a producción fiscal queda **bloqueada
automáticamente en CI** hasta que el estado sea `homologated`.

## Consecuencias
- (+) El gate es mecánico, no depende de que alguien recuerde.
- (−) Trabajo fiscal terminado puede quedar en espera semanas. Se planifica con antelación.
- (−) **`VALIDAR-SENIAT`**: usar feature flags para ocultar código fiscal no homologado dentro
  de un artefacto homologado **no** se asume permitido. Hasta tener criterio formal, el código
  fiscal no homologado no se incluye en el artefacto de producción.
