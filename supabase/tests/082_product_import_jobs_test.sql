-- =============================================================================
-- Ladino — pgTAP 82 · LA IMPORTACIÓN ES UN TRABAJO (ADR-0074; C-01, C-04, C-05)
--
--   1. RLS habilitada y forzada; aislamiento como ladino_api en las CUATRO operaciones, con un
--      usuario de UN tenant y otro de LOS DOS (el atacante realista);
--   2. el ancla: ni el usuario de los dos tenants traslada un trabajo de A a B;
--   3. la llave natural (company_id, file_hash, number_format) rechaza el segundo trabajo del
--      mismo archivo — y sin el único, entra (variante rota);
--   4. los CHECK, con la coherencia informe = filas procesadas y su variante rota (el doble
--      proceso lo prueba el pgTAP 082b: la guarda de 20260928140100);
--   5. la guarda: lo que define el trabajo no cambia, el progreso solo avanza, el informe solo
--      crece por la cola, un trabajo terminado no se toca;
--   6. el worker: lee lo pendiente de todos, toca solo su contabilidad de fallos, no borra, no
--      lee productos; puede ADOPTAR ladino_api sin heredarlo (el SET ROLE real lo ejerce el test
--      del worker, apps/worker/test/importaciones.test.ts, porque aquí la sesión es postgres).
-- =============================================================================

begin;
select plan(36);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0082-0000-4000-8000-0000000000a1'),   -- de A
  ('aaaa0082-0000-4000-8000-0000000000c1');   -- de A y de B
insert into public.tenants (id, name) values
  ('aaaa0082-0000-4000-8000-00000000000a', 'Tenant 82-A'),
  ('aaaa0082-0000-4000-8000-00000000000b', 'Tenant 82-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0082-0000-4000-8000-0000000000a2', 'aaaa0082-0000-4000-8000-00000000000a',
   'J-82-A', 'Importación 82 A'),
  ('aaaa0082-0000-4000-8000-0000000000b2', 'aaaa0082-0000-4000-8000-00000000000b',
   'J-82-B', 'Importación 82 B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0082-0000-4000-8000-0000000000a3', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a1'),
  ('aaaa0082-0000-4000-8000-0000000000c3', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000c1'),
  ('aaaa0082-0000-4000-8000-0000000000c4', 'aaaa0082-0000-4000-8000-00000000000b',
   'aaaa0082-0000-4000-8000-0000000000c1');

select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000a1', true);
insert into public.product_import_jobs
  (id, tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
values ('aaaa0082-0000-4000-8000-0000000000d1', 'aaaa0082-0000-4000-8000-00000000000a',
        'aaaa0082-0000-4000-8000-0000000000a2', 'á — productos.csv', repeat('a', 64),
        'comma_decimal', 2,
        '[{"row":2,"status":"ready","warnings":[]},{"row":3,"status":"rejected","warnings":[]}]');
select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000c1', true);
insert into public.product_import_jobs
  (id, tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
values ('aaaa0082-0000-4000-8000-0000000000d2', 'aaaa0082-0000-4000-8000-00000000000b',
        'aaaa0082-0000-4000-8000-0000000000b2', 'b.csv', repeat('b', 64), 'dot_decimal', 1,
        '[{"row":2,"status":"ready","warnings":[]}]');

-- ── 1. RLS y aislamiento ─────────────────────────────────────────────────────
select ok((select relrowsecurity from pg_class where oid = 'public.product_import_jobs'::regclass),
  'RLS habilitada');
select ok((select relforcerowsecurity from pg_class where oid = 'public.product_import_jobs'::regclass),
  'RLS forzada');
select is((select created_by from public.product_import_jobs
            where id = 'aaaa0082-0000-4000-8000-0000000000d1'),
  'aaaa0082-0000-4000-8000-0000000000a1'::uuid, 'created_by sale del actor, no del cliente');

select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*) from public.product_import_jobs
            where id in ('aaaa0082-0000-4000-8000-0000000000d1',
                         'aaaa0082-0000-4000-8000-0000000000d2')),
  1::bigint, 'ladino_api con actor de A ve SOLO el trabajo de A');
update public.product_import_jobs set last_error = 'SECUESTRADO'
 where id = 'aaaa0082-0000-4000-8000-0000000000d2';
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000b', 'aaaa0082-0000-4000-8000-0000000000b2',
             'x.csv', repeat('c', 64), 'comma_decimal', 1, '[{}]') $$,
  '42501', null, 'ladino_api con actor de A no inserta un trabajo en B: 42501');
select throws_ok($$ delete from public.product_import_jobs $$, '42501', null,
  'nadie borra un trabajo: ladino_api no tiene DELETE');
reset role;
select is((select last_error from public.product_import_jobs
            where id = 'aaaa0082-0000-4000-8000-0000000000d2'),
  null, 'el UPDATE de A sobre el trabajo de B no cambió NADA');

select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is((select count(*) from public.product_import_jobs
            where id in ('aaaa0082-0000-4000-8000-0000000000d1',
                         'aaaa0082-0000-4000-8000-0000000000d2')),
  2::bigint, 'el usuario de los dos tenants ve los dos (legítimo)');

-- ── 2. El ancla ──────────────────────────────────────────────────────────────
select throws_ok(
  $$ update public.product_import_jobs
        set tenant_id = 'aaaa0082-0000-4000-8000-00000000000b',
            company_id = 'aaaa0082-0000-4000-8000-0000000000b2'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  'LAD28', null, 'ni el usuario de los dos tenants traslada un trabajo de A a B (ancla)');
reset role;
select ok(exists (select 1 from pg_trigger t
                   where t.tgrelid = 'public.product_import_jobs'::regclass
                     and t.tgfoid = 'platform.assert_isolation_anchors_immutable()'::regprocedure),
  'la tabla lleva su trigger de ancla (test 006, sin excepciones)');

-- ── 3. La llave natural ─────────────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000a1', true);
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'otra vez.csv', repeat('a', 64), 'comma_decimal', 1, '[{}]') $$,
  '23505', null, 'el mismo archivo con el mismo formato no crea un segundo trabajo (C-04)');
select lives_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'otro formato.csv', repeat('a', 64), 'dot_decimal', 1, '[{}]') $$,
  'el mismo archivo con OTRO formato es otra interpretación: entra');
savepoint roto_llave;
drop index public.product_import_jobs_key;
select lives_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'otra vez.csv', repeat('a', 64), 'comma_decimal', 1, '[{}]') $$,
  'ROTO: sin el único, el duplicado entra — la aserción de arriba mide la llave');
rollback to savepoint roto_llave;

-- ── 4. Los CHECK ─────────────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'x.csv', 'NO-ES-HEX', 'comma_decimal', 1, '[{}]') $$,
  '23514', null, 'el hash es sha256 en hex');
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'x.csv', repeat('e', 64), 'europeo', 1, '[{}]') $$,
  '23514', null, 'el formato es comma_decimal o dot_decimal');
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'x.csv', repeat('e', 64), 'comma_decimal', 501,
             (select jsonb_agg('{}'::jsonb) from generate_series(1, 501))) $$,
  '23514', null, 'máximo 500 filas por trabajo');
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'x.csv', repeat('e', 64), 'comma_decimal', 3, '[{}]') $$,
  '23514', null, 'row_count dice cuántas filas hay en rows, ni una más');
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             '', repeat('e', 64), 'comma_decimal', 1, '[{}]') $$,
  '23514', null, 'el nombre del archivo no es vacío');
-- Coherencia: una fila procesada sin su entrada de informe. Por INSERT, porque en un UPDATE la
-- guarda de 20260928140100 (la entrada nueva es la de la fila que tocaba) dispara antes que el CHECK.
select throws_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows,
        processed_rows, created_count)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'sin informe.csv', repeat('9', 64), 'comma_decimal', 1, '[{}]', 1, 1) $$,
  '23514', null, 'una fila procesada sin su entrada de informe se rechaza (informe = procesadas)');
savepoint roto_informe;
alter table public.product_import_jobs drop constraint product_import_jobs_report_chk;
select lives_ok(
  $$ insert into public.product_import_jobs
       (tenant_id, company_id, file_name, file_hash, number_format, row_count, rows,
        processed_rows, created_count)
     values ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
             'sin informe.csv', repeat('9', 64), 'comma_decimal', 1, '[{}]', 1, 1) $$,
  'ROTO: sin el CHECK del informe, entra una fila procesada sin informe — la aserción de arriba mide ese CHECK');
rollback to savepoint roto_informe;
select throws_ok(
  $$ update public.product_import_jobs
        set processed_rows = 1, report = '[{"row":2,"status":"created","warnings":[]}]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '23514', null, 'creados + actualizados + rechazados = procesadas');
select throws_ok(
  $$ update public.product_import_jobs set status = 'done'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '23514', null, 'done exige todas las filas procesadas');

-- ── 5. La guarda ─────────────────────────────────────────────────────────────
select lives_ok(
  $$ update public.product_import_jobs
        set processed_rows = 1, created_count = 1, status = 'running',
            report = '[{"row":2,"status":"created","warnings":[]}]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  'avanzar una fila con su entrada de informe funciona (el camino autorizado vive)');
select throws_ok(
  $$ update public.product_import_jobs set rows = '[{},{}]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'las filas interpretadas no cambian');
select throws_ok(
  $$ update public.product_import_jobs set file_hash = repeat('f', 64)
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'el hash no cambia');
select throws_ok(
  $$ update public.product_import_jobs set processed_rows = 0, created_count = 0, report = '[]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'el progreso no retrocede');
select throws_ok(
  $$ update public.product_import_jobs
        set processed_rows = 2, created_count = 1, rejected_count = 1,
            report = '[{"row":2,"status":"rejected","warnings":[]},{"row":3,"status":"rejected","warnings":[]}]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'el informe no se reescribe: solo crece por la cola');
select lives_ok(
  $$ update public.product_import_jobs
        set processed_rows = 2, rejected_count = 1, status = 'done', finished_at = now(),
            report = report || '[{"row":3,"status":"rejected","warnings":[]}]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  'la última fila cierra el trabajo');
select throws_ok(
  $$ update public.product_import_jobs set last_error = 'tarde'
      where id = 'aaaa0082-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'un trabajo terminado no se toca');

-- ── 6. El worker ─────────────────────────────────────────────────────────────
set local role ladino_worker;
select is((select count(*) from public.product_import_jobs
            where id in ('aaaa0082-0000-4000-8000-0000000000d1',
                         'aaaa0082-0000-4000-8000-0000000000d2')),
  2::bigint, 'el worker lee los trabajos de todos los tenants: es su trabajo');
update public.product_import_jobs set attempts = attempts + 1, last_error = 'caída'
 where id = 'aaaa0082-0000-4000-8000-0000000000d2';
select throws_ok(
  $$ update public.product_import_jobs set report = '[]'
      where id = 'aaaa0082-0000-4000-8000-0000000000d2' $$,
  '42501', null, 'el worker no escribe el informe: solo su contabilidad de fallos');
select throws_ok($$ delete from public.product_import_jobs $$, '42501', null,
  'el worker no borra trabajos');
select throws_ok($$ select count(*) from public.products $$, '42501', null,
  'sin adoptar ladino_api, el worker sigue sin leer productos (ADR-0031)');
reset role;
select is((select attempts from public.product_import_jobs
            where id = 'aaaa0082-0000-4000-8000-0000000000d2'),
  1, 'y su contabilidad de fallos sí se escribe: attempts 0 → 1');
select ok(pg_has_role('ladino_worker', 'ladino_api', 'SET'),
  'el worker puede ADOPTAR ladino_api (SET ROLE)');
select ok(not pg_has_role('ladino_worker', 'ladino_api', 'USAGE'),
  'pero no HEREDA sus privilegios: sin el SET ROLE explícito no ve nada de negocio');

select * from finish();
rollback;
