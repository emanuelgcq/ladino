# Empresas, sucursales, almacenes y cajas


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Modelar la estructura legal y operativa multiempresa.

## Entidades
- `tenants`
- `companies`
- `branches`
- `warehouses`
- `cash_registers`
- `fiscal_series`

## Reglas de negocio
- Una empresa representa una entidad/RIF.
- Toda transacción pertenece a company.
- Series fiscales se separan por criterio autorizado.
- Almacén puede pertenecer a sucursal.

## Estados / transiciones
company: onboarding → active → suspended. branch/warehouse/register: active/inactive.

## Permisos
- tenant_owner administra empresas.
- company_admin administra estructura.
- cajero solo opera cajas asignadas.

## API / eventos
- `POST /v1/companies`
- `POST /v1/branches`
- `POST /v1/warehouses`
- `POST /v1/cash-registers`

## Criterios de aceptación
- [ ] Aislamiento entre empresas probado.
- [ ] No mover documento histórico a otra empresa.
- [ ] Caja solo usa serie autorizada.

## Casos límite
- fusión de sucursales.
- cambio domicilio fiscal.
- caja cerrada con operaciones pendientes.

## Dependencias
- Multitenancy
- Fiscal Documents
