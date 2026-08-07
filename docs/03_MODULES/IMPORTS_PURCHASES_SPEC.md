# Compras de importación


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar costos adicionales y landed cost de mercancía importada.

## Entidades
- `import_shipments`
- `import_costs`
- `landed_cost_allocations`

## Reglas de negocio
- Costos distribuibles por valor/peso/cantidad/regla.
- Asignación congelada al postear.
- No mezclar impuestos recuperables con costo sin política contable.

## Estados / transiciones
open→received→costed→closed.

## Permisos
- compras registra.
- contador aprueba costeo.

## API / eventos
- `POST /v1/imports/:id/allocate-costs`

## Criterios de aceptación
- [ ] Suma asignada=costo adicional.
- [ ] Kardex/costo actualizado trazable.

## Casos límite
- mercancía parcial.
- flete en divisa.
- costos posteriores.

## Dependencias
- Inventory
- Accounting
- Purchases
