-- =============================================================================
-- Ladino — pgTAP 6/6 · Cierre de la segunda auditoría
--
-- Los cuatro defectos que cubre eran **de la migración 5/5**, no de las
-- anteriores: arreglar una fuga introdujo otras tres. Por eso cada uno tiene
-- test propio y no una nota.
-- =============================================================================

begin;
select plan(20);

-- =============================================================================
-- ALTO-1 — el trigger de ancla faltaba en `roles` y `role_permissions`
-- =============================================================================

-- La propiedad, no la lista: TODA tabla de public con tenant_id tiene el
-- trigger. Enumerar tablas caduca; esta consulta cubre también las de S0.4.
select is(
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and exists (select 1 from information_schema.columns col
                   where col.table_schema = 'public' and col.table_name = c.relname
                     and col.column_name = 'tenant_id')
      and not exists (select 1 from pg_trigger t
                       where t.tgrelid = c.oid and t.tgname like '%anchors_immutable')),
  0::bigint,
  'TODA tabla de public con tenant_id tiene trigger de ancla. roles y '
  'role_permissions se quedaron fuera en 5/5, y la cadena que abría concedía '
  'permisos de un tenant dentro de otro');

insert into auth.users (id) values ('dddddddd-4444-4444-8444-00000000000d');
insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'A'),
  ('22222222-2222-4222-8222-000000000001', 'B');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('22222222-2222-4222-8222-00000000000c', '22222222-2222-4222-8222-000000000001',
   'rol_de_b', 'Rol de B', false);

set local role service_role;
select throws_ok(
  $$ update public.roles set tenant_id = '11111111-1111-4111-8111-000000000001'
      where id = '22222222-2222-4222-8222-00000000000c' $$,
  'LAD28'::char(5), null::text,
  'ni service_role puede mover un rol de tenant: A concedería permisos que '
  'surten efecto DENTRO de B');

select throws_ok(
  $$ update public.roles set tenant_id = null
      where id = '22222222-2222-4222-8222-00000000000c' $$,
  'LAD28'::char(5), null::text,
  'ni convertirlo en rol de sistema: tenant_id es NULLABLE y `is distinct from` '
  'trata bien el NULL');
reset role;

-- =============================================================================
-- ALTO-2 — el revoke que parecía proteger y no protegía
--
-- 5/5 revocaba de `anon, authenticated`. El EXECUTE por defecto lo tiene
-- PUBLIC, así que era un no-op: una función nueva en `public` seguía siendo
-- ejecutable por anon.
-- =============================================================================

-- EL DETECTOR. No impide crear una función expuesta —no hay forma: Postgres
-- ignora `alter default privileges ... revoke execute on functions from public`
-- y la crea igual con el default de fábrica—. Lo que hace es que CI falle.
--
-- Es deliberadamente una propiedad sobre el catálogo y no una lista de nombres:
-- así cubre también las funciones que traiga S0.4 sin tener que actualizarlo.
select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0::bigint,
  'DETECTOR: ninguna función de public es ejecutable por anon. Si esto falla, '
  'alguien creó una RPC en public sin revocar: va en platform, o lleva su '
  'REVOKE EXECUTE ... FROM PUBLIC explícito');

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0::bigint,
  'ni por authenticated');

-- Y se deja constancia de POR QUÉ hace falta un detector y no una config: si
-- algún día Postgres empezara a respetar el default para funciones, esta
-- aserción fallaría y sabríamos que el detector ya no es necesario.
create function public._ladino_test_rpc() returns int language sql as $$ select 1 $$;
select ok(has_function_privilege('anon', 'public._ladino_test_rpc()', 'EXECUTE'),
  'CONSTANCIA: una función nueva en public SIGUE naciendo ejecutable por anon '
  'pese al alter default privileges. Por eso la defensa es la regla (RPC en '
  'platform) más este detector, y no una configuración');
drop function public._ladino_test_rpc();

-- =============================================================================
-- ALTO-3 — la defensa que cerraba el único camino autorizado
--
-- El fallo era peor que un permiso mal puesto: NO fallaba. La fila se escribía
-- con created_by NULL y el vacío aparecía en una auditoría meses después.
-- =============================================================================

-- La company va primero: user_role_assignments tiene FK compuesta
-- (tenant_id, company_id) -> companies, así que el orden importa.
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-000000000002',
   '11111111-1111-4111-8111-000000000001', 'J-1', 'Empresa A');

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('11111111-1111-4111-8111-00000000000c', null, 'admin', 'Admin', false);
insert into public.role_permissions (role_id, permission_key)
  select '11111111-1111-4111-8111-00000000000c', key from public.permissions
   where key in ('branch.manage', 'company.manage');
insert into public.memberships (id, tenant_id, user_id) values
  ('11111111-1111-4111-8111-00000000000d',
   '11111111-1111-4111-8111-000000000001', 'dddddddd-4444-4444-8444-00000000000d');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('11111111-1111-4111-8111-00000000000e', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '11111111-1111-4111-8111-000000000002');

-- VÍA 1 — camino servidor CON el GUC fijado, que es el contrato de S0.5.
set local role service_role;
set local ladino.actor_id = 'dddddddd-4444-4444-8444-00000000000d';
insert into public.branches (id, tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000003',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'CON', 'Con GUC');
reset role;

select is(
  (select created_by from public.branches where code = 'CON'),
  'dddddddd-4444-4444-8444-00000000000d'::uuid,
  'CONTRATO S0.5: con `set local ladino.actor_id` fijado, el camino servidor '
  'SÍ registra el actor aunque auth.uid() sea NULL');

-- El GUC no lo controla el cliente: viene del JWT verificado, no del payload.
select ok(
  (select created_by from public.branches where code = 'CON') is not null,
  'y por tanto la regla 3 de CLAUDE.md es satisfacible por el camino servidor, '
  'que es el ÚNICO por el que se crean tenants, companies y el bloque RBAC');

-- VÍA 2 — camino servidor SIN el GUC: el modo de fallo que hay que conocer.
set local role service_role;
set local ladino.actor_id = '';
insert into public.branches (id, tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000004',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'SIN', 'Sin GUC');
reset role;

select ok(
  (select created_by from public.branches where code = 'SIN') is null,
  'SIN el GUC la fila se escribe igual y created_by queda NULL. NO HAY ERROR: '
  'este es el modo de fallo que el contrato de API_SPEC.md §Procedencia existe '
  'para evitar, y por eso se verifica en el test de integración de S0.5');

-- Y el GUC no abre una vía de forja: en el camino `authenticated`, auth.uid()
-- gana porque va primero en el coalesce.
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-4444-4444-8444-00000000000d","role":"authenticated"}', true);
set local role authenticated;
set local ladino.actor_id = '99999999-9999-4999-8999-999999999999';
insert into public.branches (tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'AUTH', 'Desde authenticated');
reset role;

select is(
  (select created_by from public.branches where code = 'AUTH'),
  'dddddddd-4444-4444-8444-00000000000d'::uuid,
  'con sesión de usuario, auth.uid() GANA al GUC: el coalesce lo pone primero, '
  'así que el GUC no sirve para suplantar a nadie');

-- =============================================================================
-- MEDIO-2 — `create or replace` es un reemplazo completo
-- =============================================================================

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proconfig is null),
  0::bigint,
  'las DOCE funciones de platform tienen search_path fijado. reject_mutation lo '
  'perdió en 5/5 porque `create or replace` no conserva proconfig: reemplaza '
  'la función entera, incluida su configuración');

select is(
  (select array_to_string(p.proconfig, ',') from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proname = 'reject_mutation'),
  'search_path=""',
  'reject_mutation recuperó su search_path');

-- =============================================================================
-- No hay regresión: lo de 5/5 sigue en pie
-- =============================================================================

set local role service_role;
select throws_ok(
  $$ update public.branches set tenant_id = '22222222-2222-4222-8222-000000000001'
      where code = 'CON' $$,
  'LAD28'::char(5), null::text,
  'el ancla de la jerarquía sigue cerrada');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"dddddddd-4444-4444-8444-00000000000d","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ update public.branches set tenant_id = '22222222-2222-4222-8222-000000000001'
      where code = 'CON' $$,
  '42501'::char(5), null::text,
  'y el GRANT por columna también');
reset role;

-- El camino legítimo no se rompió. Una defensa que impide trabajar no sirve.
select set_config('request.jwt.claims',
  '{"sub":"dddddddd-4444-4444-8444-00000000000d","role":"authenticated"}', true);
set local role authenticated;

select lives_ok(
  $$ update public.branches set name = 'Renombrada', status = 'inactive'
      where code = 'CON' $$,
  'CAMINO FELIZ: renombrar y cambiar estado siguen funcionando');
select lives_ok(
  $$ update public.companies set legal_name = 'Empresa A, C.A.'
      where id = '11111111-1111-4111-8111-000000000002' $$,
  'y editar la razón social de la propia company');
select lives_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002', 'NUEVA', 'Nueva sucursal') $$,
  'y crear sucursales');
select lives_ok(
  $$ delete from public.branches where code = 'NUEVA' $$,
  'y borrarlas');

reset role;

select is(
  (select version from public.branches where code = 'CON'),
  2::bigint,
  'y version avanzó de 1 a 2 con el UPDATE, sin que el cliente la tocara');

select is(
  (select created_by from public.branches where code = 'CON'),
  'dddddddd-4444-4444-8444-00000000000d'::uuid,
  'y el autor original sobrevivió al UPDATE');

select * from finish();
rollback;
