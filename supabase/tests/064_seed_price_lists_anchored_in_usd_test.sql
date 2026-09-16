-- =============================================================================
-- Ladino — pgTAP 64 · «DETAL» Y «MAYOR» EN USD (migración 64)
--
--   1. «detal» VES vacía y sin documentos pasa a USD …
--   2. … y «mayor» igual;
--   3. con su acta;
--   4. una lista VES CON precios no se toca (convertirla exige una tasa);
--   5. una lista con otro nombre no se toca;
--   6. idempotente: la segunda llamada no cambia nada;
--   7. VARIANTE ROTA: antes de la regla, la predeterminada de la empresa pedía bolívares.
-- =============================================================================

begin;
select plan(7);

insert into public.tenants (id, name) values
  ('aaaa0064-0000-4000-8000-00000000000a', 'Tenant 64');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0064-0000-4000-8000-0000000000a1', 'aaaa0064-0000-4000-8000-00000000000a',
   'J-64-A', 'Empresa vieja 64', 'VES'),
  ('aaaa0064-0000-4000-8000-0000000000a2', 'aaaa0064-0000-4000-8000-00000000000a',
   'J-64-B', 'Empresa con precios en Bs 64', 'VES');

-- Las listas como las sembraba el alta vieja: en la moneda funcional.
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('aaaa0064-0000-4000-8000-0000000000b1', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000a1', 'detal', 'VES'),
  ('aaaa0064-0000-4000-8000-0000000000b2', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000a1', 'mayor', 'VES'),
  ('aaaa0064-0000-4000-8000-0000000000b3', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000a1', 'especial', 'VES'),
  ('aaaa0064-0000-4000-8000-0000000000b4', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000a2', 'detal', 'VES');
insert into public.company_settings (company_id, tenant_id, default_price_list_id) values
  ('aaaa0064-0000-4000-8000-0000000000a1', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000b1');

-- La segunda empresa ya vende con precios en bolívares.
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0064-0000-4000-8000-0000000000c1', 'aaaa0064-0000-4000-8000-00000000000a',
   'aaaa0064-0000-4000-8000-0000000000a2', 'P64', 'Arroz', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.price_list_items
  (tenant_id, company_id, price_list_id, product_id, amount, effective_from) values
  ('aaaa0064-0000-4000-8000-00000000000a', 'aaaa0064-0000-4000-8000-0000000000a2',
   'aaaa0064-0000-4000-8000-0000000000b4', 'aaaa0064-0000-4000-8000-0000000000c1', 950,
   now() - interval '1 day');

select is(
  (select l.currency_code from public.company_settings s
     join public.price_lists l on l.id = s.default_price_list_id
    where s.company_id = 'aaaa0064-0000-4000-8000-0000000000a1'),
  'VES',
  'VARIANTE ROTA: antes de la regla, la lista de la caja pedía bolívares');

select is(platform.anchor_seed_price_lists_in_usd() >= 2, true,
  'la regla cambia al menos las dos listas vacías de esta prueba');

select results_eq(
  $$select name, currency_code from public.price_lists
     where company_id = 'aaaa0064-0000-4000-8000-0000000000a1' and name in ('detal', 'mayor')
     order by name$$,
  $$values ('detal'::text, 'USD'::text), ('mayor'::text, 'USD'::text)$$,
  '«detal» y «mayor» vacías pasan a USD');

select is(
  (select count(*)::int from public.audit_events
    where event_type = 'price_list.currency_anchored'
      and payload->>'origin' = 'migration_20260916160000'
      and aggregate_id in ('aaaa0064-0000-4000-8000-0000000000b1',
                           'aaaa0064-0000-4000-8000-0000000000b2')),
  2,
  'cada cambio deja su acta');

select is(
  (select currency_code from public.price_lists where id = 'aaaa0064-0000-4000-8000-0000000000b4'),
  'VES',
  'una lista con precios en bolívares no se toca: convertirla exige elegir una tasa');

select is(
  (select currency_code from public.price_lists where id = 'aaaa0064-0000-4000-8000-0000000000b3'),
  'VES',
  'una lista con otro nombre no se toca');

select is(platform.anchor_seed_price_lists_in_usd(), 0,
  'idempotente: la segunda llamada no cambia nada');

select * from finish();
rollback;
