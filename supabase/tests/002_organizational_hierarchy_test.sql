-- =============================================================================
-- Ladino — pgTAP 2/4 · Jerarquía organizacional
--
-- Cubre `create_organizational_hierarchy`: las cinco tablas, sus anclas de
-- aislamiento, las FK compuestas y el estado de RLS.
--
-- Todavía NO hay policies (llegan en 4/4), así que lo que se prueba aquí es el
-- ESTADO SEGURO INTERMEDIO: RLS habilitada y forzada, y por tanto nadie sin
-- BYPASSRLS ve nada. Denegar por defecto y abrir después, nunca al revés.
-- =============================================================================

begin;
select plan(35);

-- =============================================================================
-- Las cinco tablas existen con la forma acordada
-- =============================================================================

select has_table('public', 'tenants',        'existe public.tenants');
select has_table('public', 'companies',      'existe public.companies');
select has_table('public', 'branches',       'existe public.branches');
select has_table('public', 'warehouses',     'existe public.warehouses');
select has_table('public', 'cash_registers',
  'la tabla de cajas se llama cash_registers, no registers: gana el contrato ya '
  'publicado en COMPANIES_BRANCHES_WAREHOUSES_SPEC.md (ADR-0025 §1)');

-- =============================================================================
-- Anclas de aislamiento — la tabla de ADR-0025 §2, comprobada columna a columna
-- =============================================================================

select col_not_null('public', 'companies',      'tenant_id',  'companies.tenant_id NOT NULL');
select col_not_null('public', 'branches',       'tenant_id',  'branches.tenant_id NOT NULL');
select col_not_null('public', 'branches',       'company_id', 'branches.company_id NOT NULL');
select col_not_null('public', 'warehouses',     'tenant_id',  'warehouses.tenant_id NOT NULL');
select col_not_null('public', 'warehouses',     'company_id', 'warehouses.company_id NOT NULL');
select col_not_null('public', 'cash_registers', 'tenant_id',  'cash_registers.tenant_id NOT NULL');
select col_not_null('public', 'cash_registers', 'company_id', 'cash_registers.company_id NOT NULL');

-- El texto de la spec dice que un almacén PUEDE pertenecer a una sucursal; el
-- ERD lo dibujaba obligatorio. Gana el texto (ADR-0025 §1): un almacén central
-- que sirve a varias sucursales es una operación normal.
select col_is_null('public', 'warehouses', 'branch_id',
  'warehouses.branch_id es NULLABLE: el almacén central no cuelga de ninguna sucursal');

-- Las cajas sí cuelgan de una sucursal. Relajarlo después es compatible;
-- apretarlo después, no.
select col_not_null('public', 'cash_registers', 'branch_id',
  'cash_registers.branch_id NOT NULL: una caja está siempre en una sucursal');

-- =============================================================================
-- PK con platform.uuidv7() — la ordenación temporal es el motivo de usar v7
-- =============================================================================

select col_is_pk('public', 'tenants',        'id', 'tenants.id es PK');
select col_is_pk('public', 'companies',      'id', 'companies.id es PK');
select col_is_pk('public', 'branches',       'id', 'branches.id es PK');
select col_is_pk('public', 'warehouses',     'id', 'warehouses.id es PK');
select col_is_pk('public', 'cash_registers', 'id', 'cash_registers.id es PK');

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and table_name in ('tenants','companies','branches','warehouses','cash_registers')
      and column_name = 'id'
      and column_default <> 'platform.uuidv7()'),
  0::bigint,
  'las cinco PK usan DEFAULT platform.uuidv7(), no gen_random_uuid()');

-- =============================================================================
-- FK compuestas — ADR-0025 §9.1
--
-- Es lo que impide que un tenant_id denormalizado mal copiado convierta el
-- ancla de aislamiento en mentira. Sin esto, una fila con el company_id de A y
-- el tenant_id de B satisface la policy de B y expone datos de A, y ninguna
-- prueba de aislamiento lo encontraría porque prueban el mecanismo, no los datos.
-- =============================================================================

insert into public.tenants (id, name)
values ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
       ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name)
values ('11111111-1111-4111-8111-000000000002',
        '11111111-1111-4111-8111-000000000001', 'J-000000001', 'Empresa A'),
       ('22222222-2222-4222-8222-000000000002',
        '22222222-2222-4222-8222-000000000001', 'J-000000002', 'Empresa B');

select lives_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002', 'OK', 'Coherente') $$,
  'una sucursal con tenant_id y company_id coherentes se inserta');

select throws_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name)
     values ('22222222-2222-4222-8222-000000000001',
             '11111111-1111-4111-8111-000000000002', 'MIX', 'Mezclada') $$,
  '23503'::char(5), null::text,
  'la FK compuesta rechaza un tenant_id que no corresponde a esa company: el '
  'ancla de aislamiento no se puede falsear');

select throws_ok(
  $$ insert into public.warehouses (tenant_id, company_id, code, name)
     values ('22222222-2222-4222-8222-000000000001',
             '11111111-1111-4111-8111-000000000002', 'MIX', 'Almacén mezclado') $$,
  '23503'::char(5), null::text,
  'lo mismo en warehouses');

-- =============================================================================
-- Estados enumerados con CHECK — viven en el esquema, no solo en TypeScript
-- =============================================================================

select throws_ok(
  $$ insert into public.companies (tenant_id, tax_id, legal_name, status)
     values ('11111111-1111-4111-8111-000000000001', 'J-9', 'Mala', 'inventado') $$,
  '23514'::char(5), null::text,
  'companies.status rechaza un estado fuera del enumerado (CHECK, no solo TS)');

select throws_ok(
  $$ insert into public.branches (tenant_id, company_id, code, name, status)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-000000000002', 'X', 'Mala', 'inventado') $$,
  '23514'::char(5), null::text,
  'branches.status rechaza un estado fuera del enumerado');

-- =============================================================================
-- ON DELETE RESTRICT por defecto — la jerarquía no se borra en cascada
-- =============================================================================

select throws_ok(
  $$ delete from public.companies
      where id = '11111111-1111-4111-8111-000000000002' $$,
  '23503'::char(5), null::text,
  'no se puede borrar una company con sucursales: ON DELETE RESTRICT, sin '
  'cascadas silenciosas hacia abajo');

select throws_ok(
  $$ delete from public.tenants
      where id = '11111111-1111-4111-8111-000000000001' $$,
  '23503'::char(5), null::text,
  'no se puede borrar un tenant con companies');

-- =============================================================================
-- RLS habilitada Y FORZADA en las cinco
-- =============================================================================

select is(
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('tenants','companies','branches','warehouses','cash_registers')
      and c.relrowsecurity),
  5::bigint,
  'las cinco tablas tienen ENABLE ROW LEVEL SECURITY');

select is(
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('tenants','companies','branches','warehouses','cash_registers')
      and c.relforcerowsecurity),
  5::bigint,
  'las cinco tienen FORCE ROW LEVEL SECURITY: la RLS aplica también al dueño');

-- NOTA: la primera versión de este fichero aseveraba "todavía no hay policies",
-- cierto cuando 2/4 era la última migración. Dejó de serlo al llegar 4/4.
--
-- Los tests pgTAP corren contra el esquema FINAL, no contra el estado que había
-- cuando se escribió su migración. Aseverar un estado intermedio es aseverar
-- algo que caduca. Lo que se comprueba aquí es la propiedad DURADERA: RLS
-- habilitada y forzada. Quién puede qué es materia de 004.
select ok(
  (select count(*) from pg_policy p
     join pg_class c on c.oid = p.polrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('tenants','companies','branches','warehouses','cash_registers')) > 0,
  'las cinco tablas ya tienen policies: las trae 4/4');

-- =============================================================================
-- Índices de §7 — creados con la tabla, no cuando duela
-- =============================================================================

select has_index('public', 'branches',       'branches_tenant_company_idx',       'índice (tenant_id, company_id) en branches');
select has_index('public', 'warehouses',     'warehouses_tenant_company_idx',     'índice (tenant_id, company_id) en warehouses');
select has_index('public', 'cash_registers', 'cash_registers_tenant_company_idx', 'índice (tenant_id, company_id) en cash_registers');
select has_index('public', 'companies',      'companies_tenant_status_idx',       'índice (tenant_id, status) en companies');
select has_index('public', 'branches',       'branches_company_created_idx',      'índice (company_id, created_at desc) en branches');

select * from finish();
rollback;
