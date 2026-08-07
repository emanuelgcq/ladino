# Gestión humana


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Administrar expediente del trabajador y procesos básicos de RRHH.

## Entidades
- `employees`
- `employment_contracts`
- `leave_requests`
- `incidents`
- `documents`

## Reglas de negocio
- PII acceso restringido.
- Documentos sensibles cifrados/controlados.
- Cambios contractuales versionados.

## Estados / transiciones
employee candidate→active→suspended→terminated.

## Permisos
- RRHH administra.
- manager ve equipo mínimo.
- auditor según autorización.

## API / eventos
- `POST /v1/hr/employees`
- `POST /v1/hr/leave`

## Criterios de aceptación
- [ ] Terminación no borra nómina histórica.
- [ ] Permisos protegen PII.

## Casos límite
- rehire.
- doble contrato.
- cambio salario.

## Dependencias
- Payroll
- Privacy
