# Reglas contables de Venezuela


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Principio de diseño

Ladino implementará un motor de partida doble compatible con políticas contables configurables. La clasificación exacta de la entidad y el marco VEN-NIF aplicable deben ser validados por contador público.

## Invariantes

- Débitos = créditos por asiento.
- Un asiento posted no se edita.
- La fecha contable debe pertenecer a periodo abierto.
- Todo asiento tiene fuente: venta, compra, pago, ajuste, nómina, activo, manual.
- Una moneda funcional por empresa y monedas transaccionales adicionales.
- Tipo de cambio y fuente quedan congelados en la transacción.
- Reversión conserva relación con asiento original.
- Cierre bloquea posting salvo permiso/flujo de reapertura.

## Estados financieros mínimos
- balance de comprobación;
- estado de situación financiera;
- resultados;
- flujo de efectivo como módulo/reporting;
- mayor;
- diario;
- auxiliares;
- movimientos por centro de costo.

## Reglas que no se deben hard-code
- plan de cuentas;
- vida útil/depreciación por clase;
- tratamiento de diferencias cambiarias;
- metodología de ajuste por inflación;
- reglas de reconocimiento específicas de industria.

## Control de cambios
Cada política contable debe tener:
`id`, `company_id`, `effective_from`, `effective_to`, `version`, `approved_by`, `source_document`.
