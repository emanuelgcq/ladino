-- =============================================================================
-- Ladino — pgTAP 60 · EL DEPÓSITO PRINCIPAL Y EL ALCANCE DEL DUEÑO (migración 60)
--
--   1. default_warehouse: sin ajuste, el ACTIVO más antiguo — un depósito nuevo
--      cuyo código ordena antes («A0») NO le quita el puesto al que nació primero;
--   2. con ajuste, el elegido; si el elegido se desactiva, vuelve al más antiguo;
--   3. VARIANTE ROTA: el dueño sin binding al depósito nuevo no tiene el verbo
--      acotado ahí (el 403 del QA); bind_owner_warehouse_scope lo ata;
--   4. es idempotente (la segunda llamada no inserta nada);
--   5. no ata a quien NO es dueño: un warehouse_ops invitado sin owner sigue sin
--      binding al depósito nuevo.
-- =============================================================================

begin;
select plan(9);

insert into auth.users (id, email) values
  ('aaaa0060-0000-4000-8000-0000000000a1', 'duena60@ejemplo.com'),
  ('aaaa0060-0000-4000-8000-0000000000a2', 'almacen60@ejemplo.com');

select platform.bootstrap_tenant('aaaa0060-0000-4000-8000-0000000000a1', 'Bodega 60');

insert into public.companies (id, tenant_id, tax_id, legal_name)
select 'aaaa0060-0000-4000-8000-0000000000c1', t.id, 'J-60-A', 'Empresa 60'
  from public.tenants t where t.name = 'Bodega 60';

-- El depósito que nace con la empresa, y su binding (lo que hace el alta).
insert into public.warehouses (id, tenant_id, company_id, code, name, created_at)
select 'aaaa0060-0000-4000-8000-0000000000b1', t.id, 'aaaa0060-0000-4000-8000-0000000000c1',
       'W1', 'Principal', now() - interval '1 day'
  from public.tenants t where t.name = 'Bodega 60';
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
select ura.tenant_id, 'aaaa0060-0000-4000-8000-0000000000c1', ura.id, 'warehouse',
       'aaaa0060-0000-4000-8000-0000000000b1'
  from public.user_role_assignments ura
  join public.memberships m on m.id = ura.membership_id
  join public.roles r on r.id = ura.role_id
 where m.user_id = 'aaaa0060-0000-4000-8000-0000000000a1' and r.key = 'warehouse_ops';

-- El segundo depósito, con un código que ordena ANTES que W1.
insert into public.warehouses (id, tenant_id, company_id, code, name)
select 'aaaa0060-0000-4000-8000-0000000000b2', t.id, 'aaaa0060-0000-4000-8000-0000000000c1',
       'A0', 'Trasero'
  from public.tenants t where t.name = 'Bodega 60';

select is(
  platform.default_warehouse('aaaa0060-0000-4000-8000-0000000000c1'),
  'aaaa0060-0000-4000-8000-0000000000b1'::uuid,
  'sin ajuste, el principal es el activo más antiguo: el nuevo «A0» no le quita el puesto');

insert into public.company_settings (company_id, tenant_id, default_warehouse_id)
select 'aaaa0060-0000-4000-8000-0000000000c1', t.id, 'aaaa0060-0000-4000-8000-0000000000b2'
  from public.tenants t where t.name = 'Bodega 60';

select is(
  platform.default_warehouse('aaaa0060-0000-4000-8000-0000000000c1'),
  'aaaa0060-0000-4000-8000-0000000000b2'::uuid,
  'con ajuste, el principal es el elegido');

update public.warehouses set status = 'inactive'
 where id = 'aaaa0060-0000-4000-8000-0000000000b2';

select is(
  platform.default_warehouse('aaaa0060-0000-4000-8000-0000000000c1'),
  'aaaa0060-0000-4000-8000-0000000000b1'::uuid,
  'si el elegido se desactiva, el principal vuelve al activo más antiguo');

update public.warehouses set status = 'active'
 where id = 'aaaa0060-0000-4000-8000-0000000000b2';

-- ── VARIANTE ROTA: sin binding al depósito nuevo, el dueño no tiene el verbo ahí
select ok(
  not platform.ladino_user_has_scope('aaaa0060-0000-4000-8000-0000000000a1',
    'inventory.move', 'warehouse', 'aaaa0060-0000-4000-8000-0000000000b2'),
  'VARIANTE ROTA: sin binding, el dueño no puede mover mercancía en el depósito nuevo');

-- Un invitado con warehouse_ops (sin owner), atado solo a W1.
insert into public.memberships (id, tenant_id, user_id, status)
select 'aaaa0060-0000-4000-8000-0000000000d2', t.id, 'aaaa0060-0000-4000-8000-0000000000a2', 'active'
  from public.tenants t where t.name = 'Bodega 60';
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'aaaa0060-0000-4000-8000-0000000000e2', t.id, 'aaaa0060-0000-4000-8000-0000000000d2',
       r.id, 'aaaa0060-0000-4000-8000-0000000000c1'
  from public.tenants t, public.roles r
 where t.name = 'Bodega 60' and r.key = 'warehouse_ops' and r.tenant_id is null;
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
select t.id, 'aaaa0060-0000-4000-8000-0000000000c1', 'aaaa0060-0000-4000-8000-0000000000e2',
       'warehouse', 'aaaa0060-0000-4000-8000-0000000000b1'
  from public.tenants t where t.name = 'Bodega 60';

select is(
  platform.bind_owner_warehouse_scope('aaaa0060-0000-4000-8000-0000000000c1'),
  1, 'ata al dueño con el único depósito que le faltaba');

select ok(
  platform.ladino_user_has_scope('aaaa0060-0000-4000-8000-0000000000a1',
    'inventory.move', 'warehouse', 'aaaa0060-0000-4000-8000-0000000000b2'),
  'con el binding, el dueño mueve mercancía en el depósito nuevo');
select ok(
  platform.ladino_user_has_scope('aaaa0060-0000-4000-8000-0000000000a1',
    'purchase.receive', 'warehouse', 'aaaa0060-0000-4000-8000-0000000000b2'),
  'y recibe compras en él');

select is(
  platform.bind_owner_warehouse_scope('aaaa0060-0000-4000-8000-0000000000c1'),
  0, 'idempotente: la segunda llamada no inserta nada');

select ok(
  not platform.ladino_user_has_scope('aaaa0060-0000-4000-8000-0000000000a2',
    'inventory.move', 'warehouse', 'aaaa0060-0000-4000-8000-0000000000b2'),
  'no ata a quien no es dueño: el invitado de almacén sigue sin el depósito nuevo');

select * from finish();
rollback;
