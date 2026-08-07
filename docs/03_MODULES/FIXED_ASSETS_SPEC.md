# Activos fijos


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Registrar ciclo de vida, depreciación y disposición.

## Entidades
- `fixed_assets`
- `asset_categories`
- `depreciation_books`
- `depreciation_runs`

## Reglas de negocio
- Costo y fecha capitalización.
- Método/vida útil configurable.
- Depreciación posted mediante asiento.
- Disposición genera baja y resultado.

## Estados / transiciones
draft→in_service→suspended→disposed.

## Permisos
- activos administra ficha.
- contador aprueba depreciación/baja.

## API / eventos
- `POST /v1/assets`
- `POST /v1/depreciation-runs`
- `asset.depreciated`

## Criterios de aceptación
- [ ] No depreciar después de baja.
- [ ] Run idempotente.
- [ ] Conciliación libro activos vs GL.

## Casos límite
- mejoras.
- venta parcial.
- cambio vida útil prospectivo.

## Dependencias
- Accounting
- Inflation
