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
