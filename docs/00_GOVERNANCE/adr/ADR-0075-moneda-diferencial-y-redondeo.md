# ADR-0075 — Moneda, diferencial y redondeo: el precio es USD, la factura es Bs, el mayor va al céntimo

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.7 y respuesta a la pregunta del céntimo). Hallazgos: D-02, D-07, H-02, F-01, F-02, G-05, H-06, G-12, F-15, E-05, E-11, F-04, J-04, P-01, P-03 y K-08.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** SÍ: los importes en Bs de la factura, los libros y la declaración.
- **Enmienda:**
  - ADR-0058 (el documento se redondea a la moneda);
  - ADR-0060 (el costo de lo vendido y el inventario en el mayor);
  - ADR-0063 (el céntimo de la caja): tras esta enmienda, **ocho decimales solo para costos unitarios y tasas; ningún importe del mayor con más de dos**.

## Contexto
El recorrido encontró:
- facturas en Bs que no salen de su base en USD con una regla única (E-05);
- un pago cruzado que la pantalla no ofrece (D-02);
- el diferencial cambiario reconocido a destiempo o nunca (D-07, H-02, F-02, G-05);
- documentos pagados que vuelven a deber por una tasa tardía (F-02);
- céntimos sueltos en la cartera (G-12, F-15);
- un mayor con fracciones de céntimo (P-01, P-03, K-08);
- cajas y cartera en USD que nunca se revalúan (E-11, F-04, J-04).

## Decisión
1. **El precio sigue anclado en USD (ADR-0046).** La factura, los libros y la declaración van en Bs (PA 00071 art. 13.14).
   - **Cálculo fiscal por línea:** `base_bs = round(base_usd × tasa_factura, 2)`; `iva_bs = round(base_bs × alícuota, 2)`; los totales son sumas.
   - El USD es la contraprestación pactada y lo que se cobra; el Bs es el importe fiscal.
   - La deuda del cliente es `total_usd`.
   - **Invariante nuevo:** en todo documento fiscal, `iva_bs = round(base_bs × alícuota, 2)` exacto por alícuota, y `|total_usd × tasa − total_bs| ≤ 0,01 × líneas`.
2. **Tasa de un documento:** la BCV del día de emisión, congelada en el documento.
   - La NC y la ND que corrigen una factura van a la tasa de la factura, impresa con su número y su fecha (ola 2).
   - La ND por un concepto nuevo va a la tasa de su día (ola 2).
3. **Pago cruzado:** cualquier documento se paga en cualquier moneda, a la BCV del día del pago, y la pantalla lo propone.
4. **Diferencial cambiario:**
   - se reconoce al pagar, contra «Ganancia en diferencial cambiario» o «Pérdida en diferencial cambiario», con los códigos del plan de la empresa (los confirma el contador);
   - la CxC y la CxP se cierran en cero exacto: un documento con saldo 0 está cerrado y no vuelve a deber por una tasa tardía;
   - el ±0,01 va al diferencial o a «Diferencias por redondeo», nunca se queda en la cartera;
   - el saldo a favor conserva la moneda del documento y se revalúa como la deuda.
5. **Una sola función de deuda:** nominal en USD; Bs a la tasa de hoy solo para mostrar. El aviso al cliente dice USD y Bs con la tasa y la fecha.
6. **Partidas monetarias:**
   - cada línea de asiento guarda importe original, moneda y tasa (los siete campos de ADR-0020);
   - las cajas y la CxC/CxP en USD se revalúan al cierre del período con un asiento de revaluación (VEN-NIF PYME secc. 30);
   - las vistas «a la tasa de hoy» son cálculo con nota, no asiento.
   - **Invariante nuevo:** el saldo en USD de cada cuenta de tesorería = la suma de los importes originales en USD de su subcuenta, y lo mismo en Bs.
7. **Todo el mayor al céntimo, incluido el inventario (respuesta del dueño del 2026-09-28):**
   - el costo unitario y el promedio siguen con 8 decimales;
   - el valor de cada movimiento (cantidad × costo) se redondea half-up al céntimo al escribirse en el kardex;
   - el valor acumulado del kardex = la suma de los valores redondeados, y el asiento usa ese mismo valor;
   - el promedio derivado = valor / cantidad, a 8 decimales;
   - cuando la cantidad llega a 0 con céntimos residuales, el mismo movimiento lleva el residuo a «Diferencias por redondeo»;
   - el importe funcional de todo asiento va al céntimo, half-up, y el residuo de conversión de cada asiento va a «Diferencias por redondeo».
   - **Migración:** `inventory_moves` es append-only y no se toca. Una regularización al corte, por empresa y producto, lleva la fracción acumulada a «Diferencias por redondeo», con acta (como ADR-0060).
   - Half-up y la cuenta quedan en PENDIENTES_ASESOR.
8. **Reversa de un cobro y restitución de un IGTF indebido (R-61, P-67):** se construyen juntas. La reversa es un movimiento de reversa con motivo y acta, append-only, que reabre el saldo del documento por la única función de deuda y revierte su asiento. La corrige el contador (`ar.retention.correct` para la retención soportada; el permiso propio de la reversa de cobros).

## Consecuencias
- **Positivas.**
  - Una sola regla fiscal de conversión y una sola función de deuda.
  - Documentos pagados que no vuelven a deber.
  - Un mayor sin polvo.
  - Partidas monetarias revaluadas.
- **Negativas.**
  - La regularización al corte genera asientos en las empresas existentes (no hay clientes reales).
  - Los libros y declaraciones regenerados cambian de hash por el céntimo.
  - Hay que confirmar los códigos de las cuentas de diferencial con el contador.
- **Para revertir:** las reglas de redondeo son de dominio. Las regularizaciones son asientos posteados y se revierten con su reversa.

## Verificación
- Los invariantes nuevos (IVA por alícuota exacto, la conversión USD↔Bs y la tesorería en dos monedas) entran en CLAUDE.md §3 y en `pnpm recorrido`.
- E2E: pago cruzado; diferencial al pagar; documento pagado que no reabre; revaluación al cierre; el céntimo del kardex; reversa de un cobro.
- `pnpm recorrido D`, `E`, `F`, `G`, `H`, `J`, `K` y `P`.


## Nota de aplicación — §7, el céntimo (ola 3, 2026-10-03; P-01, P-03, K-08)

- **Función única:** `platform.round_cents(numeric)` (SQL) y `toCents` / `CENTS_POLICY` de `@ladino/money` (TS). La familia «moneda y diferencial» las reutiliza.
- **La cuenta:** papel `rounding_difference`, cuenta 5.1.10 «Diferencias por redondeo» (gasto, deudora, admite los dos signos como 5.1.06) en ve_basico y en los planes importados, con acta. No había cuenta de redondeo previa (ADR-0063 absorbía el residuo del cobro en la conversión).
- **Kardex:** el valor de cada movimiento al céntimo en `costing.ts`, `totalDeEntrada`, `revalorizar` y la revalorización de compras; el oráculo (`apply_inventory_move`, sobre 20260826222915 §9) verifica la salida contra el redondeo al céntimo y rechaza (LAD41) una fracción de céntimo sobre una posición al céntimo. Con todo al céntimo, vaciar una posición saca exactamente su valor.
- **Asientos:** el generador lleva cada línea al céntimo y el residuo a `rounding_difference` en el mismo asiento; si lo exacto no cuadra sigue siendo ENTRY_UNBALANCED. En el origen, al céntimo: gasto, transferencia (treasury.ts) y pago a proveedor (purchases.ts) — P-03.
- **Libro de compras al céntimo** (20261003140000 §4 y 20261003140100, que conserva la escala de texto): sin él, el asiento al céntimo rompía `book_ledger_reconciliation`. HOMOLOGATION_IMPACT YES.
- **Servir:** «Lo que gané» y gastos del Inicio (negocio.ts) y los estados financieros (accounting.ts) con `round(…, 2)`.
- **Regularización al corte:** `cent_regularization_prepare` / `repairCents` / `cent_regularization_finish`, por posición (kardex) y por cuenta (mayor), acta `accounting.cent_regularized` (= corte del invariante). En los post-pull de `pnpm recorrido`. Idempotente.
- **Invariante:** `platform.cent_gaps(company)`, cero filas, **sin salvedades** (20261003190000 quitó la de la reversa); `invariantes.sql` y pgTAP 105 y 108, con la variante rota de cada una de sus cuatro ramas.
- **Decidido por criterio (§2.16):**
  1. *Residuo en cantidad 0.* La regla literal del dueño: «cuando la cantidad llega a 0 con céntimos residuales, el mismo movimiento lleva el residuo a “Diferencias por redondeo”». Lo aplicado: con el valor al céntimo, la salida que vacía saca TODO el valor, así que el residuo no nace y no hay nada que llevar. **Alternativa** (la literal): un campo de residuo en el movimiento del kardex y una línea a redondeo en cada plantilla de salida. El residuo de una ENTRADA sobre existencia negativa es diferencia de costo, no redondeo, y sigue visible en el valor (ADR-0034 §Negativo).
  2. *Empresa sin contabilidad* (revisión de la ola 3; 20261003190000, corregida en 20261003190200): su KARDEX se regulariza igual y NO produce asiento. La regularización deja una fila de cola (`inventory_move` / `stock.cent_regularized`) que nace **descartada**, con su motivo («regularización del céntimo sin contabilidad: no produce asiento; el corte de ADR-0060 valora el kardex al adoptar la contabilidad») y su acta `accounting.pending_discarded`, en la misma transacción. No queda `pending`: ninguna plantilla podría resolverla (su importe es una suma de fracciones de céntimo, que al céntimo es cero y el generador descarta) y una fila pendiente hace que `closeFiscalPeriod` y `closeFiscalYear` rechacen para siempre. El enunciado de `inventory_coverage_gaps` (y el `en_cola` de `inventory_ledger_gap`) pasa a decir: asiento, cola pendiente, **o descartada con acta**; una descartada sin acta sigue sin cubrir nada. `cent_gaps` da cero también ahí. No es «como cualquier movimiento de valor sin contabilidad»: esos esperan una plantilla; este no la puede tener. El mismo camino resuelve el caso en que las fracciones del kardex netean a cero exacto y el mayor no trae ninguna (no hay asiento de importe cero). **Alternativa:** no encolar, y exceptuar en el enunciado de `inventory_coverage_gaps` los movimientos de la regularización de una empresa sin contabilidad. La empresa con mayor y sin papel de inventario (servicios) regulariza su mayor.
  3. *Residuo por alícuota del libro de compras:* «< 0,01» pasa a «≤ 0,01» hacia la alícuota mayor. **Alternativa:** dejarlo en «sin alícuota».
  4. *Posición vacía con valor* (20261003190000): en la regularización, una posición con cantidad 0 es polvo de redondeo si |valor| ≤ 0,005 × (movimientos de esa posición), y entonces va entera a redondeo; por encima, solo la FRACCIÓN de céntimo va a redondeo y el resto queda visible en el valor (es diferencia de costo, ADR-0034): la función lo devuelve en `visible_empty_positions` y el script lo lista con producto, depósito e importe. Nada falla y nada se esconde en 5.1.10. **Alternativa:** fallar por encima de un céntimo.
  5. *La reversa de un asiento con fracción* (20261003190000): se genera AL CÉNTIMO, como cualquier asiento nuevo — cada línea espejo redondeada y el residuo a `rounding_difference` en el mismo contra-asiento (`reversar`, accounting.ts). La regularización ya se llevó la fracción del saldo: el espejo exacto lo dejaría en −fracción; al céntimo lo deja en cero. Ningún trigger exigía el espejo exacto (comprobado en el catálogo). Con eso `cent_gaps` no necesita la salvedad de la reversa. **Alternativa:** mantener la reversa exacta y perdonarla también en la rama de saldos.
  6. *El asiento manual* (20261003190000; la excepción, corregida en 20261003190200): «ningún importe del mayor con más de dos decimales» falla activamente. El dominio rechaza (422, «Los importes del asiento llevan como máximo dos decimales») y la base rechaza al POSTEAR (LAD71, en `platform.assert_entry_balanced`, junto a la partida doble). El enunciado completo de LAD71: toda línea al céntimo en moneda funcional, salvo el asiento de la propia regularización, cuyo oficio es llevarse la fracción. Ese asiento se reconoce por un MECANISMO, no por una etiqueta: su id está en `platform.cent_regularization_entries`, una tabla sin GRANT a nadie y con RLS forzada sin policies donde solo escribe `cent_regularization_prepare` (que tampoco tiene GRANT). La 190000 lo reconocía por `source_kind`/`source_event`, que la API puede escribir: con esa etiqueta posteaba fracciones (pgTAP 108 lo prueba como `ladino_api`). Los asientos ya posteados no se tocan. **Es un cambio de comportamiento del endpoint** (el esquema Zod y el OpenAPI no cambian): un cliente que mandaba 8 decimales recibe 422. **Alternativa:** redondear en silencio lo que llega.
  7. *La política guardada en el kardex* (C3): el movimiento tiene una sola columna `rounding_policy_id` y guarda la que PRODUJO su importe, `ledger:cents:2:HALF_UP`; el importe se redondea UNA vez, de lo exacto al céntimo (antes a 8 y luego a 2, que difiere en el borde). La política del costo unitario (`inventory:cost:8:HALF_UP`) no necesita columna: el costo unitario es derivado (valor / cantidad a 8) y lo comprueba el oráculo. **Alternativa:** una segunda columna para la política del costo unitario.
  8. *Período cerrado:* la regularización fecha su asiento HOY (día de Caracas). Si el período de hoy está cerrado, falla diciéndolo (LAD61) y la transacción entera se deshace: no queda kardex regularizado sin su asiento. **Alternativa:** llevarlo al primer período abierto.
  9. *La declaración convierte como el libro* (AF3-09): `recompute_iva_period` suma los créditos, las notas de crédito y el ajuste de períodos anteriores con `round(iva × tasa, 2)` por documento, la misma regla de `purchases_book` (RLIVA art. 72: el resumen del libro coincide con lo declarado). La declaración NO lee del libro: son dos consultas con la misma regla, y `pnpm recorrido K` las compara mes a mes. La prorrata sigue a 8 decimales: no se tocó.
  10. *Facturación parcial contra una recepción* (C8, reproducido): 100,00 recibido por 3 unidades y tres facturas de 33,33 dejaban «mercancía recibida por facturar» con 0,01 para siempre, porque la diferencia factura/recepción se medía por factura y cada −0,0033 redondeaba a cero. Ahora se mide contra el ACUMULADO de la línea de recepción (lo facturado hasta esta factura menos lo facturado hasta la anterior), y la factura que la cierra compara contra el valor recibido entero, al céntimo: se lleva el residuo (`purchases.ts`). Una línea de recepción que ya estaba a medio facturar en el momento del despliegue puede diferir en un céntimo respecto de la regla vieja. **Alternativa:** llevar el residuo del puente a «Diferencias por redondeo» al cerrar la recepción.
  11. *Entrada en moneda propia con importe que no está al céntimo* (encontrado al escribir el test de C8): 3 × 33,3333 = 99,9999 se rechazaba con un 422 genérico — el importe de la transacción iba sin redondear y el funcional al céntimo, y la base exige que en moneda propia sean el mismo (`inventory_moves_identity_chk`). El movimiento guarda ahora el importe al céntimo en los dos campos. **Alternativa:** relajar el CHECK para admitir la diferencia de redondeo.
  12. *El cierre de ejercicio se arma al céntimo* (S1): `closeFiscalYear` cierra cada cuenta de resultado por su saldo DEL AÑO al céntimo y el resultado es la suma de esos céntimos, así que el asiento cuadra por construcción y no necesita línea de redondeo. Antes copiaba el saldo a 8 decimales: si las fracciones viejas y la regularización caen en ejercicios distintos (la regularización se fecha el día que corre), el saldo del año trae fracción y el cierre moría en LAD71, con el mensaje del asiento manual y sin salida por la API. La fracción (menos de medio céntimo por cuenta) queda en el saldo de ese año y la compensa la regularización en el ejercicio en que corrió; el saldo de toda la vida de la cuenta sigue al céntimo. **Alternativa:** fechar la regularización en el ejercicio de cada fracción (un asiento por ejercicio, en períodos que pueden estar cerrados).
  13. *El costo de la factura contra la recepción, un solo redondeo* (C5): `toCents(costo × tasa)`, de lo exacto, igual que el acumulado previo que sale de SQL (`round(x × tasa, 2)`); antes pasaba por 8 decimales y en el borde (10,004999995) dos facturas de la misma línea medían el mismo número con dos reglas. Los importes funcionales de la RECEPCIÓN y del documento siguen pasando por 8 decimales (E-05, familia de moneda): en ese borde el puente puede quedar con un céntimo por ese lado.
  14. *El libro a los dos lados del corte del céntimo* (20261003190400; corrige la 140000 y la decisión 9): el renglón del libro de compras de un documento REGISTRADO antes del corte del céntimo de su empresa se reproduce como se generó, a 8 decimales; el de uno posterior va al céntimo. El corte es el instante del acta `accounting.cent_regularized` más antigua, contra el `created_at` del documento (instante contra instante). La declaración (`recompute_iva_period`) convierte igual a los dos lados, y `book_ledger_reconciliation` no cuenta en el mayor el asiento de la regularización del céntimo (no es un hecho fiscal; se reconoce por el registro privado). Así «libro fiscal = mayor + cola» vale cero EXACTO en cualquier rango, mes a mes y en toda la historia, y el libro de un período ya generado o declarado no cambia de cifras (K-08; su hash vuelve a ser el de antes de la 140000). La 140000 convertía al céntimo todos los períodos: el período heredado descuadraba por la fracción y el de la regularización por su asiento, y la historia entera lo tapaba porque se compensan; por eso `scripts/recorrido/invariantes.sql` concilia ahora también mes a mes (21 invariantes). Casos que el enunciado declara: una empresa SIN acta convierte todo al céntimo (si tiene fracciones heredadas, `cent_gaps` y la conciliación la señalan hasta que regularice); un documento registrado en la ventana entre el `git pull` y la regularización se asienta al céntimo y el libro lo convierte a 8 (R-71: no operar en esa ventana); el libro de un período anterior al corte sigue enseñando sus 8 decimales, y redondearlos al servir es de la pantalla (ADR-0063), no del libro. El libro de VENTAS no cambia: cuadraba en los períodos viejos. **Alternativa:** comparar al céntimo con una cota declarada (|libro − (mayor + cola)| ≤ 0,005 × renglones) antes del corte: más simple, pero el libro de un período viejo cambia respecto del que se generó y la conciliación deja de ser exacta.
- **Abierto:** las declaraciones guardadas (K-08) no se reescriben (append-only): regenerar da una corrida nueva con hash nuevo, y una declaración ya presentada se corrige como diga la norma (LIVA art. 50: ajuste en el período en que se detecta si no cambia el impuesto a pagar; sustitutiva si lo cambia): P-80. Los importes funcionales de los DOCUMENTOS de compra siguen a 8 en sus filas (E-05, familia de moneda). La fila de la cola de una empresa sin contabilidad queda pendiente hasta que la empresa adopte contabilidad (su corte de ADR-0060 la deja atrás). Si las fracciones del kardex de una empresa netean a cero exacto y su mayor no trae ninguna, la regularización falla diciéndolo (no hay asiento posible): se revisa a mano. pgTAP 019 (inventario) fijaba la regla de 8 decimales y quedó en rojo con la 20261003140000; sus aserciones se llevaron al céntimo con aprobación (los datos de 8 decimales son ahora la prueba del rechazo LAD41; el promedio sigue a 8). Si una empresa regularizó sin contabilidad y después la adopta SIN el corte de ADR-0060 (procesando su cola histórica), cada movimiento viejo se asienta al céntimo y el mayor de inventario queda en Σ round(movimiento), que puede diferir en céntimos del kardex regularizado: lo enseña `inventory_ledger_gap`; el camino previsto es el corte. **No existe hoy la anulación de una factura de proveedor** (ni caso de uso ni endpoint): el acumulado factura/recepción de la decisión 10 solo cuenta facturas vigentes, y quien construya esa anulación tiene que reversar con ella su asiento `purchase_revaluation` y su revalorización del kardex. **La nota de crédito del proveedor** no toca «mercancía recibida por facturar» (no entra en ese acumulado ni tiene por qué), pero acredita inventario en el mayor sin mover el kardex: `inventory_ledger_gap` queda en el importe de la nota (visto en `e2e-inventario-en-el-mayor`; es de la familia de compras, no del céntimo).
- **Lo que las cabeceras de 20261003140000/140100 decían y no era cierto** está corregido en la cabecera de 20261003190000: el libro por alícuota perdía el signo de la NC, del ajuste y de la anulada (HOMOLOGATION_IMPACT YES, no «NO adicional»); la declaración no «lee» del libro; `cent_regularization_repair` no existe (son `_prepare` y `_finish`).

## Nota de aplicación — §1-4, moneda A (ola 3, 2026-10-03; E-05, D-02, D-07, H-02, F-01, F-02, F-15, G-12, H-06)

Migraciones `20261003170000_the_differential_is_recognized_when_paying` y `20261003170100_the_settlement_reads_the_entry_by_its_source`.

- **§1, el fiscal en Bs (E-05):** `insertarDocumento` (packages/domain/src/sales.ts) calcula por línea `base_bs = round(base_divisa × tasa, 2)`, `iva_bs = round(base_bs × alícuota, 2)`, total = suma. Es el único sitio donde nace un documento de venta (factura, NC, ND, recibo). La deuda sigue siendo `amount_transaction_currency`. Un documento en moneda funcional no cambia. HOMOLOGATION_IMPACT YES.
- **Invariante `platform.fiscal_amount_gaps(company)`:** por línea el IVA funcional es round(base × alícuota, 2); el pie es la suma de sus líneas; y el total en divisa a la tasa no se aparta del total funcional más que el redondeo por línea. Corte en el enunciado (`platform.invariant_cutoffs`): lo emitido antes no se edita (regla 1). pgTAP 109 con una variante rota por cada regla.
- **§3, pago cruzado (D-02):** en ventas ya existía (ADR-0047). En compras, `registerSupplierPayment` admite pagar en otra moneda a la BCV del día: la fila del pago va en la moneda del DINERO (la de la cuenta; LAD67 intacto) y lo cancelado va en `supplier_payments.settled_amount` / `settled_currency`, en la moneda de la factura. `platform.supplier_invoice_balance` resta `coalesce(settled_amount, net_amount)`.
- **§4, diferencial al pagar (D-07, H-02):** el pago debita la CxP por lo cancelado a la tasa de la FACTURA; la diferencia con lo que salió (`supplier_payments.exchange_difference`, positivo = pérdida) va a `exchange_loss` / `exchange_gain` (5.1.02 / 4.1.02 de ve_basico, que existen desde la migración 20260827233538; se crean en los planes que no las tengan, con acta). Plantilla `payment_made`: la línea de la CxP pasa de `net_amount` a `total` y se añaden las dos del diferencial, sin reescribir la plantilla de ninguna empresa.
- **§4, cierre en cero exacto (F-15, G-12):** el cobro o pago que cierra cancela exactamente lo que el mayor todavía le carga al documento (`platform.settlement_ledger_open`; si alguna pieza está en la cola, lo mismo calculado desde las filas), y la diferencia va al diferencial. En la retención soportada —que abona a la tasa de la factura, sin diferencial (F-01, P-30)— el céntimo del cierre va a `rounding_difference` (dos líneas nuevas en `ar.retention_applied`).
- **§4, lo saldado se congela (F-02, G-12):** `payments.settled_transaction_amount` guarda lo que cada cobro saldó en la moneda del documento, con la tasa que valía al cobrar. Lo lee la función de saldo de la familia «moneda B» (20261003180000). Los cobros anteriores no se rellenan.
- **Invariante `platform.settled_ledger_gaps(company)`:** documento saldado desde el corte ⇒ nada en cuentas por cobrar o por pagar del mayor. La primera versión de `settlement_ledger_open` (170000 §6) buscaba el asiento del cobro por una columna que no se escribe y dejaba el invariante INERTE; lo destapó el E2E y lo corrige la 170100. Su variante rota está en e2e-moneda-diferencial.
- **H-06:** el pedido nace en la moneda de la lista con la que la empresa vende (`apps/web/src/moneda-del-pedido.ts`), y el precio dice su moneda.

**Decidido por criterio (§2.16):**
1. *La tolerancia de la conversión.* El enunciado «|total_usd × tasa − total_bs| ≤ 0,01 × líneas» es inalcanzable tal cual: el IVA en divisa se redondea al céntimo de dólar (hasta 0,005 USD por línea, unos 4 Bs a la tasa actual), y eso ya separa las dos cifras (la línea «Brocha» del hallazgo: 3,42 Bs). Se implementó lo que dice la respuesta a E-05 —«la diferencia tolerada es la de redondeo por línea»—: media unidad mínima de la divisa × tasa + 0,01 Bs, por línea. **Alternativa:** cobrar el IVA en divisa sin redondear (la deuda dejaría de ser un importe en céntimos de dólar), o derivar el total en divisa del total en Bs. Queda como P-85.
2. *El diferencial de un pago parcial y el del que cierra.* Un abono cancela `round(saldado × tasa de la factura, 2)`; el que cierra, lo que quede en el mayor. La separación de E-05 entre total en Bs y total en divisa × tasa cae así en el último cobro, como diferencial. **Alternativa:** prorratear el total en Bs entre los cobros (daría un «diferencial» de céntimos en cada abono aun a la misma tasa, contra ADR-0063 §3).
3. *El pago cruzado sin cambiar el contrato.* Con `currency` = la de la factura y una cuenta en otra moneda, `gross_amount` es lo que se cancela y de la cuenta sale su equivalente del día; con `currency` distinta, `gross_amount` es el dinero que salió. **Alternativa:** un campo nuevo (`settle_amount`) en `RegisterSupplierPaymentRequest`.
4. *Las cuentas del diferencial.* Se reutilizan los papeles `exchange_gain` / `exchange_loss` y sus cuentas, sin renombrarlas en las empresas que ya las tienen («Ganancia cambiaria» / «Pérdida cambiaria»). **Alternativa:** cuentas nuevas con el nombre literal y migrar los saldos.
5. *El céntimo del cierre por retención* va a redondeo y no a diferencial, porque la retención no es cambiaria. **Alternativa:** al diferencial, como los demás cobros.

**Abierto:**
- **G-05 (el saldo a favor en USD) NO se hizo.** Anclarlo cambia tres caminos: aplicarlo (el pasivo se registró a la tasa de la nota; al aplicarlo hay que bajarlo a esa tasa y llevar la diferencia con la CxC al diferencial), reembolsarlo (`refundCustomerCredit` exige hoy una cuenta en la moneda del saldo y asienta a tasa 1; su plantilla `ar.credit_refunded` no tiene líneas de diferencial) y revaluarlo al cierre (familia «moneda B»). `customer_credits` necesita la tasa y la fuente del documento de origen. Los saldos a favor ya creados en VES no se convierten solos.
- La nota de crédito de PROVEEDOR sigue valorada a la tasa de su fecha (SOSPECHA de H-02): baja la CxP por un importe distinto al que la factura cargó. El pago que cierra lo absorbe en el diferencial; una factura saldada solo con notas, no.
- Los residuos anteriores al corte (000123 y F-88771 en compras; los ±0,01 de ventas) no se regularizan solos: P-84.
- El pedido en una moneda y la llegada en otra (SOSPECHA de H-06, servidor) sigue sin validarse.

## Nota de aplicación — §5, §6 y §8, moneda B (ola 3, 2026-10-03; E-11, F-04, J-04, R-61, P-67)

Migración `20261003180000_one_debt_the_ledger_keeps_the_currency_and_a_payment_reverses.sql`.

- **§5 · una sola función de deuda:** `platform.document_debt(empresa, documento)` devuelve el nominal en la moneda del documento y, solo para mostrar, su valor funcional a la tasa de hoy, con la tasa y la fecha. `document_debt_today` es su columna `functional_today`; `customer_debt_today` es su suma por cliente (o por empresa); `ar_aging` sale de ella. La lista de clientes, «Debe hoy», el estado de cuenta, la antigüedad y «Lo que me deben» llaman a esas funciones. El estado de cuenta trae `debt.by_currency` (nominal, tasa, fecha) y de ahí sale el WhatsApp: «USD X = Bs Y a la tasa BCV del dd/mm/aaaa». «Saldo restante» del cobro se lee del estado de cuenta, no del saldo contable. **Un documento `paid` debe 0,00** (§4).
- **§6 · la divisa en el mayor (E-11):** el generador escribe en la línea de la caja en divisa su moneda, el importe original y la tasa (`platform.treasury_original_of`, mismas fuentes que `treasury_account_of`). El contra-asiento de una reversa copia la moneda y la tasa de la línea que deshace. Las demás líneas (cuentas por cobrar, ingresos, impuestos) siguen en moneda funcional: ver «Abierto».
- **§6 · invariante (J-04):** `platform.treasury_currency_gaps(empresa)`, cero filas: el saldo de cada cuenta de tesorería, en su moneda, = Σ de los importes originales en esa moneda de su subcuenta. En `invariantes.sql` y pgTAP 110, con sus dos variantes rotas (USD y Bs). **Lo anterior a la migración** se lleva al mayor con una regularización al corte (`treasury_currency_regularization_prepare` + `repairTreasuryCurrency`, script `scripts/reparar/adr-0075-divisa-del-mayor.mjs`, acta `treasury.currency_regularized`): un asiento por empresa con, por caja, una línea en la divisa y su contraria en la misma subcuenta en moneda funcional. No cambia ningún saldo en bolívares. Corre en el post-pull.
- **§6 · revaluación al cierre:** `closeFiscalPeriod` asienta, antes de cerrar un mes, la revaluación de las cajas y de las cuentas por cobrar y por pagar en divisa a la TASA DE CIERRE (`platform.closing_rate`, ver la revisión de abajo: la oficial vigente a la fecha de cierre y no más vieja que el margen de `platform.parameters`) (`platform.fx_revaluation_items`; asiento `exchange_diff` / `fx.revaluation_at_close`, contra los papeles `exchange_gain` / `exchange_loss`, acta `accounting.fx_revalued_at_close`). Sin tasa de cierre o sin esas cuentas, el cierre no se hace y lo dice. Las líneas van en moneda funcional: la revaluación no mueve dólares.
- **§8 · reversa de un cobro (R-61):** tabla `payment_reversals`, append-only, una fila por cobro (único `(company_id, payment_id)`), con motivo. `payments` no cambia. `POST /v1/payments/{id}/reversal`, permiso `ar.payment.reverse` (dueño y contador), acta `ar.payment_reversed`. Sale de la caja lo que entró, el asiento se revierte con su contra-asiento (o se descarta de la cola), el saldo a favor consumido vuelve a estar disponible y un documento `paid` con saldo vuelve a `issued` (transición que el esquema solo admite con una reversa).
- **§8 · IGTF indebido (P-67):** si el cobro percibió IGTF en su propia venta, la percepción queda `pendiente_reintegro`, su asiento se revierte y lo percibido sale de la caja con el cobro (se restituye al cliente). Acta `igtf.perception_pending_refund`.
- **§8 · retención soportada:** `POST /v1/supported-retentions/{id}/reversal`, permiso `ar.retention.correct`: reversa el abono por la misma vía y deja el comprobante `annulled` con el motivo. Los dos CHECK NOT VALID del número (14 dígitos y prefijo de período) pasan a exigirse solo a lo vigente; el único del comprobante es parcial sobre `registered`.
- **Decidido por criterio (§2.16):**
  1. *Revaluación sin estado y acumulada:* el ajuste de cada cierre es «lo que debe llevar − lo que lleva»; no hay asiento de reverso el primer día del período siguiente. **Alternativa:** revaluar y reversar al abrir (el mayor vuelve al histórico entre cierres).
  2. *Cuentas por cobrar y por pagar se revalúan por cuenta y moneda, no por documento:* lo que el mayor lleva es Σ saldo en divisa × tasa de cada documento más lo ya revaluado. **Alternativa:** una línea por documento.
  3. *El IGTF restituido se asienta revirtiendo la percepción* (baja «IGTF percibido por enterar»; si ya se enteró, la cuenta queda deudora: es el reintegro pendiente). **Alternativa:** una cuenta propia «IGTF por recuperar».
  4. *Un cobro cuyo IGTF se documentó con nota de débito no se reversa* (409 `IGTF_NOTE_ISSUED`): la ND es un documento fiscal emitido. **Alternativa:** emitir la nota de crédito de esa ND dentro de la reversa (P-86).
  5. *Corregir una retención soportada = reversar y volver a cargar*, con el mismo número. **Alternativa:** un comprobante corregido con número nuevo.
  6. *La reversa no exige saldo en la caja:* si el dinero ya se gastó, la caja queda negativa y se ve. **Alternativa:** exigir saldo o el permiso de sobregiro (D-11).
  7. *El `balance` de la respuesta del cobro sigue siendo el saldo funcional* (contrato); la pantalla enseña la deuda. **Alternativa:** cambiar el contrato.
- **Abierto:**
  - ~~Las líneas de cuentas por cobrar y por pagar de un documento en divisa siguen en VES/identidad.~~ Cerrado en 20261003210200 (H6): llevan la moneda, el original y la tasa del documento.
  - ~~Las tablas `exchange_gain_loss` y los informes que la sumen no descuentan el diferencial de un cobro reversado.~~ Cerrado en la revisión de abajo (H4): la fila queda (append-only) y las lecturas la excluyen.
  - No hay pantalla para reversar: los dos endpoints existen y están en el OpenAPI.
  - Reabrir un período no deshace su revaluación; el cierre siguiente ajusta la diferencia.
  - Un asiento manual sobre la subcuenta de una caja en divisa se escribe en moneda funcional y no mueve sus dólares.

## Nota de aplicación — §1-4, moneda X «el cobro y el cierre» (ola 3, 2026-10-03; arreglos de las revisiones de moneda A y B)

Migración `20261003200000_the_settlement_skips_a_reversed_payment_without_entry`. HOMOLOGATION_IMPACT YES.

- **La tolerancia REAL de la conversión (precisa la Decisión §1, que no se reescribe).** «|total_usd × tasa − total_bs| ≤ 0,01 × líneas» es inalcanzable: el IVA en divisa se redondea al céntimo de la divisa, y eso solo ya separa las dos cifras hasta media unidad mínima × tasa por línea (unos 4,27 Bs a 854). Lo que rige es **por línea: media unidad mínima de la divisa × tasa + 0,01 Bs**. Es la del invariante `fiscal_amount_gaps` (pgTAP 109 la prueba ahora por los dos lados del borde: 4,2784 dentro, 4,2869 fuera) y la base del tope de la regla 4.
- **Una sola función para el fiscal en Bs (X1).** `fiscalDeLinea` (packages/domain/src/sales.ts) la usan `insertarDocumento` y `quotePos`. Antes la caja cotizaba con la regla vieja (total en divisa × tasa) y anunciaba 9.518,73 donde la factura decía 9.515,31. La web no calcula: pinta `functional_*` de la cotización.
- **`settlement_ledger_open`** (20261003200000, sobre 20261003180000 §8): un cobro reversado que nunca tuvo asiento (estaba en la cola) ya no es una pieza —antes dejaba la función en NULL para siempre y el invariante `settled_ledger_gaps` INERTE para ese documento—; y suma `functional_debit − functional_credit`, no el importe de la transacción.
- **El respaldo calculado** (cuando alguna pieza está en la cola) no cuenta los cobros reversados.
- **El cierre exacto vale con cualquier signo.** Con el mayor ya en cero o sobre-abonado antes del último cobro (un último cobro de 0,01 USD), ese cobro devuelve la cuenta por cobrar o por pagar a cero; antes solo si lo abierto era > 0, y quedaba negativa en un documento pagado.

**Decidido por criterio (§2.16), con su alternativa:**

1. *Regla 2 · un solo total (ADR-0063 §1).* A LA TASA DEL DOCUMENTO, la deuda en Bs de un documento en divisa ES su total en Bs —o la parte proporcional de lo que quede—: la caja enseña ese total, la factura lo imprime y pagar esa cifra en Bs cierra el documento en cero exacto, sin diferencial. Solo a OTRA tasa (otro día) la deuda en Bs es saldo en divisa × tasa de hoy, para mostrar. **Alternativa:** deuda en Bs siempre saldo en divisa × tasa de hoy, aunque el mismo día difiera del total impreso y se cobre más de lo que dice la factura. Va al asesor en P-85.
2. *Regla 3 · lo saldado en proporción.* Un cobro o pago en moneda funcional a la tasa del documento salda la divisa en proporción: saldo en divisa × pagado ÷ saldo en Bs. Pagar el total en Bs salda el total en divisa exacto. A otra tasa, pagado ÷ tasa del día. **Alternativa:** siempre pagado ÷ tasa (dejaba la factura «emitida» con céntimos de dólar tras pagar su total en Bs).
3. *Qué es el «saldo en Bs» de la regla 3.* Lo que el MAYOR todavía le carga al documento, siempre que cuadre con la parte proporcional del total dentro de la cota de la regla 4; si no cuadra, la parte proporcional (y el cierre falla por la regla 4). Sin abonos, o con abonos en Bs a la tasa del documento, las dos cifras son la misma. Difieren tras un abono EN DIVISA el mismo día (ese abono cancela divisa × tasa, no su parte del total en Bs): ahí la caja pide el saldo funcional, que es lo que el mayor carga, y con esa cifra la venta mixta USD + Bs cierra. ~~`document_debt` (familia «moneda B») enseña en ese caso la parte proporcional, que se aparta de lo que el mayor carga en (fracción abonada × separación de E-05): pagarla cierra igual mientras la diferencia quepa en medio céntimo de divisa; en una factura de muchas líneas puede quedar un resto de céntimos de divisa o responder «supera lo pendiente».~~ **Caduco desde la migración 20261003210100:** lo mostrado es lo que cierra (`platform.document_settlement_base`); ver más abajo «Lo mostrado es lo que cierra». **Alternativa:** la parte proporcional siempre (la venta mixta de muchas líneas no cerraría), o llevar `document_debt` a lo que el mayor carga.
4. *Regla 4 · el tope del diferencial.* El cobro o pago que CIERRA lleva al diferencial (a redondeo, la retención soportada) lo que entró − lo que el mayor carga. Tiene que coincidir con el diferencial esperado —lo saldado × (tasa del pago − tasa del documento); cero en la retención— dentro de la cota: **por línea, media unidad mínima de la divisa × tasa + 0,01; más media unidad × tasa (un cobro «cierra» a menos de medio céntimo de divisa) y un céntimo por cobro (cada uno redondea lo que cancela)**. Fuera de la cota NO se asienta: falla con `SETTLEMENT_MISMATCH` y no se registra nada. **Alternativa:** aceptar cualquier diferencia (un descuadre real se escondía en «Ganancia en diferencial cambiario»). Los dos sumandos añadidos a «por línea» no son holgura: sin ellos fallaba un cierre legítimo (la retención que cierra tras un abono en divisa: 5,13 Bs en una línea).
5. *Compras: la nota de crédito del proveedor a otra tasa.* Sigue valorada a la tasa de su fecha; lo que bajó de la cuenta por pagar a otra tasa que la de la factura ENTRA en el diferencial esperado del pago que cierra (es diferencia cambiaria, y se reconoce ahí), así que no dispara el tope. **Alternativa:** que dispare (una factura con nota a otra tasa no podría cerrarse pagando).
6. *El tope de «cobro supera lo pendiente»* de un documento en divisa se mide con lo que el cobro SALDA (lo mismo que se guarda), no con una segunda conversión.

**Abierto:**
- ~~El mapeo HTTP de `SETTLEMENT_MISMATCH` vive en `apps/api/src/middleware/errors.ts` (familia «moneda B»): mientras no esté, responde 500 con el código y el mensaje correctos (un código sin fila cae a 500 a propósito).~~ **Cerrado:** `SETTLEMENT_MISMATCH` responde 409 (`apps/api/src/middleware/errors.ts:201`).
- Una factura o un documento con abonos ANTERIORES al corte cuyo mayor quedó descuadrado (H-02, P-84) ya no cierra absorbiendo el descuadre: el cierre falla diciéndolo, y hay que regularizarlo antes.
- La cota de `fiscal_amount_gaps` deja fuera un caso de frontera: con los tres redondeos de una línea en su extremo, la separación llega a media unidad × tasa + 0,0108 (alícuota 16 %), ocho diezmilésimas por encima de 0,01. No se ha visto; si aparece, el invariante lo dirá.
- `_moneda.mjs` del recorrido cobra «total en USD × tasa» en Bs: con la regla 2 eso es un céntimo de más o de menos respecto del total de la factura, y cierra con diferencial dentro de la cota. El caso nuevo de `pnpm recorrido E` paga el total en Bs.

## Nota de aplicación — revisión de «moneda B»: el mayor en divisa, la revaluación, las reversas y las lecturas (ola 3, 2026-10-03)

Migración `20261003210000_the_revaluation_nets_and_the_closing_rate_is_fresh.sql`. Corrige también el pie de la 20261003180000 (decía que no había migraciones posteriores).

- **§6 · el Debe y el Haber de una línea en divisa (H1).** En la base, `debit_amount` / `credit_amount` llevan el importe ORIGINAL de la línea (los siete campos de ADR-0020, el esquema desde 20260827233538) y lo funcional va en `functional_debit` / `functional_credit`, que es lo que leen los cuadres y el mayor. Se queda así. Lo que se corrige son los LECTORES: el detalle del asiento que sirve la API da Debe y Haber en moneda funcional y el original aparte (`original_amount`, con su moneda y su tasa). En la base, las funciones que nombran esas columnas las ESCRIBEN (las tres regularizaciones) o quieren el original (`treasury_ledger_original`); la única que sumaba bolívares con ellas era `settlement_ledger_open` (corregida en 20261003200000).
- **§6 · la revaluación netea por cuenta (H2).** `fx_revaluation_items` devuelve una fila por cuenta y solo si hay diferencia: lo que el mayor lleva (histórico de los documentos abiertos más lo ya revaluado) contra lo que debe llevar. Reabrir y cerrar a la misma tasa no asienta nada; `closeFiscalPeriod` vuelve a netear por `account_id` antes de armar las líneas.
- **§6 · un documento saldado no se revalúa (H14)**, salvo que lo saldara un cobro o pago posterior a la fecha de cierre.
- **§6 · J-04 dice qué pasa con la cola (H5).** `treasury_currency_gaps`: la caja = su subcuenta + lo que sus hechos pendientes de contabilizar todavía le deben al mayor. Cero filas, sin corte y sin lista. La regularización nace `exchange_diff` / `treasury.currency_regularized` (no se reversa suelta) y ya no se salta la empresa con cola.
- **§8 · las lecturas (H4).** Un cobro reversado no es un cobro: `has_payments`, lo pagado del estado de cuenta, el diferencial (`exchange_gain_loss`) y la condición para anular una venta cuentan solo cobros vivos; el detalle del documento dice de cada cobro si está reversado, cuándo, por quién y por qué.
- **§8 · `paid → issued` (H11)** exige que el documento deba AHORA en su moneda, no cualquier reversa histórica.
- **§5 · la deuda sin tasa de hoy (H12).** `document_debt` no lanza: sirve el nominal y deja `rate` y `functional_today` en NULL; `customer_debt_today` y el importe de `ar_aging` van en NULL si algo de lo que se debe está en divisa (nunca una suma parcial).

**Decidido por criterio (§2.16):**
1. *El Debe/Haber en divisa se queda en la moneda de la transacción.* **Alternativa:** dejar `debit_amount` / `credit_amount` en funcional y el original solo en `amount_transaction_currency`.
2. *La tasa de cierre* es la oficial más reciente con fecha ≤ la de cierre y no más vieja que `platform.parameters.closing_rate_max_age_days` = **7 días** (dato, no código; fines de semana y feriados largos). Fuera del margen el cierre se detiene: «Falta la tasa BCV del cierre (dd/mm/aaaa). Cárgala y vuelve a cerrar.» **Alternativa:** exigir la del último día hábil con calendario de feriados. VALIDAR-CONTABLE, P-88.
3. *Cerrar un período que todavía no terminó:* la revaluación se fecha el menor entre el fin del período y hoy (día de Caracas, `date` contra `date`), y usa la tasa de esa fecha. **Alternativa:** no dejar cerrar un período en curso.
4. *La tasa solo se exige a lo que tiene saldo en divisa.* Una caja en divisa con cero dólares no detiene el cierre. **Alternativa:** exigirla siempre que exista una caja en divisa (lo que hacía la 180000).
5. *Un cobro reversado no es un cobro* para anular la venta. **Alternativa:** que reversar no habilite anular.
6. *Un comprobante de retención soportada ya declarado no se anula* (409 `RETENTION_PERIOD_DECLARED`). «Declarado» = una generación de la declaración de IVA hecha después de cerrar el período en que entró el comprobante (el mismo criterio de `recompute_iva_period`). **Alternativa:** admitirlo con un ajuste negativo en el período corriente. VALIDAR-TRIBUTARIO, P-89. Para el IGTF no hay declaración persistida que proteger; cuando exista, la misma regla.
7. *La reversa con el período de hoy cerrado se rechaza* (409 `PERIOD_CLOSED`): el contra-asiento va siempre con fecha de hoy, en el período en curso (ADR-0069: un período cerrado no recibe asientos); con el período del COBRO cerrado y el de hoy abierto, la reversa pasa y se asienta hoy. **Alternativa:** llevar el contra-asiento al primer período abierto.
8. *La reversa después del arqueo del día* pasa: el arqueo es un hecho append-only que dice lo contado entonces; la caja baja después y el arqueo siguiente lo ve. **Alternativa:** exigir reabrir o repetir el arqueo.
9. *El origen de la regularización de la divisa* reutiliza `source_kind = exchange_diff` con evento propio. **Alternativa:** un `source_kind` nuevo en el CHECK de `journal_entries`.
10. *`greatest(deuda, 0)` por documento vive en `customer_debt_today`*, para las cuatro pantallas a la vez, y no en la consulta de la lista. **Alternativa:** solo en la lista (las cuatro cifras volverían a poder diferir).
11. *`exchange_difference` ausente vale 0 en el generador* — solo ese importe, para los pagos a proveedor registrados o encolados por la API anterior (R-74 §3). **Alternativa:** reescribir el contexto de las filas en cola.

**H10 (solo documentado).** Entre cierres, `settlement_ledger_open` no ve la revaluación: el cobro reconoce el diferencial COMPLETO contra el histórico (la tasa de la factura) y la revaluación previa de ese documento se deshace en el cierre siguiente. A granularidad de período equivale a «revaluar y reversar al abrir», pero las cuentas por cobrar del mayor quedan sobrevaluadas entre cierres por lo revaluado de documentos ya cobrados. **Alternativa:** que el cobro cancele el valor revaluado. VALIDAR-CONTABLE, P-86.4.

**Abierto:**
- ~~H6 sigue abierto~~ **H6 CERRADO en 20261003210200 (ver la nota siguiente).** Lo que decía este punto, para la historia — diseño listo y entonces no aplicado: una función `platform.settlement_original_of(empresa, source_kind, source_id)` que devuelva la moneda, la tasa y la fuente del DOCUMENTO detrás del hecho (la factura; en el cobro o el pago, su documento), leída en la misma consulta de los papeles del generador; la línea de `ar_general` / `ap_general` lleva `original = round(funcional / tasa del documento)` (el total en divisa del documento cuando la línea es su total), la moneda y la tasa del documento; el diferencial va en su línea, en Bs; el contra-asiento ya copia moneda y tasa. **Lo que lo bloquea:** con esas líneas en divisa, `debit_amount` / `credit_amount` de cuentas por cobrar y por pagar dejan de ser bolívares, y los leen como bolívares `apps/api/test/e2e-moneda-diferencial.test.ts:214`, `supabase/tests/109_fiscal_amounts_in_bs_test.sql:254` y `scripts/recorrido/verificar/H.mjs:166`, que son de otro encargo: hay que pasarlos a `functional_debit` / `functional_credit` en el mismo cambio.
- La nota de crédito de proveedor y el saldo a favor en divisa (G-05) siguen como en «moneda A».
- ~~La reversa de un cobro pagado con SALDO A FAVOR no tiene prueba propia (el código devuelve el saldo a `available`; no verificado con un E2E).~~ **Tiene prueba propia:** `apps/api/test/e2e-moneda-deuda-reversa.test.ts:1580` («el saldo a favor vuelve a estar disponible, el documento vuelve a deber y los invariantes siguen en cero»).
- La web no se revisó contra los `null` nuevos de la deuda sin tasa.

**Lo mostrado es lo que cierra (migración `20261003210100_the_debt_shown_is_the_debt_that_closes.sql`).** A la tasa del documento y con cobros previos, `document_debt` enseña en Bs la MISMA base contra la que cierra `registerPayment`: lo que el mayor todavía le carga al documento si cuadra con la parte proporcional del total dentro de la cota del redondeo, y si no, la parte proporcional (`platform.document_settlement_base(empresa, documento) returns numeric`). Sin cobros o a otra tasa, la fórmula de siempre, que no lee el mayor. La regla está escrita DOS veces (esa función y `packages/domain/src/sales.ts`, que la calcula en TypeScript): queda pendiente que el cobro llame a la función. **Decidido por criterio:** la cota usa la tasa del documento (es la del día cuando la función aplica). **Alternativa:** enseñar siempre la parte proporcional y que el cobro cierre contra ella.

## Nota de aplicación — la cartera guarda su divisa y una lista no se cae por una tasa (ola 3, 2026-10-03)

Migración `20261003210200_receivables_keep_the_currency_and_a_list_never_falls.sql`.

- **§6 · H6, cerrado.** La línea de cuentas por cobrar o por pagar (`ar_general` / `ap_general`) de un hecho cuyo DOCUMENTO está en divisa lleva la moneda del documento, su importe original y la tasa del documento (`platform.settlement_original_of`, leída en la misma consulta de papeles del generador). El original es lo que el hecho dice exacto —el total del documento; lo que el cobro o el pago saldó en la moneda del documento— ~~mientras se parezca al importe funcional de la línea a esa tasa (0,5 %); si no, el funcional entre la tasa del documento~~ (el umbral era una heurística y se quitó en 20261003220000: ver la nota «última ronda»). El diferencial va en su propia línea, en moneda funcional. El contra-asiento de una reversa copia moneda y tasa. Con eso, la suma de los originales de la cartera de un documento saldado es cero **para los hechos que escriben original** (los que enumera `settlement_original_of`, desde 20261003220000; un asiento manual sobre la cartera, un cobro anterior a 20261003170000 sin lo saldado congelado y toda línea anterior a 20261003210200 van en moneda funcional y no entran en esa suma). **El importe funcional de ninguna línea cambia.** Quien quiera bolívares lee `functional_debit` / `functional_credit`; `debit_amount` / `credit_amount` llevan el original (línea de caja desde la 180000, cartera desde esta).
- **§4-5 · una sola regla para «lo que cierra».** `registerPayment` ya no calcula la base en TypeScript: llama a `platform.document_settlement_base`, la misma función que enseña `document_debt`. En compras no había regla duplicada (`registerSupplierPayment` tiene la suya, con las notas de crédito del proveedor, y ninguna lectura SQL la repite).
- **§5 · el resto de H12.** Un cobro en otra moneda anterior a 20261003170000 (sin `settled_transaction_amount`) se valora con la tasa que guardó congelada su diferencial (`exchange_gain_loss.fx_rate_payment`); si no la tiene, con la de su fecha; y si tampoco, el saldo ESTRICTO (el del cobro y la revaluación) lanza LAD51 y el de LECTURA devuelve NULL: `document_debt` da la fila con el nominal en NULL, la deuda del cliente va en NULL y la antigüedad cuenta el documento con importe NULL. La lista no responde 409. `payments` es append-only: no se rellena nada.
- **§6 · revaluación:** el cobro posterior a la fecha de cierre que mantiene en la cartera a un documento `paid` tiene que estar vivo.
- **`money_landing_gaps`** (informe, no invariante) no lista cobros reversados.
- **Generador, formato viejo del pago a proveedor (R-74 §3):** además de `exchange_difference` ausente = 0, la línea de cuentas por pagar de un pago SIN `exchange_difference` toma `net_amount` (el contexto viejo traía `total` = bruto y su plantilla cancelaba por el neto): con retención descuadraba por lo retenido.

**Decidido por criterio (§2.16):**
1. *El original de la cartera es el del hecho, no una división.* **Alternativa:** siempre `funcional / tasa del documento` (la suma de originales de un documento saldado quedaría con céntimos de divisa).
2. *El umbral del 0,5 %* para creerle al importe exacto. **Alternativa:** exigir igualdad al céntimo (el cobro que cierra, que cancela «lo que el mayor carga», caería siempre en la división).
3. *La tasa congelada de un cobro viejo es la de su diferencial*; no se rellena `payments`. **Alternativa:** una tabla aparte con lo saldado de los cobros anteriores a la 170000.
4. *Sin tasa con que valorar un cobro viejo, la lectura dice NULL* («falta la tasa») y el cobro nuevo sigue rechazándose. **Alternativa:** valorar a la tasa del documento.
5. *El formato viejo del pago se reconoce por la ausencia de `exchange_difference`.* **Alternativa:** una marca de versión en el contexto de la cola.

**Abierto:**
- Ningún invariante suma todavía los ORIGINALES de la cartera contra los saldos en divisa de los documentos (el equivalente de J-04 para cuentas por cobrar y por pagar). Las líneas anteriores a esta migración siguen en moneda funcional y no se regularizan.
- La cartera de un asiento MANUAL sobre `ar_general` / `ap_general` se escribe en moneda funcional.
- La web no se revisó contra los `null` de la deuda (sin tasa de hoy, o sin nominal calculable).

## Nota de la auditoría fiscal de moneda (2026-10-03)

- **AF-M07 · §4, el diferencial sin nota.** El art. 51 del Reglamento de la LIVA, leído en tres reproducciones no oficiales, contradice el diferencial sin nota: la diferencia de tasa al pagar sería corrección de precio documentada con nota de débito o de crédito. La decisión del dueño (P-20, 2026-09-28) espera al asesor; si lo confirma, manda la norma y el diferencial se rehace con nota de débito o de crédito. Hasta entonces no se libera emisión fiscal productiva con cobros a otra tasa. VALIDAR-TRIBUTARIO, P-20.
- **AF-M03 · «un solo total».** Lo respalda la norma leída (LIVA arts. 20, 23 y 36): cobrar más que el total facturado sería un cargo adicional al precio. Queda la pregunta del total en divisa × tasa impresa (P-85).
- **AF-M04 · el IVA es exacto POR LÍNEA** (la fórmula literal del dueño) y no por alícuota (el invariante que la misma respuesta enunció). Decidido por criterio; la alternativa y la pregunta están en P-90.
- **AF-M11 · el IGTF de un cobro reversado.** P-89 y P-67.
- **AF-M14 · la reversa de un cobro como llave de la anulación** se revisa con G-10 en la ola 4 (P-91).
- **AF-M15 · diferencial realizado y no realizado** van a las mismas cuentas (P-83, P-92).

## Nota de aplicación — última ronda de moneda: revisión final y auditoría fiscal (ola 3, 2026-10-03)

Migración `20261003220000_the_portfolio_original_is_deterministic_and_igtf_keeps_its_fortnight.sql`.

- **§6 · el original de la cartera es DETERMINISTA (Z2).** `platform.settlement_original_of` devuelve, por tipo de hecho, el original de su línea de cuentas por cobrar o por pagar: el total del documento de venta; lo que el cobro o el pago saldó; el total MENOS la retención neteada de la factura de compra; el total de la nota de crédito de proveedor. El generador lo escribe tal cual, sin umbral ni «si se parece»; si el hecho no tiene original conocido, la línea va en moneda funcional. Una plantilla con DOS líneas de cartera en el mismo asiento no toma el original en ninguna. Probado: cinco líneas de ~0,30 USD cobradas enteras → Σ originales = 0,00 y Σ funcional = 0,00; la compra con una retención del 0,375 %.
- **§4 · el cobro a la tasa del documento no es cambiario (Z5, AF-M03).** Cuando la tasa documento → funcional del día del cobro ES la del documento, lo que el cierre deje de más o de menos es redondeo: va a «Diferencias por redondeo» (`rounding_difference`, 5.1.10) y no deja fila en `exchange_gain_loss`. El generador recibe `differenceIsRounding` y lleva ahí las líneas que la plantilla mandaba a `exchange_gain` / `exchange_loss` (la marca viaja en el contexto de la cola). En compras igual; `supplier_payments.exchange_difference` conserva el importe (es aritmética: lo que salió − lo cancelado). El tope de la regla 4 no cambia: a la misma tasa el diferencial esperado ya era cero y la cota es la del redondeo. En la práctica el residuo solo nace en el cobro en bolívares que cierra por debajo de medio céntimo de divisa: en la moneda del documento y a su tasa, el cobro ya cancela exactamente lo que el mayor carga (regla 2).
- **§8 · el IGTF de un cobro reversado conserva su quincena (Z6, AF-M11).** `platform.igtf_period_totals`: una percepción cuyo cobro se reversó DESPUÉS del fin del período sigue contando en el total de ese período y se dice aparte como pendiente de reintegro; la reversada dentro de él no cuenta. Día de Caracas contra día. La única lectura del total (`GET /v1/igtf/perceptions`) sale de esa función; no hay libro ni TXT de IGTF que lea otra suma.
- **Lecturas y contrato (Z1):** la web escribe «Falta la tasa de hoy» (un texto, en `apps/web/src/components/deuda.ts`) junto al nominal por moneda cuando el servidor manda `null`; `esCero(null)` es `false` («no se sabe» no es cero). `debt_nominal` es `null` cuando no se puede calcular, y `debt.unvalued_documents` dice cuántos documentos quedan fuera de `by_currency`.
- **Mensajes (Z4):** el cierre distingue «falta la tasa de cierre (día)» de «falta la tasa del día de un cobro viejo en otra moneda».

**Decidido por criterio (§2.16):**
1. *El original de la cartera lo dice una función por tipo de hecho* (Z2). **Alternativa:** derivarlo siempre del funcional entre la tasa del documento (la suma de originales de un documento saldado quedaría con céntimos de divisa).
2. *A la tasa del documento, el residuo del cierre es redondeo y no diferencial* (Z5). **Alternativa:** derivar el total en divisa del total en Bs (no habría residuo que clasificar, pero la deuda dejaría de ser un importe en céntimos de dólar: P-85).
3. *La percepción reversada después de su quincena sigue contando en ella* (Z6; PA SNAT/2022/000013 art. 4). **Alternativa:** rebajarla del total de su quincena (lo que hacía: el total dejaba de reproducir lo declarado). VALIDAR-TRIBUTARIO, P-89.
4. *«Después de su quincena» se mide contra el `to` del período que se consulta*, no contra un calendario de quincenas guardado. **Alternativa:** persistir las declaraciones de IGTF y marcar cada percepción con la suya.

**Abierto:**
- **El invariante «cartera ↔ mayor en las dos monedas»** (Σ originales de la cartera = saldo en divisa de los documentos) NO está construido: va en la ola 4 (F-12). Hasta entonces la propiedad «documento saldado ⇒ Σ originales = 0» la sostienen el generador y sus pruebas, no un invariante.
- No existe una declaración de IGTF persistida: el total del período se recalcula al consultarlo.
- «Lo que me deben» del Inicio sigue sin distinguir «falta la tasa» de «sin permiso» (los dos llegan `null`).

### Corrección de la revisión de la última ronda (2026-10-03)

Migración `20261003230000_igtf_reversal_counts_against_its_own_fortnight.sql` (redefine solo `platform.igtf_period_totals`).

- **§4 · un diferencial REAL no va a redondeo (compras; corrige la viñeta Z5 de arriba).** La viñeta decía «en compras igual» y «a la misma tasa el diferencial esperado ya era cero». En compras no era cierto: el pago que CIERRA reconoce también lo que las notas de crédito del proveedor bajaron a OTRA tasa (`notas` en `registerSupplierPayment`; el tope lo admite como esperado). Con la tasa de hoy igual a la de la factura, ese residuo vale ≈ NC × (R' − R): diferencia cambiaria real, sin cota de redondeo, y la marca `differenceIsRounding` la mandaba a «Diferencias por redondeo». **Ahora** la marca solo se activa si, además de coincidir la tasa, el diferencial cabe en la cota del REDONDEO (la misma cota por línea del tope: `cota(tasa de la factura)`); fuera de ella va a `exchange_gain` / `exchange_loss` como siempre. Probado (`e2e-moneda-diferencial`, «revisión final»): factura USD a 854,4637, NC de 5,80 USD a 900, resto pagado a 854,4637 → 264,11 Bs a pérdida cambiaria (antes, a redondeo); el caso limpio (misma tasa, sin NC) → 0,01 a redondeo y ninguna línea de diferencial; la marca viajando por la cola (fila con marca → redondeo; fila vieja sin marca → diferencial).
- **Ventas no tiene el camino equivalente (confirmado con test).** En ventas cada cobro —también el saldo a favor aplicado a otra tasa— reconoce SU diferencial al aplicarse (227,68 Bs en el caso de prueba); el cierre a la tasa del documento solo hereda el redondeo del total en divisa (3,42 Bs: 11,136 → 11,14 USD), dentro de la cota de una línea.
- **§8 · «su quincena» es la de la PERCEPCIÓN (corrige la decisión 4 de arriba).** ~~«Después de su quincena» se mide contra el `to` del período que se consulta~~: con un rango de un mes, una percepción del día 5 reversada el 20 no contaba aunque su quincena ya se había declarado con ella (Σ quincenas ≠ mes); con un rango de un día, una reversada al día siguiente contaba. **Ahora** la reversa se compara con el fin de la quincena de la percepción (`platform.fiscal_fortnight`, la misma función del calendario del especial; no hay «1-15 / 16-fin» escrito otra vez). El total de un rango es la suma de sus percepciones y Σ quincenas = mes (pgTAP 110 §21: un día, dos quincenas, la suma y su variante rota).
- **La pantalla de IGTF** dice lo que el total hace: el total del período y, aparte, «De eso, pendiente de reintegro: Bs X (n cobros reversados después de cerrar la quincena)»; las dos cifras llegan del servidor.
- **Un documento «sin valorar» no se cobra a ciegas:** con saldo `null`, el botón de cobrar sale APAGADO con su motivo en la ficha del cliente y en el detalle de la factura (`decisionDeCobro`, `apps/web/src/components/deuda.ts`); el cobro ya no se abre con «0» precargado.

**Decidido por criterio (§2.16):**
5. *La cota que separa redondeo de diferencial en el pago a proveedor es la del tope (por línea)*, no «las notas suman cero». **Alternativa:** activar la marca solo si `notas` = 0 (una NC a la MISMA tasa deja céntimos en `notas` y perdería la marca sin motivo; y un diferencial real de una NC menor que la cota —unos 4 Bs por línea a estas tasas— sigue yendo a redondeo: es el límite aceptado).
6. *Sin rango (`from` / `to` ausentes) el total de IGTF sigue siendo solo lo percibido vigente.* **Alternativa:** aplicar también ahí la regla de la quincena de la percepción (el total sin rango sería la suma de todas las quincenas). No se cambió porque pgTAP 110 §21 lo asevera y ninguna aserción existente se toca sin el dueño: **queda como decisión abierta**.

**Abierto (se añade):**
- La anulación de una factura con IGTF percibido (la otra vía a `pendiente_reintegro`) no guarda su instante y no deja fila en `payment_reversals`: esa percepción no cuenta en ningún total. La rama hoy no se alcanza (una factura con cobros no se anula, ADR-0061); si llega a alcanzarse, la percepción necesita una columna con el instante para que las dos vías usen una sola regla (P-89, pregunta d).

## Nota de aplicación — ola 4 · cobros: el pago de más, el saldo a favor en su moneda, su reembolso y la cartera contra el mayor (2026-10-04; F-07, F-10, F-12, G-04, G-05, G-15)

ADR aplicado según la respuesta del dueño del 2026-09-28. Migraciones `20261004150000_a_credit_in_favor_keeps_its_currency.sql`, `20261004190000_an_overpayment_is_born_as_a_credit_in_favor.sql`, `20261004190100_the_refund_keeps_the_rate_of_its_day.sql` y, de la tercera ronda, `20261004190200`, `190300`, `190400` y `190500` (ver «Tercera ronda» al pie de esta nota): **siete**, no dos. Las cabeceras de la 150000 y la 190000 dicen que con la API anterior el reembolso o el cobro «respondería 422»: no es así, **queda en la cola de pendientes** (el generador encola cuando la plantilla pide un importe que no recibe); una migración creada no se edita, se corrige aquí y en R-84. HOMOLOGATION_IMPACT YES (cambian asientos de cobros y reembolsos; ningún documento fiscal cambia).

- **§4 · el saldo a favor conserva la moneda del documento (G-05).** `customer_credits` guarda `fx_rate`, `rate_source` y `functional_amount` (lo que el mayor cargó al pasivo al nacer) y, si nació de un cobro, `source_payment_id`. La nota de crédito y la devolución lo crean en la moneda de la nota, con su tasa (la de la factura que corrige). **Los saldos a favor que ya existían están en bolívares y se quedan en bolívares**: para ellos «sin tasa» es la identidad. No hay conversión ni lista de perdones.
- **Aplicarlo** (`registerPayment`, instrumento `saldo_a_favor`): a un documento de la MISMA moneda, nominal contra nominal — el cobro vale lo que el pasivo llevaba (la tasa con que nació), no la tasa del día, y la diferencia con lo que el documento cargó a cuentas por cobrar es el diferencial de siempre. A un documento de OTRA moneda, a la BCV del día de la aplicación: el documento baja por lo que el saldo a favor vale hoy y el pasivo por lo que llevaba; la diferencia va al diferencial (sin fila en `exchange_gain_loss`: lo lleva el asiento).
- **Reembolsarlo (G-15)** (`refundCustomerCredit`, permiso `sales.refund`): sale de la caja en la moneda de la cuenta que se elija, a la tasa del día. `customer_refunds` guarda el dinero que salió en sus importes de siempre y, aparte, lo consumido del saldo a favor (`credit_amount`, `credit_currency`, `credit_functional_amount`) y el diferencial (`exchange_difference`). La plantilla `ar.credit_refunded` baja el pasivo por `total` (a la tasa con que nació) y lleva dos líneas de diferencial. `whole: true` reembolsa todo lo disponible sin que quien llama conozca la moneda.
- **Revaluación al cierre (§6):** `platform.fx_revaluation_items` añade la partida `customer_credit`: lo que queda de cada saldo a favor en divisa a la fecha, contra lo que llevaba a su tasa de nacimiento más lo ya revaluado; pasivo, como las cuentas por pagar.
- **El pago de más (F-10):** se acepta. El documento se salda por lo que debía (`settled_transaction_amount`), lo que entra en la caja es lo recibido, y el sobrante nace como saldo a favor en la moneda del documento y a la tasa del cobro. `payments.credited_functional_amount` guarda la parte que no abonó el documento y `platform.document_balance` la resta. El asiento lleva la línea `credit_surplus` (haber, pasivo de saldos a favor). La respuesta trae `customer_credit`.
- **F-07, no reproducido.** El cobro en USD que cierra un documento en USD a otra tasa deja la cuenta por cobrar en cero y un asiento que cuadra sin diferencial doble (prueba «F-07» de `e2e-moneda-diferencial`). Lo que queda de ADR-0063 §2: dentro de la tolerancia de caja, el valor en bolívares del cobro es lo pendiente y no `importe × tasa`; la diferencia (menos de medio céntimo de divisa, unos 4 Bs) queda en la valoración de la caja y la recoge la revaluación al cierre. No se cambió: es una decisión de ADR-0063.
- **§5 · el estado de cuenta (G-04):** una nota de crédito o un recibo de devolución no pasan por la función de deuda: su saldo es lo que queda de su saldo a favor, en negativo (en divisa, a la tasa de hoy para mostrar).
- **Invariante `platform.receivables_ledger_gap(empresa)` (F-12):** Σ por documento de venta con asiento (total − lo que cancelaron sus cobros vivos con asiento) = saldo de las cuentas `ar_general` del mayor, sin la revaluación al cierre ni la regularización del céntimo; la ND por IGTF no carga cartera; lo que está en la cola va aparte. Lo que canceló cada cobro se guarda al cobrar (`payments.cancelled_functional_amount`) y se comprueba contra lo que se asienta. Cero filas, sin exclusiones.

**Decidido por criterio (§2.16), con su alternativa:**
1. *El sobrante de un pago de más queda en la moneda del DOCUMENTO*, no en la del pago (G-05: el saldo a favor conserva la moneda del documento que lo originó). **Alternativa:** en la moneda del pago.
2. *Un pago de más en divisa que causa IGTF se rechaza* (se entrega el vuelto). No hay norma citada sobre el IGTF de un anticipo. **Alternativa:** percibir el IGTF sobre todo lo recibido. VALIDAR-TRIBUTARIO, PENDIENTES_ASESOR.
3. *Una retención de IVA no deja sobrante*, y a un documento que no debe nada no se le cobra. **Alternativa:** aceptar también esos como anticipo.
4. *La reversa de un cobro con sobrante retira el saldo a favor* (`expired`) y se rechaza si ya se usó. **Alternativa:** dejar el saldo a favor vivo y reversar solo la parte que abonó el documento.
5. ~~*El pasivo baja por importe × tasa de nacimiento, al céntimo, en cada uso.*~~ **INVERTIDA en la tercera ronda (2026-10-04), con el dato que la tumba:** no era «un céntimo». Una nota de crédito con IVA nace por su total EN BOLÍVARES (el IVA se calcula en Bs, E-05), que no es importe × tasa: un saldo de 2,78 USD a 854,4637 cargó 2.378,82 al pasivo y 2,78 × 854,4637 = 2.375,41 — agotado, quedaban **3,41 Bs** en el pasivo para siempre, y la revaluación no los limpiaba (partía de `resto × tasa`). **Decisión vigente (decidida por criterio):** cada uso —aplicar o reembolsar— baja el pasivo por la PARTE PROPORCIONAL de `functional_amount` (al céntimo), y el uso que AGOTA el saldo se lleva lo que el mayor todavía carga: el pasivo de cada saldo a favor termina en 0,00. **Alternativa (la decisión anterior):** importe × tasa de nacimiento en cada uso. VALIDAR-CONTABLE P-99.
6. *El invariante de cartera no tiene corte:* para los cobros anteriores lee lo que su asiento acreditó. **Alternativa:** un corte en `platform.invariant_cutoffs` y comparar solo movimientos posteriores.
7. *`whole: true`* en el reembolso, para que la devolución no tenga que conocer la moneda del saldo a favor. **Alternativa:** que la respuesta de confirmar la devolución traiga el importe y la moneda del saldo a favor.
8. *«26.003» (un punto y tres cifras) se rechaza por ambiguo* en vez de leerse como 26,003 o como 26.003,00. **Alternativa:** leerlo siempre a la venezolana (un precio «1.250» tecleado con punto decimal pasaría a ser mil doscientos cincuenta).

**Abierto:**
- El invariante de cartera no cubre cuentas por pagar ni las dos monedas (Σ originales).
- No hay documento imprimible del reembolso ni del anticipo («con recibo»): existen la fila, su acta y su asiento.
- El reembolso desde el estado de cuenta no ofrece confirmar un sobregiro.
- El campo de dinero deja el importe con punto decimal después de leerlo; los demás formularios que no usan `MoneyInput` siguen con su `replace(",", ".")`.
- G-18 (la nota de crédito sobre una factura fiada baja primero su deuda) no es de este bloque: si la nota pasa a abonar cuentas por cobrar directamente, `receivables_ledger_gap` tiene que contarla.

**Segunda ronda (2026-10-04) — lo que cierra de la lista de arriba y lo que deja dicho:**
- *Cerrado:* los comprobantes imprimibles, los dos **no fiscales** (`apps/api/src/routes/receipts-pdf.ts`): `GET /v1/payments/:id/pdf` (recibido, aplicado y «Saldo a favor: …» en su moneda) y `GET /v1/customer-refunds/:id/pdf` (lo devuelto del saldo, lo que salió de la caja y en qué moneda, la tasa del día que el reembolso GUARDÓ —20261004190100—, la cuenta, quién y el motivo). Sin número de control, sin impuesto, sin serie, y sin el marcador «todavía sin RIF». **No hay correlativo legible:** ni `payments` ni `customer_refunds` tienen uno; se imprime el identificador entero y sus ocho últimos caracteres como referencia. Un número propio por empresa sería una columna y una secuencia nuevas: decisión del dueño.
- *Cerrado:* el reembolso desde el estado de cuenta ofrece confirmar el sobregiro como las demás salidas de dinero (D-11: 409 `INSUFFICIENT_FUNDS` que dice qué hacer; con `treasury.overdraft` y motivo, sale y deja su acta).
- *Cerrado:* el cuerpo del reembolso lleva EXACTAMENTE uno de `amount` | `whole` (422 con su mensaje si van los dos o ninguno).
- *Cerrado:* aplicar un saldo a favor en divisa a un documento en moneda funcional deja su fila en `exchange_gain_loss`: el reporte cuenta lo mismo que el asiento. Entre dos divisas distintas se rechaza (serían dos diferenciales y la tabla guarda uno por cobro).
- *Un saldo a favor se aplica EN SU MONEDA* (regla anterior a esta ola): quien lo aplica manda `currency` = la del saldo. Con G-05 el saldo de una NC sobre un documento en USD nace en USD; aplicarlo declarando bolívares responde 422.
- *El invariante con cartera real:* pgTAP 125 (f) monta factura fiada, cobro parcial, cobro con sobrante, nota de crédito, factura en cola y cobro reversado, y lleva DENTRO cuatro variantes rotas (reversa a medias, asiento manual sobre la cuenta por cobrar, cobro que guarda una cifra y asienta otra, factura anulada por debajo del caso de uso), cada una con su cifra.
- *G-18, lo que cambiaría:* hoy una NC acredita el pasivo de saldos a favor y no toca `ar_general`, por eso no entra en el enunciado. El día que una NC sobre factura fiada abone la cuenta por cobrar, el enunciado pasa a ser «Σ total − Σ cancelado por cobros vivos − Σ **lo que cada NC vigente con asiento abonó a la cuenta por cobrar de su documento de origen**», y ese importe tiene que GUARDARSE en la nota al emitirla (como `payments.cancelled_functional_amount`), no deducirse del asiento: si se lee del mismo asiento que se comprueba, el invariante se da la razón a sí mismo. Y `document_balance` tiene que restar lo mismo, o `settled_ledger_gaps` y este dejan de decir lo mismo.

**Tercera ronda (2026-10-04) — lo que la revisión en contexto limpio pidió:**
- *Un saldo a favor retirado se queda retirado.* La reversa de un cobro con sobrante deja su saldo a favor `expired`, pero `registerPayment` leía `status` y no lo comprobaba: el saldo retirado se podía aplicar, la reversa de esa aplicación lo devolvía a `available`, y entonces se reembolsaba en efectivo. Ahora el dominio solo aplica o reembolsa un saldo `available` (422 con su mensaje), y el esquema lo prohíbe por escrito: trigger `customer_credits_retired` (23514) — una fila `expired` no cambia de estado ni de importes (20261004190200).
- *El pasivo termina en cero* (decisión 5, invertida arriba). `payments.credit_functional_amount` guarda lo que cada aplicación bajó del pasivo (el reembolso ya lo guardaba); `platform.customer_credit_uses` es la única definición de «uso» y `platform.customer_credit_carried` lo que el mayor todavía carga por un saldo. Aplicado a un documento de su MISMA moneda, el cobro «vale» esa parte del pasivo; lo que se aparta de importe × tasa NO es deuda del documento: la cuenta por cobrar baja a la tasa del documento y la diferencia va a «Diferencias por redondeo» (misma tasa) o al diferencial (otra tasa). La cota del diferencial del cierre (regla 4) se mide sin ese ajuste.
- *La revaluación* (`fx_revaluation_items`, partida `customer_credit`) parte de `customer_credit_carried` a la fecha, no de `resto × tasa de nacimiento`. Misma cifra en el caso limpio; el texto de `carried` y `adjustment` de esa partida sale ahora a ocho decimales («188.25000000»): quien los lee los interpreta como número.
- *Invariante `platform.customer_credit_ledger_gap(empresa)`:* Σ por saldo a favor no retirado con asiento (lo que nació − lo que bajaron sus usos vivos con asiento) = saldo acreedor de las cuentas `customer_credit_liability`, sin la revaluación al cierre ni la regularización del céntimo; un saldo agotado no carga nada (fila `exhausted`); y todo saldo a favor vivo nació con asiento o está en la cola (fila `unborn`). Cero filas, sin exclusiones ni corte. La fila `unborn` la añadió la 20261004190400 porque **la variante rota del pgTAP lo destapó**: con el trigger quitado y un saldo resucitado, la primera versión decía cero — el asiento de nacimiento de un resucitado está reversado y no entraba en ningún lado de la comparación.
- *Aplicar un saldo a favor tiene tope* (antes no: 100 aplicados a un documento que debía 60 consumían los 100 y dejaban la cuenta por cobrar en −40). **Decidido por criterio:** se RECHAZA con 422 que dice cuánto se puede aplicar; no se consume nada. **Alternativa:** recortar en silencio a lo pendiente y registrar un cobro por menos de lo pedido (un importe distinto del que la persona escribió, sin aviso).
- *20261004190300:* las funciones nuevas son `security invoker` y redondean con `platform.round_cents`, que no tenía EXECUTE para `ladino_api`: la migración se aplicó limpia y aplicar un saldo a favor respondía 404 (42501). Lo vio el E2E, que corre como la API; el pgTAP 133 ejerce ahora ese camino bajo el rol.
- *20261004190500:* la función del trigger nació sin su `revoke … from public` y quedó ejecutable por `anon`; lo cazó el gate del catálogo («ninguna función de platform es ejecutable por anon», que vale por ser cero), no el test de la migración. Tres correcciones a una migración escrita en la misma sesión (190300, 190400, 190500): es CLAUDE.md §3 —«una migración que arregla otra necesita su propia auditoría completa»— cumpliéndose otra vez.
- *F-06, decisión 8 ampliada (decidido por criterio):* la regla es SIMÉTRICA — un único separador seguido de exactamente tres cifras se rechaza sea punto o coma («26.003», «1,234», «26,003»). **Alternativa descartada:** «una coma sola siempre es decimal» (quien teclea a la americana metía mil veces menos). Con los dos separadores se valida el agrupamiento de tres (`BAD_GROUPING`: «12.34,56», «1.234,567.89» ya no devuelve algo que no es un número) y «5,» / «5.» tienen su motivo (`INCOMPLETE`). `readAmountText` es el lector de DINERO: una cantidad o una tasa con tres decimales legítimos no debe leerse con ella.
- *Abierto de esta ronda:* la regla de valoración del estado de cuenta sigue como SQL en el handler (`apps/api/src/routes/sales.ts`, `/v1/customers/:id/statement`): no se movió; sin test de pago de más con IGTF ni con retención (hace falta una empresa especial con IGTF activo); el marcador `PEND-` sigue sin una empresa sin RIF que lo ejerza; si los redondeos de varios usos parciales suman más de lo que el saldo cargó, el último uso baja 0,00 del pasivo (no se ha visto; lo acusaría `customer_credit_ledger_gap`).

**Cuarta ronda (2026-10-04) — lo que cierra de «Abierto de esta ronda», sin cambiar una cifra ni una decisión:** la regla de valoración del estado de cuenta (G-04, G-05) y lo vencido (P-05, `vencidoDe`) salieron del handler: son las lecturas con nombre `customerStatement` y `customerOverdue` de `packages/domain/src/customer-statement.ts`, con el mismo SQL, sentencia por sentencia; el handler autentica, autoriza, llama y mapea. Sin migración. Los cuatro tests que faltaban viven en `apps/api/test/e2e-cobros-cuarta-pasada.test.ts`: el pago de más con IGTF (TRES caminos lo rechazan con el mismo `VALIDATION_FAILED/422` y tres mensajes distintos, todos en la moneda del pago: por omisión lo corta `pasoDeCobro` —«esta forma de pago no da vuelto» o, en efectivo, «entrega el vuelto»—; la regla F-10 + IGTF de esta nota solo habla con `igtf_included: false`), el comprobante de retención que sobra, el marcador `PEND-` con una empresa sin RIF fundada por `/v1/onboarding`, y un saldo de 2,22 USD usado en ocho partes (siete bajan 256,34 Bs y la que agota, 102,53: el pasivo termina en 0,00). *Abierto:* `platform.customer_credit_carried` responde el importe de nacimiento para un saldo RETIRADO aunque el mayor cargue cero (sus llamadores filtran los retirados antes; R-84.15).

**F-06, cierre de la familia (2026-10-04) — un solo lector de números tecleados en TODA la web:** la decisión 8 valía para `MoneyInput` y `CobrarDocumento`; ahora vale para toda la web. Ningún fichero de `apps/web/src` cambia la coma por el punto por su cuenta (eran 48 sitios en 14 ficheros: «1.500» se volvía 1,5 y «1.234,56» viajaba como «1.234.56»). El **dinero** (importe, precio, costo, límite, pago, base, monto retenido) lo lee `leerImporte` / `importeLimpio`, con la regla simétrica de arriba. Las **cantidades, tasas y porcentajes** los lee el lector hermano `leerCantidad` / `cantidadLimpia` (los dos en `apps/web/src/components/forms.tsx`, sobre `readAmountText`): una sola coma es el decimal lleve las cifras que lleve («1,250 kg» = 1,25), y un solo PUNTO con exactamente tres cifras se rechaza por ambiguo («1.250»). Lo que un lector rechaza no se envía y su motivo se pinta junto al campo. Lo sostiene `apps/web/test/lector-unico.test.ts` (gate de fuente: cero atajos fuera de `forms.tsx`, con su variante rota) y `lector-de-cantidades.test.ts`. **Decidido por criterio:** el COSTO unitario y el precio de compra son dinero y usan el lector de importes; un costo con exactamente tres decimales («1,255») se rechaza por ambiguo y hay que escribirlo con cuatro («1,2550»). **Alternativa:** leerlos con el lector de cantidades (coma con tres cifras = decimal), que aceptaría «1,255» pero leería como 1,25 el «1,250» de quien agrupa miles con coma. **Abierto:** el formulario de orden de compra de `pages/compras/Compras.tsx` manda cantidad, precio y peso tal como se teclean, sin lector (no usaba el atajo y no entró en esta pasada); los campos que no son `MoneyInput` enseñan el motivo mientras se escribe, no al salir del campo.

## Nota de aplicación — ola 4 · una sola regla de la tasa del día (2026-10-04)

ADR aplicado según la respuesta del dueño del 2026-09-28; el alcance, **decidido por criterio**.
Migración `20261004195900_the_rate_of_the_day_has_one_rule.sql`; riesgo R-85; P-22 y P-88.

**Qué pasaba.** El §6 (H7) puso el margen de antigüedad solo en la tasa de cierre
(`platform.closing_rate`) y la ola 3 lo extendió a la llegada. Todo lo demás —venta, cobro, factura
de proveedor, pago, gasto, transferencia— seguía pasando por `platform.rate_for`, que servía la
última oficial con cualquier antigüedad. Dos reglas para «la tasa del día».

**Decisión.** La regla vive en UN sitio: `platform.rate_for` devuelve la oficial más reciente no
posterior a la fecha y no más antigua que `platform.parameters.official_rate_max_age_days` (7).
`rate_at` y `closing_rate` son esa consulta reducida al número; `closing_rate` ya no filtra por su
cuenta. Fuera del margen, quien convierte se detiene (`EXCHANGE_RATE_MISSING` / LAD51) y quien solo
muestra dice «Falta la tasa de hoy». El parámetro se renombra; `closing_rate_max_age_days` queda de
alias (un trigger mantiene los dos iguales) hasta la ola Z. Sube la versión de reglas a 1.2.0
(ADR-0079).

**Por qué ahí.** `rate_for` es por donde ya pasa todo. La alternativa —que cada llamador pase por
`closing_rate`— deja la función sin margen viva para el siguiente que la use, y obliga a tocar más
de veinte consultas en ficheros que otras familias están editando.

**Alternativas descartadas.** (a) Margen 0 con calendario de días hábiles: no hay calendario
bancario cargado. (b) Un margen por tipo de operación (más laxo para mostrar, más estricto para
facturar): serían otra vez dos reglas. (c) No acotar y solo avisar: es lo que había.

**Consecuencias negativas.** Con la fuente caída más de 7 días no se opera en divisa, y no hay
carga a mano. Las lecturas que recalculan a una fecha pasada (saldo de un cobro viejo en otra
moneda, historial de precios) pierden la cifra donde antes usaban una tasa vencida. La deuda con
proveedores a la tasa de hoy lanza en vez de decir «falta». Detalle en R-85.

**No decidido aquí.** El valor del margen (P-22, P-88) y LIVA art. 25 para el día no hábil.

**Revisión en contexto limpio (2026-10-04) — migración `20261004200000_a_payables_list_never_falls.sql`.**
La regla se dio por buena; lo que sigue se **decidió por criterio** y corrige la consecuencia
«la deuda con proveedores lanza» de arriba, que deja de valer:

- **Una lista nunca se cae, tampoco en compras.** `platform.supplier_debt_today` no lanza por una
  tasa: una factura pagada o sin saldo debe 0 sin pedirla; una con saldo y sin tasa dentro del
  margen devuelve NULL. `platform.ap_aging` lleva el tramo en NULL y cuenta la factura. Las rutas
  `GET /v1/suppliers/:id/statement` y `/aging` sirven `null` con `sin_tasa` y el nominal por moneda
  (el mismo trato que §5 dio a clientes y que el resumen ya daba a «Lo que debo»). *Alternativa
  descartada:* que la lectura siga lanzando y la API la envuelva en un `savepoint` — deja la
  excepción viva para el siguiente llamador. *Coste:* NULL no es cero y `sum()` lo descarta en
  silencio; quien sume tiene que mirarlo, y la API anterior no lo hace (R-85.3): la migración se
  aplica justo después del `git pull`. Con tasa dentro del margen, las cifras son las de antes
  (una factura `paid` con residuo sigue valorándose a la tasa; solo sin tasa se dice 0, por §4).
- **Las que convierten para ESCRIBIR siguen deteniéndose**: el saldo estricto
  (`document_balance_transaction`), la base del cierre, la revaluación (`fx_revaluation_items`) y la
  regularización de la divisa. Solo las lecturas de lista y de pantalla devuelven NULL.
- **El mensaje dice lo que se puede hacer.** Para un día pasado no se promete «Tráela en Mi
  dinero» (ADR-0064 §1: Mi dinero solo trae la de hoy). Cargar la oficial de un día pasado es hoy
  una operación de plataforma sin pantalla: **decisión abierta del dueño** (R-85.8, P-22).
- **Cambiar el margen deja acta** (`platform.parameter_changed` en `system_audit_events`; R-85.9).
  No sube el semver de las reglas (ADR-0079): ninguna regla cambió.

## Nota de aplicación — ola 4 · el pago cruzado a tasa real (2026-10-04; D-02, H-09, R-80 punto 11)

Sin migración. `packages/domain/src/purchases.ts` (`registerSupplierPayment`) y
`packages/domain/src/tolerancia-de-caja.ts` (nueva, pura).

**Qué pasaba.** Una factura de proveedor en Bs pagada desde una cuenta en USD se rechazaba con 409
`SETTLEMENT_MISMATCH` a casi cualquier tasa real. Lo que sale de la cuenta se redondea al céntimo
de dólar, y «lo que salió × tasa» se aparta de lo debido hasta medio céntimo de dólar × tasa. La
cota de la regla 4 solo contaba la unidad mínima de la moneda de la FACTURA: con la factura en Bs
(tasa 1) eran unos 0,03 Bs. Y escrito en dólares, el pago que debía cerrar quedaba como abono: la
holgura del tope era medio céntimo de Bs. Los E2E del pago cruzado usaban 40 Bs/USD, donde toda
conversión cae exacta.

**El ejemplo.** Gasto con factura, neto 1.240,00 Bs, cuenta en USD, tasa 854,4637:

| | |
|---|---|
| 1.240,00 ÷ 854,4637 | 1,4512… → salen **1,45 USD** |
| 1,45 × 854,4637 | 1.238,97 Bs |
| redondeo de caja | 1,03 Bs |
| cota de la regla 4 (una línea, primer pago, tasa 1) | 0,03 Bs → **409** |
| tolerancia de caja: 0,005 USD × 854,4637 | 4,27 Bs → **cierra** |

**La regla, espejo del cobro de ventas (ADR-0063 §2, «el cobro que cierra»).** Cuando el pago
cruza, la tolerancia de caja es media unidad mínima de la moneda del DINERO, convertida a la
moneda de la factura con las dos tasas del día del pago; nunca menos que media unidad mínima de la
moneda de la factura (la holgura que ya había). Dentro de ella:

1. *El tope de «el pago supera el saldo» y el «cierra»* (pago escrito en la moneda del dinero) usan
   esa tolerancia en vez de medio céntimo fijo de la moneda de la factura. El pago que cierra salda
   EXACTAMENTE lo que se debía.
2. *Lo funcional del pago es lo que se salda*, cuando la factura vive en la moneda funcional: la
   cuenta baja por lo que salió EN SU MONEDA (1,45 USD, el original de la línea, intacto), la
   cuenta por pagar por lo que se debía (1.240,00), y el asiento tiene dos líneas. No nace una
   línea de diferencial ni de redondeo por un redondeo de caja: la caja en USD queda valorada a
   854,4637 con 1,03 Bs de diferencia, y eso lo recoge la revaluación al cierre (§6), como en
   ventas. **Solo en el pago que CIERRA** (corregido en la re-revisión, ver más abajo): un abono
   que no cierra se asienta por lo que salió, con su diferencia en el acto.
3. *La regla 4 no se abre.* La alineación se hace contra lo SALDADO (el saldo del documento), no
   contra lo que el mayor carga: si el mayor y el saldo se apartan —aunque sea en 3,00 Bs, menos
   que la tolerancia de caja—, el pago que cerraría sigue respondiendo `SETTLEMENT_MISMATCH`. Y un
   céntimo de dólar de más sigue siendo «el pago supera el saldo».

**Decidido por criterio (§2.16), con su alternativa.**

- *La tolerancia no se redondea hacia arriba a la unidad mínima del documento* y se compara con
  `<=`: es lo que hace ventas (`registerPayment`), y manda ventas. **Alternativa:** redondearla
  hacia arriba (4,28 en vez de 4,2723); con la factura en USD y el dinero en Bs subiría la holgura
  de 0,005 a 0,01 USD, el doble de la de ventas.
- *La alineación de lo funcional solo se aplica con la factura en moneda funcional.* Con la factura
  en USD y el dinero en Bs el dinero es más fino que el documento y no hay nada que alinear (probado
  a 854,4637: cierra sin diferencial). **Alternativa:** alinear contra «lo que el mayor carga + el
  diferencial esperado» en cualquier combinación: taparía descuadres del mayor dentro de la
  tolerancia, que es justo lo que la regla 4 existe para decir.
- *La función de la tolerancia vive aparte* (`tolerancia-de-caja.ts`) y la usa compras. Ventas
  conserva su cálculo en línea, que da la misma cifra; unificarlo es un cambio en `sales.ts` que no
  se hizo aquí.

**Consecuencias negativas.** El valor funcional de la línea de caja de un pago cruzado ya no es
«original × tasa del día» al céntimo: se aparta hasta medio céntimo de la divisa × tasa (4,27 Bs a
854,4637) por pago, hasta la siguiente revaluación. Quien pague una factura en Bs desde una cuenta
en USD dejando menos que esa tolerancia la deja PAGADA, no con un resto de 2 Bs. `fx_rate` de la
fila del pago sigue siendo la tasa del día, y `functional_amount` ya no es exactamente
`net_amount × fx_rate` en esos pagos (igual que en los cobros de ventas desde ADR-0063).

**Verificación.** `apps/api/test/e2e-moneda-diferencial.test.ts`, bloque «compras: el pago cruzado
a TASA REAL» (casos a, c, d, e, e2 y el espejo de ventas), `apps/api/test/e2e-gasto-con-factura.test.ts`
(«a TASA REAL») y `packages/domain/test/tolerancia-de-caja.test.ts`. Tras cada caso:
`settled_ledger_gaps`, `treasury_currency_gaps`, `treasury_ledger_gaps` y `cent_gaps` en cero, y la
comprobación cuadrada.

### Re-revisión en contexto limpio (2026-10-04): la alineación es solo del pago que cierra

**Qué pasaba.** La primera versión alineaba lo funcional también en el ABONO que no cierra cuando
se escribía en Bs lo que se cancela y la cuenta vivía en USD: un abono de 500,00 Bs sacaba 0,59 USD
(504,13 Bs a 854,4637) y cancelaba 500,00, sin asentar los 4,13 Bs. Hasta 4,27 Bs POR ABONO, sin
límite de abonos, fuera del mayor hasta el cierre. En HEAD (f16e8c6) esa diferencia se asentaba en
el acto, y ventas alinea solo «el cobro que cierra»: un abono de ventas que no cierra queda en
`importe × tasa` al céntimo.

**Decidido por criterio.** En compras la alineación se aplica SOLO al pago que cierra el documento
(`registerSupplierPayment`: la condición lleva `cierra`). Un abono que no cierra se asienta como en
HEAD: lo funcional es lo que salió × tasa, la cuenta por pagar baja por lo cancelado y la diferencia
va al diferencial cambiario en ese asiento. **Alternativa descartada:** alinear también los abonos
(lo que había): menos líneas en el asiento, a cambio de un residuo acumulable sin tope fuera del
mayor.

| Tres abonos en Bs desde la cuenta en USD y el que cierra (factura de 1.438,40 Bs) | sale | funcional | diferencia |
|---|---|---|---|
| abono 500,00 | 0,59 USD | 504,13 | 4,13 pérdida |
| abono 300,00 | 0,35 USD | 299,06 | 0,94 ganancia |
| abono 200,00 | 0,23 USD | 196,53 | 3,47 ganancia |
| cierra 438,40 | 0,51 USD | 438,40 (alineado; 0,51 × tasa = 435,78) | — |

**Lo que queda abierto (P-100, VALIDAR-CONTABLE).** El residuo del redondeo de la moneda del dinero
se asienta hoy como diferencial cambiario en el abono y se deja a la revaluación en el pago que
cierra: dos tratos para el mismo origen. Si es diferencial o «Diferencias por redondeo» (5.1.10,
§7), y si el del cierre puede esperar a la revaluación, lo dice el asesor.

**Deuda técnica anotada: una sola función de tolerancia para los dos lados.** Esta ola no toca el
cobro de ventas. `toleranciaDeCaja` (compras) y el cálculo en línea de `registerPayment` (ventas)
dan la misma cifra SOLO cuando el documento vive en la moneda funcional y el dinero vale al menos
una unidad de ella (documento en Bs, dinero en USD a 854,4637: 4,27231850 en los dos). Con el
documento en divisa difieren: ventas mide en moneda funcional y sin suelo (documento en USD cobrado
en Bs: 0,005 Bs); compras, en la moneda del documento y con suelo (0,005 USD, 4,27 Bs). El párrafo
de arriba que decía «da la misma cifra» vale solo para el caso común. El test unitario
`tolerancia-de-caja.test.ts` fija la igualdad en ese caso, documenta la diferencia y comprueba que
`sales.ts` sigue diciendo la fórmula que copia. Unificarlas es elegir una de las dos semánticas
para el documento en divisa: decisión pendiente, no un refactor.

**Verificación añadida.** Casos d2 (el abono asienta su diferencia), d3 (tres abonos y el que
cierra: cada línea de diferencial, la cuenta por pagar en cero, 1,68 USD salidos de la caja y los
cuatro invariantes en cero), e (el tope, exacto: 422 `VALIDATION_FAILED` con su mensaje literal) y
e2 (`SETTLEMENT_MISMATCH` con la cuenta por pagar cargada de más Y de menos, por las dos formas de
escribir el pago).

## Nota de aplicación — ola 4 · el vencimiento: lo vencido es la deuda de siempre, filtrada (2026-10-04; P-05, E-22)

**Decidido por criterio** (RESPUESTA §2.16: lo que promete la pantalla; menor sorpresa; lo
reversible; lo que hacen Valery, Saint, Profit y Galac, donde cada factura a crédito lleva su
vencimiento). La respuesta del dueño da por hecho que una venta fiada VENCE (ordena la lista por
«deuda vencida» y lo imprime el recibo) y el producto no tenía con qué decirlo.

1. **El dato.** `documents.due_date` (`date`, nullable; migración `20261004210000`). Se escribe AL
   EMITIR, con lo que traiga la petición, y queda congelada: un trigger propio de la columna
   (`documents_06_due_date_frozen`, LAD06), porque `platform.assert_document_immutable` enumera
   columnas y no la conoce (no compara la fila entera). CHECK: no anterior al día de Caracas de
   la emisión (dos `date`).
2. **La caja exige; la administración ofrece.** `quickSale`: si la venta deja saldo y no viene
   `due_date`, 422 «Di cuándo paga el cliente» y la transacción entera se deshace. Si queda
   pagada, la fecha que venga se guarda y no significa nada. `POST /v1/invoices`: opcional; sin
   ella el documento vence el día de su emisión. No hay plazo por omisión escrito en código: el
   vencimiento lo decide una persona.
3. **Lo vencido NO es una segunda regla de deuda** (§5): es `platform.document_debt` sobre los
   documentos con `platform.document_due_day(due_date, issued_at) < hoy`, donde «hoy» es un `date`
   (el día de Caracas, o el parámetro `p_today` de `platform.customer_overdue_today`). Vencer hoy
   no es estar vencido. Sin tasa de hoy, lo vencido en divisa lleva su nominal y el funcional en
   NULL con motivo `sin_tasa`: nunca 0.
4. **Lo anterior al corte.** Un documento sin fecha (todo lo emitido antes, y la factura de
   administración que no la trae) vence el día de su emisión: una deuda sin plazo acordado es
   exigible desde que nace. Para lo viejo, «vencido» coincide con «debe» desde el día siguiente.
5. **El papel** (E-22). La venta con saldo imprime «A CRÉDITO», «Saldo pendiente» (el de la
   función de deuda A LA FECHA EN QUE SE IMPRIME, en la moneda del documento y, si hay tasa, su
   valor en bolívares) y «Vence». Son leyendas no fiscales: no cambian base, IVA ni numeración.
   Van en el recibo y en la copia de cortesía de la factura; **no** en `destino=papel` ni
   `vista` de la factura: el tope de filas de la forma libre (PA 00071 art. 33) está medido
   contra el cuerpo actual y tres renglones más podrían sacar de la hoja una factura que cabe
   justa.
6. **No hay invariante nuevo.** «Toda venta de caja con saldo lleva vencimiento» no se puede
   enunciar sobre el esquema: el documento no dice de forma fiable si nació en la caja
   (`cart_id` es opcional) y la factura de administración puede no llevarla. La regla vive en el
   dominio con su E2E; la lista de invariantes sigue igual.

**Alternativas descartadas:** (a) vencido = más de N días desde la emisión para todos (un umbral
inventado, fijo en código); (b) un plazo de crédito por cliente o por empresa que calcule la
fecha (más dato y más pantalla; queda como comodidad futura: la fecha propuesta podrá salir de
ahí); (c) ordenar por la deuda más antigua sin decir «vencido» (no cumple el texto del dueño ni
el recibo de E-22); (d) abrir una escritura única en la guarda del documento para borrar la
fecha de una venta que quedó pagada (toca la inmutabilidad por un dato que no significa nada).

**Verificación.** pgTAP 132 (CHECK a las 23:30 de Caracas; el día de vencimiento a las 20:30 y a
las 23:30; lo vencido con `p_today`; sin tasa; LAD06; aislamiento como `ladino_api` con el usuario
de dos tenants; variantes rotas del trigger, del CHECK, de la RLS y del día UTC),
`e2e-el-fiado-vence.test.ts` (11 casos) y las comprobaciones E-22 y P-05 del recorrido. Riesgos
abiertos: R-86.
