# Auditoría e inmutabilidad

## Dos logs

### `audit_events`
Acciones de usuario/sistema.

### `fiscal_events`
Eventos fiscales con controles más estrictos.

Campos:
- event_id
- tenant/company
- aggregate_type/id
- event_type
- actor_type/id
- occurred_at
- server_received_at
- ip
- device/session
- app_build
- payload_json
- payload_hash
- previous_hash
- event_hash

## Controles
- append-only grants;
- API sin update/delete;
- trigger defensivo;
- backup;
- ~~verificación periódica de cadena~~ — **no implementada, y deliberadamente** (ver abajo);
- export de evidencia.

## Importante

Hash encadenado es recomendación Ladino para demostrar integridad; PA121 exige resultado de
integridad/inalterabilidad, no prescribe ese algoritmo.

> **Estado real a 2026-08-15 — leer antes de citar este documento ante un tercero.**
>
> **La cadena de hash NO está implementada en `audit_events`, y no va a estarlo.** Es la decisión
> D1 de **ADR-0026**, por una razón estructural y no de rendimiento: una cadena exige orden total
> sobre las inserciones, y eso es un punto de serialización en la tabla que más crece de la
> plataforma. No es un cuello que se optimice después con un índice mejor.
>
> Lo que hay hoy es **`payload_hash` por registro**, columna generada. Y su alcance, medido:
> **no da evidencia de manipulación**. Al ser generada, se recalcula si la fila se reescribe, de
> modo que frente a quien pueda saltarse el trigger el hash acompaña al payload alterado. La
> integridad la dan las **dos capas de prevención** —privilegios y `reject_mutation()`—, no la
> detección.
>
> Si la cadena llega a hacer falta, el diseño está escrito en ADR-0026 §D1: particionada por
> `company_id`, calculada por un **verificador asíncrono** sobre una tabla aparte, nunca en el
> camino de escritura. `fiscal_events` (Fase 11) es donde el argumento pesa más, y donde procede
> decidirla.
>
> Nota de contexto: PA121 quedó **derogada** el 12/08/2026 (PA SNAT/2026/00084) sin sustituta, así
> que la frase de arriba sobre lo que «PA121 exige» ya no describe una obligación vigente. Se
> conserva porque la conclusión no cambia y el razonamiento sigue siendo el correcto. Ver
> `docs/02_COMPLIANCE/REGULATORY_STATUS.md`.
