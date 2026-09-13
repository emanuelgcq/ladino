-- =============================================================================
-- Ladino — pgTAP 48 · EL DÍA DEL NEGOCIO ES EL DE CARACAS (migración 48, ADR-0054)
--
-- La prueba que CLAUDE.md §3 pide para esta familia de bugs: «si el test pasa
-- a las tres de la tarde y falla a las 23:59, es este bug». Aquí se emite a las
-- 23:30 de Venezuela del último día de agosto (= 03:30 UTC del 1 de
-- septiembre) y se asevera que el libro de ventas la pone en AGOSTO, que la
-- antigüedad la fecha en agosto, y que el saldo en la moneda del documento
-- valora un cobro nocturno con la tasa del día venezolano del pago.
-- =============================================================================

begin;
select plan(9);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0048-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0048-0000-4000-8000-00000000000a', 'Tenant 48');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0048-0000-4000-8000-0000000000a2', 'aaaa0048-0000-4000-8000-00000000000a',
   'J-48-A', 'Empresa 48', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0048-0000-4000-8000-00000000c001', 'aaaa0048-0000-4000-8000-00000000000a',
   'aaaa0048-0000-4000-8000-0000000000a2', 'J-CLI-48', 'Cliente 48', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0048-0000-4000-8000-00000000e101', 'aaaa0048-0000-4000-8000-00000000000a',
        'aaaa0048-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
select set_config('ladino.actor_id', 'aaaa0048-0000-4000-8000-0000000000a1', true);

-- ── 1. La función de corte ───────────────────────────────────────────────────
select is(platform.caracas_day('2026-09-01T03:30:00Z'::timestamptz), '2026-08-31'::date,
  '03:30 UTC del 1 de septiembre es todavía el 31 de agosto en Caracas');
select is(platform.caracas_day('2026-09-01T04:00:00Z'::timestamptz), '2026-09-01'::date,
  'y a las 04:00 UTC ya es 1 de septiembre en Caracas');
select is(('2026-09-01T03:30:00Z'::timestamptz)::date, '2026-09-01'::date,
  'CONTROL: el cast a secas en esta sesión (UTC) dice 1 de septiembre — ese es el bug que se cierra');

-- ── 2. El libro de ventas pone la factura nocturna en agosto ────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0048-0000-4000-8000-00000000f001', 'aaaa0048-0000-4000-8000-00000000000a',
   'aaaa0048-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0048-0000-4000-8000-00000000c001', 1, 4801, 'issued', '2026-09-01T03:30:00Z',
   'aaaa0048-0000-4000-8000-00000000e101', 'test-048', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160);

select is(
  (select count(*) from platform.sales_book('aaaa0048-0000-4000-8000-0000000000a2',
                                            '2026-08-01', '2026-08-31')),
  1::bigint, 'el libro de AGOSTO contiene la factura de las 23:30 de Caracas del 31');
select is(
  (select count(*) from platform.sales_book('aaaa0048-0000-4000-8000-0000000000a2',
                                            '2026-09-01', '2026-09-30')),
  0::bigint, 'y el de SEPTIEMBRE no: la misma factura no puede estar en dos meses');
select is(
  (select issued_on from platform.sales_book('aaaa0048-0000-4000-8000-0000000000a2',
                                             '2026-08-01', '2026-08-31')),
  '2026-08-31'::date, 'issued_on del libro es el día de Caracas, no el de UTC');

-- ── 3. La antigüedad también cuenta desde el día de Caracas ─────────────────
select is(
  (select bucket from platform.ar_aging('aaaa0048-0000-4000-8000-0000000000a2',
                                        'aaaa0048-0000-4000-8000-00000000c001',
                                        '2026-09-30'::date)),
  '0-30', 'al 30 de septiembre la factura del 31 de agosto tiene 30 días: bucket 0-30');
select is(
  (select bucket from platform.ar_aging('aaaa0048-0000-4000-8000-0000000000a2',
                                        'aaaa0048-0000-4000-8000-00000000c001',
                                        '2026-10-01'::date)),
  '31-60', 'y al 1 de octubre, 31: el día extra que UTC le habría quitado ya no se lo quita');

-- ── 4. El saldo en la moneda del documento valora el cobro con el día venezolano ──
-- Documento en USD (tasa 40 al emitir). Cobro en Bs a las 23:00 de Caracas del
-- 31 de agosto (03:00 UTC del 1/09). Hay tasa USD→VES del 31 (45) y del 1 (50):
-- el cobro debe valorarse a 45, no a 50.
insert into public.exchange_rates (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
values ('USD', 'VES', 45, '2026-08-31', now(), 'test-048'),
       ('USD', 'VES', 50, '2026-09-01', now(), 'test-048')
on conflict on constraint exchange_rates_day_key do nothing;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0048-0000-4000-8000-00000000f002', 'aaaa0048-0000-4000-8000-00000000000a',
   'aaaa0048-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0048-0000-4000-8000-00000000c001', 2, 4802, 'issued', '2026-08-30T15:00:00Z',
   'aaaa0048-0000-4000-8000-00000000e101', 'test-048', 'USD', 'VES', 40, 'test',
   100, 4000, 3448.27586207, 551.72413793, 4000);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind)
values ('aaaa0048-0000-4000-8000-00000000ac01', 'aaaa0048-0000-4000-8000-00000000000a',
        'aaaa0048-0000-4000-8000-0000000000a2', 'Caja 48', 'VES', 'cash');
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values
  ('aaaa0048-0000-4000-8000-00000000f101', 'aaaa0048-0000-4000-8000-00000000000a',
   'aaaa0048-0000-4000-8000-0000000000a2', 'aaaa0048-0000-4000-8000-00000000f002',
   '2026-09-01T03:00:00Z', 'VES', 2250, 1, 'identidad', now(), 2250, 'efectivo_bs',
   'aaaa0048-0000-4000-8000-00000000ac01');

select is(
  platform.document_balance_transaction('aaaa0048-0000-4000-8000-0000000000a2',
                                        'aaaa0048-0000-4000-8000-00000000f002'),
  50::numeric,
  '2 250 Bs pagados a las 23:00 de Caracas del 31 valen 50 USD (tasa 45 del 31), no 45 USD (tasa 50 del 1)');

select * from finish();
rollback;
