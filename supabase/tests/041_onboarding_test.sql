-- =============================================================================
-- Ladino — pgTAP 41 · Onboarding y miembros (migración 41, ADR-0049)
--
-- Lo que esto prueba:
--   1. bootstrap_tenant crea tenant + membresía + las DOS asignaciones del
--      fundador (owner plano, warehouse_ops acotado);
--   2. el guard de un-negocio-por-usuario: fundar dos veces rechaza (LAD81),
--      y un nombre vacío ni empieza (LAD80);
--   3. el owner plano concede TODO lo no acotado sin binding; los 8 verbos de
--      almacén llegan por warehouse_ops SOLO con su binding — el fallo por
--      omisión sigue cerrado;
--   4. user_id_by_email encuentra por correo (insensible a mayúsculas) y
--      responde NULL a lo que no existe.
-- =============================================================================

begin;
select plan(10);

insert into auth.users (id, email) values
  ('aaaa0041-0000-4000-8000-0000000000a1', 'Fundador@Ejemplo.com');

-- ── 1. El bootstrap ──────────────────────────────────────────────────────────
select lives_ok(
  $$select platform.bootstrap_tenant('aaaa0041-0000-4000-8000-0000000000a1', 'Bodega Fundada')$$,
  'el fundador nace: tenant, membresía y sus dos asignaciones en un solo acto');

select is(
  (select count(*) from public.memberships m
    join public.tenants t on t.id = m.tenant_id
   where m.user_id = 'aaaa0041-0000-4000-8000-0000000000a1'
     and t.name = 'Bodega Fundada' and m.status = 'active'),
  1::bigint, 'la membresía existe, activa, en el tenant recién nacido');

select is(
  (select count(*) from public.user_role_assignments ura
    join public.memberships m on m.id = ura.membership_id
    join public.roles r on r.id = ura.role_id
   where m.user_id = 'aaaa0041-0000-4000-8000-0000000000a1'
     and ura.company_id is null
     and r.key in ('owner', 'warehouse_ops')),
  2::bigint, 'las DOS asignaciones del fundador, a nivel tenant');

-- ── 2. Los guards ────────────────────────────────────────────────────────────
select throws_ok(
  $$select platform.bootstrap_tenant('aaaa0041-0000-4000-8000-0000000000a1', 'Otra Bodega')$$,
  'LAD81', null,
  'fundar dos veces RECHAZA: la segunda empresa va dentro del tenant, no en otro');
select throws_ok(
  $$select platform.bootstrap_tenant('aaaa0041-0000-4000-8000-0000000000a1', ' ')$$,
  'LAD80', null, 'un negocio sin nombre ni empieza');

-- ── 3. Plano concede sin binding; acotado solo con él ───────────────────────
insert into public.companies (id, tenant_id, tax_id, legal_name)
select 'aaaa0041-0000-4000-8000-0000000000c1', t.id, 'J-41-A', 'Empresa 41'
  from public.tenants t where t.name = 'Bodega Fundada';

select ok(
  platform.ladino_user_has_permission('aaaa0041-0000-4000-8000-0000000000a1',
    'company.manage', 'aaaa0041-0000-4000-8000-0000000000c1'),
  'el owner PLANO concede lo de nivel empresa/tenant sin binding: puede crear y configurar');
select ok(
  not platform.ladino_user_has_permission('aaaa0041-0000-4000-8000-0000000000a1',
    'inventory.move', 'aaaa0041-0000-4000-8000-0000000000c1'),
  'los verbos de almacén NO llegan sin binding: el fallo por omisión sigue cerrado');

insert into public.warehouses (id, tenant_id, company_id, code, name)
select 'aaaa0041-0000-4000-8000-00000000f0b1', t.id,
       'aaaa0041-0000-4000-8000-0000000000c1', 'W41', 'Principal'
  from public.tenants t where t.name = 'Bodega Fundada';
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
select ura.tenant_id, 'aaaa0041-0000-4000-8000-0000000000c1', ura.id, 'warehouse',
       'aaaa0041-0000-4000-8000-00000000f0b1'
  from public.user_role_assignments ura
  join public.memberships m on m.id = ura.membership_id
  join public.roles r on r.id = ura.role_id
 where m.user_id = 'aaaa0041-0000-4000-8000-0000000000a1' and r.key = 'warehouse_ops';

select ok(
  platform.ladino_user_has_permission('aaaa0041-0000-4000-8000-0000000000a1',
    'inventory.move', 'aaaa0041-0000-4000-8000-0000000000c1'),
  'con el binding del almacén, warehouse_ops concede los verbos: el par del fundador está completo');

-- ── 4. El correo ─────────────────────────────────────────────────────────────
select is(
  platform.user_id_by_email('  fundador@ejemplo.COM '),
  'aaaa0041-0000-4000-8000-0000000000a1'::uuid,
  'user_id_by_email encuentra sin importar mayúsculas ni espacios');
select is(
  platform.user_id_by_email('nadie@ejemplo.com'), null,
  'y responde NULL a quien no existe — sin filtrar nada más de auth');

select * from finish();
rollback;
