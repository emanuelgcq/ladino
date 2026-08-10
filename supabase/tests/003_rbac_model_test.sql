-- =============================================================================
-- Ladino — pgTAP 3/4 · Modelo RBAC y alcance por recurso
--
-- Cubre `create_rbac_model`: las seis tablas, las cuatro funciones
-- platform.ladino_*, los tres constraint triggers y el catálogo de permisos.
--
-- Lo que MÁS importa de este fichero son tres tests: el invariante de
-- requires_scope en sus TRES flancos. El tercero —reclasificar un permiso— es
-- el que se escapa si no se piensa, porque esa transacción no toca ni `roles`
-- ni `role_permissions`.
-- =============================================================================

begin;
select plan(32);

-- =============================================================================
-- Forma del catálogo global — las dos excepciones declaradas (ADR-0025 §9.2)
-- =============================================================================

select hasnt_column('public', 'permissions', 'tenant_id',
  'permissions NO lleva tenant_id: es vocabulario del sistema, no dato de nadie. '
  'Excepción declarada a la regla genérica (ADR-0025 §3)');

select col_is_pk('public', 'permissions', 'key',
  'la PK de permissions es la key textual, no un uuid: un catálogo cerrado que '
  'se referencia por nombre no gana nada con un identificador opaco');

select col_not_null('public', 'permissions', 'is_scoped',
  'permissions.is_scoped NOT NULL: clasificar es obligatorio, no opcional');

select col_not_null('public', 'roles', 'requires_scope',
  'roles.requires_scope NOT NULL y SIN DEFAULT: crear un rol obliga a decidir');

select col_is_null('public', 'roles', 'tenant_id',
  'roles.tenant_id NULLABLE: null = rol de sistema, con valor = rol del tenant');

select ok((select count(*) from public.permissions) >= 20,
  'el catálogo de permisos viene poblado por la migración');

select ok((select count(*) from public.permissions where is_scoped) > 0,
  'al menos un permiso está marcado como acotado: si ninguno lo estuviera, el '
  'invariante de requires_scope no protegería nada');

-- =============================================================================
-- Las cuatro funciones de alcance (ADR-0025 §5)
-- =============================================================================

select has_function('platform', 'ladino_tenant_ids',   'existe platform.ladino_tenant_ids()');
select has_function('platform', 'ladino_company_ids',  'existe platform.ladino_company_ids()');
select has_function('platform', 'ladino_has_permission', array['text','uuid'],
  'existe platform.ladino_has_permission(text, uuid)');
select has_function('platform', 'ladino_has_scope', array['text','text','uuid'],
  'existe platform.ladino_has_scope(text, text, uuid)');

-- Ninguna en `auth`: ese esquema es de GoTrue y las migraciones no pueden
-- escribir en él. Fue lo que tumbó la versión monolítica (ADR-0025 §5).
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'auth' and p.proname like 'ladino%'),
  0::bigint,
  'ninguna función ladino_* vive en el esquema auth: no es nuestro');

-- STABLE, no VOLATILE: una VOLATILE se evalúa POR FILA siempre, y la
-- diferencia frente al objetivo p95 < 500 ms es de tres órdenes de magnitud.
select is(
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proname like 'ladino_%'
      and (p.provolatile <> 's' or not p.prosecdef)),
  0::bigint,
  'las cuatro ladino_* son STABLE y SECURITY DEFINER (ADR-0025 §5 y §7)');

-- search_path fijado NO basta: EXECUTE se concede a PUBLIC por defecto, y una
-- función que lee memberships por debajo de la RLS y puede llamarse sin
-- autenticar es una fuga de la estructura organizativa completa.
select ok(not has_function_privilege('anon', 'platform.ladino_tenant_ids()', 'EXECUTE'),
  'anon NO puede ejecutar platform.ladino_tenant_ids()');
select ok(not has_function_privilege('anon', 'platform.ladino_company_ids()', 'EXECUTE'),
  'anon NO puede ejecutar platform.ladino_company_ids()');
select ok(not has_function_privilege('anon', 'platform.ladino_has_permission(text, uuid)', 'EXECUTE'),
  'anon NO puede ejecutar platform.ladino_has_permission()');
select ok(not has_function_privilege('anon', 'platform.ladino_has_scope(text, text, uuid)', 'EXECUTE'),
  'anon NO puede ejecutar platform.ladino_has_scope()');
select ok(has_function_privilege('authenticated', 'platform.ladino_company_ids()', 'EXECUTE'),
  'authenticated SÍ puede ejecutarlas');

-- El helper polimórfico no se expone: solo lo invocan otras SECURITY DEFINER.
select ok(
  not has_function_privilege('authenticated', 'platform.resource_company_id(text, uuid)', 'EXECUTE'),
  'platform.resource_company_id() no es invocable por authenticated');

-- =============================================================================
-- Datos de trabajo
-- =============================================================================

insert into public.tenants (id, name)
values ('11111111-1111-4111-8111-000000000001', 'Tenant A');

insert into public.companies (id, tenant_id, tax_id, legal_name)
values ('11111111-1111-4111-8111-000000000002',
        '11111111-1111-4111-8111-000000000001', 'J-000000001', 'Empresa A');

insert into public.branches (id, tenant_id, company_id, code, name)
values ('11111111-1111-4111-8111-000000000003',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000002', 'S1', 'Sucursal 1');

insert into public.cash_registers (id, tenant_id, company_id, branch_id, code, name)
values ('11111111-1111-4111-8111-000000000004',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000002',
        '11111111-1111-4111-8111-000000000003', 'C1', 'Caja 1');

-- Un rol acotado y uno company-wide. La distinción es la columna, no el nombre.
insert into public.roles (id, tenant_id, key, name, requires_scope)
values ('11111111-1111-4111-8111-00000000000b', null, 'cajero',        'Cajero',        true),
       ('11111111-1111-4111-8111-00000000000c', null, 'company_admin', 'Admin empresa', false);

-- =============================================================================
-- EL INVARIANTE, EN SUS TRES FLANCOS (ADR-0025 §4)
--
-- Los constraint triggers son DIFERIDOS para que poblar el catálogo por
-- migración no dependa del orden de los INSERT. Para provocarlos dentro de un
-- test se fuerzan a inmediatos.
-- =============================================================================

set constraints all immediate;

-- Flanco 1 — conceder un permiso acotado a un rol company-wide.
select throws_ok(
  $$ insert into public.role_permissions (role_id, permission_key)
     select '11111111-1111-4111-8111-00000000000c', key
       from public.permissions where is_scoped limit 1 $$,
  'LAD25'::char(5), null::text,
  'FLANCO 1: conceder un permiso is_scoped a un rol requires_scope=false '
  'hace fallar la transacción');

-- El mismo permiso al rol acotado sí entra.
select lives_ok(
  $$ insert into public.role_permissions (role_id, permission_key)
     select '11111111-1111-4111-8111-00000000000b', key
       from public.permissions where is_scoped limit 1 $$,
  'el mismo permiso concedido al rol acotado se acepta');

-- Flanco 2 — pasar a false un rol que ya tiene permisos acotados.
select throws_ok(
  $$ update public.roles set requires_scope = false
      where id = '11111111-1111-4111-8111-00000000000b' $$,
  'LAD25'::char(5), null::text,
  'FLANCO 2: quitarle requires_scope a un rol que ya tiene permisos acotados '
  'hace fallar la transacción');

-- Flanco 3 — reclasificar un permiso que roles company-wide ya tienen.
-- ES EL QUE SE ESCAPA: esta transacción no toca ni roles ni role_permissions.
insert into public.role_permissions (role_id, permission_key)
select '11111111-1111-4111-8111-00000000000c', key
  from public.permissions where not is_scoped limit 1;

select throws_ok(
  $$ update public.permissions set is_scoped = true
      where key = (select permission_key from public.role_permissions
                    where role_id = '11111111-1111-4111-8111-00000000000c' limit 1) $$,
  'LAD25'::char(5), null::text,
  'FLANCO 3: marcar is_scoped en un permiso que un rol company-wide ya tiene '
  'hace fallar la transacción, aunque no se toque roles ni role_permissions');

-- =============================================================================
-- scope_bindings — la FK que la forma polimórfica no permite, hecha a mano
-- =============================================================================

-- memberships.user_id tiene FK real a auth.users, así que el usuario tiene que
-- existir de verdad. Es deliberado: un membership huérfano sería un alcance
-- concedido a nadie, y `ON DELETE RESTRICT` impide que borrar un usuario deje
-- permisos colgando.
insert into auth.users (id) values ('11111111-1111-4111-8111-00000000000a');

insert into public.memberships (id, tenant_id, user_id)
values ('11111111-1111-4111-8111-00000000000d',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-00000000000a');

insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
values ('11111111-1111-4111-8111-00000000000e',
        '11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-00000000000d',
        '11111111-1111-4111-8111-00000000000b',
        '11111111-1111-4111-8111-000000000002');

select lives_ok(
  $$ insert into public.scope_bindings
       (tenant_id, company_id, assignment_id, scope_type, scope_id)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002',
             '11111111-1111-4111-8111-00000000000e',
             'cash_register', '11111111-1111-4111-8111-000000000004') $$,
  'un binding a una caja real de la misma company se acepta');

select throws_ok(
  $$ insert into public.scope_bindings
       (tenant_id, company_id, assignment_id, scope_type, scope_id)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002',
             '11111111-1111-4111-8111-00000000000e',
             'cash_register', '99999999-9999-4999-8999-999999999999') $$,
  'LAD26'::char(5), null::text,
  'un scope_id inexistente se rechaza: es lo que sustituye a la FK real que la '
  'forma polimórfica no permite (ADR-0025 §9.1)');

select throws_ok(
  $$ insert into public.scope_bindings
       (tenant_id, company_id, assignment_id, scope_type, scope_id)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002',
             '11111111-1111-4111-8111-00000000000e',
             'inventado', '11111111-1111-4111-8111-000000000004') $$,
  'LAD26'::char(5), null::text,
  'scope_type fuera del enumerado se rechaza: hay DOS defensas (el CHECK de la columna y el trigger de destino) y gana el trigger, porque los BEFORE ROW corren antes de que Postgres evalúe los CHECK');

-- ON DELETE RESTRICT replicado a mano: la FK polimórfica no lo da gratis.
select throws_ok(
  $$ delete from public.cash_registers
      where id = '11111111-1111-4111-8111-000000000004' $$,
  '23503'::char(5), null::text,
  'no se puede borrar una caja con bindings: el trigger replica el ON DELETE '
  'RESTRICT que la FK polimórfica no puede dar');

-- =============================================================================
-- RLS en las seis, sin policies todavía
-- =============================================================================

select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('memberships','roles','permissions','role_permissions',
                        'user_role_assignments','scope_bindings')
      and c.relrowsecurity and c.relforcerowsecurity),
  6::bigint,
  'las seis tablas del RBAC tienen ENABLE y FORCE row level security');

-- Las policies llegan en 4/4 y los tests corren contra el esquema FINAL, así
-- que aquí ya existen. Lo duradero es que `permissions` no acepte escritura:
-- el catálogo se puebla por migración, nunca por API.
select is(
  (select count(*) from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relname = 'permissions' and p.polcmd in ('a','w','d')),
  0::bigint,
  'permissions no tiene NINGUNA policy de escritura: el catálogo se puebla por '
  'migración (ADR-0025 §3)');

-- =============================================================================
-- Índices que sostienen el p95 de ADR-0014
-- =============================================================================

select has_index('public', 'memberships', 'memberships_user_tenant_idx',
  'índice (user_id, tenant_id): lo recorre ladino_tenant_ids() en cada policy');
select has_index('public', 'user_role_assignments',
  'user_role_assignments_membership_company_idx',
  'índice (membership_id, company_id): lo recorre ladino_company_ids()');
select has_index('public', 'scope_bindings', 'scope_bindings_scope_idx',
  'índice de scope_bindings: lo recorre ladino_has_scope()');

select * from finish();
rollback;
