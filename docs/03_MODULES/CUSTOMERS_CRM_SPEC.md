# Clientes y CRM


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar clientes, crédito, contactos, historial y datos fiscales.

## Entidades
- `customers`
- `customer_contacts`
- `customer_addresses`
- `credit_profiles`
- `customer_tags`

## Reglas de negocio
- Snapshot fiscal al facturar.
- Límite de crédito evaluado antes de venta a crédito.
- Cliente puede tener múltiples contactos/direcciones.

## Estados / transiciones
lead → active → blocked → inactive.

## Permisos
- ventas crea/edita.
- cobranzas modifica crédito con permiso.
- auditor solo lee.

## API / eventos
- `POST /v1/customers`
- `GET /v1/customers/:id/statement`
- `customer.credit_changed`

## Criterios de aceptación
- [ ] Bloqueo impide crédito pero no consulta.
- [ ] Estado de cuenta concilia con AR ledger.
- [ ] Cambios de RIF quedan auditados.

## Casos límite
- cliente sin RIF persona natural según caso.
- duplicado por RIF.
- cliente con saldo al desactivar.

## Dependencias
- Sales
- AR
- Fiscal
