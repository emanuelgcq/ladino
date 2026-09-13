# ADR-0058 — El documento de venta se redondea a la moneda

- **Estado**: aceptada (orden del dueño de resolver todos los hallazgos, 2026-09-12)
- **Fecha**: 2026-09-12
- **Módulos**: ventas (cotización, pedido, factura, notas, recibo, caja) · contabilidad
- **HOMOLOGATION_IMPACT**: **SÍ**. Cambia la escala con la que se calculan base,
  impuesto y total de cada documento nuevo. No toca numeración, formato ni
  emisión, ni ningún documento ya emitido.

## Contexto

`sales:document:8:HALF_UP` redondeaba base, impuesto y total a **ocho
decimales**: la escala de `numeric(24,8)`, no la de ninguna moneda. Con precios
redondos no se notaba. La auditoría del 2026-09-11 (hallazgo A-12) lo midió en
producción y en la caja:

| Pantalla | Lo que decía |
|---|---|
| POS, total | **Bs. 567,762** · IVA Bs. 78,312 |
| POS, vuelto | **USD 0,476** |
| Deuda de un cliente | Bs. 131,775 |
| Balance de comprobación | Bs. 8.144,94980062 |

**Bs. 567,762 no se le puede cobrar a nadie**, y USD 0,476 no se le puede
devolver. La web no falla: `formatMoney` se niega a redondear a propósito
(MONEY_AND_ROUNDING_SPEC §5) y enseña el exacto para que el defecto se vea. El
defecto es la escala del documento.

ADR-0053 ya resolvió el mismo problema para la percepción de IGTF, con este
argumento: *la escala la decide la moneda, no el fisco* (ISO-4217, spec §6.1).
Este ADR extiende esa decisión al documento entero.

## Decisión

**Base e impuesto de cada línea se redondean a las minor units ISO-4217 de la
moneda del documento; el pie es la suma de las líneas.**

```
sales:document:<minorUnits>:<modo>      p. ej. sales:document:2:HALF_UP
```

1. **Escala: la de la moneda del documento**, leída del registro
   (`currencyDefinition().minorUnits`): 2 para VES y USD. Una moneda de cero o
   de tres decimales se comportaría sola.
2. **Agregación PER_LINE, sin cambio.** Cada línea redondea su base y su
   impuesto; el total del documento es la suma de lo impreso. La disyuntiva
   PER_LINE / PER_DOCUMENT de la spec §6.2 sigue siendo del asesor; este ADR no
   la cierra.
3. **El precio unitario NO se redondea a la moneda.** Un precio de lista puede
   llevar tres decimales (combustible, granel); lo que se cobra es base ×
   cantidad. Su política (`sales:price:8:HALF_UP`) solo interviene si la lista
   está en otra moneda que el documento.
4. **La conversión a moneda funcional también va a las minor units de la
   funcional**: cada línea × tasa, redondeada a dos decimales de bolívar; el
   pie funcional es la suma y el impuesto funcional se deriva por resta, así
   que `documents_amounts_chk` cuadra por construcción. Un solo
   `rounding_policy_id` describe la fila entera, como exige ADR-0024.
5. **El vuelto se entrega a las minor units de la moneda con la que se
   devuelve.** El importe aplicado al documento sigue exacto.
6. **El modo queda nombrado**: `MODO_DOCUMENTO = "HALF_UP"`, el que ya usaba
   el pipeline. **VALIDAR-TRIBUTARIO**: la spec §6.3 deja el modo al asesor;
   la escala no está en duda.

## Lo que NO cambia

- **Ningún documento emitido.** Llevan `sales:document:8:HALF_UP` en su fila y
  esa es la regla con la que se calcularon. Un documento no se reinterpreta
  (regla 1); los 13 documentos históricos con más de dos decimales van al
  asesor (P-13).
- **La valoración de cobros y del diferencial cambiario sigue a ocho
  decimales** (`sales:valuation:8:HALF_UP`): caja = deuda saldada + diferencial
  tiene que cuadrar al céntimo de ocho decimales en el asiento, y un cobro en
  divisa contra un documento en bolívares no es representable en céntimos.
  Es exactamente el caso de la spec §6.4: la diferencia entre lo exacto y lo
  entregable es un hecho contable con contrapartida propia.
- **La diferencia de redondeo de caja (spec §6.4) todavía no tiene asiento.**
  Un vuelto de USD 11,11 entregado por un residuo exacto de 11,11111111 deja
  0,00111111 sin contrapartida. Es menor que una minor unit por cobro, y queda
  registrado aquí como **VALIDAR-CONTABLE** y en `HANDOFF.md`: el asiento de
  redondeo contra la cuenta de diferencia del plan es la siguiente pieza, no
  esta.

## Por qué así y no de otra forma

- **Alternativa descartada — mantener ocho decimales y redondear solo para la
  pantalla.** La caja no cobra pantallas: el total del documento es lo que se
  imprime y lo que entra en el libro de ventas. Redondear al enseñar dejaría
  un documento que dice una cosa y un libro que suma otra.
- **Alternativa descartada — redondear el pie y repartir el residuo entre
  líneas (`allocate()`).** Solo hace falta con agregación PER_DOCUMENT; con
  PER_LINE el pie es la suma exacta de líneas ya redondeadas y no hay residuo
  que repartir. Si el asesor elige PER_DOCUMENT, ese es el punto donde entra.

## Consecuencias

- Sin migración: `rounding_policy_id` ya existe en `documents` y
  `document_lines` y es texto libre; la fila nueva dice `sales:document:2:HALF_UP`
  y la vieja `sales:document:8:HALF_UP`. La spec §6.3 pasa de
  `VALIDAR-TRIBUTARIO` a «minor units ISO-4217 (ADR-0058); modo HALF_UP,
  VALIDAR-TRIBUTARIO».
- Los E2E de ventas que esperaban totales con más de dos decimales cambian a
  lo que la moneda sabe cobrar.
- El kardex valorado (`inventory:cost:8:HALF_UP`) y los gastos
  (`treasury:expense:8:HALF_UP`) no cambian: son costeo y valoración, no
  documentos que se cobren (spec §6.6).
