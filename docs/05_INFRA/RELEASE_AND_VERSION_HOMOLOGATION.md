# Versiones y homologación

> **Desde S0.6a el manifest EXISTE y se puebla desde la primera release:**
> `releases/manifest.json`, mantenido por `scripts/release-manifest.mjs`
> (`pnpm release:manifest new <version>`, `… digest <version> <servicio> <sha256>`), y
> **`pnpm release:manifest:check` es paso de `pnpm verify`**: falla si una migración cubierta
> por la última release cambió de contenido (ADR-0019), o si HEAD está etiquetado con
> migraciones sin registrar. La release `0.1.0` es la línea base **retroactiva** de Sprint 0,
> registrada antes de construir la primera imagen para que el historial no sea inferencia
> (ADR-0027 §5, entregable 2).
>
> `homologation_status` vale `not_applicable` mientras no exista régimen al que reportar
> (PA121 derogada). El gate de CI de `fiscal_behavior_changed` sigue **diferido** (S0.6b): sin
> régimen, un gate que bloquea contra nada solo entrena a ignorarlo. El campo se registra igual.

## Version manifest
Cada release:
- semantic version;
- git SHA;
- docker digest;
- DB migration range;
- fiscal protocol version;
- mobile min version;
- homologation_status.

## Estados
development → QA → candidate → submitted → homologated → production → retired.

## Gate
Si `fiscal_behavior_changed=true`, producción fiscal queda bloqueada hasta resolución del proceso aplicable.

## Feature flags
No deben usarse para esconder de SENIAT código fiscal no homologado dentro del mismo artefacto sin criterio formal. `VALIDAR-SENIAT`.
