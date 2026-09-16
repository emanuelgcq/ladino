-- =============================================================================
-- Ladino — pgTAP 62 · EL CÉNTIMO DE LA CAJA (migración 62, ADR-0063 §4)
--
--   1-2. `currency_minor_units`: la escala de la moneda, y 2 si no está;
--   3. la deuda de hoy de un documento en divisa, SIN cobros y a la tasa de
--      emisión, es EXACTAMENTE su total funcional (y en céntimos);
--   4. VARIANTE ROTA: la fórmula vieja (saldo × tasa, a ocho decimales) no lo
--      era — el «Total Bs 21.493,12 · Saldo Bs 21.493,114984» del QA;
--   5. si la tasa se movió desde la emisión, la deuda se reindexa en la misma
--      proporción y sigue en céntimos;
--   6. un documento en la moneda funcional: su saldo, en céntimos.
-- =============================================================================

begin;
select plan(6);

insert into public.tenants (id, name) values
  ('aaaa0062-0000-4000-8000-00000000000a', 'Tenant 62');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0062-0000-4000-8000-0000000000a2', 'aaaa0062-0000-4000-8000-00000000000a',
   'J-62-A', 'Empresa 62', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0062-0000-4000-8000-00000000c001', 'aaaa0062-0000-4000-8000-00000000000a',
   'aaaa0062-0000-4000-8000-0000000000a2', 'J-CLI-62', 'Cliente 62', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0062-0000-4000-8000-00000000e101', 'aaaa0062-0000-4000-8000-00000000000a',
        'aaaa0062-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- La tasa de HOY de esta empresa: la del QA, que destapaba los decimales.
insert into public.exchange_rates
  (from_currency, to_currency, rate, source, rate_date, rate_timestamp, tenant_id, company_id)
values ('USD', 'VES', 842.2067, 'prueba-62', platform.caracas_day(now()), now(),
        'aaaa0062-0000-4000-8000-00000000000a', 'aaaa0062-0000-4000-8000-0000000000a2');

-- F1: USD 25,52 emitida HOY a 842,2067. Su total funcional se congeló sumando los renglones
-- ya redondeados (PER_LINE): 21.493,12, no 25,52 × 842,2067 = 21.493,114984.
-- F2: USD 10 emitida a 800 (la tasa se movió desde entonces). F3: en bolívares.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0062-0000-4000-8000-00000000f001', 'aaaa0062-0000-4000-8000-00000000000a',
   'aaaa0062-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0062-0000-4000-8000-00000000c001', 1, 6201, 'issued', now(),
   'aaaa0062-0000-4000-8000-00000000e101', 'test-062', 'USD', 'VES', 842.2067, 'prueba-62',
   25.52, 21493.12, 18528.55, 2964.57, 21493.12),
  ('aaaa0062-0000-4000-8000-00000000f002', 'aaaa0062-0000-4000-8000-00000000000a',
   'aaaa0062-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0062-0000-4000-8000-00000000c001', 2, 6202, 'issued', now() - interval '5 days',
   'aaaa0062-0000-4000-8000-00000000e101', 'test-062', 'USD', 'VES', 800, 'prueba-62',
   10, 8000, 6896.55, 1103.45, 8000),
  ('aaaa0062-0000-4000-8000-00000000f003', 'aaaa0062-0000-4000-8000-00000000000a',
   'aaaa0062-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0062-0000-4000-8000-00000000c001', 3, 6203, 'issued', now(),
   'aaaa0062-0000-4000-8000-00000000e101', 'test-062', 'VES', 'VES', 1, 'identidad',
   1160.004, 1160.004, 1000.004, 160, 1160.004);

select is(platform.currency_minor_units('VES'), 2, 'el bolívar se paga a céntimos');
select is(platform.currency_minor_units('ZZZ'), 2, 'una moneda que no está: 2, no un error');

select is(
  platform.document_debt_today('aaaa0062-0000-4000-8000-0000000000a2',
                               'aaaa0062-0000-4000-8000-00000000f001'),
  21493.12::numeric,
  'sin cobros y a la tasa de emisión, la deuda ES el total, al céntimo');

select isnt(
  round(platform.document_balance_transaction('aaaa0062-0000-4000-8000-0000000000a2',
                                              'aaaa0062-0000-4000-8000-00000000f001')
        * 842.2067, 8),
  21493.12::numeric,
  'VARIANTE ROTA: saldo en divisa × tasa, a ocho decimales, NO daba el total');

select is(
  platform.document_debt_today('aaaa0062-0000-4000-8000-0000000000a2',
                               'aaaa0062-0000-4000-8000-00000000f002'),
  round(8000 * (842.2067::numeric / 800), 2),
  'si la tasa se movió, la deuda se reindexa en la misma proporción, en céntimos');

select is(
  platform.document_debt_today('aaaa0062-0000-4000-8000-0000000000a2',
                               'aaaa0062-0000-4000-8000-00000000f003'),
  1160.00::numeric,
  'un documento en bolívares: su saldo, servido en céntimos');

select * from finish();
rollback;
