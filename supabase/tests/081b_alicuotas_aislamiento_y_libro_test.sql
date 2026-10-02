-- =============================================================================
-- Ladino — pgTAP 81b · ALÍCUOTAS: AISLAMIENTO, REGLAS REFERENCIADAS Y EL LIBRO QUE CUADRA
-- (ADR-0073; revisión de la familia: H1, H2, H5)
--
--   1. H1 · aislamiento como ladino_api con el actor de A (membership SOLO en A):
--      accept_general_vat(B) → 23503, seed_catalog_tax_rules(B) → 42501, B sin reglas;
--      sales_book_by_rate y sales_book_summary: 0 filas de B y más de 0 de A.
--      Variantes ROTAS: con SECURITY DEFINER el ataque pasa (se revierte en la transacción).
--   2. H2 · una regla con líneas emitidas no se retira: reaceptar el mismo día → LAD97 con el
--      mensaje de persona, y la regla sigue vigente; al día siguiente, sí (se cierra). El trigger
--      lo impide por cualquier otro camino, con su variante rota.
--   3. H5 · factura (general, reducida, exenta y una línea sin categoría) + NC + anulada:
--      Σ por alícuota = base_gravada / iva_debito por renglón; Σ del resumen = totales del libro;
--      la NC en negativo; la anulada en cero.
-- =============================================================================

begin;
select plan(27);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0082-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0082-0000-4000-8000-0000000000a1', true);
insert into public.tenants (id, name) values
  ('aaaa0082-0000-4000-8000-00000000000a', 'Tenant 81b-A'),
  ('aaaa0082-0000-4000-8000-00000000000b', 'Tenant 81b-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0082-0000-4000-8000-0000000000a2', 'aaaa0082-0000-4000-8000-00000000000a',
        'J-82-A', 'Alícuotas 81b A', 'VES', 'ordinario'),
       ('aaaa0082-0000-4000-8000-0000000000b2', 'aaaa0082-0000-4000-8000-00000000000b',
        'J-82-B', 'Alícuotas 81b B', 'VES', 'ordinario');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0082-0000-4000-8000-0000000000a3', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0082-0000-4000-8000-00000000c00a', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a2', 'J-CLI-82A', 'Cliente 81b A', 'juridica', 'ordinario'),
  ('aaaa0082-0000-4000-8000-00000000c00b', 'aaaa0082-0000-4000-8000-00000000000b',
   'aaaa0082-0000-4000-8000-0000000000b2', 'J-CLI-82B', 'Cliente 81b B', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0082-0000-4000-8000-00000000d00a', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a2', 'SKU-82A', 'Producto 81b A', 'good', 'unidad',
   'gravado_general'),
  ('aaaa0082-0000-4000-8000-00000000d00b', 'aaaa0082-0000-4000-8000-00000000000b',
   'aaaa0082-0000-4000-8000-0000000000b2', 'SKU-82B', 'Producto 81b B', 'good', 'unidad',
   'gravado_general');
-- El tipo de contribuyente con su vigencia (ADR-0072, migración 20260928190000): sin él no se emite.
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values
  ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2', 'ordinario',
   '2026-01-01', null, 'Fixture pgTAP 81', 'test-081'),
  ('aaaa0082-0000-4000-8000-00000000000b', 'aaaa0082-0000-4000-8000-0000000000b2', 'ordinario',
   '2026-01-01', null, 'Fixture pgTAP 81', 'test-081');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0082-0000-4000-8000-00000000e10a', 'aaaa0082-0000-4000-8000-00000000000a',
        'aaaa0082-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01'),
       ('aaaa0082-0000-4000-8000-00000000e10b', 'aaaa0082-0000-4000-8000-00000000000b',
        'aaaa0082-0000-4000-8000-0000000000b2', 'formatos_libres', '2026-01-01');

-- La general de A desde julio: sus reglas (general, adicional, reducida, exenta).
select platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000a2', 0.16, '2026-07-01');

-- A: f01 factura 410 + 33,6 (general 100+16 · reducida 200+16 · exenta 100 · sin categoría
-- 10+1,6) · f02 NC 50+8 sobre f01 · f03 factura ANULADA 300+48. B: f0b factura 100+16.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   annulled_at, annul_reason,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0082-0000-4000-8000-00000000f001', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a2', 'invoice', 'A', 'aaaa0082-0000-4000-8000-00000000c00a',
   1, 8201, 'issued', '2026-07-05T14:00:00Z', 'aaaa0082-0000-4000-8000-00000000e10a', 'test-081b',
   null, null, null, 'VES', 'VES', 1, 'identidad', 443.6, 443.6, 410, 33.6, 443.6),
  ('aaaa0082-0000-4000-8000-00000000f002', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a2', 'credit_note', 'A',
   'aaaa0082-0000-4000-8000-00000000c00a', 1, 8202, 'issued', '2026-07-06T14:00:00Z',
   'aaaa0082-0000-4000-8000-00000000e10a', 'test-081b', 'aaaa0082-0000-4000-8000-00000000f001',
   null, null, 'VES', 'VES', 1, 'identidad', 58, 58, 50, 8, 58),
  ('aaaa0082-0000-4000-8000-00000000f003', 'aaaa0082-0000-4000-8000-00000000000a',
   'aaaa0082-0000-4000-8000-0000000000a2', 'invoice', 'A', 'aaaa0082-0000-4000-8000-00000000c00a',
   2, 8203, 'annulled', '2026-07-08T14:00:00Z', 'aaaa0082-0000-4000-8000-00000000e10a',
   'test-081b', null, '2026-07-08T15:00:00Z', 'No salió del establecimiento',
   'VES', 'VES', 1, 'identidad', 348, 348, 300, 48, 348),
  ('aaaa0082-0000-4000-8000-00000000f00b', 'aaaa0082-0000-4000-8000-00000000000b',
   'aaaa0082-0000-4000-8000-0000000000b2', 'invoice', 'A', 'aaaa0082-0000-4000-8000-00000000c00b',
   1, 8209, 'issued', '2026-07-05T14:00:00Z', 'aaaa0082-0000-4000-8000-00000000e10b', 'test-081b',
   null, null, null, 'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
select v.tenant, v.company, v.doc, v.n, v.prod, 'Línea', 1, v.base, v.base, v.rate, v.iva,
       v.base, v.base, v.base + v.iva, v.base + v.iva, v.base + v.iva, 'VES', 1, v.base + v.iva,
       'VES', 'identidad', now(), 'sales:document:8:HALF_UP', v.cat, v.trat
  from (values
    ('aaaa0082-0000-4000-8000-00000000000a'::uuid, 'aaaa0082-0000-4000-8000-0000000000a2'::uuid,
     'aaaa0082-0000-4000-8000-00000000f001'::uuid, 1, 'aaaa0082-0000-4000-8000-00000000d00a'::uuid,
     100::numeric, 0.16::numeric, 16::numeric, 'gravado_general', 'gravado'),
    ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
     'aaaa0082-0000-4000-8000-00000000f001', 2, 'aaaa0082-0000-4000-8000-00000000d00a',
     200, 0.08, 16, 'gravado_reducida', 'gravado'),
    ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
     'aaaa0082-0000-4000-8000-00000000f001', 3, 'aaaa0082-0000-4000-8000-00000000d00a',
     100, 0, 0, 'exento', 'exento'),
    ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
     'aaaa0082-0000-4000-8000-00000000f001', 4, 'aaaa0082-0000-4000-8000-00000000d00a',
     10, 0.16, 1.6, null, null),
    ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
     'aaaa0082-0000-4000-8000-00000000f002', 1, 'aaaa0082-0000-4000-8000-00000000d00a',
     50, 0.16, 8, 'gravado_general', 'gravado'),
    ('aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
     'aaaa0082-0000-4000-8000-00000000f003', 1, 'aaaa0082-0000-4000-8000-00000000d00a',
     300, 0.16, 48, 'gravado_general', 'gravado'),
    ('aaaa0082-0000-4000-8000-00000000000b', 'aaaa0082-0000-4000-8000-0000000000b2',
     'aaaa0082-0000-4000-8000-00000000f00b', 1, 'aaaa0082-0000-4000-8000-00000000d00b',
     100, 0.16, 16, 'gravado_general', 'gravado')
  ) v(tenant, company, doc, n, prod, base, rate, iva, cat, trat);

-- ── 1. H1 · aislamiento como ladino_api con el actor de A ────────────────────
set local role ladino_api;
select throws_ok(
  $$ select * from platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000b2', 0.16, '2026-07-01') $$,
  '23503', null, 'A no acepta la general de B: la empresa ajena no existe para A (23503)');
select throws_ok(
  $$ select platform.seed_catalog_tax_rules('aaaa0082-0000-4000-8000-0000000000b2', 0.16, '2026-07-01') $$,
  '42501', null, 'A no siembra reglas en B: la policy de insert de tax_rules lo rechaza (42501)');
select is(
  (select count(*) from platform.sales_book_by_rate('aaaa0082-0000-4000-8000-0000000000b2',
     '2026-07-01', '2026-07-31')),
  0::bigint, 'A no lee el libro por alícuota de B');
select is(
  (select count(*) from platform.sales_book_summary('aaaa0082-0000-4000-8000-0000000000b2',
     '2026-07-01', '2026-07-31')),
  0::bigint, 'A no lee el resumen del art. 72 de B');
select ok(
  (select count(*) from platform.sales_book_by_rate('aaaa0082-0000-4000-8000-0000000000a2',
     '2026-07-01', '2026-07-31')) > 0, 'A sí lee su propio libro por alícuota');
select ok(
  (select count(*) from platform.sales_book_summary('aaaa0082-0000-4000-8000-0000000000a2',
     '2026-07-01', '2026-07-31')) > 0, 'A sí lee su propio resumen');
reset role;
select is(
  (select count(*) from public.tax_rules where company_id = 'aaaa0082-0000-4000-8000-0000000000b2'),
  0::bigint, 'B sigue sin una sola regla tras los intentos de A');

-- Variantes ROTAS: con SECURITY DEFINER, el mismo ataque pasa.
alter function platform.sales_book_by_rate(uuid, date, date) security definer;
alter function platform.sales_book_summary(uuid, date, date) security definer;
alter function platform.accept_general_vat(uuid, numeric, date) security definer;
set local role ladino_api;
select ok(
  (select count(*) from platform.sales_book_by_rate('aaaa0082-0000-4000-8000-0000000000b2',
     '2026-07-01', '2026-07-31')) > 0,
  'ROTA: sales_book_by_rate como SECURITY DEFINER devuelve el libro de B: el 0 de arriba es de INVOKER');
select ok(
  (select count(*) from platform.sales_book_summary('aaaa0082-0000-4000-8000-0000000000b2',
     '2026-07-01', '2026-07-31')) > 0,
  'ROTA: sales_book_summary como SECURITY DEFINER resume el libro de B');
select lives_ok(
  $$ select * from platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000b2', 0.16, '2026-07-01') $$,
  'ROTA: accept_general_vat como SECURITY DEFINER acepta la general de B: el 23503 es de INVOKER');
reset role;
alter function platform.sales_book_by_rate(uuid, date, date) security invoker;
alter function platform.sales_book_summary(uuid, date, date) security invoker;
alter function platform.accept_general_vat(uuid, numeric, date) security invoker;
delete from public.tax_rules where company_id = 'aaaa0082-0000-4000-8000-0000000000b2';

-- ── 2. H2 · una regla con líneas emitidas no se retira ──────────────────────
-- A acepta el 15 % el 10-08 y factura ese mismo día con esa regla.
select platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000a2', 0.15, '2026-08-10');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values ('aaaa0082-0000-4000-8000-00000000f004', 'aaaa0082-0000-4000-8000-00000000000a',
        'aaaa0082-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0082-0000-4000-8000-00000000c00a', 3, 8204, 'issued', '2026-08-10T15:00:00Z',
        'aaaa0082-0000-4000-8000-00000000e10a', 'test-081b', 'VES', 'VES', 1, 'identidad',
        115, 115, 100, 15, 115);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rule_id, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
select 'aaaa0082-0000-4000-8000-00000000000a', 'aaaa0082-0000-4000-8000-0000000000a2',
       'aaaa0082-0000-4000-8000-00000000f004', 1, 'aaaa0082-0000-4000-8000-00000000d00a', 'Del día',
       1, 100, 100, t.tax_rule_id, t.rate, 15, 100, 100, 115, 115, 115, 'VES', 1, 115, 'VES',
       'identidad', now(), 'sales:document:8:HALF_UP', 'gravado_general', 'gravado'
  from platform.resolve_tax('aaaa0082-0000-4000-8000-0000000000a2', '2026-08-10', 'VE', 'iva',
                            'ordinario', 'gravado_general') t;

select throws_like(
  $$ select * from platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000a2', 0.16, '2026-08-10') $$,
  'Hoy ya se facturó al 15 %: la nueva tasa puede regir desde mañana%',
  'reaceptar el MISMO día en que ya se facturó: LAD97 con el mensaje de persona');
select throws_ok(
  $$ select * from platform.accept_general_vat('aaaa0082-0000-4000-8000-0000000000a2', 0.16, '2026-08-10') $$,
  'LAD97', null, 'y es LAD97 (422)');
select is(
  (select rate from platform.resolve_tax('aaaa0082-0000-4000-8000-0000000000a2', '2026-08-10',
     'VE', 'iva', 'ordinario', 'gravado_general')),
  0.15::numeric, 'la regla referenciada sigue vigente en su día');
select is(
  (select rules_closed from platform.accept_general_vat(
     'aaaa0082-0000-4000-8000-0000000000a2', 0.16, '2026-08-11')),
  4, 'al día siguiente sí: la general y la adicional del 15 % se CIERRAN');
select is(
  (select array[status, effective_to::text] from public.tax_rules t
    where t.id = (select tax_rule_id from public.document_lines
                   where document_id = 'aaaa0082-0000-4000-8000-00000000f004')),
  array['active', '2026-08-11'], 'la regla de la línea emitida queda activa, cerrada el 11-08');

-- El trigger, por cualquier otro camino.
select throws_ok(
  $$ update public.tax_rules set status = 'inactive'
      where id = (select tax_rule_id from public.document_lines
                   where document_id = 'aaaa0082-0000-4000-8000-00000000f004') $$,
  'LAD97', null, 'una regla con líneas emitidas no pasa a inactive por UPDATE directo');
alter table public.tax_rules disable trigger tax_rules_03_referenced_is_not_retired;
select lives_ok(
  $$ update public.tax_rules set status = 'inactive'
      where id = (select tax_rule_id from public.document_lines
                   where document_id = 'aaaa0082-0000-4000-8000-00000000f004') $$,
  'ROTA: sin el trigger, se retira: el LAD97 de arriba es suyo');
alter table public.tax_rules enable trigger tax_rules_03_referenced_is_not_retired;
update public.tax_rules set status = 'active'
 where id = (select tax_rule_id from public.document_lines
              where document_id = 'aaaa0082-0000-4000-8000-00000000f004');
select is(
  (select count(*) from public.tax_rules r
    where r.company_id is not null and r.status = 'inactive'
      and platform.tax_rule_is_referenced(r.id)),
  0::bigint, 'en toda la base, ninguna regla propia retirada tiene líneas emitidas (150200 §3)');

-- ── 3. H5 · el libro por alícuota cuadra entero ─────────────────────────────
create temporary table libro on commit drop as
  select * from platform.sales_book_by_rate('aaaa0082-0000-4000-8000-0000000000a2',
                                            '2026-07-01', '2026-07-31');
create temporary table resumen on commit drop as
  select * from platform.sales_book_summary('aaaa0082-0000-4000-8000-0000000000a2',
                                            '2026-07-01', '2026-07-31');
select is((select count(*) from libro), 3::bigint, 'el libro de julio trae factura, NC y anulada');
select is(
  (select count(*) from libro
    where base_alicuota_general + base_alicuota_adicional + base_alicuota_reducida
          + base_gravada_sin_alicuota <> base_gravada),
  0::bigint, 'por renglón, Σ base por alícuota (+ sin alícuota) = base_gravada');
select is(
  (select count(*) from libro
    where iva_alicuota_general + iva_alicuota_adicional + iva_alicuota_reducida
          + iva_sin_clasificar <> iva_debito),
  0::bigint, 'por renglón, Σ IVA por alícuota (+ sin clasificar) = iva_debito');
select is(
  (select array[base_alicuota_general, iva_alicuota_general, base_alicuota_reducida,
                iva_alicuota_reducida, iva_sin_clasificar, base_sin_clasificar]
     from libro where kind = 'invoice' and status = 'issued'),
  array[100, 16, 200, 16, 1.6, 10]::numeric[],
  'la factura: general 100+16, reducida 200+16, y la línea sin categoría 10 + 1,6 aparte');
select is(
  (select array[base_alicuota_general, iva_alicuota_general] from libro where kind = 'credit_note'),
  array[-50, -8]::numeric[], 'la NC resta, también por alícuota');
select is(
  (select array[base_alicuota_general, iva_alicuota_general, base_alicuota_reducida,
                iva_sin_clasificar] from libro where status = 'annulled'),
  array[0, 0, 0, 0]::numeric[], 'la anulada vale cero en toda columna por alícuota');
select is((select sum(tax) from resumen), (select sum(iva_debito) from libro),
  'Σ IVA del resumen = Σ iva_debito del libro');
select is((select sum(base) from resumen),
  (select sum(base_gravada + base_exenta + base_exonerada + base_no_sujeta + base_sin_clasificar)
     from libro),
  'Σ bases del resumen = Σ de todas las bases del libro');
select is(
  (select sum(base) from resumen where concept like 'gravado%'),
  (select sum(base_gravada) from libro), 'Σ bases gravadas del resumen = Σ base_gravada');

select * from finish();
rollback;
