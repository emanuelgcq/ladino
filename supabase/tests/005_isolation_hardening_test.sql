-- =============================================================================
-- Ladino — pgTAP 5/5 · Los ataques que los otros cuatro ficheros NO probaban
--
-- Existe por un hueco de fondo, no por un bug puntual: **ningún test tenía un
-- usuario con membership en DOS tenants.** Probábamos A↔A y B↔B y llamábamos
-- a eso aislamiento.
--
-- El atacante realista de un sistema multi-tenant no es un extraño: es el
-- usuario legítimo de ambos lados. Y es literalmente el caso central del
-- producto — la firma contable que lleva veinte clientes, con la que ADR-0014
-- justifica el modelo entero.
--
-- Los cuatro huecos que cierra:
--   1. usuario multi-tenant
--   2. UPDATE de las propias anclas (tenant_id / company_id)
--   3. escritura tabla por tabla, no solo en branches
--   4. TRUNCATE y la ACL de una tabla recién creada
-- =============================================================================

begin;
select plan(30);

-- =============================================================================
-- Escenario: D es miembro de A y de B. B2 solo de B.
-- =============================================================================

insert into auth.users (id) values
  ('dddddddd-4444-4444-8444-00000000000d'),
  ('bbbbbbbb-2222-4222-8222-00000000000b');

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
  ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-000000000002',
   '11111111-1111-4111-8111-000000000001', 'J-1', 'Empresa A'),
  ('22222222-2222-4222-8222-000000000002',
   '22222222-2222-4222-8222-000000000001', 'J-2', 'Empresa B');

insert into public.branches (id, tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000003',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'SEC', 'SECRETO DE A');

insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('11111111-1111-4111-8111-000000000005',
   '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-000000000002', 'ALM', 'ALMACEN SECRETO DE A');

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('11111111-1111-4111-8111-00000000000c', null, 'admin', 'Admin', false);
insert into public.role_permissions (role_id, permission_key)
  select '11111111-1111-4111-8111-00000000000c', key from public.permissions
   where key in ('branch.manage', 'warehouse.manage', 'company.manage');

-- D: membership en LOS DOS tenants. Este es el usuario que faltaba.
insert into public.memberships (id, tenant_id, user_id) values
  ('11111111-1111-4111-8111-00000000000d',
   '11111111-1111-4111-8111-000000000001', 'dddddddd-4444-4444-8444-00000000000d'),
  ('22222222-2222-4222-8222-00000000000d',
   '22222222-2222-4222-8222-000000000001', 'dddddddd-4444-4444-8444-00000000000d');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('11111111-1111-4111-8111-00000000000e', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '11111111-1111-4111-8111-000000000002'),
  ('22222222-2222-4222-8222-00000000000e', '22222222-2222-4222-8222-000000000001',
   '22222222-2222-4222-8222-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '22222222-2222-4222-8222-000000000002');

-- B2: solo tenant B. Nunca tuvo ni tendrá acceso a A.
insert into public.memberships (id, tenant_id, user_id) values
  ('33333333-3333-4333-8333-00000000000d',
   '22222222-2222-4222-8222-000000000001', 'bbbbbbbb-2222-4222-8222-00000000000b');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('33333333-3333-4333-8333-00000000000e', '22222222-2222-4222-8222-000000000001',
   '33333333-3333-4333-8333-00000000000d', '11111111-1111-4111-8111-00000000000c',
   '22222222-2222-4222-8222-000000000002');

-- =============================================================================
-- HUECO 1 y 2 — el usuario multi-tenant intenta trasladar una fila
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"dddddddd-4444-4444-8444-00000000000d","role":"authenticated"}', true);
set local role authenticated;

-- D ve legítimamente los dos tenants. No es un intruso.
select is((select count(*) from platform.ladino_tenant_ids()), 2::bigint,
  'D es miembro legítimo de DOS tenants: el caso central del producto');
select is((select count(*) from public.companies), 2::bigint,
  'y ve las dos companies, correctamente');

-- PRIMERA CAPA: el GRANT por columna. Ni siquiera puede nombrar tenant_id.
select throws_ok(
  $$ update public.branches
        set tenant_id = '22222222-2222-4222-8222-000000000001'
      where id = '11111111-1111-4111-8111-000000000003' $$,
  '42501'::char(5), null::text,
  'CAPA 1: authenticated no tiene UPDATE sobre la columna tenant_id — el GRANT '
  'por columna corta antes de llegar a la policy');

select throws_ok(
  $$ update public.branches
        set company_id = '22222222-2222-4222-8222-000000000002'
      where id = '11111111-1111-4111-8111-000000000003' $$,
  '42501'::char(5), null::text,
  'ni sobre company_id');

select throws_ok(
  $$ update public.companies
        set tenant_id = '22222222-2222-4222-8222-000000000001'
      where id = '11111111-1111-4111-8111-000000000002' $$,
  '42501'::char(5), null::text,
  'ni sobre companies.tenant_id: la empresa no cambia de tenant');

-- Lo que sí puede: editar los datos de negocio de su propia fila.
select lives_ok(
  $$ update public.branches set name = 'Renombrada por D'
      where id = '11111111-1111-4111-8111-000000000003' $$,
  'D sí puede renombrar su propia sucursal: se cierra el ancla, no la tabla');

reset role;

-- SEGUNDA CAPA: el trigger, que sí alcanza a service_role.
set local role service_role;
select throws_ok(
  $$ update public.branches
        set tenant_id = '22222222-2222-4222-8222-000000000001',
            company_id = '22222222-2222-4222-8222-000000000002'
      where id = '11111111-1111-4111-8111-000000000003' $$,
  'LAD28'::char(5), null::text,
  'CAPA 2: ni siquiera service_role puede reetiquetar el tenant. El GRANT por '
  'columna no lo contiene (BYPASSRLS); el trigger sí');

select throws_ok(
  $$ update public.warehouses
        set tenant_id = '22222222-2222-4222-8222-000000000001',
            company_id = '22222222-2222-4222-8222-000000000002'
      where id = '11111111-1111-4111-8111-000000000005' $$,
  'LAD28'::char(5), null::text,
  'lo mismo en warehouses');

select throws_ok(
  $$ update public.memberships
        set tenant_id = '11111111-1111-4111-8111-000000000001'
      where id = '33333333-3333-4333-8333-00000000000d' $$,
  'LAD28'::char(5), null::text,
  'y en memberships: mover un membership de tenant sería regalar acceso');
reset role;

-- LA PRUEBA DE FONDO: B2 sigue sin ver nada de A.
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.branches), 0::bigint,
  'B2 no ve NINGUNA sucursal de A. Antes de 5/5 veía "SECRETO DE A" tras el '
  'traslado: era una fuga real entre tenants');
select is((select count(*) from public.warehouses), 0::bigint,
  'ni almacenes');
select is((select count(*) from public.companies), 1::bigint,
  'y sigue viendo solo su propia company');
reset role;

-- =============================================================================
-- HUECO 3 — escritura tabla por tabla, no solo en branches
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-00000000000b","role":"authenticated"}', true);
set local role authenticated;

select throws_ok(
  $$ insert into public.warehouses (tenant_id, company_id, code, name)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002', 'X', 'De B en A') $$,
  '42501'::char(5), null::text,
  'B2 no puede crear un almacén en la company de A');

select throws_ok(
  $$ insert into public.cash_registers (tenant_id, company_id, branch_id, code, name)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002',
             '11111111-1111-4111-8111-000000000003', 'X', 'De B en A') $$,
  '42501'::char(5), null::text,
  'ni una caja');

-- UPDATE y DELETE ajenos: no lanzan, afectan cero filas. Se comprueba el DATO.
update public.warehouses set name = 'SECUESTRADO'
 where id = '11111111-1111-4111-8111-000000000005';
delete from public.warehouses where id = '11111111-1111-4111-8111-000000000005';
update public.companies set legal_name = 'SECUESTRADA'
 where id = '11111111-1111-4111-8111-000000000002';
reset role;

select is(
  (select name from public.warehouses where id = '11111111-1111-4111-8111-000000000005'),
  'ALMACEN SECRETO DE A',
  'el almacén de A conserva su nombre pese al UPDATE de B2');
select is(
  (select count(*) from public.warehouses where id = '11111111-1111-4111-8111-000000000005'),
  1::bigint,
  'y sigue existiendo pese al DELETE de B2');
select is(
  (select legal_name from public.companies where id = '11111111-1111-4111-8111-000000000002'),
  'Empresa A',
  'la company de A conserva su razón social');

-- =============================================================================
-- HUECO 4 — TRUNCATE y la ACL de una tabla recién creada
-- =============================================================================

select ok(not has_table_privilege('anon', 'public.companies', 'TRUNCATE'),
  'anon no puede TRUNCATE companies');
select ok(not has_table_privilege('authenticated', 'public.companies', 'TRUNCATE'),
  'authenticated tampoco: TRUNCATE ignora la RLS por diseño');
select ok(not has_table_privilege('authenticated', 'public.branches', 'TRUNCATE'),
  'ni branches');

-- Lo que de verdad importa: una tabla NUEVA no nace con TRUNCATE concedido.
-- Es la superficie que crece — en S0.4 llegan audit_events y journal_lines.
create table public._ladino_test_nueva (id uuid primary key default platform.uuidv7());

select ok(not has_table_privilege('anon', 'public._ladino_test_nueva', 'TRUNCATE'),
  'una tabla RECIÉN CREADA no concede TRUNCATE a anon: el ALTER DEFAULT '
  'PRIVILEGES está revocado, no hay que acordarse tabla por tabla');
select ok(not has_table_privilege('authenticated', 'public._ladino_test_nueva', 'TRUNCATE'),
  'ni a authenticated');
select ok(not has_table_privilege('authenticated', 'public._ladino_test_nueva', 'SELECT'),
  'ni SELECT: por defecto, nada');

-- Y reject_mutation() ahora cubre TRUNCATE.
create table public._ladino_test_append (id uuid primary key default platform.uuidv7(), n int);
create trigger _t_immutable
  before update or delete on public._ladino_test_append
  for each row execute function platform.reject_mutation();
create trigger _t_immutable_truncate
  before truncate on public._ladino_test_append
  for each statement execute function platform.reject_mutation();
grant select, insert, update, delete, truncate on public._ladino_test_append to service_role;
insert into public._ladino_test_append (n) values (1);

set local role service_role;
select throws_ok(
  $$ truncate public._ladino_test_append $$,
  'LAD06'::char(5), null::text,
  'TRUNCATE sobre una append-only lanza LAD06 incluso como service_role. Antes '
  'de 5/5, TRUNCATE ignoraba la RLS Y no disparaba el trigger, que era BEFORE '
  'UPDATE OR DELETE: la segunda capa de ADR-0006 tenía un hueco');
reset role;

-- =============================================================================
-- Procedencia de fila no forjable (regla 3 de CLAUDE.md)
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"dddddddd-4444-4444-8444-00000000000d","role":"authenticated"}', true);
set local role authenticated;

insert into public.branches (tenant_id, company_id, code, name, created_by, created_at, version)
values ('11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-000000000002', 'FORJ', 'Forjada',
        'bbbbbbbb-2222-4222-8222-00000000000b',  -- autor ajeno
        '1999-01-01T00:00:00Z',                  -- antedatada
        999);                                    -- versión inventada
reset role;

select is(
  (select created_by from public.branches where code = 'FORJ'),
  'dddddddd-4444-4444-8444-00000000000d'::uuid,
  'created_by es SIEMPRE auth.uid(), no lo que el cliente diga: un autor que el '
  'propio actor elige no es un autor (regla 3 de CLAUDE.md)');

select ok(
  (select created_at from public.branches where code = 'FORJ') > '2020-01-01'::timestamptz,
  'created_at es el reloj del servidor: no se puede antedatar una fila');

select is(
  (select version from public.branches where code = 'FORJ'),
  1::bigint,
  'version arranca en 1, no en lo que el cliente mande');

-- Y en UPDATE la procedencia del origen no se puede reescribir.
set local role service_role;
update public.branches set name = 'Editada', created_by = null, created_at = '1999-01-01T00:00:00Z'
 where code = 'FORJ';
reset role;

select is(
  (select created_by from public.branches where code = 'FORJ'),
  'dddddddd-4444-4444-8444-00000000000d'::uuid,
  'un UPDATE no puede borrar ni reescribir el autor original');
select is(
  (select version from public.branches where code = 'FORJ'),
  2::bigint,
  'version solo avanza: el UPDATE la llevó de 1 a 2');

-- =============================================================================
-- Higiene de las funciones de trigger
-- =============================================================================

select is(
  (select count(*) from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform'
      and p.proname <> 'uuidv7'
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0::bigint,
  'ninguna función de platform es ejecutable por anon (salvo uuidv7, que lo '
  'exigen los DEFAULT — y anon tampoco tiene USAGE sobre el esquema)');

select * from finish();
rollback;
