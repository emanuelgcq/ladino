# ADR-0070 — Cada cuenta de tesorería tiene su subcuenta contable

- **Estado:** ADR aplicado según la respuesta del dueño del 2026-09-28 (listado en el mensaje de apertura de la ola 1; J-01 y §2.7)
- **Fecha:** 2026-09-28
- **Impacto fiscal:** NO.
- **Hallazgos:** J-01 (y la base del invariante tesorería ↔ mayor de J-04).

## Contexto

«Mover plata» entre dos cuentas de la misma moneda falla siempre con un 500 (J-01): «ON CONFLICT DO
UPDATE command cannot affect row a second time». Todas las cuentas de tesorería en bolívares
comparten la cuenta contable 1.1.01, así que el asiento de la transferencia tiene dos líneas sobre
la misma cuenta. `apply_ledger_balance` hace un upsert por línea y choca consigo mismo. El E2E de la
transferencia pasa porque usa dos cuentas de monedas distintas.

Aunque no chocara, un traspaso entre dos cuentas que comparten cuenta contable no mueve nada en el
mayor: el mayor no puede decir cuánto hay en Banesco y cuánto en Mercantil.

## Opciones consideradas

1. **Solo agrupar por cuenta en `apply_ledger_balance`.** Cierra el 500, pero el mayor sigue sin
   distinguir cuentas: la transferencia deja dos líneas que se anulan.
2. **Subcuenta contable propia por cuenta de tesorería y, además, agrupar.** Es la opción elegida
   por el dueño.

## Decisión

1. **Cada cuenta de tesorería nace con su subcuenta contable propia**, hija de la cuenta de su
   familia y moneda (1.1.01 bolívares, 1.1.02 divisas), con el nombre de la cuenta. El cobro, el
   pago, el gasto, el cierre de caja y la transferencia asientan en la subcuenta de la cuenta que
   eligió la persona (ADR-0067).
2. **`apply_ledger_balance` agrupa por cuenta** antes del upsert. Un asiento con dos líneas sobre la
   misma cuenta es legítimo (reclasificaciones, ajustes) y no debe romper nunca.
3. **Las cuentas existentes se reparan por migración, con acta.** Se crea la subcuenta de cada una y
   su saldo se reclasifica con un **asiento de reclasificación** por empresa, fechado el día de la
   reparación: de la cuenta de familia a cada subcuenta, por el saldo que la tesorería atribuye a esa
   cuenta. Nada se actualiza sobre `journal_lines` (append-only). Es idempotente: una cuenta que ya
   tiene subcuenta no se toca.
   **Cómo corre (2026-09-28):** la migración trae las funciones `treasury_subaccounts_repair_prepare`
   y `_finish`. El asiento de reclasificación lo postea el dominio (`repairTreasurySubaccounts`,
   `packages/domain/src/treasury.ts`), porque ninguna función SQL de Ladino postea asientos y el
   guardián de inmutabilidad bloquea el paso draft → posted dentro de una migración. La corre
   `scripts/reparar/adr-0070-subcuentas.mjs`, empresa por empresa, **después** del `git pull` que sube
   la API nueva (respuesta del dueño, §7).
4. **Invariante nuevo** (se completa en la ola de moneda, J-04): el saldo de cada cuenta de tesorería
   es igual al de su subcuenta contable, por moneda.

## Consecuencias

- **Positivas.**
  - La transferencia funciona y se ve en el mayor.
  - La conciliación bancaria sale por cuenta.
  - El invariante tesorería ↔ mayor se puede enunciar sin excepciones.
- **Negativas.**
  - El plan de cuentas crece una línea por cuenta de tesorería.
  - Las plantillas contables que apuntaban a la cuenta de familia pasan a resolver la subcuenta en
    tiempo de asiento.
  - La reparación añade un asiento de reclasificación al diario de cada empresa con más de una
    cuenta.
- **Para revertir:** las subcuentas se pueden dejar sin uso. Los asientos quedan, y el saldo de la
  familia es la suma de sus hijas.

## Verificación

- E2E: una transferencia entre dos cuentas en bolívares da 201 y mueve las dos subcuentas.
- pgTAP: un asiento con dos líneas sobre la misma cuenta actualiza `ledger_balances` sin error.
- `pnpm recorrido J`: J-01 deja de reproducir.
