# Catálogo de errores

> **Estado: inventario verificado, mapeo HTTP PENDIENTE.** Este documento registra los SQLSTATE
> propios que **existen hoy en la base**, comprobados contra el catálogo de Postgres, no contra la
> documentación. La columna «HTTP» y los `code` de la API son **decisión de S0.5** y están marcadas
> como tales: no se rellenan aquí por adelantado.
>
> Existe porque era el hueco más grande que quedaba: `API_SPEC.md` define la **forma** del cuerpo
> de error y da dos ejemplos, y no hay en `docs/` **ni una línea** que mencione los `LADxx`. Sin
> este inventario, el mapeo lo inventaría quien escriba el primer handler.

## Forma del cuerpo (decidida, `API_SPEC.md`)

```json
{ "code": "…", "message": "…", "details": { }, "request_id": "…" }
```

`code` es **contrato estable**; `message` va en español y es mostrable al usuario.
`DomainError` de `packages/core` ya tiene la forma `{ code, message, details? }`: encaja sin
adaptador, y `request_id` lo añade la capa HTTP.

## SQLSTATE vivos — los que la API puede recibir

Comprobado sobre las funciones realmente instaladas. **Cada uno es único en tiempo de ejecución.**

| SQLSTATE | Función | Qué significa | `code` de API | HTTP |
|---|---|---|---|---|
| `LAD06` | `platform.reject_mutation()` | `UPDATE`/`DELETE`/`TRUNCATE` sobre tabla append-only | *S0.5* | *S0.5* |
| `LAD25` | `platform.assert_role_scope_coherence()` | rol acotado sin binding, o binding en rol no acotado | *S0.5* | *S0.5* |
| `LAD26` | `platform.assert_scope_binding_target()` | el binding apunta a un recurso que no corresponde | *S0.5* | *S0.5* |
| `LAD27` | `platform.assert_rbac_tenant_coherence()` | la fila RBAC cruza tenants | *S0.5* | *S0.5* |
| `LAD28` | `platform.assert_isolation_anchors_immutable()` | intento de mover `tenant_id`/`company_id` | *S0.5* | *S0.5* |
| `LAD29` | `platform.audit_tax_id_change()` | cambio de RIF sin `company.tax_id.manage` | *S0.5* | *S0.5* |
| `LAD30` | `platform.assert_occurred_at_not_future()` | `occurred_at` >30 s por delante del reloj del servidor | *S0.5* | *S0.5* |
| `LAD31` | `platform.assert_idempotency_actor_immutable()` | intento de mover `actor_id` de una clave | *S0.5* | *S0.5* |
| `LAD33` | `platform.assert_product_kind_frozen()` | cambiar bien/servicio de un producto que salió de `draft` (D-8, migración 16) | `PRODUCT_KIND_IMMUTABLE` | `409` |
| `LAD35` | `platform.assert_price_append_only()` · `close_price()` | editar/borrar un precio, o reabrir una vigencia cerrada (ADR-0032, migración 17) | `PRICE_APPEND_ONLY` | `409` |
| `LAD36` | `platform.audit_customer_tax_id()` | cambio de RIF de un cliente sin `customer.tax_id.manage` (M4 para clientes, ADR-0033, migración 18) | `PERMISSION_REQUIRED` | `403` |
| `LAD38` | `platform.apply_inventory_move()` · `assert_product_tracking_frozen()` | el movimiento no es posible con ese producto/almacén/lote: servicio, producto inactivo, seriales sin rastreo, lote obligatorio o prohibido, moneda funcional distinta a la de la empresa, o cambio de banderas de rastreo con movimientos (ADR-0034, migración 19) | `VALIDATION_FAILED` | `422` |
| `LAD39` | `platform.apply_inventory_move()` | existencia negativa **sin** `allow_negative_stock`, o con la política pero sin `inventory.negative` del actor sobre ese almacén | `NEGATIVE_STOCK` | `409` |
| `LAD40` | `platform.assert_transfer_balanced()` | al COMMIT, una transferencia sin sus dos patas cuadradas (mismo producto y lote, almacenes distintos, Σcantidad = 0, Σvalor = 0, referencia mutua) | `TRANSFER_UNBALANCED` | `409` |
| `LAD41` | `platform.apply_inventory_move()` | el costeo declarado por el caso de uso no coincide con el oráculo exacto del esquema (costo de salida, costo unitario resultante o saldos). Casi siempre: la posición cambió entre el cálculo y el INSERT | `COSTING_MISMATCH` | `409` |
| `LAD43` | `platform.apply_inventory_move()` | movimiento directo sobre un producto COMPUESTO, en cualquier dirección: no tiene existencias propias (ADR-0035, migración 20) | `COMPOSED_HAS_NO_STOCK` | `409` |
| `LAD44` | `platform.assert_recipe_shape()` · `assert_composed_flag_coherent()` | receta inválida: el padre no es compuesto, el hijo SÍ lo es (anidamiento no soportado), el hijo es un servicio, o se cambia `is_composed` de un producto que ya es ingrediente / ya tiene movimientos / ya tiene receta | `RECIPE_INVALID` | `409` |
| `LAD45` | *caso de uso* (`explodeRecipe`) | falta la fila de `unit_conversions` para pasar de la unidad de la receta a la del producto. **No lo lanza la base**: `convert_quantity()` devuelve `NULL` y el caso de uso lo traduce — el NULL es el mecanismo, el código es el contrato | `UNIT_CONVERSION_MISSING` | `422` |
| `LAD46` | `platform.apply_inventory_move()` | SALIDA de un lote ya vencido sin `inventory.expired` sobre ese almacén. Entrar sí se puede: el control es sobre lo que llega al cliente (ADR-0035) | `PERMISSION_REQUIRED` | `403` |
| `LAD47` | `platform.assert_variant_attributes()` | la variante declara un eje que su plantilla no tiene, o le falta uno que exige (ADR-0036, migración 20) | `VARIANT_ATTRIBUTES_INVALID` | `422` |
| `LAD49` | `platform.assert_document_issuance()` · `claim_control_number()` | numeración fiscal (ADR-0037): empresa sin régimen vigente, régimen que no permite emitir, `issued` **sin** número de control cuando el régimen lo exige, `issued` **con** número de control cuando el régimen no lo usa, o rango de control agotado | `FISCAL_NUMBERING_INVALID` | `409` |
| `LAD50` | `platform.resolve_tax()` | no hay regla tributaria vigente para esa fecha/jurisdicción/categoría, o hay **dos con la misma prioridad** (catálogo ambiguo). ADR-0038: nunca devuelve cero | `TAX_RULE_MISSING` | `409` |
| `LAD06` | *(también)* `platform.assert_document_immutable()` · `assert_document_lines_immutable()` | editar o borrar un documento **emitido**, mover su correlativo o su control, o una transición de estado no permitida. Se corrige con nota de crédito o débito | `APPEND_ONLY_VIOLATION` | `409` |

## Códigos de una sola ejecución — NO llegan a la API

`LAD26` y `LAD27` aparecen **también** en `20260810040143_create_audit_events.sql`, con otro
significado (`server_encoding ≠ UTF8` y «permiso fantasma»). **No hay colisión en tiempo de
ejecución**: los dos están dentro de bloques `do $$` que corren una sola vez al aplicar la
migración y no dejan función instalada. Se registran aquí para que nadie los lea como duplicados
al hacer `grep` sobre las migraciones y crea que el mapeo 1:1 es imposible.

`LAD32` (atributos de los roles de servicio, migración 14), `LAD34` (seeds del catálogo de
productos, migración 16), `LAD37` (seeds de clientes, migración 18), `LAD42` (permisos, capas
append-only y RLS de inventario, migración 19), `LAD48` (permisos, conversiones de unidad y RLS de
la migración 20) y `LAD52` (migración 21: que `tax_rules` NAZCA VACÍA, que ningún régimen se siembre
en `per_document`, que ninguno vaya sin norma citada, y que `payments`/`exchange_gain_loss` no
tengan privilegio de mutación) son de una sola ejecución: abortan la migración, no llegan a la API.

`LAD51` **ya está en uso desde los casos de uso de ventas**: «no hay tasa de cambio vigente para la
fecha». Se reservó antes de usarse, que es la regla de abajo, y el día que llegó su caso —emitir o
cobrar un documento cuya lista está en otra moneda— pasó a ser rechazo duro con `409`
(`EXCHANGE_RATE_MISSING`). `platform.rate_at()` sigue devolviendo `NULL` y quien la consume decide;
lo que cambió es que el consumidor de ventas **decide parar**, porque una factura emitida a una
tasa inventada no se corrige con un `UPDATE`.

**Regla para migraciones futuras:** un `LADxx` nuevo se reserva en esta tabla **antes** de usarse,
incluso para una aserción de una sola ejecución. Reutilizar un número «porque solo corre una vez»
es exactamente lo que obligó a esta comprobación.

## SQLSTATE estándar que también hay que mapear

No son propios, pero llegan por el mismo camino y hoy tampoco están mapeados:

| SQLSTATE | Origen típico en Ladino |
|---|---|
| `23505` | clave de idempotencia repetida · RIF duplicado en el tenant |
| `23514` | `CHECK` de forma o de coherencia estado/dato |
| `23503` | FK compuesta `(tenant_id, company_id)`: recurso de otro tenant |
| `23502` | `NOT NULL` — sobre todo `actor_id` y `expires_at` ausentes |
| `42501` | privilegio de tabla o de columna |
| `54000` | fila de índice demasiado grande (btree) |

## La regla de `404` frente a `403` — decisión, no convención

`42501` es **indistinguible entre «no tienes permiso» y «la RLS no te deja ver esa fila»**. La regla:

> **`404` cuando la fila no es visible para el usuario. `403` cuando es visible pero falta el
> permiso. En duda, `404`.**

**La razón, y por eso es decisión y no estilo:** responder `403` sobre un recurso que el usuario no
puede ver **confirma que ese recurso existe**. Un atacante que prueba identificadores distingue
«no existe» de «existe y no es tuyo», y con eso enumera los recursos de otro tenant sin leer ni un
dato. Es **fuga de información aunque no lo sea de datos**, y el aislamiento multi-tenant es la
categoría de control que no se relaja nunca (ADR-0027 §4).

`403` queda para el caso en que la existencia ya está admitida: el usuario ve la company y le falta
el permiso concreto sobre ella. Ahí no se revela nada que no supiera.

**«En duda, 404»** es deliberado y tiene coste: un usuario legítimo al que le falte un permiso verá
a veces un «no existe» confuso en lugar de un «no puedes». Se acepta, porque el error en la otra
dirección no se puede deshacer — una vez confirmada la existencia, ya está confirmada.

Emparentado con la clase de ataque «canal lateral por errores y tiempos», que sigue sin probar:
esta regla cubre el canal por **mensaje**, no el canal por **tiempo**.

## Mapeo propuesto — decisión de S0.5

| SQLSTATE | `code` | HTTP | Nota |
|---|---|---|---|
| `LAD06` | `APPEND_ONLY_VIOLATION` | `409` | El cliente pidió algo imposible por diseño, no malformado |
| `LAD25` · `LAD26` · `LAD27` | `RBAC_INCOHERENT` | `409` | Estado de configuración inconsistente |
| `LAD28` | `ISOLATION_ANCHOR_IMMUTABLE` | `409` | Mover `tenant_id`/`company_id` |
| `LAD29` | `PERMISSION_REQUIRED` | `403` | El recurso es visible; falta `company.tax_id.manage` |
| `LAD30` | `OCCURRED_AT_IN_FUTURE` | `422` | Dato del cliente, semánticamente inválido |
| `LAD31` | `IDEMPOTENCY_ACTOR_IMMUTABLE` | `409` | |
| `23505` | `IDEMPOTENCY_KEY_REUSED` / `DUPLICATE` | `409` | Según el índice que se viole |
| `23514` | `VALIDATION_FAILED` | `422` | Debería haberlo cazado Zod antes: **si llega aquí, hay un hueco de validación** |
| `23503` | `NOT_FOUND` | **`404`** | FK compuesta: el recurso es de otro tenant. **Regla de arriba** |
| `23502` | `VALIDATION_FAILED` | `422` | Típico: falta `actor_id` o `expires_at` |
| `42501` | `NOT_FOUND` o `PERMISSION_REQUIRED` | **`404` / `403`** | **Regla de arriba** |
| `54000` | `PAYLOAD_TOO_LARGE` | `413` | Fila de índice demasiado grande |

`23514` merece el comentario que lleva: un `CHECK` que llega hasta la base significa que el esquema
Zod no lo cubría. Es un `422` correcto **y** una señal de que falta validación en el borde.

## Códigos de la capa HTTP — no vienen de la base

Los produce un middleware antes de que el handler exista. **Los tres últimos son de S0.6a** y
existen por la auditoría de ese sprint: sin ellos, una caída del JWKS de Supabase era un `401`
para todo el tráfico (y los clientes borraban la sesión), una petición colgada no tenía tope, y
la idempotencia protegía del reintento pero no del abuso.

| `code` | HTTP | Quién | Cuándo |
|---|---|---|---|
| `UNAUTHENTICATED` | `401` | auth | sin token, o token que NO verifica (firma, emisor, audiencia, rol, `sub`). Sin detallar cuál |
| `TOKEN_EXPIRED` | `401` | auth | verifica pero caducó: el cliente debe refrescar |
| `AUTH_BACKEND_UNAVAILABLE` | `503` + `Retry-After: 5` | auth | el JWKS no respondió (timeout, red, respuesta malformada). **No es culpa del token**: se registra a nivel `error` |
| `RATE_LIMITED` | `429` + `Retry-After` | rate limit | más de N peticiones por minuto **por usuario** (`RATE_LIMIT_PER_MINUTE`, 300). Nunca por IP en la API |
| `GATEWAY_TIMEOUT` | `504` | timeout | la petición superó `REQUEST_TIMEOUT_MS` (30 s). El handler sigue hasta terminar; su respuesta se descarta |
| `VALIDATION_FAILED` | `422` | contexto | `X-Company-Id` sin forma de UUID (validado contra `ladino_user_company_ids()` desde la migración 15; invisible o inexistente → `404 NOT_FOUND`, los tres casos indistinguibles). `COMPANY_SCOPE_NOT_IMPLEMENTED` quedó retirado |
| `PAYLOAD_TOO_LARGE` | `413` | `bodyLimit` | cuerpo > 1 MB |

## Lo que este documento NO decide

- El `code` de API de cada uno, y su estado HTTP.
- Qué se expone en `details` sin filtrar existencia de recursos ajenos.
- Si el `message` en español sale de la excepción de Postgres o de una tabla de mensajes de la API.
  Los `raise exception` actuales llevan mensaje en español y `hint` accionable; reutilizarlos es
  tentador y hay que decidir si el texto de la base es contrato de la API o detalle interno.
