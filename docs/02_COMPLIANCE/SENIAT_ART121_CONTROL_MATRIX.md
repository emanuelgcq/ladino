# Matriz de controles — PA121

| Requisito | Control Ladino | Evidencia |
|---|---|---|
| Integridad | FK/checks + hash | pruebas DB + auditoría |
| Continuidad | HA/backups/contingencia | DR test |
| Confiabilidad | transacciones ACID | test integración |
| Conservación | retención + backups | política |
| Accesibilidad | audit UI/API | demo |
| Legibilidad | formatos humanos/export | PDF/JSON |
| Trazabilidad | audit events | timeline |
| Inalterabilidad | append-only/DB grants | test de rechazo |
| Inviolabilidad | RBAC/RLS/secrets | pentest |
| Remisión | adapter SENIAT configurable | sandbox |
| Registro eventos | event ledger | catálogo |
| Corrección con NC/ND | state machine | E2E |
| Fecha/hora | server timestamp | test |
| IVA | tax engine versionado | golden tests |
| Acceso SENIAT | rol + API consulta | demo |
| Nueva versión | release gate | release manifest |

## Prueba negativa esencial
Intentar `UPDATE/DELETE` sobre documento fiscal emitido debe fallar a nivel de servicio y, para tablas críticas, también por controles DB.
