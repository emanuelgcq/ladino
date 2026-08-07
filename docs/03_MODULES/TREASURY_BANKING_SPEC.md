# Tesorería y bancos


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Gestionar cuentas bancarias, movimientos, pagos, cobros y conciliación.

## Entidades
- `bank_accounts`
- `bank_transactions`
- `payment_batches`
- `reconciliations`
- `transfers`

## Reglas de negocio
- Movimiento bancario importado no se contabiliza dos veces.
- Conciliación separa suggested/matched/confirmed.
- Transferencia intercuenta crea dos patas.
- Cuenta bancaria sensible requiere permisos.

## Estados / transiciones
txn imported→matched→reconciled; batch draft→approved→sent→settled.

## Permisos
- tesorería crea.
- aprobador confirma lotes.
- contador reconcilia.

## API / eventos
- `POST /v1/banks/import`
- `POST /v1/reconciliations/match`
- `POST /v1/payment-batches`

## Criterios de aceptación
- [ ] No duplicar CSV importado.
- [ ] Conciliación cuadra saldo.
- [ ] Doble aprobación configurable.

## Casos límite
- reverso bancario.
- fecha valor distinta.
- comisión bancaria.
- moneda extranjera.

## Dependencias
- Accounting
- AP/AR
- Money
