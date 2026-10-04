-- =============================================================================
-- Ladino — pgTAP 110 · UNA DEUDA, LA DIVISA EN EL MAYOR Y LA REVERSA DE COBROS
-- Migración 20261003180000 (ADR-0075 §5, §6 y §8; E-11, F-04, J-04, R-61).
--
-- Qué se prueba (con su variante rota donde el invariante es crítico):
--   1. `payment_reversals`: aislamiento en las CUATRO operaciones con ladino_api (actor de A, y el
--      usuario de los dos tenants), append-only, y el trigger que copia del cobro lo que sale de la
--      caja (quien inserta no decide el importe);
--   2. un cobro se reversa UNA vez (23505) — y sin el único entraría la segunda;
--   3. el saldo de la caja baja lo reversado, materializado == recomputado;
--   4. la única deuda: el cobro reversado no cuenta; un documento pagado debe 0,00; la antigüedad
--      y la deuda del cliente dan la misma cifra;
--   5. `paid → issued` solo con un cobro reversado (LAD06 sin él);
--   6. el cobro cuyo IGTF se documentó con nota de débito no se reversa (LAD95);
--   7. J-04 en DOS monedas: `treasury_currency_gaps` da cero con la divisa en el mayor y señala
--      la caja en USD asentada solo en bolívares y la caja en Bs descuadrada;
--   8. R-61: anular un comprobante de retención con un número de otro formato VIVE — y con el
--      CHECK anterior fallaba con 23514;
--   9. `accounting_coverage_gaps`: un cobro reversado con su asiento todavía vivo se señala.
-- =============================================================================
begin;
select plan(82);

insert into auth.users (id) values
  ('aaaa0110-0000-4000-8000-0000000000a1'),
  ('aaaa0110-0000-4000-8000-0000000000c1');
select set_config('ladino.actor_id', 'aaaa0110-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'pgtap-110', true);
insert into public.tenants (id, name) values
  ('aaaa0110-0000-4000-8000-00000000000a', 'Tenant 110 A'),
  ('aaaa0110-0000-4000-8000-00000000000b', 'Tenant 110 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000000a',
   'J-110-A', 'Empresa 110 A', 'VES', 'ordinario'),
  ('aaaa0110-0000-4000-8000-0000000000b2', 'aaaa0110-0000-4000-8000-00000000000b',
   'J-110-B', 'Empresa 110 B', 'VES', 'ordinario');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
select c.tenant_id, c.id, 'ordinario', '2000-01-01', 'Montaje pgTAP 110', 'pgtap'
  from public.companies c
 where c.id in ('aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-0000000000b2');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0110-0000-4000-8000-0000000000a3', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a1'),
  ('aaaa0110-0000-4000-8000-0000000000c3', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000c1'),
  ('aaaa0110-0000-4000-8000-0000000000c4', 'aaaa0110-0000-4000-8000-00000000000b',
   'aaaa0110-0000-4000-8000-0000000000c1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0110-0000-4000-8000-00000000c00a', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'J-CLI-110A', 'Cliente 110 A', 'juridica', 'especial'),
  ('aaaa0110-0000-4000-8000-00000000c00b', 'aaaa0110-0000-4000-8000-00000000000b',
   'aaaa0110-0000-4000-8000-0000000000b2', 'J-CLI-110B', 'Cliente 110 B', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0110-0000-4000-8000-00000000e10a', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01'),
       ('aaaa0110-0000-4000-8000-00000000e10b', 'aaaa0110-0000-4000-8000-00000000000b',
        'aaaa0110-0000-4000-8000-0000000000b2', 'formatos_libres', '2026-01-01');

-- Dos facturas de A en bolívares (F1: 1.160; F2: 500) y una de B.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f001', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 1, 11001, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160),
  ('aaaa0110-0000-4000-8000-00000000f002', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 2, 11002, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'VES', 'VES', 1, 'identidad',
   500, 500, 500, 0, 500),
  ('aaaa0110-0000-4000-8000-00000000fb01', 'aaaa0110-0000-4000-8000-00000000000b',
   'aaaa0110-0000-4000-8000-0000000000b2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00b', 1, 11011, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10b', 'test-110', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0110-0000-4000-8000-00000000ca01', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'Caja Bs 110', 'VES', 'cash'),
  ('aaaa0110-0000-4000-8000-00000000ca02', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'Caja USD 110', 'USD', 'cash'),
  ('aaaa0110-0000-4000-8000-00000000cab1', 'aaaa0110-0000-4000-8000-00000000000b',
   'aaaa0110-0000-4000-8000-0000000000b2', 'Caja Bs 110 B', 'VES', 'cash');
-- Cobros: P1 paga F1 entera (1.160 Bs); P2 abona 200 a F2; PB paga la de B.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0110-0000-4000-8000-00000000e001', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f001',
        now(), 'VES', 1160, 1, 'identidad', now(), 1160, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca01'),
       ('aaaa0110-0000-4000-8000-00000000e002', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f002',
        now(), 'VES', 200, 1, 'identidad', now(), 200, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca01'),
       ('aaaa0110-0000-4000-8000-00000000e0b1', 'aaaa0110-0000-4000-8000-00000000000b',
        'aaaa0110-0000-4000-8000-0000000000b2', 'aaaa0110-0000-4000-8000-00000000fb01',
        now(), 'VES', 1160, 1, 'identidad', now(), 1160, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000cab1');
update public.documents set status = 'paid' where id = 'aaaa0110-0000-4000-8000-00000000f001';

-- ── 4a. La única deuda, antes de reversar ────────────────────────────────────
select is(
  (select functional_today::text from platform.document_debt(
     'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f001')),
  '0.00', 'un documento pagado debe 0,00: ni residuo ni tasa tardía');
select is(
  platform.customer_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000c00a')::text,
  '300.00', 'la deuda del cliente es lo que falta de F2 (500 − 200)');
select is(
  (select sum(amount)::text from platform.ar_aging('aaaa0110-0000-4000-8000-0000000000a2',
                                                  'aaaa0110-0000-4000-8000-00000000c00a')),
  '300.00000000', 'y la antigüedad dice la MISMA cifra (sale de la misma función; su columna va a 8)');

-- ── 5a. paid → issued sin reversa: no ────────────────────────────────────────
select throws_ok($$
  update public.documents set status = 'issued'
   where id = 'aaaa0110-0000-4000-8000-00000000f001'
$$, 'LAD06', null, 'un documento pagado no vuelve a emitido si ningún cobro suyo se reversó');

-- ── 1. La reversa, como ladino_api con actor de A ────────────────────────────
set local role ladino_api;
select lives_ok($$
  insert into public.payment_reversals
    (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          'aaaa0110-0000-4000-8000-00000000e001', 'aaaa0110-0000-4000-8000-00000000f002',
          'El efectivo era de otra factura', 'USD', 1, 1)
$$, 'ladino_api con actor de A reversa un cobro de A (la operación funciona de verdad)');
select throws_ok($$
  insert into public.payment_reversals
    (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
  values ('aaaa0110-0000-4000-8000-00000000000b', 'aaaa0110-0000-4000-8000-0000000000b2',
          'aaaa0110-0000-4000-8000-00000000e0b1', 'aaaa0110-0000-4000-8000-00000000fb01',
          'A intenta reversar un cobro de B', 'VES', 1160, 1160)
$$, '42501', null, 'el actor de A no reversa un cobro de B: 42501');
select is((select count(*) from public.payment_reversals), 1::bigint,
  'el actor de A ve su reversa y ninguna de B');
-- Dos capas, y la de abajo actúa primero: ladino_api no tiene GRANT de UPDATE ni de DELETE.
select throws_ok($$
  update public.payment_reversals set reason = 'reescrita por la API, sin dejar rastro'
$$, '42501', null, 'ladino_api no tiene UPDATE sobre las reversas: 42501');
select throws_ok($$ delete from public.payment_reversals $$, '42501', null,
  'ni DELETE: 42501');
reset role;
select is(
  (select reason from public.payment_reversals
    where payment_id = 'aaaa0110-0000-4000-8000-00000000e001'),
  'El efectivo era de otra factura',
  'y la reversa sigue como se escribió: el dato, no solo la excepción');
select throws_ok($$
  update public.payment_reversals set reason = 'reescrita por el dueño de la base'
$$, 'LAD06', null, 'la reversa es append-only también para el dueño de la base: UPDATE → LAD06');
select throws_ok($$ delete from public.payment_reversals $$, 'LAD06', null,
  'y DELETE → LAD06');

-- El trigger copia del cobro: quien inserta no decide ni el importe ni el documento.
select is(
  (select currency || ' ' || amount::text || ' ' || document_id::text || ' ' || kind
     from public.payment_reversals where payment_id = 'aaaa0110-0000-4000-8000-00000000e001'),
  'VES 1160.00000000 aaaa0110-0000-4000-8000-00000000f001 payment',
  'la reversa lleva la moneda, el importe y el documento DEL COBRO, no los que mandó quien insertó');

-- ── 2. Una sola vez, y su variante rota ──────────────────────────────────────
select throws_ok($$
  insert into public.payment_reversals
    (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          'aaaa0110-0000-4000-8000-00000000e001', 'aaaa0110-0000-4000-8000-00000000f001',
          'segunda reversa del mismo cobro', 'VES', 1160, 1160)
$$, '23505', null, 'un cobro se reversa una sola vez: 23505');
savepoint sin_unico;
alter table public.payment_reversals drop constraint payment_reversals_payment_key;
select lives_ok($$
  insert into public.payment_reversals
    (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          'aaaa0110-0000-4000-8000-00000000e001', 'aaaa0110-0000-4000-8000-00000000f001',
          'segunda reversa del mismo cobro', 'VES', 1160, 1160)
$$, 'SIN el único la segunda reversa entra: el throws_ok de arriba medía el constraint');
rollback to savepoint sin_unico;

-- ── 3. La caja ───────────────────────────────────────────────────────────────
select is(
  (select balance::text from public.company_account_balances
    where account_id = 'aaaa0110-0000-4000-8000-00000000ca01'),
  '200.00000000', 'la caja baja lo reversado: 1.160 + 200 − 1.160');
select is(
  (select count(*) from platform.treasury_reconciliation('aaaa0110-0000-4000-8000-0000000000a2')
    where not ok),
  0::bigint, 'y el saldo materializado es el recomputado desde los hechos');

-- ── 4b y 5b. El documento vuelve a deber ─────────────────────────────────────
select is(
  platform.document_balance('aaaa0110-0000-4000-8000-0000000000a2',
                            'aaaa0110-0000-4000-8000-00000000f001')::text,
  '1160.00000000', 'el cobro reversado no cuenta en el saldo del documento');
select lives_ok($$
  update public.documents set status = 'issued'
   where id = 'aaaa0110-0000-4000-8000-00000000f001'
$$, 'con un cobro reversado, paid → issued es una transición sancionada');
select is(
  (select nominal::text || ' ' || functional_today::text from platform.document_debt(
     'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f001')),
  '1160.00 1160.00', 'y la única función de deuda dice que se debe entera');
select is(
  platform.customer_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000c00a')::text,
  (select round(sum(amount), 2)::text
     from platform.ar_aging('aaaa0110-0000-4000-8000-0000000000a2',
                            'aaaa0110-0000-4000-8000-00000000c00a')),
  'deuda del cliente = antigüedad, también después de la reversa (1.460,00)');

-- El usuario de los dos tenants ve las reversas de los dos (legítimo) y tampoco las reescribe.
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0110-0000-4000-8000-00000000000b', 'aaaa0110-0000-4000-8000-0000000000b2',
        'aaaa0110-0000-4000-8000-00000000e0b1', 'aaaa0110-0000-4000-8000-00000000fb01',
        'Reversa de B, sembrada por el montaje', 'VES', 1160, 1160);
select set_config('ladino.actor_id', 'aaaa0110-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is((select count(*) from public.payment_reversals), 2::bigint,
  'el usuario de los dos tenants ve las reversas de los dos');
select throws_ok($$
  update public.payment_reversals set tenant_id = 'aaaa0110-0000-4000-8000-00000000000a',
         company_id = 'aaaa0110-0000-4000-8000-0000000000a2'
   where payment_id = 'aaaa0110-0000-4000-8000-00000000e0b1'
$$, '42501', null, 'el usuario de los dos tenants no traslada una reversa de B a A: 42501');
reset role;
select set_config('ladino.actor_id', 'aaaa0110-0000-4000-8000-0000000000a1', true);
select is(
  (select company_id from public.payment_reversals
    where payment_id = 'aaaa0110-0000-4000-8000-00000000e0b1'),
  'aaaa0110-0000-4000-8000-0000000000b2'::uuid,
  'y la reversa de B sigue siendo de B');

-- ── 6. El IGTF documentado con ND detiene la reversa ─────────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id, notes, rate_basis,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f003', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'debit_note', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 1, 11003, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'aaaa0110-0000-4000-8000-00000000f002',
   'IGTF 3 % percibido sobre el pago en divisas', 'own_day', 'VES', 'VES', 1, 'identidad',
   6, 6, 6, 0, 6);
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at, absorbed, debit_note_id)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e002', 'aaaa0110-0000-4000-8000-00000000f002',
        200, 'VES', 0.03, 6, 6, 1, 'identidad', now(), false,
        'aaaa0110-0000-4000-8000-00000000f003');
select throws_ok($$
  insert into public.payment_reversals
    (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          'aaaa0110-0000-4000-8000-00000000e002', 'aaaa0110-0000-4000-8000-00000000f002',
          'cobro con nota de débito por IGTF', 'VES', 200, 200)
$$, 'LAD95', null, 'el cobro cuyo IGTF se documentó con una ND no se reversa: LAD95');

-- ── 7. J-04: la caja y su subcuenta, en DOS monedas ──────────────────────────
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0110-0000-4000-8000-0000000ac001', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', '1.1.01.110', 'Caja Bs 110', 'activo', 'deudora',
   true, 1),
  ('aaaa0110-0000-4000-8000-0000000ac002', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', '1.1.02.110', 'Caja USD 110', 'activo', 'deudora',
   true, 1),
  ('aaaa0110-0000-4000-8000-0000000ac003', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', '4.1.01.110', 'Ventas 110', 'ingreso', 'acreedora',
   true, 1);
update public.company_accounts set ledger_account_id = 'aaaa0110-0000-4000-8000-0000000ac001'
 where id = 'aaaa0110-0000-4000-8000-00000000ca01';
update public.company_accounts set ledger_account_id = 'aaaa0110-0000-4000-8000-0000000ac002'
 where id = 'aaaa0110-0000-4000-8000-00000000ca02';
-- La caja USD recibe 10 USD (un cierre de caja a 40): tesorería dice 10 USD.
insert into public.cash_closings
  (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount, counted_amount, reason,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000ca02', platform.caracas_day(now()), now(), 0, 10,
        'Montaje pgTAP 110: sobrante de 10 USD', 10, 'USD', 40, 400, 'VES', 'BCV test', now());

-- Un asiento que lleva al mayor los 206 Bs de la caja Bs (200 del abono + 6 del IGTF percibido) y
-- los 10 USD de la caja USD.
create function pg_temp.asentar(p_usd_como text) returns uuid language plpgsql as $$
declare
  v_e uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description, rules_version)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          platform.period_for_date('aaaa0110-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), 'manual', 'Montaje pgTAP 110: cajas al mayor', 'pgtap-110')
  returning id into v_e;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  values
    ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2', v_e, 1,
     'aaaa0110-0000-4000-8000-0000000ac001', 206, 0, 206, 'VES', 1, 206, 'VES', 'identidad',
     now(), 206, 0),
    ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2', v_e, 2,
     'aaaa0110-0000-4000-8000-0000000ac002',
     case when p_usd_como = 'USD' then 10 else 400 end, 0,
     case when p_usd_como = 'USD' then 10 else 400 end, p_usd_como,
     case when p_usd_como = 'USD' then 40 else 1 end, 400, 'VES',
     case when p_usd_como = 'USD' then 'BCV test' else 'identidad' end, now(), 400, 0),
    ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2', v_e, 3,
     'aaaa0110-0000-4000-8000-0000000ac003', 0, 606, 606, 'VES', 1, 606, 'VES', 'identidad',
     now(), 0, 606);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0110-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number(
           'aaaa0110-0000-4000-8000-0000000000a2',
           extract(year from platform.caracas_day(now()))::int)
   where id = v_e;
  return v_e;
end $$;

-- La variante ROTA primero (lo que había antes de E-11): los 10 USD asentados como 400 Bs.
savepoint como_antes;
select pg_temp.asentar('VES');
select is(
  (select account_name || ' ' || currency || ' ' || treasury_balance::text || ' ≠ '
          || ledger_original::text
     from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')),
  'Caja USD 110 USD 10.00000000 ≠ 0',
  'ROTO: la caja en USD asentada solo en bolívares salta — y es la ÚNICA que salta');
select is(
  (select count(*) from platform.treasury_ledger_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where problem = 'saldo_distinto'),
  0::bigint,
  'y treasury_ledger_gaps NO lo veía: este invariante mira lo que aquel no comparaba');
rollback to savepoint como_antes;

select pg_temp.asentar('USD');
select is(
  (select count(*) from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')),
  0::bigint, 'con la divisa en el mayor, el invariante da CERO en las dos monedas');
select is(
  platform.treasury_ledger_original('aaaa0110-0000-4000-8000-0000000000a2',
    'aaaa0110-0000-4000-8000-0000000ac002', 'USD', null)::text,
  '10.00000000', 'la subcuenta de la caja USD lleva 10 USD originales');
-- Y en bolívares: un cobro más en la caja Bs sin asiento la descuadra.
savepoint bs_roto;
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0110-0000-4000-8000-00000000e009', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f002',
        now(), 'VES', 50, 1, 'identidad', now(), 50, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca01');
select is(
  (select account_name || ' ' || treasury_balance::text || ' ≠ ' || ledger_original::text
     from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')),
  'Caja Bs 110 256.00000000 ≠ 206.00000000',
  'ROTO en bolívares: la caja Bs con un cobro que el mayor no tiene también salta');
rollback to savepoint bs_roto;

-- ── 8. R-61: anular un comprobante con un número de otro formato ─────────────
-- Un comprobante anterior a los 14 dígitos (los CHECK son NOT VALID: se siembra sin ellos).
alter table public.supported_retention_receipts
  drop constraint srr_receipt_14_digits_chk, drop constraint srr_receipt_period_prefix_chk;
insert into public.supported_retention_receipts
  (id, tenant_id, company_id, customer_id, document_id, receipt_number, retained_on, base, rate,
   amount, functional_currency)
values ('aaaa0110-0000-4000-8000-000000005001', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000c00a',
        'aaaa0110-0000-4000-8000-00000000f001', 'AG-0001', platform.caracas_day(now()), 160,
        0.75, 120, 'VES');
savepoint check_viejo;
alter table public.supported_retention_receipts
  add constraint srr_receipt_14_digits_chk check (receipt_number ~ '^[0-9]{14}$') not valid;
select throws_ok($$
  update public.supported_retention_receipts
     set status = 'annulled', annul_reason = 'comprobante mal cargado'
   where id = 'aaaa0110-0000-4000-8000-000000005001'
$$, '23514', null,
  'ROTO (el CHECK de 20260928190000): NOT VALID no perdona el UPDATE, anular fallaba con 23514');
rollback to savepoint check_viejo;
alter table public.supported_retention_receipts
  add constraint srr_receipt_14_digits_chk
    check (status = 'annulled' or receipt_number ~ '^[0-9]{14}$') not valid,
  add constraint srr_receipt_period_prefix_chk
    check (status = 'annulled'
           or receipt_number ~ '^(19|20)[0-9]{2}(0[1-9]|1[0-2])[0-9]{8}$') not valid;
select lives_ok($$
  update public.supported_retention_receipts
     set status = 'annulled', annul_reason = 'comprobante mal cargado'
   where id = 'aaaa0110-0000-4000-8000-000000005001'
$$, 'con el CHECK de esta migración, el comprobante viejo se anula');
select throws_ok($$
  update public.supported_retention_receipts set status = 'registered', annul_reason = null
   where id = 'aaaa0110-0000-4000-8000-000000005001'
$$, '23514', null, 'y sigue sin poder volver a VIGENTE con ese número: el formato se exige a lo vigente');

-- ── 9. La cobertura contable y el cobro reversado ────────────────────────────
-- El cobro P1 está reversado. Si su asiento siguiera VIVO (posted), la reversa quedó a medias.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description, rules_version)
values ('aaaa0110-0000-4000-8000-0000000e0001', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2',
        platform.period_for_date('aaaa0110-0000-4000-8000-0000000000a2',
                                 platform.caracas_day(now())),
        platform.caracas_day(now()), 'payment_received',
        'aaaa0110-0000-4000-8000-00000000e001', 'ar.payment_applied',
        'Montaje pgTAP 110: el asiento del cobro reversado', 'pgtap-110');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
values
  ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
   'aaaa0110-0000-4000-8000-0000000e0001', 1, 'aaaa0110-0000-4000-8000-0000000ac001',
   1160, 0, 1160, 'VES', 1, 1160, 'VES', 'identidad', now(), 1160, 0),
  ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
   'aaaa0110-0000-4000-8000-0000000e0001', 2, 'aaaa0110-0000-4000-8000-0000000ac003',
   0, 1160, 1160, 'VES', 1, 1160, 'VES', 'identidad', now(), 0, 1160);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0110-0000-4000-8000-0000000000a1',
       entry_number = platform.claim_entry_number(
         'aaaa0110-0000-4000-8000-0000000000a2',
         extract(year from platform.caracas_day(now()))::int)
 where id = 'aaaa0110-0000-4000-8000-0000000e0001';
select is(
  (select problem from platform.accounting_coverage_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where source_id = 'aaaa0110-0000-4000-8000-00000000e001'),
  'reversal_not_posted',
  'un cobro reversado con su asiento todavía vivo se señala: reversal_not_posted');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where source_id = 'aaaa0110-0000-4000-8000-00000000e0b1'),
  0::bigint, 'y la cobertura de A no mira los cobros de B');

-- =============================================================================
-- 20261003210000 — la revaluación netea, la tasa de cierre es fresca y las lecturas no se caen
-- =============================================================================

-- ── 10. H11: `paid → issued` solo si el documento debe AHORA ─────────────────
-- F1 tiene una reversa HISTÓRICA (la de P1) y se vuelve a pagar entera con P3. Con la regla de
-- 20261003180000 («existe cualquier reversa») esta factura saldada se podía reabrir.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0110-0000-4000-8000-00000000e003', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f001',
        now(), 'VES', 1160, 1, 'identidad', now(), 1160, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca01');
update public.documents set status = 'paid' where id = 'aaaa0110-0000-4000-8000-00000000f001';
select throws_ok($$
  update public.documents set status = 'issued'
   where id = 'aaaa0110-0000-4000-8000-00000000f001'
$$, 'LAD06', null,
  'H11: con una reversa VIEJA y el documento otra vez saldado, paid → issued se rechaza');
savepoint reversa_de_ahora;
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e003', 'aaaa0110-0000-4000-8000-00000000f001',
        'La reversa que lo reabre ahora', 'VES', 1160, 1160);
select lives_ok($$
  update public.documents set status = 'issued'
   where id = 'aaaa0110-0000-4000-8000-00000000f001'
$$, 'y con la reversa que lo deja debiendo AHORA sí: lo que decide es el saldo, no la historia');
rollback to savepoint reversa_de_ahora;

-- ── 11. H12: la deuda sin tasa de hoy no se cae ──────────────────────────────
-- F4: una factura en USD (100 a 40). F5: otra en USD (50 a 40) PAGADA con 49,99: residuo 0,01.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f004', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 3, 11004, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   100, 4000, 4000, 0, 4000),
  ('aaaa0110-0000-4000-8000-00000000f005', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 4, 11005, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   50, 2000, 2000, 0, 2000);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
values ('aaaa0110-0000-4000-8000-00000000e005', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f005',
        now(), 'USD', 49.99, 40, 'BCV test', now(), 1999.60, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 49.99);
update public.documents set status = 'paid' where id = 'aaaa0110-0000-4000-8000-00000000f005';

-- Sin NINGUNA tasa (la transacción entera se revierte al final).
delete from public.exchange_rates;
select lives_ok($$
  select * from platform.document_debt('aaaa0110-0000-4000-8000-0000000000a2',
                                       'aaaa0110-0000-4000-8000-00000000f004')
$$, 'H12: sin tasa de hoy, la función de deuda NO lanza');
select is(
  (select nominal::text || ' ' || coalesce(rate::text, 'sin tasa') || ' '
          || coalesce(functional_today::text, 'sin equivalente')
     from platform.document_debt('aaaa0110-0000-4000-8000-0000000000a2',
                                 'aaaa0110-0000-4000-8000-00000000f004')),
  '100.00 sin tasa sin equivalente',
  'el nominal en divisa se sirve igual; la tasa y el equivalente en Bs van en NULL');
select is(
  platform.customer_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000c00a'),
  null::numeric,
  'la deuda del cliente va en NULL: una suma sin la factura en divisa parecería el total');
select is(
  (select string_agg(document_count::text || ' ' || coalesce(amount::text, 'sin equivalente'), '|')
     from platform.ar_aging('aaaa0110-0000-4000-8000-0000000000a2',
                            'aaaa0110-0000-4000-8000-00000000c00a')),
  '2 sin equivalente',
  'la antigüedad no se cae: cuenta los dos documentos que deben y su importe va en NULL');
select is(
  platform.document_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000f002')::text,
  '300.00', 'un documento en bolívares no necesita tasa: debe lo de siempre');
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date,
                                   rate_timestamp)
values ('USD', 'VES', 50, 'pgtap-110', platform.caracas_day(now()), now());
select is(
  platform.document_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000f004')::text,
  '5000.00', 'con la tasa de hoy (50) el equivalente vuelve: el NULL venía de la tasa que faltaba');
select is(
  platform.customer_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000c00a')::text,
  '5300.00', 'y la deuda del cliente es 300 + 5.000 (F1 y F5 están pagadas: deben cero)');

-- ── 12. H7: la tasa de cierre no puede ser rancia ────────────────────────────
-- Una sola tasa, fechada hoy. `date` contra `date`.
select is(
  platform.closing_rate('aaaa0110-0000-4000-8000-0000000000a2', 'USD', 'VES',
                        platform.caracas_day(now())),
  50::numeric, 'la tasa de cierre de hoy es la de hoy');
select is(
  platform.closing_rate('aaaa0110-0000-4000-8000-0000000000a2', 'USD', 'VES',
                        platform.caracas_day(now()) + 7),
  50::numeric, 'a 7 días (el margen del parámetro) todavía vale');
select is(
  platform.closing_rate('aaaa0110-0000-4000-8000-0000000000a2', 'USD', 'VES',
                        platform.caracas_day(now()) + 8),
  null::numeric, 'a 8 días ya no hay tasa de cierre: el cierre se detiene');
-- Desde la migración 20261004195900 el margen vive en `rate_for` (una sola regla) y `rate_at` ya
-- no sirve la tasa rancia. La variante rota es ahora «sin el margen»: se ensancha el parámetro
-- y la tasa de hace 8 días vuelve. Cambió la ENTRADA, no la cifra esperada.
savepoint margen_ancho;
update platform.parameters set value = 30 where key = 'official_rate_max_age_days';
select is(
  platform.rate_at('aaaa0110-0000-4000-8000-0000000000a2', 'USD', 'VES',
                   platform.caracas_day(now()) + 8),
  50::numeric,
  'ROTO (lo que usaba el cierre): sin el margen, rate_at devuelve la tasa rancia sin avisar — por eso no sirve aquí');
rollback to savepoint margen_ancho;
savepoint sin_parametro;
delete from platform.parameters
 where key in ('closing_rate_max_age_days', 'official_rate_max_age_days');
select is(
  platform.closing_rate('aaaa0110-0000-4000-8000-0000000000a2', 'USD', 'VES',
                        platform.caracas_day(now())),
  null::numeric, 'sin el parámetro la regla falla CERRADA: ninguna tasa es de cierre');
rollback to savepoint sin_parametro;

-- ── 13. H5: J-04 con la cola en el enunciado ─────────────────────────────────
-- El cobro P5 (49,99 USD en la caja USD) no tiene asiento ni fila en cola: hueco.
select is(
  (select treasury_balance::text || ' ≠ ' || ledger_original::text
     from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where account_id = 'aaaa0110-0000-4000-8000-00000000ca02'),
  '59.99000000 ≠ 10.00000000',
  'un cobro en la caja USD sin asiento NI cola es un hueco');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'payment_received', 'aaaa0110-0000-4000-8000-00000000e005', 'ar.payment_applied',
        '{"total": "1999.60"}'::jsonb, 'Sin plantilla configurada');
select is(
  (select count(*) from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where account_id = 'aaaa0110-0000-4000-8000-00000000ca02'),
  0::bigint, 'con el cobro EN COLA la caja cuadra: caja = subcuenta + lo que espera en la cola');
savepoint cola_descartada;
update public.journal_generation_queue set status = 'discarded', processed_at = now()
 where source_id = 'aaaa0110-0000-4000-8000-00000000e005';
select is(
  (select count(*) from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where account_id = 'aaaa0110-0000-4000-8000-00000000ca02'),
  1::bigint, 'ROTO: con la fila descartada (ni asiento ni cola) el hueco vuelve');
-- Y la regularización de ese hueco nace con origen propio, no como asiento manual.
-- En dos sentencias: la consulta que lee el asiento tiene que empezar DESPUÉS de crearlo.
select set_config('pgtap110.regularizacion',
                  platform.treasury_currency_regularization_prepare(
                    'aaaa0110-0000-4000-8000-0000000000a2') ->> 'entry_id', true);
select is(
  (select e.source_kind || ' ' || e.source_event || ' ' || (e.source_id is not null)::text
     from public.journal_entries e
    where e.id = current_setting('pgtap110.regularizacion')::uuid),
  'exchange_diff treasury.currency_regularized true',
  'el asiento de la regularización NO es manual: no se reversa suelto');
rollback to savepoint cola_descartada;

-- ── 14. H2 y H14: la revaluación netea por cuenta ────────────────────────────
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0110-0000-4000-8000-0000000ac004', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', '1.1.03.110', 'Cuentas por cobrar 110', 'activo',
   'deudora', true, 1),
  ('aaaa0110-0000-4000-8000-0000000ac005', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', '2.1.01.110', 'Cuentas por pagar 110', 'pasivo',
   'acreedora', true, 1);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
   'ar_general', 'aaaa0110-0000-4000-8000-0000000ac004'),
  ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
   'ap_general', 'aaaa0110-0000-4000-8000-0000000ac005');
-- Una factura de proveedor en USD (200 a 40): la revaluación de cuentas por pagar.
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0110-0000-4000-8000-00000000d001', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'J-PRO-110', 'Proveedor 110', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa0110-0000-4000-8000-00000000d101', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000d001',
   'FP-110', 'CTRL-110', platform.caracas_day(now()), 'posted', now(), 200, 0, 200, true,
   'USD', 'VES', 40, 200, 8000);

select is(
  platform.document_balance_transaction_at('aaaa0110-0000-4000-8000-0000000000a2',
                                           'aaaa0110-0000-4000-8000-00000000f005', null),
  0.01::numeric, 'H14: la factura PAGADA conserva un residuo de un céntimo de dólar en su saldo…');
select is(
  (select string_agg(item_kind || ' ' || currency || ' ' || round(original_balance, 2)::text
                     || ': ' || round(carried, 2)::text || ' → ' || round(target, 2)::text
                     || ' = ' || round(adjustment, 2)::text, ' | ' order by item_kind)
     from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                        platform.caracas_day(now()))),
  'payable USD 200.00: 8000.00 → 10000.00 = -2000.00 | '
  || 'receivable USD 100.00: 4000.00 → 5000.00 = 1000.00 | '
  || 'treasury USD 10.00: 400.00 → 500.00 = 100.00',
  '…y NO se revalúa: a 50, por cobrar son los 100 USD de F4; por pagar, 200 USD (ajuste acreedor); la caja, 10 USD');

-- El asiento de revaluación de ese cierre (lo que escribe closeFiscalPeriod): un borrador que
-- se postea, como el montaje de la sección 7.
create function pg_temp.revaluar() returns uuid language plpgsql as $$
declare
  v_e uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          platform.period_for_date('aaaa0110-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), 'exchange_diff', platform.uuidv7(),
          'fx.revaluation_at_close', 'Montaje pgTAP 110: revaluación al cierre', 'pgtap-110')
  returning id into v_e;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  select 'aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
         v_e, x.n, x.cuenta::uuid, x.debe, x.haber,
         greatest(x.debe, x.haber), 'VES', 1, greatest(x.debe, x.haber), 'VES', 'identidad',
         now(), x.debe, x.haber
    from (values
      (1, 'aaaa0110-0000-4000-8000-0000000ac004', 1000, 0),   -- por cobrar sube 1.000
      (2, 'aaaa0110-0000-4000-8000-0000000ac002', 100, 0),    -- la caja USD sube 100 (en Bs)
      (3, 'aaaa0110-0000-4000-8000-0000000ac005', 0, 2000),   -- por pagar sube 2.000
      (4, 'aaaa0110-0000-4000-8000-0000000ac003', 900, 0)     -- el resultado neto
    ) as x(n, cuenta, debe, haber);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0110-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number(
           'aaaa0110-0000-4000-8000-0000000000a2',
           extract(year from platform.caracas_day(now()))::int)
   where id = v_e;
  return v_e;
end $$;
select pg_temp.revaluar();
select is(
  (select count(*) from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                                      platform.caracas_day(now()))),
  0::bigint,
  'H2: asentada la revaluación, la misma pregunta da CERO FILAS (no una ganancia y una pérdida que se anulan)');
-- Otra tasa (55) con la cartera abierta: una fila por cuenta, con lo ya revaluado DENTRO de lo
-- que lleva. Sin neteo saldrían 1.500 contra el histórico y −1.000 de «lo ya revaluado».
-- Se sustituye la de 50: dentro de una transacción las dos tendrían el mismo created_at y «a igual
-- día manda la guardada más tarde» no desempata.
delete from public.exchange_rates where source = 'pgtap-110';
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date,
                                   rate_timestamp)
values ('USD', 'VES', 55, 'pgtap-110-b', platform.caracas_day(now()), now());
select is(
  (select string_agg(item_kind || ': ' || round(carried, 2)::text || ' → '
                     || round(target, 2)::text || ' = ' || round(adjustment, 2)::text,
                     ' | ' order by item_kind)
     from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                        platform.caracas_day(now()))),
  'payable: 10000.00 → 11000.00 = -1000.00 | receivable: 5000.00 → 5500.00 = 500.00 | '
  || 'treasury: 500.00 → 550.00 = 50.00',
  'a 55, cada cuenta trae SOLO la diferencia neta contra lo que el mayor ya lleva');
select is(
  (select count(*) from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                                      platform.caracas_day(now()))
    where item_kind like '%prior'),
  0::bigint, 'y ya no existen las filas «prior» de signo contrario');

-- ── 15. 20261003210100: lo mostrado es lo que cierra ─────────────────────────
-- F6: 100 USD a 40 = 4.000,00 Bs, con un abono de 30 USD que el mayor cargó por 1.200,03 (a
-- 40,001). Sin asientos, «lo que el mayor carga» sale de los cobros vivos: 2.799,97. La parte
-- proporcional del total es 2.800,00. A la tasa del documento (40) la deuda mostrada es la primera.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f006', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 5, 11006, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   100, 4000, 4000, 0, 4000);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
values ('aaaa0110-0000-4000-8000-00000000e006', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f006',
        now(), 'USD', 30, 40.001, 'BCV test', now(), 1200.03, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 30);
delete from public.exchange_rates;
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date,
                                   rate_timestamp)
values ('USD', 'VES', 40, 'pgtap-110-c', platform.caracas_day(now()), now());
select is(
  platform.document_settlement_base('aaaa0110-0000-4000-8000-0000000000a2',
                                    'aaaa0110-0000-4000-8000-00000000f006'),
  2799.97::numeric,
  'la base del cierre es lo que el mayor carga (4.000 − 1.200,03) cuando cuadra con la proporción');
select is(
  (select nominal::text || ' ' || functional_today::text
     from platform.document_debt('aaaa0110-0000-4000-8000-0000000000a2',
                                 'aaaa0110-0000-4000-8000-00000000f006')),
  '70.00 2799.97',
  'a la tasa del documento, la deuda MOSTRADA es esa base — no la parte proporcional (2.800,00)');
-- Fuera de la cota del redondeo no se le cree al mayor: vuelve la parte proporcional.
savepoint mayor_descuadrado;
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
values ('aaaa0110-0000-4000-8000-00000000e007', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f006',
        now(), 'USD', 10, 41, 'BCV test', now(), 410, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 10);
select is(
  platform.document_settlement_base('aaaa0110-0000-4000-8000-0000000000a2',
                                    'aaaa0110-0000-4000-8000-00000000f006'),
  2400::numeric,
  'ROTO el mayor (2.389,97 contra 2.400,00, fuera de la cota): la base es la parte proporcional');
rollback to savepoint mayor_descuadrado;
-- A OTRA tasa no se lee el mayor: la parte proporcional reindexada (70 USD × 50 sobre 4.000/100).
delete from public.exchange_rates;
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date,
                                   rate_timestamp)
values ('USD', 'VES', 50, 'pgtap-110-d', platform.caracas_day(now()), now());
select is(
  (select functional_today::text
     from platform.document_debt('aaaa0110-0000-4000-8000-0000000000a2',
                                 'aaaa0110-0000-4000-8000-00000000f006')),
  '3500.00', 'a otra tasa la deuda es la proporción reindexada, sin leer el mayor');

-- =============================================================================
-- 20261003210200 — una lista no se cae por una tasa, la revaluación y el informe de cuentas
-- =============================================================================

-- ── 16. La revaluación: el cobro posterior al cierre tiene que estar VIVO ────
-- F8: 50 USD, pagada con 49,99 (residuo 0,01) y con un cobro de 5 USD fechado PASADO MAÑANA.
-- A la tasa 50, la cartera abierta es F4 (100) + F6 (70) = 170 USD.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f008', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 6, 11008, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   50, 2000, 2000, 0, 2000);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
values ('aaaa0110-0000-4000-8000-00000000e011', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f008',
        now(), 'USD', 49.99, 40, 'BCV test', now(), 1999.60, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 49.99),
       ('aaaa0110-0000-4000-8000-00000000e012', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f008',
        now() + interval '2 days', 'USD', 5, 40, 'BCV test', now(), 200, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 5);
update public.documents set status = 'paid' where id = 'aaaa0110-0000-4000-8000-00000000f008';
select is(
  (select round(original_balance, 2)::text
     from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                        platform.caracas_day(now()))
    where item_kind = 'receivable'),
  '170.01',
  'un documento `paid` con un cobro VIVO posterior a la fecha de cierre sigue en la cartera a esa fecha');
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e012', 'aaaa0110-0000-4000-8000-00000000f008',
        'El cobro posterior se reversó', 'USD', 5, 200);
select is(
  (select round(original_balance, 2)::text
     from platform.fx_revaluation_items('aaaa0110-0000-4000-8000-0000000000a2',
                                        platform.caracas_day(now()))
    where item_kind = 'receivable'),
  '170.00',
  'con ese cobro REVERSADO, el `paid` no se revalúa por su residuo de un céntimo (H14)');

-- ── 17. El informe de dónde cayó el dinero no lista cobros reversados ────────
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0110-0000-4000-8000-00000000ca03', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'Banco Bs 110', 'VES', 'bank');
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0110-0000-4000-8000-00000000e013', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f002',
        now(), 'VES', 10, 1, 'identidad', now(), 10, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca03');
select is(
  (select problem from platform.money_landing_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where movement_id = 'aaaa0110-0000-4000-8000-00000000e013'),
  'familia_no_corresponde', 'efectivo cobrado en un banco sale en el informe');
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e013', 'aaaa0110-0000-4000-8000-00000000f002',
        'El cobro en el banco se reversó', 'VES', 10, 10);
select is(
  (select count(*) from platform.money_landing_gaps('aaaa0110-0000-4000-8000-0000000000a2')
    where movement_id = 'aaaa0110-0000-4000-8000-00000000e013'),
  0::bigint, 'reversado, ya no es dinero que cayó en ninguna cuenta: sale del informe');

-- ── 18. Resto de H12: un cobro viejo sin tasa con que valorarlo no tumba la lista ──
-- F7: 10 USD a 40, con un abono de 200 Bs SIN `settled_transaction_amount` (anterior a
-- 20261003170000). Sin ninguna tasa en la tabla, no hay con qué decir cuántos dólares saldó.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f007', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 7, 11007, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   10, 400, 400, 0, 400);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0110-0000-4000-8000-00000000e008', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f007',
        now(), 'VES', 200, 1, 'identidad', now(), 200, 'efectivo_bs',
        'aaaa0110-0000-4000-8000-00000000ca01');
delete from public.exchange_rates;
select throws_ok($$
  select platform.document_balance_transaction_at('aaaa0110-0000-4000-8000-0000000000a2',
                                                  'aaaa0110-0000-4000-8000-00000000f007', null)
$$, 'LAD51', null,
  'el saldo ESTRICTO (el del cobro y la revaluación) sigue lanzando sin tasa: no se inventa');
select is(
  (select coalesce(nominal::text, 'sin nominal') || ' ' || coalesce(functional_today::text, 'sin equivalente')
     from platform.document_debt('aaaa0110-0000-4000-8000-0000000000a2',
                                 'aaaa0110-0000-4000-8000-00000000f007')),
  'sin nominal sin equivalente',
  'la función de deuda NO lanza: dice que no puede decir cuánto se debe');
select is(
  platform.customer_debt_today('aaaa0110-0000-4000-8000-0000000000a2',
                               'aaaa0110-0000-4000-8000-00000000c00a'),
  null::numeric, 'la deuda del cliente va en NULL, no en un 409 de toda la lista');
select ok(
  (select sum(document_count) >= 1 and bool_and(amount is null)
     from platform.ar_aging('aaaa0110-0000-4000-8000-0000000000a2',
                            'aaaa0110-0000-4000-8000-00000000c00a')),
  'y la antigüedad cuenta el documento con su importe en NULL');
-- La tasa CONGELADA del propio cobro: la que guardó su diferencial. Con ella no hace falta
-- ninguna tasa en la tabla (y una tasa cargada o borrada después no cambia lo que saldó).
insert into public.exchange_gain_loss
  (tenant_id, company_id, document_id, payment_id, amount_transaction, transaction_currency,
   functional_at_issue, functional_at_payment, difference, fx_rate_issue, fx_rate_payment,
   account_code, occurred_on)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000f007', 'aaaa0110-0000-4000-8000-00000000e008',
        4, 'USD', 160, 200, 40, 40, 50, '4.1.02', platform.caracas_day(now()));
select is(
  platform.document_balance_transaction_at('aaaa0110-0000-4000-8000-0000000000a2',
                                           'aaaa0110-0000-4000-8000-00000000f007', null),
  6::numeric,
  'con el diferencial del cobro (tasa 50 congelada) el saldo sale sin tasa alguna en la tabla: 10 − 200/50');

-- =============================================================================
-- 20261003220000 — el original de la cartera es determinista y el IGTF conserva su quincena
-- =============================================================================

-- ── 19. El original de la línea de cartera, por hecho y sin umbral ───────────
-- Una compra en USD (200 a 40) con una retención PEQUEÑA: 30 Bs = 0,75 USD, el 0,375 % del total.
-- Con el umbral del 0,5 % de la 210200 el generador tomaba el total (200) aunque la línea de
-- cuentas por pagar va neta de retención.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount, retention_total) values
  ('aaaa0110-0000-4000-8000-00000000d102', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000d001',
   'FP-110-B', 'CTRL-110-B', platform.caracas_day(now()), 'posted', now(), 200, 0, 200, true,
   'USD', 'VES', 40, 200, 8000, 30);
select is(
  (select currency || ' ' || amount::text || ' @ ' || fx_rate::text
     from platform.settlement_original_of('aaaa0110-0000-4000-8000-0000000000a2',
            'purchase_invoice', 'aaaa0110-0000-4000-8000-00000000d102')),
  'USD 199.25000000 @ 40.00000000',
  'la factura de compra lleva en su cartera el total MENOS la retención neteada (200 − 30/40), no el total');
select is(
  (select amount from platform.settlement_original_of('aaaa0110-0000-4000-8000-0000000000a2',
            'sales_invoice', 'aaaa0110-0000-4000-8000-00000000f004')),
  100::numeric, 'la factura de venta, su total en la moneda del documento');
select is(
  (select count(*) from platform.settlement_original_of('aaaa0110-0000-4000-8000-0000000000a2',
            'manual', 'aaaa0110-0000-4000-8000-00000000f004'))
  + (select count(*) from platform.settlement_original_of('aaaa0110-0000-4000-8000-0000000000a2',
            'payment_received', 'aaaa0110-0000-4000-8000-00000000e008')
      where amount is not null),
  0::bigint,
  'un hecho sin original conocido (un asiento manual; un cobro viejo sin lo saldado) no lo inventa: su línea va en funcional');

-- ── 20. La base del cierre cuando el MAYOR responde (settlement_ledger_open no nulo) ──
-- F9: 100 USD a 40, con su asiento (CxC 4.000,00) y un abono de 30 USD cuyo asiento canceló
-- 1.200,05. El mayor carga 2.799,95; el respaldo «desde los cobros» diría 2.799,97 (4.000 −
-- 1.200,03): si la base saliera de ahí, el mayor no se estaría leyendo.
create function pg_temp.asentar_cartera(p_kind text, p_source uuid, p_evento text,
                                        p_debe uuid, p_haber uuid, p_importe numeric)
returns uuid language plpgsql as $$
declare
  v_e uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version)
  values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
          platform.period_for_date('aaaa0110-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), p_kind, p_source, p_evento,
          'Montaje pgTAP 110: cartera en el mayor', 'pgtap-110')
  returning id into v_e;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  values
    ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2', v_e, 1,
     p_debe, p_importe, 0, p_importe, 'VES', 1, p_importe, 'VES', 'identidad', now(),
     p_importe, 0),
    ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2', v_e, 2,
     p_haber, 0, p_importe, p_importe, 'VES', 1, p_importe, 'VES', 'identidad', now(),
     0, p_importe);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0110-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number(
           'aaaa0110-0000-4000-8000-0000000000a2',
           extract(year from platform.caracas_day(now()))::int)
   where id = v_e;
  return v_e;
end $$;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0110-0000-4000-8000-00000000f009', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0110-0000-4000-8000-00000000c00a', 8, 11009, 'issued', now(),
   'aaaa0110-0000-4000-8000-00000000e10a', 'test-110', 'USD', 'VES', 40, 'BCV test',
   100, 4000, 4000, 0, 4000);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount)
values ('aaaa0110-0000-4000-8000-00000000e014', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000f009',
        now(), 'USD', 30, 40.001, 'BCV test', now(), 1200.03, 'efectivo_usd',
        'aaaa0110-0000-4000-8000-00000000ca02', 30);
select pg_temp.asentar_cartera('sales_invoice', 'aaaa0110-0000-4000-8000-00000000f009',
         'fiscal.invoice.issued', 'aaaa0110-0000-4000-8000-0000000ac004',
         'aaaa0110-0000-4000-8000-0000000ac003', 4000);
select pg_temp.asentar_cartera('payment_received', 'aaaa0110-0000-4000-8000-00000000e014',
         'ar.payment_applied', 'aaaa0110-0000-4000-8000-0000000ac002',
         'aaaa0110-0000-4000-8000-0000000ac004', 1200.05);
select is(
  platform.settlement_ledger_open('aaaa0110-0000-4000-8000-0000000000a2', 'ar',
                                  'aaaa0110-0000-4000-8000-00000000f009'),
  2799.95::numeric, 'con todas sus piezas asentadas, el mayor RESPONDE: le carga 2.799,95');
select is(
  platform.document_settlement_base('aaaa0110-0000-4000-8000-0000000000a2',
                                    'aaaa0110-0000-4000-8000-00000000f009'),
  2799.95::numeric,
  'y la base del cierre es la del MAYOR (2.799,95), no la del respaldo desde los cobros (2.799,97)');

-- ── 21. El IGTF de una quincena, con la percepción reversada tarde ───────────
-- Tres percepciones del PRIMER día de la quincena anterior a la de hoy (Q1): X1 (10 Bs) se reversa
-- HOY, después de la quincena; X2 (20 Bs) se reversó dos días después de percibirse, dentro de
-- ella; X3 (40 Bs) sigue percibida. Y X4 (80 Bs), de la quincena anterior a esa (Q2), reversada
-- ya dentro de Q1. Las fechas salen de la quincena, no de «hace N días»: con días relativos, que
-- una reversa caiga dentro o fuera de la quincena de su percepción dependía del día del mes.
create temp table q21 on commit drop as
  select q1.period_from as q1_from, q1.period_to as q1_to,
         q2.period_from as q2_from, q2.period_to as q2_to
    from platform.fiscal_fortnight(platform.caracas_day(now())) q0,
         platform.fiscal_fortnight(q0.period_from - 1) q1,
         platform.fiscal_fortnight(q1.period_from - 1) q2;
insert into public.igtf_perceptions
  (id, tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at, absorbed)
values
  ('aaaa0110-0000-4000-8000-0000000019f1', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000e011',
   'aaaa0110-0000-4000-8000-00000000f008', 8.33, 'USD', 0.03, 0.25, 10, 40, 'BCV test',
   ((select q1_from from q21) + time '12:00') at time zone 'America/Caracas', false),
  ('aaaa0110-0000-4000-8000-0000000019f2', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000e014',
   'aaaa0110-0000-4000-8000-00000000f009', 16.67, 'USD', 0.03, 0.5, 20, 40, 'BCV test',
   ((select q1_from from q21) + time '12:00') at time zone 'America/Caracas', false),
  ('aaaa0110-0000-4000-8000-0000000019f3', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000e005',
   'aaaa0110-0000-4000-8000-00000000f005', 33.33, 'USD', 0.03, 1, 40, 40, 'BCV test',
   ((select q1_from from q21) + time '12:00') at time zone 'America/Caracas', false);
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e011', 'aaaa0110-0000-4000-8000-00000000f008',
        'Reversado HOY, después de su quincena', 'USD', 49.99, 1999.60);
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount,
   reversed_at)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e014', 'aaaa0110-0000-4000-8000-00000000f009',
        'Reversado dentro de su quincena', 'USD', 30, 1200.03, ((select q1_from + 2 from q21) + time '12:00') at time zone 'America/Caracas');
insert into public.igtf_perceptions
  (id, tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at, absorbed)
values
  ('aaaa0110-0000-4000-8000-0000000019f4', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a2', 'aaaa0110-0000-4000-8000-00000000e006',
   'aaaa0110-0000-4000-8000-00000000f006', 66.67, 'USD', 0.03, 2, 80, 40, 'BCV test',
   ((select q2_from from q21) + time '12:00') at time zone 'America/Caracas', false);
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount,
   reversed_at)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a2',
        'aaaa0110-0000-4000-8000-00000000e006', 'aaaa0110-0000-4000-8000-00000000f006',
        'Reversado en la quincena SIGUIENTE a la suya', 'USD', 30, 1200.03,
        ((select q1_from + 1 from q21) + time '12:00') at time zone 'America/Caracas');
update public.igtf_perceptions
   set status = 'pendiente_reintegro', status_reason = 'Reversa del cobro'
 where id in ('aaaa0110-0000-4000-8000-0000000019f1', 'aaaa0110-0000-4000-8000-0000000019f2',
              'aaaa0110-0000-4000-8000-0000000019f4');
select is(
  (select total_functional::text || ' / ' || pending_refund_functional::text || ' / '
          || pending_refund_count::text
     from platform.igtf_period_totals('aaaa0110-0000-4000-8000-0000000000a2',
            (select q1_from from q21), (select q1_to from q21))),
  '50.00000000 / 10.00000000 / 1',
  'la quincena cuenta lo percibido (40) MÁS lo reversado después de cerrarla (10), que va aparte como pendiente de reintegro; lo reversado dentro de ella (20) no cuenta');
select is(
  (select total_functional from platform.igtf_period_totals(
            'aaaa0110-0000-4000-8000-0000000000a2', null, null)),
  46::numeric,
  'sin período no hay «después del período»: solo lo percibido vigente (40 + los 6 de la sección 6)');

-- «Su quincena» es la de la PERCEPCIÓN, no el rango de la consulta (20261003230000).
create function pg_temp.igtf21(p_from date, p_to date) returns text language sql as $f$
  select total_functional::text || ' / ' || pending_refund_functional::text || ' / '
         || pending_refund_count::text
    from platform.igtf_period_totals('aaaa0110-0000-4000-8000-0000000000a2', p_from, p_to)
$f$;
select is(
  pg_temp.igtf21((select q1_from from q21), (select q1_from from q21)),
  '50.00000000 / 10.00000000 / 1',
  'rango de UN día: X2, reversada dos días después pero DENTRO de su quincena, no cuenta (contra el fin del rango contaba: 70 / 30 / 2)');
select is(
  pg_temp.igtf21((select q2_from from q21), (select q1_to from q21)),
  '130.00000000 / 90.00000000 / 2',
  'rango de dos quincenas (un mes): X4, de la primera y reversada en la segunda, cuenta — su quincena ya se declaró con ella (contra el fin del rango no contaba: 50 / 10 / 1)');
select is(
  (select total_functional from platform.igtf_period_totals(
     'aaaa0110-0000-4000-8000-0000000000a2', (select q2_from from q21), (select q1_to from q21))),
  (select total_functional from platform.igtf_period_totals(
     'aaaa0110-0000-4000-8000-0000000000a2', (select q2_from from q21), (select q2_to from q21)))
  + (select total_functional from platform.igtf_period_totals(
     'aaaa0110-0000-4000-8000-0000000000a2', (select q1_from from q21), (select q1_to from q21))),
  'Σ de las quincenas = el rango que las contiene');
-- VARIANTE ROTA: la regla de 20261003220000 (la reversa contra el fin del RANGO). Con ella el día
-- suelto cuenta a X2: si esto no diera 70, las aserciones de arriba no medirían la regla.
create or replace function platform.igtf_period_totals(p_company uuid, p_from date, p_to date)
returns table (total_functional numeric, pending_refund_functional numeric,
               pending_refund_count bigint)
language sql stable set search_path = '' as $roto$
  with percepciones as (
    select ip.functional_amount, ip.status,
           (select platform.caracas_day(r.reversed_at) from public.payment_reversals r
             where r.company_id = ip.company_id and r.payment_id = ip.payment_id) as reversada_el
      from public.igtf_perceptions ip
     where ip.company_id = p_company
       and (p_from is null or platform.caracas_day(ip.occurred_at) >= p_from)
       and (p_to is null or platform.caracas_day(ip.occurred_at) <= p_to))
  select coalesce(sum(functional_amount) filter (
                    where status = 'percibido'
                       or (status = 'pendiente_reintegro' and reversada_el > p_to)), 0),
         coalesce(sum(functional_amount) filter (
                    where status = 'pendiente_reintegro' and reversada_el > p_to), 0),
         count(*) filter (where status = 'pendiente_reintegro' and reversada_el > p_to)
    from percepciones
$roto$;
select is(
  pg_temp.igtf21((select q1_from from q21), (select q1_from from q21)),
  '70.00000000 / 30.00000000 / 2',
  'VARIANTE ROTA: comparando contra el fin del rango, el día suelto cuenta lo reversado dentro de su quincena');

select * from finish();
rollback;
