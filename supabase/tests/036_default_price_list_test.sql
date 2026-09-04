-- =============================================================================
-- Ladino — pgTAP 36 · LA LISTA PREDETERMINADA DE LA CAJA (migración 36)
--
--   1. la columna existe, nullable (NULL = heurística de siempre);
--   2. apuntar la caja a una lista PROPIA pasa;
--   3. apuntar la caja a la lista de OTRA empresa muere en la FK compuesta —
--      la variante rota que justifica la FK.
-- =============================================================================

begin;
select plan(3);

insert into public.tenants (id, name) values
  ('aaaa0036-0000-4000-8000-00000000000a', 'Tenant 36');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0036-0000-4000-8000-0000000000a1', 'aaaa0036-0000-4000-8000-00000000000a',
   'J-36-A', 'Empresa 36 A'),
  ('aaaa0036-0000-4000-8000-0000000000a2', 'aaaa0036-0000-4000-8000-00000000000a',
   'J-36-B', 'Empresa 36 B');
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('aaaa0036-0000-4000-8000-0000000000e1', 'aaaa0036-0000-4000-8000-00000000000a',
   'aaaa0036-0000-4000-8000-0000000000a1', 'Detal USD 36', 'USD'),
  ('aaaa0036-0000-4000-8000-0000000000e2', 'aaaa0036-0000-4000-8000-00000000000a',
   'aaaa0036-0000-4000-8000-0000000000a2', 'Detal ajeno 36', 'USD');

select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'company_settings'
      and column_name = 'default_price_list_id'),
  'YES',
  'default_price_list_id existe y es nullable: NULL = la heurística de siempre');

select lives_ok(
  $$insert into public.company_settings (company_id, tenant_id, default_price_list_id)
    values ('aaaa0036-0000-4000-8000-0000000000a1', 'aaaa0036-0000-4000-8000-00000000000a',
            'aaaa0036-0000-4000-8000-0000000000e1')$$,
  'La caja puede apuntar a una lista PROPIA');

select throws_ok(
  $$update public.company_settings
       set default_price_list_id = 'aaaa0036-0000-4000-8000-0000000000e2'
     where company_id = 'aaaa0036-0000-4000-8000-0000000000a1'$$,
  '23503',
  null,
  'Apuntar la caja a la lista de OTRA empresa muere en la FK compuesta');

select * from finish();
rollback;
