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
| `LAD98` | `platform.assert_document_issuance()` | factura, NC o ND de una empresa con RIF sin tipo de contribuyente declarado vigente a la fecha de emisión (ADR-0072, migración 20260928190100). Mensaje de persona: «Para facturar falta declarar el tipo de contribuyente del negocio vigente al AAAA-MM-DD…» | `TAXPAYER_TYPE_REQUIRED` | `409` |
| `LAD99` | `platform.assert_document_issuance()` | sobre forma libre, una factura sin adquirente identificado (PA 00071 art. 13.7, P-57), o una NC/ND que no identifica al adquirente como su factura (migraciones 20260928190400 y 190500). El dominio responde antes con su mensaje de persona: «Para facturar sobre forma libre hacen falta el nombre del cliente y su RIF, cédula o pasaporte (PA 00071 art. 13.7). Identifícalo: el «Consumidor final» es solo para recibos.» | `VALIDATION_FAILED` | `422` |
| `LAD41` | `platform.apply_inventory_move()` | el costeo declarado por el caso de uso no coincide con el oráculo exacto del esquema (costo de salida, costo unitario resultante o saldos). Casi siempre: la posición cambió entre el cálculo y el INSERT | `COSTING_MISMATCH` | `409` |
| `LAD43` | `platform.apply_inventory_move()` | movimiento directo sobre un producto COMPUESTO, en cualquier dirección: no tiene existencias propias (ADR-0035, migración 20) | `COMPOSED_HAS_NO_STOCK` | `409` |
| `LAD44` | `platform.assert_recipe_shape()` · `assert_composed_flag_coherent()` | receta inválida: el padre no es compuesto, el hijo SÍ lo es (anidamiento no soportado), el hijo es un servicio, o se cambia `is_composed` de un producto que ya es ingrediente / ya tiene movimientos / ya tiene receta | `RECIPE_INVALID` | `409` |
| `LAD45` | *caso de uso* (`explodeRecipe`) | falta la fila de `unit_conversions` para pasar de la unidad de la receta a la del producto. **No lo lanza la base**: `convert_quantity()` devuelve `NULL` y el caso de uso lo traduce — el NULL es el mecanismo, el código es el contrato | `UNIT_CONVERSION_MISSING` | `422` |
| `LAD46` | `platform.apply_inventory_move()` | SALIDA de un lote ya vencido sin `inventory.expired` sobre ese almacén. Entrar sí se puede: el control es sobre lo que llega al cliente (ADR-0035) | `PERMISSION_REQUIRED` | `403` |
| `LAD47` | `platform.assert_variant_attributes()` | la variante declara un eje que su plantilla no tiene, o le falta uno que exige (ADR-0036, migración 20) | `VARIANT_ATTRIBUTES_INVALID` | `422` |
| `LAD49` | `platform.assert_document_issuance()` · `claim_fiscal_control()` (ADR-0071) · `claim_control_number()` (compatibilidad, sin ejecución para la API) | numeración fiscal (ADR-0037, ADR-0071): empresa sin régimen vigente, régimen que no permite emitir, `issued` **sin** número de control cuando el régimen lo exige, `issued` **con** número de control cuando el régimen no lo usa, sin talonario con papel para la serie («No quedan números de control para facturas (identificador 00). Carga el talonario nuevo.»), o talonario sin los datos de la imprenta («Al talonario serie A (identificador 00) le faltan los datos de la imprenta…»), o emitir con número de control sin su identificador (`documents_control_identifier`, ADR-0071 H9) | `FISCAL_NUMBERING_INVALID` | `409` |
| `LAD50` | `platform.resolve_tax()` | no hay regla tributaria vigente para esa fecha/jurisdicción/categoría, o hay **dos con la misma prioridad** (catálogo ambiguo). ADR-0038: nunca devuelve cero | `TAX_RULE_MISSING` | `409` |
| `LAD06` | *(también)* `platform.assert_range_printer_frozen()` (ADR-0071: imprenta de un talonario completo sin acta de corrección, identificador de un talonario que ya emitió, anular uno que emitió) · `platform.documents_control_identifier()` (identificador del control de un documento emitido) · `platform.documents_rate_basis_frozen()` (la base de la tasa de una nota emitida, hallazgo 13) · `platform.assert_document_immutable()` · `assert_document_lines_immutable()` · `assert_purchase_doc_immutable()` · `assert_purchase_lines_immutable()` · desde la Fase C: `assert_payment_account_only_update()` (de un pago solo se corrige `account_id`), `assert_expense_backlink_only_update()` y `assert_cash_closing_backlink_only_update()` (solo el enlace al asiento), `assert_system_account_frozen()` y `assert_system_customer_frozen()` (lo de sistema ni se edita ni se borra) | editar o borrar un documento **emitido** o una compra **confirmada**, mover su correlativo o su control, o una transición de estado no permitida. Se corrige con nota de crédito o débito | `APPEND_ONLY_VIOLATION` | `409` |
| `LAD53` | `platform.resolve_retention()` · `compute_retention()` | no hay regla de retención vigente para esa fecha/jurisdicción/concepto, hay **dos con la misma prioridad**, o la `formula_kind` no está en el vocabulario cerrado. ADR-0039: nunca devuelve cero — un cero deja pasar el pago completo y deja a la empresa debiendo al fisco | `RETENTION_RULE_MISSING` | `409` |
| `LAD54` | `platform.assert_retention_receipt_number()` | cambiar el correlativo de un comprobante de retención emitido, o reemitir uno anulado. El número se conserva al anular (ADR-0039 §5) | `FISCAL_NUMBERING_INVALID` | `409` |
| `LAD59` | `platform.assert_entry_balanced()` | la partida doble no cuadra EN MONEDA FUNCIONAL, el asiento tiene menos de dos líneas, o su importe es cero. El mensaje lleva la diferencia exacta: sin ella hay que volver a sumar, y quien vuelve a sumar suma distinto | `ENTRY_UNBALANCED` | `409` |
| `LAD60` | `platform.set_account_path()` | ciclo en la jerarquía de cuentas: el padre ya desciende del hijo | `VALIDATION_FAILED` | `422` |
| `LAD61` | `platform.assert_entry_balanced()` · desde 20260928130000 también `platform.assert_entry_period_admits()` (al CREAR, también un borrador: K-05) | asiento con fecha en un período CERRADO. Reabrirlo exige permiso propio y motivo escrito; el mensaje de creación da la salida: «Reábrelo con motivo, o fecha el asiento en el período abierto» | `PERIOD_CLOSED` | `409` |
| `LAD91` | `platform.period_for_date()` · `platform.closing_period_for_year()` (ADR-0069 §3, K-05) | fecha anterior al inicio de actividades de la empresa (`companies.activity_start_date`) o posterior al último día del período en curso (día de Caracas). Se comprueba exista o no el período | `PERIOD_OUT_OF_RANGE` | `422` |
| `LAD92` | `platform.assert_entry_period_admits()` (ADR-0069 §2, K-03) | el período de cierre («13») solo admite `year_end_close` y ajustes `manual`, fechados el 31-12; y el asiento de cierre no va en un mes | `VALIDATION_FAILED` | `422` |
| `LAD97` | `platform.accept_general_vat()` · triggers `tax_rules_02_general_in_range` y `tax_rules_03_referenced_is_not_retired` (ADR-0073, B-02, H2) | reaceptar la general el mismo día en que ya se facturó con la anterior («Hoy ya se facturó al 16 %: la nueva tasa puede regir desde mañana»), o retirar por cualquier camino una regla que alguna línea emitida copió; o la alícuota general propuesta no es una general del catálogo: el 0 %, un valor fuera del rango del art. 27 que trae `tax_rule_templates` (8–16,5 %) o sin plantilla vigente en la fecha. La API lleva el mensaje de la base («el 0 % no es una alícuota general…», «tiene que estar entre 8 % y 16,5 %…»), que es también el `person_message` | `VALIDATION_FAILED` | `422` |
| `LAD62` | `platform.assert_entry_balanced()` | la cuenta agrupa (no es hoja), está desactivada, o exige dimensiones analíticas y la línea no las trae | `ACCOUNT_NOT_POSTABLE` | `409` |
| `LAD55` | *caso de uso* (`applyLandedCost`) | prorrateo `by_weight` con alguna línea sin peso. **No lo lanza la base**: el esquema admite `unit_weight` nulo porque no todo producto lo tiene; lo que no admite es repartir un flete solo entre lo que sí pesa, y eso lo decide el caso de uso. Mismo patrón que LAD45 | `MISSING_WEIGHT` | `422` |
| `LAD67` | `platform.assert_payment_account_currency()` | el pago, gasto o cierre declara una moneda distinta a la de su cuenta de tesorería: un Zelle no entra a Caja Bs (migración 29) | `VALIDATION_FAILED` | `422` |
| `LAD68` | `platform.documents_customer_snapshot_freeze()` | tocar el snapshot del cliente de un documento — nombre, documento de identidad o domicilio congelados al crearlo (R-05 lado cliente, migración 33). También rellenarlo en un documento anterior a la 33: un backfill fila a fila sigue siendo una inferencia sobre el pasado | `DOCUMENT_SNAPSHOT_FROZEN` | `409` |
| `LAD69` | `platform.assert_contingency_series()` (migración 35) · `platform.assert_contingency_membership()` (ADR-0071, H1: constraint triggers diferidos de 20260928160200 y 160300) | un registro de contingencia sobre un rango cuya serie no empieza por «contingencia» (PA 102); o, al commit, una serie «contingencia…» sin su registro en `contingency_ranges`, o un talonario de contingencia renombrado a serie normal. La serie «contingencia…» es lo que saca un rango de la exclusión de solapes: sin esto, «Contingencia-B» pisaba el talonario B | `VALIDATION_FAILED` | `422` |

## Mensajes de persona (Fase C, PARTE 16)

Desde la Fase C toda respuesta de error lleva **dos** mensajes: `message` (el técnico, con el
detalle del dominio cuando lo hay) y `person_message` — la misma verdad en voz de persona, dos
frases como máximo: qué pasó y qué hacer. Las pantallas de negocio enseñan `person_message`;
las de `/admin` pueden enseñar los dos. La fuente única del texto es `mensajePersona()` en
`apps/api/src/middleware/errors.ts`; esta tabla es su espejo documentado — si divergen, manda
el código y se corrige el espejo.

| `code` | `person_message` |
|---|---|
| `VALIDATION_FAILED` | Algo en el formulario no está bien. Revisa los campos marcados y vuelve a intentar. |
| `PERMISSION_REQUIRED` | Necesitas el permiso para <acción>. Pídeselo a quien administra el negocio. — la acción sale de `ACCION_DE_PERMISO` según el permiso que nombra `message` (ADR-0068 §4); si no nombra ninguno conocido: «Tu usuario no puede hacer esto. Pídele acceso a quien administra el negocio.» |
| `NOT_FOUND` | Eso no existe o no está disponible para ti. |
| `DUPLICATE` | Ya hay uno igual registrado. Busca el que existe en vez de crear otro. |
| `EXCHANGE_RATE_MISSING` | Falta la tasa BCV. Tráela en Mi dinero y vuelve a intentar. |
| `RATE_ONLY_FROM_BCV` | Solo se usa la tasa del BCV. Tráela con «Traer del BCV» en Mi dinero. |
| `TAX_RULE_MISSING` | Falta configurar el impuesto de venta. Se completa en Empezar antes de poder vender. |
| `FISCAL_NUMBERING_INVALID` | No quedan números de control para facturas (identificador 00). Carga el talonario nuevo. — desde ADR-0071 (H10) el cuerpo trae `details.reason`: `regime_missing` → «Completa la puesta a punto fiscal» (/empezar, `fiscal.regime.manage`); `no_range` → «Carga el talonario»; `printer_data_incomplete` → «Completa los datos de la imprenta» (ambos `fiscal.range.manage`). Sin el permiso: «Pídeselo a quien administra» (E-17). Sin `reason`: la salida genérica. |
| `NEGATIVE_STOCK` | No hay suficiente mercancía para esa cantidad. Revisa la existencia o registra la entrada primero. |
| `APPEND_ONLY_VIOLATION` | Esto ya quedó registrado y no se puede cambiar. Lo que corresponde es registrar la corrección. |
| `DOCUMENT_SNAPSHOT_FROZEN` | Los datos del cliente quedaron impresos en esa factura y no se cambian. Si están mal, se corrige con una nota de crédito. |
| `UPSTREAM_UNAVAILABLE` | No se pudo consultar el BCV en este momento. Intenta de nuevo en un rato; mientras tanto rige la última tasa. |
| `STORAGE_UNAVAILABLE` | No se pudo guardar el archivo. Intenta de nuevo en un rato; si sigue, avísanos. |
| `PERIOD_CLOSED` | Ese mes ya está cerrado en contabilidad. Habla con quien lleva los números. |
| `TAXPAYER_TYPE_REQUIRED` (409, ADR-0072 §1, A-03) | El dominio lo dice según quién pregunta: con `company.settings.manage`, «Para facturar falta declarar el tipo de contribuyente del negocio vigente al <fecha>. Decláralo en Configuración → Mi empresa → Tipo de contribuyente (o en Empezar) y vuelve a intentar.»; sin él, «… Pídeselo a quien administra el negocio.» Respaldo fijo: «Para facturar falta declarar el tipo de contribuyente del negocio. Decláralo en Configuración → Mi empresa, o pídeselo a quien administra.» |
| `PERIOD_OUT_OF_RANGE` | Esa fecha no se puede usar: es anterior al inicio de actividades del negocio o está en un mes que todavía no llega. |
| `COMPANY_SUSPENDED` | El negocio está suspendido en el sistema. Contacta a soporte. |
| `COSTING_MISMATCH` | La existencia cambió mientras guardabas. Vuelve a intentar: casi siempre pasa a la primera. |
| `PAYLOAD_TOO_LARGE` | El archivo es demasiado grande. Prueba con uno más liviano. |
| `RATE_LIMITED` | Demasiadas operaciones muy seguidas. Espera un momento y sigue. |
| `GATEWAY_TIMEOUT` | Esto está tardando más de la cuenta. Revisa en un momento si quedó registrado antes de repetirlo. |
| *(cualquier otro)* | Algo salió mal de nuestro lado. Vuelve a intentar; si sigue, avísanos. |

### Códigos de dominio del QA de pantalla (2026-09-15)

Estos viajan con el mensaje del DOMINIO como `person_message` (no están en la lista de mensajes
fijos): el texto dice qué pasó y qué hacer con los datos del caso.

| `code` | HTTP | Cuándo |
|---|---|---|
| `WAREHOUSE_IN_USE` | `409` | Apagar el depósito principal, o uno que todavía tiene mercancía (migración 60) |
| `OVER_INVOICED` | `409` | Lo facturado de una mercancía (acumulado, facturas no anuladas) pasaría de lo recibido (h. 86) |
| `MEMBER_NOT_REGISTERED` | `404` | Agregar a una persona cuyo correo no tiene cuenta en Ladino (h. 74) |
| `MEMBER_PROTECTED` | `403` | Un gestor acotado a la empresa intenta quitar roles o desactivar al Titular de la cuenta, o desactivar a quien trabaja en otra empresa que él no gestiona (ADR-0068 §3, N-02). El `person_message` es el del dominio: «Esa persona es el Titular de la cuenta: sus roles y su acceso solo los cambia el propio Titular.» / «Esa persona también trabaja en otra empresa de la cuenta. Quítale el rol en esta empresa; desactivarla del todo lo hace quien administra todas sus empresas.» |
| `ENTRY_GENERATED_BY_DOCUMENT` | `409` | Reversar desde el Diario un asiento generado por un documento: se corrige desde el documento (h. 67) |

### El documento de identidad (A-08, M-05, P-02, A-17 — 2026-09-28)

Todos son `VALIDATION_FAILED` / `422`, con el mensaje del dominio
(`packages/domain/src/documento-identidad.ts`) como `person_message`. Los tres comparten código:
los E2E (`e2e-documento-identidad.test.ts`) asertan el MENSAJE, que es lo que distingue el camino.

| Cuándo | Mensaje de persona |
|---|---|
| RIF de empresa (alta, registro, poner, cambiar, corregir) o de proveedor nacional sin la estructura letra + 9 dígitos | «El RIF no tiene la forma correcta: una letra (V, E, J, G, P o C) y nueve dígitos, con o sin guiones. Por ejemplo, J-12345678-9.» |
| Documento de un cliente que no es RIF, cédula ni pasaporte (alta de la administración, mostrador, importación, cambio de RIF) | «El documento no tiene la forma correcta: un RIF (V, E, J, G, P o C y nueve dígitos, por ejemplo J-12345678-9), una cédula (V o E y hasta ocho dígitos, por ejemplo V-12345678) o un pasaporte (P y su número, por ejemplo P-AB1234567).» |
| Poner o corregir el RIF de la empresa, o crearla por `POST /v1/companies`, con el marcador `PEND-…` en cualquier caja (A-17; revisión 2026-09-28, hallazgo 2) | ««PEND-…» es la marca de una empresa que todavía no tiene RIF, no un RIF. Escribe el RIF del certificado del SENIAT, por ejemplo J-12345678-9.» |

El dígito verificador que no cuadra **no es un error**: se acepta, y queda el acta
`<company|customer|supplier>.tax_id_check_digit_mismatch` con el dígito recibido y el esperado. La
web lo avisa antes de guardar con `avisoDigitoRif` (`packages/schemas/src/rif.ts`): «El dígito
verificador no cuadra: para J-40555123 el SENIAT calcula 2, y escribiste 4. Revísalo en el
certificado del RIF; si está bien así, se puede guardar.»

## Códigos de una sola ejecución — NO llegan a la API

`LAD26` y `LAD27` aparecen **también** en `20260810040143_create_audit_events.sql`, con otro
significado (`server_encoding ≠ UTF8` y «permiso fantasma»). **No hay colisión en tiempo de
ejecución**: los dos están dentro de bloques `do $$` que corren una sola vez al aplicar la
migración y no dejan función instalada. Se registran aquí para que nadie los lea como duplicados
al hacer `grep` sobre las migraciones y crea que el mapeo 1:1 es imposible.

`LAD32` (atributos de los roles de servicio, migración 14), `LAD34` (seeds del catálogo de
productos, migración 16), `LAD37` (seeds de clientes, migración 18), `LAD42` (permisos, capas
append-only y RLS de inventario, migración 19), `LAD48` (permisos, conversiones de unidad y RLS de
la migración 20), `LAD63` (migración 25: que journal_templates y accounts NAZCAN VACÍAS, que la plantilla de plan vaya marcada VALIDAR-CONTABLE, que las doce tablas tengan RLS forzada, que journal_lines EXISTA con ese nombre —CLAUDE.md §2 la prohíbe por él— y que el trigger de partida doble esté montado), `LAD56` (migración 22: que `retention_rules` NAZCA VACÍA, que el vocabulario de
conceptos esté sembrado, que `purchase.receive` sea acotado por almacén, que las diecinueve tablas
de compras tengan RLS forzada, que ninguna append-only tenga privilegio de mutación, y que
`fiscal_number_ranges` admita `retention_receipt`) y `LAD52` (migración 21: que `tax_rules` NAZCA VACÍA, que ningún régimen se siembre
en `per_document`, que ninguno vaya sin norma citada, y que `payments`/`exchange_gain_loss` no
tengan privilegio de mutación) son de una sola ejecución: abortan la migración, no llegan a la API.

`LAD82` — **integridad de la contabilidad de tesorería**; tampoco llega a la API: ningún caso de
uso lo dispara con una petición. Nació en la migración 56 (20260915130000, autochequeo de una sola
ejecución: que ni el preset `ve_basico` ni una plantilla vigente nombren una caja constante
—`cash_bs`/`cash_usd`— en un hecho de tesorería). Desde ADR-0070 (J-01) lo lanzan además funciones
instaladas que corren solo desde la reparación (`scripts/reparar/adr-0070-subcuentas.mjs`, con el rol
dueño de la base):
- `platform.treasury_create_subaccount`: la cuenta de familia que se pide como padre no existe;
- `platform.treasury_subaccounts_repair_finish`: el asiento de reclasificación NO está posteado
  (una reparación a medias no se cierra), o una cuenta de familia no quedó en saldo propio CERO tras
  la reclasificación.
Cualquiera de las dos aborta la transacción de esa empresa: queda como estaba, sin subcuentas ni
asiento. El script lo cuenta como error y termina con exit ≠ 0.

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
| `VALIDATION_FAILED` (por fila) | no es un status: la petición responde `200` (vista previa), `202`/`200` (`/jobs`: trabajo nuevo o reutilizado) o `201` (camino síncrono) | importación de productos (ADR-0074) | el rechazo aparece en la FILA: `rows[]`/`rejected_rows[]` de la vista previa, `report[]` del trabajo (`GET /v1/products/import/jobs/{id}`, `status: "rejected"`, `message`) o `rows[]` del camino síncrono (`status: "error"`). Ejemplos de motivo: la celda es ambigua con el formato elegido; Mensaje de persona: «El precio «0.500» es ambiguo con coma decimal (1.234,50): ¿0,5 o 500? Escríbelo como «0,5» (o «500»), o elige el otro formato de números.» No es un error de la petición: la fila no entra y las demás sí |
| `VALIDATION_FAILED` | `422` | `POST /v1/products/import` | más de 50 filas por el camino síncrono: «Por esta vía, máximo 50 productos por archivo. Para más, usa la importación en segundo plano.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-declarations/iva-periods` (L-04, 2026-10-02) | especial que pide un rango que no es quincena. Mensaje de persona: «Eres contribuyente especial: declaras el IVA por quincena (PA SNAT/2025/000091). En octubre de 2026 tus dos períodos van del 01-10-2026 al 15-10-2026 y del 16-10-2026 al 31-10-2026.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-declarations/iva-periods` (L-04) | ordinario que pide un rango que no es el mes calendario completo (H5): «Declaras el IVA por mes (eres contribuyente ordinario): el período de octubre de 2026 va del 01-10-2026 al 31-10-2026, completo.» — si pidió una quincena, añade «La quincena es de los contribuyentes especiales.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-declarations/supported-retentions` (H4, 2026-10-02) | fecha de entrega anterior a la de la retención: «La fecha de entrega del comprobante (…) no puede ser anterior a la de la retención (…).» La base lo repite con `srr_received_after_retained_chk` (23514) |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-declarations/iva-periods` (L-04) | el tipo cambia dentro del rango: «Tu tipo de contribuyente cambia dentro de ese rango (ordinario el …, especial el …): genera por separado el período de cada tipo y consulta a tu asesor cómo se declara el de la transición.» |
| `RETENTION_RULE_MISSING` | `409` | `POST /v1/supplier-invoices`, `POST /v1/arrivals` (H-01, ADR-0072 §3, 2026-10-02) | empresa agente sin regla vigente de `iva_compras` (75 %) o de `iva_compras_total` (100 %, art. 5): la factura no se registra. Mensaje de persona: el del esquema, que dice el concepto, la fecha y el tipo del proveedor («no hay regla de retención vigente para iva / iva_compras_total el …: cárgala en retention_rules con su fuente legal antes de retener») |
| `VALIDATION_FAILED` | `422` | `POST /v1/supplier-invoices` (H-01) | exclusión o 100 % en una empresa que no es agente: «La empresa no es agente de retención hoy, el día del registro (no es contribuyente especial): quita la exclusión o el 100 % de «Retención de IVA» y vuelve a registrar. Si sí es especial, decláralo en Configuración → Mi empresa → Tipo de contribuyente.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/supplier-invoices` (H-01) | exclusión automática marcada a mano: «La exclusión «proveedor_formal» la aplica el servidor solo; no se marca.» · fuera del catálogo vigente: «La exclusión «…» no está en el catálogo del art. 3 vigente en esa fecha.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/supplier-invoices` (H-01) | proveedor `no_contribuyente`/`no_sujeto`/otro a un agente sin decir qué hacer: «El proveedor está declarado como «…». Una empresa agente tiene que decir qué hace con la retención: en «Retención de IVA» de la factura, marca «se retiene el 100 %» con su motivo (art. 5…) o elige la exclusión del art. 3 que aplica.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/supplier-invoices` (auditoría fiscal H7/H8) | exclusión de 20 UT por encima del tope: «La exclusión «caja_chica_20ut» vale hasta 20 UT por operación (860.00 Bs con la UT de 43.00 Bs), y esta factura suma … Bs: se retiene. Quita la exclusión en «Retención de IVA».» · sin UT cargada: «… y no hay unidad tributaria cargada para esa fecha. Hasta que se cargue con su fuente no se puede marcar (VALIDAR-TRIBUTARIO P-71).» · entes públicos: «La exclusión «ente_publico» es de compras hechas por órganos o entes públicos (art. 3 num. 11 y 12): una empresa privada no la marca.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-books/export` (TXT, auditoría fiscal H9) | documento con varias alícuotas: «El TXT no se genera: N documento(s) llevan más de una alícuota y el instructivo pide una sola en el campo 15 (…). Está consultado con el asesor (P-69); mientras, declara esos documentos a mano en el portal.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/retention-vouchers/{id}/corrections` (H-04) | versión ya reemplazada: «Ese comprobante ya fue corregido por el AAAAMM########: corrige el vigente.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/retention-vouchers/{id}/delivery` (H11) | versión reemplazada: «Esta versión está anulada: la reemplazó el comprobante AAAAMM########. Anota la entrega en el vigente.» · fecha futura: «La entrega no puede ser en el futuro: hoy es … en Venezuela. Anótala el día que la entregues.» |
| `VALIDATION_FAILED` | `422` | `POST /v1/retention-vouchers/{id}/delivery` (H-04) | segunda entrega: «Ese comprobante ya se entregó el …: la entrega se anota una vez.» · antes de emitirse: «No se entrega antes de emitirse: el comprobante es del ….» |
| `VALIDATION_FAILED` | `422` | `POST /v1/fiscal-declarations/iva-periods` (L-05) | el período anterior es una generación 1.0.0 con excedente o retenciones (la cifra mezclada): «El período que termina el día antes del … se generó con la versión que sumaba en una sola cifra el excedente de crédito fiscal y las retenciones no descontadas. Vuelve a generarlo (y los anteriores que tengan excedente) para que cada arrastre pase por su lado.» |

## Lo que este documento NO decide

- El `code` de API de cada uno, y su estado HTTP.
- Qué se expone en `details` sin filtrar existencia de recursos ajenos.
- Si el `message` en español sale de la excepción de Postgres o de una tabla de mensajes de la API.
  Los `raise exception` actuales llevan mensaje en español y `hint` accionable; reutilizarlos es
  tentador y hay que decidir si el texto de la base es contrato de la API o detalle interno.
