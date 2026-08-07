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
