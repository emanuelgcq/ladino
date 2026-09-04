# ADR-0046 — La venta se denomina en bolívares; el dólar es el ancla de precios

- **Estado:** aceptado (orden del dueño, 2026-09-04)
- **Reemplaza parcialmente:** la decisión de ADR-0020 de calcular el documento de venta en la
  moneda de la lista (el diferencial cambiario de VENTAS). ADR-0020 sigue vigente para
  compras, tesorería y para los siete campos de conversión, que no cambian de forma.

## Contexto

Los precios del comercio venezolano se piensan en dólares, pero la operación con el cliente
se expresa en bolívares: la factura y el recibo salen en Bs a la tasa BCV del día. El art.
13.14 de la PA 00071 exige ambas monedas y el tipo de cambio **solo cuando la operación se
expresó en moneda extranjera** — si la operación se expresa en bolívares, el documento va en
bolívares y punto.

Hasta ahora Ladino calculaba el documento en la moneda de la lista (una lista USD producía
una factura denominada en USD, impresa en USD con su equivalente en Bs), deliberadamente,
para que el cobro posterior tuviera contra qué comparar el diferencial cambiario. El dueño
ordenó lo contrario: la lista es siempre USD, el carrito enseña ambas monedas, y **el
documento final se imprime siempre y solo en Bs**.

## Decisión

1. **Todo documento de venta se denomina en la moneda funcional de la empresa** (Bs en
   Venezuela): `transaction_currency = functional_currency`, siempre. El trigger de emisión
   lo exige (LAD70) — la ausencia de mecanismo no es prohibición.
2. **La lista de precios es un ancla en USD.** El precio unitario se convierte a Bs con la
   tasa vigente A LA FECHA del documento (`platform.rate_at` semántica: la más reciente no
   posterior) ANTES de calcular la línea; sin tasa, la venta desde una lista en divisa
   RECHAZA (LAD51, igual que antes).
3. **La procedencia de esa conversión se congela en el documento**: `pricing_currency`,
   `pricing_fx_rate`, `pricing_rate_source`, `pricing_rate_timestamp` (migración 38). NULL
   cuando la lista ya estaba en moneda funcional. Es la regla 3 (origen) y la regla 8
   (tasas efectivas por fecha y fuente) aplicadas al precio.
4. **El carrito y la lista de precios enseñan ambas monedas**; los dos lados los calcula el
   SERVIDOR (la web no hace aritmética de dinero). El lado USD del carrito es REFERENCIA —
   lo que se cobra, se debe y se contabiliza es el lado en Bs.
5. **El PDF de venta imprime solo Bs.** El bloque 13.14 (ambas monedas + tasa) queda para
   los documentos históricos denominados en divisa, que se siguen imprimiendo como nacieron.

## Consecuencias

- **El diferencial cambiario de ventas desaparece por diseño.** Una deuda expresada en Bs
  no se revaloriza: quien fía en modo recibos o factura a crédito asume que el monto en Bs
  es el monto. `exchange_gain_loss` y su asiento siguen existiendo para los documentos
  históricos en divisa y para el lado de compras/tesorería. Si algún día vuelve una venta
  B2B expresada en divisa, vuelve por ADR y con su propio cambio del gate.
- Los siete campos de ADR-0020 quedan en identidad para ventas (tasa 1, misma moneda) — su
  forma no cambia, así que cobros, saldos y libros no se tocan.
- El cobro en efectivo USD del POS sigue igual: el pago se convierte a funcional con la
  tasa del día del PAGO y el vuelto se calcula en la moneda entregada.
- Las pantallas dejan de ofrecer listas en Bs (el esquema sigue admitiendo listas en
  moneda funcional: la conversión es identidad y no congela procedencia).
