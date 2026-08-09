# ADR-0024 — La política de redondeo se persiste: `MonetaryFact` pasa de siete campos a ocho

- **Estado:** Aceptado · **Fecha:** 2026-08-08 · **Impacto fiscal:** SÍ
- **Amplía:** ADR-0020 (que queda vigente, no enmendado)

## Contexto

ADR-0020 fijó los siete campos que todo importe persiste, para que cualquier cifra histórica se
pueda explicar años después: qué tasa, de dónde, de cuándo.

```
amount_transaction_currency   transaction_currency   fx_rate
functional_amount             functional_currency
rate_source                   rate_timestamp
```

Con esos siete se reproduce **la conversión**: importe original × tasa citada = importe funcional
exacto. Eso funciona mientras el importe funcional sea el valor exacto.

Pero desde ADR-0023 no lo es. El resultado de una conversión es un `ExactMoney` y lo que se
persiste es el resultado de aplicarle una `RoundingPolicy` nombrada. Entre el valor exacto y la
cifra guardada hay un paso —escala y modo de redondeo— que **ninguno de los siete campos
registra**.

La auditoría de invariantes de S0.2 lo señaló así: se guarda el importe redondeado, se guarda el
pre-redondeo, y no se guarda con qué regla se pasó de uno al otro. `MONEY_AND_ROUNDING_SPEC.md`
§5 ya decía "se persisten `value`, `preRound` y `policy.id` junto al importe", pero el tipo
`MonetaryFact` —la definición canónica que S0.3 usará para crear las tablas— no lo llevaba.

Un ejemplo de por qué importa. Dos documentos con los mismos siete campos:

```
amount_transaction_currency = 100.00000000  USD
fx_rate                     = 36.50000000
functional_amount           = 3650.00000000  VES     ← policy: 2 decimales, HALF_EVEN
functional_amount           = 3650.00000000  VES     ← policy: 2 decimales, HALF_UP
```

Aquí coinciden. En un importe con empate exacto no coincidirían, y **no habría forma de saber
cuál de las dos reglas produjo la cifra guardada**. Reproducir el cálculo exigiría adivinar la
política vigente aquel día, que es exactamente lo que ADR-0020 existe para no tener que hacer.

## Opciones consideradas

1. **Dejarlo en `rules_version` del documento** — a favor: no toca el importe; ya existe por la
   regla 3 de `CLAUDE.md`. En contra: `rules_version` identifica el conjunto de reglas del
   documento, no cuál se aplicó a **este** importe. Un documento puede llevar importes redondeados
   con políticas distintas: base imponible, impuesto, total y liquidación de caja son cuatro
   contextos con cuatro políticas. Resolverlo obligaría a recorrer la `RuleSet` completa y volver
   a inferir cuál tocaba — inferencia, no registro.
2. **Persistir la política entera** (`scale` + `mode`) junto al importe — a favor: legible sin
   join. En contra: duplica dato versionado en cada fila y abre la puerta a que la copia y la
   tabla `rounding_policies` diverjan.
3. **Persistir `policy.id`**, que es estable y apunta a la fila vigente de `rounding_policies`
   con su `effective_from`, su `source` y su `version`.

## Decisión

**Opción 3. `MonetaryFact` tiene ocho campos.**

```ts
interface MonetaryFact {
  readonly amountTransactionCurrency: string;
  readonly transactionCurrency: string;
  readonly fxRate: string;
  readonly functionalAmount: string;
  readonly functionalCurrency: string;
  readonly rateSource: string;
  readonly rateTimestamp: Instant;
  readonly roundingPolicyId: string;   // ← ADR-0024
}
```

Simetría deliberada con la tasa: `fx_rate` no se acepta sin `rate_source`, y `functional_amount`
no se acepta sin `rounding_policy_id`. **Ninguna cifra derivada se persiste sin la referencia a
la regla que la produjo.** `toMonetaryFact` ya rechaza una política sin identificador
(`INVALID_ROUNDING_POLICY` en `applyPolicy`), así que el campo nunca puede quedar vacío.

**ADR-0020 no se enmienda.** Sus siete campos siguen siendo correctos y obligatorios; este ADR
añade el octavo y explica por qué hizo falta. Cambiar un ADR aceptado en silencio borra el
razonamiento que llevó a él, y ese razonamiento es la mitad del valor del registro.

## Consecuencias

**Positivas**

- Reproducir una cifra histórica deja de requerir inferencia: se lee `rounding_policy_id`, se
  busca la fila vigente y se recalcula. Es lo que ADR-0020 prometía y le faltaba un paso.
- La política aplicada queda a nivel de **importe**, no de documento, que es donde vive la
  decisión. Un documento con base imponible, impuesto y total redondeados con políticas distintas
  queda correctamente registrado.
- Cierra el hueco entre `MONEY_AND_ROUNDING_SPEC.md` §5 y el tipo canónico.

**Negativas y deuda que aceptamos**

- **Una columna más en toda tabla que persista importes**, y una FK a `rounding_policies`. El
  esquema de ADR-0020 ya era ancho; ahora lo es más.
- **`rounding_policies` se vuelve tabla de referencia crítica**: si se pierde una fila, los
  importes que la citan dejan de ser reproducibles. Hay que tratarla como append-only con
  vigencia por fecha, nunca con `UPDATE` sobre filas ya citadas.
- **Un `MonetaryFact` ya no se construye sin haber pasado por `roundFor*`.** Era cierto de facto
  desde ADR-0023; ahora también lo es en el tipo. Consecuencia buscada, pero es fricción real.
- El identificador es un `string` libre. Nada impide escribir `"tmp"` y persistirlo. La validación
  de que apunte a una fila real de `rounding_policies` es responsabilidad de la capa de
  persistencia, no de `packages/money`, que es puro y no consulta nada.

**Para revertirla** habría que quitar la columna y volver a inferir la política desde
`rules_version`. Se hace ahora, antes de S0.3, precisamente para no tener que migrar tablas ya
pobladas.

## Verificación

- `packages/money/test/fx.test.ts` — `toMonetaryFact` proyecta ocho campos, todos string, y
  `roundingPolicyId` es el `policy.id` del `RoundedMoney` recibido.
- `packages/money/test/audit-findings.test.ts` — la propiedad del invariante 9 recalcula el
  importe funcional desde los campos persistidos **usando la política citada**, no una elegida
  por el test.
- Cuando S0.3 cree el esquema: FK de `rounding_policy_id` a `rounding_policies(id)` con
  `on delete restrict`, y test pgTAP que impida borrar una política citada por algún importe.
