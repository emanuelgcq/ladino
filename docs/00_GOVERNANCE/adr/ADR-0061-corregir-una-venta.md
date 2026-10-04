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
- Con ADR-0060, el costo de ventas asentado se revierte con el hecho `sales_cost` /
  `stock.received` (inventario contra costo de ventas); si seguía en la cola, se descarta con la
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

## Implementación (migración 59, 2026-09-15)

- **Anular** (`annulInvoice`): bloquea el documento, admite solo factura o recibo, responde 409
  `DOCUMENT_HAS_PAYMENTS` con el camino escrito si hay cobros, repone con
  `reponerSalidasDeDocumento` (mismo lote, depósito y valor de cada salida) y, si el costo de ventas
  llegó a asentarse, lo revierte con el hecho `sales_cost` / `stock.received`; si seguía en la cola,
  lo descarta con la venta.
- **Devolver** (`createReturn` / `confirmReturn`): factura o recibo; tope ACUMULADO por línea al
  crear y al confirmar; el reingreso reparte lo devuelto entre las salidas de la venta —lote por lote,
  en orden de vencimiento, a su valor—, así que un producto con lotes ya se puede devolver (antes
  reingresaba al lote nulo y moría en LAD38) y el costo ya no es el `cost_snapshot`. Un recibo emite
  `receipt_return` (serie D, sin IVA, tratamiento `no_fiscal`, hecho
  `sales_receipt_return` / `sales.receipt_return.issued`).
- **El dinero**: toda devolución deja saldo a favor; `refundCustomerCredit`
  (`POST /v1/customer-credits/{id}/refunds`, permiso `sales.return.manage`) lo reembolsa desde una
  caja en la moneda del saldo: `customer_refunds` (append-only, baja el saldo de la cuenta, entra al
  recómputo) y asiento `customer_refund` / `ar.credit_refunded` contra la caja REAL.
- **Invariante**: `platform.annulled_stock_gaps(company)`, en pgTAP 059 y e2e-corregir-venta con su
  variante rota. `accounting_coverage_gaps` aprende el recibo de devolución y el reembolso.
- **Aserción existente cambiada por decisión de este ADR**: pgTAP 037 test 1 afirmaba
  «sin_facturacion: SOLO receipt»; ahora `{receipt, receipt_return}` (sigue sin nada fiscal).

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

## Nota de aplicación — M-12 (el recibo se devuelve con recibo aunque ya se facture, 2026-10-03)

ADR aplicado según la respuesta del dueño del 2026-09-28 (§3 M-12): «`receipt_return` se permite
cuando el origen es un recibo, aunque la empresa ya facture: un recibo se devuelve con recibo de
devolución, nunca con NC». Migración 20261004110000, pgTAP 121, E2E
`e2e-de-recibos-a-facturas.test.ts`.

El §5 dejaba `receipt_return` solo en `sin_facturacion.allowed_kinds`, y el régimen se juzga a la
fecha de emisión: la bodega que obtenía su RIF se quedaba sin documento para devolver un recibo
viejo. **Decidido por criterio:** `allowed_kinds` no cambia (sigue siendo lo que el régimen
VENDE, y `platform.sales_mode_at` no se entera: el pgTAP 054 sigue en verde); la excepción la
enuncia el gate de emisión —un `receipt_return` cuyo origen es un recibo de la misma empresa se
emite bajo cualquier régimen que emita— y el dominio deja de rechazarlo antes. Sigue sin número
de control (ahora lo prohíbe el trigger también bajo numeración por rango), sin IVA, con
tratamiento `no_fiscal` y fuera del libro. *Alternativa:* añadir `receipt_return` a
`formatos_libres.allowed_kinds`, que además habría obligado a tocar el modo de venta.
VALIDAR-TRIBUTARIO: PENDIENTES_ASESOR P-93.

## Nota de aplicación — G-10, G-14 y G-07 (anular solo lo que no salió; el cajero inicia la devolución, 2026-10-04)

ADR aplicado según la respuesta del dueño del 2026-09-28 (§3 G-10, G-07; §2.8). Migraciones
20261004160000, 20261004160100, 20261004160200 y 20261004160300 (esta última, tras la revisión en
contexto limpio: «declarado», la caja uniforme, el privilegio y el permiso de la nota directa),
pgTAP 126 y 126b, E2E `e2e-anular-o-nota.test.ts`.

**1. Cuándo se anula una factura (G-10; PA 00071 arts. 22 y 36).** El §1 decía «factura o recibo,
`issued`, sin cobro activo». Para la FACTURA se añade la regla del papel: se anula solo si el
documento no salió del establecimiento y la operación no ocurrió. El servidor lo traduce a cuatro
condiciones, y cualquiera que falte responde 409 `ANNULMENT_NOT_ALLOWED` con `details.reason` y un
mensaje que manda a la nota de crédito:

| Condición | `reason` | Granularidad |
|---|---|---|
| mismo día | `not_same_day` | día de Caracas de la emisión contra día de Caracas del instante de la anulación |
| período sin declarar | `period_declared` | día de Caracas de la emisión dentro de un período DECLARADO antes de ese instante. Declara solo una generación hecha después de cerrar su período (`period_to < caracas_day(created_at)`, día contra día; B-1, migración 20261002120400): una vista previa del período en curso no. **Con esa definición no puede dispararse junto a «mismo día»**: queda como red de seguridad y como segunda razón, no como bloqueo propio (C1, migración 20261004160300) |
| antes del cierre de caja | `cash_closed` | instante contra instante: un cierre de CUALQUIER caja de la empresa (`company_accounts.kind = 'cash'`) entre la emisión y la anulación |
| original y copias en mano | `originals_not_confirmed` | lo confirma la persona (`originals_in_hand: true`); queda en el acta |

Las tres primeras viven en `platform.invoice_annulment_blockers(empresa, documento, instante)`, que
no lee el reloj (el instante lo pasa `annulInvoice`: el `now()` de su transacción) y falla cerrada
(`not_found` para lo que quien llama no ve). La cuarta no la puede saber la base.

- **La regla no mira los cobros reversados (P-91).** ADR-0075 §8 decidió que «un cobro reversado no
  es un cobro» y eso sigue valiendo para el DINERO: el §1 solo cuenta cobros vivos. Pero la reversa
  no dice nada del PAPEL: una factura con su cobro reversado se anula solo si además cumple las
  cuatro condiciones.
- **«Su caja», una sola regla (decidido por criterio; migración 20261004160300).** Bloquea
  cualquier cierre de una CAJA de la empresa (`kind = 'cash'`; el cierre de un banco o de una
  billetera no cuenta) posterior a la emisión, de la misma sucursal cuando documento y cierre la
  llevan, tenga o no cobros el documento. La primera versión (160000/160100) miraba, con cobros,
  solo los cierres de las cuentas de esos cobros: una factura cuyo único cobro fue por banco o
  Zelle y se reversó no veía el cierre de la caja física. *Alternativa descartada:* mirar solo las
  cuentas de los cobros del documento. *Otra alternativa:* exigir la caja del puesto que emitió;
  hoy el documento no guarda puesto. Es más ancha en un negocio con dos cajas; se eligió el lado
  ruidoso: un 409 de más se ve y manda a la nota de crédito.
- **«Declarado» es el de la casa (C1; decidido por criterio).** La primera versión daba por
  declarado el período con cualquier fila de `iva_period_results` que cubriera el día: la vista
  previa del mes en curso, generada por la mañana, dejaba sin anular todas las facturas de ese día
  con un mensaje falso. Ahora usa la condición B-1, la misma que `recompute_iva_period`,
  inventario y la reversa de cobros. *Alternativa descartada:* que una vista previa bloquee y
  cambiar el mensaje.
- **La regla solo la ejecuta la API.** `invoice_annulment_blockers` y `annulment_paper_gaps` dejan
  de ser de `authenticated` (160300): ese rol no ve `iva_period_results` y para él la cláusula del
  período callaba (fallaba abierta).
- **El recibo conserva la regla del §1** (decidido por criterio): no es papel fiscal y el art. 36 no
  lo alcanza. *Alternativa:* la misma ventana para los dos.
- **El libro no cambia.** La anulada ya iba con su número, estado e importes en cero (P-34).
- **De quién es cada regla (auditoría fiscal de la ola 4, 2026-10-04).** «Mismo día, antes del
  cierre de caja, período sin declarar» es regla del DUEÑO (respuesta del 2026-09-28; P-91), no
  texto del art. 36 de la PA 00071. El art. 36, releído literal (reproducción ivecofi, 2026-10-04;
  no oficial, cotejo con la Gaceta pendiente), solo manda conservar el original anulado y sus
  copias hasta la prescripción: no fija día, caja ni período. La ventana de Ladino es más estricta
  que el texto; donde este ADR cita «arts. 22 y 36» junto a las cuatro condiciones, la norma
  respalda la cuarta (original y copias) y las otras tres son criterio del dueño.

**2. Cómo queda con la anulación tardía como ajuste negativo (R-2 ampliada, P-46).** No chocan,
porque hablan de papeles distintos:

- *Ventas (papel nuestro):* con esta regla ya no puede nacer una anulación tardía. Una factura de
  otro día, de caja cerrada o de período declarado no se anula: se corrige con nota de crédito, que
  entra al libro de SU período en negativo (R-1). El libro de un período declarado deja de poder
  cambiar por una anulación. Las anuladas antiguas siguen en cero en su período, como estaban.
- *Compras (papel del proveedor):* R-2 ampliada sigue igual. Que el proveedor anule su factura es
  un hecho que nos llega, a veces tarde; si llega con el período cerrado y el libro generado o
  declarado, va como «ajuste de período anterior» en el período de la anulación.
- **«En compras, una factura de proveedor anulada no se registra»** (respuesta G-10). *Decidido por
  criterio (§2.16):* la frase habla de la factura que el PROVEEDOR anuló —art. 36: nunca salió de
  su establecimiento—: no hay nada que registrar, y la pantalla lo dice donde se registra la
  factura («Si tu proveedor anuló la factura, no la registres», `capa-fiscal/textos.ts`). Lo que
  YA se registró en Ladino y luego se anula sigue la regla R-2 ampliada del dueño: en cero en el
  libro; tarde, ajuste negativo. No se construye nada ni cambia ninguna aserción. *Alternativa
  descartada:* sacar del libro de compras las anuladas ya registradas (contradice R-2 ampliada,
  que es del mismo día).

**3. La pantalla dice por qué (G-14).** `GET /v1/documents/{id}` trae `annulment`
(`allowed`, `reason`, `message`), calculado por `annulmentStatus` con las mismas preguntas que
`annulInvoice`. `DetalleFactura` enseña «Anular» solo si `allowed`, y si no, el mensaje del servidor
con el botón «Devolución». La web no rehace la regla.

**4. El cajero inicia la devolución (G-07).** El rol `cashier` recibe `sales.return.manage`: crea y
confirma la devolución, que deja saldo a favor. `refundCustomerCredit` pasa a exigir
`sales.refund` (ADR-0068 §8): el cajero no saca dinero de la caja. Lo tienen el Dueño y, desde la
migración 20261004160200, el administrativo (`back_office`): §2.8 dice que «anula y aprueba», y
hasta este cambio reembolsaba con `sales.return.manage`; quitárselo sin decirlo era una regresión
de su oficio. El cajero y el encargado no lo reciben. *Alternativa descartada:* solo el Dueño.
En una venta al Consumidor final el saldo queda pendiente de quien pueda reembolsar.
**El cajero inicia devoluciones, no emite notas de crédito directas** (decidido por criterio;
migración 20261004160300). `sales.return.manage` abría también `createDirectCreditNote`: sin
mercancía de vuelta, hasta el 100 % de cualquier factura, con saldo a favor que luego se aplica
como cobro en otra venta —mercancía que sale sin dinero y sin `sales.refund`—. La nota directa
(`POST /v1/credit-notes`) exige ahora `sales.credit_note.direct`, que reciben todos los roles que
tenían `sales.return.manage` (Dueño, administrativo y los roles propios de cada dueño) menos el
cajero de sistema. La devolución CON mercancía (`createReturn`, `confirmReturn`, `cancelReturn`)
sigue con `sales.return.manage`. La web ofrece «Nota de crédito…» solo con el permiso nuevo.
*Alternativa descartada:* dejarle al cajero `sales.return.manage` entero.

**5. Quién mira la regla del papel.** `platform.annulment_paper_gaps(empresa)` (migración
20261004160200, pgTAP 126b, línea en `scripts/recorrido/invariantes.sql`): toda FACTURA anulada
desde el corte (`platform.invariant_cutoffs`, contra `annulled_at`) se anuló el mismo día de
Caracas, en un período sin declarar, antes del cierre de su caja, y su acta lleva
`originals_in_hand = true`. Cero filas; sin la fila del corte, lanza. No hay trigger —decenas de
fixtures anulan por SQL facturas fechadas en el pasado—: la regla la obedece `annulInvoice` y la
mira este invariante, que pregunta las tres primeras cláusulas a la MISMA función que usa el caso
de uso, con la hora de la anulación.

**Consecuencias negativas.** (a) La regla no se impide en la base: un `UPDATE` directo a
`annulled` por SQL pasa, y lo que lo delata es el invariante, después. (b) El invariante comparte
la definición de la regla con el caso de uso: si la función se equivoca, se equivocan los dos; lo
que observa es que NADIE anule por fuera, no que la regla sea la correcta. (c) Cambio de contrato,
aditivo en la forma y no en el efecto: una factura ya no se anula sin `originals_in_hand: true`.
(d) Las anuladas antes del corte no se juzgan. (e) La caja uniforme bloquea de más en un negocio
con dos cajas: la factura de una deja de anularse cuando cierra la otra. (f) `period_declared` ya
no bloquea nada por sí sola; un período declarado fuera del sistema sigue sin dejar fila. (g) Otro
cambio de contrato: `POST /v1/credit-notes` responde 403 a quien solo tiene
`sales.return.manage`; un rol propio creado DESPUÉS de la migración con ese permiso no recibe el
nuevo solo.

HOMOLOGATION_IMPACT = YES: cambia cuándo una factura puede anularse y, con ello, qué entra al libro
de ventas como anulada y qué como nota de crédito.
