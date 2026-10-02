-- =============================================================================
-- Ladino — pgTAP 82b · LA IMPORTACIÓN ES UN TRABAJO: los arreglos de la revisión
-- (migración 20260928140100; ADR-0074, revisión H1, H3 y H11)
--
--   1. H3: el avance es de UNA fila y la entrada nueva del informe es la de la fila que tocaba —
--      informar dos veces la misma fila se rechaza aunque los contadores cuadren (variante rota:
--      sin la guarda, entra);
--   2. H1-c: attempts sube libre, pero solo vuelve a cero cuando el trabajo avanza;
--   3. H1-d: el único de la llave es PARCIAL — un trabajo failed no impide volver a subir el
--      archivo, y dos vivos del mismo archivo siguen chocando (variante rota: sin el índice, entra);
--   4. H11: products.reference_cost y su moneda van juntos, con importe no negativo.
-- =============================================================================

begin;
select plan(15);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa082b-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values ('aaaa082b-0000-4000-8000-00000000000a', 'Tenant 82b');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa082b-0000-4000-8000-0000000000a2', 'aaaa082b-0000-4000-8000-00000000000a',
   'J-82B-A', 'Importación 82b');
select set_config('ladino.actor_id', 'aaaa082b-0000-4000-8000-0000000000a1', true);
insert into public.product_import_jobs
  (id, tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
values ('aaaa082b-0000-4000-8000-0000000000d1', 'aaaa082b-0000-4000-8000-00000000000a',
        'aaaa082b-0000-4000-8000-0000000000a2', 'tres.csv', repeat('1', 64), 'comma_decimal', 3,
        '[{"row":2,"status":"ready","warnings":[]},{"row":3,"status":"ready","warnings":[]},{"row":4,"status":"ready","warnings":[]}]');

-- ── 1. H3: una fila, la que tocaba ──────────────────────────────────────────
select lives_ok(
  $$ update public.product_import_jobs
        set processed_rows = 1, created_count = 1, status = 'running',
            report = '[{"row":2,"status":"created","warnings":[]}]'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  'avanzar la fila 2 con SU entrada de informe funciona');
select throws_ok(
  $$ update public.product_import_jobs
        set processed_rows = 2, created_count = 2,
            report = report || '[{"row":2,"status":"created","warnings":[]}]'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'informar DOS veces la fila 2 se rechaza, aunque contador e informe cuadren');
savepoint roto_guarda;
alter table public.product_import_jobs disable trigger product_import_jobs_02_guard;
select lives_ok(
  $$ update public.product_import_jobs
        set processed_rows = 2, created_count = 2,
            report = report || '[{"row":2,"status":"created","warnings":[]}]'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  'ROTO: sin la guarda, la fila 2 entra dos veces — report_chk no lo ve; la aserción de arriba mide la guarda');
rollback to savepoint roto_guarda;
select throws_ok(
  $$ update public.product_import_jobs
        set processed_rows = 3, created_count = 3,
            report = report || '[{"row":3,"status":"created","warnings":[]},{"row":4,"status":"created","warnings":[]}]'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'avanzar dos filas de golpe se rechaza: de una en una');

-- ── 2. H1-c: attempts ───────────────────────────────────────────────────────
select lives_ok(
  $$ update public.product_import_jobs set attempts = 3, last_error = 'caída'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  'los intentos suben');
select throws_ok(
  $$ update public.product_import_jobs set attempts = 0
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'los intentos no se ponen a cero sin que el trabajo avance');
select lives_ok(
  $$ update public.product_import_jobs
        set processed_rows = 2, created_count = 2, attempts = 0,
            report = report || '[{"row":3,"status":"created","warnings":[]}]'
      where id = 'aaaa082b-0000-4000-8000-0000000000d1' $$,
  'al avanzar, los intentos vuelven a cero: caídas pasajeras repartidas no matan el trabajo');

-- ── 3. H1-d: la llave parcial ───────────────────────────────────────────────
insert into public.product_import_jobs
  (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows, status, last_error)
values ('aaaa082b-0000-4000-8000-00000000000a', 'aaaa082b-0000-4000-8000-0000000000a2',
        'fallido.csv', repeat('f', 64), 'comma_decimal', 1, '[{}]', 'failed', 'se cayó');
select lives_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa082b-0000-4000-8000-00000000000a', 'aaaa082b-0000-4000-8000-0000000000a2',
             'otra vez.csv', repeat('f', 64), 'comma_decimal', 1, '[{}]') $$,
  'el archivo de un trabajo failed se vuelve a subir: trabajo nuevo');
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa082b-0000-4000-8000-00000000000a', 'aaaa082b-0000-4000-8000-0000000000a2',
             'y otra.csv', repeat('f', 64), 'comma_decimal', 1, '[{}]') $$,
  '23505', null, 'pero dos trabajos VIVOS del mismo archivo siguen chocando');
savepoint roto_llave;
drop index public.product_import_jobs_key;
select lives_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa082b-0000-4000-8000-00000000000a', 'aaaa082b-0000-4000-8000-0000000000a2',
             'y otra.csv', repeat('f', 64), 'comma_decimal', 1, '[{}]') $$,
  'ROTO: sin el índice parcial, el duplicado vivo entra — la aserción de arriba mide la llave');
rollback to savepoint roto_llave;

-- ── 4. H11: el costo de referencia ──────────────────────────────────────────
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
values ('aaaa082b-0000-4000-8000-0000000000b1', 'aaaa082b-0000-4000-8000-00000000000a',
        'aaaa082b-0000-4000-8000-0000000000a2', 'REF-1', 'Con referencia', 'good', 'unidad',
        'gravado_general');
select throws_ok(
  $$ update public.products set reference_cost = 1
      where id = 'aaaa082b-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'un costo de referencia sin moneda se rechaza');
select throws_ok(
  $$ update public.products set reference_cost = 1, reference_cost_currency = 'usd'
      where id = 'aaaa082b-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'la moneda son tres letras mayúsculas');
select throws_ok(
  $$ update public.products set reference_cost = -1, reference_cost_currency = 'USD'
      where id = 'aaaa082b-0000-4000-8000-0000000000b1' $$,
  '23514', null, 'el costo de referencia no es negativo');
select lives_ok(
  $$ update public.products set reference_cost = 0.4, reference_cost_currency = 'USD'
      where id = 'aaaa082b-0000-4000-8000-0000000000b1' $$,
  'importe y moneda juntos se guardan');
select is((select reference_cost::text from public.products
            where id = 'aaaa082b-0000-4000-8000-0000000000b1'),
  '0.40000000', 'numeric(24,8): el importe como texto exacto');

select * from finish();
rollback;
