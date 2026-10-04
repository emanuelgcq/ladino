-- =============================================================================
-- 125 · El saldo a favor conserva su moneda, el pago de más nace como saldo a favor y la
--       cartera por documento es la cuenta por cobrar del mayor
--       (F-10, F-12, G-05, G-15 · migraciones 20261004150000 y 20261004190000)
-- =============================================================================
-- Lo que prueba (propiedades duraderas del esquema final, no estados intermedios):
--   a. customer_credits: la tasa con que nació, su fuente y su importe funcional van JUNTOS o no
--      van; una tasa de cero se rechaza. Ejerciendo el INSERT: el caso malo muere en el CHECK
--      (23514) y el bueno lo pasa y muere después, en la llave foránea (23503);
--   b. la variante rota de (a): sin el CHECK, el caso malo llega a la llave foránea. Si no
--      llegara, el 23514 de (a) lo estaría produciendo otra cosa;
--   c. el vocabulario de importes admite `credit_surplus` en las DOS tablas de líneas y sigue
--      rechazando uno inventado (23514), con su variante rota;
--   d. el preset ve_basico: el cobro lleva UNA línea del sobrante, al pasivo de saldos a favor, al
--      haber y solo si hay importe; el reembolso baja el pasivo por `total` y lleva sus dos
--      líneas de diferencial, cada una con su signo;
--   e. las funciones responden al rol de la API (se EJERCEN, no se pregunta por el privilegio):
--      una empresa sin cartera no da fila en `receivables_ledger_gap`, `fx_revaluation_items` no
--      inventa partidas y `document_balance` de un documento que no existe es NULL;
--   f. F-12 con CARTERA REAL (factura fiada, cobro parcial, cobro con sobrante, nota de crédito,
--      factura en la cola, cobro reversado): `receivables_ledger_gap` da cero, también como la
--      API, y CUATRO variantes rotas dentro de este fichero dan cada una su fila con su cifra;
--   g. un cobro deja UN saldo a favor: el único parcial por `source_payment_id` (23505), y sin él
--      el segundo sobrante entra.
-- Aislamiento: las migraciones no crean tablas; añaden columnas a customer_credits,
-- customer_refunds y payments, cuyo aislamiento prueban 020 y 034 (ventas) y 047 (reembolsos).
-- Lo que NO prueba este fichero y prueba apps/api/test/e2e-moneda-diferencial.test.ts («ola 4»):
-- el asiento del pago de más, la aplicación y el reembolso en divisa con su diferencial, la
-- revaluación del pasivo, y el invariante con sus DOS variantes rotas (una factura que deja de
-- contar con su cargo vivo en el mayor; un cobro que dice haber cancelado otra cifra).
-- =============================================================================
begin;
select plan(34);

-- ── a. La tasa, su fuente y el funcional van juntos ──────────────────────────
select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          1, 'USD', 850)
$$, '23514', null, 'a. una tasa sin su fuente ni su importe funcional se rechaza en el CHECK');

select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate,
     rate_source, functional_amount)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          1, 'USD', 0, 'BCV', 850)
$$, '23514', null, 'a. una tasa de cero se rechaza');

select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate,
     rate_source, functional_amount)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          1, 'USD', 850, 'BCV', 850)
$$, '23503', null, 'a. con los tres juntos pasa el CHECK y muere después, en la llave foránea');

select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, amount, currency)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 1, 'VES')
$$, '23503', null,
  'a. sin ninguno de los tres (un saldo a favor en moneda funcional) también pasa el CHECK');

-- ── b. Variante rota ─────────────────────────────────────────────────────────
alter table public.customer_credits drop constraint customer_credits_rate_whole_chk;
select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate)
  values (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          1, 'USD', 850)
$$, '23503', null,
  'b. sin el CHECK, la tasa suelta llega a la llave foránea: el 23514 de (a) lo produce el CHECK');

-- ── c. El vocabulario de importes ────────────────────────────────────────────
select lives_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select e.id, 9001, 'customer_credit_liability', 'credit_surplus', 'credit',
         'if_amount_nonzero', 'pgTAP 125'
    from public.journal_template_preset_entries e
   where e.preset_code = 've_basico' and e.source_kind = 'payment_received'
     and e.source_event = 'ar.payment_applied'
$$, 'c. credit_surplus entra en las líneas del preset');

select throws_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select e.id, 9002, 'customer_credit_liability', 'importe_inventado', 'credit',
         'if_amount_nonzero', 'pgTAP 125'
    from public.journal_template_preset_entries e
   where e.preset_code = 've_basico' and e.source_kind = 'payment_received'
     and e.source_event = 'ar.payment_applied'
$$, '23514', null, 'c. un importe inventado se sigue rechazando en el preset');

select ok(
  pg_get_constraintdef((select c.oid from pg_catalog.pg_constraint c
                         where c.conrelid = 'public.journal_template_lines'::regclass
                           and c.conname = 'journal_template_lines_amount_chk'))
    like '%credit_surplus%owner_contribution%'
  or pg_get_constraintdef((select c.oid from pg_catalog.pg_constraint c
                            where c.conrelid = 'public.journal_template_lines'::regclass
                              and c.conname = 'journal_template_lines_amount_chk'))
    like '%owner_contribution%credit_surplus%',
  'c. el CHECK de las plantillas de empresa admite credit_surplus sin perder owner_contribution');

alter table public.journal_template_preset_lines
  drop constraint journal_template_preset_lines_amount_chk;
select lives_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select e.id, 9003, 'customer_credit_liability', 'importe_inventado', 'credit',
         'if_amount_nonzero', 'pgTAP 125'
    from public.journal_template_preset_entries e
   where e.preset_code = 've_basico' and e.source_kind = 'payment_received'
     and e.source_event = 'ar.payment_applied'
$$, 'c. variante rota: sin el CHECK, el importe inventado entra');

-- ── d. Las plantillas del preset ─────────────────────────────────────────────
select is(
  (select array_agg(l.account_purpose || '/' || l.side || '/' || l.condition_kind)
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'payment_received'
      and e.source_event = 'ar.payment_applied' and l.amount_source = 'credit_surplus'
      and l.line_number < 9000),
  array['customer_credit_liability/credit/if_amount_nonzero'],
  'd. el cobro lleva UNA línea del sobrante: al pasivo de saldos a favor, al haber, si hay importe');

select is(
  (select l.amount_source
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'customer_refund'
      and e.source_event = 'ar.credit_refunded'
      and l.account_purpose = 'customer_credit_liability'),
  'total', 'd. el reembolso baja el pasivo por «total»: lo que llevaba, a la tasa con que nació');

select is(
  (select l.amount_source
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'customer_refund'
      and e.source_event = 'ar.credit_refunded' and l.account_purpose = 'treasury_account'),
  'functional_amount', 'd. y la caja sale por «functional_amount»: lo que salió, a la tasa del día');

select is(
  (select array_agg(l.account_purpose || '/' || l.side || '/' || l.condition_kind
                    order by l.line_number)
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'customer_refund'
      and e.source_event = 'ar.credit_refunded' and l.amount_source = 'exchange_difference'),
  array['exchange_gain/credit/if_positive', 'exchange_loss/debit/if_negative'],
  'd. el reembolso lleva sus dos líneas de diferencial, cada una con su signo');

-- ── e. Las funciones, ejercidas como la API ──────────────────────────────────
set local role ladino_api;
select lives_ok($$ select * from platform.receivables_ledger_gap(gen_random_uuid()) $$,
  'e. la API puede llamar a receivables_ledger_gap');
select is((select count(*)::int from platform.receivables_ledger_gap(gen_random_uuid())), 0,
  'e. una empresa sin cuenta por cobrar no da fila: no hay nada que comparar');
select is((select count(*)::int
             from platform.fx_revaluation_items(gen_random_uuid(), current_date)), 0,
  'e. fx_revaluation_items no inventa partidas para una empresa que no existe');
select is(platform.document_balance(gen_random_uuid(), gen_random_uuid()), null::numeric,
  'e. el saldo de un documento que no existe es NULL, no cero');
reset role;

-- =============================================================================
-- f. F-12 CON CARTERA REAL: `receivables_ledger_gap` sobre una empresa con una factura fiada, un
--    cobro parcial, un cobro con sobrante (y su saldo a favor), una nota de crédito, una factura
--    en la cola y un cobro reversado. Cada asiento es el que escribiría el caso de uso.
--    Las variantes rotas van DENTRO: cada una mueve una sola pieza y el invariante dice cuánto.
-- g. La clave natural del sobrante: un cobro deja UN saldo a favor (único parcial por
--    `source_payment_id`), con su variante rota.
-- =============================================================================
insert into auth.users (id) values ('aaaa0125-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0125-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'pgtap-125', true);
insert into public.tenants (id, name) values
  ('aaaa0125-0000-4000-8000-00000000000a', 'Tenant 125');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0125-0000-4000-8000-0000000000a2', 'aaaa0125-0000-4000-8000-00000000000a',
   'J-125-A', 'Empresa 125', 'VES', 'ordinario');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
        'ordinario', '2000-01-01', 'Montaje pgTAP 125', 'pgtap');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0125-0000-4000-8000-0000000000a3', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0125-0000-4000-8000-00000000c00a', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', 'J-CLI-125', 'Cliente 125', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0125-0000-4000-8000-00000000e10a', 'aaaa0125-0000-4000-8000-00000000000a',
        'aaaa0125-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0125-0000-4000-8000-0000000ac001', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', '1.1.01.125', 'Caja Bs 125', 'activo', 'deudora',
   true, 1),
  ('aaaa0125-0000-4000-8000-0000000ac002', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', '1.1.03.125', 'Cuentas por cobrar 125', 'activo',
   'deudora', true, 1),
  ('aaaa0125-0000-4000-8000-0000000ac003', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', '4.1.01.125', 'Ventas 125', 'ingreso', 'acreedora',
   true, 1),
  ('aaaa0125-0000-4000-8000-0000000ac004', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', '2.1.09.125', 'Saldos a favor de clientes 125',
   'pasivo', 'acreedora', true, 1);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
   'ar_general', 'aaaa0125-0000-4000-8000-0000000ac002'),
  ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
   'customer_credit_liability', 'aaaa0125-0000-4000-8000-0000000ac004');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0125-0000-4000-8000-00000000ca01', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', 'Caja Bs 125', 'VES', 'cash');

-- Un asiento posteado. `p_lineas`: [[último dígito de la cuenta, debe, haber], …].
create function pg_temp.asiento_125(p_id uuid, p_kind text, p_source uuid, p_event text,
                                    p_lineas jsonb, p_reversa_de uuid default null)
returns void language plpgsql as $$
declare l jsonb; n int := 0;
begin
  insert into public.journal_entries
    (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version, is_reversal_of)
  values (p_id, 'aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
          platform.period_for_date('aaaa0125-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), p_kind, p_source, p_event, 'Montaje pgTAP 125',
          'pgtap-125', p_reversa_de);
  for l in select * from jsonb_array_elements(p_lineas) loop
    n := n + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
    values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
            p_id, n, ('aaaa0125-0000-4000-8000-0000000ac00' || (l ->> 0))::uuid,
            (l ->> 1)::numeric, (l ->> 2)::numeric,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 1,
            greatest((l ->> 1)::numeric, (l ->> 2)::numeric), 'VES', 'identidad', now(),
            (l ->> 1)::numeric, (l ->> 2)::numeric);
  end loop;
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0125-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number(
           'aaaa0125-0000-4000-8000-0000000000a2',
           extract(year from platform.caracas_day(now()))::int)
   where id = p_id;
end $$;
-- Lo que dice el invariante, en una línea: «documentos|mayor|brecha|cola», o «cero» si no hay fila.
create function pg_temp.brecha_125() returns text language sql as $$
  select coalesce(
    (select round(g.documents, 2)::text || '|' || round(g.ledger, 2)::text || '|'
            || round(g.gap, 2)::text || '|' || round(g.queued, 2)::text
       from platform.receivables_ledger_gap('aaaa0125-0000-4000-8000-0000000000a2') g),
    'cero');
$$;

-- Los asientos de las facturas (cuenta por cobrar contra ventas) y el de la nota de crédito
-- (ventas contra el pasivo de saldos a favor: hoy una NC no abona la cuenta por cobrar).
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0f01', 'sales_invoice',
  'aaaa0125-0000-4000-8000-00000000f001',
  'fiscal.invoice.issued', '[["2", 1160, 0], ["3", 0, 1160]]');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0f02', 'sales_invoice',
  'aaaa0125-0000-4000-8000-00000000f002',
  'fiscal.invoice.issued', '[["2", 500, 0], ["3", 0, 500]]');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0f03', 'sales_invoice',
  'aaaa0125-0000-4000-8000-00000000f003',
  'fiscal.invoice.issued', '[["2", 300, 0], ["3", 0, 300]]');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0f05', 'sales_credit_note',
  'aaaa0125-0000-4000-8000-00000000f005',
  'fiscal.credit_note.issued', '[["3", 116, 0], ["4", 0, 116]]');

-- F1 fiada (1.160) · F2 (500) · F3 (300) · F4 (200, sin asiento: en la cola) · NC de F1 (116).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
   journal_entry_id)
select ('aaaa0125-0000-4000-8000-00000000f00' || v.n)::uuid,
       'aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2', v.kind,
       'A', 'aaaa0125-0000-4000-8000-00000000c00a', v.numero, 12500 + v.n, 'issued', now(),
       'aaaa0125-0000-4000-8000-00000000e10a', 'test-125', v.origen::uuid,
       'VES', 'VES', 1, 'identidad', v.total, v.total, v.total, 0, v.total, v.asiento::uuid
  from (values
    (1, 'invoice', 1, 1160, null, 'aaaa0125-0000-4000-8000-0000000e0f01'),
    (2, 'invoice', 2, 500, null, 'aaaa0125-0000-4000-8000-0000000e0f02'),
    (3, 'invoice', 3, 300, null, 'aaaa0125-0000-4000-8000-0000000e0f03'),
    (4, 'invoice', 4, 200, null, null),
    (5, 'credit_note', 1, 116, 'aaaa0125-0000-4000-8000-00000000f001',
     'aaaa0125-0000-4000-8000-0000000e0f05')
  ) as v(n, kind, numero, total, origen, asiento);
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
        'sales_invoice', 'aaaa0125-0000-4000-8000-00000000f004', 'fiscal.invoice.issued',
        '{"total": "200.00"}'::jsonb, 'Sin plantilla configurada');

select is(pg_temp.brecha_125(), 'cero',
  'f. tres facturas con asiento, una en la cola y una nota de crédito: cartera = mayor (1.960)');

-- P1: abono de 400 a F1. P2: 600 para una factura de 500 — cancela 500 y sobran 100, que nacen
-- como saldo a favor. P3: 300 a F3, que después se reversa.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount,
   credited_functional_amount, cancelled_functional_amount)
select ('aaaa0125-0000-4000-8000-00000000e00' || v.n)::uuid,
       'aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
       ('aaaa0125-0000-4000-8000-00000000f00' || v.n)::uuid, now(), 'VES', v.importe, 1,
       'identidad', now(), v.importe, 'efectivo_bs', 'aaaa0125-0000-4000-8000-00000000ca01',
       v.cancelado, v.sobrante::numeric, v.cancelado
  from (values (1, 400, 400, null), (2, 600, 500, 100), (3, 300, 300, null))
       as v(n, importe, cancelado, sobrante);
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e01', 'payment_received',
  'aaaa0125-0000-4000-8000-00000000e001', 'ar.payment_applied',
  '[["1", 400, 0], ["2", 0, 400]]');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e02', 'payment_received',
  'aaaa0125-0000-4000-8000-00000000e002', 'ar.payment_applied',
  '[["1", 600, 0], ["2", 0, 500], ["4", 0, 100]]');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e03', 'payment_received',
  'aaaa0125-0000-4000-8000-00000000e003', 'ar.payment_applied',
  '[["1", 300, 0], ["2", 0, 300]]');
update public.documents set status = 'paid'
 where id in ('aaaa0125-0000-4000-8000-00000000f002', 'aaaa0125-0000-4000-8000-00000000f003');
insert into public.customer_credits
  (id, tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency)
values
  ('aaaa0125-0000-4000-8000-00000000cc02', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', 'aaaa0125-0000-4000-8000-00000000c00a',
   'aaaa0125-0000-4000-8000-00000000f002', 'aaaa0125-0000-4000-8000-00000000e002', 100, 'VES'),
  ('aaaa0125-0000-4000-8000-00000000cc05', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000a2', 'aaaa0125-0000-4000-8000-00000000c00a',
   'aaaa0125-0000-4000-8000-00000000f005', null, 116, 'VES');

select is(pg_temp.brecha_125(), 'cero',
  'f. con el abono, el cobro con sobrante y el cobro entero: cartera = mayor (760), y el sobrante no entra en la cuenta por cobrar');

-- La reversa de P3, en sus dos pasos. A MEDIAS (la fila de la reversa sin su contra-asiento) el
-- cobro ya no cuenta y el mayor todavía lo lleva: es la primera variante rota, y cae sola.
insert into public.payment_reversals
  (tenant_id, company_id, payment_id, document_id, reason, currency, amount, functional_amount)
values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
        'aaaa0125-0000-4000-8000-00000000e003', 'aaaa0125-0000-4000-8000-00000000f003',
        'El cobro era de otro cliente', 'VES', 300, 300);
update public.documents set status = 'issued' where id = 'aaaa0125-0000-4000-8000-00000000f003';
select is(pg_temp.brecha_125(), '1060.00|760.00|300.00|200.00',
  'f. ROTO: una reversa A MEDIAS (sin su contra-asiento) da fila — faltan 300 en el mayor, y la cola dice sus 200');
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e09', 'manual', null, null,
  '[["2", 300, 0], ["1", 0, 300]]', 'aaaa0125-0000-4000-8000-0000000e0e03');
update public.journal_entries
   set status = 'reversed', reversed_by_entry_id = 'aaaa0125-0000-4000-8000-0000000e0e09'
 where id = 'aaaa0125-0000-4000-8000-0000000e0e03';
select is(pg_temp.brecha_125(), 'cero',
  'f. con su contra-asiento, la reversa cuadra: cartera = mayor (1.060)');

-- Como la API, con el actor de la empresa: la función se EJERCE bajo la RLS, con cartera real.
set local role ladino_api;
select is(
  (select count(*)::int
     from platform.receivables_ledger_gap('aaaa0125-0000-4000-8000-0000000000a2')),
  0, 'f. ladino_api con el actor de la empresa lee la cartera y el mayor: cero filas');
reset role;

-- R-82 / ola 4 (sospecha comprobada y DESCARTADA): la función no es `security definer` —ningún
-- invariante de la familia lo es— y se sospechó que un `authenticated` que ve documentos pero no
-- el mayor recibiría una brecha FALSA. No puede: las policies de lectura de documents, payments,
-- journal_entries y journal_lines son la MISMA (`company_id in ladino_company_ids()`); el permiso
-- `accounting.read` no decide filas. Se ejerce: una persona de la empresa SIN `accounting.read`
-- lee cero filas con la cartera cuadrada y la MISMA fila con la cartera rota.
insert into auth.users (id) values ('aaaa0125-0000-4000-8000-0000000000b1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0125-0000-4000-8000-0000000000b2', null, 'pgtap125_vende_sin_mayor', 'Vende sin mayor',
   false);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0125-0000-4000-8000-0000000000b2', 'sales.invoice.issue');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0125-0000-4000-8000-0000000000b3', 'aaaa0125-0000-4000-8000-00000000000a',
   'aaaa0125-0000-4000-8000-0000000000b1');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id) values
  ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000b3',
   'aaaa0125-0000-4000-8000-0000000000b2', 'aaaa0125-0000-4000-8000-0000000000a2');
select is(
  platform.ladino_user_has_permission('aaaa0125-0000-4000-8000-0000000000b1', 'accounting.read',
                                      'aaaa0125-0000-4000-8000-0000000000a2'),
  false, 'f. el montaje: la persona de la empresa NO tiene accounting.read');
select set_config('request.jwt.claims',
  '{"sub":"aaaa0125-0000-4000-8000-0000000000b1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*)::int
     from platform.receivables_ledger_gap('aaaa0125-0000-4000-8000-0000000000a2')),
  0, 'f. authenticated SIN accounting.read, cartera cuadrada: cero filas — no hay brecha falsa');
reset role;

-- ROTO: un asiento que mueve la cuenta por cobrar sin ser un documento ni un cobro.
savepoint asiento_suelto;
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e10', 'manual', null, null,
  '[["2", 50, 0], ["3", 0, 50]]');
select is(pg_temp.brecha_125(), '1060.00|1110.00|-50.00|200.00',
  'f. ROTO: un asiento manual de 50 sobre la cuenta por cobrar da fila — sin lista de perdones');
set local role ladino_api;
select is(
  (select round(g.documents, 2)::text || '|' || round(g.ledger, 2)::text || '|'
          || round(g.gap, 2)::text || '|' || round(g.queued, 2)::text
     from platform.receivables_ledger_gap('aaaa0125-0000-4000-8000-0000000000a2') g),
  '1060.00|1110.00|-50.00|200.00',
  'f. y la API ve la MISMA fila: bajo la RLS el invariante no se queda ciego');
reset role;
set local role authenticated;
select is(
  (select round(g.documents, 2)::text || '|' || round(g.ledger, 2)::text || '|'
          || round(g.gap, 2)::text || '|' || round(g.queued, 2)::text
     from platform.receivables_ledger_gap('aaaa0125-0000-4000-8000-0000000000a2') g),
  '1060.00|1110.00|-50.00|200.00',
  'f. y authenticated SIN accounting.read ve la MISMA fila: ni ciego ni con una brecha propia');
reset role;
rollback to savepoint asiento_suelto;

-- ROTO: un cobro que dice haber cancelado una cifra y su asiento acreditó otra.
savepoint cobro_que_miente;
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id, settled_transaction_amount,
   cancelled_functional_amount)
values ('aaaa0125-0000-4000-8000-00000000e004', 'aaaa0125-0000-4000-8000-00000000000a',
        'aaaa0125-0000-4000-8000-0000000000a2', 'aaaa0125-0000-4000-8000-00000000f001',
        now(), 'VES', 100, 1, 'identidad', now(), 100, 'efectivo_bs',
        'aaaa0125-0000-4000-8000-00000000ca01', 100, 100);
select pg_temp.asiento_125('aaaa0125-0000-4000-8000-0000000e0e04', 'payment_received',
  'aaaa0125-0000-4000-8000-00000000e004', 'ar.payment_applied',
  '[["1", 100, 0], ["2", 0, 80], ["3", 0, 20]]');
select is(pg_temp.brecha_125(), '960.00|980.00|-20.00|200.00',
  'f. ROTO: un cobro que guarda 100 de cancelado con un asiento que acreditó 80 da fila por los 20');
rollback to savepoint cobro_que_miente;

-- ROTO: una factura que deja de contar (anulada por debajo del caso de uso) con su cargo vivo en
-- el mayor. Es lo que deja la «variante rota» de e2e-corregir-venta en la base local.
savepoint anulada_por_debajo;
alter table public.documents disable trigger user;
update public.documents set status = 'annulled', annulled_at = now(), annul_reason = 'variante rota'
 where id = 'aaaa0125-0000-4000-8000-00000000f003';
alter table public.documents enable trigger user;
select is(pg_temp.brecha_125(), '760.00|1060.00|-300.00|200.00',
  'f. ROTO: una factura anulada sin revertir su asiento da fila por su total');
rollback to savepoint anulada_por_debajo;

select is(pg_temp.brecha_125(), 'cero',
  'f. deshechas las tres variantes, vuelve a cero: cada fila la produjo SU rotura');

-- ── g. Un cobro deja UN saldo a favor ────────────────────────────────────────
select throws_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency)
  values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
          'aaaa0125-0000-4000-8000-00000000c00a', 'aaaa0125-0000-4000-8000-00000000f002',
          'aaaa0125-0000-4000-8000-00000000e002', 100, 'VES')
$$, '23505', null, 'g. un segundo sobrante del MISMO cobro muere en el único parcial: 23505');
select lives_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency)
  values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
          'aaaa0125-0000-4000-8000-00000000c00a', 'aaaa0125-0000-4000-8000-00000000f001',
          'aaaa0125-0000-4000-8000-00000000e001', 10, 'VES')
$$, 'g. y el sobrante de OTRO cobro entra: el único es por cobro, no por cliente ni por documento');
savepoint sin_unico_del_sobrante;
drop index public.customer_credits_source_payment_key;
select lives_ok($$
  insert into public.customer_credits
    (tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount, currency)
  values ('aaaa0125-0000-4000-8000-00000000000a', 'aaaa0125-0000-4000-8000-0000000000a2',
          'aaaa0125-0000-4000-8000-00000000c00a', 'aaaa0125-0000-4000-8000-00000000f002',
          'aaaa0125-0000-4000-8000-00000000e002', 100, 'VES')
$$, 'g. ROTO: sin el único, el segundo sobrante del mismo cobro entra — el 23505 lo medía el índice');
rollback to savepoint sin_unico_del_sobrante;
-- La última aserción va FUERA del savepoint: pgTAP guarda su cuenta en una tabla, y un rollback
-- final la devolvería a la anterior («planned 31 but ran 30», con todo en ok).
select is(
  (select count(*)::int from public.customer_credits
    where source_payment_id = 'aaaa0125-0000-4000-8000-00000000e002'),
  1, 'g. el cobro con sobrante sigue con UN saldo a favor, repuesto el único: el dato, no solo la excepción');

select * from finish();
rollback;
