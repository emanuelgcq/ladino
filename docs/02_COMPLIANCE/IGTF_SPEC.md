# IGTF

## Alcance
Motor configurable para supuestos de IGTF que correspondan a la empresa y medio de pago.

## Regla
El sistema no debe asumir universalmente que toda operación en divisa causa IGTF.

Inputs mínimos:
- clasificación del contribuyente;
- fecha;
- moneda/medio;
- naturaleza de operación;
- establecimiento;
- regla vigente.

## Posting
La cuenta contable del impuesto se obtiene de `accounting_mappings`.

`VALIDAR-TRIBUTARIO` antes de habilitar en producción.

## Marco verificado el 2026-09-28 (respuesta del dueño al recorrido)

| Norma | Qué fija | Fuente · verificada | Estado |
|---|---|---|---|
| LIGTF (G.O. 6.687 Ext., 25-02-2022; rige desde el 27-03-2022) + Decreto 4.972 + PA SNAT/2022/000013 (G.O. 42.339, 17-03-2022) | 3 % transitorio sobre pagos en divisas o cripto (art. 4 num. 5 y 6); 0 % en Bs para SPE (Decreto 4.972); percepción el mismo día (PA art. 2); entero quincenal según el calendario SPE (art. 3); percepción indebida → restituir al cliente y pedir reintegro (art. 4); la factura muestra alícuota y monto del IGTF percibido (art. 6) | gerenciaytributos, ivecofi · 2026-09-25/28 | verificado; **Decreto 4.924 pendiente de fuente** |

Decisiones del dueño que aplican esta norma (respuesta §2.6):
- el SPE percibe el 3 % sobre lo pagado en divisas contra **cualquier** documento;
- la caja lo suma al total;
- el cobro posterior se documenta con una Nota de Débito por IGTF;
- la devolución deja el IGTF percibido, y solo la anulación lo hace indebido;
- la quincena la calcula el servidor con el calendario.

## Fuentes normativas (verificadas 2026-09-12)

- **Ley de IGTF** (reforma 2022): 3 % sobre pagos en divisas o criptoactivos distintos de los
  emitidos por la República, percibido por el sujeto pasivo especial.
- **Decreto 4.972** (G.O. Ext. 6.821, publicada el 12/07/2024, vigente desde el 15/07/2024): alícuota **0 %** para las operaciones en
  bolívares de los sujetos pasivos especiales. Ladino solo percibe sobre el PAGO en divisa
  (ADR-0052) y redondea la percepción a la moneda (ADR-0053).
- La percepción es de la empresa clasificada como sujeto pasivo especial (`IGTF` en la puesta a
  punto); una empresa ordinaria no percibe.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**: alícuota, supuestos y modo de redondeo).
