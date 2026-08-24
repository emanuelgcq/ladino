# ADR-0026 — Esquema de `audit_events`, `outbox` e `idempotency_keys`

- **Estado:** **Aceptado** (2026-08-15, al cerrar S0.4) · **Fecha:** 2026-08-09
- **Impacto fiscal:** SÍ — *toca comportamiento fiscal observable y hay que poder decir qué cambió,
  cuándo y bajo qué versión de reglas*, en el sentido que fija ADR-0027 §3.

  > **Corrección de la justificación.** La versión original decía «SÍ porque ADR-0005, ADR-0006 y
  > ADR-0018 están marcados SÍ y este ADR los concreta». Era **heredada y transitiva**, y el
  > revisor fiscal tenía razón en rechazarla: por esa regla cualquier migración que descienda de
  > un ADR marcado SÍ sería SÍ, y el marcador deja de discriminar. La justificación directa,
  > migración por migración: `audit_events` es el registro de eventos y la evidencia de
  > trazabilidad e inalterabilidad; `guard_company_tax_id` cambia el régimen de control sobre el
  > identificador del contribuyente que aparece en todo documento emitido; `idempotency_keys` es
  > el mecanismo tras «100 reintentos de una misma clave producen un solo documento»
  > (`FISCAL_DOCUMENTS_SPEC.md`); `outbox` lo es por arrastre real —entrega *at-least-once* de
  > efectos fiscales—, no por concretar ADR-0005.
- **Concreta:** ADR-0005 (outbox transaccional), ADR-0006 (append-only), ADR-0018 (idempotencia)
- **Se apoya en:** ADR-0025 (dos capas del aislamiento), ADR-0019 (expand/contract)

## Contexto

S0.4 construye las tres piezas de infraestructura sobre las que se apoyará todo caso de uso de
dominio: la pista de auditoría, la publicación transaccional de efectos y la deduplicación de
operaciones críticas.

Al preparar el DDL, `spec-explorer` encontró un desnivel grande entre las tres:

- **`idempotency_keys`** está especificada a nivel de columnas en ADR-0018.
- **`audit_events`** está especificada a medias, y con una ambigüedad que decide si lleva cadena
  hash o no.
- **`outbox` no tiene esquema en ninguna parte.** Tres columnas nombradas de pasada en
  `SPRINT_0_BOOTSTRAP.md` —`estado`, `intentos`, `available_at`— y **cero estados enumerados**,
  cuando `ENGINEERING_STANDARDS.md:64` exige `CHECK` sobre todo estado y `STATE_MACHINES.md` no
  incluye el outbox.

Además aparecieron **diez contradicciones** entre documentos, una de ellas contra la regla 3 de
`CLAUDE.md`. Este ADR las resuelve por escrito antes de que exista una línea de SQL, porque una
migración aplicada no se edita (ADR-0019).

---

## Decisión

### D1 · `audit_events` lleva `payload_hash`. No lleva cadena.

**La contradicción.** `AUDIT_TRAIL_AND_IMMUTABILITY.md` declara dos tablas (`fiscal_events` y
`audit_events`) y después pone **una sola** sección `Campos:`, sin decir a cuál aplica. Esa
sección incluye `previous_hash` y `event_hash`. Leída de una forma, `audit_events` lleva cadena
hash; leída de la otra, esos campos son de `fiscal_events` y `audit_events` no.

**La decisión: sin cadena.** Y la razón es **estructural, no de rendimiento**.

Una cadena hash exige que cada fila conozca el hash de la fila anterior. Eso presupone un **orden
total** sobre las inserciones. Y un orden total sobre inserciones concurrentes no es un problema
de índices ni de plan de consulta: es un **punto de serialización**. Para que la fila N+1 lea el
hash de la fila N, la fila N tiene que estar comprometida y nadie más puede estar escribiendo en
medio. Eso es un lock global sobre la tabla que más crece de toda la plataforma, atravesado por
cada caso de uso de cada tenant.

**Esto importa decirlo bien.** Si se documenta como *"es lento"*, alguien lo reintentará dentro de
un año con un índice mejor, un `BRIN`, o particionado — y descubrirá, después de escribir el
código, que ninguna de esas cosas ataca el problema. El cuello no está en el acceso al dato: está
en que la definición misma de la cadena obliga a que las escrituras ocurran **una detrás de otra**.
No es un cuello que se optimiza después. Es una propiedad de la estructura.

La documentación además lo permite explícitamente: *"PA121 exige resultado de
integridad/inalterabilidad, no prescribe ese algoritmo"* (`AUDIT_TRAIL_AND_IMMUTABILITY.md:35`).
La inalterabilidad la dan las dos capas de ADR-0006: sin policies de escritura, y `reject_mutation()`
en trigger, que alcanza a `service_role` donde los GRANT no llegan.

**Lo que sí entra: `payload_hash`.** Un hash sobre JSON sin forma canónica no sirve para nada —dos
serializaciones del mismo objeto dan hashes distintos— pero Postgres almacena `jsonb` con **claves
ordenadas y deduplicadas**: la forma canónica está garantizada por el tipo, sin implementar
RFC 8785 a mano ni depender de cómo serialice el cliente. Es columna **generada**, no calculada por
el llamante, para que responda el servidor.

> **Corrección (2026-08-15, auditoría de cierre).** La versión original decía que `payload_hash`
> «es verificable de verdad, no decorativo». **Es demasiado.** Una columna generada **se recalcula
> en cada `UPDATE` de la fila**, así que frente al único adversario que importa aquí —quien puede
> saltarse el trigger: superusuario, `DISABLE TRIGGER`, un restore adulterado— el hash *sigue* al
> payload manipulado y queda coherente. No hay copia independiente contra la que comparar.
>
> Lo que hoy da integridad a `audit_events` son **las dos capas de prevención** —sin privilegios
> de escritura y `reject_mutation()` en trigger—, **no la detección**. Redactarlo de otro modo
> ante un tercero sería afirmar una defensa que no existe. `FISCAL_DOCUMENTS_SPEC.md` admite la
> disyunción «bloqueada **o** detectada», y Ladino cumple por la rama «bloqueada».
>
> Y un segundo límite, medido: `platform.audit_payload_hash()` **colisiona** sobre `jsonb`
> arbitrario (un objeto y la cadena que deletrea su texto comparten huella) y devuelve `NULL` para
> el escalar `null`. La migración 5/5 lo cierra restringiendo `payload` a objetos: la colisión
> queda **inalcanzable por la tabla**, no imposible en la función. La función no se corrige porque
> cambiar su cuerpo **no recalcula** los hashes ya almacenados.
>
> `payload_hash` sigue valiendo por lo que este ADR necesita de él: ser la base sobre la que un
> verificador futuro construya la cadena diferida, sin tener que recalcular sobre payloads
> históricos con una canonicalización que ya no se podría reconstruir.

#### Diseño de la cadena, si SENIAT la exige

Queda escrito ahora para que quien la implemente no tenga que redescubrir por qué no está:

1. **Particionada por `company_id`**, nunca global. El orden total se exige dentro de un
   contribuyente, que es la unidad ante la que se responde. Cadenas independientes por company no
   se serializan entre sí, y el lock —si hace falta— queda acotado a un contribuyente.
2. **Calculada por un verificador asíncrono**, en una tabla aparte (`audit_chain`), que lee
   `audit_events` en orden de `(company_id, created_at, id)` y encadena. `platform.uuidv7()` es
   ordenable en el tiempo por construcción, así que el orden existe **sin necesidad de imponerlo
   en la escritura**.
3. **Nunca en el camino de escritura.** Este es el punto que no se negocia. Si la cadena vuelve
   al `INSERT`, vuelve el punto de serialización, y con él todo lo que este ADR decide evitar.
4. El verificador periódico de `AUDIT_TRAIL_AND_IMMUTABILITY.md:32` es el mismo proceso: encadena
   y comprueba a la vez. Un hueco en la cadena es una alerta P1 (`OBSERVABILITY.md:26`).

Esta es la razón exacta por la que `payload_hash` entra **hoy** aunque la cadena no: sin él, el
verificador futuro no tendría sobre qué encadenar y habría que recalcular hashes sobre payloads
históricos, con la canonicalización de entonces, que ya no se puede reconstruir.

### D2 · La auditoría la escribe el caso de uso, dentro de su transacción

**La contradicción.** `IMPLEMENTATION_PLAN.md:9` y `.claude/skills/caso-de-uso/SKILL.md:20`
sitúan la escritura de auditoría **dentro** de la transacción del caso de uso, como paso 8 de
diez. `API_SPEC.md:92` decía que la escribe **el worker**.

**La decisión: el caso de uso.** `API_SPEC.md` estaba equivocado y **queda corregido** en esta
misma entrega.

Auditoría escrita por el worker es **auditoría que se puede perder**. El outbox entrega
*at-least-once* (ADR-0005): puede entregar dos veces, y puede tardar. Una fila de auditoría
escrita por el consumidor vive **fuera** de la transacción del hecho que audita, de modo que
existen dos estados observables que no deberían existir: el hecho ocurrió y la auditoría todavía
no está, o el hecho se revirtió y la auditoría se escribió igual.

La regla 3 de `CLAUDE.md` pide lo contrario: que el registro exista **si y solo si** el hecho
ocurrió. Eso solo lo garantiza el commit compartido. Es exactamente el mismo argumento por el que
ADR-0005 pone el `INSERT` del outbox dentro de la transacción y no después.

Nota adicional: `fiscal_events` **no** es de S0.4. Llega en la Fase 11 (`IMPLEMENTATION_PLAN.md`).

### D3 · Superficie de escritura: `authenticated` no escribe ninguna de las tres

ADR-0025 §9 fijó tabla por tabla y operación por operación qué puede hacer `authenticated` en
S0.3. Para S0.4 no existía equivalente. Este es:

| Tabla | `authenticated` | Escritura real |
|---|---|---|
| `audit_events` | **solo `SELECT`**, acotado por `ladino_tenant_ids()` y por el permiso `fiscal.audit.read` | `service_role`, desde el caso de uso en `apps/api` |
| `outbox` | **nada** | `service_role` (encolado por el caso de uso, consumo por `apps/worker`) |
| `idempotency_keys` | **nada** | `service_role`, desde el middleware de idempotencia (S0.5) |

**Las prohibiciones se escriben, no se dejan implícitas.** Donde `authenticated` no puede hacer
algo, va una policy explícita `using (false)` / `with check (false)`, no la ausencia de policy.

Es la lección que estuvo a punto de costarnos caro en S0.3: recomendé borrar quince policies de
escritura del RBAC creyéndolas un agujero, cuando eran denegaciones explícitas. Borrarlas habría
sustituido una prohibición **escrita** por una prohibición **implícita** — que funciona igual hasta
el día en que alguien añade un `GRANT` amplio y nadie recuerda por qué la tabla estaba a salvo.
El principio general ya está en `CLAUDE.md` §2: *ausencia de mecanismo no es prohibición*. Aquí se
aplica en su forma más barata: una línea de SQL que dice que no.

Que `audit_events` permita `SELECT` a `authenticated` y las otras dos no, tiene motivo: la
auditoría es un producto para el usuario (`fiscal.audit.read` existe en
`MULTITENANCY_AND_RBAC.md:30`, y PA121 pide *"trazabilidad → timeline"*). El outbox y las claves
de idempotencia son fontanería: nadie fuera del servidor tiene por qué verlas.

### D4 · `idempotency_keys` lleva `tenant_id`

**La contradicción.** ADR-0018:13 define la tabla con `company_id` y **sin `tenant_id`**. Choca
con la regla 5 de `CLAUDE.md` —*"Todo registro pertenece explícitamente a un `tenant_id`. Sin
excepción"*— y con ADR-0025 §2, que lo exige en toda tabla tenant-owned con una única excepción
declarada (`permissions`, que es catálogo global).

**La decisión: lleva `tenant_id`.** ADR-0018 es anterior a ADR-0025 y no tuvo ocasión de
considerarlo.

Hay además una razón mecánica: `assert_isolation_anchors_immutable()` compara `tenant_id` entre
`OLD` y `NEW`. Sin la columna no hay ancla que comparar, y el test 006 —que lo comprueba como
**propiedad sobre el catálogo**, no tabla por tabla— haría fallar S0.4 solo. Es la clase de gate
que preferimos: no depende de que nadie se acuerde.

### D5 · Único por `(tenant_id, company_id, actor_id, key)`, sin `endpoint`

> **Enmienda 2026-08-17.** El alcance original de esta decisión era
> `(tenant_id, company_id, key)`: **sin actor**. La auditoría de cierre encontró que dos usuarios
> de la misma company con la misma clave se pisaban, y que la rama peor no es el 409 sino la del
> cuerpo idéntico — el segundo recibe **la respuesta del primero**, datos de otro usuario, y su
> operación no se ejecuta, con un `200`.
>
> El primer intento de arreglo metió `created_by` en el índice y **fue peor**: es una columna de
> procedencia best-effort que queda NULL en silencio si la API olvida el GUC, así que un reintento
> sin GUC creaba una segunda reserva. La regla general que salió de ahí está en ADR-0027 §3-bis.
>
> El alcance vigente usa **`actor_id`**: columna propia, `NOT NULL`, fijada por el middleware, no
> derivada de ningún trigger. Y el corolario que el índice no puede imponer: **el lookup de replay
> debe filtrar por actor** (`API_SPEC.md` §Idempotencia). El índice nunca fue la fuga.
>
> Lo que **no** cambia y sigue argumentado abajo: `endpoint` queda fuera.

**La contradicción.** `SPRINT_0_BOOTSTRAP.md:69` dice único por `(company_id, key)`. ADR-0018:13
añade una columna `endpoint` a la tabla y dice solo *"con índice único"*, sin nombrar columnas.
Las dos lecturas producen **comportamientos observables distintos en el contrato de la API**.

**La decisión: `endpoint` no entra en el único.**

Si entrara, un cliente que reusa por error la misma clave en dos endpoints distintos obtendría
**dos efectos** —dos facturas, dos pagos— y ninguno de los dos parecería un error. Fuera del
único, obtiene un `409 IDEMPOTENCY_KEY_REUSED`, que es ruidoso, corregible y no genera un
documento fiscal de más. Entre un fallo ruidoso y un efecto duplicado silencioso, en una
plataforma fiscal se elige el ruidoso.

`endpoint` se guarda igual, como columna, para que el 409 pueda decir **qué endpoint reclamó la
clave primero**. Un 409 sin esa información obliga a leer logs para diagnosticar un error de
cliente trivial.

**Detalle técnico que no es evidente:** `company_id` es nullable, porque hay operaciones de nivel
tenant. Un `UNIQUE` ordinario **no deduplica filas con NULL** —en SQL, `NULL` no es igual a `NULL`—
y el índice dejaría pasar tantas claves repetidas como se quiera, sin error, mientras
`company_id` sea `NULL`. Es otra vez ausencia de fallo leída como éxito. Se resuelve con
`UNIQUE NULLS NOT DISTINCT` (PostgreSQL 15+; el stack local va por encima). El test lo comprueba
sobre el caso `NULL`, no solo sobre el caso fácil.

### D6 · Los estados, que ninguna doc enumera

`ENGINEERING_STANDARDS.md:64` exige `CHECK` sobre todo estado enumerado —*"los estados viven en el
esquema, no solo en TypeScript"*— y no hay nada que enumerar: ni `STATE_MACHINES.md`, ni ADR-0005,
ni `SPRINT_0_BOOTSTRAP.md` los definen. Se deciden aquí.

**`outbox.status`:**

| Estado | Significado | Transiciones |
|---|---|---|
| `pending` | encolado, esperando turno | → `in_flight` |
| `in_flight` | tomado por un worker | → `published`, → `pending` (reintento), → `dead` |
| `published` | entregado al menos una vez | terminal |
| `dead` | agotó los intentos; requiere intervención | → `pending` (reproceso manual) |

`dead` es **un estado, no una tabla aparte**. Una DLQ separada obliga a duplicar el esquema y a
mover filas entre tablas para reprocesar; un estado permite reprocesar con un `UPDATE`. `outbox`
no está en la lista append-only de ADR-0006, así que puede hacerlo.

**`idempotency_keys.status`:**

| Estado | Significado |
|---|---|
| `in_progress` | la primera llamada sigue en vuelo |
| `completed` | hay respuesta guardada; un replay la devuelve |
| `failed` | la operación falló; la clave se puede reintentar |

`in_progress` responde a un hueco que la documentación deja abierto y que en producción ocurre a
diario: **qué pasa si llega la misma clave mientras la primera sigue ejecutándose**. Sin ese
estado, la segunda llamada no encuentra respuesta guardada, concluye que es nueva, y produce el
efecto duplicado que toda la tabla existe para impedir. Con él, la fila ya está y la segunda
llamada puede esperar o rechazar. (Qué hace exactamente la API —esperar, `409`, `425`— es contrato
de S0.5; el esquema solo tiene que hacer la distinción **posible**.)

### D7 · Solo `audit_events` es append-only

ADR-0006 lista las tablas append-only y **no incluye** `outbox` ni `idempotency_keys`.

Es coherente: las dos necesitan `UPDATE` por diseño —marcar estado, incrementar intentos, guardar
la respuesta— y prohibírselo las dejaría inservibles. Sería el modo de fallo que registramos en
ADR-0023 a propósito de otra cosa: *una defensa que cierra el único camino autorizado no es una
defensa, es una avería silenciosa*.

Los dos enganches de `reject_mutation()` van **solo en `audit_events`**.

### D8 · Un solo autor, un solo timestamp de servidor

**La contradicción.** `AUDIT_TRAIL_AND_IMMUTABILITY.md` pide `actor_type`/`actor_id`,
`occurred_at` y `server_received_at`. `platform.set_row_provenance()` impone `created_by` y
`created_at`. La tabla acabaría con **dos autores y dos timestamps de servidor**, y ninguna fuente
los reconcilia. Dos columnas para el mismo dato es una invitación a que diverjan.

**La decisión:**

- `created_by` y `created_at`, del trigger, son la autoridad. `actor_id` y `server_received_at`
  **no existen**: son esos mismos, con otro nombre.
- `actor_type` **sí se conserva**: distingue usuario de sistema, y eso no se deduce de
  `created_by` (que puede ser `NULL` en trabajo de servicio, justo el caso que el GUC
  `ladino.actor_id` de `API_SPEC.md` viene a cubrir).
- `occurred_at` **se conserva**, y solo porque el modo offline lo hace real: el hecho ocurrió en
  el dispositivo antes de llegar al servidor (`OFFLINE_AND_SYNC_SPEC.md`). Es dato del cliente y
  se trata como tal.
- `occurred_at <= created_at` va como `CHECK`. Un cliente no puede declarar que algo ocurrió en el
  futuro. Esto funciona gracias a un hallazgo de S0.3: **los triggers `BEFORE ROW` disparan antes
  que las `CHECK` constraints**, así que cuando el `CHECK` se evalúa, `created_at` ya tiene el
  valor del servidor. Sin ese orden, la comprobación sería contra `NULL` y pasaría siempre.

### D9 · La versión de reglas es columna propia

**La contradicción.** La regla 3 de `CLAUDE.md` exige *"autor, timestamp, origen y **versión de
reglas**"*. La skill `caso-de-uso` lo repite en su firma —`writeAuditEvent(tx, ctx, 'invoice.issued',
invoice.id, rules.version)`— y `.claude/agents/accounting-invariants.md:28` también. Pero
**ninguna de las quince columnas** de `AUDIT_TRAIL_AND_IMMUTABILITY.md:11-25` es la versión de
reglas.

**La decisión: columna `rules_version`, no un campo dentro de `payload_json`.**

Enterrada en el JSON no es consultable con un índice, no es exigible con un `NOT NULL`, y no
sobrevive a un cambio de forma del payload. Y es precisamente el dato que hay que poder responder
en una fiscalización: *"con qué reglas se calculó este documento"*. Un dato que la norma obliga a
tener no puede depender de que quien escribió el caso de uso se acordara de meterlo en un objeto
libre.

### D10 · Qué se audita se difiere, con dueño y disparador

Cuatro documentos exigen auditar las "acciones críticas" y **ninguno define "crítica"**. Tampoco
está decidido si se auditan **lecturas**, que `PRIVACY_AND_DATA_GOVERNANCE.md:15` exige para RRHH
y fiscal.

**La decisión: S0.4 entrega el mecanismo, no la política.** Una lista de eventos escrita antes de
que exista un solo caso de uso sería adivinación, y quedaría desactualizada en la primera semana
de la Fase 1.

Pero **un diferimiento sin dueño es un olvido con buena redacción**. Queda registrado como
**R-04 en `RISK_REGISTER.md`**, con dueño (quien escriba el primer caso de uso de `packages/domain`),
disparador (el primer `EVENT_CATALOG.md` con eventos reales, o la primera llamada a
`writeAuditEvent`) y momento en que deja de ser aceptable (el segundo caso de uso: con uno se
puede argumentar que el catálogo se deduce; con dos ya hay divergencia). Ahí vive hasta que se
cierre, no en el handoff de una sesión.

Mientras tanto, `event_type` lleva un `CHECK` de forma (`^[a-z_]+\.[a-z_]+$`). No dice qué eventos
son válidos —eso es la política que se difiere— pero impide que el campo degenere en texto libre
antes de que exista el catálogo. Restringir después a un conjunto cerrado es fácil; recuperar seis
meses de `event_type` inventados sobre la marcha, no.

---

## Esquema resultante

Escrito en prosa a propósito: el SQL exacto vive en las migraciones, y este ADR no debe
convertirse en una segunda fuente de verdad que se desincronice.

**`audit_events`** — `id` (`uuidv7`), `tenant_id`, `company_id` (nullable: crear una company es un
evento de nivel tenant), `aggregate_type`, `aggregate_id`, `event_type` (con `CHECK` de forma),
`actor_type`, `occurred_at`, `rules_version`, `payload` (`jsonb`), `payload_hash` (por trigger),
`ip`, `device_id`, `session_id`, `app_build`, más `created_by`/`created_at`/`version` de
`set_row_provenance()`.

**`outbox`** — `id` (`uuidv7`), `tenant_id`, `company_id` (nullable), `aggregate_type`,
`aggregate_id`, `event_type`, `schema_version` (exigida por `EVENT_CATALOG.md:30`), `payload`
(`jsonb`), `status` (con `CHECK`), `attempts`, `available_at`, `last_error`, `published_at`,
más provenance.

**`idempotency_keys`** — `id` (`uuidv7`), `tenant_id`, `company_id` (nullable), `key`, `endpoint`,
`request_hash`, `response` (`jsonb`, nullable), `status` (con `CHECK`), `expires_at`, más
provenance, más **`actor_id`** (`NOT NULL`, fijado por el middleware, clavado por trigger). Único
`NULLS NOT DISTINCT` sobre **`(tenant_id, company_id, actor_id, key)`** — ver la enmienda de D5.
Este párrafo decía `(tenant_id, company_id, key)`: la enmienda de D5 no había bajado hasta aquí.

### Los tres bloqueantes heredados de S0.3

1. **`set_row_provenance()` en las tres.** En `audit_events` la columna `version` queda muerta
   —nunca hay `UPDATE`— y se deja igual: cuatro bytes cuestan menos que una excepción en un
   trigger compartido, y el bloqueante dice *toda* tabla. Un trigger con casos especiales es un
   trigger que alguien aplicará mal.
2. **`reject_mutation()` enganchado dos veces, solo en `audit_events`:** `before update or delete
   for each row` **y** `before truncate for each statement`. `TRUNCATE` ignora la RLS, no dispara
   el trigger de fila, y Supabase lo concede a `anon`/`authenticated` en toda tabla nueva.
3. **`assert_isolation_anchors_immutable()` en las tres.** Se hereda solo: el test 006 lo
   comprueba como propiedad sobre el catálogo.

---

## Consecuencias

**Buenas.**

- La escritura de auditoría no tiene punto de serialización. Cada caso de uso escribe su fila sin
  coordinarse con nadie.
- `payload_hash` es verificable hoy y sirve de base a la cadena si algún día se exige, sin tener
  que recalcular sobre payloads históricos.
- Los estados están en el esquema. Un worker con un bug no puede dejar una fila en un estado que
  no existe.
- El único `NULLS NOT DISTINCT` cierra el agujero de idempotencia en operaciones de nivel tenant,
  que un `UNIQUE` ordinario dejaba pasar en silencio.

**Malas, y asumidas.**

- **`version` es una columna muerta en `audit_events`.** Coste: cuatro bytes por fila en la tabla
  que más crece. Se acepta por uniformidad del trigger.
- **No hay cadena hash.** Si SENIAT la exige, hay trabajo: el verificador de la sección D1. El
  diseño está escrito, pero no implementado.
- **No hay política de retención.** `OPEN_QUESTIONS.md:16` es `VALIDAR-SENIAT` (conservación legal
  por tipo de documento más allá del acceso digital de diez años de PA102) y no se inventa un
  plazo. Consecuencia operativa concreta: `audit_events` y `outbox` crecen de forma monótona y sin
  purga. Hay que mirarlo antes de producción, no después.
- **La policy de `SELECT` depende de que `fiscal.audit.read` tenga fila en `permissions`.** La
  tiene desde S0.3, pero la dependencia es silenciosa: si una migración futura lo retirase, la
  lectura de auditoría se cerraría a todo el mundo sin un solo error. La migración 7 comprueba
  su existencia y falla si no está.

> **Corrección (misma sesión).** Una versión anterior de este ADR afirmaba que `fiscal.audit.read`
> **no existía** en la base y que la migración 7 debía crearlo. Era falso: está en la migración
> 3/4 de S0.3, línea 813. El dato venía del informe de `spec-explorer` y se repitió sin
> contrastarlo contra el catálogo. **El informe de un subagente es documentación, no catálogo** —
> exactamente la distinción que el propio hallazgo pretendía señalar. La migración `INSERT`
> habría fallado por clave duplicada, y falló. Lo que queda es la defensa, que sigue valiendo:
> comprobar la existencia en vez de suponerla.

**Lo que este ADR no decide.**

- El contrato HTTP de idempotencia (código de estado del replay, header que lo señale, TTL,
  canonicalización de `request_hash`). Es S0.5.
- El mecanismo de toma de trabajo del worker. El esquema lo **habilita** —índice parcial pensado
  para `FOR UPDATE SKIP LOCKED`— pero quién y cómo consume es S0.6.
- La lista de eventos auditables: R-04.

## Alternativas descartadas

**Cadena hash en el `INSERT`.** Descartada por D1: convierte cada escritura de la plataforma en un
punto de serialización. No es una cuestión de coste que se optimice después.

**DLQ como tabla aparte.** Descartada: duplica el esquema y obliga a mover filas para reprocesar.
Un estado `dead` hace lo mismo con un `UPDATE`.

**`endpoint` dentro del índice único.** Descartada por D5: convierte un error de cliente en un
efecto duplicado silencioso.

**Auditoría escrita por trigger de base de datos.** No la propone ningún documento, y la
descartamos también: un trigger ve la fila, no la **intención**. Sabe que `invoices` cambió; no
sabe si fue una emisión, una anulación o una corrección, ni con qué versión de reglas se calculó.
`event_type` y `rules_version` solo los conoce el caso de uso.

> **Excepción, y una sola (S0.4, migración 4/4 — M4).** El cambio de `companies.tax_id` **sí** se
> audita desde un trigger. Las dos condiciones que la justifican, y que hay que exigir a cualquier
> excepción futura:
>
> 1. **La intención está determinada por el dato.** `tax_id` pasó de X a Y: no hay otra lectura
>    posible del hecho, así que el argumento de arriba —el trigger no conoce la intención— no
>    aplica. Cuando no se cumpla esta condición, la excepción no vale.
> 2. **La red existe precisamente porque la capa de aplicación no lo registraba.** M4 es un
>    defecto heredado de S0.3: el RIF se reescribía sin rastro. Una red que depende de que el caso
>    de uso se acuerde es la que ya falló una vez.
>
> No sustituye a la auditoría del caso de uso: la **complementa**, con la misma lógica de dos
> capas que se usa en privilegios y policies. El caso de uso escribirá su evento, más rico; el
> trigger garantiza que el rastro existe aunque no lo haga. Y cuando el caso de uso declara
> `ladino.rules_version`, la fila del trigger la respeta; cuando no, queda marcada `db-guard`,
> de modo que las dos procedencias son **distinguibles** en la propia tabla.

**`audit_events` sin `tenant_id`, como log global consultable por un auditor externo.** Descartada:
choca con la regla 5, y el acceso del auditor SENIAT externo está bloqueado por `OPEN_QUESTIONS.md:6`
(`VALIDAR-SENIAT`: mecanismo de clave de consulta y acceso a API). Un modelo de acceso construido
sobre una suposición sería peor que no tenerlo.

## Verificación

| Qué | Dónde |
|---|---|
| `UPDATE` y `DELETE` sobre `audit_events` como `service_role` → LAD06 | pgTAP 008 |
| `TRUNCATE` sobre `audit_events` → LAD06 | pgTAP 008 |
| Aislamiento A/B con **usuario multi-tenant** (obligatorio desde S0.3) | pgTAP 008, 009, 010 |
| `occurred_at` en el futuro rechazado por `CHECK` | pgTAP 008 |
| `payload_hash` reproducible desde `payload` | pgTAP 008 |
| Transiciones de estado del outbox; `authenticated` no ve ni escribe nada | pgTAP 009 |
| Toma de trabajo concurrente sin doble entrega — **`pgbench`, fuera de pgTAP** | migración 8 |
| Misma clave + `company_id` `NULL` deduplica (`NULLS NOT DISTINCT`) | pgTAP 010 |
| `in_progress` impide el segundo efecto | pgTAP 010 |
| Cero tablas de `public` sin RLS habilitada **y forzada**; anclas en toda tabla con `tenant_id` | pgTAP 006, como propiedad del catálogo |
| Cambio de `tax_id` deja rastro de auditoría (M4) | pgTAP 011 |

**Al cerrar S0.4:** `rls-security-auditor` **y** `fiscal-reviewer`, por el impacto de homologación.
