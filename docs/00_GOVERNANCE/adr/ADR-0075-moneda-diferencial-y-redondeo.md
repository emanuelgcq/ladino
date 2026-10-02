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
