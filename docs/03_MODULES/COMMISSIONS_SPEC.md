# Comisiones


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Calcular comisiones de vendedores según reglas transparentes.

## Entidades
- `commission_plans`
- `commission_rules`
- `commission_accruals`

## Reglas de negocio
- Regla versionada.
- Base puede ser facturado/cobrado según plan.
- NC/devolución ajusta devengo.

## Estados / transiciones
accrued→approved→paid.

## Permisos
- ventas consulta.
- manager configura.
- nómina/tesorería paga.

## API / eventos
- `POST /v1/commissions/calculate`
- `commission.accrued`

## Criterios de aceptación
- [ ] Reproducible por periodo.
- [ ] No doble pago.

## Casos límite
- pago parcial.
- devolución posterior.
- cambio plan.

## Dependencias
- Sales
- Payroll/Treasury
