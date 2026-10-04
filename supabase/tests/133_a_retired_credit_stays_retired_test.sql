-- =============================================================================
-- 133 · Un saldo a favor retirado se queda retirado, y los saldos a favor vivos son el pasivo
--       del mayor (migraciones 20261004190200, 190300, 190400 y 190500)
-- =============================================================================
-- Lo que prueba (propiedades duraderas del esquema final):
--   a. `customer_credit_ledger_gap` con SALDOS A FAVOR REALES, por cada camino: nace por nota de
--      crédito, por recibo de devolución y por el sobrante de un cobro; se aplica; se reembolsa;
--      se retira al reversar su cobro. Da cero en cada paso, y cada camino tiene su VARIANTE ROTA
--      con su cifra. Un saldo AGOTADO que todavía carga algo da su fila propia (`exhausted`);
--   b. las funciones se EJERCEN como la API (no se pregunta por el privilegio): bajo la RLS,
--      `customer_credit_carried` responde —incluido el camino que redondea al céntimo, que es el
--      que 20261004190200 dejó sin permiso y 20261004190300 corrige— y el invariante ve lo mismo;
--   c. el trigger: una fila `expired` no vuelve a `available` ni a `applied` ni sube su
--      `applied_amount` (23514); un saldo vivo sí se consume; y sin el trigger, el retirado
--      resucita (la variante rota: el 23514 lo produce el trigger y nada más);
--   d. `payments.credit_functional_amount` solo acompaña a un cobro con saldo a favor (23514).
-- Aislamiento: no hay tablas nuevas; el de customer_credits, payments y customer_refunds lo
-- prueban 020, 034 y 047.
-- Lo que NO prueba este fichero y prueba apps/api/test/e2e-moneda-diferencial.test.ts («revisión
-- 3»): la regla proporcional del dominio, el uso que agota, y la revaluación desde
-- customer_credit_carried (necesita una tasa de cierre global).
-- =============================================================================
begin;
select plan(29);

insert into auth.users (id) values ('aaaa0133-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0133-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'pgtap-133', true);
insert into public.tenants (id, name) values
  ('aaaa0133-0000-4000-8000-00000000000a', 'Tenant 133');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000000a',
   'J-133-A', 'Empresa 133', 'VES', 'ordinario');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
        'ordinario', '2000-01-01', 'Montaje pgTAP 133', 'pgtap');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0133-0000-4000-8000-0000000000a3', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0133-0000-4000-8000-00000000c00a', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', 'J-CLI-133', 'Cliente 133', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0133-0000-4000-8000-00000000e10a', 'aaaa0133-0000-4000-8000-00000000000a',
        'aaaa0133-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0133-0000-4000-8000-0000000ac001', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', '1.1.01.133', 'Caja Bs 133', 'activo', 'deudora',
   true, 1),
  ('aaaa0133-0000-4000-8000-0000000ac002', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', '1.1.03.133', 'Cuentas por cobrar 133', 'activo',
   'deudora', true, 1),
  ('aaaa0133-0000-4000-8000-0000000ac003', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', '4.1.01.133', 'Ventas 133', 'ingreso', 'acreedora',
   true, 1),
  ('aaaa0133-0000-4000-8000-0000000ac004', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', '2.1.09.133', 'Saldos a favor de clientes 133',
   'pasivo', 'acreedora', true, 1);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
   'ar_general', 'aaaa0133-0000-4000-8000-0000000ac002'),
  ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
   'customer_credit_liability', 'aaaa0133-0000-4000-8000-0000000ac004');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0133-0000-4000-8000-00000000ca01', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', 'Caja Bs 133', 'VES', 'cash');

-- Un asiento posteado. `p_lineas`: [[último dígito de la cuenta, debe, haber], …].
create function pg_temp.asiento_133(p_id uuid, p_kind text, p_source uuid, p_event text,
                                    p_lineas jsonb, p_reversa_de uuid default null)
returns void language plpgsql as $$
declare l jsonb; n int := 0;
begin
  insert into public.journal_entries
    (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version, is_reversal_of)
  values (p_id, 'aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
          platform.period_for_date('aaaa0133-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), p_kind, p_source, p_event, 'Montaje pgTAP 133',
          'pgtap-133', p_reversa_de);
  for l in select * from jsonb_array_elements(p_lineas) loop
    n := n + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
    values ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
            p_id, n, ('aaaa0133-0000-4000-8000-0000000ac00' || (l ->> 0))::uuid,
            (l ->> 1)::numeric, (l ->> 2)::numeric,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 1,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 'identidad', now(),
            (l ->> 1)::numeric, (l ->> 2)::numeric);
  end loop;
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0133-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number(
           'aaaa0133-0000-4000-8000-0000000000a2',
           extract(year from platform.caracas_day(now()))::int)
   where id = p_id;
end $$;
-- Lo que dice el invariante: «tipo:esperado|mayor|brecha», una por fila, o «cero».
create function pg_temp.brecha_133() returns text language sql as $$
  select coalesce(
    (select string_agg(g.kind || ':' || round(g.expected, 2)::text || '|'
                       || round(g.ledger, 2)::text || '|' || round(g.gap, 2)::text, ' ; '
                       order by g.kind, g.gap)
       from platform.customer_credit_ledger_gap('aaaa0133-0000-4000-8000-0000000000a2') g),
    'cero');
$$;
-- Un cobro con saldo a favor (sin caja) y su asiento: baja el pasivo y la cuenta por cobrar.
create function pg_temp.aplicar_133(p_n text, p_credito uuid, p_importe numeric, p_asentado numeric)
returns void language plpgsql as $$
begin
  insert into public.payments
    (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
     rate_timestamp, functional_amount, instrument, customer_credit_id,
     settled_transaction_amount, cancelled_functional_amount, credit_functional_amount)
  values (('aaaa0133-0000-4000-8000-00000000e0' || p_n)::uuid,
          'aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
          'aaaa0133-0000-4000-8000-00000000f001', now(), 'VES', p_importe, 1, 'identidad', now(),
          p_importe, 'saldo_a_favor', p_credito, p_importe, p_asentado, p_importe);
  perform pg_temp.asiento_133(('aaaa0133-0000-4000-8000-0000000e0e' || p_n)::uuid,
    'payment_received', ('aaaa0133-0000-4000-8000-00000000e0' || p_n)::uuid, 'ar.credit_applied',
    jsonb_build_array(jsonb_build_array('4', p_asentado, 0), jsonb_build_array('2', 0, p_asentado)));
  update public.customer_credits
     set applied_amount = applied_amount + p_importe,
         status = case when applied_amount + p_importe >= amount then 'applied' else status end
   where id = p_credito;
end $$;
-- Un reembolso de saldo a favor desde la caja y su asiento.
create function pg_temp.reembolsar_133(p_n text, p_credito uuid, p_importe numeric,
                                       p_asentado numeric)
returns void language plpgsql as $$
begin
  insert into public.customer_refunds
    (id, tenant_id, company_id, customer_credit_id, account_id, reason,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     credit_amount, credit_currency, credit_functional_amount)
  values (('aaaa0133-0000-4000-8000-00000000ee' || p_n)::uuid,
          'aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
          p_credito, 'aaaa0133-0000-4000-8000-00000000ca01', 'El cliente pidió su dinero',
          p_importe, 'VES', p_importe, 'VES', p_importe, 'VES', p_importe);
  perform pg_temp.asiento_133(('aaaa0133-0000-4000-8000-0000000e0b' || p_n)::uuid,
    'customer_refund', ('aaaa0133-0000-4000-8000-00000000ee' || p_n)::uuid, 'ar.credit_refunded',
    jsonb_build_array(jsonb_build_array('4', p_asentado, 0), jsonb_build_array('1', 0, p_asentado)));
  update public.customer_credits set applied_amount = applied_amount + p_importe
   where id = p_credito;
end $$;

-- ── a. Los caminos por los que NACE un saldo a favor ─────────────────────────
-- F1 (1.160), F2 (500), F3 (300) · NC de F1 (116) · recibo de devolución (50).
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0f01', 'sales_invoice',
  'aaaa0133-0000-4000-8000-00000000f001', 'fiscal.invoice.issued',
  '[["2", 1160, 0], ["3", 0, 1160]]');
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0f02', 'sales_invoice',
  'aaaa0133-0000-4000-8000-00000000f002', 'fiscal.invoice.issued',
  '[["2", 500, 0], ["3", 0, 500]]');
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0f03', 'sales_invoice',
  'aaaa0133-0000-4000-8000-00000000f003', 'fiscal.invoice.issued',
  '[["2", 300, 0], ["3", 0, 300]]');
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0f05', 'sales_credit_note',
  'aaaa0133-0000-4000-8000-00000000f005', 'fiscal.credit_note.issued',
  '[["3", 116, 0], ["4", 0, 116]]');
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0f06', 'sales_receipt_return',
  'aaaa0133-0000-4000-8000-00000000f006', 'sales.receipt_return.issued',
  '[["3", 50, 0], ["4", 0, 50]]');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
   journal_entry_id)
select ('aaaa0133-0000-4000-8000-00000000f00' || v.n)::uuid,
       'aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2', v.kind,
       'A', 'aaaa0133-0000-4000-8000-00000000c00a', v.numero, 13300 + v.n, 'issued', now(),
       'aaaa0133-0000-4000-8000-00000000e10a', 'test-133', v.origen::uuid,
       'VES', 'VES', 1, 'identidad', v.total, v.total, v.total, 0, v.total, v.asiento::uuid
  from (values
    (1, 'invoice', 1, 1160, null, 'aaaa0133-0000-4000-8000-0000000e0f01'),
    (2, 'invoice', 2, 500, null, 'aaaa0133-0000-4000-8000-0000000e0f02'),
    (3, 'invoice', 3, 300, null, 'aaaa0133-0000-4000-8000-0000000e0f03'),
    (5, 'credit_note', 1, 116, 'aaaa0133-0000-4000-8000-00000000f001',
     'aaaa0133-0000-4000-8000-0000000e0f05')
  ) as v(n, kind, numero, total, origen, asiento);
-- El recibo de devolución es de una empresa que emite recibos; el régimen de este montaje
-- (formatos libres) no lo emite, y aquí solo importa su saldo a favor: se monta por debajo, con
-- los triggers de emisión apagados y lo que la procedencia habría puesto, a mano.
alter table public.documents disable trigger user;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, status, issued_at,
   regime_version_id, rules_version, source_document_id, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount, journal_entry_id, created_at, version)
values ('aaaa0133-0000-4000-8000-00000000f006', 'aaaa0133-0000-4000-8000-00000000000a',
        'aaaa0133-0000-4000-8000-0000000000a2', 'receipt_return', 'R',
        'aaaa0133-0000-4000-8000-00000000c00a', 1, 'issued', now(),
        'aaaa0133-0000-4000-8000-00000000e10a', 'test-133',
        'aaaa0133-0000-4000-8000-00000000f002', 'VES', 'VES', 1, 'identidad', 50, 50, 50, 0, 50,
        'aaaa0133-0000-4000-8000-0000000e0f06', now(), 1);
alter table public.documents enable trigger user;
-- P2: 600 para una factura de 500 — sobran 100, que nacen como saldo a favor.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount,
   credited_functional_amount, cancelled_functional_amount)
values ('aaaa0133-0000-4000-8000-00000000e002', 'aaaa0133-0000-4000-8000-00000000000a',
        'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000f002', now(),
        'VES', 600, 1, 'identidad', now(), 600, 'efectivo_bs',
        'aaaa0133-0000-4000-8000-00000000ca01', 500, 100, 500);
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0e02', 'payment_received',
  'aaaa0133-0000-4000-8000-00000000e002', 'ar.payment_applied',
  '[["1", 600, 0], ["2", 0, 500], ["4", 0, 100]]');
-- cc05 y cc06 SIN importe funcional (como todo saldo anterior a 20261004150000): lo que nacieron
-- se redondea al céntimo desde su importe — el camino que usa platform.round_cents.
insert into public.customer_credits
  (id, tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency,
   fx_rate, rate_source, functional_amount)
values
  ('aaaa0133-0000-4000-8000-00000000cc02', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000c00a',
   'aaaa0133-0000-4000-8000-00000000f002', 'aaaa0133-0000-4000-8000-00000000e002', 100, 'VES',
   1, 'identidad', 100),
  ('aaaa0133-0000-4000-8000-00000000cc05', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000c00a',
   'aaaa0133-0000-4000-8000-00000000f005', null, 116, 'VES', null, null, null),
  ('aaaa0133-0000-4000-8000-00000000cc06', 'aaaa0133-0000-4000-8000-00000000000a',
   'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000c00a',
   'aaaa0133-0000-4000-8000-00000000f006', null, 50, 'VES', null, null, null);

select is(pg_temp.brecha_133(), 'cero',
  'a. nacidos por nota de crédito (116), por recibo de devolución (50) y por sobrante (100): saldos a favor = pasivo del mayor (266)');

-- ── a. Se aplica y se reembolsa ──────────────────────────────────────────────
select pg_temp.aplicar_133('07', 'aaaa0133-0000-4000-8000-00000000cc05', 50, 50);
select is(pg_temp.brecha_133(), 'cero',
  'a. aplicados 50 del saldo de la nota a una factura: el pasivo baja lo mismo (216)');
select pg_temp.reembolsar_133('01', 'aaaa0133-0000-4000-8000-00000000cc02', 30, 30);
select is(pg_temp.brecha_133(), 'cero',
  'a. reembolsados 30 del sobrante desde la caja: el pasivo baja lo mismo (186)');

-- ── a. Se retira al reversar el cobro que lo creó ────────────────────────────
-- P8: 400 para una factura de 300 — sobran 100. Después se reversa.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount,
   credited_functional_amount, cancelled_functional_amount)
values ('aaaa0133-0000-4000-8000-00000000e008', 'aaaa0133-0000-4000-8000-00000000000a',
        'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000f003', now(),
        'VES', 400, 1, 'identidad', now(), 400, 'efectivo_bs',
        'aaaa0133-0000-4000-8000-00000000ca01', 300, 100, 300);
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0e08', 'payment_received',
  'aaaa0133-0000-4000-8000-00000000e008', 'ar.payment_applied',
  '[["1", 400, 0], ["2", 0, 300], ["4", 0, 100]]');
insert into public.customer_credits
  (id, tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency,
   fx_rate, rate_source, functional_amount)
values ('aaaa0133-0000-4000-8000-00000000cc08', 'aaaa0133-0000-4000-8000-00000000000a',
        'aaaa0133-0000-4000-8000-0000000000a2', 'aaaa0133-0000-4000-8000-00000000c00a',
        'aaaa0133-0000-4000-8000-00000000f003', 'aaaa0133-0000-4000-8000-00000000e008', 100,
        'VES', 1, 'identidad', 100);
select is(pg_temp.brecha_133(), 'cero', 'a. otro sobrante de 100: saldos a favor = pasivo (286)');

insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
        'aaaa0133-0000-4000-8000-00000000e008', 'aaaa0133-0000-4000-8000-00000000f003',
        'El cobro era de otro cliente', 'VES', 400, 400);
update public.customer_credits set status = 'expired'
 where id = 'aaaa0133-0000-4000-8000-00000000cc08';
select is(pg_temp.brecha_133(), 'ledger:186.00|286.00|-100.00',
  'a. ROTO (se retira): el saldo retirado SIN el contra-asiento de su cobro da fila — el mayor todavía carga sus 100');
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0e09', 'manual', null, null,
  '[["2", 300, 0], ["4", 100, 0], ["1", 0, 400]]', 'aaaa0133-0000-4000-8000-0000000e0e08');
update public.journal_entries
   set status = 'reversed', reversed_by_entry_id = 'aaaa0133-0000-4000-8000-0000000e0e09'
 where id = 'aaaa0133-0000-4000-8000-0000000e0e08';
select is(pg_temp.brecha_133(), 'cero',
  'a. con el contra-asiento, el saldo retirado no cuenta en ningún lado: cero (186)');

-- ── b. Como la API, bajo la RLS: se EJERCE ───────────────────────────────────
set local role ladino_api;
select is(
  platform.customer_credit_carried('aaaa0133-0000-4000-8000-0000000000a2',
                                   'aaaa0133-0000-4000-8000-00000000cc05'),
  66::numeric,
  'b. ladino_api lee lo que el mayor carga por un saldo SIN importe funcional (redondea al céntimo): 116 − 50');
select is(
  platform.customer_credit_carried('aaaa0133-0000-4000-8000-0000000000a2',
                                   'aaaa0133-0000-4000-8000-00000000cc02'),
  70::numeric, 'b. y por el sobrante reembolsado en parte: 100 − 30');
select is(
  (select count(*)::int
     from platform.customer_credit_ledger_gap('aaaa0133-0000-4000-8000-0000000000a2')),
  0, 'b. ladino_api con el actor de la empresa lee saldos a favor y mayor: cero filas');
reset role;
select set_config('request.jwt.claims',
  '{"sub":"aaaa0133-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*)::int
     from platform.customer_credit_ledger_gap('aaaa0133-0000-4000-8000-0000000000a2')),
  0, 'b. authenticated de la empresa: cero filas');
reset role;
select is(
  platform.customer_credit_carried('aaaa0133-0000-4000-8000-0000000000a2',
                                   'aaaa0133-0000-4000-8000-00000000cc05',
                                   platform.caracas_day(now()) - 1),
  116::numeric, 'b. a una fecha anterior al uso, el saldo cargaba lo que nació');

-- ── a. Las variantes rotas: una por camino ───────────────────────────────────
savepoint nace_por_nota;
update public.customer_credits set amount = 100
 where id = 'aaaa0133-0000-4000-8000-00000000cc05';
select is(pg_temp.brecha_133(), 'ledger:170.00|186.00|-16.00',
  'a. ROTO (nace por nota): la nota acreditó 116 al pasivo y el saldo dice 100');
rollback to savepoint nace_por_nota;

savepoint nace_por_sobrante;
update public.customer_credits set amount = 90, functional_amount = 90
 where id = 'aaaa0133-0000-4000-8000-00000000cc02';
select is(pg_temp.brecha_133(), 'ledger:176.00|186.00|-10.00',
  'a. ROTO (nace por sobrante): el cobro acreditó 100 al pasivo y el saldo dice 90');
rollback to savepoint nace_por_sobrante;

savepoint nace_por_devolucion;
update public.customer_credits set amount = 45
 where id = 'aaaa0133-0000-4000-8000-00000000cc06';
select is(pg_temp.brecha_133(), 'ledger:181.00|186.00|-5.00',
  'a. ROTO (nace por devolución): el recibo de devolución acreditó 50 y el saldo dice 45');
rollback to savepoint nace_por_devolucion;

savepoint se_aplica;
select pg_temp.aplicar_133('10', 'aaaa0133-0000-4000-8000-00000000cc06', 20, 15);
select is(pg_temp.brecha_133(), 'ledger:166.00|171.00|-5.00',
  'a. ROTO (se aplica): el cobro dice que bajó 20 del pasivo y su asiento debitó 15');
rollback to savepoint se_aplica;

savepoint se_reembolsa;
select pg_temp.reembolsar_133('02', 'aaaa0133-0000-4000-8000-00000000cc06', 10, 8);
select is(pg_temp.brecha_133(), 'ledger:176.00|178.00|-2.00',
  'a. ROTO (se reembolsa): el reembolso dice que bajó 10 del pasivo y su asiento debitó 8');
rollback to savepoint se_reembolsa;

savepoint agotado_con_resto;
select pg_temp.aplicar_133('11', 'aaaa0133-0000-4000-8000-00000000cc06', 49, 49);
update public.customer_credits set applied_amount = 50, status = 'applied'
 where id = 'aaaa0133-0000-4000-8000-00000000cc06';
select is(pg_temp.brecha_133(), 'exhausted:0.00|1.00|-1.00',
  'a. ROTO (se agota): un saldo agotado cuyos usos bajaron 49 de los 50 que nació da SU fila — el pasivo no volvió a cero');
rollback to savepoint agotado_con_resto;

savepoint asiento_suelto;
select pg_temp.asiento_133('aaaa0133-0000-4000-8000-0000000e0e12', 'manual', null, null,
  '[["3", 7, 0], ["4", 0, 7]]');
select is(pg_temp.brecha_133(), 'ledger:186.00|193.00|-7.00',
  'a. ROTO: un asiento manual de 7 sobre la cuenta de saldos a favor da fila — sin lista de perdones');
set local role ladino_api;
select is(
  (select g.kind || ':' || round(g.gap, 2)::text
     from platform.customer_credit_ledger_gap('aaaa0133-0000-4000-8000-0000000000a2') g),
  'ledger:-7.00', 'a. y la API ve la MISMA fila: bajo la RLS el invariante no se queda ciego');
reset role;
rollback to savepoint asiento_suelto;

select is(pg_temp.brecha_133(), 'cero',
  'a. deshechas las variantes, vuelve a cero: cada fila la produjo SU rotura');

-- ── c. Un saldo a favor retirado se queda retirado ───────────────────────────
select throws_ok($$
  update public.customer_credits set status = 'available'
   where id = 'aaaa0133-0000-4000-8000-00000000cc08'
$$, '23514', null, 'c. un saldo retirado no vuelve a estar disponible');
select throws_ok($$
  update public.customer_credits set applied_amount = 100, status = 'applied'
   where id = 'aaaa0133-0000-4000-8000-00000000cc08'
$$, '23514', null, 'c. ni se consume: no pasa a aplicado');
select throws_ok($$
  update public.customer_credits set applied_amount = 40
   where id = 'aaaa0133-0000-4000-8000-00000000cc08'
$$, '23514', null, 'c. ni sube su importe aplicado quedándose retirado');
-- Como la API: el trigger dispara también bajo ladino_api, aunque nadie tenga EXECUTE sobre su
-- función (20261004190500 se lo quitó a PUBLIC; el permiso se comprueba al crear el trigger).
set local role ladino_api;
select throws_ok($$
  update public.customer_credits set status = 'available'
   where id = 'aaaa0133-0000-4000-8000-00000000cc08'
$$, '23514', null, 'c. ladino_api tampoco resucita un saldo retirado: el trigger dispara bajo su rol');
reset role;
select is((select status from public.customer_credits
            where id = 'aaaa0133-0000-4000-8000-00000000cc08'), 'expired',
  'c. y el dato no cambió: sigue retirado');
select lives_ok($$
  update public.customer_credits set applied_amount = applied_amount + 1
   where id = 'aaaa0133-0000-4000-8000-00000000cc06'
$$, 'c. un saldo DISPONIBLE sí se consume: el trigger no cierra el camino autorizado');
update public.customer_credits set applied_amount = applied_amount - 1
 where id = 'aaaa0133-0000-4000-8000-00000000cc06';

-- Variante rota: sin el trigger, el retirado resucita. Si esto NO lo dejara pasar, el 23514 de
-- arriba lo estaría produciendo otra cosa.
alter table public.customer_credits disable trigger customer_credits_retired;
select lives_ok($$
  update public.customer_credits set status = 'available'
   where id = 'aaaa0133-0000-4000-8000-00000000cc08'
$$, 'c. variante rota: sin el trigger, el saldo retirado vuelve a estar disponible');
-- (La primera versión del invariante, 20261004190200, decía «cero» aquí: solo sumaba los saldos
-- con asiento posteado, y el de un resucitado está reversado. 20261004190400 añadió la fila.)
select is(pg_temp.brecha_133(), 'unborn:100.00|0.00|100.00',
  'c. y el invariante lo acusa: un saldo resucitado es un pasivo que el mayor no tiene');
update public.customer_credits set status = 'expired'
 where id = 'aaaa0133-0000-4000-8000-00000000cc08';
alter table public.customer_credits enable trigger customer_credits_retired;

-- ── d. credit_functional_amount solo acompaña a un cobro con saldo a favor ───
select throws_ok($$
  insert into public.payments
    (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
     rate_timestamp, functional_amount, instrument, account_id, credit_functional_amount)
  values ('aaaa0133-0000-4000-8000-00000000000a', 'aaaa0133-0000-4000-8000-0000000000a2',
          'aaaa0133-0000-4000-8000-00000000f001', now(), 'VES', 10, 1, 'identidad', now(), 10,
          'efectivo_bs', 'aaaa0133-0000-4000-8000-00000000ca01', 10)
$$, '23514', null, 'd. un cobro en efectivo no dice haber bajado el pasivo de un saldo a favor');

select * from finish();
rollback;
