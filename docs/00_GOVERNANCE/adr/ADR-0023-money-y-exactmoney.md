# ADR-0023 — `Money` y `ExactMoney`: separar lo persistible de lo calculado

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ

## Contexto

Al implementar S0.2, `Money` se definió con un invariante que parecía obviamente correcto:

> Todo `Money` es exactamente representable en `numeric(24,8)`.

Es lo que hace que `toAmountString()` nunca necesite redondear, y que persistir un importe no
pueda perder información. Duró hasta la primera conversión FX. `fast-check` devolvió este
contraejemplo mínimo:

```
0.00000001 USD × 36.5 = 0.000000365 VES     ← nueve decimales
```

El resultado **exacto** de una conversión casi nunca cabe en ocho decimales. Con el invariante
puesto, `convert` no tenía más salida que devolver un error o redondear por dentro.

Y redondear por dentro no es una opción. El contraejemplo, redondeando a 8 decimales:

```
a·r = 0.000000005      b·r = 0.000000005

redondear cada uno:    0.00000000 + 0.00000000  =  0.00000000
redondear la suma:     round(0.00000001)        =  0.00000001
```

La linealidad `convert(a+b) = convert(a) + convert(b)` se pierde. Convertir línea a línea daría
un total distinto que convertir el total, y el diferencial cambiario dejaría de cuadrar contra la
tasa congelada — invariante 9 de `06_QA/ACCOUNTING_INVARIANTS_TESTS.md`, y una de las cifras que
ADR-0020 exige poder explicar años después.

El problema no era la propiedad. Era el invariante: **un solo tipo cargaba con dos
responsabilidades incompatibles**, ser el resultado exacto de un cálculo y ser lo que se
persiste.

## Opciones consideradas

1. **`convert` redondea internamente** — a favor: un solo tipo, cero cambios. En contra: rompe la
   linealidad, que es exactamente lo que no se puede romper. Descartada por el contraejemplo.
2. **Relajar `Money` a decimal exacto sin tope de escala, y que `toAmountString()` lance si el
   valor no cabe** — a favor: cambio mínimo. En contra: el tipo deja de decir la verdad. Un
   `Money` con doce decimales sigue llamándose `Money`, se puede pasar a cualquier función que
   espere un importe persistible, y el fallo llega tarde y en runtime.
3. **Restringir los generadores de las propiedades FX** a tasas e importes cuyo producto quepa en
   ocho decimales — en contra: deja sin probar el caso real que más importa, tasas del BCV con
   muchos decimales sobre importes con céntimos. Es tapar el termómetro.
4. **Dos tipos** — el que se persiste y el que se calcula.

## Decisión

**Dos tipos, con un único puente entre ellos.**

| | `Money` | `ExactMoney` |
|---|---|---|
| Qué es | lo persistible | el intermedio de cálculo |
| Escala | ≤ 8 decimales | hasta la precisión del clon (50 dígitos) |
| Magnitud | acotada a `numeric(24,8)` | **sin acotar** |
| Serialización | `toJSON()` → `{ amount, currency }` | **ninguna. Lanza.** |
| Proyección a string | `toAmountString()`, siempre 8 decimales | no tiene |
| Salida | es el destino | solo `roundForCurrency` / `roundForTax` / `roundForDocument` / `roundForPayment` |

Consecuencias directas en las firmas:

- `Money#multiply(factor)` devuelve `ExactMoney` y **deja de ser `Result`**. Multiplicar te saca
  del mundo persistible; no puede fallar porque ya no promete caber en ninguna parte.
- `convert()` devuelve `FxConversion` con `converted: ExactMoney`. Solo falla si la tasa no parte
  de la moneda del importe.
- `roundFor*` pasa a devolver `Result<RoundedMoney, MoneyError>`. Es el corolario de que
  `ExactMoney` no tenga cota de magnitud: la cota de `numeric(24,8)` tiene que comprobarse en
  algún sitio, y ese sitio es el puente. **Toda restricción de persistencia vive en un punto.**
- `RoundedMoney.preRound` es `ExactMoney`, porque el valor de entrada normalmente tiene más
  precisión de la que `numeric(24,8)` admite.
- `toMonetaryFact(conversion, functional)` necesita los dos argumentos: `converted` es un
  `ExactMoney` y no existe forma de producir `functional_amount` sin haber nombrado antes una
  política.

El objetivo no era arreglar dos propiedades. Era hacer **imposible** persistir o publicar un
valor calculado sin nombrar la política con la que se redondeó.

### `toMonetaryFact` valida la procedencia, no solo la forma

`toMonetaryFact` comprueba que `functional.preRound` sea exactamente el valor convertido de esa
conversión, y que la moneda funcional sea la moneda destino de la tasa. Si no, devuelve
`MONEY_FACT_ROUNDING_MISMATCH`.

No es una comprobación defensiva de rutina. Los siete campos de ADR-0020 **solo significan algo
si son coherentes entre sí**. Un `fx_rate` que no corresponde al `functional_amount` persistido
produce un registro donde cada campo es individualmente cierto y el conjunto es mentira: el
importe funcional no se obtiene de aplicar esa tasa a ese importe transaccional. Nadie puede
reproducir la cifra, y en una inspección no hay nada que alegar — el registro se contradice solo.

El sistema de tipos no puede impedirlo: dos `RoundedMoney` de la misma moneda son
indistinguibles para el compilador. Así que se comprueba en ejecución, que es donde se puede.

## Consecuencias

**Positivas**

- Publicar o persistir un valor sin redondear es imposible, no "desaconsejado".
- La linealidad de `convert` es exacta y verificable. P25 dejó de comparar cadenas de 8 decimales
  —que igualaban cualquier par coincidente hasta ahí— y pasó a exigir igualdad de valores.
- La cota de `numeric(24,8)` vive en un solo punto del código.
- Cada cifra persistida arrastra la política que la produjo.

**Negativas y deuda que aceptamos**

- **Dos tipos que hacen casi lo mismo.** Dos álgebras que mantener, dos juegos de propiedades
  (P1–P7 y P1e–P7e) y una fuente permanente de "¿cuál de los dos necesito aquí?". Es el precio
  y es real.
- **`roundFor*` es falible**, lo que metió 23 `must(...)` en los tests y mete un `Result` en cada
  llamada de producción. Se puede argumentar que redondear "no debería poder fallar"; puede, si
  el valor no cabe.
- **Fricción en el borde.** Todo camino de cálculo a persistencia gana un paso explícito. Es
  deliberado, pero en un módulo con muchas conversiones se nota.
- **`ExactMoney` no tiene cota de magnitud**, así que un error de escala (multiplicar por 10⁹ sin
  querer) no se descubre en el momento sino al redondear. El diagnóstico llega más tarde que la
  causa.
- **La precisión no es infinita.** El clon trabaja a 50 dígitos significativos; una cadena de
  operaciones que los supere redondea en silencio dentro de `decimal.js`. No hay test que lo
  cubra hoy. Queda anotado como límite conocido.

**Para revertirla** habría que fusionar los tipos y volver a elegir entre romper la linealidad o
relajar el invariante. Es decir: volver al problema. Por eso se hace ahora, en S0.2, cuando el
único consumidor es la propia suite.

## Consecuencia aparte: por qué `Money` también quedó cerrado

La separación de tipos protege contra publicar un valor **prohibido**. Pero al probar las vías de
salida apareció un caso distinto y peor:

```js
JSON.stringify({ ...money })   // {"amount":"1.005","currency":"VES"}
```

El spread copiaba las propiedades propias, saltándose `toAmountString()`. El resultado **no es un
valor prohibido: es un valor válido mal formado.** `"1.005"` en lugar del canónico
`"1.00500000"`. Tiene la forma exacta de un payload legítimo, pasa cualquier validación de tipo,
y el receptor **no tiene forma de detectar la diferencia** — no le falta nada, le sobran tres
decimales de menos.

Un valor ausente se nota. Un valor prohibido revienta. Un valor válido mal formado se persiste y
se descubre en un cuadre, meses después, sin rastro de dónde entró.

Ese caso es el que justifica cerrar también `Money`, y no solo `ExactMoney`. La regla queda:
**la única serialización de un importe es su `toJSON()`.**

### Por qué campos privados y no propiedades no enumerables

Las dos opciones cierran el spread, `Object.entries` y `structuredClone`. Se eligieron campos
privados `#amount` / `#currency` con getters en el prototipo por una diferencia concreta:

- Una propiedad no enumerable **sigue siendo una propiedad propia**. Su descriptor se puede
  rehacer desde fuera con `Object.defineProperty(x, "amount", { enumerable: true })`, y la
  protección desaparece sin que nada avise.
- Un getter en el prototipo **no es propiedad propia, por construcción**. `Object.keys`,
  `Object.entries`, el spread y `structuredClone` copian propiedades propias enumerables: no hay
  nada que copiar, y no hay descriptor que rehacer.

La primera depende de una configuración que alguien puede deshacer. La segunda depende de cómo
funciona el lenguaje. En un paquete cuyo trabajo es impedir que una cifra mal formada llegue a un
libro fiscal, esa diferencia importa.

`Object.freeze(this)` se conserva, pero no es lo que cierra estas vías — de hecho no cierra
ninguna. Congelar impide modificar; no impide leer ni copiar.

## La lección: la ausencia de fallo leída como éxito

Este patrón apareció **ocho veces en un solo sprint**, en ocho capas distintas. Es lo más
transferible que deja S0.1/S0.2 y por eso se escribe aquí, donde sobrevivirá al código que lo
produjo.

| # | Dónde | Qué parecía | Qué pasaba |
|---|---|---|---|
| 1 | `dependency-cruiser` | "sin violaciones de frontera" | No se le pasó `exportsFields`, así que **ningún import a `@ladino/*` resolvía**. Las reglas coinciden sobre la ruta resuelta: no coincidía ninguna. El gate estaba inerte y daba verde. |
| 2 | GitHub Actions | "CI configurado" | El trigger era `push: [main]` + `pull_request`. El primer push a una rama de trabajo sin PR no disparó nada: **cero runs, cero fallos, cero señal.** |
| 3 | `ExactMoney` | "no tiene `toJSON`, luego no se puede publicar" | `JSON.stringify` enumera las propiedades propias aunque no haya `toJSON`, y `Decimal` trae el suyo. Se publicaba `{"amount":"1.23456789012345",...}`. |
| 4 | `Money` / `ExactMoney` | "`toJSON` ya está cerrado" | El spread y `Object.entries` **ni siquiera pasan por `toJSON`**. Seguían publicando el objeto entero. |
| 5 | Suite de `money` | "146 propiedades en verde, S0.2 terminado" | Siete defectos en los huecos que el autor no pensó probar. Los encontró una revisión con mandato de buscar el fallo, no de confirmar el acierto. |
| 6 | `CLAUDE.md` §5 | "`pnpm db:reset`, `db:new` y `test:rls` son los comandos del proyecto" | **No existían.** Documentados desde el primer día, ausentes de `package.json`, y nadie se entera hasta que va a usarlos — en S0.3, dos sprints después. |
| 7 | Aislamiento multi-tenant | "120 aserciones pgTAP en verde, A no ve a B" | **Ningún test tenía un usuario con membership en dos tenants.** Probábamos A↔A y B↔B. El atacante realista de un sistema multi-tenant es el usuario legítimo de ambos, y es el caso central del producto. Un `UPDATE` trasladaba filas de un tenant a otro. |
| 8 | `alter default privileges ... revoke all on functions from anon, authenticated` | "las funciones nuevas quedan cerradas" | **No-op.** El `EXECUTE` por defecto lo tiene `PUBLIC`, no `anon`. Revocar de quien no lo tiene no quita nada: una función nueva en `public` seguía siendo ejecutable por `anon`. |

| 9 | `pure-packages-no-io-libs`, la regla que garantiza que `money`, `accounting`, `fiscal` e `inventory` no tocan un cliente de base de datos ni HTTP | "el invariante de pureza está cubierto por el gate de fronteras" | **Inerte desde el día que se escribió.** `node_modules` estaba en `exclude`, así que esos módulos no entraban en el grafo, **ninguna arista npm existía**, y la regla daba verde por no tener nada que mirar. El invariante nunca estuvo protegido. Detectada en S0.5 al escribir una regla nueva del mismo tipo y comprobar con su variante rota que tampoco disparaba. |
| 10 | `no-dev-dep-in-src`, y el `exclude` corregido del caso 9 | "ya está arreglado: quitamos `node_modules` del `exclude`" | El patrón quedó en `(^|/)(dist|coverage)/`, **sin anclar**, y eso excluye también el `dist/` **interno de las dependencias npm** — donde casi todas publican su entry point. `postgres` se salvaba por exponer `src/index.js`; `vitest` desaparecía del grafo. **El arreglo del caso 9 dejó vivo el mismo fallo un nivel más abajo**, y solo lo destapó el autotest regla por regla. |

**El caso 9 es el más grave de la lista, y por un motivo que no es su alcance:** es la **segunda vez
que `no-unresolvable` tapa este patrón dentro del gate que existe para detectarlo**. En el caso 1
fue lo único que delató que `dependency-cruiser` no resolvía nada; aquí fue lo que hizo *parecer*
cubierta una violación que la regla concreta no veía. Un control de seguridad que salva la
situación dos veces seguidas no es una red: es la señal de que las reglas que debería respaldar no
se están comprobando.

**Y la generalización, que es lo que hay que llevarse:** *un gate compuesto no está vivo porque el
conjunto pase.* Veintidós reglas en verde pueden ser veintiuna vivas y una muerta, y desde fuera se
ven igual. Cada regla tiene que demostrar que dispara, con su propia violación. Es lo que hace
`pnpm boundaries:selftest`, que al escribirlo encontró **dos** reglas muertas y **una** que solo
parecía viva.

Los casos 8, 9 y 10 son de la peor variante: **no es una defensa ausente, es una defensa que parece estar.**
Un `revoke` escrito, revisado y aprobado, que no revoca nada. Quien lo lea después dará el flanco
por cubierto y no volverá a mirar. Una defensa que no existe se acaba echando en falta; una que
existe y no funciona, no.

Los diez comparten la misma estructura: **se confundió "no observé un fallo" con "no hay
fallo"**, cuando lo que ocurría era que el mecanismo de detección no estaba conectado.

Y en casi todos, lo que lo destapó fue un control que existía **precisamente para desconfiar del
control principal**: la regla `no-unresolvable` en el caso 1, empujar la puerta a propósito en el
3 y el 4.

### Un modo de fallo distinto: la defensa que cierra el camino autorizado

Los ocho casos de arriba comparten estructura. **Este no**, y por eso va aparte — va a repetirse.

Al cerrar la falsificación de `created_by` se fijó `created_by := auth.uid()` sin excepción.
Impecable contra el cliente. Pero `tenants`, `companies` y todo el bloque RBAC **solo se escriben
con `service_role`**, donde `auth.uid()` es `NULL`. El resultado: el 100 % de esas altas quedaban
sin autor, y el servidor no tenía forma de corregirlo.

**Se hizo el campo no forjable y, a la vez, no escribible por el único camino que puede
escribirlo.** La regla que la defensa venía a proteger quedó insatisfacible justo donde más
importaba.

Lo que lo hace peligroso no es el error: es que **no falla**. No hay excepción, la fila se
escribe, la respuesta es `201`. El hueco aparece meses después, en una auditoría, sobre datos que
ya no se pueden reconstruir.

> **Una defensa que cierra el único camino autorizado no es una defensa: es una avería
> silenciosa.** Antes de cerrar una vía, enumera quién la usa legítimamente y comprueba que le
> queda una. Si el camino legítimo es el de servicio, la defensa necesita una entrada para él —
> controlada por el servidor, nunca por el payload.

En Ladino esa entrada es el GUC de transacción `ladino.actor_id`, y su contrato está en
`04_PLATFORM/API_SPEC.md` §Procedencia. Que exista no basta: **si la API olvida fijarlo, el fallo
vuelve a ser silencioso.** Por eso el contrato dice dónde se verifica, y por eso el test que
cuenta es el de integración y no el de la función.

De ahí tres reglas operativas para todo el repositorio:

1. **Ausencia de mecanismo no es prohibición.** Si algo no debe poder hacerse, tiene que fallar
   activamente, no depender de que el método no exista. Está en `CLAUDE.md` §2.
2. **Todo gate necesita un detector de su propia avería.** `no-unresolvable` en
   `dependency-cruiser`; `assert-no-number-in-dts.mjs` sale con código 2 si no encuentra ni un
   `.d.ts`, en vez de felicitarse por no haber encontrado ningún `number`.
3. **Una prohibición no está probada hasta que se ha visto fallar.** Cada regla de frontera se
   verificó inyectando una violación real y comprobando que saltaba la regla esperada. Cada vía
   de serialización se probó empujándola una por una. Una prohibición que nunca se ha visto
   actuar es una hipótesis, no un control.

## Lo que la auditoría de invariantes encontró después

El subagente `accounting-invariants` revisó el paquete ya terminado y con 146 casos en verde.
Encontró **siete defectos que pasaban toda la suite** y producían registros indefendibles. Los
dos peores confirman que el patrón de la sección anterior no se agota:

- **La tasa se persistía sin forma canónica ni cota.** `fx_rate` salía de `Decimal.toString()`,
  así que una tasa derivada —la inversa de 3 son 0.333… periódico— se guardaba con 50 decimales,
  Postgres la truncaba a `0.33333333`, y quien recalculase obtenía **33 millones de VES de
  diferencia**. ADR-0013 dice `numeric(24,8)` "para todo monto **y toda tasa**"; el código lo
  aplicaba solo a los montos. Ahora `makeFxRate` rechaza tasas que no caben, `toMonetaryFact`
  rechaza tasas derivadas con `RATE_NOT_PERSISTABLE`, y `fx_rate` se emite canónico.
- **`RoundedMoney` es una `interface`**, no una clase de constructor privado. Se podía fabricar
  a mano uno cuyo `value` no tuviera nada que ver con su `preRound`, y `toMonetaryFact` lo
  aceptaba. El puente único tenía una entrada lateral. Ahora `isRoundingOf` comprueba que el
  valor sea el redondeo de su propio pre-redondeo bajo su propia política.

Efecto secundario deseable: con las tasas acotadas a 8 decimales y los importes a 24 dígitos
significativos, los productos no pasan de 33 dígitos. **La linealidad de `convert` deja de
depender de que los generadores usen tasas cortas y pasa a ser un teorema** dentro del dominio
construible.

Los otros cinco: política de redondeo sin identificador aceptada, `Roundable` estructural que
dejaba salir un `Money` con moneda fuera del registro, `roundForCurrency` lanzando en vez de
devolver `Result`, `allocate` sin comprobar su postcondición, y un comentario que afirmaba
`FIRST_LINE` cuando el algoritmo es mayor-resto (con pesos `[1,2]` el céntimo cae en la segunda
línea, y los tests no lo veían porque solo usaban pesos iguales).

**Lección añadida:** una suite verde escrita por quien implementa comparte sus puntos ciegos.
Los siete defectos estaban en el espacio entre lo que el autor pensó probar y lo que el sistema
puede hacer. Una revisión independiente con mandato de buscar el fallo, no de confirmar el
acierto, es parte del gate — no una formalidad al final.

### Límites conocidos que quedan anotados

- `MonetaryFact` **no lleva `policy.id`**, mientras `MONEY_AND_ROUNDING_SPEC.md` §5 dice que se
  persiste junto al importe. ADR-0020 fija siete campos y añadir un octavo es una decisión de
  contrato, no de implementación. Pendiente de resolver antes de S0.3, que es quien creará las
  tablas.
- Más allá de 50 dígitos significativos `decimal.js` redondea en silencio. `ExactMoney` no tiene
  cota de magnitud que lo haga improbable. Sin test ni guardia.
- `allocate` rechaza pesos negativos, pero una factura con línea de descuento es un vector de
  signo mixto. `packages/fiscal` se lo va a encontrar.
- El oráculo BigInt de P5e compara a 10⁻²⁰: una corrupción en los dígitos 21 a 50 pasaría verde.

## Verificación

- `packages/money/test/no-leak.test.ts` — 13 casos que empujan cada puerta: `JSON.stringify`,
  spread, `Object.entries`/`keys`/`values`, `Object.assign`, `structuredClone`, y las mismas
  sobre `RoundedMoney` entero (que arrastra `preRound`).
- `packages/money/test/exact-algebra.test.ts` — el álgebra de `ExactMoney`, que es la que
  recorren `multiply` y `convert` por dentro.
- P25 con igualdad exacta y el contraejemplo `0.00000001 × 0.5` como test con nombre.
- P27 con dos casos de `FACT_ROUNDING_MISMATCH`: un `RoundedMoney` de otra conversión y uno en
  otra moneda.
- Revisión a los tres meses: si en `packages/accounting` o `packages/fiscal` aparece código que
  convierte `ExactMoney` a `Money` con una política inventada en el sitio en vez de recibida, la
  separación no está cumpliendo su función y hay que revisar el diseño, no el código.
