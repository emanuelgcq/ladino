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
- **Cada cuenta de tesorería tiene su subcuenta contable propia** (ADR-0070, 2026-09-28). Nace con
  la cuenta —la cree quien la cree—, hija de la cuenta de su familia y moneda (la del papel
  `cash_bs` si está en la moneda funcional, `cash_usd` si no: 1.1.01 / 1.1.02 en `ve_basico`), con
  el nombre de la cuenta. Cobro, pago, gasto, cierre, reembolso, IGTF y transferencia asientan en
  la subcuenta de la cuenta que eligió la persona. La cuenta de familia agrupa y no recibe
  asientos (LAD62). Un mapeo explícito (`ledger_account_id` en el alta) se respeta.
- **Las empresas que ya existían se reparan** con `platform.treasury_subaccounts_repair_prepare`
  → posteo en el dominio (`repairTreasurySubaccounts`) → `…_finish`, lanzado por
  `node scripts/reparar/adr-0070-subcuentas.mjs`: una subcuenta por cuenta y UN asiento de
  reclasificación por empresa, fechado el día de Caracas en que corre, por el saldo que la
  tesorería atribuye a cada cuenta; lo que ninguna explica va a «Por conciliar (reparación
  ADR-0070)». Idempotente, con acta en `audit_events`. No repara con el período del día cerrado ni
  con hechos en la cola (lo deja escrito). Mientras una empresa no esté reparada, sus cuentas
  nuevas siguen mapeándose a la familia.
- **Invariante tesorería ↔ mayor** (`platform.treasury_ledger_gaps(company)`, 0 filas): toda cuenta
  de una empresa con plan de cuentas —«Sin asignar» incluida— tiene subcuenta propia y hoja; en
  moneda funcional, su saldo es el de su subcuenta. La igualdad en moneda original de las cuentas
  en divisa llega con J-04 (E-11).

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
