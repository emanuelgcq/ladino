# ADR-0035 — Productos compuestos: recetas de ingredientes y unidades fraccionadas

- **Estado:** Aceptado
- **Fecha:** 2026-08-26
- **Impacto fiscal:** NO (costeo interno; el COGS lo consumirá contabilidad con asiento propio)

## Contexto

Un restaurante vende arepas y no almacena arepas: almacena harina, leche y queso. El producto que
se vende no es el que se descuenta. Y la unidad tampoco coincide: la harina se compra por
kilo y la receta la mide en gramos. Ninguna de las dos cosas la contempla el módulo de inventario
de ADR-0034, donde vender siempre descuenta el mismo producto que se vende, en su propia unidad.

Es la primera vez que **el costo de lo vendido se calcula sobre varios productos a la vez**, así
que va con rigor máximo aunque el módulo sea una extensión.

## Decisión

### El compuesto no tiene existencias propias

`products.is_composed`. Un compuesto se vende pero **no se almacena**: no admite movimientos de
inventario en ninguna dirección (LAD43), no lleva lotes, ni seriales, ni vencimiento. Vender uno
genera **una salida por ingrediente**, ligadas entre sí por `inventory_moves.source_document_id`.

Eso no puede ser un `CHECK` —requiere mirar `products`, y un CHECK no admite subconsulta— así que
vive en `platform.apply_inventory_move()`, junto a las demás reglas del movimiento. Y se cierra el
flanco que no toca `product_recipes`: marcar compuesto un producto que ya es ingrediente, o que ya
tiene movimientos, y desmarcar uno que tiene receta (LAD44).

### Costo: la suma de lo que costaron las salidas reales

El costo de un compuesto **no** es un número guardado ni una estimación aplicada: es la suma de los
importes que el costeo por promedio produjo para cada ingrediente, cada uno con su propia posición
y su propio promedio móvil. Existe además `platform.recipe_cost()` para **enseñar** un costo
estimado en pantalla antes de vender; es explícitamente otra cosa, y devuelve `NULL` en cuanto una
línea no se puede convertir — un costo a medias sería peor que ninguno.

### Anidamiento: NO, en esta iteración, y forzado

Un ingrediente no puede ser a su vez compuesto (LAD44). Explotar recetas anidadas exige recursión
**con detección de ciclos y tope de profundidad**, y convierte el costeo de «suma de hijos» en una
explosión recursiva: otra bestia, con su propio rigor máximo, que no se cuela de contrabando en una
extensión.

- **Coste hoy:** una salsa base usada en tres platos se repite como líneas en las tres recetas.
- **Levantarlo después no migra datos:** se quita la comprobación del trigger y la explosión pasa a
  ser un CTE recursivo. Las recetas ya escritas siguen siendo válidas.

### Unidades: conversión dirigida, sin derivar la inversa

`unit_conversions(from, to, factor)`. La inversa **no se deriva**: 1/3 no cabe en `numeric(24,8)`,
y una conversión que se altera al persistirse deja de ser reproducible — el mismo argumento que
ADR-0020 da para las tasas derivadas. Quien necesite los dos sentidos carga las dos filas.

**Sin conversión, el consumo se RECHAZA** (LAD45 / `UNIT_CONVERSION_MISSING`). El sistema no
adivina cuántos gramos tiene un litro: eso es densidad, y depende del producto. El movimiento se
persiste **siempre en la unidad del producto**; la receta se expresa en la que le convenga al cocinero.

### El redondeo va al final, y eso tiene una consecuencia

`cantidad × factor × unidades` se calcula como **un solo producto exacto** y se redondea a 8
decimales una vez, al final. Redondear antes acumula error por línea y por venta.

**Consecuencia, encontrada por el property test:** vender 12 arepas de una vez y venderlas de una en
una pueden consumir cantidades distintas, en menos de `(n+1)/2` unidades de 10⁻⁸. La linealidad
exacta **es imposible** a escala finita: o se redondea una vez (y el total depende de si la venta
fue en bloque) o se redondea por unidad (y el error se acumula en cada una). Se elige lo primero
porque el error no crece con el volumen del día, solo con el tamaño de la venta — y porque con
cantidades de receta reales (200 g de una harina que se lleva en kg) el producto es exacto y la
diferencia es cero.

## Consecuencias

- Positivas: el restaurante entra sin tocar el motor de costeo; el kardex sigue siendo de productos
  almacenables; `source_document_id` deja el rastro que mañana usará la factura de venta.
- Negativas: sin anidamiento, las sub-recetas se repiten; una conversión que falta bloquea la venta
  hasta que alguien la cargue (deliberado: la alternativa es descontar mal); dos ventas iguales
  ejecutadas distinto pueden diferir en 10⁻⁸ de ingrediente.
- Revertir: `drop` de `product_recipes` y `unit_conversions` mientras estén vacías; las banderas de
  `products` se quedan sin uso.

## Verificación

pgTAP 020: la receta en gramos descuenta kilos (10 kg − 12 arepas × 200 g = 7,6 kg, a mano);
el costo del compuesto es 117,00 calculado a mano; recibir **y** sacar stock del compuesto mueren con
LAD43; la variante rota quita la validación y el stock del compuesto entra; `recipe_cost` devuelve
`NULL` con una línea sin conversión. `packages/inventory`: cuasi-linealidad con su cota, determinismo,
«sin conversión no se explota» y la suma exacta del costo total.
