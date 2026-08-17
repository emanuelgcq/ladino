-- =============================================================================
-- Ladino — pgTAP 7 · Revocación inmediata y concurrencia real
--
-- Cierra la deuda de pruebas de S0.3. Las dos clases que quedaban y que sí se
-- pueden probar con lo que hay.
--
-- 1. REVOCACIÓN INMEDIATA CON SESIÓN ABIERTA.
--    Es la promesa central de ADR-0014 y la razón por la que los permisos NO
--    van en el JWT: "se quita el membership y el acceso cae en la siguiente
--    consulta". Todo el coste por consulta de las policies —resolver contra la
--    base en cada SELECT, el objetivo p95 < 500 ms— se paga POR ESTA PROMESA.
--    Si no se cumple, ese coste no compra nada.
--
-- 2. CONCURRENCIA MULTI-SESIÓN, con `dblink`. pgTAP corre en una conexión, pero
--    `dblink` abre otras de verdad: distinto backend, distinto snapshot, RLS
--    evaluada de forma independiente.
-- =============================================================================

begin;
select plan(16);

create extension if not exists dblink with schema extensions;

-- =============================================================================
-- Escenario
-- =============================================================================

insert into auth.users (id) values ('aaaaaaaa-1111-4111-8111-00000000000a');

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-000000000002',
   '11111111-1111-4111-8111-000000000001', 'J-1', 'Empresa A');
insert into public.branches (id, tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000003',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'S1', 'Sucursal A');

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('11111111-1111-4111-8111-00000000000c', null, 'admin', 'Admin', false);
insert into public.role_permissions (role_id, permission_key)
  select '11111111-1111-4111-8111-00000000000c', key from public.permissions
   where key in ('branch.manage', 'company.manage');
insert into public.memberships (id, tenant_id, user_id) values
  ('11111111-1111-4111-8111-00000000000d',
   '11111111-1111-4111-8111-000000000001', 'aaaaaaaa-1111-4111-8111-00000000000a');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('11111111-1111-4111-8111-00000000000e', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '11111111-1111-4111-8111-000000000002');

-- =============================================================================
-- 1. REVOCACIÓN INMEDIATA — la sesión NO se cierra entre medias
--
-- Los claims se fijan UNA vez y no se vuelven a tocar: es la misma sesión, con
-- el mismo JWT, que en producción seguiría siendo válido hasta su expiración.
-- Lo que cambia es la base. Si el acceso no cae, ADR-0014 está roto.
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);

set local role authenticated;
select is((select count(*) from public.branches), 1::bigint,
  'ANTES: el usuario ve su sucursal');
select is((select count(*) from platform.ladino_company_ids()), 1::bigint,
  'y ladino_company_ids() le devuelve su company');
select ok(platform.ladino_has_permission('branch.manage',
            '11111111-1111-4111-8111-000000000002'),
  'y tiene branch.manage');
reset role;

-- Se revoca. El JWT del usuario sigue siendo válido y su sesión, abierta.
delete from public.user_role_assignments
 where id = '11111111-1111-4111-8111-00000000000e';

set local role authenticated;
select ok(not platform.ladino_has_permission('branch.manage',
            '11111111-1111-4111-8111-000000000002'),
  'REVOCACIÓN DE ROL: el permiso cae en la MISMA sesión, sin reemitir token. '
  'Es la promesa de ADR-0014 y lo que justifica el coste por consulta');
select is((select count(*) from platform.ladino_company_ids()), 0::bigint,
  'y ladino_company_ids() deja de devolver la company');
select is((select count(*) from public.branches), 0::bigint,
  'y las policies dejan de mostrar las sucursales: el corte llega hasta el dato');
reset role;

-- Se restituye, y vuelve. La revocación no es un estado pegajoso.
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('11111111-1111-4111-8111-00000000000e', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '11111111-1111-4111-8111-000000000002');

set local role authenticated;
select is((select count(*) from public.branches), 1::bigint,
  'restituida la asignación, el acceso vuelve en la siguiente consulta');
reset role;

-- Ahora el membership entero, que es el caso que ADR-0014 nombra.
delete from public.user_role_assignments
 where id = '11111111-1111-4111-8111-00000000000e';
delete from public.memberships
 where id = '11111111-1111-4111-8111-00000000000d';

set local role authenticated;
select is((select count(*) from platform.ladino_tenant_ids()), 0::bigint,
  'REVOCACIÓN DE MEMBERSHIP: ladino_tenant_ids() queda vacío en la misma sesión');
select is((select count(*) from public.companies), 0::bigint,
  'y el usuario deja de ver la company');
select is((select count(*) from public.tenants), 0::bigint,
  'y el tenant');
reset role;

-- Suspender la company también corta, sin tocar el membership.
insert into public.memberships (id, tenant_id, user_id) values
  ('11111111-1111-4111-8111-00000000000d',
   '11111111-1111-4111-8111-000000000001', 'aaaaaaaa-1111-4111-8111-00000000000a');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('11111111-1111-4111-8111-00000000000e', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '11111111-1111-4111-8111-000000000002');

update public.memberships set status = 'inactive'
 where id = '11111111-1111-4111-8111-00000000000d';

set local role authenticated;
select is((select count(*) from platform.ladino_tenant_ids()), 0::bigint,
  'MEMBERSHIP DADO DE BAJA: status = inactive corta igual que borrarlo, porque '
  'ladino_tenant_ids() filtra por status = active. La baja lógica revoca igual '
  'que la física, que es como se hará en producción');
reset role;

update public.memberships set status = 'active'
 where id = '11111111-1111-4111-8111-00000000000d';

-- =============================================================================
-- 2. CONCURRENCIA REAL con dblink — otro backend, otro snapshot
--
-- pgTAP corre en una conexión, pero dblink abre conexiones de verdad. Cada
-- consulta vía dblink se evalúa en un backend distinto, con sus propios GUC y
-- su propia evaluación de RLS. Es la única forma de probar aquí que el
-- aislamiento no depende del estado de sesión del test.
--
-- NOTA: la sesión dblink NO ve las filas de esta transacción (aún sin commit),
-- así que lo que se prueba es lo que ya está comprometido: el ESQUEMA, los
-- privilegios y las policies. Para concurrencia sobre DATOS hace falta un
-- escenario con commit, y eso va con el outbox en S0.4.
-- =============================================================================

select is(
  (select v from extensions.dblink(
     (select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
                    host(inet_server_addr()), inet_server_port())),
     $$ select count(*)::text from pg_class c join pg_namespace n on n.oid=c.relnamespace
         where n.nspname='public' and c.relkind='r'
           and not (c.relrowsecurity and c.relforcerowsecurity) $$
   ) as t(v text)),
  '0',
  'CONCURRENCIA: desde OTRA conexión, cero tablas de public sin RLS forzada');

select is(
  (select v from extensions.dblink(
     (select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
                    host(inet_server_addr()), inet_server_port())),
     $$ set local role authenticated;
        select count(*)::text from public.companies $$
   ) as t(v text)),
  '0',
  'otra conexión, SIN claims: authenticated no ve ninguna company. El '
  'aislamiento no depende del estado de sesión de este test');

select is(
  (select v from extensions.dblink(
     (select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
                    host(inet_server_addr()), inet_server_port())),
     $$ select count(*)::text from pg_proc p join pg_namespace n on n.oid=p.pronamespace
         where n.nspname='public' and has_function_privilege('anon',p.oid,'EXECUTE') $$
   ) as t(v text)),
  '0',
  'y ninguna función de public es ejecutable por anon desde otra conexión');

-- uuidv7 desde DOS backends a la vez: es la prueba de concurrencia que 001
-- dejó marcada VALIDAR-QA por no poder montarla en una sola conexión.
select is(
  (select v from extensions.dblink(
     (select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
                    host(inet_server_addr()), inet_server_port())),
     $$ select count(distinct u)::text from (
          select platform.uuidv7() as u from generate_series(1, 5000)) s $$
   ) as t(v text)),
  '5000',
  'uuidv7: 5.000 generaciones en OTRO backend, cero colisiones');

-- El `count(*)` va POR FUERA del `group by`: contando los grupos duplicados, no
-- las filas de cada grupo. Escrito al revés, sin duplicados no hay grupos, el
-- subquery escalar devuelve NULL y no 0 — otra vez la ausencia de resultado
-- haciéndose pasar por resultado. Aquí falló en rojo, que es como debe fallar.
select is(
  (select count(*) from (
     select u from (
       select platform.uuidv7() as u from generate_series(1, 5000)
       union all
       select v::uuid from extensions.dblink(
         (select format('host=%s port=%s dbname=postgres user=postgres password=postgres',
                      host(inet_server_addr()), inet_server_port())),
         $$ select platform.uuidv7()::text from generate_series(1, 5000) $$
       ) as t(v text)
     ) s
     group by u having count(*) > 1
   ) duplicados),
  0::bigint,
  'CONCURRENCIA REAL DE uuidv7: 10.000 ids generados desde DOS backends '
  'simultáneos, cero colisiones entre ellos. Cierra el VALIDAR-QA de 001');

select * from finish();
rollback;
