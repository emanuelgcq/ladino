-- =============================================================================
-- Ladino — pgTAP 81 · LAS ALÍCUOTAS SON UN CATÁLOGO CON FUENTE (ADR-0073; B-02, B-04, E-18)
--
--   1. el catálogo de plataforma trae cada alícuota con norma, artículo, Gaceta y vigencia
--      exactamente como IVA_SPEC.md; lo «pendiente de fuente» NO se siembra (no_sujeto, art. 62);
--      lo exonerado solo para importación (Decreto 5.196), no se ofrece en ventas;
--   2. la cesta básica (LIVA art. 18.1) por literal, cada uno «fuente secundaria»;
--   3. aceptar la general: 0 % rechazado, fuera de 8–16,5 % rechazado (LAD97);
--   4. aceptar crea la general, la adicional SUMADA a la general, la reducida y la exenta
--      (estas dos desde el catálogo, con su cita, no «aceptadas por el dueño»);
--   5. aceptar OTRA tasa cierra la vigencia actual y abre otra desde la fecha efectiva (B-02);
--      el mismo día, la anterior queda inactiva; la misma tasa no crea nada;
--   6. la defensa en la tabla: una general propia fuera de rango no entra por ningún camino,
--      y su variante ROTA (sin el trigger entra);
--   7. el catálogo es de lectura: authenticated y ladino_api lo leen y no lo escriben.
-- =============================================================================

begin;
select plan(37);

insert into public.tenants (id, name) values
  ('aaaa0081-0000-4000-8000-00000000000a', 'Tenant 81-A');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0081-0000-4000-8000-0000000000a2', 'aaaa0081-0000-4000-8000-00000000000a',
        'J-81-A', 'Alícuotas 81 A', 'VES');

-- ── 1. El catálogo, con sus citas ────────────────────────────────────────────
select is(
  (select rate from public.tax_rule_templates where product_tax_category = 'gravado_general'),
  0.16::numeric, 'la general del catálogo es 16 %');
select ok(
  (select legal_source like '%Decreto%4.079%' and legal_source like '%41.788%'
          and legal_source like '%art. 27%'
     from public.tax_rule_templates where product_tax_category = 'gravado_general'),
  'la general cita el Decreto 4.079 (G.O. 41.788) sobre el art. 27, no la Ley de Presupuesto');
select is(
  (select array[rate_min, rate_max] from public.tax_rule_templates
    where product_tax_category = 'gravado_general'),
  array[0.08, 0.165]::numeric[], 'el rango de la general es el del art. 27: 8–16,5 %');
select is(
  (select effective_from from public.tax_rule_templates
    where product_tax_category = 'gravado_general'),
  '2020-01-01'::date, 'la general rige desde el 01-01-2020 (Decreto 4.079)');
select ok(
  (select rate = 0.08 and legal_source like '%art. 64%'
     from public.tax_rule_templates where product_tax_category = 'gravado_reducida'),
  'la reducida: 8 %, LIVA art. 64');
select ok(
  (select rate = 0.15 and adds_to_category = 'gravado_general' and legal_source like '%art. 61%'
     from public.tax_rule_templates where product_tax_category = 'gravado_adicional'),
  'la adicional suntuaria: 15 % SUMADA a la general, LIVA art. 61');
select ok(
  (select rate = 0 and legal_source like '%arts. 17%19%'
     from public.tax_rule_templates where product_tax_category = 'exento'),
  'la exenta: 0 %, LIVA arts. 17-19');
select is(
  (select count(*) from public.tax_rule_templates where product_tax_category = 'no_sujeto'),
  0::bigint, 'no_sujeto (art. 16) está pendiente de fuente: NO se siembra');
select is(
  (select count(*) from public.tax_rule_templates where legal_source ilike '%art. 62%'),
  0::bigint, 'la adicional del art. 62 (pagos en divisas) NO se siembra: sin decreto que la active');
select ok(
  (select scope = 'importacion' and not offered_in_sales and legal_source like '%5.196%'
          and effective_to = '2027-01-01'
     from public.tax_rule_templates where product_tax_category = 'exonerado'),
  'lo exonerado: solo importación (Decreto 5.196, hasta el 31-12-2026), no se ofrece en ventas');
select is(
  (select count(*) from public.tax_rule_templates
    where offered_in_sales and product_tax_category not in
          ('gravado_general', 'gravado_reducida', 'gravado_adicional', 'exento')),
  0::bigint, 'en ventas se ofrecen solo general, reducida, adicional y exenta');
select is(
  (select count(*) from public.tax_rule_templates
    where source_status not in ('verificada', 'fuente_secundaria')),
  0::bigint, 'ninguna plantilla sin estado de fuente');

-- ── 2. La cesta básica por literal ───────────────────────────────────────────
select is((select count(*) from public.tax_exemption_literals where code like '18.1.%'),
  21::bigint, 'los 21 literales del art. 18.1 (a–u) de IVA_SPEC.md');
select is(
  (select count(*) from public.tax_exemption_literals where source_status <> 'fuente_secundaria'),
  0::bigint, 'cada literal marcado «fuente secundaria» (no cotejado con la G.O. 6.507)');
select ok(
  (select description ilike '%harina%' from public.tax_exemption_literals where code = '18.1.d'),
  '18.1.d es la harina de origen vegetal');
select is(
  (select count(*) from public.tax_exemption_literals where description ilike '%sorgo%'),
  0::bigint, 'el literal pendiente de fuente (maíz, sorgo, soya…) NO se siembra');

-- ── 3. La aceptación rechaza lo que no es una general ───────────────────────
select throws_ok(
  $$ select * from platform.accept_general_vat('aaaa0081-0000-4000-8000-0000000000a2', 0, '2026-09-01') $$,
  'LAD97', null, 'el 0 % no es una alícuota general: LAD97');
select throws_ok(
  $$ select * from platform.accept_general_vat('aaaa0081-0000-4000-8000-0000000000a2', 0.17, '2026-09-01') $$,
  'LAD97', null, 'por encima del 16,5 %: LAD97');
select throws_ok(
  $$ select * from platform.accept_general_vat('aaaa0081-0000-4000-8000-0000000000a2', 0.07, '2026-09-01') $$,
  'LAD97', null, 'por debajo del 8 %: LAD97');
select is(
  (select count(*) from public.tax_rules where company_id = 'aaaa0081-0000-4000-8000-0000000000a2'),
  0::bigint, 'los rechazos no dejaron ni una regla');

-- ── 4. Aceptar crea la general y lo que viene del catálogo ──────────────────
select is(
  (select rules_created from platform.accept_general_vat(
     'aaaa0081-0000-4000-8000-0000000000a2', 0.16, '2026-09-01')),
  8, 'aceptar el 16 % crea 8 reglas: general, adicional, reducida y exenta × venta y compra');
select is(
  (select rate from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-15',
     'VE', 'iva', 'ordinario', 'gravado_reducida')),
  0.08::numeric, 'la reducida se vende al 8 %');
select is(
  (select rate from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-15',
     'VE', 'iva', 'ordinario', 'gravado_adicional')),
  0.31::numeric, 'la adicional se vende al 16 % + 15 %');
select ok(
  (select legal_source like '%arts. 17%19%' and legal_source not ilike '%aceptada%'
     from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-15',
       'VE', 'iva', 'ordinario', 'exento')),
  'la exenta cita la ley, no «aceptada por el dueño» (B-04)');
select is(
  (select rules_created from platform.accept_general_vat(
     'aaaa0081-0000-4000-8000-0000000000a2', 0.16, '2026-09-10')),
  0, 'aceptar la MISMA tasa otra vez no crea nada');

-- ── 5. Aceptar otra tasa cierra la vigencia y abre otra (B-02) ──────────────
select is(
  (select rules_closed from platform.accept_general_vat(
     'aaaa0081-0000-4000-8000-0000000000a2', 0.15, '2026-09-20')),
  4, 'aceptar el 15 % cierra la general y la adicional vigentes (venta y compra)');
select is(
  (select rate from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-19',
     'VE', 'iva', 'ordinario', 'gravado_general')),
  0.16::numeric, 'el día anterior a la fecha efectiva sigue siendo 16 %');
select is(
  (select rate from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-20',
     'VE', 'iva', 'ordinario', 'gravado_general')),
  0.15::numeric, 'desde la fecha efectiva es 15 %: el acta SE APLICA');
select is(
  (select rate from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-20',
     'VE', 'iva', 'ordinario', 'gravado_adicional')),
  0.30::numeric, 'y la adicional sigue a la general: 15 % + 15 %');
select is(
  (select effective_to from public.tax_rules
    where company_id = 'aaaa0081-0000-4000-8000-0000000000a2' and rate = 0.16
      and product_tax_category = 'gravado_general' and transaction_type = 'sale'),
  '2026-09-20'::date, 'la regla del 16 % queda cerrada en la fecha efectiva, no borrada');
-- El mismo día: la del 15 % nació el 20 y se reemplaza el 20.
select is(
  (select rules_closed from platform.accept_general_vat(
     'aaaa0081-0000-4000-8000-0000000000a2', 0.165, '2026-09-20')),
  4, 'reaceptar el MISMO día retira las del día (no hay vigencia de cero días)');
select is(
  (select count(*) from public.tax_rules
    where company_id = 'aaaa0081-0000-4000-8000-0000000000a2' and rate = 0.15
      and status = 'inactive'),
  2::bigint, 'las del 15 % quedan inactivas, con su historia');
select lives_ok(
  $$ select * from platform.resolve_tax('aaaa0081-0000-4000-8000-0000000000a2', '2026-09-25',
       'VE', 'iva', 'ordinario', 'gravado_general') $$,
  'y el catálogo de la empresa no queda ambiguo');

-- ── 6. La defensa en la tabla, y su variante rota ───────────────────────────
select throws_ok($$
  insert into public.tax_rules
    (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, transaction_type,
     product_tax_category, rate, effective_from, legal_source, priority)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          'VE', 'iva', 'especial', 'sale', 'gravado_general', 0, '2026-09-25',
          'REGLA DE PRUEBA pgTAP 081 — general de cero', 50) $$,
  'LAD97', null, 'una general propia del 0 % no entra ni por INSERT directo');
alter table public.tax_rules disable trigger tax_rules_02_general_in_range;
select lives_ok($$
  insert into public.tax_rules
    (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, transaction_type,
     product_tax_category, rate, effective_from, legal_source, priority)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          'VE', 'iva', 'especial', 'sale', 'gravado_general', 0, '2026-09-25',
          'REGLA DE PRUEBA pgTAP 081 — general de cero', 50) $$,
  'ROTA: sin el trigger, la general del 0 % entra: el LAD97 de arriba es suyo');
alter table public.tax_rules enable trigger tax_rules_02_general_in_range;

-- ── 7. El catálogo se lee y no se escribe ───────────────────────────────────
set local role ladino_api;
select ok((select count(*) from public.tax_rule_templates) >= 5,
  'ladino_api lee el catálogo de alícuotas');
select throws_ok($$
  insert into public.tax_rule_templates
    (product_tax_category, rate, requires_acceptance, offered_in_sales, scope, legal_norm,
     legal_article, effective_from, source_status, legal_source)
  values ('gravado_general', 0.5, true, true, 'interna', 'x', 'x', '2026-01-01', 'verificada',
          'inventada') $$,
  '42501', null, 'ladino_api no escribe el catálogo: 42501');
reset role;

select * from finish();
rollback;
