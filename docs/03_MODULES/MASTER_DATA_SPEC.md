# Maestros y datos base


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Centralizar catálogos reutilizados por todos los módulos.

## Entidades
- `tax_identifiers`
- `addresses`
- `units`
- `currencies`
- `exchange_rate_sources`
- `payment_methods`
- `document_types`
- `salespersons`
- `carriers`

## Reglas de negocio
- Todos los maestros tienen tenant/company scope explícito.
- Campos fiscales relevantes se versionan o snapshottean al emitir.
- No eliminar maestro referenciado; desactivar.

## Estados / transiciones
active ↔ inactive. Los maestros fiscales versionados usan draft → approved → retired.

## Permisos
- admin configura.
- usuarios operativos solo consultan los maestros necesarios.

## API / eventos
- `GET /v1/master-data/:type`
- `POST /v1/master-data/:type`
- `master_data.updated`

## Criterios de aceptación
- [ ] No se puede borrar una moneda usada.
- [ ] RIF se valida sintácticamente y unicidad se configura por ámbito.
- [ ] Desactivar no rompe documentos históricos.

## Casos límite
- Cambio de nombre legal después de facturar.
- duplicados importados.
- unidad desactivada con stock.

## Dependencias
- RBAC
- Audit
- Tax Engine
