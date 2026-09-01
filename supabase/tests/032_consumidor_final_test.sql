-- =============================================================================
-- Ladino — pgTAP 32 · CONSUMIDOR FINAL (migración 32)
--
-- Rigor normal, con un punto de rigor máximo: el cliente de sistema es la
-- contraparte de TODA venta de mostrador. Si alguien lo borra, lo renombra o
-- lo desactiva, la pantalla de Vender se queda sin cliente por defecto. Esto
-- prueba que está congelado, que hay a lo sumo UNO por empresa, y que el
-- vocabulario fiscal nuevo dice la verdad (consumidor_final, no un
-- «ordinario» de mentira para que cuadre con las reglas de la demo).
-- =============================================================================

begin;
select plan(8);

insert into public.tenants (id, name) values
  ('aaaa0032-0000-4000-8000-00000000000a', 'Tenant 32');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0032-0000-4000-8000-0000000000a2', 'aaaa0032-0000-4000-8000-00000000000a',
   'J-32-A', 'Empresa 32', 'ordinario');

-- ── 1. El vocabulario dice la verdad ────────────────────────────────────────
select is(
  (select count(*) from public.taxpayer_types where code = 'consumidor_final'),
  1::bigint,
  'consumidor_final existe como taxpayer_type: le aplican las reglas GENERALES, no las de ordinario');

-- ── 2. El alta (lo que hará createCompany): natural, sin RIF, de sistema ────
select lives_ok($$
  insert into public.customers
    (id, tenant_id, company_id, legal_name, person_type_code, taxpayer_type_code, is_system)
  values ('aaaa0032-0000-4000-8000-00000000c001', 'aaaa0032-0000-4000-8000-00000000000a',
          'aaaa0032-0000-4000-8000-0000000000a2', 'Consumidor final', 'natural',
          'consumidor_final', true)
$$, 'Consumidor final entra como persona natural sin RIF: exactamente el caso que D-2 permite');
select throws_ok($$
  insert into public.customers
    (tenant_id, company_id, legal_name, person_type_code, taxpayer_type_code, is_system)
  values ('aaaa0032-0000-4000-8000-00000000000a', 'aaaa0032-0000-4000-8000-0000000000a2',
          'Otro consumidor', 'natural', 'consumidor_final', true)
$$, '23505', null,
  'DOS clientes de sistema en la misma empresa: imposible — el carrito no sabría a cuál apuntar');

-- ── 3. Congelado por trigger, no por convención ─────────────────────────────
select throws_ok($$
  update public.customers set legal_name = 'Cliente mostrador'
   where id = 'aaaa0032-0000-4000-8000-00000000c001'
$$, 'LAD06', null, 'no se renombra: media UI lo busca por lo que es');
select throws_ok($$
  update public.customers set status = 'inactive'
   where id = 'aaaa0032-0000-4000-8000-00000000c001'
$$, 'LAD06', null, 'no se desactiva: la venta de mostrador se quedaría sin contraparte');
select throws_ok($$
  delete from public.customers where id = 'aaaa0032-0000-4000-8000-00000000c001'
$$, 'LAD06', null, 'y no se borra');

-- ── 4. Y el guard no muerde a los clientes normales ─────────────────────────
insert into public.customers
  (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0032-0000-4000-8000-00000000c002', 'aaaa0032-0000-4000-8000-00000000000a',
   'aaaa0032-0000-4000-8000-0000000000a2', 'J-CLI-32', 'Cliente Normal, C.A.',
   'juridica', 'ordinario');
select lives_ok($$
  update public.customers set legal_name = 'Cliente Normal renombrado, C.A.'
   where id = 'aaaa0032-0000-4000-8000-00000000c002'
$$, 'un cliente normal se sigue editando igual que siempre');
select throws_ok($$
  update public.customers set is_system = true
   where id = 'aaaa0032-0000-4000-8000-00000000c002'
$$, 'LAD06', null,
  'pero no asciende a sistema: el único camino a is_system es el alta de empresa o la migración');

select * from finish();
rollback;
