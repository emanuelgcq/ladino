# packages/fiscal

Bounded context fiscal. **Release train propio.** Es el único lugar del repositorio donde
vive el conocimiento de documentos fiscales, numeración y adaptadores de imprenta.

Antes de tocar cualquier archivo aquí: lee `docs/02_COMPLIANCE/` completo e invoca el
subagente `fiscal-reviewer` al terminar. Sin excepción.

## Reglas absolutas

- **Nada tributario se inventa.** Si una tasa, formato, plazo u obligación no está documentada
  con fuente normativa, se para y se emite `VALIDAR-SENIAT` o `VALIDAR-TRIBUTARIO`.
- Toda tasa vive en tabla con `effective_from`, `effective_to`, `source`, `version`.
  Cero constantes fiscales en el código.
- Numeración secuencial sin huecos, sin reutilización, asignada dentro de la transacción de
  emisión y a prueba de concurrencia.
- Documento emitido = inmutable. Corrección solo por nota de crédito o débito.
- Cada intento de emisión genera `fiscal_event` append-only: payload, respuesta, error, reintento.
- Los adaptadores de imprenta digital van detrás de una interfaz. Cambiar de proveedor no
  debe tocar el dominio.
- Contingencia definida y probada: qué ocurre si la imprenta o SENIAT no responden.

## Versionado

Todo cambio aquí evalúa `HOMOLOGATION_IMPACT`. Si es `YES`, el release fiscal queda bloqueado
hasta cerrar el proceso de `docs/05_INFRA/RELEASE_AND_VERSION_HOMOLOGATION.md`.
Los feature flags **no** sirven para ocultar código fiscal no homologado dentro de un
artefacto homologado. `VALIDAR-SENIAT`.
