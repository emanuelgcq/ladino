# ADR-0078 — Salidas y retiros de inventario: tres verbos, un motivo con CHECK, y el retiro es una venta a la propia empresa

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.13). Hallazgos: I-01, I-02, I-05, I-06, I-07, I-08, I-09, I-10, I-11, I-12 y P-10.
- **Fecha:** 2026-10-02.
- **Impacto fiscal:** SÍ: el retiro causa débito fiscal (LIVA art. 4.3) y va al libro de ventas.
- **Enmienda:** ADR-0034 (inventario) y ADR-0060 (inventario en el mayor), en los tipos de movimiento y sus cuentas.

## Contexto
El recorrido encontró:
- un solo verbo para trasladar, ajustar y sacar (I-08);
- el motivo como nota libre (I-01);
- las mermas contra el costo de ventas (I-11);
- el consumo propio y los regalos sin débito fiscal (I-11);
- un conteo que no calcula la diferencia (I-07);
- un kardex sin tipos legibles (I-06);
- «por agotarse» que ignora lotes e inactivos (I-12, P-10).

## Decisión
1. **Tres verbos distintos:**
   - `traslado`, entre depósitos y sin cambio de valor;
   - `ajuste por conteo`: la diferencia entre lo contado y el sistema, con motivo;
   - `salida con motivo`: merma, rotura, vencido, consumo propio, regalo, donación o muestra.
2. **El motivo es una columna con CHECK**, no una nota, y viaja al asiento.
3. **Contabilidad y fiscal de las salidas:**
   - las mermas, roturas, vencidos y faltantes justificados van a «Pérdidas por mermas y faltantes de inventario», un gasto operativo con cuenta propia que no es costo de ventas. Son faltantes justificados solo con motivo y evidencia (RLIVA art. 14);
   - **el consumo propio, el regalo, la donación y la muestra son retiros (LIVA art. 4.3):** generan débito fiscal sobre el valor de mercado y un documento interno «Nota de retiro» numerado, que va al libro de ventas como venta a la propia empresa;
   - en una empresa sin RIF, el retiro deja solo la salida de kardex y el gasto.
4. **Conteo:** un verbo «Conteo». La persona escribe lo que contó, el sistema calcula la diferencia y propone el ajuste con motivo.
5. **Kardex por depósito con tipos legibles.**
6. **No se vende sin existencia (E-13):** el ajuste muerto se elimina. Cuando la caja no encuentra existencia, ofrece «Registrar llegada rápida» (ADR-0066).
7. **Pausado (I-05, C-03):** inactivo significa «no se vende», no «no existe». Sale de la cuadrícula y de la búsqueda de la caja, pero sigue en el inventario con la marca «inactivo» y su existencia. Al inactivar con existencia, la pantalla avisa.
8. **«Por agotarse» (I-12, P-10):** cuenta la existencia total, incluida la que está en lotes, y excluye los inactivos.

## Consecuencias
- **Positivas:**
  - cada salida dice qué es y adónde va en el mayor;
  - el retiro tributa como manda la LIVA;
  - el conteo es un flujo, no una cuenta mental.
- **Negativas:**
  - un documento interno nuevo (Nota de retiro) con su numeración;
  - un CHECK nuevo sobre el motivo: los movimientos viejos no se tocan (append-only), y el CHECK aplica a los nuevos (NOT VALID o columna nueva);
  - la cuenta de mermas se agrega al plan de las empresas existentes.
- **Para revertir:** los tipos y la cuenta son aditivos. Las notas de retiro emitidas no se borran.

## Verificación
- Invariantes: `inventory_ledger_gap()` e `inventory_coverage_gaps()` en cero con las salidas nuevas; el retiro en el libro de ventas cuadra con `book_ledger_reconciliation()`.
- E2E: traslado sin cambio de valor; conteo con diferencia; merma a su cuenta; consumo propio con débito fiscal y Nota de retiro; «por agotarse» con lotes.
- `pnpm recorrido I` y `P`.
