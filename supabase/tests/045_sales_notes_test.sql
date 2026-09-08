-- =============================================================================
-- Ladino — pgTAP 45 · Notas de débito/crédito y el cierre de R-20 (ADR-0051)
--
--   1. el vocabulario ganó 'sales_debit_note' en sus tres casas;
--   2. el preset ve_basico trae los TRES asientos nuevos con sus líneas;
--   3. el papel «Saldos a favor de clientes» y su cuenta de plantilla existen;
--   4. la cobertura contable VE una NC sin asiento (antes ni aparecía — R-20)
--      y se calma cuando la NC está encolada;
--   5. el aging envejece la familia completa: factura, RECIBO y nota de
--      débito con saldo — no solo 'invoice'.
-- =============================================================================

begin;
select plan(12);

-- ── 1. Vocabulario en las tres casas ────────────────────────────────────────
select ok(
  (select pg_get_constraintdef(oid) like '%sales_debit_note%'
     from pg_constraint where conname = 'journal_entries_source_kind_chk'),
  'journal_entries acepta sales_debit_note');
select ok(
  (select pg_get_constraintdef(oid) like '%sales_debit_note%'
     from pg_constraint where conname = 'journal_templates_source_kind_chk'),
  'journal_templates acepta sales_debit_note');
select ok(
  (select pg_get_constraintdef(oid) like '%sales_debit_note%'
     from pg_constraint where conname = 'journal_template_preset_entries_kind_chk'),
  'el preset acepta sales_debit_note');

-- ── 2. Los tres asientos del preset, con sus líneas ─────────────────────────
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'sales_credit_note'
      and e.source_event = 'fiscal.credit_note.issued'),
  3::bigint, 'la NC emitida tiene su asiento de 3 líneas en el preset');
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'sales_debit_note'
      and e.source_event = 'fiscal.debit_note.issued'),
  3::bigint, 'la ND emitida tiene su asiento de 3 líneas en el preset');
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'payment_received'
      and e.source_event = 'ar.credit_applied'
      and l.account_purpose in ('customer_credit_liability', 'ar_general',
                                'exchange_gain', 'exchange_loss')),
  4::bigint, 'aplicar saldo a favor tiene su asiento propio: baja el pasivo, no toca caja');

-- ── 3. El papel y su cuenta de plantilla ────────────────────────────────────
select ok(
  exists (select 1 from public.account_purposes where code = 'customer_credit_liability'),
  'el papel «Saldos a favor de clientes» existe');
select ok(
  exists (select 1 from public.chart_template_accounts
           where template_code = 've_basico' and code = '2.1.90'
             and suggested_purpose = 'customer_credit_liability'),
  'y la plantilla ve_basico trae su cuenta 2.1.90');

-- ── Fixture: empresa con formatos_libres (facturas, NC, ND) ─────────────────
insert into public.tenants (id, name) values
  ('aaaa0045-0000-4000-8000-00000000000a', 'Tenant 45');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0045-0000-4000-8000-0000000000a1', 'aaaa0045-0000-4000-8000-00000000000a',
   'J-45-A', 'Notas C.A.', 'VES'),
  ('aaaa0045-0000-4000-8000-0000000000a2', 'aaaa0045-0000-4000-8000-00000000000a',
   'PEND-45B', 'Bodega recibos 45', 'VES');
insert into public.customers (id, tenant_id, company_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0045-0000-4000-8000-00000000c001', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a1', 'Cliente 45', 'natural', 'consumidor_final'),
  ('aaaa0045-0000-4000-8000-00000000c002', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a2', 'Cliente 45 B', 'natural', 'consumidor_final');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0045-0000-4000-8000-00000000000a', 'aaaa0045-0000-4000-8000-0000000000a1',
   'formatos_libres', now() - interval '100 days'),
  ('aaaa0045-0000-4000-8000-00000000000a', 'aaaa0045-0000-4000-8000-0000000000a2',
   'sin_facturacion', now() - interval '100 days');

select set_config('ladino.actor_id', 'aaaa0045-0000-4000-8000-00000000aaaa', true);
select set_config('ladino.rules_version', 'test-045', true);

-- Factura, ND y NC emitidas (números puestos a mano: aquí se prueba deuda y
-- cobertura, no la numeración — esa la prueban 021 y las e2e).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0045-0000-4000-8000-00000000f001', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a1', 'invoice', 'A',
   'aaaa0045-0000-4000-8000-00000000c001', 4501, 4501, 'issued',
   now() - interval '40 days',
   (select regime_version_id from platform.regime_at('aaaa0045-0000-4000-8000-0000000000a1', now() - interval '40 days')), 'test-045', 'VES', 'VES', 1, 'identidad',
   116, 116, 100, 16, 116),
  ('aaaa0045-0000-4000-8000-00000000f002', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a1', 'debit_note', 'A',
   'aaaa0045-0000-4000-8000-00000000c001', 4502, 4502, 'issued',
   now() - interval '5 days',
   (select regime_version_id from platform.regime_at('aaaa0045-0000-4000-8000-0000000000a1', now() - interval '5 days')), 'test-045', 'VES', 'VES', 1, 'identidad',
   58, 58, 50, 8, 58),
  ('aaaa0045-0000-4000-8000-00000000f003', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a1', 'credit_note', 'A',
   'aaaa0045-0000-4000-8000-00000000c001', 4503, 4503, 'issued',
   now() - interval '3 days',
   (select regime_version_id from platform.regime_at('aaaa0045-0000-4000-8000-0000000000a1', now() - interval '3 days')), 'test-045', 'VES', 'VES', 1, 'identidad',
   23.2, 23.2, 20, 3.2, 23.2);
-- Y el recibo fiado de la bodega (empresa B, modo sin_facturacion).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number,
   status, issued_at, regime_version_id, rules_version, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0045-0000-4000-8000-00000000f004', 'aaaa0045-0000-4000-8000-00000000000a',
   'aaaa0045-0000-4000-8000-0000000000a2', 'receipt', 'R',
   'aaaa0045-0000-4000-8000-00000000c002', 1, 'issued',
   now() - interval '70 days',
   (select regime_version_id from platform.regime_at('aaaa0045-0000-4000-8000-0000000000a2', now() - interval '70 days')), 'test-045', 'VES', 'VES', 1, 'identidad',
   200, 200, 200, 0, 200);

-- ── 4. La cobertura VE la NC huérfana, y se calma encolada ──────────────────
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0045-0000-4000-8000-0000000000a1')
    where source_kind = 'sales_credit_note' and problem = 'missing'),
  1::bigint, 'una NC emitida sin asiento y sin cola ES un hueco de cobertura (R-20 cerrado)');

insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0045-0000-4000-8000-00000000000a', 'aaaa0045-0000-4000-8000-0000000000a1',
        'sales_credit_note', 'aaaa0045-0000-4000-8000-00000000f003',
        'fiscal.credit_note.issued', '{"total":"23.2"}', 'encolada por el test 045');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0045-0000-4000-8000-0000000000a1')
    where source_kind = 'sales_credit_note'),
  0::bigint, 'encolada, deja de ser hueco: pendiente visible no es agujero');

-- ── 5. El aging envejece la familia completa ────────────────────────────────
select is(
  (select count(*) from platform.ar_aging('aaaa0045-0000-4000-8000-0000000000a1',
                                          'aaaa0045-0000-4000-8000-00000000c001')),
  2::bigint, 'factura Y nota de débito con saldo envejecen (la ND es deuda)');
select is(
  (select sum(amount)::text from platform.ar_aging('aaaa0045-0000-4000-8000-0000000000a2',
                                                   'aaaa0045-0000-4000-8000-00000000c002')),
  '200.00000000', 'el recibo fiado también envejece: la deuda no depende del RIF');

select * from finish();
rollback;
