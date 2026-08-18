# ADR-0018 — Idempotencia obligatoria por clave de cliente

- **Estado:** Aceptado · **Fecha:** 2026-08-07 · **Impacto fiscal:** SÍ
- **Enmendado el 2026-08-15** — ver §Enmienda. La decisión de fondo se mantiene; se admite el
  protocolo de dos transacciones y se corrige el alcance de la clave.

## Contexto
Conectividad irregular, usuarios que tocan dos veces, reintentos automáticos de la app móvil.
Sin idempotencia, todo eso produce facturas duplicadas y pagos dobles.

## Decisión
Header `Idempotency-Key` obligatorio en: emisión de factura, pagos, cobros, posting de asientos,
reintentos fiscales y posting de nómina.

Tabla `idempotency_keys(key, company_id, endpoint, request_hash, response, status, created_at)`
con índice único. Se escribe **dentro** de la transacción del caso de uso. Una segunda llamada
con la misma clave devuelve la respuesta original; con la misma clave y distinto cuerpo devuelve
`409 IDEMPOTENCY_KEY_REUSED`.

En offline, `client_command_id` cumple ese papel.

## Consecuencias
- (+) Reintentar es seguro siempre. La app móvil puede reintentar sin preguntar.
- (−) Se retiene la respuesta un tiempo (política de retención a definir, mínimo 24 h).

## Enmienda 2026-08-15 — dos transacciones, y el actor en la clave

Al cerrar S0.4, el revisor fiscal encontró que **dos de los tres estados de `idempotency_keys` no
hacen nada bajo el contrato de una sola transacción**, y tenía razón. La comprobación es directa:

- Si la clave se escribe **dentro** de la transacción del caso de uso, `in_progress` **nunca es
  observable** por otra sesión. Una fila sin commit es invisible: la segunda llamada no la ve y
  espera, sino que **bloquea en el índice único**. El estado no trabaja.
- Y `failed` es **inalcanzable**: si la operación falla, la transacción revierte y la fila
  desaparece con ella. No queda nada que marcar.

### Se admite el protocolo de dos transacciones

**T1 reserva la clave y commitea** (`in_progress`) → se hace el trabajo, incluido cualquier viaje
externo → **T2 actualiza** a `completed` o `failed` con la respuesta.

El motivo no es elegancia: **la emisión fiscal lo necesita**. La llamada a la imprenta digital es
un viaje externo, y bajo una sola transacción un timeout de la imprenta retiene conexión y bloqueo
de fila durante todo el viaje, con los reintentos del cliente encolados detrás.
`FISCAL_DOCUMENTS_SPEC.md` ya define `issuing → issued | failed` precisamente por eso.

**La regla original sigue valiendo donde el trabajo es local:** un asiento, un pago interno, un
movimiento de inventario se resuelven en una transacción y no necesitan las dos fases. La
enmienda **habilita** el protocolo de dos fases, no lo impone.

### Lo que las dos fases traen consigo, y hay que construir

- **Un reaper.** Un proceso que muere entre T1 y T2 deja la clave clavada en `in_progress` y
  **bloquea el reintento legítimo hasta `expires_at`** — es decir, impide emitir el documento. Es
  un fallo de disponibilidad en el camino de emisión, no de duplicación, y hoy no hay nada que lo
  recoja. Va con el worker (S0.6), junto al equivalente del outbox (`outbox_in_flight_idx` existe
  para eso y su proceso tampoco).
- **Qué responde la API ante una clave `in_progress`** —esperar, `409`, `425`— es contrato de
  S0.5. El esquema solo tiene que hacer la distinción posible, y la hace.

### El alcance de la clave incluye el ACTOR

La tabla de la decisión original —`(key, company_id, …)`— dejaba fuera al usuario. Dos usuarios de
la misma company con la misma clave chocaban, y las dos ramas son malas: con el mismo cuerpo el
segundo recibe **la respuesta del primero** —datos de otro usuario— y su operación no se ejecuta,
con un 200; con cuerpo distinto, un 409 sobre una operación correcta.

El alcance vigente es **`(tenant_id, company_id, actor_id, key)`**, con `NULLS NOT DISTINCT`.
`tenant_id` lo exige la regla 5 de `CLAUDE.md` (ADR-0026 D4); `endpoint` sigue **fuera** a
propósito (ADR-0026 D5). Aplicado en la migración `20260817000254`, y `actor_id` clavado por
trigger en `20260817003238`.

> **Corrección.** Este párrafo decía `created_by` y citaba la migración `20260816010608`. Las dos
> cosas estaban mal y se corrigieron en la misma sesión: `created_by` es procedencia **best-effort**
> —queda NULL en silencio si la API olvida el GUC— y sostener una restricción de unicidad sobre
> ella producía dos reservas para el mismo cliente. `actor_id` es columna propia, `NOT NULL`,
> fijada por el middleware. La regla general está en ADR-0027 §3-bis.
>
> Que este texto quedara desfasado respecto del esquema es, otra vez, documentación y catálogo como
> dos fuentes. Lo detectó `spec-explorer` al abrir S0.5.

### Lo que sigue sin decidir

El **TTL concreto** («mínimo 24 h» no es una política) y la **canonicalización de `request_hash`**,
sin la cual dos cuerpos semánticamente iguales producen 409 espurios. Las dos son de S0.5.
