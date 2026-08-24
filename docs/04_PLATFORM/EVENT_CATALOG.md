# Catálogo de eventos

## Fiscal
- fiscal.invoice.issuing
- fiscal.invoice.issued
- fiscal.invoice.failed
- fiscal.credit_note.issued
- fiscal.debit_note.issued
- fiscal.contingency.started
- fiscal.contingency.ended

## Accounting
- journal.posted
- journal.reversed
- period.closed
- period.reopened

## Inventory
- stock.received
- stock.shipped
- stock.transferred
- stock.adjusted

## Money
- payment.received
- payment.sent
- payment.applied
- bank.reconciled

Cada evento incluye schema version.

## Estructura organizacional

Sección nueva (S0.5). Las cuatro anteriores —Fiscal, Accounting, Inventory, Money— cubren el
movimiento del negocio; ninguna cubre los cambios sobre la propia estructura, y `company.created`
no encajaba en ninguna.

- company.created

Los demás eventos de esta sección se añaden **cuando exista el caso de uso que los emite**, no por
anticipado: la política de qué se audita está diferida con dueño y disparador en `RISK_REGISTER.md`
(R-04), y un catálogo escrito por adelantado sería adivinación.

> **Nota sobre el alta de una company.** Deja **dos** rastros y no son duplicados:
> `company.created` en el outbox —lo emite el caso de uso, y es el evento de integración— y
> `company.tax_id_established` en `audit_events` —lo escribe el trigger de M4, y es la red del
> esquema que garantiza que la identidad fiscal inicial queda registrada aunque no haya caso de uso
> (una carga directa, un script de operación). Hechos distintos, destinos distintos.
