# Punto de venta


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Venta rápida táctil para retail/restaurante manteniendo controles fiscales.

## Entidades
- `pos_sessions`
- `pos_sales`
- `cash_drawer_events`
- `pos_terminals`

## Reglas de negocio
- Caja debe abrir antes de vender.
- Operador asignado.
- Cierre compara esperado vs contado.
- Terminal fiscal debe cumplir política homologada.
- Modo offline solo según contingencia.

## Estados / transiciones
session: closed→open→closing→closed; sale: cart→payment→issuing→completed.

## Permisos
- cajero opera propia caja.
- supervisor override descuentos/anulaciones permitidas.
- auditor consulta.

## API / eventos
- `POST /v1/pos/sessions/open`
- `POST /v1/pos/checkout`
- `POST /v1/pos/sessions/close`
- `pos.variance_detected`

## Criterios de aceptación
- [ ] Checkout p95 aceptable.
- [ ] Retry no duplica factura.
- [ ] Diferencia de caja se registra, no se borra.

## Casos límite
- internet cae al cobrar.
- pago mixto.
- vuelto multimoneda.
- impresora/dispositivo falla.

## Dependencias
- Fiscal Contingency
- Pricing
- Inventory
- Cash
