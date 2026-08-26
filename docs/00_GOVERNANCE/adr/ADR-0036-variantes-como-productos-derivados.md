# ADR-0036 — Variantes de producto como productos derivados, no como dimensión de existencias

- **Estado:** Aceptado
- **Fecha:** 2026-08-26
- **Impacto fiscal:** NO

## Contexto

Una tienda de ropa vende «camisa azul» en tallas S, M, L. Hay dos formas de modelarlo y la elección
es estructural, difícil de revertir y toca casi todo el sistema:

- **(a) Variante como dimensión de existencias:** un producto «camisa azul» y `stock_balances` gana
  una columna `variant` (o una tabla `product_variants` a la que apunta cada balance).
- **(b) Variante como producto derivado:** cada talla ES un producto, con su SKU, su precio y su
  costo; un `product_template` los agrupa.

## Decisión

**(b): cada variante es un producto.** `product_templates` + `products.template_id` +
`products.attributes` (`{"talla":"M","color":"azul"}`). Sin template, un producto es autónomo, que
es el caso de la bodega normal y sigue siendo el caso por defecto.

Las razones, en orden de peso:

1. **`stock_balances` no gana una dimensión.** Su clave ya es
   `(company, almacén, producto, lote)`; añadir variante la hace de cinco y obliga a revisar el
   trigger de aplicación, el bloqueo de posición, la reconciliación, el índice único y todas las
   consultas. La opción (a) mete la complejidad **en la tabla más caliente del sistema**, que es
   justo donde no se quiere.
2. **El motor de precios sigue funcionando sin cambios.** `price_list_items` referencia
   `product_id`. Con (b), la M y la L tienen precios distintos sin tocar ADR-0032. Con (a), toda
   lista de precios necesitaría también la variante — y el `EXCLUDE` de vigencias, y `price_at()`.
3. **El costeo por variante es natural.** Cada talla tiene su promedio móvil porque cada talla es
   una posición. Con (a) habría que decidir si el promedio es del padre o de la variante, y las dos
   respuestas son defendibles, que es la peor señal posible.
4. **El código de barras es de la variante, no del producto.** Un escáner lee «camisa M azul», no
   «camisa azul». `products.barcode` ya es único por company: con (b) funciona tal cual.
5. **El documento fiscal factura una variante.** Copia SKU y descripción del producto (R-05); con
   (b) no hay nada que decidir.

Lo que el template aporta: agrupar en la UI, buscar, construir el formulario de alta
(`attribute_keys`) y **agregar el kardex** — `platform.stock_by_template()` desglosa por variante y
lleva el total del template al lado, que es lo que pide una pantalla de ropa.

Invariantes forzados: los atributos son un objeto **plano** de texto→texto; una variante declara
**exactamente** los ejes que su plantilla dice, ni uno menos ni uno más (LAD47); y dos variantes del
mismo template no pueden tener los mismos atributos — dos «M azul» con dos SKU serían dos
existencias y nadie sabría cuál usar.

## Consecuencias

- Positivas: nada del núcleo cambia; precios, costeo, código de barras y facturación funcionan sin
  saber que las variantes existen. Un cliente sin variantes no paga nada por ellas.
- Negativas: **un catálogo con muchos ejes explota en filas** — 5 tallas × 8 colores son 40
  productos, y el alta masiva necesitará una pantalla que los genere (no construida). Cambiar el
  nombre comercial obliga a tocar N productos, o a leerlo del template. Y `attributes` es `jsonb`:
  el CHECK acota su forma, pero el vocabulario de valores («azul» vs «Azul») no está normalizado —
  si eso duele, la evolución es una tabla de valores por eje, que no rompe nada de lo escrito.
- Revertir: caro. Es la clase de decisión que este ADR existe para no tener que retomar.

## Verificación

pgTAP 020: una talla no se mueve como si fuera otra (5 en la M, 7 en la L, costos 50 y 60);
`stock_by_template` desglosa dos filas y ambas llevan el total 12; atributos duplicados, incompletos,
con un eje inventado, sin plantilla o anidados — todos rechazados.
