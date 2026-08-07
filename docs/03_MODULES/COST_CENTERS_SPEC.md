# Centros de costo


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Distribuir ingresos/gastos por unidades analíticas.

## Entidades
- `cost_centers`
- `allocation_rules`
- `journal_line_dimensions`

## Reglas de negocio
- Dimensiones no alteran balance contable.
- Asignación puede ser obligatoria por cuenta.
- Reglas versionadas.

## Estados / transiciones
active/inactive.

## Permisos
- contador configura.
- operadores usan centros permitidos.

## API / eventos
- `POST /v1/cost-centers`
- `POST /v1/allocations`

## Criterios de aceptación
- [ ] 100% distribución cuando sea requerida.
- [ ] Reporte concilia con mayor.

## Casos límite
- split porcentual.
- centro cerrado.
- multi-sucursal.

## Dependencias
- Accounting
