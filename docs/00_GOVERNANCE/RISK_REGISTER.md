# Registro de riesgos

| Riesgo | Severidad | Mitigación |
|---|---:|---|
| Interpretación Art. 8.3 PA121 respecto a dispositivos no homologados | Crítica | VALIDAR-SENIAT antes de POS/mobile fiscal |
| Cambio fiscal requiere nueva homologación | Crítica | release train fiscal aislado |
| Dependencia de imprenta digital | Alta | adapter + proveedor secundario si es viable |
| Caída de internet | Alta | plan de contingencia conforme PA102 |
| Errores de redondeo | Alta | decimal + tests golden |
| RLS incorrecta filtra tenant | Crítica | pruebas automáticas de aislamiento |
| Claude sugiere asiento/impuesto incorrecto | Alta | aprobación humana + motor determinista |
| Actualización móvil no coordinada | Alta | feature flags y compatibilidad de protocolo |
| Secuencias duplicadas | Crítica | asignación transaccional/locking |
| Pérdida de audit logs | Crítica | append-only + backup + hash |
| Hostinger sin SLA suficiente para fiscal | Alta | evaluar plan/arquitectura y failover |
| Norma tributaria cambia | Alta | tax rules versionadas |

## Deuda técnica abierta

Riesgos concretos con dueño, disparador y momento en que dejan de ser aceptables. No viven en el
handoff de una sesión: aquí, hasta que se cierren.

### R-01 · `allocate` rechaza pesos negativos

- **Severidad:** Alta · **Disparador:** primera nota de crédito con línea de descuento
- **Dónde:** `packages/money/src/rounding.ts` → `allocate`, error `MONEY_INVALID_WEIGHTS`

Una nota de crédito que revierte una factura con descuento produce un vector de pesos de **signo
mixto**, y hoy `allocate` lo rechaza de plano. Quien se lo encuentre tendrá la tentación de
repartir a mano, que es exactamente el camino por el que se pierde un céntimo y se descuadra un
asiento (invariante 10 de `06_QA/ACCOUNTING_INVARIANTS_TESTS.md`).

**Decisión pendiente:** ¿se admiten pesos de signo mixto en `allocate`, o el descuento se modela
como una línea aparte con su propio reparto? Lo segundo es más limpio contablemente pero obliga a
`packages/fiscal` a orquestar dos repartos y a cuadrarlos entre sí.

**Deja de ser aceptable:** antes de la primera emisión de nota de crédito en `packages/fiscal`.
No bloquea S0.3 ni S0.4.

### R-02 · `ResidualAllocation` sin implementar

- **Severidad:** Media · **Disparador:** respuesta del asesor a `MONEY_AND_ROUNDING_SPEC.md` §6.3
- **Dónde:** `packages/money/src/rounding.ts` → `allocate`

`allocate` reparte por **mayor resto**, que no es ninguno de los cuatro modos que la spec enumera
(`FIRST_LINE`, `LAST_LINE`, `LARGEST_LINE`, `PROPORTIONAL`). Con pesos iguales degenera en
`FIRST_LINE` y por eso no se notaba; con pesos `[1, 2]` sobre 0.10 el céntimo cae en la **segunda**
línea.

El comentario del código afirmaba `FIRST_LINE` y era falso — lo detectó la auditoría de
invariantes, no la suite. Ya está corregido en el código; lo que falta es el parámetro.

**Bloqueado por:** `VALIDAR-TRIBUTARIO` de §6.3, donde el asesor decide qué línea absorbe el
residuo. No tiene sentido implementar cuatro modos antes de saber cuál se exige.

**Deja de ser aceptable:** cuando §6.3 se responda, o antes si `packages/fiscal` necesita un modo
distinto del actual.

### R-03 · `decimal.js` redondea en silencio más allá de 50 dígitos significativos

- **Severidad:** Media · **Disparador:** una cadena larga de operaciones sobre `ExactMoney`
- **Dónde:** `packages/money/src/decimal.ts` → `LadinoDecimal`, y `ExactMoney` en general

El clon trabaja a 50 dígitos significativos. Una secuencia de operaciones que los supere **pierde
precisión sin avisar**: la auditoría comprobó que `(max × 10^30) + 0.00000001` menos el original
da exactamente `0`. El céntimo desaparece.

`ExactMoney` no tiene cota de magnitud (deliberado, ADR-0023), así que nada hace improbable llegar
ahí. No hay test ni guardia.

**Mitigación posible:** una comprobación de dígitos significativos en las operaciones de
`ExactMoney`, o una cota de magnitud que lo haga inalcanzable. Las dos tienen coste y ninguna es
obviamente correcta.

**Deja de ser aceptable:** cuando `packages/accounting` o `packages/inventory` encadenen
operaciones sobre intermedios (valoración de inventario, prorrateos anidados). Hoy no hay
consumidores.
