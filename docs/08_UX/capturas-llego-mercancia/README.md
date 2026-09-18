# Llegó mercancía — capturas del recorrido

Tomadas con Playwright contra el stack local (ADR-0066, 2026-09-18). El guion recorre los caminos
y asevera lo que la persona ve; las capturas son el rastro, no la prueba — la prueba es
`apps/api/test/e2e-llegada.test.ts` y los QA de navegador que las generaron:

| Entrega | Comprobaciones | Hallazgos |
|---|---|---|
| (i) la puerta única | 16 | 0 |
| (ii) el dinero se escribe una vez | 15 | 0 |
| (iii) del pedido a la llegada | 26 | 0 |
| (iii) el paso 0 de la puerta | 8 | 0 |
| textos nuevos y «¿Con qué la pagaste?» | 16 | 0 |

Los tres últimos comprueban además la PROPAGACIÓN contra la base, no contra la pantalla: kardex,
mayor, libro de compras, deuda con el proveedor y los invariantes que cruzan módulos.

| Captura | Qué enseña |
|---|---|
| `1-de-quien-vino.png` | La primera pregunta: de quién vino, en dos tarjetas |
| `2-que-llego.png` | Qué llegó: producto, cantidad, costo por unidad o total, moneda y día |
| `3-confirmar-aporte.png` | La consecuencia en lenguaje de persona, antes de escribir nada |
| `4-listo-aporte.png` | «Listo», con los enlaces a lo que tengo y a lo que debo |
| `5-tienes-la-factura.png` | Las tres respuestas sobre la factura |
| `6-listo-recepcion.png` | La recepción sin factura, registrada |
| `7-falta-la-factura.png` | La pestaña nueva de «Compras y gastos», con su antigüedad |
| `8-inventario-sin-entrada.png` | Administración → Inventario ya no mete mercancía |
| `9-viene-de-un-pedido.png` | El paso 0: los pedidos que esperan, y la salida para lo que llegó sin pedido |
| `10-hacer-un-pedido.png` | «Hacer un pedido», el único formulario de compras que sigue pidiendo precios |
| `11-por-recibir.png` | La bandeja «Por recibir» en el mostrador, con sus dos verbos |
| `12-recepcion-a-ciegas.png` | La puerta abierta desde un pedido: se cuenta, no se valora |
| `13-no-va-a-llegar.png` | Cerrar un pedido exige decir por qué; sin motivo el botón está apagado |
| `14-costo-en-dolares.png` | Los dos campos de importe, con la tasa que convierte y una sola frase de ayuda |
| `15-con-que-la-pagaste.png` | Con qué se le pagó al proveedor: las nueve formas, con la tabla de formas configuradas VACÍA |
