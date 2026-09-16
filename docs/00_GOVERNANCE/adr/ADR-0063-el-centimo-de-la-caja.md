# ADR-0063 — El céntimo de la caja: cobrar, dar vuelto y valorar sin polvo

- **Estado**: aceptada (dueño, 2026-09-15: «arregla TODO … con la mejor práctica»)
- **Fecha**: 2026-09-16 (migración 62)
- **Módulos**: ventas (POS, cobros) · tesorería · contabilidad · reportes
- **Rigor**: máximo. Enmienda ADR-0058 §«Lo que NO cambia» en los tres puntos de abajo.
- **HOMOLOGATION_IMPACT**: NO. El total de la factura y su numeración no cambian (siguen
  PER_LINE, ADR-0058). Cambian el importe del cobro guardado, el vuelto y el diferencial.

## Contexto — QA de pantalla 2026-09-15

Con la venta anclada en USD (ADR-0047) y la caja en bolívares:

- vuelto de USD 5 sobre USD 2,80 = «USD 2,19» (h. 16);
- el cobro en USD guardado como 2,80000147 y 4,22529291; la caja en dólares con «USD 7,02529438»,
  el cierre pidiendo contar «USD 4,49999982» (h. 17, 28);
- cobrar en Bs el total exacto dejaba «Ganancia cambiaria 0,00000302» con la misma tasa (h. 18, 29);
- la caja cotizaba Bs 5.558,56 (total convertido una vez) y el recibo sumaba Bs 5.558,57
  (renglones redondeados) (h. 19, 57);
- saldos con 5–6 decimales: «Saldo Bs. 21.493,114984» con total 21.493,12 (h. 32, 37, 56).

Causa: `pasoDeCobro` guardaba lo APLICADO a 8 decimales (el pendiente funcional ÷ tasa), el
diferencial se calculaba con un ida-y-vuelta ÷ tasa × tasa sin tolerancia, la cotización y el
documento usaban dos reglas de total, y los saldos se servían sin redondear.

## Decisión

1. **Un solo total.** La cotización del POS suma los renglones funcionales redondeados, igual que
   `insertarDocumento` (PER_LINE, ADR-0058). Lo que la caja anuncia es lo que el recibo dice.
2. **El cobro que cierra, en céntimos de su moneda.** Lo necesario para cerrar en la moneda del
   pago se redondea HALF_UP a sus unidades mínimas; el importe guardado del cobro es ese número
   (céntimos de verdad) y su valor funcional es EXACTAMENTE el pendiente funcional: el documento
   queda en cero y la caja suma lo que entró. El vuelto es entregado − necesario, redondeado HACIA
   ABAJO a las unidades mínimas (la caja nunca devuelve de más). El abono parcial se guarda tal
   como se entregó y su funcional se redondea a las unidades mínimas de la moneda funcional.
3. **Diferencial sin polvo.** El diferencial de un cobro se calcula con la proporción
   (funcional × (1 − tasaEmisión ÷ tasaCobro)), redondeado a las unidades mínimas funcionales; con
   tasas iguales es CERO exacto y un resultado menor que un céntimo no se registra.
4. **El saldo se sirve a céntimos.** `document_debt_today`, el saldo del detalle y el del
   comprobante de cobro viajan redondeados a 2 (la base conserva 8), con la regla del último
   céntimo que ya existe.
5. **Las equivalencias de presentación** (≈ Bs de un precio, columna en bolívares de la lista, la
   vista previa de una entrada) se sirven a las unidades mínimas de su moneda.
6. **Cierre de caja** a unidades mínimas: esperado, contado y diferencia en céntimos; el asiento
   del faltante, a céntimos funcionales.

Lo que NO cambia: el costeo del inventario sigue a 8 decimales (§6.6); los asientos derivados de
ese costeo conservan su escala (el invariante kardex = mayor lo exige). Las pantallas de
contabilidad e inventario reciben esos importes redondeados a 2 al servir.

## Consecuencias

- Tests que fijaban 8 decimales en cobros y equivalencias cambian (listados en el commit).
- VALIDAR-CONTABLE (ADR-0058 §6.4): la diferencia de redondeo de un cobro en divisa que cierra
  (≤ media unidad mínima) no se asienta aparte; queda absorbida en la conversión del cobro.

## Cómo quedó implementado

- `quotePos` suma los renglones funcionales, igual que `insertarDocumento` (§1);
- `pasoDeCobro` calcula lo necesario en las unidades mínimas de la moneda del pago, y el vuelto
  sale de esa cifra; el abono parcial valora a los céntimos funcionales (§2);
- `registerPayment` ajusta el valor funcional del cobro que cierra a lo pendiente EXACTO, con
  tolerancia de media unidad mínima de la moneda del cobro — y el tope de sobrecobro usa esa
  misma holgura, para que pagar lo sugerido nunca se lea como «de más» (§2);
- `exchangeDifference` calcula la diferencia como importe × (tasa de cobro − tasa de emisión),
  redondeada UNA vez, y deriva lo valorado a la emisión restándola: con tasas iguales es cero
  exacto, y las tres cifras del asiento cuadran por construcción (§3);
- migración 62: `platform.currency_minor_units` y `document_debt_today` como proporción del
  total funcional reindexada por la tasa, servida en céntimos (§4);
- se sirven en céntimos: el saldo del documento, los saldos de las cuentas, los importes del
  arqueo, el dinero por moneda del resumen y las equivalencias de la lista de precios (§§4-5);
- `closeCashRegister` arquea en unidades mínimas, y el asiento de la diferencia también (§6).

**Lo que queda sabido y no resuelto**: el saldo materializado de una cuenta con historia vieja
conserva el polvo de los cobros anteriores a esta decisión (se sirve redondeado, y el arqueo lo
absorbe la primera vez que alguien cuenta esa caja y explica la diferencia). No se toca dato de
producción para limpiarlo: R8.
