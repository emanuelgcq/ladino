-- =============================================================================
-- Ladino — pgTAP 39 · La deuda se ancla en la moneda del documento (ADR-0047)
--
-- El ejemplo del dueño, LITERAL, como test: el lunes el producto vale 1 USD y
-- la tasa es 100 — se fía. El viernes la tasa es 150. La deuda de hoy tiene
-- que decir 150 Bs, no los 100 del lunes: si dijera 100, el que fió perdió
-- 50 Bs de margen por fiar en la moneda que se devalúa.
--
--   1. la factura en divisa vuelve a EMITIRSE (el gate LAD70 de la migración
--      38 cayó con ella) y las columnas pricing_* ya no existen;
--   2. document_balance_transaction: la deuda EN USD, con los cobros en Bs
--      valorados a la tasa del DÍA DEL PAGO;
--   3. document_debt_today: la deuda del lunes, preguntada el viernes, vale
--      viernes;
--   4. pagar los USD completos deja el saldo transacción en CERO aunque la
--      tasa haya cambiado — el ajuste es del diferencial, no del estado.
-- =============================================================================

begin;
select plan(7);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0039-0000-4000-8000-00000000000a', 'Tenant 39');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0039-0000-4000-8000-0000000000a1', 'aaaa0039-0000-4000-8000-00000000000a',
   'J-39-A', 'Bodega que fía, C.A.', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0039-0000-4000-8000-00000000e101', 'aaaa0039-0000-4000-8000-00000000000a',
   'aaaa0039-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.customers (id, tenant_id, company_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0039-0000-4000-8000-00000000c001', 'aaaa0039-0000-4000-8000-00000000000a',
   'aaaa0039-0000-4000-8000-0000000000a1', 'Vecino fiado', 'natural', 'consumidor_final');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0039-0000-4000-8000-000000000ca1', 'aaaa0039-0000-4000-8000-00000000000a',
   'aaaa0039-0000-4000-8000-0000000000a1', 'Caja Bs 39', 'VES', 'cash');

-- El lunes la tasa es 100; el viernes, 150. (Fechas relativas a HOY para que
-- document_debt_today —que pregunta con current_date— vea la del viernes.)
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
values ('USD', 'VES', 100.00000000, 'BCV', current_date - 4, now() - interval '4 days'),
       ('USD', 'VES', 150.00000000, 'BCV', current_date, now());

-- ── 1. La factura en divisa se emite otra vez, y pricing_* no existe ─────────
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name like 'pricing%'),
  0::bigint, 'las columnas pricing_* del interregno (migración 38) se fueron');

select lives_ok(
  $$insert into public.documents
      (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source, rate_timestamp,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0039-0000-4000-8000-00000000f001',
            'aaaa0039-0000-4000-8000-00000000000a', 'aaaa0039-0000-4000-8000-0000000000a1',
            'invoice', 'A', 'aaaa0039-0000-4000-8000-00000000c001', 'issued',
            (current_date - 4)::timestamptz, 1, 101,
            'aaaa0039-0000-4000-8000-00000000e101', 'test-039',
            'USD', 'VES', 100, 'BCV', (current_date - 4)::timestamptz,
            1, 100, 100, 0, 100)$$,
  'El LUNES se fía 1 USD a tasa 100: la factura en divisa se emite (ADR-0047 restituye ADR-0020)');

-- ── 2. La deuda del lunes, preguntada el viernes, vale viernes ───────────────
select is(
  platform.document_balance_transaction('aaaa0039-0000-4000-8000-0000000000a1',
                                        'aaaa0039-0000-4000-8000-00000000f001'),
  1.00000000::numeric,
  'La deuda EN LA MONEDA DEL DOCUMENTO: 1 USD, entera');

select is(
  platform.document_debt_today('aaaa0039-0000-4000-8000-0000000000a1',
                               'aaaa0039-0000-4000-8000-00000000f001'),
  150.00000000::numeric,
  'EL EJEMPLO DEL DUEÑO: la deuda de hoy dice 150 Bs (1 USD × tasa de HOY), no los 100 del lunes');

-- ── 3. El cobro en Bs del viernes se valora a la tasa del viernes ────────────
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0039-0000-4000-8000-00000000f101', 'aaaa0039-0000-4000-8000-00000000000a',
        'aaaa0039-0000-4000-8000-0000000000a1', 'aaaa0039-0000-4000-8000-00000000f001',
        now(), 'VES', 150, 1, 'identidad', now(), 150, 'efectivo_bs',
        'aaaa0039-0000-4000-8000-000000000ca1');

select is(
  platform.document_balance_transaction('aaaa0039-0000-4000-8000-0000000000a1',
                                        'aaaa0039-0000-4000-8000-00000000f001'),
  0.00000000::numeric,
  'Los 150 Bs del viernes valen 1 USD al día del pago: la deuda queda en CERO — nadie perdió margen');

select is(
  platform.document_debt_today('aaaa0039-0000-4000-8000-0000000000a1',
                               'aaaa0039-0000-4000-8000-00000000f001'),
  0.00000000::numeric,
  'Y la deuda de hoy también dice cero');

-- ── 4. El saldo funcional CONGELADO ya no es el que decide ───────────────────
-- Funcional: 100 al emitir, 150 cobrados → −50. Ese −50 no es un sobrepago:
-- es la ganancia cambiaria del que fió bien, y quien decide `paid` es el
-- saldo en transacción (el dominio; aquí se deja constancia del número).
select is(
  platform.document_balance('aaaa0039-0000-4000-8000-0000000000a1',
                            'aaaa0039-0000-4000-8000-00000000f001'),
  -50.00000000::numeric,
  'El funcional congelado da −50: la diferencia es diferencial cambiario, no un sobrepago');

select * from finish();
rollback;
