# Matriz de controles — PA121

> # ⛔ DOCUMENTO HISTÓRICO — PA121 DEROGADA
>
> **PA SNAT/2024/000121 fue derogada por PA SNAT/2026/00084**, Gaceta Oficial N.º 43.435 del
> **12/08/2026**, sin norma sustituta. **Ninguna fila de esta matriz es exigible hoy.**
>
> Se conserva porque sigue siendo útil por dos motivos distintos de aquel para el que se escribió:
>
> 1. **Es el diff de referencia** si la 121 vuelve reformada.
> 2. **La columna del medio no caducó.** Los controles —append-only, RLS, transacciones ACID,
>    versionado de reglas, event ledger— siguen construidos y siguen siendo buenos controles de
>    ERP. Lo que caducó es la columna de la izquierda: la obligación legal de demostrarlos ante un
>    evaluador. Se mantienen porque un ERP contable sin trazabilidad no es vendible, no porque una
>    providencia lo mande. Ver ADR-0027.
>
> Estado vigente en `REGULATORY_STATUS.md`.

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
