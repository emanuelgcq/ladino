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

## Libros fiscales (migración 27, ADR-0044)

**`fiscal.book.exported` — implementado, `schema_version` 1.** Lo emite `exportFiscalBook()` con
`aggregate_type = 'fiscal_book_run'` y `aggregate_id` = el id de la fila de `fiscal_book_runs`, en
la misma transacción que la escribe. El payload lleva `{book_kind, period_from, period_to,
format_code, timezone, unclassified_rows, dataset_hash}` — **el hash va dentro a propósito**: un
consumidor que algún día transmita una generación oficial tiene que poder decir *qué* dataset se
transmitió, y sin el hash el evento solo diría que alguien exportó algo.

`unclassified_rows` viaja también por la misma razón: si una generación posterior del mismo período
trae otro número, el consumidor lo ve sin tener que recalcular el libro.

**Consultar un libro NO emite evento.** Es una lectura, no un hecho. Emitirlo llenaría el outbox de
ruido y haría que el rastro de presentaciones dejara de probar nada — el mismo argumento por el que
consultar tampoco deja fila en `fiscal_book_runs` (ADR-0044 §2).

**`fiscal.book.reconciled` — RESERVADO, hoy no lo emite nadie.** La conciliación
`libro = mayor + cola` es una consulta (`platform.book_ledger_reconciliation()`), y una consulta no
es un hecho: no hay caso de uso que lo emita y el nombre queda apartado, no implementado.

> Queda escrito **contra la política de esta misma sección** —«los eventos se añaden cuando exista
> el caso de uso que los emite, no por anticipado»— por encargo explícito, para reservar el nombre
> de cara a la transmisión de generaciones oficiales. Va marcado así justamente para que el
> catálogo no mienta sobre lo que existe. El día que un caso de uso lo emita, se mueve arriba con
> su payload; si nunca lo emite, **se borra**, porque un nombre reservado que envejece sin dueño es
> exactamente la adivinación que la política evita.

## Inventory
- stock.received
- stock.shipped
- stock.transferred
- stock.adjusted

**Implementados en S0.6 (módulo de inventario, ADR-0034), `schema_version` 1.** Los emiten los
casos de uso de `packages/domain/src/inventory.ts` con `aggregate_type = 'inventory_move'`, y el
payload lleva siempre `{warehouse_id, product_id, lot_id, quantity, functional_amount,
functional_currency, unit_cost, quantity_after, rounding_policy_id}` — el importe funcional y la
política de redondeo van dentro porque un evento de inventario sin ellos no permite reconstruir el
costo. `stock.adjusted` añade `{reason}` (obligatorio) y `stock.transferred` añade
`{transfer_id, from_warehouse_id, to_warehouse_id}`.

`INVENTORY_SPEC.md` §API/eventos nombra `inventory.moved`; **el vocabulario bueno es el de este
catálogo** (`stock.*`), que es el canónico y el que ya estaba escrito. La spec de módulo quedó
desactualizada y no se sigue.

La entrada de una transferencia NO emite evento propio: es la misma transferencia, y dos eventos
para un hecho obligan a todo consumidor a deduplicar (el mismo argumento que el autocierre de
precios en ADR-0032).

**Consumo de una receta (migración 20, ADR-0035).** Vender un compuesto emite **un `stock.shipped`
por ingrediente**, no un evento nuevo del compuesto, y todos llevan el mismo `source_document_id` en
el payload. La razón es la misma que arriba: el hecho de inventario es la salida de harina, y quien
consuma estos eventos (contabilidad, para el COGS) necesita exactamente eso. El hecho comercial —«se
vendieron doce arepas»— es del módulo de ventas, que todavía no existe; cuando exista, emitirá el
suyo y se ligará por `source_document_id`.

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

## Maestros (catálogo de productos y precios — S0.6, módulo de productos)

Emitidos por los casos de uso de `packages/domain` (products.ts, pricing.ts), `schema_version` 1:

- product.created
- product.updated
- product.tax_category_set — el payload lleva `{from, to}`: una reclasificación fiscal sin el
  valor anterior no se puede revisar (la lección de la migración 10)
- price_list.created
- price.set — el payload lleva `{amount (string), currency, effective_from, effective_to}`;
  el autocierre del período anterior NO emite evento propio: es consecuencia del mismo hecho

Clientes (migración 18, ADR-0033) — casos de uso de `customers.ts`, `schema_version` 1:

- customer.created · customer.updated · customer.blocked · customer.unblocked (payload `{reason}`)
- customer.tax_id_established — lo escribe el **trigger M4** al alta con RIF (red del esquema)
- customer.tax_id_changed — lo escribe el **trigger M4** con `{tax_id_anterior, tax_id_nuevo,
  legal_name}`; el caso de uso `setCustomerTaxId` NO lo duplica en `audit_events`: emite solo el
  evento de outbox del mismo nombre (la misma partición que `company.tax_id_established`)

Los demás eventos de esta sección se añaden **cuando exista el caso de uso que los emite**, no por
anticipado: la política de qué se audita está diferida con dueño y disparador en `RISK_REGISTER.md`
(R-04), y un catálogo escrito por adelantado sería adivinación.

> **Nota sobre el alta de una company.** Deja **dos** rastros y no son duplicados:
> `company.created` en el outbox —lo emite el caso de uso, y es el evento de integración— y
> `company.tax_id_established` en `audit_events` —lo escribe el trigger de M4, y es la red del
> esquema que garantiza que la identidad fiscal inicial queda registrada aunque no haya caso de uso
> (una carga directa, un script de operación). Hechos distintos, destinos distintos.
