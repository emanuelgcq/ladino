-- =============================================================================
-- Ladino — 6/6 de S0.4 · Correcciones de la auditoría de la migración anterior
--
-- Módulo:         RBAC, auditoría, idempotencia (S0.4)
-- Spec:           ADR-0025 §5, ADR-0026, ADR-0018 (enmendado), ADR-0027
-- Reversibilidad: SÍ. Funciones, un índice, una columna y un trigger.
--                 `idempotency_keys.actor_id` es la única que toca datos, y la
--                 tabla está vacía en todos los entornos: no hay producción.
-- HOMOLOGATION_IMPACT: YES
--
-- La migración anterior arregló seis defectos e introdujo dos. Esta corrige los
-- dos, y la lección de proceso es la que va escrita arriba del todo: una
-- migración escrita para arreglar otra necesita su propia auditoría, porque el
-- foco puesto en el defecto conocido es exactamente lo que deja pasar el nuevo.
-- =============================================================================


-- =============================================================================
-- 1. ALTO — la delegación costaba 28×
--
-- HALLAZGO TÉCNICO, y merece leerse entero porque no es evidente y se va a
-- volver a tropezar:
--
--   **Una función SQL cuyo cuerpo es UNA SOLA LLAMADA a otra función SQL no
--   inlinable replanifica el cuerpo de la interna EN CADA INVOCACIÓN.**
--
-- El envoltorio SQL no puede inlinar a la interna porque es `security definer`
-- —eso no cambió respecto de S0.3—. Lo que cambió es DÓNDE vive el caché de
-- plan: al llamarse desde el cuerpo de otra función SQL, el `FmgrInfo` de la
-- interna se construye en el `ExprContext` por invocación, así que el join de
-- cinco tablas se replanifica POR FILA. Antes, la función la invocaba
-- directamente la policy y su plan vivía en el plan cacheado de la sentencia.
--
-- En `plpgsql` no pasa: el plan de una expresión simple vive en el
-- `simple_eval_estate` de la función y sobrevive entre invocaciones.
--
-- MEDIDO sobre la ruta real de RLS (audit_events_select, que invoca la función
-- por fila), 5.000 filas, misma sesión, mismo dataset:
--
--     S0.3 monolítica ................  394 ms
--     envoltorio SQL delegando ....... 10.380 ms      ← lo que introdujo la 5/5
--     envoltorio plpgsql .............  372 ms       ← esto
--
-- Esta función la usan más de CUARENTA policies. La migración de RBAC de S0.3
-- justifica sus índices citando el objetivo p95 < 500 ms de ADR-0014, y la
-- regresión lo revienta entre 15× y 28× según la ruta.
--
-- Ningún test lo detectó porque NINGUNO MEDÍA COSTE. El gate lo añade el test
-- 013, con su propia variante rota para comprobar que detecta.
--
-- Se conserva la propiedad que buscaba la 5/5: UNA sola implementación de la
-- resolución RBAC. Solo cambia el lenguaje del envoltorio.
-- =============================================================================

create or replace function platform.ladino_has_permission(
  p_permission text,
  p_company_id uuid
)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return platform.ladino_user_has_permission(auth.uid(), p_permission, p_company_id);
end;
$$;

comment on function platform.ladino_has_permission(text, uuid) is
  'Permiso del usuario del JWT sobre una company. Delega en '
  'ladino_user_has_permission(auth.uid(), …) para tener UNA sola implementación '
  'de la resolución RBAC. EN plpgsql Y NO EN SQL a propósito: un envoltorio SQL '
  'sobre una función SQL no inlinable replanifica el cuerpo de la interna por '
  'fila (28× medido en la ruta de RLS). plpgsql cachea el plan en su '
  'simple_eval_estate. Gate de coste en el test 013.';

revoke execute on function platform.ladino_has_permission(text, uuid) from public;
grant  execute on function platform.ladino_has_permission(text, uuid) to authenticated;


-- =============================================================================
-- 2. MEDIO — la función parametrizada era un oráculo RBAC
--
-- `ladino_user_has_permission(p_user, …)` acepta un usuario ARBITRARIO y es
-- `security definer`, así que ignora la RLS. Concedida a `authenticated`, deja
-- preguntar por los permisos de cualquier usuario en cualquier company de
-- cualquier tenant: un oráculo de existencia y de configuración RBAC ajena.
--
-- Hoy no es alcanzable —`platform` no está entre los esquemas expuestos de
-- `config.toml`— pero eso es UNA LÍNEA DE CONFIGURACIÓN, no una defensa. Y el
-- GRANT era innecesario desde el principio: los dos únicos llamantes
-- (`ladino_has_permission` y `audit_tax_id_change`) son `security definer` y la
-- invocan como el owner.
-- =============================================================================

revoke execute on function platform.ladino_user_has_permission(uuid, text, uuid)
  from authenticated;

comment on function platform.ladino_user_has_permission(uuid, text, uuid) is
  'Resolución RBAC parametrizada por usuario. Implementación ÚNICA. NO se '
  'concede a authenticated: acepta un p_user arbitrario y es security definer, '
  'así que sería un oráculo de permisos ajenos. Sus llamantes son security '
  'definer y la ejecutan como el owner.';


-- =============================================================================
-- 3. ALTO — la unicidad de idempotencia colgaba de una columna best-effort
--
-- La 5/5 metió `created_by` en el índice único. `created_by` lo rellena
-- `set_row_provenance()` desde `coalesce(auth.uid(), GUC ladino.actor_id)`, y
-- la migración 6/6 de S0.3 lo documenta EN NEGRITA: «si la API olvida fijar el
-- GUC, created_by vuelve a NULL EN SILENCIO».
--
-- Reproducido: mismo cliente, misma clave, mismo cuerpo, un intento con el GUC
-- puesto y el reintento sin él -> DOS filas, actores {uuid, NULL}. Antes de la
-- 5/5 eso deduplicaba con 23505. Un silencio documentado convertido en doble
-- efecto, que en emisión fiscal es un documento duplicado (regla 4).
--
-- LA REGLA GENERAL, que es lo que hay que llevarse de aquí y está en ADR-0027:
-- **una restricción de unicidad no se construye sobre una columna cuyo contrato
-- documentado es "best-effort, y si falta queda NULL en silencio".**
--
-- `created_by` es PROCEDENCIA: quién escribió la fila, con la mejor información
-- disponible. `actor_id` es SEMÁNTICA DE LA CLAVE: en nombre de quién se
-- reserva la idempotencia. Confundirlos hace que cambiar el contrato de uno
-- cambie el otro en silencio. Se separan.
--
-- `actor_id` lo fija el MIDDLEWARE explícitamente. No lo deriva ningún trigger,
-- y por eso puede ser NOT NULL: si falta, falla activamente. Para trabajo de
-- sistema sin usuario, el middleware pone el centinela documentado abajo — un
-- valor explícito, no un NULL que signifique «no me acordé».
--
-- Sin FK a `auth.users`: el centinela no es un usuario, y una FK ahí impediría
-- borrar un usuario que alguna vez reservó una clave.
-- =============================================================================

alter table public.idempotency_keys add column actor_id uuid;

-- Backfill desde la procedencia. La tabla está vacía en todos los entornos —no
-- hay producción todavía— así que esto no toca ninguna fila real; se escribe
-- igual para que la migración sea correcta si alguien la aplica sobre datos.
update public.idempotency_keys
   set actor_id = coalesce(created_by, '00000000-0000-4000-8000-000000000000')
 where actor_id is null;

alter table public.idempotency_keys alter column actor_id set not null;

comment on column public.idempotency_keys.actor_id is
  'En nombre de quién se reserva la clave. Lo fija el MIDDLEWARE de forma '
  'explícita; NO lo deriva set_row_provenance(). Es semántica de la clave, no '
  'procedencia: por eso es NOT NULL y no se apoya en created_by, cuyo contrato '
  'es best-effort. Centinela para trabajo de sistema sin usuario: '
  '00000000-0000-4000-8000-000000000000. Sin FK a auth.users a propósito.';

drop index public.idempotency_keys_scope_uq;

create unique index idempotency_keys_scope_uq
  on public.idempotency_keys (tenant_id, company_id, actor_id, key)
  nulls not distinct;

comment on index public.idempotency_keys_scope_uq is
  'Alcance: tenant + company + ACTOR + clave. `endpoint` sigue fuera (ADR-0026 '
  'D5 enmendado). NULLS NOT DISTINCT cubre company de nivel tenant; actor_id es '
  'NOT NULL y no necesita la cláusula, pero company_id sí. '
  'CONTRATO S0.5: el lookup de replay DEBE filtrar por actor_id, o el índice no '
  'sirve de nada — el índice nunca fue la fuga, la fuga es el lookup.';


-- =============================================================================
-- 4. MEDIO — los 30 s de tolerancia compartían presupuesto con la transacción
--
-- El CHECK comparaba `occurred_at <= created_at + 30 s`, y `created_at` es
-- `now()`: la hora de INICIO DE TRANSACCIÓN. Así que los 30 s se gastaban
-- también en el tiempo que la transacción llevara abierta, y una transacción de
-- más de 30 s no podía escribir auditoría con reloj de pared. La 5/5 movió el
-- fallo de 50 ms a 30 s en vez de arreglarlo.
--
-- La comparación correcta es contra el reloj de PARED en el momento de
-- escribir. Un CHECK no puede hacerla —`clock_timestamp()` no es IMMUTABLE—, así
-- que la validación se va a un trigger BEFORE INSERT y el CHECK se retira.
--
-- Los 30 s siguen siendo la tolerancia, y ahora significan lo que decían
-- significar: deriva de reloj entre el app server y Postgres, y solo eso.
-- =============================================================================

alter table public.audit_events drop constraint audit_events_occurred_at_chk;

create or replace function platform.assert_occurred_at_not_future()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.occurred_at > clock_timestamp() + interval '30 seconds' then
    raise exception
      'LADINO_OCCURRED_AT_FUTURO: occurred_at (%) está más de 30 s por delante '
      'del reloj del servidor (%). Un cliente no declara que algo ocurrió en el '
      'futuro.',
      new.occurred_at, clock_timestamp()
      using errcode = 'LAD30',
            hint = 'Revise la sincronización de reloj del emisor. Hacia el '
                   'pasado no hay cota: el modo offline lo permite.';
  end if;
  return new;
end;
$$;

comment on function platform.assert_occurred_at_not_future() is
  'Valida occurred_at contra el RELOJ DE PARED (clock_timestamp()), no contra '
  'created_at. created_at es now() —hora de inicio de transacción— y comparar '
  'con él hacía que la tolerancia se gastara en la duración de la transacción: '
  'una transacción de más de 30 s no podía escribir auditoría. Un CHECK no '
  'sirve porque clock_timestamp() no es IMMUTABLE.';

revoke execute on function platform.assert_occurred_at_not_future() from public;

create trigger audit_events_occurred_at
  before insert on public.audit_events
  for each row execute function platform.assert_occurred_at_not_future();


-- =============================================================================
-- 5. BAJO — `event_type` sin cota de longitud reventaba en el índice
--
-- El regex admite cualquier longitud. `audit_events_type_idx` indexa
-- `event_type`, y un btree rechaza entradas de más de ~2700 bytes con
-- «index row size N exceeds btree version 4 maximum 2704» — un error que
-- ninguna capa de aplicación va a mapear y que aborta la transacción de
-- negocio.
--
-- Es exactamente el riesgo que la 3/4 acotó para `idempotency_keys.key`, y que
-- al reescribir este CHECK no se acotó aquí. `outbox` no indexa `event_type`,
-- pero se acota igual: la simetría entre las dos tablas vale más que el ahorro.
-- =============================================================================

alter table public.audit_events drop constraint audit_events_event_type_chk;
alter table public.audit_events add  constraint audit_events_event_type_chk
  check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
         and length(event_type) between 3 and 128);

alter table public.outbox drop constraint outbox_event_type_chk;
alter table public.outbox add  constraint outbox_event_type_chk
  check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'
         and length(event_type) between 3 and 128);


-- =============================================================================
-- 6. El comentario de `company_id` contradecía al trigger de alta
--
-- Decía que crear una company es un evento de NIVEL TENANT, con company_id
-- NULL. El trigger de alta de la 5/5 escribe `company_id = new.id`, lo que hace
-- ese evento visible al auditor de esa company.
--
-- Gana el trigger: **el alta de una company es parte de su propia historia.**
-- Un auditor con fiscal.audit.read sobre la empresa debe poder ver con qué RIF
-- nació. El comentario se corrige.
-- =============================================================================

comment on column public.audit_events.company_id is
  'NULL solo para eventos que no pertenecen a ninguna company. El ALTA de una '
  'company NO es uno de ellos: lleva company_id = su propio id, porque el alta '
  'es parte de la historia de esa empresa y su auditor debe verla. '
  'Consecuencia de los que sí son de nivel tenant: NO son legibles por '
  'authenticated — ver la policy de SELECT y ADR-0026 D3.';
