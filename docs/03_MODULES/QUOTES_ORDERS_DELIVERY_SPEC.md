# Cotizaciones, pedidos y despacho


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar preventa, compromisos, reservas y entregas parciales.

## Entidades
- `quotes`
- `sales_orders`
- `shipments`
- `delivery_notes`
- `backorders`

## Reglas de negocio
- Cotización no afecta contabilidad.
- Pedido puede reservar stock.
- Despacho afecta stock según política.
- Entrega parcial mantiene saldo pendiente.

## Estados / transiciones
quote draft→sent→accepted/rejected/expired; order confirmed→partial→fulfilled.

## Permisos
- ventas gestiona quote/order.
- almacén confirma despacho.

## API / eventos
- `POST /v1/quotes/:id/convert`
- `POST /v1/orders/:id/ship`
- `shipment.created`

## Criterios de aceptación
- [ ] Backorder exacto.
- [ ] No despachar más de confirmado sin permiso.
- [ ] Trazabilidad lote/serial.

## Casos límite
- split shipment.
- drop shipment.
- cancelación tras reserva.

## Dependencias
- Inventory
- Sales
- Fiscal Documents
