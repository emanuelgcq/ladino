# ADR-0062 — El dinero del negocio: la cuenta del cobro, las transferencias y el sobregiro

- **Estado**: aceptada (dueño, 2026-09-15: «arregla TODO … con la mejor práctica»)
- **Fecha**: 2026-09-16
- **Módulos**: tesorería · ventas (cobros, reembolsos) · compras (pagos) · contabilidad
- **Rigor**: máximo (dinero).
- **HOMOLOGATION_IMPACT**: NO. Ningún documento fiscal cambia; cambia a qué caja entra o de qué
  caja sale el dinero, y se agrega un movimiento no fiscal (la transferencia).

## Contexto — QA de pantalla 2026-09-15

1. **Hallazgo 15 (crítico).** Empezar obliga a crear cuentas («cada cobro va a caer en una de
   estas cuentas — por eso este paso no se puede saltar») pero la escalera de
   `resolverCuentaEfectivo` solo miraba las FORMAS DE PAGO. Sin formas, todo cobro caía en la
   cuenta de sistema «Sin asignar (VES/USD)» y «Caja del local» quedaba en cero.
2. **Hallazgo 24.** «Sin asignar — Por repartir» no tenía cómo repartirse: no existe transferencia
   entre cuentas, aunque `TREASURY_BANKING_SPEC.md` la exige («Transferencia intercuenta crea dos
   patas»).
3. **Hallazgo 27.** Una forma en dólares (Zelle) se podía apuntar a una cuenta en bolívares.
4. **Hallazgos 33, 50, 77.** Un reembolso, un gasto o un pago a proveedor dejaban la caja en
   negativo sin avisar. El pago simple a proveedor, sin forma configurada, sacaba el dinero de
   «Sin asignar» y la dejaba en −20 USD.

## Decisión

### 1. La escalera de la cuenta del cobro gana un peldaño

1. instrumento sin efectivo → sin cuenta (igual);
2. la forma de pago configurada para el instrumento, en la moneda del pago (igual);
3. **NUEVO — la cuenta propia de la familia del instrumento**, activa, no de sistema, en la moneda
   del pago, la más antigua:
   - efectivo (`efectivo_bs`, `efectivo_usd`) → solo cuentas **caja**;
   - lo digital (`pago_movil`, `transferencia`, `punto_venta`, `tarjeta`, `cashea`, `zelle`,
     `usdt`, `otro`) → **banco** o **billetera**, nunca una caja física;
4. «Sin asignar (moneda)» solo si no hay ninguna de la familia.

Un pago móvil nunca entra a la caja física aunque sea la única cuenta en bolívares: el cierre de
caja contaría billetes que no están. Para eso sigue «Sin asignar», que ahora sí se reparte (§3).

### 2. La forma de pago vive en la moneda de su cuenta

La moneda del instrumento la decide el servidor (`monedaDeInstrumento`): efectivo Bs, pago móvil,
transferencia, punto de venta y Cashea en la moneda funcional; efectivo USD, Zelle y USDT en USD;
tarjeta y «otro», en cualquiera. Crear o cambiar una forma contra una cuenta de otra moneda es 422.

### 3. Transferencia entre cuentas (migración 61)

`treasury_transfers`: una fila, dos patas sobre los saldos (−origen, +destino), MISMA moneda,
append-only (solo el backlink al asiento se escribe después), con motivo. El recómputo del saldo y
la cobertura contable la aprenden. Su asiento: `treasury_account` (destino) al debe y el papel
nuevo `treasury_account_from` (origen) al haber, ambos resueltos por la caja real del hecho. Si las
dos cajas mapean a la misma cuenta contable, el asiento se posta igual (débito y crédito en la
misma cuenta): el invariante «hecho de dinero ⇒ asiento o cola» vale sin excepción.

El cambio de moneda (dólares a bolívares) NO es una transferencia: tiene tasa y diferencial, y
queda fuera de esta decisión.

### 4. Sobregiro: se confirma, no se cuela

Un egreso (gasto, pago a proveedor, reembolso, transferencia) que deja la cuenta por debajo de
cero responde **409 `INSUFFICIENT_FUNDS`** con el saldo y lo que faltaría, salvo que el cuerpo
traiga `allow_negative_balance: true`. La pantalla pide la confirmación con el número delante.
No se prohíbe del todo porque una cuenta nace en cero y el dinero que ya existía no se ha cargado:
bloquear del todo impediría registrar el primer gasto.

## Consecuencias

- Los cobros sin forma configurada llegan a las cajas del dueño; «Sin asignar» se vuelve la
  excepción visible y repartible.
- El test `e2e-purchases` que esperaba «Sin asignar (USD)» en −116 cambia: ese pago ahora exige
  confirmar el sobregiro (lo manda el test explícitamente).
- VALIDAR-CONTADOR: el asiento de la transferencia entre dos cajas de la misma cuenta contable
  (débito y crédito iguales) es informativo; el contador puede preferir no verlo en el diario.
