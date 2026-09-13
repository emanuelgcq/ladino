# ADR-0059 — La caja cobra con el IGTF dentro de lo recibido

- **Estado**: aceptada (orden del dueño, 2026-09-13: «piensa en una caja diaria y todo lo que
  puede suceder»)
- **Fecha**: 2026-09-13
- **Módulos**: ventas (POS, cobro) · IGTF · tesorería (saldo de caja)
- **HOMOLOGATION_IMPACT**: NO. No cambia qué se emite ni la regla del IGTF (3 % por pago en
  divisa, ADR-0052/0053); cambia cómo la caja interpreta lo que teclea la cajera y adónde va el
  dinero percibido.

## Contexto

QA con la cuenta del dueño en producción, 2026-09-13. Una venta de Bs. 18.884,80 cobrada en
dólares fue rechazada con «Una venta de mostrador se cobra completa». Al revisar la caja
entera aparecieron cinco defectos que se refuerzan entre sí:

1. **Con la lista en bolívares, elegir una forma en USD dejaba el monto vacío.** La cajera lo
   escribía a mano, redondeaba a la baja (22,68 por 22,6848) y quedaba saldo: rechazo.
2. **El IGTF no estaba dentro de lo recibido.** El monto tecleado se tomaba entero como pago
   de la venta y el IGTF se cobraba ENCIMA. Si el cliente entregaba 23,37 USD por una cuenta de
   22,69 más 0,68 de IGTF, Zelle se rechazaba por exceso y el efectivo devolvía el IGTF como
   vuelto.
3. **El IGTF cobrado no entraba al saldo de la caja.** El saldo de una cuenta solo sumaba
   cobros, pagos, gastos y cierres; la percepción quedaba fuera. Al cierre, la caja «esperaba»
   menos de lo contado, siempre.
4. **Vuelto e IGTF se calculaban en dos llamadas que no se conocían** (`/v1/pos/change`,
   `/v1/pos/igtf`), con redondeos distintos, y ninguna decía cuánto faltaba.
5. Dos formas de pago como máximo, sin resumen «recibido / falta / vuelto», y un diálogo que
   se salía de la pantalla.

## Decisión

**Lo que teclea la cajera es lo ENTREGADO por el cliente, y un solo cálculo del servidor decide
qué parte es de la venta, qué parte es IGTF y qué parte es vuelto.**

`pasoDeCobro` (dominio de ventas) aplica UN pago a lo pendiente:

1. **Lo necesario para cerrar** = pendiente en la moneda del pago + su IGTF (ADR-0053, a las
   minor units de la moneda).
2. **Si lo entregado llega a lo necesario, con tolerancia de una unidad mínima** (menos de un
   céntimo por debajo también cierra: no existe moneda de medio céntimo), la venta queda
   pagada. Lo que sobra es **vuelto, solo en efectivo, redondeado hacia abajo**: la caja jamás
   devuelve más de lo que recibió. Con una forma que no da vuelto, sobrar un céntimo o más es
   un error que dice cuánto hacía falta, IGTF incluido.
3. **Si no llega, abona**: lo entregado se reparte en base + IGTF de modo que base + IGTF(base)
   = entregado.
4. Las formas se aplican **en orden**; el IGTF se calcula por forma (H-7): en un pago mixto Bs +
   USD solo la parte en divisa lo causa.

La **vista previa** (`POST /v1/pos/tender`, sin escribir) y la **venta** (`POST /v1/pos/sales`)
llaman a la misma función. La vista previa además devuelve, para cada forma que la caja
ofrece, **cuánto pedir para cerrar** lo que falta, IGTF incluido, redondeado al céntimo.

**El IGTF percibido entra a la caja de su pago** (migración 53): trigger en
`igtf_perceptions`, recómputo con la quinta fuente, redistribución del pago que mueve también
su IGTF, y backfill con una guarda que falla si un cierre de caja ya lo hubiera contado como
diferencia (hoy, cero cierres en producción).

**Hasta cuatro formas de pago** por venta.

## Lo que no cambia

- La regla del IGTF, su redondeo y su asiento (ADR-0052, ADR-0053).
- La «regla del último centavo» de `registerPayment` (R-02): un residuo menor a medio céntimo
  marca la factura pagada y queda en libros para el asesor. La pantalla de venta decide
  «fiada» por el ESTADO de la factura, no por ese residuo.
- `/v1/pos/change` y `/v1/pos/igtf` siguen existiendo para clientes anteriores; el POS ya no los
  usa.

## Pendiente

- **El vuelto en otra moneda** (paga 20 USD, recibe el vuelto en bolívares) no está soportado:
  exige un movimiento de caja entre dos cuentas y su asiento. **VALIDAR-OPERACIÓN**.
- **La diferencia de redondeo de caja** (spec §6.4): el residuo menor a un céntimo que deja el
  vuelto hacia abajo o la tolerancia se acumula en la caja sin asiento propio.
  **VALIDAR-CONTABLE**, igual que en ADR-0058.

## Consecuencias

- E2E: nueve escenarios de caja (sugerencia con IGTF, 50 USD con vuelto 20,13, saldo de caja
  +29,87, Zelle exacto y de más, tolerancia de medio céntimo, mixto Bs + USD, sugerencia del
  resto, abono parcial en divisa, cuatro formas).
- pgTAP 053: saldo materializado = recómputo con IGTF, redistribución, moneda incoherente.
- Al desplegar, las cuentas con percepciones históricas suben su saldo en el IGTF cobrado
  (en producción: Caja USD +92,20, Zelle +145,74, Sin asignar +0,27 USD).
