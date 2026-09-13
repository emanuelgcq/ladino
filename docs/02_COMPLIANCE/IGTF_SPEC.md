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

## Fuentes normativas (verificadas 2026-09-12)

- **Ley de IGTF** (reforma 2022): 3 % sobre pagos en divisas o criptoactivos distintos de los
  emitidos por la República, percibido por el sujeto pasivo especial.
- **Decreto 4.972** (G.O. Ext. 6.821, 15/07/2024): alícuota **0 %** para las operaciones en
  bolívares de los sujetos pasivos especiales. Ladino solo percibe sobre el PAGO en divisa
  (ADR-0052) y redondea la percepción a la moneda (ADR-0053).
- La percepción es de la empresa clasificada como sujeto pasivo especial (`IGTF` en la puesta a
  punto); una empresa ordinaria no percibe.
- Texto primario en Gaceta pendiente de archivar en `EXPEDIENTE_TECNICO.md`
  (**VALIDAR-TRIBUTARIO**: alícuota, supuestos y modo de redondeo).
