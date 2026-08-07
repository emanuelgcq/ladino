# E-commerce / pedidos remotos

## Alcance
Recibir pedidos externos por API/web.

## Regla fiscal
Pedido online no es por sí mismo factura. La emisión ocurre en fiscal service según medio y autorización aplicable.

## Idempotencia
`external_order_id + channel`.
