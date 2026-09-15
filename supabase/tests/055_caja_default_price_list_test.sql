-- =============================================================================
-- Ladino — pgTAP 55 · LA CAJA DE LAS EMPRESAS EXISTENTES (migración 55)
--
-- `platform.assign_caja_default_price_list` repara la empresa cuya caja no
-- vende nada porque el alta escribió en una lista y la caja lee en otra:
--   1-2. forma «Pollos y víveres paola»: «detal» VES vacía + «detal USD» con el
--        precio → la predeterminada pasa a «detal USD», con acta;
--   3.   forma «catálogo en Bs que vende»: NO se toca (la caja ya cobra);
--   4-5. sin lista USD y con un precio solo de un producto INACTIVO → crea
--        «detal USD» y la fija;
--   6-7. con predeterminada ya puesta → no se toca;
--   8.   idempotente: la segunda llamada no hace nada;
--   9.   la variante rota: sin precio de un producto activo, la misma empresa en
--        Bs SÍ cambiaría de lista — la condición es la que la protege.
-- =============================================================================

begin;
select plan(9);

insert into public.tenants (id, name) values
  ('aaaa0055-0000-4000-8000-00000000000a', 'Tenant 55');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0055-0000-4000-8000-0000000000a1', 'aaaa0055-0000-4000-8000-00000000000a', 'J-55-A', 'Paola 55'),
  ('aaaa0055-0000-4000-8000-0000000000a2', 'aaaa0055-0000-4000-8000-00000000000a', 'J-55-B', 'Catalogo Bs 55'),
  ('aaaa0055-0000-4000-8000-0000000000a3', 'aaaa0055-0000-4000-8000-00000000000a', 'J-55-C', 'Sin USD 55'),
  ('aaaa0055-0000-4000-8000-0000000000a4', 'aaaa0055-0000-4000-8000-00000000000a', 'J-55-D', 'Ya elegida 55');

insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0055-0000-4000-8000-0000000000d1', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a1', 'P55-A', 'Pollo 55', 'good', 'active', 'unidad', 'gravado_general'),
  ('aaaa0055-0000-4000-8000-0000000000d2', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a2', 'P55-B', 'Arroz 55', 'good', 'active', 'unidad', 'gravado_general'),
  ('aaaa0055-0000-4000-8000-0000000000d3', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a3', 'P55-C', 'Viejo 55', 'good', 'inactive', 'unidad', 'gravado_general');

insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  -- A: la forma del bug
  ('aaaa0055-0000-4000-8000-0000000000e1', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a1', 'detal', 'VES'),
  ('aaaa0055-0000-4000-8000-0000000000e2', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a1', 'detal USD', 'USD'),
  -- B: catálogo en Bs que vende
  ('aaaa0055-0000-4000-8000-0000000000e3', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a2', 'detal', 'VES'),
  -- C: sin lista USD; un precio de un producto inactivo
  ('aaaa0055-0000-4000-8000-0000000000e4', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a3', 'detal', 'VES'),
  -- D: ya elegida
  ('aaaa0055-0000-4000-8000-0000000000e5', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000a4', 'detal', 'VES');

insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from) values
  ('aaaa0055-0000-4000-8000-00000000000a', 'aaaa0055-0000-4000-8000-0000000000a1',
   'aaaa0055-0000-4000-8000-0000000000e2', 'aaaa0055-0000-4000-8000-0000000000d1', 5, '2026-09-01T00:00:00Z'),
  ('aaaa0055-0000-4000-8000-00000000000a', 'aaaa0055-0000-4000-8000-0000000000a2',
   'aaaa0055-0000-4000-8000-0000000000e3', 'aaaa0055-0000-4000-8000-0000000000d2', 200, '2026-09-01T00:00:00Z'),
  ('aaaa0055-0000-4000-8000-00000000000a', 'aaaa0055-0000-4000-8000-0000000000a3',
   'aaaa0055-0000-4000-8000-0000000000e4', 'aaaa0055-0000-4000-8000-0000000000d3', 90, '2026-09-01T00:00:00Z');

insert into public.company_settings (company_id, tenant_id, default_price_list_id) values
  ('aaaa0055-0000-4000-8000-0000000000a4', 'aaaa0055-0000-4000-8000-00000000000a',
   'aaaa0055-0000-4000-8000-0000000000e5');

-- 1-2 · la forma del bug
select is(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a1'),
  'aaaa0055-0000-4000-8000-0000000000e2'::uuid,
  'Forma «paola»: la caja pasa a la lista USD donde el alta escribió el precio');

select is(
  (select count(*)::int from public.audit_events
    where company_id = 'aaaa0055-0000-4000-8000-0000000000a1'
      and event_type = 'company.settings.updated' and actor_type = 'system'
      and payload->>'origin' = 'migration_20260915120000'
      and payload->>'default_price_list_id' = 'aaaa0055-0000-4000-8000-0000000000e2'),
  1,
  'La reparación deja su acta, con el origen y la lista');

-- 3 · la caja que ya vende no se toca
select is(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a2'),
  null::uuid,
  'Una caja que ya cobra algo (catálogo en Bs) NO cambia de lista');

-- 4 · sin lista USD
select isnt(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a3'),
  null::uuid,
  'Sin lista USD y con precios solo de productos inactivos: repara');
select ok(
  (select l.name = 'detal USD' and l.currency_code = 'USD'
     from public.company_settings cs join public.price_lists l on l.id = cs.default_price_list_id
    where cs.company_id = 'aaaa0055-0000-4000-8000-0000000000a3'),
  '… creando «detal USD» en USD y fijándola como predeterminada');

-- 5 · ya elegida
select is(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a4'),
  null::uuid,
  'Con predeterminada puesta por el dueño, no se toca');
select is(
  (select default_price_list_id from public.company_settings
    where company_id = 'aaaa0055-0000-4000-8000-0000000000a4'),
  'aaaa0055-0000-4000-8000-0000000000e5'::uuid,
  'y su lista sigue siendo la del dueño');

-- 6 · idempotente
select is(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a1'),
  null::uuid,
  'Idempotente: la segunda llamada no hace nada');

-- 7 · VARIANTE ROTA: lo único que protege a la empresa en Bs es que su caja
-- tiene precio para un producto ACTIVO. Se le quita esa condición (el producto
-- pasa a inactivo, dentro de un savepoint) y la misma función SÍ la cambia.
savepoint rota;
update public.products set status = 'inactive'
 where id = 'aaaa0055-0000-4000-8000-0000000000d2';
select isnt(
  platform.assign_caja_default_price_list('aaaa0055-0000-4000-8000-0000000000a2'),
  null::uuid,
  'VARIANTE ROTA: sin precio de un producto activo, la caja en Bs SÍ cambiaría de lista — la condición es la defensa');
rollback to savepoint rota;

select * from finish();
rollback;
