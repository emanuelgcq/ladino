# ADR-0031 — Roles de servicio dedicados, sin `BYPASSRLS`: la RLS también contiene a la API

- **Estado:** Aceptado
- **Fecha:** 2026-08-24
- **Impacto fiscal:** NO
- **Enmienda a:** ADR-0025 §9 («la RLS no protege a la API») — deja de ser cierto por diseño.

## Contexto

La auditoría de S0.6a (F-15) encontró que la API y el worker se conectan como `postgres.<ref>`, el
rol administrativo del proyecto: `BYPASSRLS`, DDL y lectura de todos los tenants. ADR-0025 §9 lo
había aceptado con una frase honesta: «la RLS protege de `anon` y `authenticated`; no protege de
`service_role`, que es exactamente lo que usa el servidor». La consecuencia, dicha entera: **las
seis migraciones de aislamiento de S0.3 son decorativas para el camino por el que pasa todo el
tráfico**, y la única defensa real es que el código filtre bien — el modelo que Ladino descartó
explícitamente (CLAUDE.md §2: ausencia de mecanismo no es prohibición; un mecanismo que no
contiene al que escribe, tampoco).

Hay además un momento: **antes del primer deploy**. Arreglarlo después significa rotar
credenciales sobre un sistema en marcha, con clientes conectados, que es peor que hacerlo con la
base vacía.

Lo que ya existe y lo hace barato: el GUC `ladino.actor_id`, que `withTransaction()` fija como
primera sentencia de cada transacción (ADR-0027 §3-bis), y `set_row_provenance()`, que ya lo
usa con `coalesce(auth.uid(), GUC)`. El puente entre «quién es el actor» y «quién ejecuta la
sentencia» está a medio construir desde S0.3.

## Opciones consideradas

1. **Seguir con `postgres`/`service_role` y confiar en el código.** A favor: cero trabajo. En
   contra: es el hallazgo. Un bug de filtrado —un `where tenant_id` olvidado— es una fuga total y
   silenciosa.
2. **Un solo rol `ladino_app` sin `BYPASSRLS`.** A favor: simple. En contra: el worker recibiría
   los privilegios de la API (companies, RBAC, auditoría) para hacer un trabajo que solo toca
   dos tablas. Mínimo privilegio es por servicio, no por «lo del servidor».
3. **Roles sin `BYPASSRLS` y suplantar el JWT** — que la API fije `request.jwt.claims` para que
   `auth.uid()` devuelva el actor y las policies existentes funcionen sin tocarlas. A favor: no
   se modifica ninguna función. En contra: la API fabricaría claims de JWT que nadie firmó; el
   día que algo más lea esos claims (`role`, `aal`, `session_id`) estaremos mintiéndole. Y el
   GUC propio ya existe: dos mecanismos para el mismo hecho.
4. **Una función de actor compartida, `coalesce(auth.uid(), GUC)`, dentro de las funciones de
   RLS existentes.** Fue el primer diseño implementado, y **seis suites de pgTAP lo tumbaron**:
   con el GUC presente en la transacción, una sesión `authenticated` SIN JWT ganaba visibilidad
   — y «sin JWT no se ve nada» es una propiedad que esos tests protegen desde S0.3. El orden del
   coalesce protegía el caso «JWT presente», no el caso «JWT ausente».
5. **Roles por servicio sin `BYPASSRLS` + funciones de actor SEPARADAS**: el camino
   `authenticated` conserva sus funciones intactas (`auth.uid()`); el camino de servicio tiene
   las suyas (`platform.ladino_service_actor_id()`, que lee SOLO el GUC, y
   `ladino_service_tenant_ids()`), usadas únicamente por las policies `TO ladino_api`;
   `ladino_worker` con GRANT solo sobre `outbox` e `idempotency_keys`. — **Elegida.**

## Decisión

### Dos roles, `NOBYPASSRLS NOSUPERUSER`, creados por migración y sin contraseña en ella

- **`ladino_api`** — lo que la API necesita y nada más: `SELECT`/`INSERT`/`UPDATE` sobre las
  tablas de la jerarquía y del RBAC, `INSERT` en `audit_events` y `outbox`, todo sobre
  `idempotency_keys`. Sin `TRUNCATE`, `REFERENCES`, `TRIGGER`, sin DDL.
- **`ladino_worker`** — `SELECT`/`UPDATE` en `outbox`, `SELECT`/`UPDATE`/`DELETE` en
  `idempotency_keys`. **Nada más por GRANT**: un worker comprometido no puede ni nombrar
  `companies`. Su aislamiento no es RLS, es privilegio de tabla.

La migración los crea `NOLOGIN` y **sin contraseña**: una contraseña en una migración es un
secreto en git. El `LOGIN` y la contraseña se dan fuera de banda — en local, `supabase/seed.sql`
(que solo corre en `db reset`); en el remoto, el operador (VALIDAR-SUPABASE, abajo).

### Dos caminos, dos juegos de funciones — el GUC no existe para `authenticated`

```sql
platform.ladino_service_actor_id()  := nullif(current_setting('ladino.actor_id', true), '')::uuid
platform.ladino_service_tenant_ids() := memberships activos de ese actor (SECURITY DEFINER)
```

Las funciones del camino `authenticated` (`ladino_tenant_ids()`, `ladino_company_ids()`,
`ladino_has_permission()`, `ladino_has_scope()`, `memberships_select`) **no se tocan**: siguen
resolviendo por `auth.uid()`. Las policies `TO ladino_api` usan las de servicio. La consecuencia
de seguridad es **estructural, no de orden de evaluación**: ninguna policy de `anon`/
`authenticated` lee el GUC, así que el GUC no puede dar acceso a ese camino — ni a un cliente
con JWT ni, lo que tumbó al primer diseño, a una sesión sin JWT. La 014 lo prueba en las dos
direcciones y su variante rota (una policy de `authenticated` usando la función de servicio)
demuestra exactamente qué se pierde al mezclarlos.

`set_row_provenance()` conserva su `coalesce(auth.uid(), GUC)` de S0.3: ahí **atribuye**, no
autoriza, y el camino de servicio necesita `created_by` correcto.

Las funciones de servicio son SQL de una expresión, `STABLE`: la de actor es inlinable y la de
tenants es un `InitPlan` por sentencia. No reintroducen el envoltorio que costó 28× en S0.4, y el
camino caliente de `authenticated` —que el gate 013 mide contra el esquema final— queda intacto.

### Policies `TO ladino_api` por **tenant** del actor, no por company

El predicado es `tenant_id in (select platform.ladino_tenant_ids())`: un `InitPlan`, una vez por
sentencia. La granularidad company y el permiso concreto siguen siendo del caso de uso (el JOIN de
autorización de la plantilla de S0.5). **La RLS del rol de servicio es la segunda capa**: si el
código olvida un filtro, la fuga posible es dentro del tenant del actor, nunca a otro tenant.
Eso es exactamente lo que «intentar leer datos de otro tenant y que falle» exige, y lo que las
seis migraciones de S0.3 prometían.

`idempotency_keys` va más estrecha —tenant **y** `actor_id = ladino_service_actor_id()`—, porque
ya lo era en el código (H-2 de S0.5) y una policy que lo escribe lo hace greppable.

Sin actor (GUC vacío y sin JWT) `ladino_api` **no ve nada y no puede insertar nada**: modo de
fallo ruidoso, probado.

## Consecuencias

- **Positivas.** La RLS deja de ser decorativa para el tráfico real. Un `where` olvidado en un
  caso de uso ya no es una fuga entre clientes. El worker no puede leer datos de negocio ni con
  la conexión en la mano. Los tests E2E de la API y del worker se ejecutan **como los roles
  dedicados**, así que un privilegio que falte falla en `verify`, no en producción.
- **Negativas.** Cada tabla nueva necesita, además de sus policies para `authenticated`, sus
  policies `TO ladino_api` — la skill `migracion-supabase` lo exige desde ahora. Las funciones de
  RLS tienen una capa más (`ladino_actor_id()`), aunque inlinable. `SELECT … FOR UPDATE` exige
  privilegio `UPDATE`, así que `ladino_api` tiene `UPDATE` sobre `tenants` aunque hoy no lo use
  para escribir; la policy lo acota al tenant del actor.
- **Deuda aceptada.** El operador de plataforma (ADR-0030) y el alta de tenants no tienen camino
  por `ladino_api` todavía: `tenants` no admite `INSERT` para él. Llegará con su caso de uso.
- **Para revertir:** conectar de nuevo como `postgres` funciona sin tocar nada (tiene
  `BYPASSRLS`). Que sea tan fácil es el riesgo: el `DATABASE_URL` de producción es contrato y
  el README lo dice.

## Verificación

- pgTAP 014 (35 aserciones): atributos del catálogo (`rolbypassrls = false`, `rolsuper = false`,
  ambos roles), y **ejercicio**, no bits: como `ladino_api` con actor A, `SELECT`/`UPDATE`/
  `INSERT` sobre datos de B → 0 filas, dato intacto, `42501`; con actor multi-tenant, ve A y B;
  sin actor, nada. Separación de caminos: `authenticated` con JWT A y GUC B ve A; sin JWT, el
  GUC no da acceso ninguno. Como `ladino_worker`: `outbox` de todos los tenants, `companies` →
  `42501`.
- **Variantes rotas** en el mismo test, cada una con su restauración: una policy `using (true)`
  para `ladino_api` hace visible a B (la aserción mide la RLS); un `GRANT SELECT` al worker hace
  legible `companies` (mide el privilegio); una policy de `authenticated` que use la función de
  servicio deja entrar por el GUC sin JWT (mide la separación de caminos — el fallo del primer
  diseño, conservado como negativo).
- Los tests de vitest de la API y del worker conectan como `ladino_api` / `ladino_worker`.
- **VALIDAR-SUPABASE:** que el pooler (Supavisor, puerto 6543) acepte los roles dedicados con su
  contraseña. Si no, conexión directa (5432) para la API y el worker.
- Revisión: cuando exista el primer caso de uso de alcance company (maestros), comprobar que la
  policy por tenant no ha absorbido en silencio la autorización por company del caso de uso.
