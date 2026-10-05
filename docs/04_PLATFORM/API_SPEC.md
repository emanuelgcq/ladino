# API — Ladino

REST JSON bajo `/v1`. Hono sobre Node 22 (ADR-0012). Contrato OpenAPI generado desde los
esquemas Zod de `packages/schemas` (ADR-0004): el build falla si `openapi.json` difiere del
generado.

## La capa es delgada

```
autenticar → autorizar (resource.action) → validar (Zod) → delegar a un caso de uso → mapear a HTTP
```

Cero reglas de negocio en los handlers. Si estás calculando un impuesto en un endpoint,
está en el paquete equivocado.

## Headers

| Header | Uso |
|---|---|
| `Authorization: Bearer` | token del usuario |
| `Idempotency-Key` | obligatorio en todo endpoint mutante crítico |
| `X-Company-Id` | empresa en contexto; validada contra el alcance del usuario |
| `X-Request-Id` | correlación de trazas y logs |

## Dinero en el contrato

**Todo valor monetario viaja como objeto `{ amount, currency }`. Nunca como string escalar,
nunca como número JSON.**

```json
{ "amount": "1234.56000000", "currency": "VES" }
```

- `amount`: string decimal canónico, **siempre 8 decimales**, notación plana, sin separador de
  miles, sin exponente. En OpenAPI: `type: string, format: decimal`, `pattern` de 8 decimales.
- `currency`: código ISO-4217. **Obligatorio en cada importe**, aunque el documento ya declare
  una moneda en la cabecera.

La redundancia es deliberada. Una moneda implícita, heredada de un campo hermano o del
encabezado del documento, es exactamente la suposición que produce una factura emitida en la
moneda equivocada. Es más verboso y es el precio correcto.

Un cliente que haga `JSON.parse` y opere con `amount` como número está introduciendo un error
de redondeo. Los clientes deben pasar el objeto a `@ladino/money/format` para presentarlo y
enviarlo de vuelta sin tocarlo.

El string escalar de 8 decimales (`toAmountString()`) existe **solo** para persistencia y para
los tests de paridad con `numeric(24,8)`. No es una forma válida del contrato de la API.

**La única serialización de un importe es su `toJSON()`.** Nunca `{ ...money }` ni
`Object.entries`: el spread se salta la forma canónica y produce `"1.005"` en lugar de
`"1.00500000"` — un valor válido mal formado, indistinguible de uno correcto para el receptor.
En `packages/money` está cerrado por construcción (ADR-0023), pero la regla aplica a cualquier
DTO que envuelva un importe.

Un `ExactMoney` **no se serializa en absoluto**: es un intermedio de cálculo y hay que redondearlo
con una política nombrada antes de que pueda salir en una respuesta.

En un documento multimoneda, un importe convertido añade los campos de trazabilidad de
ADR-0020 junto al par: `fx_rate`, `rate_source`, `rate_timestamp`, más el par funcional.

## Procedencia: la API **debe** declarar el actor — contrato de S0.5

**Toda transacción que escriba tiene que fijar el actor antes del primer `INSERT` o `UPDATE`:**

```sql
set local ladino.actor_id = '<uuid del usuario autenticado>';
```

`set local`, no `set`: muere con la transacción y no contamina la siguiente conexión del pool.

### Por qué existe

`platform.set_row_provenance()` rellena `created_by` sin preguntarle al cliente — un autor que
el propio actor elige no es un autor (regla 3 de `CLAUDE.md`). Lo saca de:

```sql
coalesce(auth.uid(), nullif(current_setting('ladino.actor_id', true), '')::uuid)
```

`auth.uid()` funciona en el camino `authenticated`. **Pero `tenants`, `companies` y todo el
bloque RBAC solo se escriben con `service_role`** (ADR-0025 §9), y ahí `auth.uid()` es `NULL`.
Sin el GUC, esas altas no tienen autor.

### Qué pasa si se olvida

**Nada visible.** No hay error, la fila se escribe, la respuesta es `201`. `created_by` queda
`NULL` y el vacío aparece meses después, en una auditoría, sobre datos que ya no se pueden
reconstruir.

Es el peor modo de fallo posible para una pista de auditoría: silencioso, tardío e irreversible.
En S0.4 alcanza a `audit_events`.

> **Corrección (S0.4, ADR-0026).** Este párrafo decía antes *"`audit_events` y `fiscal_events`,
> que escribe el worker"*. Era incorrecto por partida doble. **La auditoría la escribe el caso de
> uso, dentro de su misma transacción**, no el worker: el outbox es *at-least-once*, y una fila
> de auditoría escrita por el consumidor queda **fuera** de la transacción del hecho que audita —
> auditoría que se puede perder. La regla 3 de `CLAUDE.md` quiere que el registro exista si y
> solo si el hecho ocurrió, y eso solo lo garantiza el commit compartido. Y `fiscal_events` no
> es de S0.4: llega en la Fase 11 (`IMPLEMENTATION_PLAN.md`).

### La API verifica la firma del JWT. No delega.

**Hueco de documentación, detectado al abrir S0.5 y anotado como tal:** hasta ahora **ningún
documento decía quién verifica el JWT**. ADR-0014 lo menciona solo para argumentar contra los
tokens de larga vida, y `SECURITY.md` habla de qué clave va en el cliente. La decisión faltaba.

**La API verifica la firma ella misma, antes de cualquier otra cosa.** La razón original era la
consecuencia de ADR-0025 §9: la API escribía con `service_role` (`BYPASSRLS`) y la RLS no la
protegía. **Desde ADR-0031 la API se conecta como `ladino_api`, sin `BYPASSRLS`, y la RLS por
tenant del actor sí la contiene** — pero la decisión no cambia: la API sigue verificando el token
ella misma, porque la RLS es la segunda capa, no la autorización, y porque el actor que la RLS usa
(el GUC) sale precisamente de ese token verificado. Si la API no verifica, el GUC es un `sub` que
cualquiera escribe.

No es un detalle de implementación. Es el único punto donde se decide que el actor es quien dice
ser, y de ese actor cuelgan `created_by`, la resolución de permisos y el alcance de la clave de
idempotencia.

### Dos modos de firma, y el que manda es el asimétrico (S0.6a)

| Modo | Dónde | Algoritmo | Qué necesita la API |
|---|---|---|---|
| `jwks` | **producción** (el proyecto remoto firma así, comprobado contra su JWKS público) | ES256 | solo la clave **pública**, vía `/auth/v1/.well-known/jwks.json` |
| `hs256` | solo el stack **local** de `supabase start` | HS256 | el secreto legacy compartido |

**Los secretos compartidos no escalan y no rotan bien**: cada servicio que verifica necesita el
secreto, y rotarlo es redeploy coordinado. Con JWKS la API no guarda nada que proteger, la
rotación de clave del proyecto se absorbe sola (jose refresca por `kid`), y la clase de ataque de
«confusión de algoritmo» desaparece porque no existe secreto HMAC contra el que reinterpretar.

**El modo es configuración, no detección.** Un token no elige cómo se le verifica: en modo `jwks`
un HS256 muere aunque su secreto coincidiera con algo. Y `LADINO_AUTH_MODE=hs256` **no arranca**
ni con `NODE_ENV=production` ni contra un emisor que no sea local (dos capas, `config.ts`): es un
error de despliegue y falla activamente.

**Un token que no PUDO verificarse no es un token inválido.** Si el JWKS no responde, la API
devuelve `503 AUTH_BACKEND_UNAVAILABLE` con `Retry-After`, no `401`: un 401 masivo hace que los
clientes borren la sesión por una incidencia de red nuestra.

### Controles de borde en `/v1/*` (S0.6a)

`bodyLimit (1 MB) → timeout (30 s, 504 GATEWAY_TIMEOUT) → auth → rate limit (300/min por
USUARIO, 429 RATE_LIMITED) → contexto → [idempotencia]`. El rate limit en la API es por usuario,
nunca por IP (NAT móvil); el límite por IP existe en Traefik, mucho más laxo. El plazo de 30 s
es lo que hace seguro que el reaper libere claves de idempotencia a los 15 min. Códigos en
`ERROR_CATALOG.md`.

### El centinela de sistema vale para unas tablas y no para otras — y es deliberado

Asimetría que **no es obvia y que alguien va a "corregir"**, así que va escrita:

| Columna | ¿Acepta el centinela `00000000-0000-4000-8000-000000000000`? | Por qué |
|---|---|---|
| `companies.created_by` | **NO** | Tiene **FK a `auth.users`**. El actor debe ser un usuario real |
| `idempotency_keys.actor_id` | **SÍ** | **Sin FK a propósito**: el centinela no es un usuario |

Las dos decisiones son correctas y por motivos distintos. `created_by` es **procedencia**: responde
«quién hizo esto», y atribuirlo a un UUID que no corresponde a nadie sería peor que dejarlo nulo.
`actor_id` es **semántica de la clave de idempotencia**: responde «en nombre de quién se reserva»,
y el trabajo de sistema sin usuario necesita un valor explícito — un `NULL` ahí significaría «no me
acordé», que es justo lo que ADR-0027 §3-bis prohíbe.

**Consecuencia práctica para el middleware:** un alta de company **no se puede ejecutar con el
actor de sistema**. Falla con `companies_created_by_fkey`, comprobado. Toda operación que cree una
company exige un usuario real detrás, y eso es correcto.

**Quien intente unificarlas** —poner FK en `actor_id` o quitarla de `created_by`— romperá una de
las dos: la FK en `actor_id` impediría el trabajo de sistema y bloquearía el borrado de usuarios;
quitarla de `created_by` permitiría atribuir filas a actores inexistentes.

### Precedencia: `auth.uid()` gana al GUC

El `coalesce` pone `auth.uid()` primero, y eso tiene dos consecuencias que conviene saber:

- **El GUC no sirve para suplantar.** Un cliente `authenticated` puede llamar a
  `set_config('ladino.actor_id', …)` —los GUC de usuario no son privilegiados en Postgres— y da
  igual: su `auth.uid()` manda. Verificado.
- **Los claims residuales mandan sobre el GUC.** Si la transacción todavía tiene
  `request.jwt.claims` de un usuario y se pasa a `service_role`, la fila se atribuye a **ese
  usuario**, no al del GUC. Verificado: con claims residuales sale `bbbb…`; sin ellos, el GUC.

Normalmente eso es correcto —los claims y el GUC son el mismo actor— pero el middleware no debe
dejar claims de un usuario colgando en una transacción que hace trabajo de servicio en nombre de
otro. Si las dos fuentes pueden discrepar, limpia los claims o haz que coincidan.

### Dónde se verifica

| Capa | Comprobación |
|---|---|
| Middleware de la API | fija el GUC a partir del JWT verificado, **antes** de abrir el caso de uso. Nunca desde el payload |
| Caso de uso transaccional | el paso 1 del patrón de la skill `caso-de-uso` es "validar permisos"; fijar el actor va con él, dentro de la **misma** transacción |
| Test de integración de S0.5 | un caso de uso ejecutado sin GUC **debe fallar el test**, comprobando `created_by is not null` en la fila resultante |
| pgTAP | `006` cubre las dos vías: con GUC fijado y sin él |

La comprobación de integración es la que importa: es la única que se ejecuta por el mismo camino
que producción. Un test que fije el GUC a mano prueba el trigger, no la API.

```json
{
  "error": {
    "code": "FISCAL_DOCUMENT_IMMUTABLE",
    "message": "El documento emitido no puede modificarse.",
    "details": {},
    "request_id": "..."
  }
}
```

`code` es estable y forma parte del contrato: los clientes ramifican sobre él, no sobre `message`.
`message` está en español y es apto para mostrar al usuario final.

## Idempotencia (ADR-0018)

Obligatoria en: emisión de factura, pagos, cobros, posting de asientos, reintentos fiscales
y posting de nómina.

- Misma clave, mismo cuerpo → devuelve la respuesta original, sin repetir el efecto.
- Misma clave, cuerpo distinto → `409 IDEMPOTENCY_BODY_MISMATCH` (ADR-0076; antes `IDEMPOTENCY_KEY_REUSED`).
- Misma clave en OTRO endpoint → `409 IDEMPOTENCY_KEY_REUSED` (ADR-0056).
- La clave es por INTENTO (ADR-0076): el cliente la estrena tras un 4xx (salvo
  `IDEMPOTENCY_IN_PROGRESS`) y la conserva tras un fallo de red o un 5xx. Nunca es el id de un
  recurso (la cuenta del POS fue el caso: M-01).
- ~~La clave se persiste **dentro** de la transacción del caso de uso.~~ Sigue siendo lo correcto
  cuando el trabajo es local, pero **se admite el protocolo de dos transacciones** para operaciones
  con un viaje externo — la emisión fiscal lo necesita. Ver la enmienda de ADR-0018.

### El alcance de la clave, y la parte que se olvida

**Alcance: `(tenant_id, company_id, actor_id, key)`.** `endpoint` **no** entra (ADR-0026 D5): si
entrara, un cliente que reusa la clave en otro endpoint obtendría dos efectos en vez de un 409.

⚠ **CONTRATO OBLIGATORIO DE S0.5, y el índice no lo puede imponer solo:**

1. **La API fija `actor_id` explícitamente al reservar la clave.** No lo deriva de `created_by`, que
   es procedencia best-effort y puede quedar NULL en silencio. La columna es `NOT NULL`: si se
   olvida, la reserva **falla activamente**, que es lo que se busca. Para trabajo de sistema sin
   usuario existe el centinela documentado en la columna.
2. **El lookup de replay DEBE filtrar por `actor_id`.** Esta es la que se olvida y la que importa:
   *el índice único nunca fue la fuga*. Si la consulta que busca la respuesta guardada hace
   `where tenant_id = ? and company_id = ? and key = ?` sin el actor, devuelve la fila de **otro
   usuario** y le entrega su respuesta — con un `200`, y sin ejecutar la operación que sí pidió.
   Arreglar el almacenamiento y no la lectura deja el agujero intacto con aspecto de cerrado.

Pendiente y no decidido: el TTL concreto (`expires_at` no tiene default a propósito) y la
**canonicalización de `request_hash`**, sin la cual dos cuerpos semánticamente iguales producen
409 espurios sobre peticiones correctas.

## Versionado

- Versión de API en el path (`/v1`).
- `fiscal_protocol_version` dentro del payload, no en el path: el tren fiscal es independiente.
- No se rompe un cliente móvil antiguo sin ventana de compatibilidad. Soporte N y N-1.
- Si un build deja de ser compatible con el protocolo fiscal, se fuerza actualización.
- La versión del contrato vive en `info.version` del `openapi.json`. **0.2.0 (2026-10-02, ADR-0072
  §3-§4):** `POST /v1/supplier-invoices` y `POST /v1/arrivals` practican solos la retención de IVA
  de una empresa especial (antes solo con `retention_concepts`, que sigue valiendo: N-1), aceptan
  `retention_exclusion` e `iva_retention_full_reason`, y devuelven `retention_voucher_id`,
  `retention_voucher_number`, `retention_exclusion_code`, `retention_exclusion_reason` e
  `iva_retention_full_reason`; nuevas rutas `/v1/retention-vouchers` (lista, detalle, PDF, entrega,
  corrección y modo). Un cliente 0.1.0 sigue funcionando: los campos nuevos son opcionales en la
  entrada y aditivos en la salida.
- **Retenciones de IVA que practicamos (ADR-0072 §3-§4, contrato 0.2.0):**
  - `GET /v1/retention-exclusions` — las exclusiones del art. 3 de la PA SNAT/2025/000054 que la
    persona puede MARCAR (`applies = marked`, vigentes hoy), con norma, numeral y si está verificado.
    Lectura: `ap.read`, `purchase.invoice.register` o `retention.receipt.issue`.
    Con `?account_id=` (la cuenta de la que sale un gasto con factura; AF4-01, 2026-10-04) no trae
    las exclusiones que esa cuenta no admite: el servicio público domiciliado (art. 3 num. 8) solo
    se ofrece para una cuenta bancaria. Cuenta ajena o inexistente: 404. Sin el parámetro, igual
    que antes.
  - `GET /v1/retention-vouchers?from&to&supplier_id` — comprobantes con estado (`issued` / `annulled`),
    vencimiento de entrega, entrega y total retenido. Misma lectura.
  - `GET /v1/retention-vouchers/{id}` y `GET /v1/retention-vouchers/{id}/pdf` — el comprobante con
    sus renglones, y su PDF (art. 16). Misma lectura.
  - `POST /v1/retention-vouchers/{id}/delivery` (`Idempotency-Key`, `retention.receipt.issue`) —
    anota la entrega una vez; 422 si la fecha es futura o la versión está reemplazada.
  - `POST /v1/retention-vouchers/{id}/corrections` (`Idempotency-Key`, `retention.receipt.issue`) —
    versión nueva con número nuevo que reemplaza a la vigente; 201.
  - `PUT /v1/retention-vouchers/settings` (`Idempotency-Key`, `company.settings.manage`) — un
    comprobante por operación o por quincena y proveedor.
  - `POST /v1/fiscal-books/export` con `txt_retenciones_iva` devuelve `warnings` cuando omite
    correcciones de lo ya declarado (P-65), y 422 —sin registrar la generación— si un documento
    lleva varias alícuotas (P-69).

## Endpoints principales

`/companies` `/customers` `/suppliers` `/products` `/inventory` `/sales-orders` `/invoices`
`/purchase-orders` `/supplier-invoices` `/payments` `/banks` `/accounting` `/tax` `/fiscal`
`/reports` `/audit`

### La reversa de un cobro y de una retención soportada (ADR-0075 §8, ola 3)

- **`POST /v1/payments/{id}/reversal`** — permiso `ar.payment.reverse` (dueño y contador). Cuerpo
  `{company_id, reason}` (motivo de 10 a 300 caracteres). 201 con la reversa, el estado del
  documento, la deuda que queda (`debt`, de la única función) y, si lo hubo, el IGTF pendiente de
  reintegro. Errores: 403 `PERMISSION_REQUIRED`; 422 sin motivo o si el abono es un comprobante de
  retención; 409 `PAYMENT_ALREADY_REVERSED`, `IGTF_NOTE_ISSUED`, `PERIOD_CLOSED` (el contra-asiento
  va con fecha de hoy: si el período de hoy está cerrado, la reversa se rechaza).
- **`POST /v1/supported-retentions/{id}/reversal`** — permiso `ar.retention.correct` (contador).
  Mismo cuerpo y misma respuesta (`kind = supported_retention`); el comprobante queda `annulled`.
  409 `RETENTION_PERIOD_DECLARED` si el comprobante ya entró en una declaración presentada.

**Lecturas (aditivo, ola 3).** Un cobro reversado no es un cobro:

- `GET /v1/documents`: `has_payments` cuenta solo cobros vivos.
- `GET /v1/documents/{id}`: cada elemento de `payments` trae `reversal` (`null` o
  `{id, reversed_at, reversed_by, reversed_by_name, reason}`); `exchange_differences` no incluye el
  diferencial de un cobro reversado; `balance` es `null` si el documento está en divisa y no hay
  tasa de hoy.
- `GET /v1/customers/{id}/statement` y `/aging`, `GET /v1/customers?with_debt=1`: `paid_amount`
  excluye lo reversado; `total_outstanding`, `debt.by_currency[].functional_today`, `aging.total`,
  el `amount` de cada tramo y `debt` de la lista pueden ser `null`: hay deuda en divisa y falta la
  tasa de hoy. El nominal por moneda (`debt.by_currency[].nominal`) se sirve siempre,
  salvo un cobro antiguo en otra moneda sin tasa con que valorarlo, que deja la deuda en nulo.
- `GET /v1/reports/exchange-difference`: no suma el diferencial de un cobro reversado.
- `GET /v1/reports/{sales|margin|iva|inventory|receivables|payables|cash-closings|igtf}` (ola 5,
  P-07, F-13, H-11): los reportes y las carteras. Una sola forma de respuesta (`ReportTable`:
  `columns`, `rows`, `totals`, `summary`, `notes`, `row_count`). Rango `from`/`to` en días de
  Caracas (las carteras son «a hoy» y no lo llevan); `group` y `sort` según el reporte;
  `format=csv|xlsx` responde el archivo y exige además `report.export`. Importes como texto
  redondeado al servir; `null` con motivo (`sin_tasa`, `sin_permiso`, `sin_dato`), nunca 0. Permisos
  y fuentes de cada uno: `docs/03_MODULES/REPORTING_ANALYTICS_SPEC.md`, «Lo construido». Los
  cierres de caja exigen `treasury.read`, el mismo de `GET /v1/cash-closings` (no
  `cash_register.read`). `from` y `to` tienen que ser fechas que existan: `2026-02-30` es 422.
  En ventas, `fiscal_total` es «Ventas con factura»: no cuenta facturas de retiro ni notas de
  débito por IGTF, que sí están en el libro de ventas.
- CORS expone `Content-Disposition` (el nombre del archivo descargado).
- `GET /v1/journal-entries/{id}`: `debit_amount` y `credit_amount` de cada línea van en moneda
  FUNCIONAL (iguales a `functional_debit` / `functional_credit`); el importe original va en
  `original_amount`, con `transaction_currency` y `fx_rate`.

**Ola 4 · el fiado tiene una sola puerta (R-82 punto 1; cambia el COMPORTAMIENTO, no la forma).** `POST /v1/invoices` emite una factura que nace sin cobro: es fiado, y pasa por la misma regla que `POST /v1/pos/sales`. Respuestas nuevas de ese endpoint: 403 `PERMISSION_REQUIRED` si quien emite no tiene `sales.credit`; 409 `CREDIT_LIMIT_EXCEEDED` si el cliente tiene límite 0 o la factura lo deja por encima de su límite; 409 `EXCHANGE_RATE_MISSING` si falta la tasa oficial de hoy (la deuda no se puede medir); 422 `VALIDATION_FAILED` al «Consumidor final». Ningún rechazo deja documento ni gasta número. El cuerpo y la respuesta 201 no cambian. `POST /v1/fiscal/contingency-invoices` y `POST /v1/debit-notes` no pasan por la regla.

**Última ronda (aditivo, ola 3).** `GET /v1/customers/{id}/statement`: `documents[].balance` y `documents[].debt_nominal` pueden ser `null` (no «0») cuando no se pueden calcular, y `debt.unvalued_documents` dice cuántos documentos quedan fuera de `debt.by_currency`. La respuesta de las dos reversas: `debt.nominal` y `debt.functional_today` pueden ser `null`. `GET /v1/igtf/perceptions`: `total_functional` incluye lo percibido cuyo cobro se reversó después del fin del período, y `pending_refund_functional` / `pending_refund_count` lo dicen aparte. **Corrección (20261003230000, sin cambio de forma):** «después del fin del período» es después del fin de la QUINCENA DE LA PERCEPCIÓN, no del `to` de la consulta; el total de un rango es la suma de sus percepciones y Σ quincenas = mes. `GET /v1/supplier-invoices`: `items[].balance` es `null` en una factura sin asentar (borrador o anulada).

**Ola 4 (aditivo): «no hay» no es «no puedes ver» (N-05, P-05).**
- `GET /v1/negocio/tasa` (nuevo): `{ tasa_del_dia }`, el mismo objeto del resumen (o `null` si nunca se cargó), para cualquier miembro de la empresa. No exige `treasury.read`: quien cierra su caja la necesita sin ver el dinero del negocio.
- `GET /v1/search/documents?q=` (nuevo, P-06, ADR-0081): `{ items: [{ type, id, number, party_name, date, status }] }`, la búsqueda de documentos por número de la paleta. `type` es `invoice | receipt | credit_note | debit_note | quote | withdrawal_invoice | withdrawal_credit_note | purchase`. Solo lectura, sin importes y sin total. Ventas: exige `ar.read`, `accounting.read` o un permiso de operación de ventas (`sales.invoice.issue`, `sales.invoice.annul`, `sales.quote.manage`, `sales.order.manage`, `sales.return.manage`, `sales.payment.register`): los mismos con que el menú abre «Ventas», más los de quien vende. Compras: `ap.read`, `purchase.invoice.register` o `purchase.payment.register`. El grupo que el rol no abre no se consulta: sin ningún permiso, `items` viene vacío (200, no 403). `q` con menos de 2 caracteres: 422.
- `GET /v1/negocio/resumen`: cada total de deuda en `null` dice su motivo en `lo_que_me_deben_motivo` / `lo_que_debo_motivo` (`"sin_permiso"` | `"sin_tasa"`; `null` cuando hay cifra) y, con `sin_tasa`, el nominal conocido en `…_por_moneda` (`[{ currency, nominal }]`; vacía en los demás casos). Sin tasa para una factura de proveedor en divisa el resumen ya no falla: `lo_que_debo` va en `null` con `sin_tasa`.
- `GET /v1/customers`: `sort` = `name` (por omisión) | `debt_desc` | `debt_asc`. Los dos de deuda exigen `with_debt=1` (y por tanto `ar.read`); el cliente cuya deuda no se pudo valorar (`debt: null`) va arriba en los dos sentidos. Un valor desconocido, o deuda sin `with_debt`, es 422 `VALIDATION_FAILED`: nunca cae en silencio al orden por nombre.

**Ola 4 (aditivo): el fiado tiene vencimiento (P-05, E-22; migración `20261004210000`).**
- `POST /v1/pos/sales`: `due_date` (`AAAA-MM-DD`, opcional en el esquema). **Si la venta deja saldo y no viene, 422 `VALIDATION_FAILED`** («Di cuándo paga el cliente…», `details.reason = "due_date_required"`) y no se emite nada. Anterior al día de la venta (día de Caracas): 422 (`due_date_before_sale`, con `details.sale_day`); un día que no existe: 422 (`due_date_invalid`). En una venta que queda pagada se guarda y no significa nada. La comprobación va DESPUÉS de la regla del fiado: a quien no se le puede fiar se le responde eso (403/409), no la falta de fecha.
- `POST /v1/invoices` (y el recibo de administración): `due_date` opcional. Sin ella el documento vence el día de su emisión. Misma validación de la fecha.
- `DocumentResponse.due_date` (`string | null`): el vencimiento acordado; inmutable tras emitir (LAD06 en la base).
- `POST /v1/pos/quote`: `credit_due_date` = `{ required, min } | null`. `null` en la venta de mostrador; con cliente, `required: true` (fiar por la caja exige la fecha) y `min` = hoy en Caracas. Va aparte de `credit`, cuya forma no cambia.
- `GET /v1/customers?with_debt=1`: cada cliente trae `overdue` (lo vencido de su deuda en la moneda de la empresa a la tasa de hoy; `"0.00"` = nada vencido) y `overdue_reason` (`"sin_tasa"` cuando `overdue` es `null`: hay vencido y no se puede valorar hoy; nunca 0). `sort` admite además `overdue_desc` | `overdue_asc` (exigen `with_debt=1` y `ar.read`, 403 `PERMISSION_REQUIRED` sin él): lo no valorado arriba; en `overdue_desc`, a igual vencido, por deuda total y después por nombre.
- `GET /v1/customers/{id}/aging` y `…/statement` (`aging`): `overdue` y `overdue_reason`, a la fecha de referencia. Los tramos NO cambian: siguen contando días desde la emisión. `statement.documents[]`: `due_date` (el acordado o, sin él, el día de emisión) y `overdue` (debe y su vencimiento es anterior a hoy).
- **Vencido** = la deuda de `platform.document_debt` (la única función de deuda) de los documentos con `coalesce(due_date, día de Caracas de la emisión) < hoy de Caracas`. Vencer hoy no es estar vencido.
- `GET /v1/documents/{id}/pdf`: la factura o el recibo con saldo imprime «A CRÉDITO», «Saldo pendiente: …» (el de la fecha en que se imprime) y «Vence: dd/mm/aaaa». En el recibo, siempre; en la factura, solo en la copia de cortesía (no en `destino=papel` ni `vista`).

### `POST /v1/payments`: `amount` es lo ENTREGADO, por omisión (2026-10-02, ADR-0072 parte 2)

`igtf_included` (booleano, opcional) decide qué significa `amount` cuando el cobro causa IGTF (un
sujeto pasivo especial que cobra en divisas o cripto sin mediación financiera, PA SNAT/2022/000013
art. 1):

- **Por omisión (ausente o `true`)**: `amount` es lo que el cliente ENTREGÓ, IGTF incluido. El
  servidor lo reparte como la caja —base + IGTF(base) = entregado— contra lo pendiente valorado el
  DÍA DEL COBRO (`paid_at`), y lo que no alcance queda pendiente en el documento. Nunca se registra
  dinero que no entró.
- **`false`**: `amount` es lo que ABONA al documento y el IGTF se percibe aparte. Solo para quien ya
  repartió lo entregado con el mismo cálculo (`/v1/pos/tender`): la caja.

Es un **cambio de comportamiento** del contrato: antes, por omisión, el IGTF se percibía ADEMÁS de
`amount`. Si el cobro no causa IGTF, el campo no cambia nada. Un especial que cobra en divisa con el
instrumento `otro` recibe 422: debe registrarlo con su instrumento verdadero. La respuesta trae
`igtf` (con `absorbed`) y, en un cobro posterior a la factura, `igtf_debit_note` (la Nota de Débito
por IGTF que lo documenta).

### `POST /v1/payments` y `POST /v1/supplier-payments`: 409 `SETTLEMENT_MISMATCH` (ADR-0075 §4, regla 4, ola 3)

El cobro o el pago que CIERRA el documento y dejaría un diferencial (o un redondeo, en la retención
soportada) fuera de la cota del redondeo se rechaza con 409 `SETTLEMENT_MISMATCH` y no se registra
nada. Mensajes (`ERROR_CATALOG.md`):

- `POST /v1/payments`: «Este cobro no cuadra con lo que el documento todavía debe. No se registró:
  revisa el documento.»
- `POST /v1/supplier-payments`: «Este pago no cuadra con lo que la factura todavía debe. No se
  registró: revisa la factura.»

### Productos y precios: el alta única y el historial con la tasa de su día (C-02 y C-11, ola 4)

- **`POST /v1/products/simple`** acepta, además de lo que ya recibía, tres campos OPCIONALES:
  `tax_category_code`, `reduced_rate_literal` y `tax_category_justification`. Pasan tal cual al
  alta completa, que los valida igual que `POST /v1/products`: clasificación activa y ofrecida en
  ventas, literal de la lista cerrada para la reducida y justificación para la adicional (422
  `VALIDATION_FAILED` con el motivo). Sin `tax_category_code`, el producto nace con la de la
  empresa. Permiso: `product.manage`, el mismo del alta.
- **`GET /v1/tax-categories`** dice en `offered_in_sales` lo que la pantalla puede ofrecer: la
  reducida sale en `false` mientras `tax_reduced_rate_literals` no tenga un literal (P-51).
- **`GET /v1/price-lists/{id}/prices`** añade por fila, sin quitar nada:
  - `historical_equivalent_amount` y `historical_equivalent_currency`: el equivalente a la tasa
    oficial vigente el día de Caracas en que empezó a regir el precio (`effective_from`);
  - `historical_rate`, `historical_rate_date`, `historical_rate_source`: esa tasa, su fecha y su
    fuente (`platform.rate_for`);
  - `historical_rate_status`: `available`; `missing` (ese día no había tasa guardada); `scheduled`
    (el precio aún no rige y su día no tiene tasa); `not_applicable` (la lista no es USD ni VES).
    En los tres últimos, la cifra y la tasa van en `null`: nunca se rellenan con la de hoy.
  - `equivalent_amount`, `equivalent_currency` y `rate` siguen siendo la referencia de HOY.

## Observabilidad

Cada request emite log estructurado con `request_id`, `tenant_id`, `company_id`, `user_id`,
`use_case`, `duration`, `result`. Trazas OTel. Nunca el payload fiscal completo en el log.

## Rate limiting

En rutas caras y autenticadas la clave de rate limit es el `user_id`, **no la IP**:
la IP se falsifica y además penaliza a oficinas completas tras un NAT.

## La empresa y el menú: dos campos de la ola 4 (2026-10-03, A-04 y A-05)

Contrato AMPLIADO; el detalle campo a campo está en `openapi.json`.

- **`PUT /v1/companies/tax-id`** acepta `legal_name` (opcional en el esquema). **Al poner el PRIMER
  RIF** —la empresa tiene el marcador `PEND-…`— el servidor lo EXIGE: sin él, `422 VALIDATION_FAILED`
  «Con tu RIF, dinos la razón social tal como aparece en él…». La razón social se guarda junto al
  RIF, en la misma transacción, y deja acta `company.profile_updated`. **Con RIF ya puesto**,
  enviar `legal_name` es `422`: la razón social se cambia por `PATCH /v1/companies/profile`, con
  motivo si hay documentos emitidos (ADR-0050, nivel 2).
- **`POST /v1/companies/tax-id/correct`** sobre una empresa sin RIF es `422` («…todavía no tiene
  RIF, así que no hay nada que corregir…»): la corrección no es el camino del primer RIF.
- **`GET /v1/me/permissions`** devuelve, además de `permissions`, **`roles`**: las claves de los roles
  de sistema con los que la persona actúa en la empresa de `X-Company-Id` (`owner`, `accountant`,
  `cashier`…). **No autoriza nada**: la autorización sigue siendo por permiso y por operación. Existe
  para la divulgación progresiva del menú (ADR-0048). Quien no pertenece a la empresa recibe el 404
  de siempre, sin `roles`.
- Web y API se despliegan en la misma ventana: la API nueva responde 422 al primer RIF de una web
  que no envíe `legal_name`, y la API vieja rechaza el campo (esquema `strict`). Ver R-76.

## La nota de crédito del proveedor (H-03, ADR-0083)

| Ruta | Permiso | Qué hace |
|---|---|---|
| `GET /v1/supplier-invoices/{id}/lines` | `purchase.credit_note.register` o `purchase.invoice.register`; `expense.register` solo si la factura es de un gasto (403 con su mensaje en una de mercancía) | Lo que la pantalla de la nota necesita de la factura: `transaction_currency`, `is_expense`, `fiscal_support`, `has_retention`, `lines[]` (`id`, `line_number`, `description`, `product_id`, `quantity`, `has_receipt`, `tracks_lots`, `returned_quantity`; sin precios ni costos) y `lots[]`: los lotes CON existencia de los productos por lotes cuya línea no viene de una recepción (`product_id`, `warehouse_id`, `lot_id`, `code`, `expires_at`, `expired`, `quantity`), vencidos incluidos. |
| `POST /v1/supplier-credit-notes` | `purchase.credit_note.register`; `expense.register` si la factura es de un gasto | Registra la nota. Cuerpo: `supplier_invoice_id`, `supplier_document_number`, `supplier_control_number?` (sin él, la nota fiscal queda `document_incomplete`, aunque traiga `supplier_document_ref`), `note_date` (ni futura ni anterior a su factura), `reason`, `currency` (la de la factura), `kind` (`devolucion` \| `rebaja`; obligatorio en mercancía, ausente en un gasto), `warehouse_id?` (solo vale para la línea sin recepción) y `lines[]`: `supplier_invoice_line_id` (o `product_id` si la factura lo trae una vez), `quantity`, `unit_price` sin IVA, `tax_amount?` (lo calcula el servidor; si se envía tiene que coincidir al céntimo) y `lot_id?` (devolución de un producto por lotes sin recepción). Respuesta: `id`, `total_amount`, `balance` (negativo = saldo a favor), `accounting_date`, `is_fiscal`, `document_incomplete`, `retention_untouched`, `left_credit_in_favor`. |
| `GET /v1/suppliers/{id}/statement` | `ap.read` | Además de lo que ya traía: `total_outstanding` suma SOLO saldos positivos (es la suma de los tramos de `aging`); `credit_in_favor[]` (`currency`, `nominal`: el saldo a favor por moneda de la factura, según el auxiliar; no está restado del total), `credit_in_favor_functional` (lo que las notas vigentes asentaron en saldos a favor) y `credit_notes[]` (`id`, `supplier_invoice_id`, `supplier_document_number`, `supplier_control_number`, `note_date`, `transaction_currency`, `total_amount`, `kind`, `is_fiscal`, `document_incomplete`). |

`POST /v1/supplier-payments` rechaza (422) el pago de una factura `posted` cuyo saldo es cero o negativo: la cerró una nota de crédito.

## Gastos que se repiten (H-07, ola 5)

| Ruta | Permiso | Qué hace |
|---|---|---|
| `GET /v1/recurring-expenses` | `expense.read` | Los recordatorios vivos. Respuesta: `today` (día de Caracas) e `items[]` con `id`, `category`, `description`, `account_id`, `supplier_id`, `suggested_amount` y `currency` (lo que salió la última vez: una sugerencia), `with_invoice`, `periodicity` (`weekly` · `semimonthly` · `monthly` · `yearly`), `next_due_on`, `following_due_on` (el período que le sigue), `is_due` y `days_overdue` (los decide el servidor: día contra día), `status`. |
| `POST /v1/recurring-expenses/{id}/skip` | `expense.register` · Idempotency-Key | Cuerpo `company_id`, `due_on`. El período queda atendido sin gasto. `409 CONFLICT` si `due_on` ya no es el que toca o el recordatorio está detenido. |
| `POST /v1/recurring-expenses/{id}/stop` | `expense.register` · Idempotency-Key | Cuerpo `company_id`. Deja de avisar; no se deshace. Repetirlo responde 200. |

`POST /v1/expenses` gana tres campos opcionales en el cuerpo y uno en la respuesta:

- `recurrence`: cada cuánto se paga. Solo con `is_recurring: true` (422 si no); sin él, `monthly`. Crea el recordatorio de la categoría si no hay uno vivo.
- `recurring_expense_id` y `recurring_due_on` (los dos o ninguno, 422): «registrar ahora». El gasto atiende ese período del recordatorio. 422 si la categoría del gasto no es la del recordatorio; 409 si el período ya no es el que toca; en ningún rechazo se registra el gasto.
- respuesta, `recurrence_kept` (`{ periodicity, next_due_on }`): presente SOLO cuando el gasto venía con `is_recurring` y su categoría ya tenía un recordatorio vivo. El gasto se registró; el recordatorio no cambió.

## La lista de precios de una venta en la caja (C-06, ola 5)

`POST /v1/pos/quote` y `POST /v1/pos/sales` aceptan `price_list_id` (ya existía). El orden lo resuelve el servidor: lista de la venta → lista asignada al cliente → lista de mostrador. Pedir una lista DISTINTA de la que tocaría:

1. sin `sales.price_list.override` → `403 PERMISSION_REQUIRED` (como siempre);
2. con el permiso y el ajuste «Vendo al mayor» (`company_settings.sells_wholesale`) apagado → `422 VALIDATION_FAILED` «Tu negocio no tiene activado vender al mayor. Actívalo en Configuración para cobrar con otra lista.»;
3. con el permiso y el ajuste encendido → se cotiza y se cobra por esa lista; el documento la guarda.

Pedir la misma que ya aplicaría no exige nada. El ajuste gobierna SOLO la caja: `POST /v1/invoices` y `POST /v1/quotes` (administración) siguen exigiendo solo el permiso, y la lista asignada al cliente aplica con el ajuste apagado. Un producto sin precio en la lista que aplica → `422` que nombra el producto y la lista.
