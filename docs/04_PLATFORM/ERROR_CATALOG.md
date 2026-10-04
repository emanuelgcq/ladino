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
| `LAD78` | `platform.guard_customer_credit_limit()` | alta de un cliente con `credit_limit_usd` distinto de 0: un cliente nace con límite de fiado 0 (E-09, migración 20261004140000) | `VALIDATION_FAILED` | `422` |
| `LAD79` | `platform.guard_customer_credit_limit()` | cambio del límite de fiado de un cliente por el camino de servidor sin `customers.credit.set` (E-09, migración 20261004140000) | `PERMISSION_REQUIRED` | `403` |
| `LAD38` | `platform.apply_inventory_move()` · `assert_product_tracking_frozen()` | el movimiento no es posible con ese producto/almacén/lote: servicio, producto inactivo, seriales sin rastreo, lote obligatorio o prohibido, moneda funcional distinta a la de la empresa, o cambio de banderas de rastreo con movimientos (ADR-0034, migración 19) | `VALIDATION_FAILED` | `422` |
| `LAD39` | `platform.apply_inventory_move()` | existencia negativa **sin** `allow_negative_stock`, o con la política pero sin `inventory.negative` del actor sobre ese almacén | `NEGATIVE_STOCK` | `409` |
| `LAD40` | `platform.assert_transfer_balanced()` | al COMMIT, una transferencia sin sus dos patas cuadradas (mismo producto y lote, almacenes distintos, Σcantidad = 0, Σvalor = 0, referencia mutua) | `TRANSFER_UNBALANCED` | `409` |
| `LAD98` | `platform.assert_document_issuance()` | factura, NC o ND de una empresa con RIF sin tipo de contribuyente declarado vigente a la fecha de emisión (ADR-0072, migración 20260928190100). Mensaje de persona: «Para facturar falta declarar el tipo de contribuyente del negocio vigente al AAAA-MM-DD…» | `TAXPAYER_TYPE_REQUIRED` | `409` |
| `LAD99` | `platform.assert_document_issuance()` | sobre forma libre, una factura sin adquirente identificado (PA 00071 art. 13.7, P-57), o una NC/ND que no identifica al adquirente como su factura (migraciones 20260928190400 y 190500). El dominio responde antes con su mensaje de persona: «Para facturar sobre forma libre hacen falta el nombre del cliente y su RIF, cédula o pasaporte (PA 00071 art. 13.7). Identifícalo: el «Consumidor final» es solo para recibos.» | `VALIDATION_FAILED` | `422` |
| `LAD99` | `platform.assert_document_issuance()` · `platform.assert_formal_line()` | M-10 (LIVA art. 8; migración 20261004110000): la factura o la nota de débito de un contribuyente `formal` lleva una línea gravada, o se le agrega una después de emitir. Mensaje de persona, el de la respuesta del dueño: «Con esta condición no puedes vender productos gravados; si tu negocio cambió, actualiza el tipo de contribuyente». Hoy no lo alcanza ningún camino de producto: `formal` no se puede declarar (P-38) | `VALIDATION_FAILED` | `422` |
| `LAD41` | `platform.apply_inventory_move()` | el costeo declarado por el caso de uso no coincide con el oráculo exacto del esquema (costo de salida, costo unitario resultante o saldos). Casi siempre: la posición cambió entre el cálculo y el INSERT. **Desde 20261003140000 (ADR-0075 §7) también:** «kardex: el valor de un movimiento va al céntimo» — sobre una posición al céntimo llegó un valor con fracción de céntimo; no es carrera y reintentar no sirve (ver la sección «El mayor al céntimo» al final, con su mensaje de persona) | `COSTING_MISMATCH` | `409` |
| `LAD43` | `platform.apply_inventory_move()` | movimiento directo sobre un producto COMPUESTO, en cualquier dirección: no tiene existencias propias (ADR-0035, migración 20) | `COMPOSED_HAS_NO_STOCK` | `409` |
| `LAD44` | `platform.assert_recipe_shape()` · `assert_composed_flag_coherent()` | receta inválida: el padre no es compuesto, el hijo SÍ lo es (anidamiento no soportado), el hijo es un servicio, o se cambia `is_composed` de un producto que ya es ingrediente / ya tiene movimientos / ya tiene receta | `RECIPE_INVALID` | `409` |
| `LAD45` | *caso de uso* (`explodeRecipe`) | falta la fila de `unit_conversions` para pasar de la unidad de la receta a la del producto. **No lo lanza la base**: `convert_quantity()` devuelve `NULL` y el caso de uso lo traduce — el NULL es el mecanismo, el código es el contrato | `UNIT_CONVERSION_MISSING` | `422` |
| `LAD46` | `platform.apply_inventory_move()` | SALIDA de un lote ya vencido sin `inventory.expired` sobre ese almacén. Entrar sí se puede: el control es sobre lo que llega al cliente (ADR-0035) | `PERMISSION_REQUIRED` | `403` |
| `LAD47` | `platform.assert_variant_attributes()` | la variante declara un eje que su plantilla no tiene, o le falta uno que exige (ADR-0036, migración 20) | `VARIANT_ATTRIBUTES_INVALID` | `422` |
| `LAD49` | `platform.assert_document_issuance()` · `claim_fiscal_control()` (ADR-0071) · `claim_control_number()` (compatibilidad, sin ejecución para la API) | numeración fiscal (ADR-0037, ADR-0071): empresa sin régimen vigente, régimen que no permite emitir, `issued` **sin** número de control cuando el régimen lo exige, `issued` **con** número de control cuando el régimen no lo usa, sin talonario con papel para la serie («No quedan números de control para facturas (identificador 00). Carga el talonario nuevo.»), o talonario sin los datos de la imprenta («Al talonario serie A (identificador 00) le faltan los datos de la imprenta…»), o emitir con número de control sin su identificador (`documents_control_identifier`, ADR-0071 H9) | `FISCAL_NUMBERING_INVALID` | `409` |
| `LAD50` | `platform.resolve_tax()` | no hay regla tributaria vigente para esa fecha/jurisdicción/categoría, o hay **dos con la misma prioridad** (catálogo ambiguo). ADR-0038: nunca devuelve cero | `TAX_RULE_MISSING` | `409` |
| `LAD06` | *(también)* `platform.assert_range_printer_frozen()` (ADR-0071: imprenta de un talonario completo sin acta de corrección, identificador de un talonario que ya emitió, anular uno que emitió) · `platform.documents_control_identifier()` (identificador del control de un documento emitido) · `platform.documents_rate_basis_frozen()` (la base de la tasa de una nota emitida, hallazgo 13) · `platform.documents_due_date_frozen()` (el vencimiento de un documento emitido, P-05, migración 20261004210000; ningún camino de la API lo intenta) · `platform.assert_document_immutable()` · `assert_document_lines_immutable()` · `assert_purchase_doc_immutable()` · `assert_purchase_lines_immutable()` · desde la Fase C: `assert_payment_account_only_update()` (de un pago solo se corrige `account_id`), `assert_expense_backlink_only_update()` y `assert_cash_closing_backlink_only_update()` (solo el enlace al asiento), `assert_system_account_frozen()` y `assert_system_customer_frozen()` (lo de sistema ni se edita ni se borra) | editar o borrar un documento **emitido** o una compra **confirmada**, mover su correlativo o su control, o una transición de estado no permitida. Se corrige con nota de crédito o débito | `APPEND_ONLY_VIOLATION` | `409` |
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
| `ACCESS_REVOKED` | Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio. — ADR-0077 §3 (N-06), texto del dueño. |
| `INVITATION_UNAVAILABLE` | Esta invitación ya no se puede usar. Pide a quien te invitó un enlace nuevo. — el dominio dice cuál de los casos (usada, vencida, quien invitó ya no gestiona). |
| `INVITATION_FOR_OTHER_EMAIL` | Esta invitación es para otro correo. Entra con la cuenta del correo al que te invitaron. |
| `IDEMPOTENCY_BODY_MISMATCH` | El texto lo elige el servidor por `details.previous_status` (`personaDeOtroCuerpo`, ADR-0076 §12). `completed`: «Esa operación ya quedó registrada antes con otros datos. Revísala antes de repetirla.» · `in_progress`: «Esa operación todavía se está registrando. Espera un momento y revisa si quedó.» · `failed` u otro: «Esa operación ya se envió con otros datos; vuelve a intentarlo.» — 409: la misma `Idempotency-Key` en el mismo endpoint con OTRO cuerpo (ADR-0076). No se ejecuta nada. Con `completed` o `in_progress` la web NO estrena llave y enseña ese texto con el camino a revisar el intento anterior; con `failed`, estrena. |
| `IDEMPOTENCY_KEY_REUSED` | Esa operación se envió como si fuera otra; vuelve a intentarlo. — desde ADR-0076, SOLO la misma llave en OTRO endpoint (ADR-0056); otro cuerpo es `IDEMPOTENCY_BODY_MISMATCH`. |
| `POS_CART_SOLD` | Lo escribe el dominio: «Esa cuenta ya se cobró (venta X-N). No se puede cobrar ni cambiar otra vez: si el cliente quiere algo más, ábrele una cuenta nueva.» — 409, con `details.sale_id`, `series` y `document_number` (ADR-0076). |
| `CREDIT_LIMIT_EXCEEDED` | Lo escribe el dominio (E-09) — 409. Con límite 0: «A este cliente todavía no se le fía: su límite de fiado es 0. Lo fija quien administra el negocio (permiso customers.credit.set). Cóbrale la venta completa.» Pasado el límite: «El límite de fiado de este cliente es USD 10.00 y con esta venta quedaría debiendo USD 11.60. Cobra la diferencia, o pide a quien administra que le suba el límite.» Sin `sales.credit` la respuesta es `PERMISSION_REQUIRED` (403): «Necesitas el permiso para fiar. Pídeselo a quien administra el negocio.» Sin tasa de hoy para decir la deuda: `EXCHANGE_RATE_MISSING`. **Una sola puerta (R-82 punto 1):** las mismas respuestas, con los mismos mensajes, las da la factura de administración (`POST /v1/invoices`), que nace sin cobro; al «Consumidor final» responde 422 «Una venta de mostrador se cobra completa. Para fiar, identifica al cliente.» **El vencimiento (P-05, sin código nuevo: `VALIDATION_FAILED` 422, después de las respuestas de arriba):** la caja que deja saldo sin `due_date`: «Di cuándo paga el cliente: una venta fiada lleva su fecha de vencimiento. Elige la fecha en «¿Cuándo paga?» o cobra la venta completa.» (`details.reason = due_date_required`); una fecha anterior al día de la venta, en la caja y en la factura: «La fecha en que paga el cliente no puede ser anterior al día de la venta (dd/mm/aaaa).» (`due_date_before_sale`); un día que no existe: «La fecha en que paga el cliente no es un día del calendario.» (`due_date_invalid`). |
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

> **Ola 3 (2026-10-03, ADR-0068 §7–§8).** Permisos nuevos en `ACCION_DE_PERMISO`: `sales.refund` → «devolver dinero a un cliente», `treasury.overdraft` → «dejar una cuenta en negativo», `purchase.payment.approve` → «aprobar pagos grandes a proveedores». `GET /v1/customers?with_debt=1` sin `ar.read` da `PERMISSION_REQUIRED` («Necesitas el permiso para ver lo que deben los clientes…»). El cierre de caja (`POST /v1/cash-closings`) sobre una cuenta que no es caja: `NOT_FOUND` para quien no ve la cuenta (solo `cash.close`) y `VALIDATION_FAILED` «Solo se cierran cajas: «X» no es una caja.» para quien sí la ve; ninguno de los dos lleva el saldo. El logo y la foto del producto responden 403/404 ANTES de leer el archivo. `INSUFFICIENT_FUNDS` (sobregiro) lleva el saldo de la cuenta solo si quien opera tiene `treasury.read`; si no: «En «X» no alcanza para sacar …: quedaría en negativo…».


### Códigos de dominio del QA de pantalla (2026-09-15)

Estos viajan con el mensaje del DOMINIO como `person_message` (no están en la lista de mensajes
fijos): el texto dice qué pasó y qué hacer con los datos del caso.

| `code` | HTTP | Cuándo |
|---|---|---|
| `WAREHOUSE_IN_USE` | `409` | Apagar el depósito principal, o uno que todavía tiene mercancía (migración 60) |
| `OVER_INVOICED` | `409` | Lo facturado de una mercancía (acumulado, facturas no anuladas) pasaría de lo recibido (h. 86) |
| `MEMBER_NOT_REGISTERED` | `404` | Agregar a una persona cuyo correo no tiene cuenta en Ladino (h. 74) |
| `MEMBER_PROTECTED` | `403` | Un gestor acotado a la empresa intenta quitar roles o desactivar al Titular de la cuenta, o desactivar a quien trabaja en otra empresa que él no gestiona (ADR-0068 §3, N-02). El `person_message` es el del dominio: «Esa persona es el Titular de la cuenta: sus roles y su acceso solo los cambia el propio Titular.» / «Esa persona también trabaja en otra empresa de la cuenta. Quítale el rol en esta empresa; desactivarla del todo lo hace quien administra todas sus empresas.» |
| `ACCESS_REVOKED` | `404` | ADR-0077 §3 (N-06, N-03). El middleware de alcance lo responde EN LUGAR de `NOT_FOUND` solo a quien TUVO acceso a esa empresa (regla de `platform.lost_access_to_company`, migraciones 20261003120300 y 120500: una membresía desactivada con un rol de esa empresa, o de nivel tenant si la empresa ya existía cuando se desactivó —según el acta `member.deactivated`—; o un acta `member.role_revoked` de esa membresía cuyo `assignment_company_id` es esa empresa, o `null` —rol de nivel tenant— si la empresa ya existía cuando se quitó. Las actas sin esa clave, anteriores a esta ola, no cuentan: esa persona recibe `NOT_FOUND`): ya sabe que existe, así que decírselo no revela nada. Mismo `404` (la regla de este catálogo: 404 antes que 403). Un extraño, o un miembro con rol en otra empresa del tenant que pide una a la que nunca tuvo acceso, sigue recibiendo `NOT_FOUND` idéntico (`scope.test.ts`, «los TRES 404»). `person_message` fijo: «Tu acceso a esta empresa ya no está activo. Habla con quien administra el negocio.» — la web reemplaza la pantalla entera por ese aviso. |
| `INVITATION_UNAVAILABLE` | `409` | ADR-0077 §3 (N-08). La invitación ya se usó o fue anulada (LAD86), venció (LAD87), la membresía está desactivada y una invitación no la reactiva (LAD89), o quien la envió ya no gestiona las personas de esa empresa (LAD90). El `person_message` es el del dominio y dice cuál y qué hacer («Esta invitación venció. Pide a quien te invitó un enlace nuevo.»). |
| `INVITATION_FOR_OTHER_EMAIL` | `403` | ADR-0077 §3. La invitación está ligada a otro correo (LAD88): «Esta invitación es para otro correo. Entra con la cuenta del correo al que te invitaron.» |
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
| Poner el PRIMER RIF de la empresa (`PUT /v1/companies/tax-id`) sin `legal_name` (A-05, ADR-0050; ola 4) | «Con tu RIF, dinos la razón social tal como aparece en él: es el nombre que sale en tus facturas.» |
| `PUT /v1/companies/tax-id` con `legal_name` cuando la empresa ya tiene RIF (A-05; ola 4) | «La razón social se cambia en «Editar», no al cambiar el RIF: si ya emitiste documentos, pide un motivo y deja acta.» |
| `POST /v1/companies/tax-id/correct` sobre una empresa que todavía no tiene RIF (`PEND-…`) (A-05; revisión de la ola 4) | «Esta empresa todavía no tiene RIF, así que no hay nada que corregir: ponlo en «Poner mi RIF», con su razón social.» |

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
| `LAD85` | `NOT_FOUND` | `404` | Token de invitación que no existe (ADR-0077) |
| `LAD86` | `INVITATION_UNAVAILABLE` | `409` | Invitación ya usada por otra cuenta, o anulada |
| `LAD87` | `INVITATION_UNAVAILABLE` | `409` | Invitación vencida |
| `LAD88` | `INVITATION_FOR_OTHER_EMAIL` | `403` | Invitación ligada a otro correo |
| `LAD89` | `INVITATION_UNAVAILABLE` | `409` | La membresía está desactivada: una invitación nunca la reactiva (revisión H1) |
| `LAD90` | `INVITATION_UNAVAILABLE` | `409` | Quien invitó ya no tiene `membership.manage` sobre la empresa |
| `LAD93` | `PERMISSION_REQUIRED` | `403` | «Crear otra empresa» sin ser Titular de ninguna cuenta |
| `LAD94` | `DUPLICATE` | `409` | Ya tiene un negocio con ese nombre o ese RIF (clave natural de la otra empresa) |
| `23505` | `IDEMPOTENCY_KEY_REUSED` / `DUPLICATE` | `409` | Según el índice que se viole (el middleware responde `IDEMPOTENCY_BODY_MISMATCH` u `IDEMPOTENCY_KEY_REUSED` antes de llegar al índice; ADR-0076) |
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

## Salidas y retiros de inventario (ADR-0078, 20261003110000)

| Camino | Cuándo | `code` | HTTP | Mensaje (lo que ve la persona) |
|---|---|---|---|---|
| esquema `IssueStockRequest.reason` | salida sin motivo o con uno fuera de la lista | `VALIDATION_FAILED` | `422` | «Elige el motivo de la salida: merma, rotura, vencido, faltante, consumo propio, regalo, donación o muestra.» con `details[].path = ["reason"]`: la pantalla marca el campo (I-09) |
| `valorDeRetiro` | retiro en empresa que factura, producto sin precio en la lista principal | `VALIDATION_FAILED` | `422` | «El retiro se valora al precio de venta (LIVA art. 4.3) y este producto no tiene precio en tu lista de precios principal. Ponle precio y vuelve a registrar la salida.» |
| `valorDeRetiro` | lista en divisa sin tasa del día | `EXCHANGE_RATE_MISSING` | `409` | «No hay tasa de USD a VES vigente para hoy: el retiro se valora al precio de venta en bolívares…» |
| trigger `assign_withdrawal_note` | nota de retiro que no corresponde a una salida de retiro de esa empresa | `23514` → `VALIDATION_FAILED` | `422` | genérico (no lo alcanza la API: el dominio solo emite notas de sus propias salidas) |

### Revisión (20261003110100)

| Camino | Cuándo | `code` | HTTP | Mensaje |
|---|---|---|---|---|
| `issueStock` | merma, rotura, vencido o faltante sin `evidence` | `VALIDATION_FAILED` | `422` | «Una merma, rotura, vencimiento o faltante necesita su evidencia: escribe la referencia del acta, la foto o el informe que la respalda (RLIVA art. 14).» |
| `countStock` | conteo que da faltante, registrado sin `evidence` (la vista previa y el sobrante no la piden) | `VALIDATION_FAILED` | `422` | «El conteo dio un faltante: va a pérdidas y necesita su evidencia. Escribe la referencia del acta, la foto o el informe que lo respalda (RLIVA art. 14).» |
| `issueStock` | retiro con `occurred_at` en un período cuya declaración se generó después de cerrarse | `VALIDATION_FAILED` | `422` | «El período del … al … ya se declaró: un retiro con esa fecha cambiaría una declaración presentada. Regístralo con la fecha de hoy.» |
| `countStock` | producto con lotes sin `lot_id` (antes de bloquear) | `VALIDATION_FAILED` | `422` | «Elige el lote que contaste: este producto se lleva por lotes y cada lote se cuenta aparte.» |
| `countStock` | `expected_system_quantity` distinto del sistema bajo el bloqueo | `CONFLICT` (nuevo) | `409` | «La existencia cambió desde que calculaste la diferencia: el sistema tiene ahora N y viste M. Vuelve a calcular la diferencia.» · persona: «Algo cambió mientras lo revisabas. Vuelve a calcularlo y confirma de nuevo.» |

## Sin RIF y la llegada (ola 3, 20261003160000)

| Código | Dónde | Cuándo | `code` | HTTP | Mensaje de persona |
|---|---|---|---|---|---|
| `LAD96` | trigger `supplier_invoices_fiscal_needs_tax_id` | factura de proveedor CON soporte fiscal a un proveedor nacional sin RIF (D-04). El caso de uso lo dice antes; el trigger cierra cualquier otro camino | `VALIDATION_FAILED` | `422` | «Esta factura necesita el RIF del proveedor, que viene impreso en ella, y este proveedor está guardado sin RIF. Agrégalo como proveedor con su RIF y vuelve a registrar la factura.» (AF3-14: sin la salida «no va a haber factura») |
| — | `registerSupplierInvoice` | «Falta el tipo de contribuyente de la empresa…» ya solo con factura (D-01): sin soporte fiscal no hay IVA que discriminar | `VALIDATION_FAILED` | `422` | sin cambios |
| — | `registerArrival` · `prices_include_tax` | sin alícuota de compra vigente para quitar el IVA del precio escrito (D-05) | `TAX_RULE_MISSING` | `409` | «No hay alícuota de IVA de compra vigente para ese producto ese día: sin ella no se puede quitar el IVA del precio. Escribe el precio sin IVA, como viene en la factura.» |

`POST /v1/arrivals/preview` (D-05) falla con los MISMOS códigos que `POST /v1/arrivals` —es el mismo caso de uso, deshecho al terminar—: `EXCHANGE_RATE_MISSING` (D-09), el `LAD96`/422 de arriba, etc. Un proveedor nacional sin RIF ya no da 422 al crearse (antes «Un proveedor nacional necesita RIF…», que desaparece).

`INSUFFICIENT_FUNDS` (D-13): los importes del mensaje van con formato de dinero de la moneda de la cuenta («Bs. 120.000,00»), redondeados a sus decimales SOLO para el texto; antes «120000.00000000».

## El mayor al céntimo (ADR-0075 §7, 20261003140000)

| SQLSTATE | Dónde | Cuándo | `code` / HTTP | `person_message` |
|---|---|---|---|---|
| `LAD41` — «kardex: el valor de un movimiento va al céntimo» | `platform.apply_inventory_move()` | sobre una posición cuyo valor ya está al céntimo llega un movimiento con fracción de céntimo (un cliente viejo, o un camino que no pasa por `costing.ts`). No es una carrera: reintentar no sirve | `VALIDATION_FAILED` (traducido en `traducir`, packages/domain/src/inventory.ts) / `422`; si llega crudo, `COSTING_MISMATCH` / `409` | El importe de este movimiento tiene más de dos decimales y el inventario se lleva al céntimo. Escribe el costo con dos decimales como máximo y vuelve a intentar. |

| `LAD71` — «Los importes del asiento llevan como máximo dos decimales» | `platform.assert_entry_balanced()` (20261003190000; el mismo trigger que comprueba la partida doble) · antes, `createManualJournalEntry` (packages/domain/src/accounting.ts) con el mismo texto | al POSTEAR un asiento con una línea cuyo importe en moneda funcional tiene más de dos decimales. La única excepción está en el enunciado y es un mecanismo, no una etiqueta: el asiento cuyo id registró `platform.cent_regularization_prepare` en `platform.cent_regularization_entries` (tabla sin GRANT a nadie, 20261003190200); escribir `source_event = 'stock.cent_regularized'` desde la API no exime. Los asientos ya posteados no se tocan; la reversa de uno viejo se genera al céntimo | `VALIDATION_FAILED` / `422` (por el dominio y también si llega crudo) | Los importes del asiento llevan como máximo dos decimales. |

El mensaje técnico (`message`) dice: «El valor de un movimiento de inventario va al céntimo (ADR-0075 §7): llegó un importe con más de dos decimales.» Lo distingue del LAD41 de carrera el texto «va al céntimo» del error de la base, que es lo que mira `traducir`.

### Confirmar un sobregiro (D-11, H-05) y los libros sin RIF (AF3-13)

| Dónde | Cuándo | `code` | HTTP | Mensaje de persona |
|---|---|---|---|---|
| `exigeSaldo` (gasto, transferencia, pago a proveedor, reembolso) | el egreso deja la cuenta en negativo y el cuerpo NO lo confirma | `INSUFFICIENT_FUNDS` | `409` | con `treasury.overdraft`: «… quedaría en negativo. Revisa de qué cuenta sale, o regístralo igual con su motivo.»; sin él: «… quedaría en negativo. Elige otra cuenta o pídele a quien administra que lo registre.» El saldo solo aparece con `treasury.read`. Ya no dice «confirma que quieres registrarlo igual» |
| `exigeSaldo` | lo confirma (`allow_negative_balance`) quien no tiene `treasury.overdraft` | `PERMISSION_REQUIRED` | `403` | «Esta cuenta no tiene saldo suficiente. Elige otra cuenta o pídele a quien administra que lo registre.» (frase propia de este permiso en `personaDePermiso`) |
| `exigeSaldo` | lo confirma quien puede, sin `overdraft_reason` o con menos de 5 caracteres | `VALIDATION_FAILED` | `422` | «Para dejar una cuenta en negativo hay que decir el motivo: escribe por qué se registra sin saldo (queda en el historial).» |
| `GET /v1/fiscal-books/:kind` · `POST /v1/fiscal-books/export` | la empresa no tiene RIF (`PEND-…`) | `REGIME_KIND_NOT_ALLOWED` | `409` | «Los libros de compras y ventas son de quien tiene RIF, y este negocio no tiene RIF: sus compras y ventas no van a libros ni a declaraciones. Cuando tengas tu RIF, regístralo en Mi empresa.» |

El sobregiro confirmado deja el acta `treasury.overdraft.confirmed` (agregado `company_account`): `actor_id`, `account_id`, `account_name`, `currency`, `amount`, `balance_before`, `balance_after`, `reason`, `operation` (`expense` · `transfer` · `supplier_payment` · `refund`). Si el saldo alcanza, `allow_negative_balance` no exige ni permiso ni motivo.

## Reversa de cobros y revaluación al cierre (ADR-0075 §6 y §8, migración 20261003180000)

| Origen | Dónde nace | `code` | HTTP | Mensaje para la persona |
|---|---|---|---|---|
| caso de uso | `annulInvoice` (G-10): la factura es de otro día (`details.reason = not_same_day`) | `ANNULMENT_NOT_ALLOWED` | `409` | «Esta factura es de otro día y ya no se anula: solo se anula el mismo día, si el papel no salió del negocio. Se corrige con una nota de crédito (o con una devolución, si el cliente devuelve la mercancía).» |
| caso de uso | `annulInvoice` (G-10): una caja de la empresa se cerró después de emitirla (`cash_closed`; cualquier caja, 20261004160300) | `ANNULMENT_NOT_ALLOWED` | `409` | «La caja ya se cerró después de emitir esta factura y ya no se anula. Se corrige con una nota de crédito (o con una devolución, si el cliente devuelve la mercancía).» |
| caso de uso | `annulInvoice` (G-10): el período de IVA de la factura ya se declaró (`period_declared`; declarado = generado después de cerrar el período, así que llega siempre detrás de `not_same_day`, que tiene prioridad: este mensaje es red de seguridad) | `ANNULMENT_NOT_ALLOWED` | `409` | «El período de esta factura ya se declaró y ya no se anula. Se corrige con una nota de crédito (o con una devolución, si el cliente devuelve la mercancía).» |
| caso de uso | `annulInvoice` (G-10): falta `originals_in_hand: true` (`originals_not_confirmed`) | `ANNULMENT_NOT_ALLOWED` | `409` | «Para anular esta factura confirma que tienes en la mano el original y todas las copias. Si ya se entregó al cliente, no se anula. Se corrige con una nota de crédito (o con una devolución, si el cliente devuelve la mercancía).» |
| caso de uso | `refundCustomerCredit` (G-07): quien pide no tiene `sales.refund` | `PERMISSION_REQUIRED` | `403` | «Necesitas el permiso para devolver dinero a un cliente. Pídeselo a quien administra el negocio.» |
| caso de uso | `createDirectCreditNote` (G-07, migración 20261004160300): quien pide no tiene `sales.credit_note.direct` (el cajero: tiene `sales.return.manage`, que ya no la abre) | `PERMISSION_REQUIRED` | `403` | «Necesitas el permiso para emitir notas de crédito sin devolución de mercancía. Pídeselo a quien administra el negocio.» |
| caso de uso | `annulInvoice` (G-10): quien pide no tiene `sales.invoice.annul`, aunque la factura además esté bloqueada por la regla del papel (se autoriza ANTES de evaluar la regla: el 403 no lleva `details.reason`) | `PERMISSION_REQUIRED` | `403` | «Necesitas el permiso para anular ventas. Pídeselo a quien administra el negocio.» |
| caso de uso | `reversePayment`: el cobro ya tiene reversa | `PAYMENT_ALREADY_REVERSED` | `409` | «Este cobro ya fue reversado. Un cobro se reversa una sola vez.» |
| caso de uso | `reverseSupportedRetention`: el comprobante ya está anulado | `PAYMENT_ALREADY_REVERSED` | `409` | «Este comprobante de retención ya está anulado.» |
| caso de uso (y trigger `payment_reversals_05_fill`, `LAD95`) | el IGTF del cobro se documentó con nota de débito | `IGTF_NOTE_ISSUED` | `409` | «Este cobro documentó su IGTF con la nota de débito N. Una nota de débito emitida es un documento fiscal y no se deshace reversando el cobro: consulta con tu contador cómo corregirla antes de reversar.» |
| caso de uso | `registerPayment` / `registerSupplierPayment`: el cobro o pago que CIERRA dejaría un diferencial (o un redondeo, en la retención soportada) fuera de la cota del redondeo (ADR-0075 §4, regla 4) | `SETTLEMENT_MISMATCH` | `409` (mapeado a 409 en errors.ts desde la ola 3, con test) | «Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.» · en compras: «Este pago no cuadra con lo que la factura todavía debe. No se registró: revisa la factura.» |
| caso de uso | el abono de una retención reversado como cobro | `VALIDATION_FAILED` | `422` | «Este abono es un comprobante de retención de IVA: no se reversa como un cobro. Lo corrige el contador desde el comprobante (Retenciones que nos practican).» |
| caso de uso | `reverseSupportedRetention`: el comprobante ya entró en una declaración de IVA presentada (ADR-0075 §8, H9; P-89) | `RETENTION_PERIOD_DECLARED` | `409` | «Este comprobante ya entró en una declaración presentada. Corregirlo exige una declaración sustitutiva o un ajuste: habla con tu contador.» |
| caso de uso | `reversePayment`: el período contable de HOY está cerrado y el contra-asiento no tiene dónde asentarse (ADR-0069) | `PERIOD_CLOSED` | `409` | «El período contable de hoy está cerrado: el contra-asiento de esta reversa no tiene dónde asentarse. Reabre el período o espera al siguiente, y vuelve a reversar.» |
| caso de uso | `closeFiscalPeriod`: no hay tasa oficial dentro del margen para la fecha de cierre (ADR-0075 §6, H7; P-88) | `VALIDATION_FAILED` | `422` | «Falta la tasa BCV del cierre (dd/mm/aaaa). Cárgala y vuelve a cerrar.» |
| permiso | `reversePayment` / `reverseSupportedRetention` sin `ar.payment.reverse` / `ar.retention.correct` | `PERMISSION_REQUIRED` | `403` | «Necesitas el permiso para reversar un cobro. Pídeselo a quien administra el negocio.» / «Necesitas el permiso para corregir una retención que le practicaron al negocio. Pídeselo a quien administra el negocio.» |
| caso de uso | motivo de menos de 10 caracteres | `VALIDATION_FAILED` | `422` | «Escribe el motivo de la reversa (entre 10 y 300 caracteres): queda en el acta.» |
| `closeFiscalPeriod` (`LAD51` de `fx_revaluation_items`) | sin tasa BCV al último día del período | `VALIDATION_FAILED` | `422` | «No hay tasa del día de cierre (fecha) para revaluar las cuentas en divisa. Cárgala con su fuente y vuelve a cerrar.» |
| `closeFiscalPeriod` | falta la cuenta de ganancia o pérdida en diferencial | `VALIDATION_FAILED` | `422` | «Falta configurar la cuenta de ganancia (o pérdida) en diferencial cambiario: la revaluación de «partida» al cierre no tiene dónde asentarse. Asígnala en el plan de cuentas y vuelve a cerrar.» |
| trigger `documents_immutable` (`LAD06`) | `paid → issued` sin un cobro reversado | `VALIDATION_FAILED` | `422` | no se alcanza desde la API: solo la reversa de un cobro produce esa transición |

`EXCHANGE_RATE_MISSING` en la llegada (D-09): `POST /v1/arrivals` y `/v1/arrivals/preview` lo devuelven (409) cuando la llegada cruza monedas y la tasa oficial vigente a su fecha no existe o es más antigua que `platform.parameters.closing_rate_max_age_days`: «No hay tasa del BCV vigente para ese día: la última publicada es demasiado vieja o no existe. Tráela en Mi dinero y vuelve a registrar la llegada.» La vista previa devuelve además `fx_rate` y `fx_rate_date` (la tasa que se usaría y el día en que se publicó).

### El gasto con factura fiscal y la vista previa del pago (ola 4: H-09, H-08, D-02)

| Origen | Cuándo | `code` | HTTP | Mensaje de persona |
|---|---|---|---|---|
| caso de uso `registerInvoicedExpense` | el cuerpo trae `invoice` y además `amount` | `VALIDATION_FAILED` | `422` | «Con factura fiscal no se escribe el importe: sale de las bases de la factura, su IVA y lo que se retiene. Quita el importe o registra el gasto sin factura.» |
| caso de uso `registerExpense` | sin `invoice` y sin `amount` | `VALIDATION_FAILED` | `422` | «Falta el importe del gasto.» |
| caso de uso `registerSupplierInvoice` (línea de servicio) | la categoría tributaria de una base no está en `product_tax_categories` | `VALIDATION_FAILED` | `422` | «La categoría tributaria «…» no está en el catálogo.» |
| caso de uso `registerInvoicedExpense` | el proveedor del gasto y el de su factura no coinciden | `VALIDATION_FAILED` | `422` | «El proveedor del gasto y el de su factura no coinciden.» |
| caso de uso `registerInvoicedExpense` | el cuerpo trae `branch_id` | `VALIDATION_FAILED` | `422` | «Un gasto con factura fiscal todavía no se asigna a una sucursal: regístralo sin sucursal.» |
| trigger `supplier_invoice_lines_02_service_line` (`LADH9`) | una línea sin producto fuera de la factura de un gasto | `VALIDATION_FAILED` | `422` | «Cada línea de una factura de mercancía lleva su producto. Una línea sin producto solo va en un gasto con factura fiscal.» (no se alcanza desde la API: el esquema público exige `product_id`) |
| ruta `POST /v1/expenses/attachment` | el contenido del archivo no es el del tipo declarado (se leen sus primeros bytes: PDF, PNG, JPEG, WebP) | `VALIDATION_FAILED` | `422` | «El archivo no es lo que dice ser: su contenido no es el de una foto (JPG, PNG, WebP) ni el de un PDF.» |
| casos de uso `registerExpense` y `registerInvoicedExpense` | `attachment_path` no empieza por `<empresa de la sesión>/receipts/` | `VALIDATION_FAILED` | `422` | «Ese comprobante no es de esta empresa. Vuelve a adjuntarlo desde el formulario del gasto.» |
| `POST /v1/expenses` y `/v1/expenses/preview` con factura en una moneda y cuenta en otra | el pago que cierra no cabe en la cota del redondeo (ADR-0075 regla 4): el saldo de la factura y su mayor no cuadran. El redondeo de caja del pago cruzado ya NO lo dispara (ADR-0075, nota «el pago cruzado a tasa real», 2026-10-04) | `SETTLEMENT_MISMATCH` | `409` | «Este pago no cuadra con lo que la factura todavía debe. No se registró: revisa la factura.» |
| ruta `POST /v1/expenses/attachment` | el archivo pesa más de 6 MB | `VALIDATION_FAILED` | `422` | «El comprobante pesa más de 6 MB. Sube una foto más liviana o un PDF más corto.» |
| `POST /v1/expenses/preview` | el cuerpo no trae `invoice` (un gasto llano no tiene nada que calcular) | `VALIDATION_FAILED` | `422` | «Falta la factura del gasto.» |
| `POST /v1/expenses` y `/v1/expenses/preview` con factura (AF4-01, 2026-10-04; PA SNAT/2025/000054 art. 3 num. 8, reproducción no oficial; P-95) | la exclusión `servicio_publico_domiciliado` marcada en un gasto que sale de una cuenta que no es bancaria (caja o monedero). No se escribe nada | `VALIDATION_FAILED` | `422` | «Esa exclusión es para servicios pagados por domiciliación desde una cuenta bancaria. Este gasto sale de «Caja», que no es una cuenta de banco: se le retiene. Quita la exclusión, o elige la cuenta del banco si de verdad se pagó por domiciliación.» |
| `GET /v1/retention-exclusions?account_id=…` (AF4-01) | la cuenta no existe o no es de la empresa (o el id no es un uuid) | `NOT_FOUND` | `404` | «Recurso no encontrado.» |
| `POST /v1/expenses/preview` | lo mismo que fallaría al registrar la factura del gasto (proveedor sin RIF, categoría fuera del catálogo, exclusión inválida, sin regla de retención, sin tasa) | el del registro | el del registro | el del registro: la vista previa corre el mismo caso de uso y lo deshace. Si la cuenta no alcanza NO es un error: responde 200 con las cifras y `insufficient_funds` (el mensaje del control de saldo) |
| `POST /v1/supplier-payments/preview` | lo mismo que fallaría al pagar (sin tasa, por encima del saldo, fuera del tope). Si la cuenta no alcanza responde 200 con el resumen e `insufficient_funds` | el del pago | el del pago | el del pago: la vista previa corre el mismo caso de uso y lo deshace |

El gasto con factura devuelve además todos los errores de `registerSupplierInvoice` (proveedor sin RIF, falta el tipo de contribuyente, `RETENTION_RULE_MISSING`, la exclusión fuera del catálogo o por encima de su tope) y de `registerSupplierPayment` (`INSUFFICIENT_FUNDS`, `EXCHANGE_RATE_MISSING`), con sus mismos mensajes.

### Ola 4 · cobros, saldos a favor y reversas (F-06, F-10, G-05, G-15)

**«El cobro supera lo pendiente… regístralo como saldo a favor con una nota de crédito» ya no existe (F-10).** Un pago de más se acepta: responde 201 y el sobrante vuelve en `customer_credit` (`{ id, amount, currency }`).

| Dónde | Cuándo | `code` | HTTP | Mensaje de persona |
|---|---|---|---|---|
| `registerPayment` | el pago de más es en divisa y causa IGTF | `VALIDATION_FAILED` | `422` | «Lo recibido supera lo que falta y este pago causa IGTF: sobran 2.22 USD. Registra lo que queda y entrega el vuelto.» |
| `registerPayment` | una retención de IVA, o un cobro a un documento que ya no debe nada, supera lo pendiente | `VALIDATION_FAILED` | `422` | «El abono supera lo pendiente: quedan 0.00 USD por cobrar. Ajusta el importe.» |
| `registerPayment` | lo que el cobro guardó como cancelado no es lo que se asienta | `SETTLEMENT_MISMATCH` | `409` | «Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.» |
| `reversePayment` | el cobro dejó un saldo a favor (pagó de más) que ya se APLICÓ a otro documento | `VALIDATION_FAILED` | `422` | «Este cobro dejó un saldo a favor que ya se usó: no se puede reversar. Reversa primero el cobro que lo aplicó.» |
| `reversePayment` | el cobro dejó un saldo a favor que ya se REEMBOLSÓ, entero o en parte (un reembolso no tiene reversa) | `VALIDATION_FAILED` | `422` | «Este cobro dejó un saldo a favor que ya se usó: se le devolvió al cliente en dinero, y un reembolso no se deshace. Este cobro ya no se puede reversar.» |
| `registerPayment` (`saldo_a_favor`) · `refundCustomerCredit` | el saldo a favor está RETIRADO (`expired`): se reversó el cobro que lo creó, el dinero salió y el contra-asiento deshizo el pasivo. El esquema lo impide también (trigger `customer_credits_retired`, 23514) | `VALIDATION_FAILED` | `422` | «Ese saldo a favor se retiró al reversar el cobro que lo creó: ya no se aplica ni se reembolsa.» |
| `registerPayment` (`saldo_a_favor`) · `refundCustomerCredit` | el saldo a favor ya se usó entero (`applied`) | `VALIDATION_FAILED` | `422` | «Ese saldo a favor ya se usó entero: no queda nada que aplicar.» / «…no queda nada que reembolsar.» |
| `registerPayment` (`saldo_a_favor`) | se aplica más de lo que el documento debe (antes no tenía tope: el exceso se consumía y la cuenta por cobrar quedaba negativa). No se consume nada: el saldo conserva su resto | `VALIDATION_FAILED` | `422` | «El saldo a favor que se aplica supera lo pendiente: quedan 1160.00 VES por cobrar. Aplica hasta ese importe: lo demás sigue a favor del cliente.» |
| `registerPayment` | pago de más en divisa con una forma que causa IGTF: el vuelto se dice EN LA MONEDA DEL PAGO (antes, en la del documento) | `VALIDATION_FAILED` | `422` | «Lo recibido supera lo que falta y este pago causa IGTF: sobran 0.50 USD. Registra lo que queda y entrega el vuelto.» |
| campo de dinero de la web (`leerImporte`, sobre `readAmountText`) | un solo separador y exactamente tres cifras detrás, sea punto o coma («26.003», «1,234») | — (no llega al servidor) | — | «“1,234” se puede leer de dos maneras: con miles o con decimales. Escribe el número sin separador de miles (26003) o con sus céntimos (26.003,00).» |
| campo de dinero de la web | termina en el separador («5,», «5.») | — | — | «A “5,” le faltan los decimales. Escríbelos (5,00) o quita el separador (5).» |
| campo de dinero de la web | con los dos separadores, los miles no van de tres en tres («12.34,56», «1.234,567.89») | — | — | «En “12.34,56” los miles no van de tres en tres. Escríbelo como 26.003,58 o sin separador de miles (26003,58).» |
| `refundCustomerCredit` | la cuenta o el saldo a favor están en divisa y no hay tasa de hoy | `EXCHANGE_RATE_MISSING` | el de ese código | «No hay tasa de USD a VES para hoy: sin ella no se puede reembolsar en otra moneda.» |
«Ese saldo a favor ya no está disponible: no se reembolsa» ya no existe (tercera ronda de cobros): un saldo retirado dice que se retiró y uno agotado dice que se usó entero (las dos filas de arriba).
| `refundCustomerCredit` | lo que saldría de la cuenta no llega a un céntimo de su moneda | `VALIDATION_FAILED` | `422` | «El importe a reembolsar es menor que un céntimo de la cuenta de la que sale.» |

«El saldo a favor está en X y la cuenta en Y: el reembolso sale de una cuenta en la moneda del saldo» ya no existe (G-15): el reembolso sale en la moneda de la cuenta, a la tasa del día.

**En la pantalla (no son códigos nuevos):** un campo de dinero que no puede leer lo tecleado lo dice debajo —«Escribe el importe.», «Eso no es un importe. Escribe solo el número, por ejemplo 26.003,58.», «“26.003” se puede leer de dos maneras. Escribe los decimales con coma (26.003,58) o el número sin puntos de miles (26003).», «El importe no puede ser negativo.», «El importe admite hasta 16 cifras enteras y 8 decimales.»— (`leerImporte`, `apps/web/src/components/forms.tsx`). El diálogo de reversa (`ReversarCobro.tsx`) añade al mensaje del servidor qué hacer con `IGTF_NOTE_ISSUED`, `PAYMENT_ALREADY_REVERSED`, `RETENTION_PERIOD_DECLARED` y `PERIOD_CLOSED`.

`EXCHANGE_RATE_MISSING` con una sola regla (ola 4, migración 20261004195900). «La tasa del día» de una fecha es la oficial más reciente no posterior **y no más antigua que `platform.parameters.official_rate_max_age_days`** (7; `closing_rate_max_age_days` es su alias). La regla vive en `platform.rate_for`, así que el 409 ya no es solo «no existe ninguna tasa»: también «la última publicada es más vieja que el margen», y lo devuelve toda operación que convierte (cotizar, emitir, cobrar, registrar la factura o el pago de un proveedor, el gasto, la transferencia, el costo de importación, la llegada, el cierre). Mensaje de persona (`mensajeFaltaTasa(dia, hoy)`, `packages/domain/src/tasa-oficial.ts`; lo usan `tasaA` de compras, `tasaHoy` de tesorería y `condicionDePago` de cobros), con el día del hecho y según lo que la persona puede hacer:

| situación | mensaje |
|---|---|
| el día que falta es hoy | «Falta la tasa BCV del dd/mm/aaaa. Tráela en Mi dinero.» |
| es hoy y hay una guardada, pero más vieja que el margen (vistas previas: `previsualizarConversion`, `GET /v1/negocio/convertir`, el vuelto) | «Falta la tasa BCV del dd/mm/aaaa: la última guardada es del dd/mm/aaaa. Tráela en Mi dinero.» |
| es un día PASADO (Mi dinero solo trae la de hoy, ADR-0064 §1) | «No hay tasa BCV guardada para el dd/mm/aaaa. Fecha la operación en un día con tasa, o escribe a soporte para cargar la oficial de ese día.» |
| es un día FUTURO (ninguna validación rechaza antes un gasto, un pago o una factura de proveedor fechados más adelante; llega aquí cuando ese día queda más allá del margen de la última guardada) | «La tasa BCV del dd/mm/aaaa todavía no se ha publicado: ese día aún no llega. Fecha la operación hoy o en un día que ya tenga tasa.» |

`TRUNCATE platform.parameters` (migración 20261004200100) — no llega por la API; lo ve quien opera la base. SQLSTATE `0A000`: «LADINO_PARAMETERS_TRUNCATE: platform.parameters no se vacía. Sin sus parámetros la regla de la tasa del día (platform.rate_for) no devuelve ninguna tasa y toda conversión se detiene. Para retirar un parámetro, bórralo por su clave: deja acta.»

`PERMISSION_REQUIRED` al leer comprobantes de retención (`apps/api/src/routes/retention-vouchers.ts`): el mensaje nombra todos los permisos que abren ESA lectura. En el comprobante de un gasto con factura: «Consultar comprobantes de retención exige ap.read, purchase.invoice.register, retention.receipt.issue o expense.register.»; en las demás: «… exige ap.read, purchase.invoice.register o retention.receipt.issue.»

Resumen del negocio y estado de cuenta del proveedor sin tasa (revisión de la ola 4): `sin_tasa` quiere decir «hay DEUDA en divisa que hoy no se puede valorar». Una factura en divisa que no debe nada (saldo cero o negativo) no lo provoca: `lo_que_debo` y `total_outstanding` traen su cifra. Lo decide `platform.supplier_debt_today` (NULL = se debe y no se puede valorar), no una pre-comprobación de la tasa.

La llegada conserva «No hay tasa del BCV vigente para ese día: …».

**Qué lecturas no fallan y cuáles sí (migración 20261004200000).** Las de LISTA y de PANTALLA no lanzan por una tasa: devuelven `null` y la pantalla dice «Falta la tasa de hoy» con el nominal por moneda — la deuda de clientes (`platform.document_debt`, `customer_debt_today`, `ar_aging`, `customer_credit`), la de proveedores (`platform.supplier_debt_today`, `ap_aging`; `GET /v1/suppliers/:id/statement` y `/aging` con `total_outstanding_motivo` / `total_motivo` = `sin_tasa`) y el resumen (`lo_que_debo_motivo`). `null` no es cero. Las que convierten para ESCRIBIR sí se detienen: el saldo estricto de un documento en divisa (`platform.document_balance_transaction`, LAD51, al cobrar o reversar), la revaluación al cierre (`platform.fx_revaluation_items`, LAD51 → `VALIDATION_FAILED` 422 con el día), la regularización de la divisa y toda operación con `EXCHANGE_RATE_MISSING`. Antes de esa migración, el estado de cuenta de un proveedor con una factura en divisa respondía 500 sin tasa dentro del margen, aunque no se le debiera nada.

### Ola 4 · la versión de reglas (ADR-0079): `LAD00` es operativo, no de persona

`LAD00` **no está en la tabla de SQLSTATE de la API** (`apps/api/src/middleware/errors.ts`): cae en el caso general y el cliente recibe `INTERNAL` / `500` / «Error interno.» (`errors.ts:327`). Es deliberado: ninguno de los tres casos lo puede arreglar quien está en el mostrador. El texto legible va en el mensaje de Postgres y queda en el log de la base (Supabase → Logs → Postgres); lo lee quien opera. `onErrorResponder` (`errors.ts:702-737`) no escribe el error crudo en el log de la API: que un 500 deje ahí el mensaje de Postgres está **no verificado**, así que se busca por `request_id` y hora en el log de la base.

| Mensaje (empieza por) | Quién lo levanta | Cuándo | Qué ve el cliente | Qué hacer (quien opera) |
|---|---|---|---|---|
| `LADINO_RULES_HASH_BLIND` | `platform.assert_rules_reader_sees_all()` (migración 20261004120200), llamada por `platform.rules_global_hash()` y `platform.current_rules_version()` | el rol que calcula el hash de reglas no tiene `BYPASSRLS` ni es superusuario: leería cero reglas en silencio y toda versión sería la misma | `500` en **toda** escritura que lleve `rules_version` (documentos, asientos, actas): la API deja de escribir | `select rolbypassrls from pg_roles where rolname = 'postgres';` tiene que dar `t`. Es paso del ensayo en seco ANTES de aplicar las migraciones (R-81.10); si da `f`, no se aplican y se decide otro dueño para esas funciones. La 20261004120200 llama al hash al aplicarse: con el rol equivocado falla la migración, no la primera venta |
| `LADINO_RULES_VERSION` | `platform.current_rules_version()` (definición vigente: 20261004120300) | no hay ninguna fila en `platform.rules_releases` o `platform.rule_set_state` no tiene hash global | `500` en toda escritura con `rules_version` | las dos filas las siembran las migraciones de la familia; si faltan, la base no tiene aplicada la familia entera (20261004120000 a 20261004205000, en orden) |
| `LADINO_INVARIANT_WITHOUT_CUTOFF` | `platform.rules_version_gaps()` y `platform.global_rate_record_gaps()` (migración 20261004205000) | falta la fila del invariante en `platform.invariant_cutoffs` | nada: la API no llama a los invariantes. Lo ve el recorrido o quien los consulte, como error y no como «cero filas» | reponer la fila del corte con su fecha y su razón. Un invariante sin corte no puede afirmar cero |

Mensaje de persona: no hay uno propio. Quien vende ve el genérico de un 500; el arreglo es de quien opera la base.
