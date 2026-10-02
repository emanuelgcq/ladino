-- =============================================================================
-- Ladino — pgTAP 81d · ALÍCUOTAS EN EL LIBRO DE COMPRAS, LA LISTA CERRADA DE LA REDUCIDA Y LA
-- FUENTE DE LA GENERAL (ADR-0073; auditoría fiscal de la ronda: hallazgos 6, 10 y 12; revisión:
-- A1, A2, A3)
--
--   1. H6 · `purchases_book_by_rate` en julio: factura al 16 %, al 8 % y exenta; anulada en su
--      período; NC sobre la línea del 16 %; NC sobre la línea EXENTA (A2: resta de exentas); una
--      factura en USD con fx de 8 decimales y dos alícuotas (A1: sin residuo de redondeo); una
--      factura sin crédito recuperable. En TODO renglón limpio, base_gravada_sin_alicuota = 0 e
--      iva_sin_clasificar = 0 (A3), y el resumen no trae una fila «sin_clasificar» falsa.
--   2. El mes en curso: el «ajuste de período anterior» (factor −1) de una factura anulada después
--      de cerrar y generar su libro, y una factura recibida con retraso.
--   3. Aislamiento: el actor de otro tenant no lee nada (y su variante ROTA).
--   4. H10 · la lista cerrada de la reducida; H12 · la general, fuente secundaria.
-- =============================================================================

begin;
select plan(23);

insert into auth.users (id) values ('aaaa0084-0000-4000-8000-0000000000b1'),
                                   ('aaaa0084-0000-4000-8000-0000000000a9');
select set_config('ladino.actor_id', 'aaaa0084-0000-4000-8000-0000000000a9', true);
insert into public.tenants (id, name) values
  ('aaaa0084-0000-4000-8000-00000000000a', 'Tenant 81d-A'),
  ('aaaa0084-0000-4000-8000-00000000000b', 'Tenant 81d-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0084-0000-4000-8000-0000000000a2', 'aaaa0084-0000-4000-8000-00000000000a',
        'J-84-A', 'Compras 81d A', 'VES', 'ordinario'),
       ('aaaa0084-0000-4000-8000-0000000000b2', 'aaaa0084-0000-4000-8000-00000000000b',
        'J-84-B', 'Compras 81d B', 'VES', 'ordinario');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0084-0000-4000-8000-0000000000b3', 'aaaa0084-0000-4000-8000-00000000000b',
   'aaaa0084-0000-4000-8000-0000000000b1');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0084-0000-4000-8000-0000000000c1', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a2', 'J-84-PROV', 'Proveedor 81d', 'nacional',
        'ordinario', 'juridica');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0084-0000-4000-8000-00000000d00a', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a2', 'SKU-84A', 'Producto 81d', 'service', 'unidad',
   'gravado_general');

-- Los meses relativos: m0 = el mes en curso (Caracas); m2 = dos meses atrás.
create temporary table mes (k int primary key, desde date, hasta date) on commit drop;
insert into mes
select k, d, (d + interval '1 month - 1 day')::date
  from (select k, (date_trunc('month', platform.caracas_day(now())) - make_interval(months => k))::date as d
          from generate_series(0, 2) k) x;

-- Facturas. Julio: f1 (16 % + 8 % + exento), f2 (se anula en su período), f3 (USD, fx de 8
-- decimales, 16 % y 8 %), f4 (sin crédito recuperable). m2: f5 (se anula después de cerrar y
-- generar su libro) y f6 (de m2, registrada HOY: recibida con retraso).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, accounting_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
select v.id, 'aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
       'aaaa0084-0000-4000-8000-0000000000c1', v.num, v.ctl, v.fecha, v.registro, 'posted', now(),
       v.sub, v.iva, v.sub + v.iva, v.recuperable, v.moneda, 'VES', v.fx, v.fuente
  from (values
    ('aaaa0084-0000-4000-8000-0000000000f1'::uuid, 'F84-1', '00-841', '2026-07-05'::date,
     null::date, 400::numeric, 32::numeric, true, 'VES', 1::numeric, 'identidad'),
    ('aaaa0084-0000-4000-8000-0000000000f2', 'F84-2', '00-842', '2026-07-06', null, 300, 48, true,
     'VES', 1, 'identidad'),
    ('aaaa0084-0000-4000-8000-0000000000f3', 'F84-3', '00-843', '2026-07-09', null, 30.04, 3.20,
     true, 'USD', 36.12345679, 'BCV'),
    ('aaaa0084-0000-4000-8000-0000000000f4', 'F84-4', '00-844', '2026-07-10', null, 100, 16, false,
     'VES', 1, 'identidad'),
    ('aaaa0084-0000-4000-8000-0000000000f5', 'F84-5', '00-845', (select desde + 9 from mes where k = 2),
     null, 100, 16, true, 'VES', 1, 'identidad'),
    ('aaaa0084-0000-4000-8000-0000000000f6', 'F84-6', '00-846', (select desde + 10 from mes where k = 2),
     platform.caracas_day(now()), 100, 16, true, 'VES', 1, 'identidad')
  ) v(id, num, ctl, fecha, registro, sub, iva, recuperable, moneda, fx, fuente);
insert into public.supplier_invoice_lines
  (id, tenant_id, company_id, supplier_invoice_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, line_subtotal_transaction,
   line_total_transaction, tax_amount, tax_rate_snapshot, tax_category_snapshot, tax_treatment,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
select v.id, 'aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
       v.inv, v.n, 'aaaa0084-0000-4000-8000-00000000d00a', 'Línea', 1, v.base,
       round(v.base * v.fx, 8), v.base, v.base + v.iva, v.iva, v.rate, v.cat, v.trat,
       v.base + v.iva, v.moneda, v.fx, round((v.base + v.iva) * v.fx, 8), 'VES', 'prueba', now(),
       'purchases:document:8:HALF_UP'
  from (values
    ('aaaa0084-0000-4000-8000-0000000001a1'::uuid, 'aaaa0084-0000-4000-8000-0000000000f1'::uuid, 1,
     100::numeric, 16::numeric, 0.16::numeric, 'gravado_general', 'gravado', 'VES', 1::numeric),
    ('aaaa0084-0000-4000-8000-0000000001a2', 'aaaa0084-0000-4000-8000-0000000000f1', 2,
     200, 16, 0.08, 'gravado_reducida', 'gravado', 'VES', 1),
    ('aaaa0084-0000-4000-8000-0000000001a3', 'aaaa0084-0000-4000-8000-0000000000f1', 3,
     100, 0, 0, 'exento', 'exento', 'VES', 1),
    ('aaaa0084-0000-4000-8000-0000000001b1', 'aaaa0084-0000-4000-8000-0000000000f2', 1,
     300, 48, 0.16, 'gravado_general', 'gravado', 'VES', 1),
    ('aaaa0084-0000-4000-8000-0000000001c1', 'aaaa0084-0000-4000-8000-0000000000f3', 1,
     10.01, 1.60, 0.16, 'gravado_general', 'gravado', 'USD', 36.12345679),
    ('aaaa0084-0000-4000-8000-0000000001c2', 'aaaa0084-0000-4000-8000-0000000000f3', 2,
     20.03, 1.60, 0.08, 'gravado_reducida', 'gravado', 'USD', 36.12345679),
    ('aaaa0084-0000-4000-8000-0000000001d1', 'aaaa0084-0000-4000-8000-0000000000f4', 1,
     100, 16, 0.16, 'gravado_general', 'gravado', 'VES', 1),
    ('aaaa0084-0000-4000-8000-0000000001e1', 'aaaa0084-0000-4000-8000-0000000000f5', 1,
     100, 16, 0.16, 'gravado_general', 'gravado', 'VES', 1),
    ('aaaa0084-0000-4000-8000-0000000001e2', 'aaaa0084-0000-4000-8000-0000000000f6', 1,
     100, 16, 0.16, 'gravado_general', 'gravado', 'VES', 1)
  ) v(id, inv, n, base, iva, rate, cat, trat, moneda, fx);
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0084-0000-4000-8000-0000000000f2';

-- Dos NC recibidas en julio: una sobre la línea del 16 % (50 + 8), otra sobre la EXENTA (30).
insert into public.supplier_credit_notes
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
   supplier_control_number, note_date, status, posted_at, reason, subtotal_amount, tax_amount,
   total_amount, transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0084-0000-4000-8000-0000000000e1', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a2', 'aaaa0084-0000-4000-8000-0000000000c1',
        'aaaa0084-0000-4000-8000-0000000000f1', 'NC84-1', '00-849', '2026-07-07', 'posted',
        now(), 'Devolución parcial', 50, 8, 58, 'VES', 'VES', 1, 'identidad'),
       ('aaaa0084-0000-4000-8000-0000000000e2', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a2', 'aaaa0084-0000-4000-8000-0000000000c1',
        'aaaa0084-0000-4000-8000-0000000000f1', 'NC84-2', '00-850', '2026-07-08', 'posted',
        now(), 'Devolución de lo exento', 30, 0, 30, 'VES', 'VES', 1, 'identidad');
insert into public.supplier_credit_note_lines
  (tenant_id, company_id, supplier_credit_note_id, line_number, supplier_invoice_line_id,
   product_id, description, quantity, unit_price_transaction, tax_amount,
   line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
        'aaaa0084-0000-4000-8000-0000000000e1', 1, 'aaaa0084-0000-4000-8000-0000000001a1',
        'aaaa0084-0000-4000-8000-00000000d00a', 'Devuelta', 1, 50, 8, 50, 58, 58, 'VES', 1, 58,
        'VES', 'identidad', now(), 'purchases:document:8:HALF_UP'),
       ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
        'aaaa0084-0000-4000-8000-0000000000e2', 1, 'aaaa0084-0000-4000-8000-0000000001a3',
        'aaaa0084-0000-4000-8000-00000000d00a', 'Exenta devuelta', 1, 30, 0, 30, 30, 30, 'VES', 1,
        30, 'VES', 'identidad', now(), 'purchases:document:8:HALF_UP');

-- m2: período CERRADO y su libro de compras GENERADO; f5 se anula AHORA → ajuste en m0.
insert into public.fiscal_periods (tenant_id, company_id, year, month, status, closed_at, closed_by)
select 'aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
       extract(year from desde)::int, extract(month from desde)::int, 'closed', now(),
       'aaaa0084-0000-4000-8000-0000000000a9'
  from mes where k = 2;
insert into public.fiscal_book_runs
  (tenant_id, company_id, book_kind, period_from, period_to, timezone, generator_version,
   dataset_hash, row_count, format_code)
select 'aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a2',
       'compras', desde, hasta, 'America/Caracas', 'test', repeat('c', 64), 1,
       'csv_columnas_legales'
  from mes where k = 2;
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0084-0000-4000-8000-0000000000f5';

create temporary table libro on commit drop as
  select * from platform.purchases_book_by_rate('aaaa0084-0000-4000-8000-0000000000a2',
                                                '2026-07-01', '2026-07-31');
create temporary table resumen on commit drop as
  select * from platform.purchases_book_summary('aaaa0084-0000-4000-8000-0000000000a2',
                                                '2026-07-01', '2026-07-31');
create temporary table libro_m0 on commit drop as
  select * from platform.purchases_book_by_rate('aaaa0084-0000-4000-8000-0000000000a2',
                                                (select desde from mes where k = 0),
                                                (select hasta from mes where k = 0));

-- ── 1. Julio ─────────────────────────────────────────────────────────────────
select is((select count(*) from libro), 6::bigint,
  'julio trae f1, f2 (anulada), f3 (USD), f4 (sin crédito) y las dos NC');
select is(
  (select count(*) from libro where base_gravada_sin_alicuota <> 0 or iva_sin_clasificar <> 0),
  0::bigint, 'A3: en todo renglón limpio de julio, nada queda sin alícuota ni sin clasificar');
select is(
  (select array[base_alicuota_general, iva_alicuota_general, alicuota_general,
                base_alicuota_reducida, iva_alicuota_reducida, alicuota_reducida, base_exenta]
     from libro where invoice_id = 'aaaa0084-0000-4000-8000-0000000000f1'),
  array[100, 16, 0.16, 200, 16, 0.08, 100]::numeric[],
  'f1: 16 % y 8 % por separado, exento aparte');
select is(
  (select array[base_alicuota_general, iva_alicuota_general]
     from libro where invoice_id = 'aaaa0084-0000-4000-8000-0000000000e1'),
  array[-50, -8]::numeric[], 'la NC sobre la línea del 16 % resta del 16 %');
select is(
  (select array[base_exenta, base_gravada, base_sin_clasificar]
     from platform.purchases_book('aaaa0084-0000-4000-8000-0000000000a2', '2026-07-01', '2026-07-31')
    where invoice_id = 'aaaa0084-0000-4000-8000-0000000000e2'),
  array[-30, 0, 0]::numeric[],
  'A2: la NC sobre una línea EXENTA resta de exentas en el libro, no de gravadas ni sin clasificar');
select is(
  (select array[base_alicuota_general, iva_alicuota_general, iva_sin_clasificar]
     from libro where invoice_id = 'aaaa0084-0000-4000-8000-0000000000f2'),
  array[0, 0, 0]::numeric[], 'la anulada en su período vale cero por alícuota');
select is(
  (select array[base_gravada_sin_alicuota, iva_sin_clasificar,
                base_alicuota_general + base_alicuota_reducida - base_gravada]
     from libro where invoice_id = 'aaaa0084-0000-4000-8000-0000000000f3'),
  array[0, 0, 0]::numeric[],
  'A1: con fx de 8 decimales y dos alícuotas, el redondeo no deja residuo sin alícuota');
select is(
  (select array[iva_credito, iva_al_costo, iva_alicuota_general]
     from libro where invoice_id = 'aaaa0084-0000-4000-8000-0000000000f4'),
  array[0, 16, 16]::numeric[],
  'sin crédito recuperable: el IVA va al costo y sigue discriminado por alícuota');
select is((select sum(tax) from resumen), (select sum(iva_credito + iva_al_costo) from libro),
  'Σ IVA del resumen = Σ IVA del libro de compras');
select is((select sum(base) from resumen),
  (select sum(base_gravada + base_exenta + base_exonerada + base_no_sujeta + base_sin_clasificar)
     from libro),
  'Σ bases del resumen = Σ de todas las bases del libro de compras');
select is((select count(*) from resumen where concept = 'sin_clasificar'), 0::bigint,
  'A1: el resumen no trae una fila «sin_clasificar» falsa por redondeo');
select is((select base from resumen where concept = 'exento'), 70::numeric,
  'A2: el resumen trae las exentas netas de su NC: 100 − 30');

-- ── 2. El mes en curso: ajuste de período anterior y recibida con retraso ───
select is(
  (select array[base_alicuota_general, iva_alicuota_general, base_gravada_sin_alicuota,
                iva_sin_clasificar]
     from libro_m0 where status = 'ajuste_periodo_anterior'),
  array[-100, -16, 0, 0]::numeric[],
  'el ajuste de período anterior (factor −1) resta por alícuota, sin residuo');
select is(
  (select array[base_alicuota_general, iva_alicuota_general, base_gravada_sin_alicuota]
     from libro_m0 where invoice_id = 'aaaa0084-0000-4000-8000-0000000000f6' and received_late),
  array[100, 16, 0]::numeric[], 'la recibida con retraso entra en su período de registro, por alícuota');
select is(
  (select count(*) from libro_m0 where base_gravada_sin_alicuota <> 0 or iva_sin_clasificar <> 0),
  0::bigint, 'A3: en el mes en curso tampoco queda nada sin alícuota');

-- ── 3. Aislamiento ───────────────────────────────────────────────────────────
set local role ladino_api;
select set_config('ladino.actor_id', 'aaaa0084-0000-4000-8000-0000000000b1', true);
select is(
  (select count(*) from platform.purchases_book_by_rate('aaaa0084-0000-4000-8000-0000000000a2',
     '2026-07-01', '2026-07-31')),
  0::bigint, 'el actor de otro tenant no lee el libro de compras por alícuota de A');
reset role;
alter function platform.purchases_book_by_rate(uuid, date, date) security definer;
set local role ladino_api;
select ok(
  (select count(*) from platform.purchases_book_by_rate('aaaa0084-0000-4000-8000-0000000000a2',
     '2026-07-01', '2026-07-31')) > 0,
  'ROTA: como SECURITY DEFINER lo leería: el 0 de arriba es de INVOKER');
reset role;
alter function platform.purchases_book_by_rate(uuid, date, date) security invoker;

-- ── 4. H10 y H12 ─────────────────────────────────────────────────────────────
select has_column('public', 'products', 'reduced_rate_literal_code',
  'el producto guarda el literal del art. 64 que lo hace reducido');
select throws_ok($$
  insert into public.tax_reduced_rate_literals (code, product_tax_category, description,
                                                legal_source, source_status)
  values ('64.z', 'exento', 'x', 'LIVA art. 64 — prueba', 'fuente_secundaria') $$,
  '23514', null, 'la lista del art. 64 solo admite la categoría reducida');
select throws_ok($$
  update public.products set reduced_rate_literal_code = '64.no-existe'
   where id = 'aaaa0084-0000-4000-8000-00000000d00a' $$,
  '23503', null, 'un literal que no está en la lista no se guarda en el producto (FK)');
select throws_ok($$
  insert into public.tax_reduced_rate_literals (code, product_tax_category, description,
                                                legal_source, source_status)
  values ('64.a', 'gravado_reducida', 'x', 'LIVA art. 64 — prueba', 'pendiente') $$,
  '23514', null, 'un literal sin estado de fuente admitido no entra');
select is(
  (select source_status from public.tax_rule_templates
    where product_tax_category = 'gravado_general'),
  'fuente_secundaria', 'la general es «fuente secundaria» hasta archivar la Gaceta (P-44)');
select is(
  (select count(*) from public.tax_rule_templates
    where product_tax_category = 'gravado_general' and offered_in_sales),
  1::bigint, 'y se sigue ofreciendo: nada filtra por «verificada»');

select * from finish();
rollback;
