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
- `GET /v1/journal-entries/{id}`: `debit_amount` y `credit_amount` de cada línea van en moneda
  FUNCIONAL (iguales a `functional_debit` / `functional_credit`); el importe original va en
  `original_amount`, con `transaction_currency` y `fx_rate`.

**Última ronda (aditivo, ola 3).** `GET /v1/customers/{id}/statement`: `documents[].balance` y `documents[].debt_nominal` pueden ser `null` (no «0») cuando no se pueden calcular, y `debt.unvalued_documents` dice cuántos documentos quedan fuera de `debt.by_currency`. La respuesta de las dos reversas: `debt.nominal` y `debt.functional_today` pueden ser `null`. `GET /v1/igtf/perceptions`: `total_functional` incluye lo percibido cuyo cobro se reversó después del fin del período, y `pending_refund_functional` / `pending_refund_count` lo dicen aparte. **Corrección (20261003230000, sin cambio de forma):** «después del fin del período» es después del fin de la QUINCENA DE LA PERCEPCIÓN, no del `to` de la consulta; el total de un rango es la suma de sus percepciones y Σ quincenas = mes. `GET /v1/supplier-invoices`: `items[].balance` es `null` en una factura sin asentar (borrador o anulada).

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

## Observabilidad

Cada request emite log estructurado con `request_id`, `tenant_id`, `company_id`, `user_id`,
`use_case`, `duration`, `result`. Trazas OTel. Nunca el payload fiscal completo en el log.

## Rate limiting

En rutas caras y autenticadas la clave de rate limit es el `user_id`, **no la IP**:
la IP se falsifica y además penaliza a oficinas completas tras un NAT.
