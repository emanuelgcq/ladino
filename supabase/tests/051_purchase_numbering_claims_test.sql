-- =============================================================================
-- Ladino — pgTAP 51 · NUMERACIÓN DE ÓRDENES Y RECEPCIONES (migración 51, M-16)
--
-- Las dos funciones de reclamación existen, son definer con search_path
-- vacío, solo la API las ejecuta, empiezan en 1, no reutilizan huecos y la
-- unicidad por empresa sigue estando en la tabla (el candado serializa; el
-- índice es la última defensa).
-- =============================================================================

begin;
select plan(10);

select has_function('platform', 'claim_purchase_order_number', array['uuid'],
  'claim_purchase_order_number(uuid) existe');
select has_function('platform', 'claim_goods_receipt_number', array['uuid'],
  'claim_goods_receipt_number(uuid) existe');
select is_definer('platform', 'claim_purchase_order_number', array['uuid'], 'es security definer');
select is_definer('platform', 'claim_goods_receipt_number', array['uuid'], 'es security definer');
select ok(not has_function_privilege('anon', 'platform.claim_purchase_order_number(uuid)', 'execute'),
  'anon no puede reclamar números de orden');
select ok(has_function_privilege('ladino_api', 'platform.claim_goods_receipt_number(uuid)', 'execute'),
  'la API sí puede reclamar números de recepción');

insert into public.tenants (id, name) values ('aaaa0051-0000-4000-8000-00000000000a', 'Tenant 51');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0051-0000-4000-8000-0000000000a2', 'aaaa0051-0000-4000-8000-00000000000a',
   'J-51-A', 'Empresa 51', 'ordinario');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0051-0000-4000-8000-00000000ff01', 'aaaa0051-0000-4000-8000-00000000000a',
   'aaaa0051-0000-4000-8000-0000000000a2', 'W1', 'Principal');
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0051-0000-4000-8000-00000000ba01', 'aaaa0051-0000-4000-8000-00000000000a',
   'aaaa0051-0000-4000-8000-0000000000a2', 'J-PROV-51', 'Proveedor 51', 'nacional',
   'juridica', 'ordinario');

select is(platform.claim_purchase_order_number('aaaa0051-0000-4000-8000-0000000000a2'), 1::bigint,
  'la primera orden de la empresa es la 1');

insert into public.purchase_orders
  (id, tenant_id, company_id, supplier_id, warehouse_id, status, order_number, ordered_at,
   transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0051-0000-4000-8000-00000000d001', 'aaaa0051-0000-4000-8000-00000000000a',
        'aaaa0051-0000-4000-8000-0000000000a2', 'aaaa0051-0000-4000-8000-00000000ba01',
        'aaaa0051-0000-4000-8000-00000000ff01', 'pending',
        platform.claim_purchase_order_number('aaaa0051-0000-4000-8000-0000000000a2'),
        now(), 'VES', 'VES', 1, 'identidad');
update public.purchase_orders set status = 'cancelled'
 where id = 'aaaa0051-0000-4000-8000-00000000d001';
select is(platform.claim_purchase_order_number('aaaa0051-0000-4000-8000-0000000000a2'), 2::bigint,
  'la siguiente es la 2: el número de una orden cancelada no se reutiliza');

select throws_ok($$
  insert into public.purchase_orders
    (tenant_id, company_id, supplier_id, warehouse_id, status, order_number, ordered_at,
     transaction_currency, functional_currency, fx_rate, rate_source)
  values ('aaaa0051-0000-4000-8000-00000000000a', 'aaaa0051-0000-4000-8000-0000000000a2',
          'aaaa0051-0000-4000-8000-00000000ba01', 'aaaa0051-0000-4000-8000-00000000ff01',
          'pending', 1, now(), 'VES', 'VES', 1, 'identidad')
$$, '23505', null, 'y el índice único sigue rechazando un número repetido en la misma empresa');

select is(platform.claim_goods_receipt_number('aaaa0051-0000-4000-8000-0000000000a2'), 1::bigint,
  'la primera recepción de la empresa es la 1');

select * from finish();
rollback;
