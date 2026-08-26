# ADR-0034 — Inventario: promedio ponderado móvil, kardex append-only materializado y transferencia atómica

- **Estado:** Aceptado
- **Fecha:** 2026-08-26
- **Impacto fiscal:** NO (costeo interno; ningún documento fiscal. El COGS lo consumirá contabilidad
  con asiento propio — invariante 8 de `ACCOUNTING_INVARIANTS_TESTS.md`)

## Contexto

`INVENTORY_SPEC.md` es un esqueleto: exige «kardex append-only», «balance deriva/reconcilia
movimientos», «no stock negativo salvo política explícita», «transferencia usa salida+entrada
vinculadas», «costeo reproducible» y «kardex reproduce balance» — y no fija método de costeo,
política de negativo, semántica de «en tránsito» ni la frontera lotes/seriales/BOM (grep en
`docs/`: cero apariciones de «promedio», «FIFO», «in_transit», «allow_negative»). ADR-0006 nombra
`inventory_moves` entre las tablas append-only con dos capas; ADR-0020 exige siete campos por
importe y «moneda funcional por empresa», que no existía en el esquema. MONEY_AND_ROUNDING_SPEC
§6 tenía cuatro contextos de redondeo y el costo no cabía en ninguno. Es el primer módulo donde el
dinero entra en una tabla append-only. Las decisiones 1–6 las fijó el usuario; el resto es de este
ADR.

## Decisión

### Costeo: promedio ponderado móvil, en moneda funcional, por posición

- **Método como dato**: `inventory_settings.costing_method` con un solo valor hoy
  (`promedio_ponderado_movil`). FIFO es una fila más en el CHECK y un módulo más en
  `packages/inventory`, no rehacer este.
- **Granularidad**: la posición es `(company, almacén, producto, lote)`. Cada posición lleva su
  propio promedio; un lote es una sub-existencia con su costo, y una transferencia mueve el valor
  al costo de origen (valor conservado). Elegido frente a «promedio por company» porque el
  promedio por almacén es lo que pide un almacén que compra a precios distintos, y frente a
  «promedio por producto con lotes derivados» porque obligaría a revalorar todos los lotes en cada
  entrada.
- **La regla vive una vez y se verifica dos veces**: `packages/inventory` (puro, TypeScript,
  property-based) calcula; `platform.apply_inventory_move()` verifica cada salida con un
  **oráculo de multiplicaciones exactas** — `|costo × existencia − valor × q| ≤ ½·10⁻⁸ ×
  existencia` — sin dividir en SQL (una división a escala finita y un redondeo en TypeScript pueden
  discrepar en un empate; el producto exacto no). Desacuerdo = LAD41, nunca un dato mal costeado.
- **Costo de una salida** (regla exacta, en los dos sitios): `0 < q < existencia` →
  `round8(valor × q / existencia)`; `q = existencia` → **todo el valor** (la posición cierra en
  cero exacto, sin residuo); `q > existencia > 0` → todo el valor + `round8((q − existencia) ×
  promedio)`; sin promedio significativo → `round8(q × último costo unitario)`.
- **Promedio significativo** solo con `cantidad > 0` **y** `valor ≥ 0`. Si no, se arrastra el
  último conocido (`last_unit_cost`). Lo encontró el property test: con negativo permitido, una
  entrada barata tras una posición negativa dejaba promedio negativo. El residuo queda **visible en
  el valor** (el kardex sigue cuadrando: valor = Σ movimientos, exacto) y nunca se persiste un
  costo unitario negativo. Regularizarlo es un ajuste de valor, que hoy no existe (R-13).
- **Redondeo**: quinto contexto `roundForCost`, política `inventory:cost:8:HALF_UP`, persistida
  en `rounding_policy_id` (MONEY_AND_ROUNDING_SPEC §6.6). `HALF_UP` porque el `round()` de
  Postgres es *half away from zero* y el oráculo no debe discrepar en un empate.
- **Moneda**: `companies.functional_currency_code` (default `VES` provisional,
  VALIDAR-TRIBUTARIO: es juicio contable VEN-NIF). Una entrada en otra moneda persiste los siete
  campos de ADR-0020 (`toMonetaryFact`) y la política; **sin fuente de tasa no se persiste**. Una
  entrada en moneda funcional lleva `fx_rate = 1`, `rate_source = 'identidad'` y el CHECK exige que
  ambos importes coincidan: la identidad no es una conversión.
- **Orden**: el promedio sigue el orden de **registro** (id uuidv7 monótono); `stock_at(fecha)`
  sigue `occurred_at`, **parámetro, nunca `now()`**. Un backdate cambia la existencia histórica a
  una fecha, no el promedio ya calculado.

### Kardex append-only y materializado

- `inventory_moves` con las **dos capas de ADR-0006**: sin policy ni GRANT de UPDATE/DELETE para
  ningún rol, y `reject_mutation()` en fila y en TRUNCATE (LAD06). Cantidad e importes **con
  signo**: recomputar es `sum()`.
- Cada movimiento persiste también `unit_cost` (resultante), `quantity_after` y `value_after`: el
  kardex se lee sin recalcular y son tres puntos de consistencia, no uno.
- `stock_balances` se actualiza **en el mismo trigger y transacción** (decisión 6). Nadie más lo
  escribe: sin GRANT de escritura para ningún rol; `reject_mutation()` en DELETE y TRUNCATE.
- **Criterio de aceptación como test**: `platform.recompute_stock()` recalcula desde los
  movimientos y `platform.stock_reconciliation(company)` lista divergencias; pgTAP 019 exige cero y
  demuestra con la variante rota (trigger desactivado) que la aserción mide el trigger.
- **Serialización**: `platform.lock_stock_position()` crea-si-no-existe y bloquea la posición
  `FOR UPDATE` hasta el commit. Dos movimientos concurrentes sobre la misma posición se ordenan;
  un insertante directo que calculó sobre un estado viejo muere en LAD41.

### Negativo: nunca silencioso

`inventory_settings.allow_negative_stock` (default `false`) **y** el permiso acotado
`inventory.negative` del actor sobre **ese almacén**, exigidos **en el esquema** para los dos
caminos (`coalesce(auth.uid(), GUC de servicio)`, como el M4 de la migración 11). LAD39 en cada
uno de los dos fallos, con mensaje distinto.

### Transferencia instantánea, sin «en tránsito»

Salida y entrada en la **misma transacción**, `transfer_id` común y `counterpart_move_id` mutuo
(FK diferida). Un constraint trigger **diferido** (LAD40) exige al commit exactamente dos patas,
una de cada tipo, mismo producto y lote, almacenes distintos, Σcantidad = 0, Σvalor = 0 y
referencia mutua. **No hay estado «en tránsito»** porque no hay intervalo: el stock no puede
estar en ningún lado ni en los dos. Si logística lo necesita, el tránsito es un almacén más — el
modelo lo admite sin cambiar. La transferencia exige `inventory.transfer` en **los dos**
almacenes.

### Frontera lotes / seriales / BOM

Los tres son de **inventario**: un producto no «tiene» lotes, sus existencias sí. En `products`
solo banderas: `tracks_lots` (entra con `lots`, obligatorio/prohibido por trigger, **congelada
con movimientos** — LAD38), `tracks_serials` (estructura diferida; un producto con la bandera
**no puede moverse** hasta que exista el rastreo — ausencia de mecanismo no es prohibición) e
`is_manufactured` (sin efecto sobre movimientos). Los lotes se crean **al recibir**.

### Alcance

Dentro: `inventory_moves`, `stock_balances`, `lots`, transferencias, costeo, `inventory_settings`,
alta de almacenes. **Fuera**: `reservations` (ventas: compromiso de pedido, no existencia),
`counts` (módulo propio: flujo con aprobación), seriales y BOM (estructura), ajustes de solo valor
(R-13), y un endpoint para `inventory_settings` (hoy la fila la escribe el operador).

## Consecuencias

- Positivas: la primera tabla append-only con dinero es reproducible campo a campo (siete campos +
  política + oráculo); consultar existencias es una lectura; el negativo deja rastro de quién y
  con qué política; añadir FIFO o tránsito no toca lo construido.
- Negativas: cada movimiento paga un bloqueo de fila y una verificación; una empresa que activa el
  negativo acepta valores residuales hasta regularizar; `warehouse.move` (S0.3) queda en el catálogo
  sin uso (los permisos no se renombran); el default de moneda funcional es provisional.
- Revertir: `drop` de tablas, funciones y columnas mientras `inventory_moves` esté vacía. Con
  movimientos, no.

## Verificación

pgTAP 019: inmutabilidad por dos capas incluida `service_role` y TRUNCATE; materializado ==
recalculado y su roto; negativo en las dos direcciones (sin bandera, con bandera sin permiso, con
las dos); costeo contra valores calculados **a mano en el test**, con importe al límite de
`numeric(24,8)` y una entrada en USD con los siete campos; transferencia atómica (una pata sola no
puede confirmarse); aislamiento con usuario en dos tenants; almacenista con binding a un almacén
no mueve otro. `packages/inventory`: cinco propiedades (Σ exacta, determinismo, redondeo en el
importe, no negativo sin política, costo unitario ≥ 0 incluso con negativo) y los mismos ejemplos a
mano que el pgTAP. Dominio y E2E como `ladino_api`.
