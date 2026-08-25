-- =============================================================================
-- Ladino — migración 14 · Roles de servicio dedicados, sin BYPASSRLS (ADR-0031)
--
-- Módulo: platform   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md · ADR-0031
-- Reversible: SÍ (drop de policies, funciones de servicio y roles)
-- Homologación: NO
--
-- QUÉ ARREGLA. La API y el worker se conectaban como `postgres.<ref>`: BYPASSRLS,
-- DDL, todos los tenants. Con eso, las seis migraciones de aislamiento de S0.3
-- eran decorativas para el camino por el que pasa TODO el tráfico, y la única
-- defensa real era que el código filtrara bien (F-15 de la auditoría de S0.6a).
--
-- CÓMO. Tres piezas:
--   1. Funciones de actor DE SERVICIO, separadas: `ladino_service_actor_id()`
--      lee SOLO el GUC `ladino.actor_id` que fija withTransaction(). Las
--      funciones del camino `authenticated` (`ladino_tenant_ids()`,
--      `ladino_company_ids()`, `ladino_has_permission()`…) NO SE TOCAN y
--      siguen resolviendo por `auth.uid()`.
--   2. `ladino_api` — sin BYPASSRLS, con policies propias por TENANT del actor
--      de servicio. La RLS es la segunda capa; la autorización por company y
--      permiso sigue en el caso de uso.
--   3. `ladino_worker` — sin BYPASSRLS y con GRANT solo sobre outbox e
--      idempotency_keys. Su aislamiento es privilegio de tabla, no RLS.
--
-- POR QUÉ FUNCIONES SEPARADAS Y NO UN COALESCE(auth.uid(), GUC) EN LAS
-- EXISTENTES — se intentó y SEIS suites de pgTAP lo tumbaron: con el coalesce,
-- un GUC presente en la transacción daba visibilidad a una sesión
-- `authenticated` SIN JWT, y «sin JWT no se ve nada» es una propiedad que esos
-- tests protegen desde S0.3. Con funciones separadas la propiedad es
-- estructural: NINGUNA policy de anon/authenticated lee el GUC, así que el GUC
-- no puede dar acceso a ese camino ni con el orden de un coalesce bien puesto.
-- La 014 lo prueba, y su variante rota demuestra qué se pierde al mezclarlas.
--
-- Sin contraseñas aquí: una contraseña en una migración es un secreto en git.
-- LOGIN y contraseña se dan fuera de banda (seed.sql en local; el operador en
-- el remoto). `set_row_provenance()` no cambia: ya resolvía auth.uid() → GUC
-- desde S0.3, y ese coalesce es correcto ahí — atribuye, no autoriza.
-- =============================================================================

-- ── 1. El actor de SERVICIO ──────────────────────────────────────────────────
-- STABLE + SECURITY DEFINER + search_path fijado: el INVARIANTE que 003 y 006
-- exigen a toda función platform.ladino_* / de platform. Renuncia al inlining,
-- y está bien renunciar: se evalúa una vez por sentencia (InitPlan en las
-- policies de tenant) o por fila sobre conjuntos mínimos (idempotencia por
-- clave única). No es el envoltorio SQL→SQL que costó 28× en S0.4: el cuerpo
-- llama a current_setting, una función C.
create or replace function platform.ladino_service_actor_id()
returns uuid
language sql
stable security definer
set search_path = ''
as $$
  select nullif(pg_catalog.current_setting('ladino.actor_id', true), '')::uuid;
$$;

comment on function platform.ladino_service_actor_id() is
  'Actor del camino de SERVICIO: el GUC ladino.actor_id que withTransaction() '
  'fija como primera sentencia. Deliberadamente NO mira auth.uid(): el camino '
  'authenticated tiene sus propias funciones, y ninguna policy de ese camino '
  'lee el GUC — separación por construcción (ADR-0031).';

revoke execute on function platform.ladino_service_actor_id() from public;

create or replace function platform.ladino_service_tenant_ids()
returns setof uuid
language sql
stable security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.memberships m
   where m.user_id = platform.ladino_service_actor_id()
     and m.status = 'active';
$$;

comment on function platform.ladino_service_tenant_ids() is
  'Tenants con membership activo del actor de servicio (GUC). Es el predicado '
  'de TODAS las policies TO ladino_api: un InitPlan por sentencia. ADR-0031.';

revoke execute on function platform.ladino_service_tenant_ids() from public;

-- ── 2. Los roles ─────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ladino_api') then
    create role ladino_api nologin nobypassrls nosuperuser noinherit nocreatedb nocreaterole;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'ladino_worker') then
    create role ladino_worker nologin nobypassrls nosuperuser noinherit nocreatedb nocreaterole;
  end if;
end $$;

-- Si ya existían con otros atributos (un remoto donde alguien los creó a
-- mano), NO se corrigen con ALTER — nombrar SUPERUSER en un ALTER ROLE exige
-- ser superusuario, y las migraciones corren como `postgres`, que no lo es
-- (descubierto al aplicar: 42501). El bloque LAD32 del final ABORTA la
-- migración si los atributos no son los exigidos; corregirlos es del operador.

comment on role ladino_api is
  'Rol de conexión de apps/api. Sin BYPASSRLS: las policies TO ladino_api lo '
  'acotan al tenant del actor (GUC ladino.actor_id). ADR-0031.';
comment on role ladino_worker is
  'Rol de conexión de apps/worker. Sin BYPASSRLS y con GRANT solo sobre outbox '
  'e idempotency_keys: no puede ni nombrar las tablas de negocio. ADR-0031.';

-- `postgres` puede adoptar los roles (SET ROLE): lo necesitan los pgTAP y el
-- operador para diagnosticar «qué ve la API». No amplía nada: postgres ya
-- tiene BYPASSRLS.
grant ladino_api    to postgres;
grant ladino_worker to postgres;

-- ── 3. Privilegios: estado limpio y luego lo mínimo ─────────────────────────
revoke all on all tables    in schema public   from ladino_api, ladino_worker;
revoke all on all functions in schema platform from ladino_api, ladino_worker;

grant usage on schema public   to ladino_api, ladino_worker;
grant usage on schema platform to ladino_api, ladino_worker;
-- `platform.uuidv7()` y `audit_payload_hash()` llaman por dentro a pgcrypto,
-- que vive en `extensions` — y un default o columna generada se evalúa con los
-- privilegios del INSERTANTE. Sin este USAGE, el primer INSERT muere con
-- «permission denied for schema extensions» (encontrado ejerciendo la
-- operación, no mirando el catálogo: la lección de S0.4, otra vez).
grant usage on schema extensions to ladino_api, ladino_worker;

-- Lo que evalúa el INSERTANTE, no el trigger: defaults y columnas generadas
-- (la lección de S0.4: has_table_privilege decía sí y el INSERT moría por
-- falta de EXECUTE en audit_payload_hash).
grant execute on function platform.uuidv7()                  to ladino_api, ladino_worker;
grant execute on function platform.audit_payload_hash(jsonb) to ladino_api;
-- Las funciones de servicio las evalúan las policies, que corren como el rol.
grant execute on function platform.ladino_service_actor_id()  to ladino_api, ladino_worker;
grant execute on function platform.ladino_service_tenant_ids() to ladino_api;

-- ladino_api: lo que la API hace hoy y lo que harán los maestros. Sin
-- TRUNCATE, REFERENCES ni TRIGGER en ninguna.
grant select, update                 on public.tenants               to ladino_api; -- UPDATE por el FOR UPDATE
grant select, insert, update         on public.companies             to ladino_api;
grant select, insert, update, delete on public.memberships           to ladino_api;
grant select, insert, update, delete on public.roles                 to ladino_api;
grant select, insert, update, delete on public.role_permissions      to ladino_api;
grant select, insert, update, delete on public.user_role_assignments to ladino_api;
grant select, insert, update, delete on public.scope_bindings        to ladino_api;
grant select                         on public.permissions           to ladino_api;
grant select, insert, update, delete on public.branches              to ladino_api;
grant select, insert, update, delete on public.warehouses            to ladino_api;
grant select, insert, update, delete on public.cash_registers        to ladino_api;
grant select, insert                 on public.audit_events          to ladino_api;
grant select, insert                 on public.outbox                to ladino_api;
grant select, insert, update         on public.idempotency_keys      to ladino_api;

-- ladino_worker: dos tablas. Nada más.
grant select, update         on public.outbox           to ladino_worker;
grant select, update, delete on public.idempotency_keys to ladino_worker;

-- ── 4. Policies TO ladino_api — por TENANT del actor de servicio ─────────────
-- `tenant_id in (select platform.ladino_service_tenant_ids())` es un InitPlan:
-- una vez por sentencia, no por fila. La company y el permiso los decide el
-- caso de uso; esto es la segunda capa, y la fuga que impide es la que cruza
-- tenants.

create policy tenants_api_select on public.tenants for select to ladino_api
  using (id in (select platform.ladino_service_tenant_ids()));
create policy tenants_api_update on public.tenants for update to ladino_api
  using      (id in (select platform.ladino_service_tenant_ids()))
  with check (id in (select platform.ladino_service_tenant_ids()));

create policy companies_api_select on public.companies for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy companies_api_insert on public.companies for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy companies_api_update on public.companies for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy memberships_api_select on public.memberships for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy memberships_api_insert on public.memberships for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy memberships_api_update on public.memberships for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy memberships_api_delete on public.memberships for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- roles y role_permissions: las filas GLOBALES (tenant_id null) se leen; solo
-- se escriben las del tenant.
create policy roles_api_select on public.roles for select to ladino_api
  using (tenant_id is null or tenant_id in (select platform.ladino_service_tenant_ids()));
create policy roles_api_insert on public.roles for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy roles_api_update on public.roles for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy roles_api_delete on public.roles for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy role_permissions_api_select on public.role_permissions for select to ladino_api
  using (tenant_id is null or tenant_id in (select platform.ladino_service_tenant_ids()));
create policy role_permissions_api_insert on public.role_permissions for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy role_permissions_api_update on public.role_permissions for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy role_permissions_api_delete on public.role_permissions for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy user_role_assignments_api_select on public.user_role_assignments for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy user_role_assignments_api_insert on public.user_role_assignments for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy user_role_assignments_api_update on public.user_role_assignments for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy user_role_assignments_api_delete on public.user_role_assignments for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy scope_bindings_api_select on public.scope_bindings for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy scope_bindings_api_insert on public.scope_bindings for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy scope_bindings_api_update on public.scope_bindings for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy scope_bindings_api_delete on public.scope_bindings for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- Catálogo de permisos: sin tenant, de lectura para todos los actores.
create policy permissions_api_select on public.permissions for select to ladino_api
  using (true);

create policy branches_api_select on public.branches for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy branches_api_insert on public.branches for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy branches_api_update on public.branches for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy branches_api_delete on public.branches for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy warehouses_api_select on public.warehouses for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy warehouses_api_insert on public.warehouses for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy warehouses_api_update on public.warehouses for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy warehouses_api_delete on public.warehouses for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy cash_registers_api_select on public.cash_registers for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_registers_api_insert on public.cash_registers for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_registers_api_update on public.cash_registers for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_registers_api_delete on public.cash_registers for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- Append-only: solo INSERT (el trigger reject_mutation sigue cubriendo el resto).
create policy audit_events_api_select on public.audit_events for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy audit_events_api_insert on public.audit_events for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy outbox_api_select on public.outbox for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy outbox_api_insert on public.outbox for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- Idempotencia: tenant Y actor. El código ya filtraba por actor (H-2 de S0.5);
-- la policy lo escribe donde un grep lo encuentra.
create policy idempotency_keys_api_select on public.idempotency_keys for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids())
         and actor_id = platform.ladino_service_actor_id());
create policy idempotency_keys_api_insert on public.idempotency_keys for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids())
              and actor_id = platform.ladino_service_actor_id());
create policy idempotency_keys_api_update on public.idempotency_keys for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids())
              and actor_id = platform.ladino_service_actor_id())
  with check (tenant_id in (select platform.ladino_service_tenant_ids())
              and actor_id = platform.ladino_service_actor_id());

-- ── 5. Policies TO ladino_worker — todo lo que el GRANT le deja ──────────────
-- El worker trabaja para todos los tenants por definición (drena el outbox y
-- libera claves huérfanas). Su contención es el GRANT: dos tablas.
create policy outbox_worker_select on public.outbox for select to ladino_worker using (true);
create policy outbox_worker_update on public.outbox for update to ladino_worker
  using (true) with check (true);
create policy idempotency_keys_worker_select on public.idempotency_keys for select to ladino_worker
  using (true);
create policy idempotency_keys_worker_update on public.idempotency_keys for update to ladino_worker
  using (true) with check (true);
create policy idempotency_keys_worker_delete on public.idempotency_keys for delete to ladino_worker
  using (true);

-- ── 6. Lo que esta migración GARANTIZA sobre sí misma ───────────────────────
do $$
declare r record;
begin
  for r in select rolname, rolbypassrls, rolsuper from pg_roles
            where rolname in ('ladino_api', 'ladino_worker')
  loop
    if r.rolbypassrls or r.rolsuper then
      raise exception 'LAD32: el rol % tiene BYPASSRLS o SUPERUSER; la migración no cumple ADR-0031', r.rolname;
    end if;
  end loop;
  if (select count(*) from pg_roles where rolname in ('ladino_api', 'ladino_worker')) <> 2 then
    raise exception 'LAD32: faltan roles de servicio';
  end if;
end $$;
