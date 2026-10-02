-- =============================================================================
-- Ladino — pgTAP 82c · LA IMPORTACIÓN ES UN TRABAJO: la re-revisión
-- (migración 20260928140300; ADR-0074, A4 y A5)
--
--   1. A4: la moneda del costo de referencia es una moneda del catálogo (FK a currencies), con
--      su variante rota: sin el FK, «XYZ» —tres mayúsculas, el CHECK la deja— entra;
--   2. A5: el worker puede escribir `next_attempt_at` (su backoff) y sigue sin poder escribir el
--      informe.
-- =============================================================================

begin;
select plan(6);

insert into auth.users (id) values ('aaaa082c-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values ('aaaa082c-0000-4000-8000-00000000000a', 'Tenant 82c');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa082c-0000-4000-8000-0000000000a2', 'aaaa082c-0000-4000-8000-00000000000a',
   'J-82C-A', 'Importación 82c');
select set_config('ladino.actor_id', 'aaaa082c-0000-4000-8000-0000000000a1', true);
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
values ('aaaa082c-0000-4000-8000-0000000000b1', 'aaaa082c-0000-4000-8000-00000000000a',
        'aaaa082c-0000-4000-8000-0000000000a2', 'REF-C', 'Con referencia', 'good', 'unidad',
        'gravado_general');
insert into public.product_import_jobs
  (id, tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
values ('aaaa082c-0000-4000-8000-0000000000d1', 'aaaa082c-0000-4000-8000-00000000000a',
        'aaaa082c-0000-4000-8000-0000000000a2', 'c.csv', repeat('c', 64), 'comma_decimal', 1,
        '[{"row":2,"status":"ready","warnings":[]}]');

-- ── 1. A4 ───────────────────────────────────────────────────────────────────
select throws_ok(
  $$ update public.products set reference_cost = 1, reference_cost_currency = 'XYZ'
      where id = 'aaaa082c-0000-4000-8000-0000000000b1' $$,
  '23503', null, 'una moneda fuera del catálogo se rechaza (FK a currencies)');
select lives_ok(
  $$ update public.products set reference_cost = 1, reference_cost_currency = 'VES'
      where id = 'aaaa082c-0000-4000-8000-0000000000b1' $$,
  'una moneda del catálogo entra');
savepoint roto_fk;
alter table public.products drop constraint products_reference_cost_currency_fk;
select lives_ok(
  $$ update public.products set reference_cost = 1, reference_cost_currency = 'XYZ'
      where id = 'aaaa082c-0000-4000-8000-0000000000b1' $$,
  'ROTO: sin el FK, «XYZ» entra — el CHECK no la para; la aserción de arriba mide el FK');
rollback to savepoint roto_fk;

-- ── 2. A5 ───────────────────────────────────────────────────────────────────
set local role ladino_worker;
update public.product_import_jobs
   set attempts = attempts + 1, next_attempt_at = now() + interval '30 seconds'
 where id = 'aaaa082c-0000-4000-8000-0000000000d1';
select throws_ok(
  $$ update public.product_import_jobs set report = '[]'
      where id = 'aaaa082c-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'el worker sigue sin escribir el informe');
reset role;
select ok((select next_attempt_at > now() from public.product_import_jobs
            where id = 'aaaa082c-0000-4000-8000-0000000000d1'),
  'el worker escribe su backoff: next_attempt_at en el futuro');
select is((select attempts from public.product_import_jobs
            where id = 'aaaa082c-0000-4000-8000-0000000000d1'),
  1, 'y su contabilidad de fallos: attempts 0 → 1');

select * from finish();
rollback;
