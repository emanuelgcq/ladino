# ADR-0053 — La percepción de IGTF se redondea a la moneda

- **Estado**: aceptada (orden del dueño, 2026-09-10)
- **Fecha**: 2026-09-10
- **Módulos**: ventas (cobro) · fiscal (IGTF) · contabilidad
- **HOMOLOGATION_IMPACT**: NO. No toca numeración, formato de documento ni
  emisión. Cambia la **escala** del importe percibido, que es metadato de la
  moneda (ISO-4217), no un valor tributario.

## Contexto

La percepción se calculaba así (ADR-0052, migración 46):

```ts
const monto = importe.times(tasaIgtf).toDecimalPlaces(8, 4);
const funcional = monto.times(tasaCobro).toDecimalPlaces(8, 4);
```

Ocho decimales, porque ocho es la escala de `numeric(24,8)` y la que usa el
resto del pipeline de ventas (`sales:document:8:HALF_UP`). Con precios
redondos el resultado no se notaba. Con datos reales sí: de **166
percepciones en producción, 160 tienen más de dos decimales** — el 96 %,
porque el 3 % de un importe cualquiera casi nunca cae en un céntimo.

Lo que veía el dueño en pantalla:

| Base del pago | Percibido | En sus libros |
|---|---|---|
| USD 35,45 | **USD 1,0635** | Bs. 865,40834235 |
| USD 3,00 | USD 0,09 | Bs. 74,496339 |

**USD 1,0635 no se le puede cobrar a nadie.** No existe forma de pagar cuatro
decimales de un dólar, y la percepción no es un cálculo interno: es dinero que
se le cobra al cliente encima de su pago, en el momento del cobro, y que
después se entera al fisco.

La pantalla no estaba mintiendo ni le faltaba formato. `formatMoney` **se niega
a redondear** a propósito (MONEY_AND_ROUNDING_SPEC §5): formatear no es
redondear, y un importe con más decimales de los que la moneda muestra cae al
formato exacto para que el defecto se vea en vez de taparse. Hizo su trabajo.

## Decisión

La percepción de IGTF y su importe funcional se redondean a las **minor units
ISO-4217 de su moneda** en el momento de calcularlas, con `roundForTax` y una
política explícita y persistida.

```
igtf:perception:<minorUnits>:<modo>     p. ej. igtf:perception:2:HALF_UP
```

Tres cosas, y el porqué de cada una:

1. **La escala la decide la moneda, no el fisco.** MONEY_AND_ROUNDING_SPEC §6.1
   fija escala 2 para VES y USD y dice literalmente que «las escalas son
   ISO-4217, no una interpretación fiscal». No se inventa nada: se lee la
   definición de la moneda (`currencyDefinition().minorUnits`), así que una
   moneda de cero decimales o de tres se comportaría sola.

2. **El funcional se calcula desde el importe YA redondeado**, no desde el
   exacto. Lo que entra en caja es lo que se le cobró al cliente; valorar otra
   cifra produciría un asiento que no corresponde a ningún dinero movido.

3. **El modo queda nombrado y persistido.** `MODO_IGTF = "HALF_UP"`, el mismo
   que ya usa `sales:document:8:HALF_UP` en todo el pipeline de ventas: la
   coherencia dentro de un cobro pesa más que elegir un modo distinto por
   gusto. Va en el `rounding_policy_id` de cada fila, así que cambiarlo mañana
   no reescribe la historia — las filas viejas siguen diciendo con qué regla se
   calcularon.

**VALIDAR-SENIAT**: que el modo de redondeo de la percepción sea `HALF_UP` y no
otro lo confirma el contador. La escala no está en duda; el modo sí, y por eso
tiene nombre propio en el código y queda escrito en cada fila. Es exactamente
el mismo tratamiento que `ISO_PRESENTATION_MODE` le da a la casilla abierta de
§6.1.

## Lo que NO se toca

**Las 166 percepciones ya registradas se quedan como están.** Se calcularon con
otra regla y su asiento está posteado; un asiento posteado no se actualiza
(regla 2). La migración les escribe la política que de verdad se les aplicó
—`igtf:perception:8:HALF_UP`, que es lo que hacía `toDecimalPlaces(8, 4)`— para
que la historia diga la verdad, no para reinterpretarla.

Tampoco cambia **cuándo** se percibe, ni sobre qué, ni la tasa: eso es
ADR-0052 y sigue igual.

## Consecuencias

- `igtf_perceptions` gana `rounding_policy_id not null`. La spec ya lo exigía
  («`functional_amount` no se acepta sin `rounding_policy_id`») y la tabla nació
  sin él: esto cierra esa deuda, no solo la del redondeo.
- `/v1/pos/igtf` —el aviso que la caja enseña antes de cobrar— redondea igual.
  Si previsualizara con otra escala, la caja diría un número y cobraría otro.
- Dos aserciones de `e2e-igtf.test.ts` cambian a propósito: fijaban los ocho
  decimales que este ADR sustituye. Se añade el caso que las anteriores no
  cubrían — una base cuyo 3 % no cae en un céntimo.
- El total de la quincena deja de arrastrar decimales de más: es la suma de
  importes ya redondeados, no un redondeo del total.
