# packages/money

Aritmética monetaria de Ladino. **Paquete puro: sin I/O, sin fecha del sistema, sin red.**

Solo puede importar `@ladino/core` (`Result`, `DomainError`, `Brand`, `Instant`) y `decimal.js`.
Nada más del repositorio.

## Dos entradas

| Entrada | Contenido | Quién la importa |
|---|---|---|
| `@ladino/money` | `Money`, aritmética, los cinco redondeos nombrados (`roundForCost` llegó con inventario, ADR-0034), FX, `allocate`, `MonetaryFact` | `accounting`, `fiscal`, `inventory`, `domain`, `api`, `worker` |
| `@ladino/money/format` | `formatMoney`, `parseUserInput`. Cero aritmética, cero FX, cero redondeo fiscal | además: `web`, `mobile`, `ui` |

`web`, `mobile` y `ui` **no pueden importar la raíz**. La regla es mecánica en
`dependency-cruiser`, no una anotación (ADR-0021).

## Dos tipos, un solo puente (ADR-0023)

```
Money ──multiply──▶ ExactMoney ──roundFor*──▶ RoundedMoney { value: Money, preRound, policy }
  ▲                      ▲                                        │
  └────── convert ───────┘                                        ▼ se persiste
```

| | `Money` | `ExactMoney` |
|---|---|---|
| Qué es | lo persistible | el intermedio de cálculo |
| Escala | ≤ 8 decimales | hasta 50 dígitos significativos |
| Magnitud | acotada a `numeric(24,8)` | sin acotar |
| Serializa | `toJSON()` → `{ amount, currency }` | **no. Lanza.** |
| Salida | es el destino | solo un `roundFor*` |

`0.00000001 USD × 36.5 = 0.000000365 VES`: el resultado exacto de una conversión casi nunca cabe
en ocho decimales. **No existe forma de persistir ni publicar un valor calculado sin nombrar
antes la política de redondeo.** Está cerrado por construcción, no por convención.

La cota de `numeric(24,8)` se comprueba en **un solo punto**, el puente. Por eso `roundFor*`
devuelve `Result`.

### Estanqueidad

`amount` y `currency` son campos privados (`#`) con getter en el prototipo, no propiedades
propias. Cierra las cuatro vías de publicación —`JSON.stringify`, spread, `Object.entries`,
`structuredClone`— **por construcción**: un getter en prototipo no es propiedad propia y no hay
descriptor que alguien pueda rehacer con `Object.defineProperty`.

Vale también para `Money`, y no solo por simetría: con propiedades propias, `{...money}` producía
`{"amount":"1.005"}` en vez del canónico `"1.00500000"`. **Un valor válido mal formado**, con la
forma exacta de un payload legítimo y sin forma de que el receptor lo detecte. Peor que uno
ausente.

Ver `test/no-leak.test.ts`. **Ausencia de mecanismo no es prohibición** (`CLAUDE.md` §2).

## Contrato

- Tipo `Money { amount: Decimal; currency: CurrencyCode }`. Nunca un `number` suelto.
  Ningún `number` aparece en una firma pública: `Scale` es una unión literal (`0|2|4|6|8`)
  precisamente para que el gate `api-surface` no necesite excepciones.
- `Money#multiply` devuelve `ExactMoney` y **no es `Result`**: multiplicar te saca del mundo
  persistible, así que no promete caber en ninguna parte.
- `decimal.js` internamente, vía **clon privado** (`Decimal.clone()`), nunca el constructor
  global: su configuración es global y mutable. Precisión 50, alineada con `numeric(24,8)`.
- Serialización a JSON como objeto `{ amount, currency }`, con `amount` siempre a 8 decimales.
  `Money.toJSON()` nunca produce un número. `toAmountString()` es solo para persistencia y
  paridad con `numeric(24,8)`, no es forma válida del contrato de la API.
- El redondeo es **explícito y nombrado**: `roundForCurrency`, `roundForTax`, `roundForDocument`,
  `roundForPayment`. No existe un redondeo "por defecto" implícito.
- Los cuatro devuelven `RoundedMoney`, que conserva el pre-redondeo **siempre**. Si fuera
  opcional, se perdería.
- El paquete **no tiene opinión fiscal**: la `RoundingPolicy` se inyecta. Los valores vigentes
  son un formulario abierto en `docs/04_PLATFORM/MONEY_AND_ROUNDING_SPEC.md` §6.
- Conversión FX requiere `{ rate, source, timestamp }`. `source` y `timestamp` son
  **obligatorios en el tipo** (garantía de compile-time) y su **no-vacuidad se valida en
  `makeFxRate`**, que es la única vía de construcción. `'' as RateSource` compila en cualquier
  sistema de tipos de TypeScript; la doc no promete lo que el compilador no puede dar.
- `convert()` no redondea. Devuelve `converted: ExactMoney` exacto; redondear es del llamador.
- `toMonetaryFact(conversion, functional)` necesita los dos argumentos y **valida la
  procedencia**: si `functional.preRound` no es el valor convertido de esa conversión,
  `FACT_ROUNDING_MISMATCH`. Un `fx_rate` que no corresponde al `functional_amount` persistido
  da un registro donde cada campo es cierto y el conjunto es mentira — indefendible en auditoría.
- Errores como valores: `Result<T, MoneyError>` de `@ladino/core`. Códigos estables, parte
  del contrato.

## Tests

Property-based obligatorio con fast-check, **escritos antes que la implementación** (ADR-0016).
Como mínimo:
- asociatividad y conmutatividad de la suma en el rango soportado;
- `0.1 + 0.2 === 0.3` exacto, y su generalización contra aritmética de enteros escalados a 10⁸;
- redondeo half-even vs half-up documentado y probado por moneda — la documentación es la tabla
  de `MONEY_AND_ROUNDING_SPEC.md` §6.1; mientras esté vacía se prueban los cinco modos por igual;
- ida y vuelta de serialización sin pérdida;
- una conversión FX y su inversa con la misma tasa recuperan el original dentro de tolerancia
  declarada **como constante en el test**, no descubierta ajustando hasta que pase;
- `allocate`: la suma de las partes es exactamente el total;
- pureza: un espía sobre `Date.now` falla el test si el dominio lee el reloj.
