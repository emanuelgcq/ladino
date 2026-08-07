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
- verificación periódica de cadena;
- export de evidencia.

## Importante
Hash encadenado es recomendación Ladino para demostrar integridad; PA121 exige resultado de integridad/inalterabilidad, no prescribe ese algoritmo.
