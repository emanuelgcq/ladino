-- =============================================================================
-- Ladino — pgTAP 77 · EL DUEÑO INVITADO OPERA SUS ALMACENES (migración 20260928100000)
--
--   1. VARIANTE ROTA: un owner acotado a una empresa, sin warehouse_ops, NO tiene
--      inventory.move en el almacén de su empresa (el rol owner no lo trae);
--   2. la función le da warehouse_ops acotado y el binding al almacén: ahora sí;
--   3. es idempotente (la segunda llamada no crea nada);
--   4. no toca al fundador (warehouse_ops de nivel tenant) ni a un rol que no es owner;
--   5. deja su rastro en audit_events;
--   6. authenticated no la puede ejecutar (42501).
-- =============================================================================

begin;
select plan(9);

insert into auth.users (id, email) values
  ('aaaa0077-0000-4000-8000-0000000000a1', 'fundador77@ejemplo.com'),
  ('aaaa0077-0000-4000-8000-0000000000a2', 'duenoinvitado77@ejemplo.com'),
  ('aaaa0077-0000-4000-8000-0000000000a3', 'cajero77@ejemplo.com');

select platform.bootstrap_tenant('aaaa0077-0000-4000-8000-0000000000a1', 'Bodega 77');

insert into public.companies (id, tenant_id, tax_id, legal_name)
select 'aaaa0077-0000-4000-8000-0000000000c1', t.id, 'J-77-A', 'Empresa 77'
  from public.tenants t where t.name = 'Bodega 77';

insert into public.warehouses (id, tenant_id, company_id, code, name)
select 'aaaa0077-0000-4000-8000-0000000000b1', t.id, 'aaaa0077-0000-4000-8000-0000000000c1',
       'W1', 'Principal'
  from public.tenants t where t.name = 'Bodega 77';

-- El Dueño invitado y el cajero, como los dejaba `addMember` antes de ADR-0068: la asignación
-- ACOTADA a la empresa, sin warehouse_ops.
insert into public.memberships (id, tenant_id, user_id)
select v.id, t.id, v.usuario
  from public.tenants t,
       (values ('aaaa0077-0000-4000-8000-0000000000d2'::uuid,
                'aaaa0077-0000-4000-8000-0000000000a2'::uuid),
               ('aaaa0077-0000-4000-8000-0000000000d3'::uuid,
                'aaaa0077-0000-4000-8000-0000000000a3'::uuid)) as v(id, usuario)
 where t.name = 'Bodega 77';
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select t.id, v.membresia, r.id, 'aaaa0077-0000-4000-8000-0000000000c1'
  from public.tenants t,
       (values ('aaaa0077-0000-4000-8000-0000000000d2'::uuid, 'owner'),
               ('aaaa0077-0000-4000-8000-0000000000d3'::uuid, 'cashier')) as v(membresia, rol)
  join public.roles r on r.key = v.rol and r.tenant_id is null
 where t.name = 'Bodega 77';

select ok(
  not platform.ladino_user_has_scope('aaaa0077-0000-4000-8000-0000000000a2', 'inventory.move',
                                     'warehouse', 'aaaa0077-0000-4000-8000-0000000000b1'),
  'VARIANTE ROTA: el owner acotado sin warehouse_ops no mueve mercancía en su almacén');

select is(platform.grant_invited_owner_warehouse_ops() >= 1, true,
  'la función da warehouse_ops al Dueño invitado');

select ok(
  platform.ladino_user_has_scope('aaaa0077-0000-4000-8000-0000000000a2', 'inventory.move',
                                 'warehouse', 'aaaa0077-0000-4000-8000-0000000000b1'),
  'con warehouse_ops acotado y su binding, el Dueño invitado mueve mercancía en su almacén');

select is(
  (select ura.company_id from public.user_role_assignments ura
     join public.roles r on r.id = ura.role_id and r.key = 'warehouse_ops'
    where ura.membership_id = 'aaaa0077-0000-4000-8000-0000000000d2'),
  'aaaa0077-0000-4000-8000-0000000000c1'::uuid,
  'la asignación nueva es ACOTADA a la empresa, no de nivel tenant');

select is(platform.grant_invited_owner_warehouse_ops(), 0,
  'idempotente: la segunda llamada no crea nada');

select is(
  (select count(*)::int from public.user_role_assignments ura
     join public.memberships m on m.id = ura.membership_id
     join public.roles r on r.id = ura.role_id and r.key = 'warehouse_ops'
    where m.user_id = 'aaaa0077-0000-4000-8000-0000000000a1'),
  1,
  'al fundador (warehouse_ops de nivel tenant) no se le añade otro');

select is(
  (select count(*)::int from public.user_role_assignments ura
     join public.roles r on r.id = ura.role_id and r.key = 'warehouse_ops'
    where ura.membership_id = 'aaaa0077-0000-4000-8000-0000000000d3'),
  0,
  'un rol que no es owner (cajero acotado) no recibe warehouse_ops');

select is(
  (select count(*)::int from public.audit_events
    where aggregate_id = 'aaaa0077-0000-4000-8000-0000000000d2'
      and event_type = 'member.role_assigned' and actor_type = 'system'
      and payload->>'origin' = '20260928100000' and payload->>'role_key' = 'warehouse_ops'),
  1,
  'la asignación deja su rastro en audit_events');

set local role authenticated;
select throws_ok($$ select platform.grant_invited_owner_warehouse_ops() $$, '42501', null,
  'authenticated no puede ejecutar la función');
reset role;

select * from finish();
rollback;
