# Dinero y redondeo

> **Estado de la documentación:** estructura definida el 2026-08-07 (S0.2).
> **Los valores de política tributaria están deliberadamente vacíos.** Este documento define
> *dónde* vive cada regla de redondeo, *quién* la resuelve y *cómo* se aplica. Las celdas
> marcadas `VALIDAR-TRIBUTARIO` requieren confirmación formal del asesor antes de producción.
> Ninguna de ellas está hard-coded en el código: `packages/money` no tiene opinión fiscal.

Referencias: ADR-0013 (Decimal), ADR-0020 (multimoneda), `ENGINEERING_STANDARDS.md` §Dinero.

---

## 1. Representación

Decimal exacto. Nunca IEEE 754.

| Capa | Tipo |
|---|---|
| Postgres | `numeric(24,8)` — 16 dígitos enteros, 8 decimales |
| TypeScript, valor persistible | `Money` de `packages/money` |
| TypeScript, intermedio de cálculo | `ExactMoney` de `packages/money` |
| JSON / API | objeto `{ amount: string, currency: string }` (ver `API_SPEC.md`) |
| Persistencia / paridad de tests | string canónico de 8 decimales |

`packages/money` usa un **clon privado** de `Decimal` (`Decimal.clone()`), no el constructor
global: la configuración de `decimal.js` es global y mutable, y una dependencia transitiva que
llamara `Decimal.set()` alteraría en silencio todos nuestros cálculos.

## 1.1 Dos tipos, un solo puente (ADR-0023)

Un importe calculado y un importe persistible **no son la misma cosa**, y confundirlos obliga a
elegir entre dos males: redondear a escondidas o mentir sobre lo que un valor representa.

```
   Money  ──multiply──▶  ExactMoney  ──roundFor*──▶  RoundedMoney { value: Money, preRound, policy }
     ▲                        ▲                                          │
     └──────── convert ───────┘                                          ▼
                                                                    se persiste
```

| | `Money` | `ExactMoney` |
|---|---|---|
| Escala | ≤ 8 decimales | hasta 50 dígitos significativos |
| Magnitud | acotada a `numeric(24,8)` | sin acotar |
| Serializa | `toJSON()` → `{ amount, currency }` | **no. Lanza.** |
| Salida | es el destino | solo un `roundFor*` |

La razón concreta: el resultado exacto de una conversión casi nunca cabe en ocho decimales
—`0.00000001 USD × 36.5 = 0.000000365 VES`— y redondearlo dentro de `convert` rompería la
linealidad y con ella el cuadre del diferencial cambiario.

**Consecuencia práctica:** no existe forma de persistir ni publicar un valor calculado sin haber
nombrado antes la política de redondeo. No es una convención de estilo; está cerrado por
construcción y verificado en `packages/money/test/no-leak.test.ts`.

La cota de `numeric(24,8)` se comprueba **en un solo punto**: el puente `roundFor*`. Por eso esas
cuatro funciones devuelven `Result`.

## 2. Los siete campos de un importe (ADR-0020)

Todo importe persistido lleva los siete. El tipo `MonetaryFact` de `packages/money` es su
única definición canónica; ninguna tabla los redeclara por su cuenta.

Se obtienen con `toMonetaryFact(conversion, functional)`, que necesita **los dos** argumentos:
`conversion.converted` es un `ExactMoney` y `functional_amount` no existe hasta que alguien nombra
una política de redondeo.

| Campo | Origen en `packages/money` |
|---|---|
| `amount_transaction_currency` | `conversion.original.toAmountString()` |
| `transaction_currency` | `conversion.original.currency` |
| `fx_rate` | `conversion.rate.rate` |
| `functional_amount` | `functional.value.toAmountString()` — **ya redondeado** |
| `functional_currency` | `functional.value.currency` |
| `rate_source` | `conversion.rate.source` |
| `rate_timestamp` | `conversion.rate.timestamp` |

`toMonetaryFact` **valida la procedencia**: comprueba que `functional.preRound` sea el valor
convertido de esa conversión y que la moneda funcional sea la moneda destino de la tasa. Si no,
`MONEY_FACT_ROUNDING_MISMATCH`.

No es rutina defensiva. Los siete campos solo significan algo si son coherentes entre sí: un
`fx_rate` que no corresponde al `functional_amount` persistido produce un registro donde cada
campo es individualmente cierto y el conjunto es mentira. Nadie puede reproducir esa cifra, y en
una inspección el registro se contradice solo.

`convert()` **no redondea**. Devuelve el valor exacto y el redondeo es una decisión posterior
y explícita del contexto. Si `convert` redondeara internamente, se perdería la linealidad
(`convert(a+b) = convert(a) + convert(b)`) y los diferenciales cambiarios dejarían de cuadrar:

```
a·r = 0.000000005      b·r = 0.000000005
redondeando cada uno:  0.00000000 + 0.00000000 = 0.00000000
redondeando la suma:   round(0.00000001)       = 0.00000001
```

## 3. Qué es una `RoundingPolicy`

Una política de redondeo es un **dato versionado y vigente por fecha**, nunca una constante
en el código.

```ts
interface RoundingPolicy {
  id:    string;        // identificador estable, se persiste junto al importe redondeado
  scale: Scale;         // 0 | 2 | 4 | 6 | 8 — decimales del resultado
  mode:  RoundingMode;  // HALF_UP | HALF_EVEN | HALF_DOWN | DOWN | UP
}
```

Las cuatro funciones de redondeo devuelven `RoundedMoney`, que conserva **siempre** el valor
previo. El pre-redondeo es estructural, no opcional: si fuera opcional, se perdería.

```ts
interface RoundedMoney {
  value:    Money;          // redondeado, persistible
  preRound: ExactMoney;     // el valor exacto, sin excepción
  policy:   RoundingPolicy; // qué política se aplicó realmente
}
```

`preRound` es un `ExactMoney` porque el valor de entrada normalmente tiene más precisión de la
que `numeric(24,8)` admite — viniendo de una conversión FX, es el caso habitual.

**Serializar un `RoundedMoney` entero lanza**, precisamente porque arrastra el pre-redondeo. Lo
que se publica es `value`, explícitamente. Es un tipo pensado para cruzar capas, así que esa
puerta también está cerrada y probada.

## 4. Dónde viven las políticas

Tabla `rounding_policies` (llega con el módulo tributario, no en Sprint 0). Vigencia por fecha
y fuente citada, igual que las tasas de cambio y las alícuotas:

| Columna | Tipo | Nota |
|---|---|---|
| `id` | `text` | estable; se persiste en cada importe redondeado |
| `context` | `text` | `currency` \| `tax` \| `document` \| `payment` |
| `selector` | `jsonb` | a qué aplica: moneda, tipo de impuesto, tipo de documento, medio de pago |
| `scale` | `smallint` | |
| `mode` | `text` | `CHECK` sobre el enumerado |
| `effective_from` | `date` | vigencia por fecha, nunca retroactiva |
| `effective_to` | `date` | nullable |
| `source` | `text` | **referencia normativa citada.** Sin `source` no se inserta la fila |
| `version` | `text` | versión de reglas; se guarda en el importe (regla 3 de `CLAUDE.md`) |

Sin `source` no hay política, igual que sin `source` no hay conversión FX.

## 5. Quién resuelve la política

`packages/money` **no resuelve nada**: recibe la política ya resuelta como argumento. Es un
paquete puro, sin acceso a base de datos ni al reloj del sistema.

```
motor tributario / caso de uso de dominio
    │  resuelve la política vigente para (context, selector, fecha fiscal)
    ▼
packages/money  roundForTax(money, policy) → RoundedMoney
    │
    ▼
se persisten value, preRound y policy.id junto al importe
```

El único redondeo con default es `roundForCurrency`: su escala son las *minor units* de
ISO-4217 de la moneda, que es metadato de la moneda y **no** una regla tributaria.

## 6. Los cuatro contextos — formulario para el asesor

**Las celdas de valores tributarios están vacías a propósito.** Rellenarlas con un supuesto
plausible sería peor que dejarlas en blanco (`CLAUDE.md` §2, señal de parada de
`CONTEXT_MAP.md`). El asesor recibe un formulario concreto, no una pregunta abierta.

Lo que **sí** está decidido, porque no es materia tributaria sino de ingeniería o de
contabilidad, y por tanto no espera a nadie:

- §6.2 — el motor soporta **ambos** modos de agregación del impuesto. El asesor elige el valor.
- §6.3 — la línea que absorbe el residuo es **parámetro de la política**, no una constante.
- §6.4 — el redondeo de caja **genera asiento propio**. Regla contable, cerrada.
- §6.5 — el modo aplicado se persiste en `rules_version`, para poder reproducir el documento.

### 6.1 `roundForCurrency` — presentación y saldos por moneda

| Moneda | Escala | Modo | Fuente |
|---|---|---|---|
| VES | `2` (ISO-4217) | `VALIDAR-TRIBUTARIO` | |
| USD | `2` (ISO-4217) | `VALIDAR-TRIBUTARIO` | |

Las escalas son ISO-4217, no una interpretación fiscal. El **modo** sí requiere confirmación:
`packages/money/CLAUDE.md` exige "half-even vs half-up documentado y probado por moneda", y esa
documentación es exactamente esta tabla.

### 6.2 `roundForTax` — base imponible e impuesto

| Impuesto | ¿Se redondea la base? | Escala | Modo | Agregación | Fuente |
|---|---|---|---|---|---|
| IVA | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Retención de IVA | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Retención de ISLR | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| IGTF | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |

**Agregación: el motor soporta los dos modos. No elegimos uno.**

```
PER_LINE      calcular el impuesto en cada línea y sumar los resultados
PER_DOCUMENT  sumar las bases de las líneas y calcular el impuesto una sola vez
```

Las dos vías difieren en céntimos y el libro de ventas los acumula, así que no es un detalle de
implementación: es una decisión con consecuencias. Pero **no es una decisión de ingeniería**.
`TaxAggregation` es un campo de la `RuleSet` tributaria, con la misma vigencia por fecha y fuente
citada que cualquier otra regla; el asesor elige el valor, el motor implementa ambos caminos y
los prueba por igual. Un motor que solo sepa hacer uno obliga a rediseñar el día que la respuesta
sea la otra.

### 6.3 `roundForDocument` — totales del documento fiscal

| Concepto | Escala | Modo | Fuente |
|---|---|---|---|
| Subtotal | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Descuentos | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Total del documento | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |

**Absorción del residuo: parámetro de la política, no una constante del código.**

Cuando la suma de las líneas redondeadas difiere del total redondeado, `allocate()` de
`packages/money` garantiza que la suma de las partes sea exactamente el total. *Cuál* línea
recibe el céntimo sobrante lo decide la política:

```
ResidualAllocation = FIRST_LINE | LAST_LINE | LARGEST_LINE | PROPORTIONAL
```

`allocate()` es determinista en cualquiera de los modos: mismos argumentos, mismo reparto.

### 6.4 `roundForPayment` — cobros, pagos y vuelto

| Concepto | Escala | Modo | Fuente |
|---|---|---|---|
| Efectivo VES | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Efectivo USD | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Medios electrónicos | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |
| Vuelto en moneda distinta | `VALIDAR-TRIBUTARIO` | `VALIDAR-TRIBUTARIO` | |

**Redondeo de caja por denominación mínima — DECIDIDO. Es una regla contable, no tributaria.**

Cuando el importe a cobrar o el vuelto no es representable con la denominación mínima disponible
en caja, la diferencia:

- **genera su propio asiento** contra una cuenta de *diferencia de redondeo* del plan contable;
- **nunca se absorbe en el importe cobrado**, ni en la base imponible, ni en el impuesto, ni en
  el total del documento fiscal;
- se registra con su `preRound`, la denominación mínima aplicada y la política vigente, de modo
  que el asiento sea reproducible.

El documento fiscal conserva su total exacto. Lo que cambia es la liquidación de caja, y esa
diferencia es un hecho contable con contrapartida explícita. Absorberla en el cobro dejaría un
descuadre entre el documento y el arqueo que ningún cierre podría explicar después.

### 6.5 Reproducibilidad: el modo aplicado se persiste

Ni la agregación de §6.2 ni la absorción de §6.3 se pueden inferir del resultado. Dos documentos
con los mismos importes y distinta configuración producen totales distintos y ambos son
correctos bajo sus reglas.

Por eso **el modo efectivamente aplicado queda registrado en el `rules_version` del documento**,
junto con el resto de la `RuleSet` vigente en el momento de la emisión (regla 3 de `CLAUDE.md`:
todo documento fiscal guarda autor, timestamp, origen y versión de reglas).

Reproducir una factura años después consiste en recuperar su `rules_version`, no en adivinar qué
configuración estaba activa aquel día. Un cambio posterior de política **no recalcula histórico**
—`PRICING_MULTICURRENCY_SPEC.md` §Reglas de negocio— precisamente porque cada documento lleva
consigo las reglas con las que nació.

## 7. Conservación del pre-redondeo

Se persiste `preRound` siempre que el importe sea base de un cálculo posterior, entre en un
libro fiscal o forme parte de un asiento. La reproducibilidad de una cifra histórica
(ADR-0013) depende de tener el valor exacto y la política aplicada, no solo el resultado.

## 8. Tests

En `packages/money` el test se escribe **antes** que la implementación (ADR-0016). Las
propiedades verificadas están en `packages/money/test/`. Las que anclan este documento:

- `0.1 + 0.2` es exactamente `0.3`, y su generalización: la suma coincide con aritmética de
  enteros escalados a 10⁸ para todo par del dominio.
- Cota de error: `|round(x) − x| ≤ ½·10^(−scale)` para toda función y política.
- **Discriminación de modos:** fuera de los empates exactos, los cinco modos coinciden. Es la
  propiedad que atrapa una confusión half-even/half-up, que de otro modo sobrevive años.
- `preRound` es exactamente la entrada, para las cuatro funciones y toda política.
- `allocate`: la suma de las partes es exactamente el total. Cero céntimos perdidos —
  invariante 10 de `06_QA/ACCOUNTING_INVARIANTS_TESTS.md`.
- Pureza: un espía sobre `Date.now` falla el test si el dominio lee el reloj.

Mientras las celdas de §6 sigan vacías, la suite prueba **los cinco modos por igual**. Ninguna
política es privilegiada en el código, así que responder el formulario no exige rediseñar nada:
solo insertar filas en `rounding_policies`.
