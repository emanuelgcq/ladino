# Nómina


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Calcular nómina y obligaciones laborales con reglas versionadas.

## Entidades
- `employees`
- `contracts`
- `payroll_concepts`
- `payroll_runs`
- `payroll_items`
- `loans`
- `vacations`

## Reglas de negocio
- Conceptos parametrizados.
- Run aprobado se congela.
- Pago y posting separados.
- Obligaciones legales no hard-coded sin fuente.

## Estados / transiciones
run draft→calculated→reviewed→approved→paid→posted.

## Permisos
- RRHH prepara.
- nómina revisa.
- aprobador aprueba.
- tesorería paga.

## API / eventos
- `POST /v1/payroll/runs`
- `POST /v1/payroll/runs/:id/calculate`
- `payroll.approved`

## Criterios de aceptación
- [ ] Recalcular draft es determinista.
- [ ] Aprobado no cambia.
- [ ] Retroactivos separados.

## Casos límite
- vacaciones.
- utilidades.
- reposo.
- préstamo.
- multimoneda.

## Dependencias
- VALIDAR-LABORAL
- Treasury
- Accounting
