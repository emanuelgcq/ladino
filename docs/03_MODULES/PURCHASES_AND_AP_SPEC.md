# Compras y cuentas por pagar


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar procure-to-pay desde requisición hasta pago.

## Entidades
- `purchase_requisitions`
- `purchase_orders`
- `receipts`
- `supplier_invoices`
- `payables`
- `payment_applications`

## Reglas de negocio
- Recepción aumenta stock sin necesidad de factura inmediata.
- Factura crea CxP.
- 3-way match configurable.
- Pago crea aplicación y asiento.

## Estados / transiciones
PO draft→approved→sent→partial→closed; AP open→partial→paid.

## Permisos
- solicitante crea requisición.
- comprador aprueba según límites.
- almacén recibe.
- tesorería paga.

## API / eventos
- `POST /v1/purchase-orders`
- `POST /v1/receipts`
- `POST /v1/supplier-invoices`
- `ap.invoice_posted`

## Criterios de aceptación
- [ ] Recepción parcial/backorder.
- [ ] No pagar factura bloqueada.
- [ ] Retenciones se calculan por regla.

## Casos límite
- factura sin PO.
- diferencia de cantidad/precio.
- importación.
- anticipo a proveedor.

## Dependencias
- Inventory
- Retentions
- Accounting
- Treasury
