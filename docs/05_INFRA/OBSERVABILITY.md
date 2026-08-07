# Observabilidad

## Logs estructurados
Campos:
request_id, tenant_id, company_id, user_id, use_case, entity_id, duration, result.

No loggear secretos ni payload fiscal completo si no es necesario.

## Métricas
- emisión fiscal success/failure;
- latencia imprenta;
- retries/DLQ;
- posting errors;
- stock conflicts;
- RLS denied;
- auth failures;
- backup age;
- worker lag.

## Traces
OpenTelemetry en API, worker y fiscal.

## Alertas
P1:
- emisión caída;
- corrupción/integrity check;
- backup fallido;
- secuencia conflictiva.
