# Proveedores


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar proveedores, condiciones, retenciones, cuentas y documentos.

## Entidades
- `suppliers`
- `supplier_contacts`
- `supplier_bank_accounts`
- `supplier_tax_profiles`

## Reglas de negocio
- Cuenta bancaria requiere aprobación si se usa para pagos.
- Perfil tributario versionable.
- No eliminar con movimientos.

## Estados / transiciones
pending → active → blocked → inactive.

## Permisos
- compras mantiene datos.
- tesorería aprueba cuentas bancarias críticas.
- contador configura perfil tributario.

## API / eventos
- `POST /v1/suppliers`
- `GET /v1/suppliers/:id/statement`
- `supplier.bank_account_changed`

## Criterios de aceptación
- [ ] Cambio de cuenta bancaria queda auditado.
- [ ] CxP coincide con auxiliar.
- [ ] Retención usa perfil vigente a fecha.

## Casos límite
- proveedor extranjero.
- RIF duplicado.
- cambio cuenta antes de lote de pagos.

## Dependencias
- Purchases
- AP
- Retentions
