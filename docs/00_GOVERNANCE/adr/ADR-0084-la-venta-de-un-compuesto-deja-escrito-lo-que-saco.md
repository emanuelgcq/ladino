# ADR-0084 — La venta de un compuesto deja escrito lo que sacó

- **Estado:** Aceptado — ADR aplicado según la respuesta del dueño del 2026-09-28 (§2.12, I-04)
- **Fecha:** 2026-10-04
- **Impacto fiscal:** NO (costeo interno y kardex; ningún documento fiscal cambia de contenido)

## Contexto

ADR-0035 decidió las recetas: un producto compuesto no lleva existencia propia, y consumirlo saca
sus ingredientes. Lo construido hasta la ola 4 era el esquema (`products.is_composed`,
`product_recipes`) y un consumo suelto por pantalla. La VENTA trataba al compuesto como «no
inventariable»: emitía la línea sin mover un ingrediente y sin costo, y ningún invariante lo
miraba (I-04 del recorrido 2026-09-24).

La respuesta del dueño (RESPUESTA §2.12) manda construir la mitad que faltaba: «vender el compuesto
descuenta los ingredientes al costo promedio de cada uno; el compuesto no lleva existencia propia».
Al construirlo aparece una decisión que ADR-0035 no tomó y que es estructural: **dónde queda escrito
qué sacó cada línea vendida.** Hace falta saberlo después, por tres motivos que no se resuelven
leyendo la receta:

1. la receta CAMBIA; lo vendido no puede cambiar con ella;
2. la misma venta puede llevar el mismo producto suelto y como ingrediente (pan suelto y el pan de
   la arepa): las salidas de kardex cuelgan del documento, no de la línea, y no se distinguen;
3. la devolución parcial tiene que reingresar lo que salió por ESA línea, al costo con que salió y
   al mismo lote, y saber cuánto volvió ya.

Restricciones: el kardex es append-only (regla 4 del equipo) y su trigger de costeo
(`apply_inventory_move`) lo comparten todas las salidas; el valor de un movimiento va al céntimo
(ADR-0075 §7) y el costo unitario a 8 decimales; un equipo de una persona.

## Opciones consideradas

1. **`cost_snapshot` en la línea vendida (= Σ de las salidas / cantidad).** A favor: los lectores de
   margen que ya existen (`cost_snapshot × cantidad`) funcionarían sin tocarlos. En contra: no es
   exacto —53,00 / 3 = 17,66666667 y × 3 = 53,00000001: el margen de la línea dejaría de coincidir
   con el asiento de costo de ventas, que suma las salidas—; exige un UPDATE de la línea ya emitida
   (el costo se conoce después de sacar la mercancía); y no resuelve ninguno de los tres motivos de
   arriba: no dice qué movimiento es de qué línea ni qué receta se usó.
2. **Una columna `source_line_id` en `inventory_moves`.** A favor: sin tabla nueva. En contra: toca
   el insert del kardex y su trigger de costeo, que comparten todas las salidas; no guarda la receta
   del momento; y el reingreso de la devolución necesitaría otra columna más («revierte a»).
3. **No guardar nada: repartir la devolución por producto leyendo la receta de hoy.** En contra: con
   el mismo producto suelto y como ingrediente no se sabe qué salida es de quién, y una receta
   cambiada reingresaría otra cosa de la que salió.
4. **Una tabla propia, `sale_line_components`, append-only: una fila por movimiento de kardex que
   la línea produjo.** A favor: resuelve los tres motivos, no toca el kardex, y da al invariante
   algo independiente que comparar. En contra: es irreversible con datos y los lectores de costo
   tienen que aprender a sumarla.

## Decisión

**Opción 4.** `public.sale_line_components` (migración 20261005130000):

- una fila `out` por cada salida de ingrediente que produce la línea vendida de un compuesto, con
  la cantidad y el valor del movimiento (copiados, en positivo) y **la receta de ese momento**
  (`recipe_quantity`, `unit_factor`); una fila `back` por cada reingreso de una devolución, que dice
  qué salida revierte (`reverses_move_id`) y de qué devolución (`return_id`);
- append-only con las dos capas (trigger `reject_mutation` y policies `using (false)` escritas),
  sin TRUNCATE, con ancla de tenant, RLS por operación y la API como único escritor;
- una guarda (`sale_line_component_guard`) exige que la fila diga la verdad sobre su línea, su
  documento y su movimiento, y `unique (move_id)`: un movimiento pertenece a UNA línea.

**El costo de la línea vendida de un compuesto es la SUMA de sus filas `out`**, cada una al céntimo
y al costo promedio de su ingrediente. La línea sigue con `cost_snapshot` nulo, a propósito. Quien
lee margen suma la tabla:

- el asiento de costo de ventas ya suma los movimientos del documento (ADR-0060 §1): no cambia;
- «lo que gané» del Inicio (`apps/api/src/routes/negocio.ts`): la venta resta Σ `out` de la línea y
  la devolución devuelve Σ `back` de esa devolución y esa línea (segunda ronda, C1);
- el reporte de margen (`packages/domain/src/reports.ts`, `marginReport`) aplica la misma regla,
  leyendo la tabla directamente (lo escribió la familia de reportes, con su E2E). Los dos lectores
  leen el costo EN EL MISMO ORDEN: primero el `cost_snapshot` de la línea; si no lo hay, la suma
  de `sale_line_components`; si tampoco, un servicio no tiene costo y lo demás es «venta sin
  costo». No hay una función compartida: son dos consultas con la misma regla, y las coteja
  quien las revisa.

**La devolución** reingresa en proporción ACUMULADA (`debeHaberVueltoDe`): tras devolver `d` de `v`,
de cada salida debe haber vuelto `round8(q × d / v)` y `céntimo(valor × d / v)`; cada devolución
reingresa la diferencia con lo que ya volvió, y la última deja la venta en cero exacto.

**La anulación** repone todas las salidas del documento por el camino de siempre (ADR-0061 §2).
Segunda ronda: **una venta con una devolución confirmada ya no se anula** (422): la anulación
reponía también lo que la devolución ya había reingresado —la mercancía entraba dos veces— y
`annulled_stock_gaps` no lo veía, porque los reingresos de la devolución cuelgan de la devolución.
Vale para toda venta, no solo la de un compuesto. Decidido por criterio (RESPUESTA §2.16: lo más
estrecho, ruidoso y reversible; es la misma regla que ya tenía la factura de retiro corregida con
su nota). Alternativa descartada: que la anulación reponga solo lo que no ha vuelto; exige además
decidir qué pasa con la nota de crédito o el recibo de devolución ya emitidos y con el asiento, que
se reversaría entero sobre una venta ya corregida en parte. **Queda para que el dueño la confirme.**

Tercera ronda, la misma regla por la otra puerta: **una devolución en borrador no se confirma
contra una venta anulada** (422 «Esa venta se anuló: la devolución ya no se puede confirmar»).
Con la devolución en BORRADOR la venta sí se anula —y repone todo—; confirmar después reingresaba
otra vez (reproducido: `confirmReturn` devolvía 200, y las dos a la vez daban 200 y 200).
`confirmReturn` lee ahora el origen con `for update` y exige que siga emitido, igual que
`createReturn` al crear. Es el mismo candado, sobre el mismo documento, que `annulInvoice` toma
lo primero: anular y confirmar a la vez se serializan y gana uno solo. Alternativa descartada:
cancelar los borradores al anular; escribe sobre devoluciones que la persona no tocó, y no cierra
la carrera sin el candado.

**El pedido con un compuesto** (tercera ronda; decidido por el dueño, opción a): al confirmar un
pedido, **la línea de un compuesto no reserva** —se salta el candado de posición, la lectura del
disponible y la fila de `stock_reservations`—; la existencia de sus ingredientes se comprueba al
FACTURAR, con la receta de ese momento. Antes el pedido no se podía confirmar nunca (409 «quedan
0»: el disponible de un compuesto es siempre cero). La confirmación del pedido lo dice.
Alternativa descartada: reservar ingredientes × receta; mete en `stock_reservations` productos que
no están en el pedido y se desalinea si la receta cambia entre confirmar y facturar.

**Los bordes, lo más estrecho** (ya en la enmienda de ADR-0035, que ahora apunta aquí): un
ingrediente no es otro compuesto; un producto con movimientos no se vuelve compuesto; un compuesto
vendido no deja de serlo; un compuesto sin ingredientes no se vende. Segunda ronda: **marcar o
quitar «compuesto» exige `product.recipe.manage`** además de `product.manage` (el encargado tenía
el segundo y no el primero: podía dejar un producto que no se vende y no podía completarlo).
Alternativa descartada: dar `product.recipe.manage` al rol `store_manager`; mueve los permisos de
un rol de sistema y eso lo decide el dueño.

## El invariante

`platform.composite_sale_gaps(empresa)` — cero filas, sin lista de excepciones:

| Rama | Qué dice | Variante rota (pgTAP 137) |
|---|---|---|
| `sin_salidas` | línea vendida de un compuesto sin ninguna fila `out` | sí (y en el E2E) |
| `fuera_de_proporcion` | Σ `out` ≠ receta de ese momento × vendido | sí |
| `movimiento_no_coincide` | la fila no dice lo que su movimiento | sí |
| `devuelto_de_mas` | de una salida volvió más de lo que salió | sí (segunda ronda): la guarda de la fila NO suma; solo lo ve el invariante |
| `compuesto_con_existencia` | un compuesto con movimientos propios | sí (segunda ronda), por el lado que LAD43 no cubre; LAD43 se prueba aparte |

**Margen ↔ `sale_line_components`: con esto basta, y por qué.** El invariante ata cada fila a su
movimiento de kardex (cantidad y valor), y el asiento de costo sale de esos mismos movimientos:
si la tabla mintiera, daría `movimiento_no_coincide`. Lo que NO cubre es que un LECTOR sume mal la
tabla; eso no es un hecho de la base y lo cubren los E2E de cada lector con cifras exactas. No se
añade una rama.

## Consecuencias

- **Positivas.** La receta puede cambiar sin tocar lo vendido; la devolución parcial es exacta en
  cantidad y en valor; el margen de un compuesto es exacto al céntimo e igual al del mayor; hay un
  observador independiente de la pieza que escribe.
- **Negativas y deuda que aceptamos.**
  - Todo lector de costo por línea tiene DOS reglas: `cost_snapshot × cantidad` para la línea
    suelta y Σ de la tabla para la del compuesto. Un lector nuevo que olvide la segunda verá el
    compuesto sin costo, en silencio. Hoy son dos lectores; no hay un gate que encuentre un tercero.
  - Una venta de un compuesto con k ingredientes hace k salidas y k filas más: es más lenta que una
    línea suelta (medido en el E2E: una venta con devoluciones pasa de 2 s con la base compartida).
  - Un pedido confirmado NO compromete los ingredientes de sus compuestos: entre confirmar y
    facturar otro puede venderlos, y la factura dirá entonces cuál falta. Es el precio de no
    reservar por receta.
  - El consumo suelto de receta sigue existiendo y no escribe en la tabla (no es una venta): usado
    además de la venta descuenta dos veces. La pantalla ahora lo avisa; no lo impide.
  - Anular después de devolver ya no es posible: quien se equivocó en una venta ya devuelta en
    parte tiene que devolver el resto.
- **Qué habría que cambiar para revertirla.** Sin datos: `drop` de la tabla, de la guarda y del
  invariante, y devolver las dos funciones de guarda de producto a su cuerpo anterior. **Con datos
  no se revierte**: la tabla es el único vínculo entre la línea vendida y las salidas de sus
  ingredientes; sin ella la devolución parcial no sabe qué reingresar ni a qué costo, y el margen de
  esas ventas se queda sin costo. Los movimientos y asientos que las ventas produjeron no se
  deshacen en ningún caso.

## Despliegue

Las tres migraciones van juntas, JUSTO DESPUÉS del `git pull` y antes de arrancar la API nueva
(dependen de 20261003140000, que deja `apply_inventory_move` al céntimo; la API saliente no escribe
la tabla ni conoce LAD73):

1. `20261005130000_a_composite_sale_takes_its_ingredients` — la tabla, la guarda, el invariante.
2. `20261005130100_expired_is_judged_by_the_caracas_day` — parchea `apply_inventory_move` leyendo
   su definición viva; **su fichero no enseña el cuerpo que deja**. En el ensayo en seco:
   `pg_get_functiondef` antes y después, y que la única diferencia sea la expresión de LAD46 (la
   receta completa está en la cabecera de la 130200).
3. `20261005130200_a_lot_that_expires_is_born_with_its_date` — falla si hay lotes sin fecha de
   productos que vencen: correr antes la consulta de su cabecera.

Riesgo de despliegue que no se pudo medir desde aquí: si en producción ya hay ventas emitidas de
productos marcados `is_composed`, `composite_sale_gaps` las dará como `sin_salidas` (no sacaron
nada). El invariante no las perdona: se decide con el dueño qué se hace con ellas antes de
desplegar. Consulta: `select * from platform.composite_sale_gaps(<empresa>)` tras aplicar la 130000
en el ensayo.

## Verificación

- pgTAP 137 (31 aserciones, las cinco ramas del invariante con su variante rota) y 138 (15).
- E2E `e2e-compuestos-y-lotes` (17) y `e2e-compuestos-segunda-ronda` (14): vender, devolver por
  partes, anular, dos ventas simultáneas, el reintento con la misma llave, la receta fraccionaria
  con conversión de unidad, y «lo que gané» exacto en cada paso.
- Unitarios `packages/domain/test/compuestos.test.ts`: N devoluciones parciales suman exacto.
- `composite_sale_gaps` en `scripts/recorrido/invariantes.sql`: cero en E1–E3 en cada recorrido.
- Revisar en la primera semana con compuestos reales en producción: el invariante en cero por
  empresa y el margen del Inicio contra el estado de resultados.
