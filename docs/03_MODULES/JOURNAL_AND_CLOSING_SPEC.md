# Diario, periodos y cierre


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Controlar posting, cierres mensuales/anuales y reaperturas auditadas.

## Entidades
- `accounting_periods`
- `closing_checklists`
- `closing_entries`

## Reglas de negocio
- No post en periodo cerrado.
- Reapertura requiere permiso/motivo.
- Cierre verifica subledgers.
- Asientos cierre son trazables.

## Estados / transiciones
period open→soft_closed→closed→reopened.

## Permisos
- contador cierra.
- CFO/aprobador reabre.
- auditor solo lee.

## API / eventos
- `POST /v1/periods/:id/close`
- `POST /v1/periods/:id/reopen`
- `period.closed`

## Criterios de aceptación
- [ ] No cerrar con documentos pendientes configurados.
- [ ] Reapertura queda auditada.
- [ ] Balance sigue cuadrado.

## Casos límite
- backdated transaction.
- cierre anual.
- ajuste auditor.

## Implementación vigente (ADR-0069, migración 20260928130000)

- **Historia de períodos:** `fiscal_period_events` (append-only, con ancla): un evento `closed` o
  `reopened` por cada cambio de estado, con motivo (≥ 10 caracteres al reabrir), autor e instante.
  Lo escribe un trigger del esquema (`fiscal_periods_10_history`), no el caso de uso. La fila de
  `fiscal_periods` guarda el estado actual y los últimos datos: cerrar → reabrir → cerrar, n veces.
- **Período de cierre («13»):** `month = 13`, `kind = 'closing'`, fechado el 31-12. Solo admite el
  asiento `year_end_close` y ajustes `manual` del contador (`closing_period: true` al crear el
  asiento). El cierre del ejercicio postea ahí aunque diciembre esté cerrado, pasa por «Resultado
  del ejercicio» (`year_result`: entra y sale el resultado) hacia «Utilidades o pérdidas
  acumuladas» (`retained_earnings`), y deja el 13 cerrado. Reabrir el ejercicio = reabrir el 13.
  Antes de cerrar, nombra los borradores del ejercicio y exige la cola vacía. **Reabrir el 13
  revierte su asiento de cierre** (contra-asiento en el 13, autorizado por el permiso de reabrir,
  con el motivo en su acta): los resultados vuelven a tener saldo para los ajustes y el ejercicio se
  cierra otra vez.
- **Fechas:** `companies.activity_start_date` (por omisión, el día del alta en Caracas; se pide en
  el registro y se corrige en Mi empresa, con acta, nunca futura ni posterior al primer asiento). `period_for_date` rechaza (LAD91, 422) fechas anteriores a ella o posteriores al
  período en curso, exista o no el período. Todas las comparaciones son `date` contra `date`.
- **Borradores:** no se crean en un período cerrado (LAD61, 409 con la salida). Se **descartan**
  (`POST /v1/journal-entries/:id/discard`, permiso `accounting.entry.create`): pasan a
  `discarded` con rastro en `audit_events` (`journal.discarded`). Un posteado no se descarta nunca.
- **Factura de proveedor tardía (K-04):** si la fecha de la factura, la NC, el landed cost, la
  recepción, el pago a proveedor o el gasto de tesorería cae en un período cerrado, o antes del
  inicio de actividades, `platform.accounting_date_for` registra su asiento HOY (día de Caracas,
  período en curso). La factura y la NC guardan esa fecha en `accounting_date` (y la devuelven al
  registrarse, para que la web avise). Los demás no tienen esa columna: conservan su propia fecha
  (`incurred_on`, `received_at`, `paid_at`), y la fecha contable es la del asiento. El impuesto y la
  tasa siguen siendo los de la fecha del documento. El asiento, el libro de
  compras (`booked_on`, `received_late`) y la planilla de IVA la toman en el período de registro
  (migración 20260928130100, sobre la versión final de 20260928120000). Libro y mayor cuadran en
  los dos períodos. La ventana legal para deducir el crédito (LIVA, «doce períodos») **no se
  aplica**: está pendiente de fuente (P-35).

## Revaluación al cierre (ADR-0075 §6, migración 20261003180000)

Cerrar un período mensual asienta primero la revaluación de las partidas monetarias en divisa a la
tasa BCV del último día del período (VEN-NIF PYME secc. 30): cada caja en divisa, y las cuentas por
cobrar y por pagar en divisa por moneda. `platform.fx_revaluation_items(empresa, fecha)` dice qué
lleva el mayor, qué debe llevar y el ajuste; `closeFiscalPeriod` escribe un asiento `exchange_diff`
/ `fx.revaluation_at_close` fechado ese día, contra los papeles `exchange_gain` y `exchange_loss`, y
deja el acta `accounting.fx_revalued_at_close`. No guarda estado: cerrar otra vez el mismo período
ajusta solo la diferencia. Sin diferencias no hay asiento. Sin tasa a esa fecha, o sin esas cuentas,
el período no se cierra y el mensaje dice qué falta. El período de cierre del ejercicio no revalúa.
El método queda en PENDIENTES_ASESOR P-86.

## Dependencias
- Accounting
- AR/AP
- Inventory
