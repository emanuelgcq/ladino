# Reportes y analítica


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Proveer reporting operativo, financiero y gerencial reproducible.

## Entidades
- `report_definitions`
- `report_runs`
- `dashboard_widgets`

## Reglas de negocio
- Reportes financieros salen del ledger.
- Fiscal usa snapshots fiscales.
- Permisos aplican a filas y columnas sensibles.
- Exportación grande asíncrona.

## Estados / transiciones
run queued→running→completed/failed.

## Permisos
- según rol.
- export financiero requiere permiso.

## API / eventos
- `POST /v1/reports/:id/run`
- `GET /v1/report-runs/:id`

## Criterios de aceptación
- [ ] Mismo corte produce mismo resultado.
- [ ] Excel/PDF coincide con pantalla.

## Casos límite
- millones de líneas.
- timezone.
- periodo cerrado.

## Dependencias
- All modules
- Storage
