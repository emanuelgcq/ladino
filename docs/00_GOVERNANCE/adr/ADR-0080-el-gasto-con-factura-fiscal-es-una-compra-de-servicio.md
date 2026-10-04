# ADR-0080 — El gasto con factura fiscal es una compra de servicio

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (H-09). Hallazgos: H-09 (y cierra P-5 de `PENDIENTES_ASESOR.md`).
- **Fecha:** 2026-10-03.
- **Impacto fiscal:** SÍ: el gasto con factura entra al libro de compras, da crédito fiscal (LIVA art. 33) y la empresa agente le practica la retención de IVA (PA SNAT/2025/000054).
- **Enmienda:** ADR-0066 (la mercancía entra por una puerta) en lo que es una factura de proveedor: ya no toda línea lleva producto. ADR-0041/0055 (papeles y plantillas) con un hecho nuevo.

## Contexto
El recorrido del 2026-09-24 encontró (H-09) que un gasto con factura e IVA —la luz, el teléfono, el alquiler— se registraba como gasto llano: sin RIF, sin número, sin control y sin IVA. No entraba al libro de compras ni daba crédito fiscal, y una empresa agente no le retenía. El único camino al libro era la factura de proveedor, que exige un producto por línea y debita «mercancía recibida por facturar», un puente que un servicio no cierra nunca.

La respuesta del dueño (§3, H-09): «un gasto con factura fiscal es una compra de servicio: entra al libro de compras y da crédito (LIVA art. 33), capturando RIF, razón social, número, control, fecha, base por alícuota, IVA, exento; si la empresa es SPE, retiene salvo la exclusión del art. 3.8; la pantalla ofrece “con factura fiscal” / “sin factura”».

Restricciones: las reglas fiscales de una compra (libro, crédito o costo según el tipo de contribuyente, MODO sin RIF, agente, exclusiones como data, comprobante) ya viven en `registerSupplierInvoice`, y los invariantes `book_ledger_reconciliation`, `retention_voucher_gaps` y `accounting_coverage_gaps` las miran ahí. Equipo de una persona: una segunda copia de esas reglas es una segunda copia que mantener.

## Opciones consideradas
1. **El gasto con factura se registra por `registerSupplierInvoice`** (la elegida) — a favor: una sola implementación de libro, crédito, retención y comprobante; los invariantes existentes lo cubren sin cambiar. En contra: la línea de factura deja de exigir producto, y el gasto con factura no vive en `expenses`.
2. **Una rama fiscal dentro de `registerExpense`**, con columnas de IVA y retención en `expenses` — en contra: duplica las reglas, y el libro, la declaración y el TXT de retenciones tendrían que leer dos tablas.
3. **Un «producto de servicio» por cada categoría de gasto**, para cumplir el `product_id` — en contra: ensucia el catálogo, queda vendible en la caja, y una factura con parte gravada y parte exenta necesitaría dos productos.
4. **Una fila en `expenses` además de la factura** — en contra: el trigger de `expenses` mueve el saldo de la cuenta, así que el dinero saldría dos veces, y el gasto estaría dos veces en el mayor.

## Decisión
1. **`POST /v1/expenses` con el bloque `invoice`** registra una factura de proveedor por `registerSupplierInvoice` y paga su saldo por `registerSupplierPayment`, en una sola transacción (`registerInvoicedExpense`). Si cualquiera de los dos devuelve error, no queda nada escrito.
2. **La factura se marca con `supplier_invoices.expense_category`.** Sus líneas no llevan producto: llevan la categoría tributaria y la base tal como vienen impresas, y el IVA lo resuelve el mismo motor (`platform.resolve_tax`). Una línea sin producto solo vive en la factura de un gasto (CHECK + trigger `LADH9`).
3. **Su asiento usa la plantilla `purchase_invoice / ap.expense_invoice_posted`**: débito a gasto (y a crédito fiscal si el IVA es recuperable), crédito al proveedor por el neto y a lo retenido por enterar. Nunca el puente de mercancía.
4. **El evento es `ap.expense_invoice_posted`**, en la auditoría y en el outbox, con el mismo nombre que su hecho contable. Se publica EN VEZ de `ap.invoice_posted`, no además.
5. **Lo autoriza `expense.register`** (permiso anidado, RESPUESTA §2.8): quien lleva los gastos no necesita permisos de compras.
6. **No hay fila en `expenses`.** El historial de gastos y el resumen del negocio unen las dos fuentes; un gasto con factura cuenta como gasto por lo mismo que su asiento debita a gasto (la base si el IVA es crédito, el total si va al costo).
7. **La empresa sin RIF no lleva libro**: su tipo vigente es `no_contribuyente`, el IVA va al costo y `purchases_book` no la lista. Lo decide `registerSupplierInvoice`, sin rama propia.
8. **Las exclusiones de retención son data** (`retention_exclusions`, con su numeral): el servicio público domiciliado (art. 3 num. 8) lo marca la persona con su motivo, que queda auditado.
9. **Antes de confirmar, la pantalla enseña las cifras del servidor** (`POST /v1/expenses/preview`: el mismo registro de la factura y el mismo pago, deshechos al terminar): base por categoría, IVA, total, retenido y lo que sale de la cuenta en SU moneda, con la tasa BCV y su fecha si el pago cruza. Si la cuenta no alcanza, la vista previa lo dice SIN dejar de enseñar las cifras; el sobregiro se confirma al registrar, con su permiso y su motivo.
10. **La moneda de la factura es la IMPRESA** (`invoice.currency`; por omisión, la funcional). Las bases se escriben en esa moneda y así entran al libro de compras. La cuenta de la que sale el dinero puede vivir en otra: el pago cruza por `registerSupplierPayment` (ADR-0075 §3), con su tope `SETTLEMENT_MISMATCH`.

### Decidido por criterio (RESPUESTA §2.16), con su alternativa
- **El pago del gasto lleva el instrumento `otro`.** El gasto pregunta la cuenta, no la forma de pago, y `otro` no presume una moneda. Alternativa: preguntar el instrumento.
- **La moneda de la factura la dice quien registra (por omisión, bolívares), no la cuenta** (revisión de la ola 4). Antes la factura heredaba la moneda de la cuenta: una factura de luz impresa en Bs pagada desde una cuenta en USD entraba al libro como factura en USD, y el libro llevaba base × tasa en vez de lo impreso. Alternativa descartada: heredar la moneda de la cuenta con un aviso en la pantalla.
- **`invoice` + `amount` se rechaza (422).** Con factura el importe lo calcula el servidor. Alternativa: aceptarlo y compararlo con el calculado.
- **`invoice` + `branch_id` se rechaza (422).** La factura de proveedor no tiene sucursal. Alternativa: añadir la columna.
- **El día del gasto, en el resumen sin contabilidad, es el de la factura** (o el contable si llegó tarde), que es el día en que se asienta. Alternativa: el día del pago, como el gasto llano.

## Consecuencias
- **Positivas.** Una sola implementación de libro, crédito, retención y comprobante. Los invariantes cruzados cubren el gasto con factura sin tocarse. Quien lleva los gastos no necesita permisos de compras.
- **Negativas y deuda que aceptamos.**
  - `supplier_invoice_lines.product_id` deja de ser obligatorio: todo lo que lea esa columna suponiendo un producto recibe nulos en las facturas de gasto.
  - «Los gastos» viven en dos tablas; cada lectura nueva de `expenses` tiene que acordarse de la otra (hoy: el listado y el resumen).
  - El proveedor se elige de la lista: no hay alta en línea desde el gasto.
  - **Un gasto con factura mal registrado no tiene corrección hoy.** La nota de crédito de proveedor exige `product_id` por línea y no existe la anulación de una factura de proveedor: la factura de un gasto, que no lleva producto, no se puede corregir ni anular. Deuda con destino: **ola 5, familia «NC de proveedor» (H-03)**, que tiene que admitir la línea de servicio.
  - **CERRADO el 2026-10-04 (ADR-0075, nota «el pago cruzado a tasa real»): una factura en Bs pagada desde una cuenta en divisa cierra a cualquier tasa.** El pago cruzado tolera el redondeo de caja (media unidad mínima de la moneda del dinero a la tasa del pago), lo funcional del pago es lo que se salda y no nace diferencial por el céntimo de dólar; probado a 854,4637 con su vista previa (`e2e-gasto-con-factura`, «a TASA REAL»). Lo que decía antes: ~~Una factura en Bs pagada desde una cuenta en divisa solo cierra si la conversión cae exacta.~~ Lo que sale se redondea al céntimo de la divisa, y ese redondeo (hasta medio céntimo × tasa) no cabe en la cota del tope de `registerSupplierPayment` (ADR-0075 regla 4), que solo cuenta la unidad mínima de la moneda de la FACTURA. A una tasa real el pago se rechaza con 409 `SETTLEMENT_MISMATCH` y no se registra nada (falla del lado ruidoso; la vista previa lo dice antes). Es un límite del pago cruzado de la ola 3, no del gasto: ampliar la cota es una decisión de ADR-0075 que no se tomó aquí.
  - La vista previa registra y deshace una factura y un pago en cada consulta: toma los candados del comprobante de retención y de la cuenta mientras dura. La pantalla espera 400 ms de reposo y cancela la petición anterior.
  - La retención de ISLR no se ofrece en el gasto (P-96); la deducibilidad del crédito no se pregunta (P-94); la exclusión del art. 3 num. 8 no verifica la domiciliación (P-95) — **desde el 2026-10-04 sí comprueba que la cuenta sea bancaria: ver la nota AF4-01, abajo**.
  - Un gasto con factura mal registrado no tiene corrección ni anulación, y su crédito, su retención y su comprobante quedan como se registraron: la pregunta al asesor es P-102 (AF4-02).
  - Un consumidor del outbox que quiera todas las facturas de proveedor escucha dos eventos.
- **Qué habría que cambiar para revertirla.** No se revierte con datos vivos (las migraciones 20261004170000 y 20261004170100 lo dicen): habría que migrar las facturas de gasto a otra forma. Antes de la primera factura de gasto, basta quitar el bloque `invoice` del contrato y las columnas.

## Nota de la auditoría fiscal de la ola 4 (2026-10-04) · AF4-01: la exclusión del servicio público domiciliado exige cuenta bancaria
- **Qué dice la norma.** PA SNAT/2025/000054 art. 3 num. 8, literal en la reproducción de ivecofi leída el 2026-10-04 (reproducción no oficial; cotejo con la Gaceta pendiente): no se retiene en electricidad, agua, aseo y telefonía «pagados mediante domiciliación a cuentas bancarias de los agentes de retención». Son dos condiciones: la clase de servicio y el medio de pago. Manda la norma (RESPUESTA §0).
- **Qué pasaba.** El punto 8 de la Decisión dejaba la exclusión a la marca de la persona. En el gasto con factura la cuenta de la que sale el dinero se conoce en el mismo acto, y un gasto de luz pagado en efectivo desde una caja se podía marcar excluido: el agente dejaba de retener cuando debía.
- **Qué se cambió (lo que el texto respalda, nada más).** En el gasto con factura, `servicio_publico_domiciliado` se rechaza con 422 cuando la cuenta no es de clase banco (`company_accounts.kind <> 'bank'`: caja o monedero). La comprobación vive en `registerSupplierInvoice`, con la cuenta que le pasa `registerInvoicedExpense`; la vista previa (`POST /v1/expenses/preview`) pasa por el mismo código y dice lo mismo antes de confirmar. `GET /v1/retention-exclusions` acepta `account_id` y no ofrece la exclusión para esa cuenta: la pantalla no decide nada. Desde la misma caja, sin la exclusión, el gasto se registra y retiene.
- **Qué NO se cambió.** La factura de proveedor registrada sin pago (`POST /v1/supplier-invoices`, la llegada de mercancía): el medio de pago no se conoce aún. La clase de servicio no se valida contra nada, ni qué cuenta como «domiciliación»: sería criterio, y es P-95.
- **Decidido por criterio, con su alternativa.** (1) «No bancaria» es toda cuenta que no sea de clase banco, incluido el monedero. Alternativa: rechazar solo la caja. (2) El código de la exclusión condicionada es una constante del dominio (`EXCLUSIONES_CON_CUENTA_BANCARIA`), no una columna del catálogo `retention_exclusions`. Alternativa: la columna, con su migración; cambiaría el hash de reglas de ADR-0079, y se deja para cuando una segunda exclusión dependa del medio de pago. Consecuencia negativa: es una regla del art. 3 que no está en la data, a diferencia de las demás (R-80.15).
- **Verificación.** `apps/api/test/e2e-gasto-con-factura.test.ts`, caso «AF4-01»: desde una caja, 422 con su mensaje al registrar y en la vista previa, sin factura, sin acta y sin mover el saldo; desde la misma caja sin exclusión, 201 reteniendo; desde el banco, 201 sin retención con su acta `ap.retention_excluded`; el catálogo con `account_id`.

## Verificación
- `apps/api/test/e2e-gasto-con-factura.test.ts`: libro, crédito, retención con comprobante, neto que sale de la cuenta, asiento a la misma cuenta que un gasto llano, exclusión con acta, atomicidad sin saldo, permiso anidado, empresa sin RIF, evento, vista previa, «lo que gané» igual con y sin factura, e invariantes en cero.
- `supabase/tests/127_an_invoiced_expense_is_a_service_purchase_test.sql`: la línea sin producto solo en la factura de un gasto, con su variante rota.
- `supabase/tests/026_journal_generator_test.sql`: el evento del preset es el del outbox.
- `pnpm recorrido H`: el caso H-09 sobre el escenario del recorrido.
- Revisión: cuando el asesor responda P-94 a P-96.
