# Caja y efectivo


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Controlar aperturas, ingresos/egresos, arqueos y diferencias.

## Entidades
- `cash_sessions`
- `cash_movements`
- `cash_counts`
- `cash_denominations`

## Reglas de negocio
- Toda caja abierta tiene operador.
- Egreso manual requiere motivo.
- Arqueo no altera esperado.
- Diferencia genera evento y posible asiento aprobado.

## Estados / transiciones
closed→open→closing→closed.

## Permisos
- cajero opera.
- supervisor aprueba ajustes.
- auditor consulta.

## API / eventos
- `POST /v1/cash/open`
- `POST /v1/cash/movements`
- `POST /v1/cash/close`

## Criterios de aceptación
- [ ] Esperado se calcula desde movimientos.
- [ ] Diferencia visible.
- [ ] Reapertura controlada.

## Casos límite
- cambio de turno.
- caja multimoneda.
- retiro parcial.

## Dependencias
- POS
- Accounting
- Audit
