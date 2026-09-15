# ADR-0061 — Corregir una venta: anular repone, y el recibo se devuelve

- **Estado**: **aceptada con dos condiciones** (dueño, 2026-09-15): el texto de «Anular» se
  corrige en el MISMO commit en que la reposición se vuelve cierta; y el camino completo para
  deshacer una venta cobrada queda escrito (§8) y el 409 lleva a él.
- **Fecha**: 2026-09-14 (propuesta) · 2026-09-15 (aceptada)
- **Módulos**: ventas (anulación, devoluciones, notas) · inventario · tesorería · contabilidad
- **Rigor**: máximo. `annulInvoice` es compartido: se trata como **defecto de todos**, no como un
  cambio del modo recibos.
- **HOMOLOGATION_IMPACT**: NO en el contenido ni en la numeración de la factura. El documento
  nuevo (§5) no es fiscal. Revisión de `fiscal-reviewer` obligatoria, porque se toca la anulación
  de facturas.

## Contexto

Verificado en código el 2026-09-14 (`packages/domain/src/sales.ts`).

### `annulInvoice` (1626-1711)

1. **No repone existencia.** No crea ningún `inventory_move`.
   - La pantalla promete lo contrario: «el inventario que descargó se repone»
     (`apps/web/src/pages/ventas/DetalleFactura.tsx:636`). **Hoy ese texto es falso.**
2. **No mira el tipo.** Por la API se anula un recibo, una nota de crédito o una de débito en
   estado `issued`. La web solo ofrece anular facturas (`DetalleFactura.tsx:273`).
3. **No mira los cobros.** Un documento cobrado en parte sigue `issued` y se anula dejando sus
   cobros vivos. Uno cobrado entero (`paid`, `sales.ts:2118`) no se puede anular: toda venta de
   caja cobrada es inanulable.
4. **No bloquea el documento.** Lee sin `for update` (1644-1645), a diferencia de
   `registerPayment` (1743).
5. **Evento equivocado.** Registra `fiscal.invoice.annulled` también para recibos.
6. **Lo que sí hace bien:**
   - reversa el asiento (1670-1679) o descarta la fila de la cola (1680-1686);
   - pasa la percepción de IGTF a `pendiente_reintegro` (1692-1704);
   - conserva el correlativo (ADR-0037).

### El recibo no tiene corrección posible

- Devolución: 422 «Solo se devuelve contra una factura emitida» (2302-2307).
- Nota: 422 (2403-2408) y, si se salta ese control, 409 `REGIME_KIND_NOT_ALLOWED` (2798-2803).
- **No existe reembolso de caja ni reverso de cobro** (`payments` es append-only; no hay caso de
  uso en `sales.ts` ni en `treasury.ts`).
- La devolución de factura solo deja saldo a favor (2718-2723).
- La devolución compara la cantidad devuelta por devolución, **no acumulada** (2343): dos
  devoluciones pueden devolver más de lo vendido.

### Nadie mira esto

`stock_reconciliation` compara kardex con saldos (`create_inventory.sql:798-819`). Una venta
anulada sin reposición es internamente coherente y **ningún invariante** dice «documento
anulado ⇒ su kardex neto es cero».

## Decisión

### 1. Qué se anula

- Solo **factura** y **recibo**, en estado `issued`, **sin ningún cobro activo**, con el
  documento bloqueado (`for update`).
- Las notas no se anulan: una nota se corrige con la nota contraria.
- Con cobros (parciales o totales), la corrección es la **devolución** (§8), no la anulación.
  El 409 lo dice con palabras de persona y lleva a «Devolución».

### 2. Anular repone al costo exacto que salió

- Por cada movimiento de salida con `source_document_id` = el documento, una entrada **en el
  mismo depósito y lote**, por la misma cantidad y el **mismo `functional_amount`**. No se usa el
  promedio de hoy ni `cost_snapshot`.
- Va en la misma transacción que la anulación.
- El permiso de anular basta. La reposición es parte del caso de uso y queda en la auditoría; no
  se exige además `inventory.move`.
- Con ADR-0060 aprobado, el hecho `inventory.cost_of_sales` se reversa junto con el asiento de la
  venta.

### 3. Evento propio

- Recibo: `sales.receipt.annulled`.
- Factura: sigue `fiscal.invoice.annulled`.

### 4. Devolución: tope acumulado para todos

- Lo devuelto por línea, sumando todas las devoluciones confirmadas, nunca supera lo vendido.
- Es un defecto de facturas y recibos por igual.

### 5. El recibo de devolución: un tipo nuevo, no una nota de crédito

- Tipo de documento nuevo `receipt_return` («Recibo de devolución»):
  - sin IVA;
  - numeración interna propia (`claim_document_number` por tipo);
  - `sin_facturacion.allowed_kinds = {receipt, receipt_return}`.
- Repone existencia al costo original (el de la salida, como §2).
- **Devuelve el dinero de dos formas:**
  - **saldo a favor** (`customer_credits`) si el recibo tiene cliente identificado;
  - **reembolso** desde una cuenta de tesorería. Es un caso de uso nuevo: una salida de dinero,
    con asiento, y que resta del saldo de caja. Es la única vía para «consumidor final», que no
    puede tener saldo.
- **Por qué no `credit_note`:** el libro de ventas selecciona
  `kind in ('invoice','credit_note','debit_note')`
  (`20260912120000_fiscal_books_caracas_day.sql:69`). Una nota contra un recibo entraría al libro
  fiscal de una empresa que no factura.
- `platform.sales_mode_at` deriva el modo de `allowed_kinds` (migración 54). Agregar
  `receipt_return` **no puede** cambiar el modo: el pgTAP 054 lo tiene que seguir probando.

### 6. Invariante nuevo, con respuesta cero

`platform.annulled_stock_gaps(company)` devuelve los documentos anulados cuyos movimientos
**no netean a cero** (en cantidad y en `functional_amount`). Tiene que dar **cero filas**.

- Va en pgTAP con su variante rota, y a la tabla de CLAUDE.md §3.
- **Histórico:** las ventas ya anuladas en producción sin reposición se reponen con **entradas
  nuevas fechadas hoy**, citando el documento. No se edita ni se borra nada (R8).
- Antes se cuenta cuántas son, en solo lectura, y el dueño ve la lista.

### 7. La pantalla dice la verdad, en el mismo commit que el comportamiento

- Hoy la confirmación de «Anular» promete «el inventario que descargó se repone» y no es cierto.
  El texto se corrige **en el mismo commit** en que §2 hace cierta la reposición: ni antes (la
  pantalla dejaría de mentir sin que nada hubiera cambiado) ni después (el comportamiento cambiaría
  sin decirlo).
- Se agrega: «Si ya tiene cobros, no se anula: registra una devolución».
- En un recibo: «Devolver», con las dos salidas del dinero, y ninguna mención a notas.

### 8. El camino completo para deshacer una venta cobrada

**Una venta con cobros no se anula: se devuelve.** No existe «revertir el cobro y luego anular», y
no se crea: un cobro es un hecho de caja que ocurrió (el cliente pagó), `payments` es append-only, y
el IGTF que percibió ese cobro tiene su propio flujo de reintegro (P-9). Anular fingiría que el
dinero nunca entró.

El camino, para facturas y recibos por igual:

1. **Devolución** de las líneas (todas o parte): repone la existencia al costo con que salió.
2. **El documento de la devolución:**
   - de una **factura** → **nota de crédito** por lo devuelto (entra al libro de ventas, como debe);
   - de un **recibo** → **recibo de devolución** (§5; no fiscal, fuera del libro).
3. **El dinero:**
   - cliente identificado → **saldo a favor**, que se usa en su próxima compra;
   - consumidor final, o si el cliente pide su dinero → **reembolso** desde la cuenta de tesorería
     elegida (salida de caja con asiento, que resta del saldo de esa caja; ADR-0060 §4 resuelve su
     cuenta contable).

El 409 de «Anular» con cobros dice exactamente eso: «Esta venta ya tiene cobros y no se puede
anular. Para deshacerla, registra una devolución: repone la mercancía y devuelve el dinero como
saldo a favor o reembolso.» — y la pantalla lo acompaña con el botón «Devolución».

## Alternativas descartadas

- **Anular revirtiendo los cobros.** No existe reverso de cobro; inventarlo dentro de la anulación
  mezcla dos correcciones y deja el IGTF percibido sin flujo claro (P-9 abierto). La devolución ya
  es el camino con dinero.
- **Reusar `credit_note` para el recibo.** Entra al libro de ventas.
- **Reponer al costo promedio de hoy.** El kardex quedaría con un valor que nunca salió, y
  `inventory_ledger_gap` (ADR-0060) no daría cero.

## Consecuencias

- **Migración:**
  - `documents_kind_chk` con `receipt_return` y `allowed_kinds` de `sin_facturacion`;
  - `source_kind` del generador en sus tres sitios y en `accounting_coverage_gaps`;
  - plantilla del reembolso;
  - `annulled_stock_gaps` y pgTAP.
- **Cambio de contrato de la API:** el tipo nuevo en los enums de `packages/schemas` y un endpoint
  de reembolso. `openapi.json` se regenera.
- **El único test existente que cambia, aprobado por el dueño (2026-09-15).**
  `apps/api/test/e2e-igtf.test.ts:640-677` anulaba una factura **con un cobro** y esperaba 200. La
  aserción era incorrecta: anular una venta ya cobrada sin tratar el dinero es justo lo que no debe
  permitirse. **No se ajusta: se reemplaza por dos tests:**
  - (a) anular factura CON cobro aplicado → 409, y el mensaje nombra la devolución (§8);
  - (b) anular factura SIN cobros → 200, con existencia **y valor** del kardex aseverados antes y
    después: vuelven exactamente a los de antes de la venta.
- **Tests que no cambian:** `e2e-sales.test.ts:419-447` (estado y número),
  `e2e-accounting-hooks.test.ts:510-545` (contra-asiento neto cero) y
  `e2e-fiscal-books.test.ts:328-346` (la anulada sigue en el libro). No se tocan; las aserciones
  de existencia y valor van en tests nuevos. Cualquier otra aserción existente que se ponga roja
  significa que el cambio rompió algo, y se para.

## Pendiente (VALIDAR)

- **VALIDAR-SENIAT:** `SENIAT_COMPLIANCE_AND_HOMOLOGATION.md:37` dice que la factura se corrige
  solo con nota, y ADR-0037 admite la anulación directa conservando el número. Esta decisión no
  amplía la anulación de facturas (la restringe), pero la tensión sigue abierta.
- **VALIDAR-TRIBUTARIO (P-9):** reintegro del IGTF percibido en una venta que se devuelve.
- **VALIDAR-LEGAL:** texto del recibo de devolución.
- **Decidido por el dueño (2026-09-15):** reemplazo de `e2e-igtf.test.ts:640-677` por los dos
  tests de arriba.
