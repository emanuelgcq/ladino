# ADR-0047 — La deuda se ancla en dólares; el papel habla en bolívares

- **Estado:** aceptado (orden del dueño, 2026-09-04)
- **Reemplaza:** la decisión central de ADR-0046 (denominar la venta en funcional). Se
  conservan de ADR-0046 las decisiones de pantalla: lista de precios siempre en USD con su
  columna en Bs, carrito y cuadrícula en dos monedas, y el PDF hablando en bolívares.
- **Restituye:** la denominación de ADR-0020 (el documento nace en la moneda de la lista) —
  y la corrige donde estaba corta.

## Contexto

ADR-0046 denominó la venta en bolívares. El dueño lo tumbó con un ejemplo de bodega: *el
lunes el producto vale 1 USD = 100 Bs y se fía; el viernes 1 USD = 150 Bs; el comerciante
perdió 50 Bs de margen porque fió en la moneda que se devalúa.* Una deuda expresada en Bs
congela el margen en la tasa del día de la venta. En Venezuela **se fía en dólares y se
cobra en bolívares a la tasa del día del pago** — eso es lo que el sistema tiene que decir.

Y la revisión destapó que el modelo previo a ADR-0046 tampoco lo decía completo: el saldo
(`document_balance`) vive en moneda funcional congelada a la tasa de emisión, así que
**cobrar en bolívares días después pedía los Bs del día de la venta** — la misma pérdida,
solo que por la puerta del cobro. El diferencial solo se registraba si el pago venía en la
moneda del documento.

## Decisión

1. **El documento se denomina en la moneda de la lista** (USD): ADR-0020 vuelve a mandar.
   Los siete campos congelan la tasa de emisión; el diferencial cambiario existe otra vez.
2. **La deuda vive en la moneda del documento.** Nueva `platform.document_balance_transaction`:
   total en moneda de transacción − Σ cobros, cada cobro valorado en esa moneda (los pagos
   en otra moneda se convierten con la tasa USD→VES **del día en que se pagó**). Un
   documento en divisa está `paid` cuando ESTE saldo llega a cero — no cuando el funcional
   congelado lo diga: pagar los 116 USD completos salda la factura aunque la tasa haya
   bajado.
3. **Lo que se debe HOY se pregunta con `platform.document_debt_today`**: para documentos
   en divisa, saldo en transacción × tasa de HOY; para documentos en funcional, el saldo
   funcional de siempre. Deudas, estado de cuenta y el chip del POS cobran por esta
   función: el viernes la deuda del lunes vale viernes.
4. **El diferencial se registra para TODO cobro de un documento en divisa**, venga en USD o
   en Bs: la porción saldada en USD × (tasa del pago − tasa de emisión). Antes solo se
   escribía si el pago venía en la moneda del documento.
5. **El papel habla en bolívares** (lo que queda vivo de ADR-0046): el PDF imprime líneas y
   totales del LADO FUNCIONAL congelado (Bs), y —cuando la operación se expresó en
   divisa— añade el total en la moneda del documento y el tipo de cambio con su fuente.
   Ambas monedas presentes: art. 13.14 cumplido, y el Bs es el que se lee grande.
6. Las columnas `pricing_*` de la migración 38 se eliminan: con la denominación restituida,
   la procedencia de la conversión vuelve a vivir en los siete campos de ADR-0020. Ningún
   dato productivo las usó (la migración 38 nunca corrió bajo una API desplegada).

## Consecuencias

- El caso del dueño, como test: fío 1 USD el lunes a 100; el viernes la tasa es 150; la
  deuda de hoy dice 150 Bs, el cobro en Bs pide 150, y los 50 de más quedan como ganancia
  cambiaria — no desaparecen en el camino.
- Pagar la factura completa en su moneda la deja `paid` con la tasa subiendo o bajando; el
  ajuste va al diferencial. El estado ya no depende de una comparación en la moneda
  equivocada.
- El carrito enseña Bs grande (es lo que se cobra hoy) y el USD al lado; la cotización
  lleva ambos lados POR LÍNEA, calculados por el servidor.
- Sin tasa del día no se puede valorar un cobro cruzado ni la deuda de hoy: se RECHAZA
  (LAD51 de espíritu), no se inventa — igual que en la emisión.
