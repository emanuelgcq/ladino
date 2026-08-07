# Plan de cuentas


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Configurar estructura jerárquica de cuentas y mapeos operativos.

## Entidades
- `accounts`
- `account_groups`
- `accounting_mappings`

## Reglas de negocio
- Código único por empresa.
- Cuenta padre puede ser no-postable.
- Desactivar cuenta con saldo no borra histórico.
- Mapeo por evento/impuesto/product category.

## Estados / transiciones
draft→active→inactive.

## Permisos
- contador administra.
- usuarios operativos solo ven nombres necesarios.

## API / eventos
- `POST /v1/accounts`
- `POST /v1/account-mappings`

## Criterios de aceptación
- [ ] No ciclos jerárquicos.
- [ ] No post a cuenta no-postable.
- [ ] Importación valida duplicados.

## Casos límite
- renumeración.
- merge de cuentas.
- saldo apertura.

## Dependencias
- Accounting Engine
