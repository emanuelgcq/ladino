-- =============================================================================
-- Ladino — 7/7 de S0.4 · Cierre: el actor se clava, y `aggregate_type` se acota
--
-- Módulo:         idempotencia, auditoría (S0.4)
-- Spec:           ADR-0018 (enmendado), ADR-0026, ADR-0027 §3-bis
-- Reversibilidad: SÍ. Un trigger y dos constraints.
-- HOMOLOGATION_IMPACT: YES
--
-- Dos defectos de la migración anterior, los dos reproducidos contra la base.
-- El primero lo introduje al arreglar otra cosa; el segundo lo dejé a medias en
-- la misma migración que decía haberlo cerrado.
-- =============================================================================


-- =============================================================================
-- 1. ALTO — `actor_id` es MUTABLE, y `created_by` no lo era
--
-- Al mover la dimensión de actor del índice único desde `created_by` hacia
-- `actor_id`, la columna semántica perdió la única defensa activa que tenía la
-- de procedencia: `platform.set_row_provenance()` hace
-- `new.created_by := old.created_by` en TODO update, así que `created_by` estaba
-- CLAVADO. `actor_id` no lo está, y esta tabla recibe updates por diseño
-- (in_progress -> completed).
--
-- Reproducido como service_role, que es exactamente quien escribe la tabla:
--
--     insert ... actor_id = 'aaaa…'
--     update public.idempotency_keys set actor_id = '9999…' where key = 'K-1';
--     -> UPDATE 1, actor_id = 9999…
--
-- Consecuencia: mover la reserva de actor LIBERA el hueco del actor original
-- —su operación se vuelve a ejecutar, y en emisión fiscal eso es un documento
-- duplicado (regla 4)— o bloquea a otro. No hace falta malicia: un ORM que
-- reescriba la fila entera al marcar `completed`, o un UPDATE con WHERE flojo.
--
-- La lección, que es la de ADR-0027 §3-bis leída al revés: separar semántica de
-- procedencia fue correcto, pero al separarlas hay que **replicar la defensa**,
-- no solo el dato. Una columna que sostiene una garantía dura necesita que algo
-- la sostenga a ella.
-- =============================================================================

create or replace function platform.assert_idempotency_actor_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.actor_id is distinct from old.actor_id then
    raise exception
      'LADINO_IDEMPOTENCY_ACTOR_INMUTABLE: actor_id es parte del alcance de la '
      'clave de idempotencia. Moverlo libera la reserva del actor original y su '
      'operación se ejecuta dos veces.'
      using errcode = 'LAD31',
            hint = 'Para una operación de otro actor, reserve una clave nueva.';
  end if;
  return new;
end;
$$;

comment on function platform.assert_idempotency_actor_immutable() is
  'Clava idempotency_keys.actor_id. Es el equivalente de lo que '
  'set_row_provenance() hacía por created_by: una columna que sostiene el '
  'alcance de la unicidad no puede cambiar mientras la fila viva.';

revoke execute on function platform.assert_idempotency_actor_immutable() from public;

create trigger idempotency_keys_actor_immutable
  before update on public.idempotency_keys
  for each row execute function platform.assert_idempotency_actor_immutable();


-- =============================================================================
-- 2. MEDIO — se acotó `event_type` y se dejó `aggregate_type` suelto
--
-- La migración anterior acotó `event_type` a 3–128 «porque audit_events_type_idx
-- lo indexa y un btree revienta a ~2704 bytes». La tabla tiene OTRO índice,
-- `audit_events_aggregate_idx (tenant_id, aggregate_type, aggregate_id, id)`, y
-- `aggregate_type` solo llevaba el regex de forma: sin cota.
--
-- Reproducido, con texto incompresible de 3.000 caracteres:
--
--     ERROR: index row size 3064 exceeds btree version 4 maximum 2704
--            for index "audit_events_aggregate_idx"
--
-- Es literalmente el error que la migración anterior dice haber eliminado, en la
-- misma tabla, sin mapear a ningún código de aplicación y abortando la
-- transacción de negocio — que con el commit compartido de ADR-0026 D2 es el
-- hecho fiscal, no el log.
--
-- Detalle que explica por qué no se ve a la primera: con `repeat('z', 3000)` NO
-- se reproduce. TOAST comprime la cadena repetitiva y la entrada del índice
-- cabe. Hace falta texto incompresible. Una prueba con datos «bonitos» pasa en
-- verde sobre un esquema roto — el mismo patrón que el test 012 documenta.
--
-- 64 basta con holgura: el término más largo del catálogo es `contingency`.
-- =============================================================================

alter table public.audit_events add constraint audit_events_aggregate_type_len_chk
  check (length(aggregate_type) between 1 and 64);

alter table public.outbox add constraint outbox_aggregate_type_len_chk
  check (length(aggregate_type) between 1 and 64);

comment on constraint audit_events_aggregate_type_len_chk on public.audit_events is
  'Cota de longitud, no de forma. `aggregate_type` entra en '
  'audit_events_aggregate_idx y un btree rechaza entradas de más de ~2704 bytes '
  'con un error que ninguna capa de aplicación mapea. No se reproduce con texto '
  'repetitivo porque TOAST lo comprime: hace falta texto incompresible.';
