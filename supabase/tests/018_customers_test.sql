-- =============================================================================
-- Ladino — pgTAP 18 · Clientes (migración 18, ADR-0033)
--
-- Por encargo explícito, además de lo habitual:
--   · el RIF nullable con ÚNICO PARCIAL funcionando en las dos direcciones:
--     dos clientes sin RIF conviven; dos con el mismo RIF (mayúsculas,
--     minúsculas, espacios) no — y su roto: sin el índice, el duplicado entra;
--   · el cambio de RIF dejando EL VALOR ANTERIOR en audit_events, asertado por
--     el DATO (tax_id_anterior / tax_id_nuevo), no solo «hubo evento» — y su
--     roto: sin el trigger, el cambio no deja rastro;
--   · LAD36: con JWT y sin customer.tax_id.manage el cambio muere; con el
--     permiso, vive. Sin JWT (camino de servidor) responde la API.
-- =============================================================================

begin;
select plan(30);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0018-0000-4000-8000-0000000000a1'),   -- UA: customer.manage
  ('aaaa0018-0000-4000-8000-0000000000b1');   -- UB: customer.tax_id.manage
insert into public.tenants (id, name) values
  ('aaaa0018-0000-4000-8000-00000000000a', 'Tenant 18-A'),
  ('aaaa0018-0000-4000-8000-00000000000b', 'Tenant 18-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0018-0000-4000-8000-0000000000a2', 'aaaa0018-0000-4000-8000-00000000000a', 'J-18-A1', 'Empresa 18-A1'),
  ('aaaa0018-0000-4000-8000-0000000000b2', 'aaaa0018-0000-4000-8000-00000000000b', 'J-18-B1', 'Empresa 18-B1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0018-0000-4000-8000-0000000000e1', null, 'gestor18', 'Gestor', false),
  ('aaaa0018-0000-4000-8000-0000000000e2', null, 'rif18', 'RIF', false);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0018-0000-4000-8000-0000000000e1', 'customer.manage'),
  ('aaaa0018-0000-4000-8000-0000000000e2', 'customer.tax_id.manage');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0018-0000-4000-8000-0000000000a3', 'aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a1'),
  ('aaaa0018-0000-4000-8000-0000000000b3', 'aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000b1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0018-0000-4000-8000-0000000000a4', 'aaaa0018-0000-4000-8000-00000000000a',
   'aaaa0018-0000-4000-8000-0000000000a3', 'aaaa0018-0000-4000-8000-0000000000e1', null),
  ('aaaa0018-0000-4000-8000-0000000000b4', 'aaaa0018-0000-4000-8000-00000000000a',
   'aaaa0018-0000-4000-8000-0000000000b3', 'aaaa0018-0000-4000-8000-0000000000e2', null);
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('aaaa0018-0000-4000-8000-0000000000c1', 'aaaa0018-0000-4000-8000-00000000000a',
   'aaaa0018-0000-4000-8000-0000000000a2', 'PVP 18', 'VES'),
  ('aaaa0018-0000-4000-8000-0000000000c9', 'aaaa0018-0000-4000-8000-00000000000b',
   'aaaa0018-0000-4000-8000-0000000000b2', 'Lista de B', 'USD');
-- Un cliente del tenant B sembrado como postgres: invisible para A.
insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0018-0000-4000-8000-00000000000b', 'aaaa0018-0000-4000-8000-0000000000b2',
   'J-B-0001', 'Cliente de B', 'juridica', 'ordinario');

-- ── 1. Esquema y seeds ───────────────────────────────────────────────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname in ('taxpayer_types','person_types','customers')
      and c.relrowsecurity and c.relforcerowsecurity),
  3::bigint, 'las tres tablas nuevas tienen RLS habilitada y FORZADA');
-- Seis desde la migración 32: consumidor_final se sumó a los cinco de ADR-0033.
select is((select count(*) from public.taxpayer_types where status = 'active'), 6::bigint,
  'seed de taxpayer_types: el vocabulario aprobado (5 de ADR-0033 + consumidor_final), VALIDAR-TRIBUTARIO');
select is((select count(*) from public.person_types where status = 'active'), 4::bigint,
  'seed de person_types: cuatro');
select is(
  (select count(*) from public.permissions
    where key in ('customer.manage','customer.tax_id.manage','customer.block')),
  3::bigint, 'tres permisos: gestión, RIF y bloqueo, segregados (D-11)');

-- ── 2. Como ladino_api, actor UA ─────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0018-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'test-018', true);
set local role ladino_api;

select lives_ok(
  $$ insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code, default_price_list_id)
     values ('aaaa0018-0000-4000-8000-0000000000d1', 'aaaa0018-0000-4000-8000-00000000000a',
             'aaaa0018-0000-4000-8000-0000000000a2', 'J-12345678-9', 'Ferretería Ñandú C.A.',
             'juridica', 'ordinario', 'aaaa0018-0000-4000-8000-0000000000c1') $$,
  'alta con RIF, jurídica, ordinario y lista preferida: todo el camino vivo');

-- El único PARCIAL, con datos hostiles:
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             'j-12345678-9', 'Mismo RIF en minúsculas', 'juridica', 'ordinario') $$,
  '23505', null, 'el mismo RIF en minúsculas: DUPLICADO (único case-insensitive)');
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             ' J-12345678-9 ', 'Espacios al borde', 'juridica', 'ordinario') $$,
  '23514', null, 'espacios al borde: RECHAZADOS por CHECK, no recortados en silencio');
select lives_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             null, 'Consumidor final uno', 'natural', 'no_sujeto') $$,
  'persona natural SIN RIF: vive');
select lives_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             null, 'Consumidor final dos', 'natural', 'no_sujeto') $$,
  'y OTRA persona natural sin RIF también vive: el único es parcial');
select is(
  (select count(*) from public.customers
    where company_id = 'aaaa0018-0000-4000-8000-0000000000a2' and tax_id is null),
  2::bigint, 'dos clientes sin RIF conviven en la misma company');
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             null, 'Jurídica sin RIF', 'juridica', 'ordinario') $$,
  '23514', null, 'una persona JURÍDICA sin RIF es un error (D-2), no un dato');
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code, default_price_list_id)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             'J-55555555-5', 'Lista ajena', 'juridica', 'ordinario',
             'aaaa0018-0000-4000-8000-0000000000c9') $$,
  '23503', null, 'una lista de precios de OTRA company como preferida muere en el FK compuesto');
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             'J-66666666-6', 'Clasificación inventada', 'juridica', 'exento_especialisimo') $$,
  '23503', null, 'una clasificación fiscal fuera del catálogo muere en el FK');
select throws_ok(
  $$ insert into public.taxpayer_types (code, name, description) values ('nuevo', 'x', 'x') $$,
  '42501', null, 'los catálogos fiscales no se escriben desde la API: vocabulario por migración');
select is((select count(*) from public.customers where legal_name = 'Cliente de B'), 0::bigint,
  'el cliente del tenant B: invisible para el actor de A');
select throws_ok(
  $$ delete from public.customers where id = 'aaaa0018-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'DELETE no existe: un cliente se desactiva (PII incluida, D-12)');
-- Cambio de RIF por el camino de SERVIDOR (sin JWT): el permiso lo responde la
-- API; aquí lo que se prueba es que el rastro con el valor anterior existe.
select lives_ok(
  $$ update public.customers set tax_id = 'J-99999999-0'
      where id = 'aaaa0018-0000-4000-8000-0000000000d1' $$,
  'cambio de RIF por el camino de servidor: vive (el permiso lo exige el caso de uso)');
reset role;

select is(
  (select created_by from public.customers where id = 'aaaa0018-0000-4000-8000-0000000000d1'),
  'aaaa0018-0000-4000-8000-0000000000a1'::uuid, 'created_by = el actor del GUC');
select is(
  (select payload->>'tax_id' from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_established'),
  'J-12345678-9', 'el alta con RIF dejó customer.tax_id_established con el RIF inicial');
select is(
  (select payload->>'tax_id_anterior' from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_changed'),
  'J-12345678-9', 'EL VALOR ANTERIOR está en la auditoría: tax_id_anterior = el RIF de antes (dato, no «hubo evento»)');
select is(
  (select payload->>'tax_id_nuevo' from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_changed'),
  'J-99999999-0', 'y tax_id_nuevo = el RIF de después');
select is(
  (select rules_version from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_changed'),
  'test-018', 'la versión de reglas del caso de uso se respeta (no «db-guard» si el caso de uso la declaró)');

-- ── 3. LAD36: con JWT, el permiso se exige en el esquema ─────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaa0018-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select throws_ok(
  $$ update public.customers set tax_id = 'J-00000000-1'
      where id = 'aaaa0018-0000-4000-8000-0000000000d1' $$,
  'LAD36', null,
  'con JWT de UA (customer.manage, SIN customer.tax_id.manage): el cambio de RIF muere con LAD36');
select set_config('request.jwt.claims',
  '{"sub":"aaaa0018-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
select lives_ok(
  $$ update public.customers set tax_id = 'J-00000000-1'
      where id = 'aaaa0018-0000-4000-8000-0000000000d1' $$,
  'con JWT de UB (customer.tax_id.manage): vive — la segregación funciona en el esquema');
select is(
  (select payload->>'tax_id_anterior' from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_changed'
    order by occurred_at desc, id desc limit 1),
  'J-99999999-0', 'el segundo cambio también deja SU valor anterior');
select set_config('request.jwt.claims', '', true);

-- ── 4. authenticated lee, no escribe ─────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaa0018-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select cmp_ok((select count(*) from public.customers), '>=', 3::bigint,
  'authenticated LEE los clientes de sus companies');
select throws_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             'J-11111111-1', 'Colado por PostgREST', 'juridica', 'ordinario') $$,
  '42501', null, 'authenticated NO escribe maestros: los datos van por la API');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 5. VARIANTES ROTAS ───────────────────────────────────────────────────────
-- 5a. Sin el índice parcial, el RIF duplicado ENTRA.
drop index public.customers_company_tax_id_uidx;
set local role ladino_api;
select lives_ok(
  $$ insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
     values ('aaaa0018-0000-4000-8000-00000000000a', 'aaaa0018-0000-4000-8000-0000000000a2',
             'j-00000000-1', 'ROTO: duplicado', 'juridica', 'ordinario') $$,
  'ROTO: sin el índice parcial, el RIF duplicado entra — la aserción de arriba mide el índice');
reset role;

-- 5b. Sin el trigger, el cambio de RIF NO deja rastro.
drop trigger customers_audit_tax_id on public.customers;
select lives_ok(
  $$ update public.customers set tax_id = 'J-77777777-7'
      where id = 'aaaa0018-0000-4000-8000-0000000000d1' $$,
  'ROTO: sin el trigger el cambio vive…');
select is(
  (select count(*) from public.audit_events
    where aggregate_id = 'aaaa0018-0000-4000-8000-0000000000d1' and event_type = 'customer.tax_id_changed'),
  2::bigint,
  '…y NO deja rastro (siguen dos eventos): las aserciones del valor anterior miden el trigger');

select * from finish();
rollback;
