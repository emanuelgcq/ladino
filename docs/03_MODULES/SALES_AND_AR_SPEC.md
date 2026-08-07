# Ventas y cuentas por cobrar


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Controlar ciclo de venta y cartera con impacto de inventario/contabilidad/fiscal.

## Entidades
- `sales_orders`
- `invoices`
- `invoice_lines`
- `receivables`
- `collections`
- `applications`

## Reglas de negocio
- Factura emitida crea CxC si queda saldo.
- Pago no modifica factura; crea aplicación.
- Estado de cuenta deriva de ledger.
- Venta fiscal usa fiscal service.

## Estados / transiciones
order: draft→confirmed→partially_fulfilled→fulfilled/cancelled. AR: open→partial→paid/overdue/written_off.

## Permisos
- ventas crea pedidos.
- cajero factura según permisos.
- cobranzas aplica pagos.
- contador autoriza write-off.

## API / eventos
- `POST /v1/sales-orders`
- `POST /v1/invoices`
- `POST /v1/ar/applications`
- `invoice.issued`
- `ar.payment_applied`

## Criterios de aceptación
- [ ] Pago parcial correcto.
- [ ] Anticipo aplicable.
- [ ] Factura genera posting balanceado.
- [ ] No duplicar factura por retry.

## Casos límite
- sobrepago.
- devolución.
- crédito excedido.
- cliente bloqueado.
- pago en divisa.

## Dependencias
- Inventory
- Fiscal
- Accounting
- Treasury
