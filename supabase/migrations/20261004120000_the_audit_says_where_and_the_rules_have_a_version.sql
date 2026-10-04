-- Módulo: auditoría y versión de reglas   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md
-- Hallazgos del recorrido 2026-09-24: A-16, B-06, B-14 (RESPUESTA §2.15).
-- Reversible: SÍ en el esquema, NO en los datos — ver «REVERSIBILIDAD» al final.
-- Homologación: YES (cambia lo que cada documento fiscal y cada asiento guardan como versión de reglas).
--
-- EXPAND: solo añade. La API hoy desplegada sigue mandando la cadena `domain-s0.5` y sigue sin
-- declarar origen: la base resuelve la versión y pone el canal por el rol, así que esta migración
-- se puede aplicar antes del `git pull`.
--
-- TRES PIEZAS
--
--   1. ORIGEN DE LA AUDITORÍA (A-16). `audit_events` gana `channel` y `user_agent`, y un trigger
--      rellena canal, ip, user-agent, sesión y build desde los GUC `ladino.origin_*` que fija
--      `withTransaction` (packages/db) con lo que resolvió el middleware. Ningún caso de uso los
--      escribe. Sin GUC —la API de antes, una migración, una consola— el canal sale del rol.
--
--   2. ACTA DE PLATAFORMA (B-14). `audit_events` exige `tenant_id`, y la tasa oficial del BCV es de
--      la plataforma: no tiene inquilino. `public.system_audit_events` es su acta: append-only,
--      solo la escribe el actor de sistema y no la lee nadie por la API.
--
--   3. `rules_version` (B-06, ADR-0079) = versión semántica + hash del conjunto de reglas.
--        · la versión semántica vive en `platform.rules_releases` y la sube una migración;
--        · el hash tiene dos partes: la GLOBAL (calendario, unidad tributaria, IGTF, porciones y
--          exclusiones de retención, literales, regímenes, parámetros), materializada en
--          `platform.rule_set_state` por un trigger de sentencia, y la DE LA EMPRESA (sus
--          `tax_rules` y `retention_rules` —las globales y las propias—, su régimen y su tipo de
--          contribuyente), calculada al congelar. Medido: el conjunto entero costaba 77 ms por
--          cálculo (970 filas de calendario); así, cada fila paga solo la parte de la empresa;
--        · el hash no depende de la fecha ni de `now()`: cubre TODAS las filas con sus vigencias.
--          Cambia cuando cambia una regla, no cuando pasa un día;
--        · quien escribe declara `domain-s0.5` (la cadena de siempre, la que manda la API
--          desplegada) y la base la sustituye, en un solo sitio, por la versión vigente y la
--          registra en `platform.rules_versions`. Cualquier otra cadena (`db-guard`,
--          `db-migration`, `repair-*`) se respeta: dice que no la escribió un caso de uso;
--        · lo ya escrito no se toca (reglas 1 y 2): conserva `domain-s0.5`.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. ORIGEN DE LA AUDITORÍA
-- ════════════════════════════════════════════════════════════════════════════

alter table public.audit_events
  add column if not exists channel text,
  add column if not exists user_agent text;

alter table public.audit_events
  add constraint audit_events_channel_chk
    check (channel is null or channel in ('web', 'mobile', 'api', 'worker', 'migration', 'db')),
  add constraint audit_events_user_agent_len_chk
    check (user_agent is null or length(user_agent) <= 512);

comment on column public.audit_events.channel is
  'Por dónde entró la escritura (A-16): web, mobile o api (lo resuelve el middleware de la API; web y mobile los DECLARA el cliente en X-Ladino-Client, no son prueba), worker, migration (lo dice la migración) o db (una sesión SQL sin aplicación). NULL solo en filas anteriores a 20261004120000.';
comment on column public.audit_events.user_agent is
  'User-Agent de la petición, recortado a 512. Dato personal: no sale en ninguna respuesta de la API; lo lee quien tiene fiscal.audit.read.';
comment on column public.audit_events.ip is
  'IP del cliente según el último salto de X-Forwarded-For (el que añade el proxy propio). Dato personal: no sale en ninguna respuesta de la API.';

create or replace function platform.set_audit_origin()
returns trigger
language plpgsql
set search_path to ''
as $function$
declare
  v_channel text := nullif(pg_catalog.current_setting('ladino.origin_channel', true), '');
  v_ip      text;
begin
  if v_channel is not null then
    -- Lo que declaró quien abrió la transacción MANDA sobre lo que traiga la fila: el origen no
    -- es dato del caso de uso.
    v_ip := nullif(pg_catalog.current_setting('ladino.origin_ip', true), '');
    new.channel    := v_channel;
    -- Una ip mal formada no puede tumbar la escritura que se audita: queda vacía.
    new.ip         := case when v_ip is not null and pg_catalog.pg_input_is_valid(v_ip, 'inet')
                           then v_ip::inet end;
    new.user_agent := pg_catalog.left(
      nullif(pg_catalog.current_setting('ladino.origin_user_agent', true), ''), 512);
    new.session_id := pg_catalog.left(
      nullif(pg_catalog.current_setting('ladino.origin_session', true), ''), 128);
    new.app_build  := pg_catalog.left(
      nullif(pg_catalog.current_setting('ladino.origin_build', true), ''), 128);
  end if;
  if new.channel is null
     or new.channel not in ('web', 'mobile', 'api', 'worker', 'migration', 'db') then
    -- Nadie declaró el canal (la API anterior a esta migración, una reparación, una consola):
    -- lo dice el rol. `session_user` cubre la conexión directa; `current_user`, el `set role`.
    new.channel := case
      when 'ladino_worker' in (session_user, current_user) then 'worker'
      when 'ladino_api' in (session_user, current_user) then 'api'
      else 'db'
    end;
  end if;
  return new;
end;
$function$;

revoke all on function platform.set_audit_origin() from public;

create trigger audit_events_origin
  before insert on public.audit_events
  for each row execute function platform.set_audit_origin();

-- ════════════════════════════════════════════════════════════════════════════
-- 2. ACTA DE PLATAFORMA
-- ════════════════════════════════════════════════════════════════════════════

create table public.system_audit_events (
  id             uuid primary key default platform.uuidv7(),
  aggregate_type text not null,
  aggregate_id   uuid not null,
  event_type     text not null,
  actor_type     text not null default 'system',
  -- La persona que lo pidió, si lo pidió alguien (el botón «Traer del BCV»). Sin FK: es
  -- procedencia, y el acta sobrevive a la cuenta.
  requested_by   uuid,
  occurred_at    timestamptz not null,
  payload        jsonb not null default '{}'::jsonb,
  payload_hash   bytea generated always as (platform.audit_payload_hash(payload)) stored,
  created_by     uuid,
  created_at     timestamptz not null,
  version        integer not null,
  constraint system_audit_events_aggregate_type_chk
    check (aggregate_type ~ '^[a-z][a-z0-9_]*$' and length(aggregate_type) <= 64),
  constraint system_audit_events_event_type_chk
    check (event_type ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$' and length(event_type) <= 128),
  constraint system_audit_events_actor_type_chk check (actor_type = 'system'),
  constraint system_audit_events_payload_object_chk check (jsonb_typeof(payload) = 'object')
);

comment on table public.system_audit_events is
  'Acta de las operaciones de la PLATAFORMA, que no tienen inquilino (B-14): hoy, la captura de la tasa oficial del BCV. Append-only. La escribe el actor de sistema; no se lee por la API.';

create index system_audit_events_aggregate_idx
  on public.system_audit_events (aggregate_type, aggregate_id, id desc);

create trigger system_audit_events_provenance
  before insert or update on public.system_audit_events
  for each row execute function platform.set_row_provenance();
create trigger system_audit_events_occurred_at
  before insert on public.system_audit_events
  for each row execute function platform.assert_occurred_at_not_future();
create trigger system_audit_events_append_only
  before update or delete on public.system_audit_events
  for each row execute function platform.reject_mutation();
create trigger system_audit_events_no_truncate
  before truncate on public.system_audit_events
  for each statement execute function platform.reject_mutation();

alter table public.system_audit_events enable row level security;
alter table public.system_audit_events force row level security;

revoke all on public.system_audit_events from public, anon, authenticated;
grant insert on public.system_audit_events to ladino_api;

-- Prohibiciones ESCRITAS (ausencia de policy no es prohibición).
create policy system_audit_events_select on public.system_audit_events
  for select to authenticated, ladino_api using (false);
create policy system_audit_events_insert on public.system_audit_events
  for insert to authenticated with check (false);
create policy system_audit_events_update on public.system_audit_events
  for update to authenticated, ladino_api using (false);
create policy system_audit_events_delete on public.system_audit_events
  for delete to authenticated, ladino_api using (false);
-- El único camino: la API, con el actor de sistema.
create policy system_audit_events_api_insert on public.system_audit_events
  for insert to ladino_api with check (platform.ladino_actor_is_system());

-- ════════════════════════════════════════════════════════════════════════════
-- 3. rules_version
-- ════════════════════════════════════════════════════════════════════════════

-- 3.1 La versión semántica: la sube una migración con un `insert`.
create table platform.rules_releases (
  semver      text primary key,
  released_at timestamptz not null default now(),
  note        text not null,
  constraint rules_releases_semver_chk check (semver ~ '^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$'),
  constraint rules_releases_note_chk check (length(btrim(note)) >= 10)
);
comment on table platform.rules_releases is
  'ADR-0079: la versión semántica del conjunto de reglas. Sube por MIGRACIÓN (un insert) cuando cambia la lógica de una regla; el contenido de las reglas lo cubre el hash. Append-only.';

-- 3.2 La parte global del hash, materializada.
create table platform.rule_set_state (
  id          boolean primary key default true,
  global_hash text not null,
  computed_at timestamptz not null default now(),
  constraint rule_set_state_single_chk check (id),
  constraint rule_set_state_hash_chk check (global_hash ~ '^[0-9a-f]{64}$')
);
comment on table platform.rule_set_state is
  'ADR-0079: el hash de las reglas GLOBALES, recalculado por trigger de sentencia en cada tabla que cubre. Es una materialización: platform.rule_set_drift() la compara con el recálculo y debe dar cero.';

-- 3.3 El registro de versiones que algún documento congeló.
create table platform.rules_versions (
  version       text primary key,
  semver        text not null references platform.rules_releases (semver),
  rules_hash    text not null,
  registered_at timestamptz not null default now(),
  constraint rules_versions_hash_chk check (rules_hash ~ '^[0-9a-f]{64}$'),
  constraint rules_versions_shape_chk
    check (version = semver || '+' || left(rules_hash, 16))
);
comment on table platform.rules_versions is
  'ADR-0079: cada versión de reglas que se congeló en una fila. `version` = semver + «+» + los 16 primeros hex del hash. Append-only. No guarda de qué empresa es: un hash no dice nada de nadie.';

create trigger rules_releases_append_only
  before update or delete on platform.rules_releases
  for each row execute function platform.reject_mutation();
create trigger rules_releases_no_truncate
  before truncate on platform.rules_releases
  for each statement execute function platform.reject_mutation();
create trigger rules_versions_append_only
  before update or delete on platform.rules_versions
  for each row execute function platform.reject_mutation();
create trigger rules_versions_no_truncate
  before truncate on platform.rules_versions
  for each statement execute function platform.reject_mutation();

alter table platform.rules_releases enable row level security;
alter table platform.rules_releases force row level security;
alter table platform.rule_set_state enable row level security;
alter table platform.rule_set_state force row level security;
alter table platform.rules_versions enable row level security;
alter table platform.rules_versions force row level security;
revoke all on platform.rules_releases, platform.rule_set_state, platform.rules_versions
  from public, anon, authenticated, ladino_api, ladino_worker;

-- 3.4 El hash global. Orden estable (tabla, clave, fila), sin now(): las columnas de procedencia
-- (cuándo y quién) no son la regla y quedan fuera.
create or replace function platform.rules_global_hash()
returns text
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v text;
begin
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           pg_catalog.string_agg(
             f.t || '|' || f.k || '|'
               || ((f.j - array['created_at', 'created_by', 'version', 'updated_at'])::text),
             E'\n' order by f.t, f.k, f.j::text), ''), 'UTF8')), 'hex')
    into v
    from (
      select 'tax_calendar_entries'::text as t, r.id::text as k, pg_catalog.to_jsonb(r) as j
        from public.tax_calendar_entries r
      union all
      select 'tax_units', r.id::text, pg_catalog.to_jsonb(r) from public.tax_units r
      union all
      select 'igtf_rules', r.id::text, pg_catalog.to_jsonb(r) from public.igtf_rules r
      union all
      select 'iva_retention_portions', r.id::text, pg_catalog.to_jsonb(r)
        from public.iva_retention_portions r
      union all
      select 'retention_concepts', r.code::text, pg_catalog.to_jsonb(r)
        from public.retention_concepts r
      union all
      select 'retention_exclusions', r.code::text, pg_catalog.to_jsonb(r)
        from public.retention_exclusions r
      union all
      select 'tax_exemption_literals', r.code::text, pg_catalog.to_jsonb(r)
        from public.tax_exemption_literals r
      union all
      select 'tax_reduced_rate_literals', r.code::text, pg_catalog.to_jsonb(r)
        from public.tax_reduced_rate_literals r
      union all
      select 'fiscal_regimes', r.code::text, pg_catalog.to_jsonb(r) from public.fiscal_regimes r
      union all
      select 'parameters', r.key, pg_catalog.to_jsonb(r) from platform.parameters r
    ) f;
  return v;
end;
$function$;

create or replace function platform.refresh_rule_set_state()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  -- El candado ANTES del cálculo: quien espera aquí recalcula después con una foto que ya ve lo
  -- que commiteó el otro. Calcular y luego esperar guardaría un hash sin la regla del otro.
  perform 1 from platform.rule_set_state s where s.id for update;
  update platform.rule_set_state s
     set global_hash = platform.rules_global_hash(), computed_at = pg_catalog.now()
   where s.id;
  perform pg_catalog.set_config('ladino.rules_version_cache', '', true);
  return null;
end;
$function$;

do $crear$
declare
  t text;
begin
  foreach t in array array[
    'public.tax_calendar_entries', 'public.tax_units', 'public.igtf_rules',
    'public.iva_retention_portions', 'public.retention_concepts', 'public.retention_exclusions',
    'public.tax_exemption_literals', 'public.tax_reduced_rate_literals', 'public.fiscal_regimes',
    'platform.parameters']
  loop
    execute format(
      'create trigger %I after insert or update or delete or truncate on %s '
      'for each statement execute function platform.refresh_rule_set_state()',
      'zz_rule_set_state', t);
  end loop;
end
$crear$;

insert into platform.rule_set_state (id, global_hash) values (true, platform.rules_global_hash());

insert into platform.rules_releases (semver, note) values
  ('1.0.0', 'ADR-0079: primer conjunto de reglas versionado. Lo anterior lleva la cadena fija domain-s0.5.');

-- 3.5 La versión vigente de una empresa (sin escribir) y la que se congela (registra).
create or replace function platform.current_rules_version(p_company uuid)
returns table (version text, semver text, rules_hash text)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_semver  text;
  v_global  text;
  v_company text;
  v_hash    text;
begin
  select r.semver into v_semver
    from platform.rules_releases r
   order by pg_catalog.string_to_array(r.semver, '.')::int[] desc
   limit 1;
  select s.global_hash into v_global from platform.rule_set_state s where s.id;
  if v_semver is null or v_global is null then
    raise exception 'LADINO_RULES_VERSION: falta la versión semántica o el hash global de reglas.'
      using errcode = 'LAD00';
  end if;

  -- La parte de la empresa: las reglas que le aplican (globales y propias), su régimen y su tipo.
  -- `rules_version` y `actor_id` de company_taxpayer_types son procedencia, no regla.
  select pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(coalesce(
           pg_catalog.string_agg(
             f.t || '|' || f.k || '|'
               || ((f.j - array['created_at', 'created_by', 'version', 'updated_at',
                                'rules_version', 'actor_id'])::text),
             E'\n' order by f.t, f.k), ''), 'UTF8')), 'hex')
    into v_company
    from (
      select 'tax_rules'::text as t, r.id::text as k, pg_catalog.to_jsonb(r) as j
        from public.tax_rules r
       where r.company_id is null or r.company_id = p_company
      union all
      select 'retention_rules', r.id::text, pg_catalog.to_jsonb(r)
        from public.retention_rules r
       where r.company_id is null or r.company_id = p_company
      union all
      select 'company_fiscal_regimes', r.id::text, pg_catalog.to_jsonb(r)
        from public.company_fiscal_regimes r
       where r.company_id = p_company
      union all
      select 'company_taxpayer_types', r.id::text, pg_catalog.to_jsonb(r)
        from public.company_taxpayer_types r
       where r.company_id = p_company
    ) f;

  v_hash := pg_catalog.encode(
    pg_catalog.sha256(pg_catalog.convert_to(v_global || '|' || v_company, 'UTF8')), 'hex');
  version := v_semver || '+' || pg_catalog.left(v_hash, 16);
  semver := v_semver;
  rules_hash := v_hash;
  return next;
end;
$function$;

create or replace function platform.freeze_rules_version(p_company uuid)
returns text
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v record;
begin
  select c.version, c.semver, c.rules_hash into v from platform.current_rules_version(p_company) c;
  if not exists (select 1 from platform.rules_versions r where r.version = v.version) then
    insert into platform.rules_versions (version, semver, rules_hash)
    values (v.version, v.semver, v.rules_hash)
    on conflict (version) do nothing;
  end if;
  return v.version;
end;
$function$;

-- 3.6 EL ÚNICO SITIO donde la cadena fija se sustituye.
create or replace function platform.stamp_rules_version()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_key   text;
  v_cache text;
  v       text;
begin
  -- `domain-s0.5` es lo que declara el dominio (RULES_VERSION, packages/domain): «lo escribe un
  -- caso de uso; la versión la pone la base». Otra cadena, o ninguna, se deja como viene.
  if new.rules_version is distinct from 'domain-s0.5' then
    return new;
  end if;
  -- Congelada es congelada: un UPDATE que vuelve a declarar no cambia la versión con la que nació.
  if tg_op = 'UPDATE' and exists (
       select 1 from platform.rules_versions r where r.version = old.rules_version) then
    new.rules_version := old.rules_version;
    return new;
  end if;
  -- Una transacción, una versión por empresa: el documento, su asiento y sus actas comparten la
  -- misma, y el hash se calcula una vez (medido: ~3 ms por fila sin esto). La memoria es un GUC
  -- local a la transacción que borra todo cambio de regla (forget_rules_version_cache y
  -- refresh_rule_set_state); y solo vale si nombra una versión REGISTRADA, así que escribirlo a
  -- mano no inventa una versión.
  v_key := coalesce(new.company_id::text, '-');
  v_cache := pg_catalog.current_setting('ladino.rules_version_cache', true);
  if v_cache is not null and pg_catalog.split_part(v_cache, '|', 1) = v_key then
    v := pg_catalog.split_part(v_cache, '|', 2);
    if exists (select 1 from platform.rules_versions r where r.version = v) then
      new.rules_version := v;
      return new;
    end if;
  end if;
  v := platform.freeze_rules_version(new.company_id);
  perform pg_catalog.set_config('ladino.rules_version_cache', v_key || '|' || v, true);
  new.rules_version := v;
  return new;
end;
$function$;

-- Todo cambio en las reglas de la empresa olvida la versión recordada en la transacción.
create or replace function platform.forget_rules_version_cache()
returns trigger
language plpgsql
set search_path to ''
as $function$
begin
  perform pg_catalog.set_config('ladino.rules_version_cache', '', true);
  return null;
end;
$function$;

revoke all on function platform.forget_rules_version_cache() from public;

do $crear$
declare
  t text;
begin
  foreach t in array array['tax_rules', 'retention_rules', 'company_fiscal_regimes',
                           'company_taxpayer_types']
  loop
    execute format(
      'create trigger %I after insert or update or delete or truncate on public.%I '
      'for each statement execute function platform.forget_rules_version_cache()',
      'zz_rules_version_cache', t);
  end loop;
end
$crear$;

revoke all on function platform.rules_global_hash() from public;
revoke all on function platform.refresh_rule_set_state() from public;
revoke all on function platform.current_rules_version(uuid) from public;
revoke all on function platform.freeze_rules_version(uuid) from public;
revoke all on function platform.stamp_rules_version() from public;

-- Toda tabla de public con `rules_version` lleva el trigger: es regla de familia, sin lista de
-- perdones (el pgTAP 122 lo pregunta al catálogo). Si una no tiene `company_id`, la migración
-- falla aquí en vez de dejarla fuera.
do $crear$
declare
  r record;
begin
  for r in
    select c.table_name,
           exists (select 1 from information_schema.columns k
                    where k.table_schema = 'public' and k.table_name = c.table_name
                      and k.column_name = 'company_id') as con_empresa
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'rules_version'
     order by c.table_name
  loop
    if not r.con_empresa then
      raise exception 'public.% tiene rules_version y no tiene company_id', r.table_name;
    end if;
    execute format(
      'create trigger %I before insert or update of rules_version on public.%I '
      'for each row execute function platform.stamp_rules_version()',
      r.table_name || '_90_rules_version', r.table_name);
  end loop;
end
$crear$;

-- ════════════════════════════════════════════════════════════════════════════
-- 4. INVARIANTES
-- ════════════════════════════════════════════════════════════════════════════

insert into platform.invariant_cutoffs (invariant, since, reason) values
  ('rules_version_gaps', now(),
   'Antes de esta migración la versión de reglas era la cadena fija domain-s0.5 (B-06). Un documento fiscal emitido no se edita (regla 1): los anteriores conservan esa cadena (ADR-0079).');

create or replace function platform.rules_version_gaps(p_company uuid)
returns table (document_id uuid, rules_version text)
language sql
stable
set search_path to ''
as $function$
  -- ENUNCIADO: todo documento fiscal (factura, nota de crédito, nota de débito) emitido desde el
  -- corte (platform.invariant_cutoffs) lleva una `rules_version` registrada en
  -- platform.rules_versions.
  select d.id, d.rules_version
    from public.documents d
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and coalesce(d.issued_at, d.created_at) >= (select c.since from platform.invariant_cutoffs c
                                                  where c.invariant = 'rules_version_gaps')
     and not exists (select 1 from platform.rules_versions v where v.version = d.rules_version)
$function$;

create or replace function platform.rule_set_drift()
returns table (stored text, recomputed text)
language sql
stable
set search_path to ''
as $function$
  -- ENUNCIADO: el hash global guardado es el que sale de recalcularlo. Una fila aquí es una tabla
  -- de reglas que cambió sin pasar por su trigger (o una tabla nueva sin él).
  select s.global_hash, platform.rules_global_hash()
    from platform.rule_set_state s
   where s.global_hash is distinct from platform.rules_global_hash()
  union all
  select null, platform.rules_global_hash()
   where not exists (select 1 from platform.rule_set_state)
$function$;

revoke all on function platform.rules_version_gaps(uuid) from public;
revoke all on function platform.rule_set_drift() from public;

-- REVERSIBILIDAD, con datos vivos.
--   · El esquema se deshace con otra migración: quitar los triggers `*_90_rules_version`,
--     `audit_events_origin` y `zz_rule_set_state`, y las funciones. Las columnas `channel` y
--     `user_agent` y las tablas nuevas se pueden dejar.
--   · Los datos NO: toda fila escrita desde aquí en audit_events, journal_entries, documents y
--     las demás lleva `1.0.0+<hash>` en vez de `domain-s0.5`, y esas tablas son append-only o
--     documentos emitidos. No se reescriben. Revertir deja dos generaciones de cadena
--     conviviendo —como ya conviven desde hoy—, y quien lea `rules_version` tiene que aceptar las
--     dos. Borrar `platform.rules_versions` dejaría esas filas apuntando a una versión que ya no
--     existe: no se borra.
