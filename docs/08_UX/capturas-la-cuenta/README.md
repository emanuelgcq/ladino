# La cuenta se pregunta — capturas del recorrido

Tomadas con Playwright contra el stack local (ADR-0067, 2026-09-20), sobre la empresa de la
demostración, que arranca **sin una sola cuenta propia** — exactamente como las ocho de producción.
Las capturas son el rastro, no la prueba: la prueba son `e2e-treasury`, `073_money_landed…` y el
guion `24-cuenta` que las generó (**13 comprobaciones, 0 hallazgos**).

| Captura | Qué enseña |
|---|---|
| `1-de-que-cuenta-salio.png` | Con dos bancos, la puerta pregunta — y «Seguir» no se enciende hasta elegir |
| `2-sin-cuenta-de-esa-familia.png` | Sin cuenta de ese tipo no se pregunta: se avisa de que caerá en «Sin asignar» |
| `3-el-pos-abre-el-boton.png` | El mostrador no pregunta dos veces: un botón por cuenta |
| `4-donde-cayo-el-dinero.png` | «Mi dinero» enseña lo que cayó donde nadie eligió, con su cuenta |
