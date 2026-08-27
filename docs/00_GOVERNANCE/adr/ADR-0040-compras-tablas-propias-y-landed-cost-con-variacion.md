# ADR-0040 — Compras: tablas propias, tres documentos, y landed cost tardío como VARIACIÓN

- **Estado:** Aceptado
- **Fecha:** 2026-08-27
- **Impacto fiscal:** SÍ (libro de compras, crédito fiscal, costo de inventario)
- **Aplica:** `PURCHASES_AND_AP_SPEC.md`, `IMPORTS_PURCHASES_SPEC.md`, ADR-0034 (costeo)

## Contexto

Compras es la contraparte de ventas, pero **no es su espejo**. Tres asimetrías la separan, y las
tres tienen consecuencias de esquema:

1. **Nosotros no emitimos la factura de compra: la recibimos.** Trae el correlativo y el número de
   control **del proveedor**. No hay nada nuestro que numerar.
2. **El ciclo son tres documentos que llegan en momentos distintos**: la orden compromete, la
   recepción mueve stock, la factura crea la deuda. Entre la recepción y la factura pueden pasar
   días, y el inventario no espera al papel.
3. **El costo real no se conoce en la recepción.** Flete, aduana y transporte llegan después, y son
   parte del costo de la mercancía.

## Decisión

### 1. Tablas PROPIAS, no `documents` con un `kind` más

`purchase_orders`, `goods_receipts`, `supplier_invoices`, `supplier_credit_notes`, cada una con sus
líneas. **No** se reutiliza `documents`.

El argumento no es la limpieza conceptual, es un trigger: `platform.assert_document_issuance()`
valida **nuestra** numeración fiscal contra el régimen vigente de la empresa. Meter ahí una factura
de proveedor obliga a exceptuar tres `kind` nuevos dentro de la función — y **un trigger compartido
con casos especiales se aplica mal**. Es la lección de S0.4, escrita en `CLAUDE.md`, y aquí el
trigger que se llenaría de excepciones es precisamente el que impide emitir sin régimen.

El coste alternativo era peor: `documents.customer_id` es `NOT NULL` con FK a `customers`, y
acomodar compras exigía debilitarlo a nullable con un `CHECK` por `kind`. Se habría cambiado una
garantía **activa** sobre todas las ventas ya existentes para hospedar un módulo nuevo.

Se paga duplicación de forma —columnas de ADR-0020 repetidas, triggers append-only repetidos— y se
paga a gusto: **la duplicación es visible y auditable; un trigger fiscal con agujeros no lo es.**

### 2. El correlativo del proveedor es un CAMPO, no un rango nuestro

`supplier_invoices` guarda `supplier_document_number` y `supplier_control_number` como **texto**, no
como `bigint`: son datos de otro emisor, con su formato, y normalizarlos sería reinterpretar el
documento de un tercero. Van al libro de compras tal como el proveedor los emitió.

Para el proveedor extranjero, `supplier_control_number` es `NULL` y `supplier_document_ref` lleva la
referencia de su documento (invoice number, B/L, lo que traiga). El `CHECK` lo obliga: **o número de
control, o referencia de documento origen, nunca ninguno de los dos.**

### 3. Estado de la orden, derivado y no escrito a mano

`pendiente → parcial → completa → cerrada`. Los tres primeros los **calcula** una función sobre lo
recibido (`platform.purchase_order_progress`), no los escribe el caller: un estado guardado a mano
diverge de las recepciones en la tercera recepción parcial. `cerrada` sí es un acto explícito —
cerrar una orden con saldo pendiente es una decisión, no un cálculo.

### 4. El costo funcional se fija en la RECEPCIÓN

Con los siete campos de ADR-0020 por línea y la tasa vigente **a la fecha de la recepción**, no de
la orden ni de la factura. La orden es una intención y la factura es un papel: el momento en que el
inventario incorpora costo es cuando la mercancía entra.

### 5. Landed cost: tres métodos de prorrateo, congelados al aplicar

`by_value`, `by_weight`, `by_units`, elegidos por gasto. El prorrateo se calcula una vez, se
persiste por línea (`landed_cost_allocations`) y no se recalcula al leer.

El **residuo del redondeo** va a la línea de mayor base, elegido de forma determinista (mayor base,
desempate por `line_number`). No es cosmética: sin una regla explícita, la suma de lo asignado no
cuadra con el gasto y el `CHECK` que lo comprueba —que existe— rechazaría la operación.

`by_weight` exige que **todas** las líneas afectadas tengan peso. Prorratear por peso ignorando las
líneas sin peso repartiría el flete entre parte de la mercancía y encarecería de más lo que sí pesa.
Si falta un peso, falla (LAD55).

### 6. Landed cost TARDÍO: variación declarada, nunca prorrateo sobre lo que queda

Es la decisión que más dinero mueve y la que más fácil habría sido hacer mal.

Cuando el gasto llega **después** de que parte de la mercancía ya se vendió, hay dos caminos:

- **Prorratear todo el gasto sobre las unidades que quedan.** Es lo que hace medio mercado y es
  **mentira**: encarece unidades que no incurrieron en ese costo, y el margen de las ventas
  siguientes sale mal. El error se propaga a todas las ventas posteriores del producto, que es
  exactamente lo que este módulo tiene que no hacer.
- **Repartir el gasto entre TODAS las unidades recibidas, llevar al inventario solo la parte de las
  que siguen en existencia, y reconocer el resto como VARIACIÓN DE COSTO** — un gasto del período,
  no un mayor valor del inventario.

Se elige el segundo. Concretamente:

```
costo_unitario_landed = gasto_asignado_a_la_línea / cantidad_recibida
parte_inventario      = costo_unitario_landed × cantidad_que_queda
parte_variación       = gasto_asignado_a_la_línea − parte_inventario
```

`parte_inventario` entra como **revalorización**: un movimiento de kardex de valor sin cantidad, que
recalcula el promedio hacia adelante. `parte_variación` se registra en `landed_cost_variances` con
su cuenta contable **«Variación de costo por landed cost tardío»**, que va a resultados.

Las unidades ya vendidas **conservan el costo con el que se emitieron**. No se reescribe una salida
de kardex, no se recalcula un margen pasado: `inventory_moves` es append-only y una venta emitida es
un hecho cerrado.

> El asiento contable automático espera al motor contable. **El modelo y el cálculo no**: la
> variación se calcula, se persiste con su importe y su cuenta, y queda esperando a que alguien la
> contabilice. Un número que no se calcula hoy es un número que nadie reconstruye mañana.

### 7. El IVA de compra: crédito o costo, derivado del contribuyente

Para una empresa **contribuyente ordinario**, el IVA de la compra es crédito fiscal y **no entra al
costo del inventario**. Para una **contribuyente formal**, no es recuperable y **sí** es costo.

Se deriva de `companies.taxpayer_type_code`, no se configura: es una consecuencia del régimen de la
empresa, no una preferencia, y ofrecerlo como opción invitaría a marcarlo mal.

> `VALIDAR-TRIBUTARIO`, anotado en el código donde se aplica y no solo aquí. `IMPORTS_PURCHASES_SPEC`
> avisa: «no mezclar impuestos recuperables con costo sin política contable». Esta ES la política, y
> necesita confirmación antes de producción.

### 8. Matching de tres vías: precio con umbral, cantidad sin él

- **Precio unitario por línea**: se admite diferencia dentro de `price_tolerance_pct` (config por
  empresa, default 5 %). Fuera del umbral, exige `purchase.price_variance.approve`.
- **Cantidad: sin tolerancia.** Una diferencia de cantidad no es un redondeo — es una recepción
  parcial que falta o un error. Se resuelve recibiendo lo que falta o corrigiendo explícitamente, no
  tolerándola.

Es la única política de compras que va como configuración por empresa
(`purchase_settings.price_tolerance_pct`). El resto son reglas.

## Consecuencias

**Positivas.** El módulo no puede corromper el costeo de ventas por la vía del landed cost tardío,
que era el riesgo real. La duplicación de tablas mantiene ventas y compras evolucionando por
separado. El libro de compras tiene los datos del proveedor sin normalizar.

**Negativas:**

- **Duplicación de forma.** Los siete campos de ADR-0020, los triggers append-only y las policies
  RLS aparecen dos veces. Un cambio transversal —una columna nueva de procedencia— hay que hacerlo
  en los dos sitios, y olvidarse de uno es posible. Mitigación: el test de catálogo de S0.4 recorre
  **todas** las tablas con `tenant_id` y exige el trigger de ancla, así que una tabla nueva sin él
  no pasa.
- **La variación de costo espera a contabilidad.** Hoy se calcula y se guarda; nadie la postea.
  Hasta que exista el motor contable, es un número correcto en una tabla que ningún estado
  financiero lee.
- **`by_weight` puede bloquear una operación legítima** si el maestro de productos no tiene pesos.
  Se prefiere a repartir mal.
- **El estado derivado de la orden cuesta una consulta** en vez de leer una columna. A cambio, no
  puede desincronizarse.

## Alternativas descartadas

- **Reutilizar `documents`** — analizado arriba: exigía exceptuar el trigger de emisión fiscal y
  debilitar un `NOT NULL` vigente.
- **Recepción y factura como un solo documento.** Simplifica y es falso: la mercancía entra días
  antes que el papel, y unificarlos obliga a elegir entre stock tardío o CxP inventada.
- **Recalcular el costo hacia atrás cuando llega el landed cost.** Requiere reescribir salidas de
  kardex ya emitidas: prohibido por ADR-0006, y además reabre márgenes de ventas ya cerradas.
