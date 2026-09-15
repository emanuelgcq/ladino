# ADR-0060 — El costo de lo vendido y el inventario en el mayor

- **Estado**: **aceptada con precisiones** (dueño, 2026-09-15): los cuatro caminos de la cuenta
  de efectivo en este mismo ADR; el porqué del invariante escrito; regularización con ensayo en
  seco y visto bueno previo.
- **Fecha**: 2026-09-14 (propuesta) · 2026-09-15 (aceptada)
- **Módulos**: contabilidad (generador de asientos) · inventario (kardex, lotes) · ventas ·
  tesorería · compras (solo la recepción)
- **Rigor**: máximo (dinero, contabilidad, asientos posteados en producción)
- **HOMOLOGATION_IMPACT**: NO. No cambia qué se emite, ni su numeración, ni los libros de IVA.
  Cambia qué asientos genera cada hecho. Pasa por `accounting-invariants` y `fiscal-reviewer`.

## Contexto

Verificado en código el 2026-09-14. Tres defectos tienen la misma raíz: **el mayor no sigue lo
que pasa con la mercancía ni con la caja**.

1. **Ninguna venta asienta costo de ventas (B5).**
   - El costo existe dentro de la transacción de la venta: `issueStockBatch` devuelve los
     movimientos con `functional_amount` = −costo (`packages/domain/src/inventory.ts:661-667`).
   - Pero `sales.ts:1556-1572` solo mira el error y **tira el costo**.
   - El rol `cogs_general` (cuenta 5.1.01) y el importe `cost_amount` existen en el esquema
     (`create_accounting.sql:411, 1090, 1147`) y nadie los usa.
   - Además, el `cost_snapshot` de la línea sale de `last_unit_cost` del lote nulo
     (`sales.ts:843-847`), que no es el costo que registró el movimiento.
2. **Ninguna entrada de mercancía asienta.**
   - `receiveStock` (`inventory.ts:394-499`) escribe movimiento, auditoría y outbox, y nada más.
   - Lo usan la recepción de compra (`purchases.ts:572`), la existencia inicial
     (`products.ts:521`) y las devoluciones (`sales.ts:2679`). Solo el ajuste asienta
     (`inventory.ts:893`).
   - Con la factura del proveedor, el inventario se debita por el subtotal. Al formal se le
     debita el total con IVA (`connect_journal_generator.sql:218-233`), mientras el kardex valora
     sin IVA (`purchases.ts:570-577`).
3. **El cobro siempre va a efectivo en Bs (B6).**
   - La plantilla del cobro debita `cash_bs` sin condición (`connect_journal_generator.sql:206`).
     Igual el pago a proveedor (`:249`), el gasto (`create_expenses.sql:216`) y el cierre de caja
     (`create_cash_closings.sql:214, 220`).
   - `company_accounts.ledger_account_id` (`create_treasury_accounts.sql:42`) existe, su
     comentario promete la resolución por moneda, y el generador nunca la lee
     (`journal-generator.ts:277-288`).
   - Bug vivo: `apps/api/test/e2e-ola0-verificaciones.test.ts:192-238` (V2, `it.fails`).
4. **Una venta con lotes no se puede hacer (B3).**
   - La venta no manda `lot_id` (`sales.ts:1559-1562`) y descuenta del lote nulo, que está vacío,
     así que responde 409 `NEGATIVE_STOCK` (`inventory.ts:634-643`).
   - `platform.suggest_lot_fefo` devuelve UN lote y es «sugerencia»
     (`extend_inventory…sql:558-577`). Ninguna función reparte una cantidad entre varios lotes.
   - Bug vivo: V1 (`e2e-ola0-verificaciones.test.ts:165-191`).

**Nadie mira esto.** La spec pide el invariante 8, «inventario valorizado = cuentas de
inventario» (`docs/06_QA/ACCOUNTING_INVARIANTS_TESTS.md:10`), y no existe.
`accounting_coverage_gaps()` no cubre movimientos de inventario ni cobros. Es el caso de CLAUDE.md
§3: un invariante que cruza módulos y que nadie observa.

## Decisión

### 1. El costo de ventas es un hecho propio, no una línea de la plantilla de la venta

- Cada documento que descarga existencia (factura, recibo) genera, **en la misma transacción**,
  el hecho `sales_cost` / `stock.shipped`: Débito `cogs_general`, Crédito `inventory_general`.
  El evento es el REAL del outbox —EVENT_CATALOG.md reserva `stock.*` «para el COGS»— y el
  origen va en `source_kind`, que es esa dimensión (pgTAP 026 lo exige: nada de vocabulario
  paralelo de eventos).
- El importe es **exactamente** −Σ`functional_amount` de los movimientos con ese
  `source_document_id`. No se recalcula nada.
- `cost_snapshot` de la línea no se reescribe (la línea emitida no se edita); el costo contable
  es el de los movimientos.
- **Por qué hecho aparte:**
  - El importador salta los hechos que ya tienen plantilla (`accounting.ts:984-990`). Una línea
    nueva en la plantilla de venta **nunca llegaría** a las empresas existentes; un hecho nuevo
    sí llega reimportando.
  - Factura y recibo lo comparten.
  - La cobertura puede exigirlo por separado.

### 2. Toda entrada y salida de kardex tiene contrapartida en el mayor

| Hecho | Débito | Crédito |
|---|---|---|
| Existencia inicial | `inventory_general` | `opening_equity` (propósito nuevo) |
| Recepción de compra | `inventory_general` | `goods_received_not_invoiced` (propósito nuevo, cuenta puente) |
| Factura de proveedor con mercancía recibida | `goods_received_not_invoiced` (por lo recibido) + diferencia de precio | `suppliers` |
| Devolución de venta confirmada | `inventory_general` | `cogs_general` |
| Consumo de receta | `cogs_general` | `inventory_general` |
| Salida directa (consumo interno) | `inventory_adjustment` | `inventory_general` |
| Transferencia entre depósitos | sin asiento: no cambia el valor de la empresa | — |

**Orígenes y eventos (implementado, migración 58).** Cuatro `source_kind` nuevos en sus tres
casas, con los eventos reales del catálogo:

| Hecho | `source_kind` | evento | `source_id` |
|---|---|---|---|
| Costo de lo vendido (venta) | `sales_cost` | `stock.shipped` | el documento |
| Consumo de receta | `sales_cost` | `stock.shipped` | el movimiento |
| Salida directa | `inventory_move` | `stock.shipped` | el movimiento |
| Existencia inicial / entrada directa | `stock_opening` | `stock.received` | el movimiento |
| Recepción de compra | `goods_receipt` | `stock.received` | la recepción |
| Devolución de venta | `sales_return` | `stock.received` | la devolución |
| Factura distinta de lo recibido | `purchase_revaluation` | `ap.invoice_posted` | la factura |

- **Diferencia entre lo facturado y lo recibido.** Si la factura del proveedor valora distinto
  (precio, o IVA al costo del formal), la diferencia entra al kardex como `revaluacion` (tipo que
  ya existe) **y** al mayor por el mismo importe. Kardex y mayor nunca se separan.
- **El IVA al costo** queda sujeto a P-15 (VALIDAR-TRIBUTARIO). Hasta la respuesta se mantiene el
  tratamiento actual, pero pasa por el kardex.

### 3. La venta con lotes reparte por FEFO en el servidor

- Nueva función `platform.allocate_lots_fefo(company, warehouse, product, qty)`. Devuelve **varias
  filas** (lote, cantidad): primero vence, primero sale, y **nunca un lote vencido**.
- La venta descuenta lote por lote, cada uno a su costo.
- Si lo no vencido no alcanza: 409 con mensaje de persona. El vencido solo sale por ajuste, con
  permiso `inventory.expired`, como hoy.
- La caja no elige lote en v1.

### 4. La cuenta de efectivo sale de la cuenta de tesorería REAL, en los cuatro caminos

El defecto no es del cobro: son **cuatro caminos con la misma constante**, y se arreglan juntos.

| Camino | Caso de uso | Constante de hoy |
|---|---|---|
| Cobro | `registerPayment` (`sales.ts:1718`) | débito `cash_bs` (`connect_journal_generator.sql:206`) |
| Pago a proveedor | `registerSupplierPayment` (`purchases.ts:1505`) | crédito `cash_bs` (`:249`) |
| Gasto | `registerExpense` (`treasury.ts:401`) | crédito `cash_bs` (`create_expenses.sql:216`) |
| Cierre de caja | `closeCashRegister` (`treasury.ts:534`) | `cash_bs` (`create_cash_closings.sql:214, 220`) |

- **Un propósito nuevo del vocabulario cerrado** (enmienda de ADR-0041): `treasury_account`. La
  línea de plantilla con ese propósito no nombra una cuenta: el generador la resuelve con la
  cuenta de tesorería del movimiento (la del cobro, la del pago a proveedor, la del gasto, la del
  cierre) → `company_accounts.ledger_account_id`.
- **El mapeo es obligatorio, y su falta no se esconde.**
  - La migración asigna `ledger_account_id` a cada cuenta de tesorería existente (`cash_bs` o
    `cash_usd` según su moneda), con acta, y el alta de una cuenta nueva lo asigna igual.
  - Si al asentar la cuenta no tiene mapeo, **el asiento no cae en `cash_bs`**: el hecho va a la
    cola contable con el motivo explícito `treasury_account_unmapped`, visible como pendiente. No
    se rechaza la venta ni el pago —el cajero no queda bloqueado por una configuración contable—
    y nunca existe un asiento con la cuenta equivocada.
- **Tests, uno por camino:** movimiento en USD contra una caja USD → el débito o crédito cae en la
  cuenta contable de ESA caja. **Variante rota:** se le quita el mapeo a una cuenta y el hecho
  aparece en la cola con `treasury_account_unmapped`, sin un solo asiento en `cash_bs`.
- Plantillas nuevas con vigencia desde el deploy; las anteriores no se editan.

### 5. El invariante nuevo, con respuesta cero

**Por qué existe.** `accounting_coverage_gaps()` vigila que los **documentos** tengan asiento; no
vigila que los **movimientos de inventario** lo tengan. Ese punto ciego es lo que dejó pasar el
costo de ventas durante meses: cada factura tenía su asiento —la cobertura daba cero— mientras la
mercancía salía del kardex sin que el mayor se enterara. El invariante nuevo no es una comprobación
más: **es el cierre de un agujero de diseño**, el observador que no depende de la pieza observada
(CLAUDE.md §3).

`platform.inventory_ledger_gap(company)` =

> valor del kardex − saldo del mayor en cuentas de propósito `inventory_general`

- `diferencia` tiene que dar **0**, sin lista de perdones.
- **Estricto (precisión del dueño, 2026-09-15):** un hecho encolado lo pone en ROJO, y es verdad
  —mientras está en cola el mayor no sabe de esa mercancía—. La columna `en_cola` dice cuánto de
  la diferencia es pendiente. El borrador restaba la cola; la variante rota que pidió el dueño
  («quita la plantilla de costo de ventas → rojo») exige la forma estricta.
- La cobertura va en su PROPIA función, `platform.inventory_coverage_gaps(company)`: todo
  movimiento que cambia el valor (entrada, salida, ajuste, revaluación) posterior al corte tiene
  asiento o cola. No se mezcla en `accounting_coverage_gaps()`, que sigue preguntando por
  documentos: extenderla habría puesto en rojo los fixtures que siembran existencia por SQL en
  los E2E contables, y su pregunta es otra.
- Se prueba en pgTAP 058 y en `e2e-inventario-en-el-mayor`, con sus variantes rotas, y se agrega a
  la tabla de CLAUDE.md §3.

### 6. El histórico: corte con asiento de regularización, no reproceso

Los asientos posteados **no se tocan** (regla 2) y **nada se borra** (R8). Por empresa, **en la
fecha real en que se ejecuta** (no una fecha redonda: el asiento dice cuándo se corrigió), con su
motivo escrito y su acta en `audit_events`:

- **Inventario.** **Un solo** asiento de regularización por empresa, por la diferencia TOTAL entre
  el valor del kardex y el saldo de `inventory_general`, contra `inventory_adjustment` (5.1.04).
  Es por empresa y no por documento porque el invariante es por empresa: en «Ladino» y
  «ferreteria» la semilla y lo real comparten kardex y cuenta, y regularizar solo lo real dejaría
  esas empresas en rojo para siempre, o obligaría a excluir la semilla dentro del invariante, que
  es la lista de perdones que CLAUDE.md §3 prohíbe. El asiento **no edita ni borra** ningún
  documento de semilla. El informe del ensayo en seco separa qué parte del importe viene de la
  semilla (`platform.seed_marks`, §7) y qué parte de lo real.
  **VALIDAR-CONTADOR**: la cuenta de contrapartida, porque el costo de ventas de meses pasados
  quedó sin registrar.
- **Caja.** Por cada cuenta de tesorería en USD, un asiento de reclasificación `cash_bs` →
  `cash_usd` (o la cuenta ligada) por la suma funcional de los cobros y pagos asentados en Bs.
- **Desde el corte**, todo por las reglas nuevas. `inventory_ledger_gap` = 0 a partir de la fecha
  de corte.

No se regenera el histórico porque la cola guarda contexto sin costo (`journal-backfill.ts:103`)
y no existe «reversar y regenerar» para asientos del generador (`accounting.ts:565`). Construirlo
para unos pocos documentos reales cuesta más que regularizar, y toca asientos que el dueño ya vio.

**Procedimiento obligatorio:**

1. **Ensayo en seco** en solo lectura: documentos, asientos que se crearían, importes, cuentas y
   saldo antes/después de cada cuenta afectada. Se entrega al dueño y **se para** hasta su visto
   bueno.
2. **El invariante se mide ANTES y debe estar en rojo.** Si sale verde sobre datos que se sabe
   incorrectos, el chequeo o el diagnóstico están mal: se para.
3. **Se ejecuta en una transacción por empresa.**
4. **El invariante se mide DESPUÉS y debe estar en verde**; si no, se revierte la transacción.
5. `trial_balance`, `recompute_ledger`, `accounting_coverage_gaps` y `stock_reconciliation` no
   pueden haberse puesto en rojo de rebote.

**Cómo se revertiría:** con el contra-asiento de cada asiento de regularización
(`reverseJournalEntry`, que marca el original `reversed` y deja el suyo). Nada se borra; quedan el
acta de la regularización y la de su reversa. Revertir devuelve el invariante a rojo.

### 7. La marca de semilla

La marca por empresa del plan (1.3) no funciona: en «Ladino» la semilla (1.193 documentos) y los 8
documentos reales del dueño viven en la misma empresa. La marca es **por registro**, en una tabla
aparte que solo admite inserción: `platform.seed_marks(company_id, source_table, source_id)`. No
toca las tablas append-only (`inventory_moves`, `journal_lines`…: nada de UPDATE). Se llena por
autor (el usuario semilla) con la lista a la vista. Sirve a los reportes y al informe de la
regularización; **el invariante contable no la usa**. La semilla no se borra en producción: la
reemplazará una semilla limpia en una empresa de demostración aparte.

## Alternativas descartadas

- **Costo de ventas como línea de la plantilla de venta.** No llega a las empresas existentes
  (importador) y ata factura y recibo a una plantilla con IVA.
- **Reprocesar todo el histórico.** No hay costo en la cola ni mecanismo de regeneración, y el
  riesgo es sobre producción.
- **Que la caja elija el lote.** Es más lento en el mostrador y el error humano vende el lote que
  vence después. Queda para una versión con escáner de lote.
- **Recepción de compra sin asiento hasta la factura (lo de hoy).** El kardex sube y el mayor no:
  el invariante no puede dar cero.

## Consecuencias

- **Migración:**
  - dos propósitos contables nuevos (`opening_equity`, `goods_received_not_invoiced`) y
    `treasury_account`;
  - cuentas nuevas en `ve_basico` **y** en los planes ya importados de cada empresa;
  - plantillas nuevas con vigencia;
  - `allocate_lots_fefo`, `inventory_ledger_gap` y la extensión de la cobertura;
  - pgTAP de cada una.
- **Cambia la API interna de ventas:** la venta usa lotes y pasa el costo al generador. **No
  cambia el contrato público**, porque `cost_snapshot` ya existe.
- **Tests que dejan de fallar:** V1 y V2 pasan de `it.fails` a `it` **sin cambiar su aserción**.
- **Tests que pueden cambiar de cifra:** los E2E que cuentan asientos por documento
  (`e2e-accounting-hooks`) verán un asiento más por venta. Se revisa uno por uno; si una
  aserción cambia de valor, se dice antes de tocarla.
- **Producción:** la migración, en el mismo push; la regularización, solo tras el visto bueno del
  dueño sobre el ensayo en seco.

## Pendiente (VALIDAR)

- **VALIDAR-CONTADOR:** contrapartida de la regularización de inventario y cuenta de
  `opening_equity`.
- **VALIDAR-TRIBUTARIO (P-15):** IVA al costo del formal y de quien vende con recibos.
- **Decidido por el dueño (2026-09-15):** fecha de corte = el día real de ejecución; la semilla no
  se borra; los documentos reales quedan regularizados dentro del asiento por empresa.
