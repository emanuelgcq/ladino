# Productos, servicios y catálogo


> **Estado de la documentación:** base de ingeniería de Ladino, preparada el 2026-08-07.  
> **Regla de cumplimiento:** ninguna tasa, formato tributario, obligación o interpretación jurídica debe quedar hard-coded sin una fuente normativa versionada. Los puntos marcados `VALIDAR-SENIAT`, `VALIDAR-TRIBUTARIO` o `VALIDAR-LABORAL` requieren confirmación formal antes de producción/homologación.


## Objetivo
Modelar bienes/servicios con atributos operativos, inventario y tributación.

## Entidades
- `products`
- `product_variants`
- `categories`
- `brands`
- `barcodes`
- `lots`
- `serials`
- `bom_components`

## Reglas de negocio
- SKU único por empresa.
- Producto inventariable genera movimientos.
- Servicio no genera stock.
- Categoría tributaria separada del IVA hard-coded.
- Combo/receta puede consumir componentes.

### Los dos interruptores de existencia (I-04, C-07 · ADR-0084)
Solo para bienes; se ponen en el alta, el alta simple y la edición. Son excluyentes.

| Interruptor | Qué hace | Qué NO se puede cambiar después |
|---|---|---|
| «Se arma con otros productos» (`is_composed`) | no lleva existencia: venderlo descuenta los ingredientes de su receta (`PUT /v1/products/:id/recipe`). Sin ingredientes no se vende. Marcarlo o quitarlo exige `product.recipe.manage` además de `product.manage` | un producto con movimientos no se vuelve compuesto; uno que es ingrediente tampoco; **un compuesto que ya se vendió no deja de serlo** (LAD44). Quitar la marca a uno sin vender borra su receta, y el acta (`product.updated`) guarda las líneas borradas (`recipe_removed`) |
| «Lleva lote y vencimiento» (`tracks_lots` + `tracks_expiry`, juntos) | cada entrada pide el código del lote y la fecha en que vence; la venta toma primero lo que vence antes | **con movimientos registrados no se enciende ni se apaga** (LAD38); encenderlo con lotes sin fecha tampoco (LAD73). No admite existencia inicial en el alta simple: entra por «Llegó mercancía» |

En las pantallas de la persona (`pages/negocio`) se lee «Se vence» y «código del paquete»; en
Administración, «Lleva lote y vencimiento».

## Estados / transiciones
draft → active → inactive.

El alta crea en **`active`** salvo que se pida `draft` explícitamente
(2026-09-10). Un producto que nace en borrador no se puede vender ni aparece
en el mostrador, y un alta que responde «creado» dejando algo inservible —sin
decirlo— es una trampa. `draft` sigue siendo el único estado donde `kind`
todavía se puede corregir (LAD33), así que quien necesita esa red la pide.

## Permisos
- inventario administra SKU.
- ventas puede consultar.
- contador aprueba mapeo contable/tributario.

## API / eventos
- `POST /v1/products`
- `POST /v1/products/:id/variants`
- `product.updated`

## Criterios de aceptación
- [ ] No vender SKU inactivo salvo permiso especial.
- [ ] barcode único.
- [ ] Cambio tributario no altera ventas pasadas.

## Casos límite
- talla/color.
- producto por peso.
- lote vencido.
- serial duplicado.
- combo con componentes insuficientes.

## Dependencias
- Inventory
- Pricing
- Tax

## Importación (ADR-0074)

Hallazgos C-01, C-04 y C-05 del recorrido 2026-09-24. Código: `packages/domain/src/product-import.ts`,
rutas en `apps/api/src/routes/products.ts`, worker en `apps/worker/src/importaciones.ts`, pantalla
`apps/web/src/components/importar-productos.tsx`, tabla `product_import_jobs` (migración
`20260928140000_product_import_jobs.sql`, pgTAP 082).

1. **Formato de números declarado (C-01).** Campo multipart `number_format`: `comma_decimal` (por
   omisión, el venezolano: `1.234,50`) o `dot_decimal` (`1,234.50`). `leerNumeroDeclarado` da una de
   tres salidas: la lectura canónica del formato; la del formato contrario **con aviso** cuando es la
   única posible («0.90» con coma decimal); o **rechazo por ambigüedad** cuando la celda admite las dos
   («0.500» con coma decimal: ¿0,5 o 500?). En `.xlsx`, las celdas numéricas se escriben en el formato
   declarado antes de leerse. «2.500» con coma decimal es 2.500 (el formato declarado decide).
2. **Vista previa (C-05).** `POST /v1/products/import/preview` no escribe: devuelve las diez primeras
   filas como se van a guardar, con avisos, y todas las rechazadas con su fila y su motivo. Nada se
   descarta en silencio: la existencia de un servicio se ignora **con aviso**; el costo sin existencia
   (o el de un servicio) se acepta como **costo de referencia** con aviso, y se GUARDA en el producto
   (`products.reference_cost` y `reference_cost_currency`, H11; la moneda referencia `currencies`, A4).
3. **Trabajo (C-04).** `POST /v1/products/import/jobs` solo crea el trabajo (202) con las filas ya
   interpretadas; el mismo archivo (sha256) con el mismo formato devuelve el existente (200,
   `reused: true`) por el único PARCIAL `(company_id, file_hash, number_format) where status <> 'failed'`
   (H1-d): un trabajo fallado no impide volver a subir el archivo. El worker lo procesa una fila
   por transacción, **como el usuario que lo subió**, y en la misma transacción avanza
   `processed_rows` y crece `report`. Dentro del trabajo, el **código** es la llave: si ya existe, la
   fila actualiza el precio (vigencia nueva solo si cambió) y no recarga existencia ni pisa el nombre
   (avisos). `GET /v1/products/import/jobs/{id}` da progreso e informe (creados, actualizados,
   rechazados con motivo). Un fallo inesperado suma `attempts`; al quinto, `failed` con `last_error`.
4. **El camino síncrono** `POST /v1/products/import` sigue (contrato aditivo: `number_format` y
   `warnings` opcionales), con el mismo intérprete, pero **hasta 50 filas**: lo grande va por el
   trabajo, que es lo que usa la web.
5. **Privilegio del worker:** `ladino_worker` puede `SET ROLE ladino_api` (sin heredar) dentro de la
   transacción de cada fila. Enmienda ADR-0031 — ver RISK_REGISTER R-56.

### Revisión de la familia (H1–H11), 2026-09-29

Migraciones: `20260928140100_product_import_jobs_review.sql` y
`20260928140200_reference_cost_needs_its_currency.sql`. pgTAP: 082b.

- **H1: una fila mala no tumba el trabajo.**
  - Los largos de la base (nombre ≤200, código ≤60, código de barras ≤64, categoría ≤100) se
    rechazan en la interpretación, con fila y motivo.
  - Un error de datos de Postgres (clases 22 y 23) en una fila la deja rechazada con motivo legible;
    el savepoint deshace lo que la fila hubiera escrito.
  - `attempts` vuelve a cero cada vez que el trabajo avanza: lo mata una racha de cinco caídas en la
    misma fila, no cinco repartidas.
- **H1-d, decidido por criterio: un trabajo `failed` no bloquea volver a subir el archivo.** El único
  de la llave es parcial (`where status <> 'failed'`) y la resubida crea un trabajo nuevo. Las filas
  con código no se duplican (el código es la llave); las que no tienen código sí se crearían otra
  vez, y la web lo dice. *Alternativa:* reanudar el trabajo fallado.
- **H1, la vista previa dice la verdad:** si el código ya existe, la fila lleva `updates_existing` y el
  aviso «solo actualiza su precio; no cambia ni la existencia ni el nombre». Sin `price_list.manage`,
  avisa además de que un precio distinto se rechazará.
- **H2: actualizar el precio de un código existente exige `price_list.manage`.** Sin ese permiso, la
  fila se rechaza con «Necesitas el permiso para cambiar precios. Pídeselo a quien administra.» y el
  precio no cambia. El alta sigue autorizando su propio precio (§2.8).
- **H3: la guarda exige avanzar de una en una**, y que la entrada nueva del informe sea la de la fila
  que tocaba. `report_chk` es coherencia, no detector de doble proceso (COMMENT ON corregido).
- **H4: `POST /v1/products/import/jobs` exige y honra `Idempotency-Key`.**
  - El hash de la petición es canónico: sha256 del archivo más `number_format`, no el multipart crudo
    con su boundary. Lo hace el middleware con la opción `canonicalHash`.
  - La misma llave con otro archivo da 409 `IDEMPOTENCY_BODY_MISMATCH` (ADR-0076; antes
    `IDEMPOTENCY_KEY_REUSED`, que queda para la misma llave en otro endpoint).
  - La web usa una llave por intento de «Confirmar»: se conserva ante un fallo de red y se estrena
    tras un 4xx.
- **H5:** la vista previa devuelve `warned_rows`, todas las filas con aviso, y la web las lista antes
  de confirmar.
- **H6, decidido por criterio: coherencia por archivo.** Si alguna celda numérica solo se entiende con
  el formato contrario al declarado, las celdas con grupo de miles que en el otro formato serían
  otro número («1.250» con coma decimal) se rechazan como ambiguas. La vista previa devuelve
  `suspected_format` y la web enseña la banda «Tu archivo parece usar …». «1.234,56» no se rechaza:
  no tiene otra lectura. *Alternativa:* detectar el formato por archivo.
- **H7:** las celdas con fórmula del .xlsx (`result` numérico, también la fórmula compartida) se leen
  como número, en el formato declarado.
- **H8, decidido por criterio: el worker adopta `ladino_api`.** Está en ADR-0074 §«Quién procesa el
  trabajo» y en R-56. *Alternativa:* procesar en la API y revocar el GRANT. Métrica: `en_cola`
  (profundidad de la cola) en el log del ciclo del worker.
- **H9:** hay un test de atomicidad (la transacción muere antes del commit: ni producto ni avance), y
  el test del worker solo avanza su propio trabajo.
- **H10:** el worker tiene un presupuesto de 5 s por vuelta (no un número fijo de filas), y cada fila
  lee solo `rows -> processed_rows`.
- **H11, decidido por criterio (§2.12): el costo de referencia se GUARDA en el producto.**
  - Columnas nullables `products.reference_cost numeric(24,8)` y `reference_cost_currency`, juntas o
    ninguna. La moneda va aparte porque un importe sin moneda no dice nada.
  - Se escribe por el trabajo y por el camino síncrono.
  - La ficha lo muestra en solo lectura como «Costo de referencia (importado)».
  - *Alternativa:* guardarlo solo en el informe.

### Re-revisión (A1–A7), 2026-09-29

Migración `20260928140300_import_jobs_backoff_and_currency_fk.sql`; pgTAP 082c.

- **A1.** «El precio ya era ese» se mira SOLO en la lista de destino del detal. `listaDeDestino` (en
  `products.ts`) es la única copia de esa lógica: la usan `ponerPrecioEnLista` para escribir y la
  importación para comparar. Un precio de mayor igual al de la fila ya no cuenta como «ya era ese».
- **A2.** Una fila se rechaza por datos solo si la restricción es de `products_*`,
  `product_categories_*` o `price_list_items_*`, o si el código es 22001, 22003 o 22P02. Todo lo demás
  se relanza y suma `attempts`: un 23503 de otra tabla (por ejemplo `stock_balances_warehouse_fk`) y
  el 23505 de una carrera entre trabajos.
- **A3, decidido por criterio (lo que la persona ve en Excel).** El número de una celda (fórmula o
  simple) se representa con `String(Number(n.toPrecision(15)))`: 15 cifras significativas, como Excel
  (19,99 × 1,16 → «23,1884»; 0,1 + 0,2 → «0,3»). *Alternativa:* rechazar la celda con ruido binario.
- **A4.** `products_reference_cost_currency_fk` → `currencies (code)`.
- **A5.** Backoff exponencial con jitter (el del outbox) tras un fallo que no es de la fila: el
  worker escribe `next_attempt_at` y no toma el trabajo antes de esa hora.
- **A7.** Crear el trabajo deja el audit_event `product.import_job.created` con el nombre y el hash
  del archivo, el formato y el número de filas. La reutilización del mismo archivo no audita.
- **Despliegue:** 140100, 140200 y 140300 van ANTES de levantar la API nueva, porque `PRODUCT_SELECT`
  lee `reference_cost`. Son expand y se pueden aplicar antes del `git pull` (RISK_REGISTER R-62).
