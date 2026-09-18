# Llegó mercancía — capturas del recorrido

Tomadas con Playwright contra el stack local (ADR-0066, entrega i, 2026-09-18). El guion recorre
los caminos y asevera lo que la persona ve; las capturas son el rastro, no la prueba — la prueba
es `apps/api/test/e2e-llegada.test.ts` y el QA de navegador que las generó (16 comprobaciones,
cero hallazgos).

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
