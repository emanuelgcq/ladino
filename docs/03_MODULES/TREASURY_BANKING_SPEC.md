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

## El gasto que se repite (H-07, migración 20261005140000)

Un gasto marcado «se repite» deja un RECORDATORIO por categoría (`recurring_expenses`): qué se paga, cada cuánto (semana, quincena, mes, año) y desde qué día. **Toca** cuando su próximo día (`next_due_on`) es hoy o anterior, comparando el día calendario de Caracas contra un día, sin horas; se calcula al leer, no hay tarea programada. Cada ocurrencia sale del día del primer pago: un gasto del 31 toca el último día de un mes corto y vuelve al 31. El aviso se enseña en Inicio y en Compras → Gastos a quien tiene `expense.read`.

**«Registrar ahora»** abre el formulario de gasto de siempre con la categoría (fija), la cuenta y el importe de la última vez como sugerencia, y registra por `POST /v1/expenses` —con factura fiscal o sin ella, con sus validaciones de período, tasa, saldo y retención—. El período queda atendido (`recurring_expense_periods`, append-only) y el aviso pasa al siguiente. Un período se atiende una sola vez: el segundo intento recibe 409 y no registra otro gasto.

**Lo que NO hace:** no registra dinero solo, no avisa antes del día, no se edita (se detiene y se vuelve a marcar), y un gasto registrado a mano de esa categoría no atiende su período. «Omitir esta vez» y «Ya no se paga» no se deshacen.
