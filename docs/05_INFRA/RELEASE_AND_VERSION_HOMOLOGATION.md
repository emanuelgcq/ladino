# Versiones y homologación

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
