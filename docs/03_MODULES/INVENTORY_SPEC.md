# Inventario


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Controlar cantidades, costos y trazabilidad por almacén.

## Entidades
- `stock_items`
- `inventory_moves`
- `stock_balances`
- `reservations`
- `counts`
- `transfers`
- `lots`
- `serials`

## Reglas de negocio
- Kardex append-only.
- Balance deriva/reconcilia movimientos.
- No stock negativo salvo política explícita.
- Transferencia usa salida+entrada vinculadas.
- Serial cantidad 1.

### Productos compuestos (I-04 · ADR-0035, ADR-0084)
- Un compuesto (`products.is_composed`) **no lleva existencia propia**: no tiene saldo ni
  movimientos (LAD43), ni lote ni vencimiento (`products_composed_chk`).
- **Venderlo saca sus ingredientes**, con la receta de ese momento (un nivel, sin anidar), en la
  misma salida en lote que las líneas sueltas. Cada salida va al costo promedio de su ingrediente y
  al céntimo; el costo de la línea es la SUMA de las salidas. Sin existencia de un ingrediente la
  venta se rechaza entera y dice cuál falta y de qué compuesto. Un compuesto sin ingredientes no se
  vende. Cotización y pedido no mueven nada.
- **`sale_line_components`** (append-only) guarda qué movimiento produjo cada línea: filas `out`
  al vender y `back` al devolver, con la cantidad de receta y el factor de unidad del momento. La
  receta puede cambiar; lo vendido no. La línea NO lleva `cost_snapshot`: quien lee costo suma la
  tabla.
- **Devolver** reingresa los ingredientes en proporción acumulada, al costo con que salieron y al
  mismo lote; devolver todo deja la venta en cero exacto. **Anular** repone todo; una venta con una
  devolución confirmada no se anula (se devuelve el resto).
- Invariante: `platform.composite_sale_gaps(empresa)` = 0 filas.
- **Pedido:** al confirmarlo, la línea de un compuesto NO reserva (no lleva existencia); la de sus
  ingredientes se comprueba al facturar. Una devolución en borrador no se confirma contra una
  venta anulada.
- Abierto: el consumo suelto de receta descuenta aparte de la venta (la pantalla lo avisa).

### Lote y vencimiento (C-07 · ADR-0060 §3)
- Un interruptor por producto enciende `tracks_lots` y `tracks_expiry` a la vez. **No se cambia
  con movimientos registrados**, ni para encender ni para apagar (LAD38).
- **Toda entrada pide el lote, y el lote nuevo su fecha**: llegada, recepción de compra y demás
  puertas pasan por `resolverLote`, que lo dice con el nombre del producto; debajo, el esquema no
  admite un lote sin fecha de un producto que vence, ni encender el vencimiento con lotes sin
  fecha (LAD73, migración 20261005130200).
- **La salida toma primero lo que vence antes** (FEFO, `allocate_lots_fefo`). «Vencido» es día
  contra día y **el día es el de Caracas**: un lote se vende durante todo el día en que vence, y
  desde el siguiente solo sale con `inventory.expired` (LAD46). Lo vencido no se vende: se da de
  baja con una salida con motivo.

## Estados / transiciones
movement immutable; count draft→counting→review→posted.

## Permisos
- almacén mueve/recibe.
- supervisor aprueba ajustes.
- auditor lee.

## API / eventos
- `POST /v1/inventory/transfers`
- `POST /v1/inventory/counts/:id/post`
- `inventory.moved`

## Criterios de aceptación
- [ ] Kardex reproduce balance.
- [ ] Concurrencia no sobrevende reservas.
- [ ] Costeo reproducible.

## Casos límite
- stock negativo.
- lote vencido.
- serial devuelto.
- conteo durante ventas.
- transferencia en tránsito.

## Dependencias
- Products
- Accounting
- Warehouses
