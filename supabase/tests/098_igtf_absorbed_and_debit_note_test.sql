-- =============================================================================
-- Ladino — pgTAP 98 · EL IGTF ABSORBIDO Y LA ND POR IGTF (migración 20261002100000; F-05, E-03)
--
-- Lo absorbido no suma a la caja (trigger, redistribución y recómputo: las tres caras de
-- treasury_ledger_gaps); lo absorbido no se documenta con ND; la ND por IGTF la paga su
-- percepción (platform.document_balance) y documenta una sola; la plantilla del gasto existe.
-- Con su variante rota.
-- =============================================================================

begin;
select plan(17);

insert into public.tenants (id, name) values ('aaaa0098-0000-4000-8000-00000000000a', 'Tenant 98');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0098-0000-4000-8000-0000000000a2', 'aaaa0098-0000-4000-8000-00000000000a',
   'J-98-A', 'Empresa 98', 'especial');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0098-0000-4000-8000-00000000c001', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'J-CLI-98', 'Cliente 98', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0098-0000-4000-8000-00000000e101', 'aaaa0098-0000-4000-8000-00000000000a',
        'aaaa0098-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
-- ADR-0072 §1 (migración 20260928190100): el montaje declara el tipo de contribuyente de sus
-- empresas con RIF; sin tipo vigente la base no deja emitir factura, NC ni ND (LAD98).
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
select c.tenant_id, c.id,
       case when c.taxpayer_type_code in ('ordinario', 'especial', 'formal')
            then c.taxpayer_type_code else 'ordinario' end,
       '2000-01-01', case when c.taxpayer_type_code = 'especial' then '2000-01-01'::date end,
       'Montaje pgTAP: el tipo que declara la empresa de prueba', 'pgtap'
  from public.companies c
 where c.created_at = now() and upper(btrim(c.tax_id)) not like 'PEND-%'
   and not exists (select 1 from public.company_taxpayer_types h where h.company_id = c.id);

insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0098-0000-4000-8000-00000000f001', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0098-0000-4000-8000-00000000c001', 1, 9801, 'issued', now(),
   'aaaa0098-0000-4000-8000-00000000e101', 'test-098', 'VES', 'VES', 1, 'identidad',
   18884.80, 18884.80, 16280, 2604.80, 18884.80);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0098-0000-4000-8000-00000000ca01', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'Caja USD 98', 'USD', 'cash'),
  ('aaaa0098-0000-4000-8000-00000000ca02', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'Caja USD 2', 'USD', 'cash'),
  ('aaaa0098-0000-4000-8000-00000000ca03', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'Caja Bs 98', 'VES', 'cash');


-- ── El ajuste nace apagado ──────────────────────────────────────────────────
insert into public.company_settings (company_id, tenant_id)
values ('aaaa0098-0000-4000-8000-0000000000a2', 'aaaa0098-0000-4000-8000-00000000000a');
select is((select absorb_igtf from public.company_settings
            where company_id = 'aaaa0098-0000-4000-8000-0000000000a2'),
  false, 'absorb_igtf nace en NO: por omisión el cliente paga el IGTF (F-05)');

-- ── Lo absorbido no suma a la caja ──────────────────────────────────────────
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0098-0000-4000-8000-00000000e001', 'aaaa0098-0000-4000-8000-00000000000a',
        'aaaa0098-0000-4000-8000-0000000000a2', 'aaaa0098-0000-4000-8000-00000000f001',
        now(), 'USD', 29, 40, 'BCV test', now(), 1160, 'zelle',
        'aaaa0098-0000-4000-8000-00000000ca01');
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at, absorbed)
values ('aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000a2',
        'aaaa0098-0000-4000-8000-00000000e001', 'aaaa0098-0000-4000-8000-00000000f001',
        29, 'USD', 0.03, 0.87, 34.80, 40, 'BCV test', now(), true);
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0098-0000-4000-8000-00000000ca01'),
  29::numeric, 'la percepción ABSORBIDA no suma a la caja: el cliente entregó 29, no 29,87');
select is(platform.recompute_account_balance('aaaa0098-0000-4000-8000-00000000ca01'),
  29::numeric, 'y el recómputo desde los hechos tampoco la cuenta');
update public.payments set account_id = 'aaaa0098-0000-4000-8000-00000000ca02'
 where id = 'aaaa0098-0000-4000-8000-00000000e001';
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0098-0000-4000-8000-00000000ca02'),
  29::numeric, 'redistribuir el pago muda 29: lo absorbido no estaba en la caja');
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0098-0000-4000-8000-00000000ca01'),
  0::numeric, 'y la caja de origen queda en cero, no en −0,87');

-- ── La ND por IGTF ──────────────────────────────────────────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id, notes, rate_basis,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0098-0000-4000-8000-00000000f002', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000a2', 'debit_note', 'A',
   'aaaa0098-0000-4000-8000-00000000c001', 1, 9802, 'issued', now(),
   'aaaa0098-0000-4000-8000-00000000e101', 'test-098', 'aaaa0098-0000-4000-8000-00000000f001',
   'IGTF 3 % percibido sobre el pago en divisas', 'own_day', 'VES', 'VES', 1, 'identidad',
   12, 12, 12, 0, 12);
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0098-0000-4000-8000-00000000e002', 'aaaa0098-0000-4000-8000-00000000000a',
        'aaaa0098-0000-4000-8000-0000000000a2', 'aaaa0098-0000-4000-8000-00000000f001',
        now(), 'USD', 10, 40, 'BCV test', now(), 400, 'zelle',
        'aaaa0098-0000-4000-8000-00000000ca01'),
       ('aaaa0098-0000-4000-8000-00000000e003', 'aaaa0098-0000-4000-8000-00000000000a',
        'aaaa0098-0000-4000-8000-0000000000a2', 'aaaa0098-0000-4000-8000-00000000f001',
        now(), 'USD', 1, 40, 'BCV test', now(), 40, 'zelle',
        'aaaa0098-0000-4000-8000-00000000ca01');

-- Lo absorbido no se le cobró al cliente: no se documenta con ND.
select throws_ok($$
  insert into public.igtf_perceptions
    (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
     functional_amount, fx_rate, rate_source, occurred_at, absorbed, debit_note_id)
  values ('aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000a2',
          'aaaa0098-0000-4000-8000-00000000e003', 'aaaa0098-0000-4000-8000-00000000f001',
          1, 'USD', 0.03, 0.03, 1.20, 40, 'BCV test', now(), true,
          'aaaa0098-0000-4000-8000-00000000f002')
$$, '23514', null, 'una percepción absorbida no lleva ND (ip_absorbed_no_note_chk)');

select is(platform.document_balance('aaaa0098-0000-4000-8000-0000000000a2',
                                    'aaaa0098-0000-4000-8000-00000000f002'),
  12::numeric, 'sin percepción, la ND debe sus 12 Bs');
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at, debit_note_id)
values ('aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000a2',
        'aaaa0098-0000-4000-8000-00000000e002', 'aaaa0098-0000-4000-8000-00000000f001',
        10, 'USD', 0.03, 0.30, 12, 40, 'BCV test', now(),
        'aaaa0098-0000-4000-8000-00000000f002');
select is(platform.document_balance('aaaa0098-0000-4000-8000-0000000000a2',
                                    'aaaa0098-0000-4000-8000-00000000f002'),
  0::numeric, 'con su percepción, la ND por IGTF queda en cero: el dinero entró en el mismo acto');
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0098-0000-4000-8000-00000000ca01'),
  11.30::numeric, 'la percepción documentada con ND SÍ entró: la caja tiene 10 + 1 + 0,30');
select is(platform.recompute_account_balance('aaaa0098-0000-4000-8000-00000000ca01'),
  11.30::numeric, 'y el recómputo coincide');
select throws_ok($$
  insert into public.igtf_perceptions
    (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
     functional_amount, fx_rate, rate_source, occurred_at, debit_note_id)
  values ('aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000a2',
          'aaaa0098-0000-4000-8000-00000000e003', 'aaaa0098-0000-4000-8000-00000000f001',
          1, 'USD', 0.03, 0.03, 1.20, 40, 'BCV test', now(),
          'aaaa0098-0000-4000-8000-00000000f002')
$$, '23505', null, 'una ND documenta UNA percepción (ip_debit_note_key)');

-- ── La plantilla del IGTF asumido, en el preset ─────────────────────────────
select is((select l.account_purpose
             from public.journal_template_preset_entries e
             join public.journal_template_preset_lines l on l.entry_id = e.id
            where e.preset_code = 've_basico' and e.source_kind = 'igtf_perception'
              and e.source_event = 'igtf.perception_absorbed' and l.side = 'debit'),
  'operating_expense', 'el IGTF asumido debita gastos operativos (VALIDAR-CONTABLE)');

-- ── Revisión 5: la lectura de authenticated (ip_select) aísla por empresa ───
-- El usuario de A lee lo de A y nada de B; `document_balance` funciona con su JWT.
insert into auth.users (id) values ('aaaa0098-0000-4000-8000-0000000000e1');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0098-0000-4000-8000-0000000000b1', 'aaaa0098-0000-4000-8000-00000000000a',
   'aaaa0098-0000-4000-8000-0000000000e1');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000b1', r.id, null
  from public.roles r where r.key = 'owner' and r.tenant_id is null;

insert into public.tenants (id, name) values ('aaaa0098-0000-4000-8000-00000000000b', 'Tenant 98 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0098-0000-4000-8000-0000000000b2', 'aaaa0098-0000-4000-8000-00000000000b',
   'J-98-B', 'Empresa 98 B', 'especial');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values ('aaaa0098-0000-4000-8000-00000000000b', 'aaaa0098-0000-4000-8000-0000000000b2',
        'especial', '2000-01-01', '2000-01-01', 'Montaje pgTAP 98 B', 'pgtap');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0098-0000-4000-8000-00000000c0b1', 'aaaa0098-0000-4000-8000-00000000000b',
   'aaaa0098-0000-4000-8000-0000000000b2', 'J-CLI-98B', 'Cliente 98 B', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0098-0000-4000-8000-00000000e1b1', 'aaaa0098-0000-4000-8000-00000000000b',
        'aaaa0098-0000-4000-8000-0000000000b2', 'formatos_libres', '2026-01-01');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0098-0000-4000-8000-00000000fb01', 'aaaa0098-0000-4000-8000-00000000000b',
   'aaaa0098-0000-4000-8000-0000000000b2', 'invoice', 'A',
   'aaaa0098-0000-4000-8000-00000000c0b1', 1, 9811, 'issued', now(),
   'aaaa0098-0000-4000-8000-00000000e1b1', 'test-098', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0098-0000-4000-8000-00000000cab1', 'aaaa0098-0000-4000-8000-00000000000b',
   'aaaa0098-0000-4000-8000-0000000000b2', 'Caja USD 98 B', 'USD', 'cash');
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0098-0000-4000-8000-00000000eb01', 'aaaa0098-0000-4000-8000-00000000000b',
        'aaaa0098-0000-4000-8000-0000000000b2', 'aaaa0098-0000-4000-8000-00000000fb01',
        now(), 'USD', 10, 40, 'BCV test', now(), 400, 'zelle',
        'aaaa0098-0000-4000-8000-00000000cab1');
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at)
values ('aaaa0098-0000-4000-8000-00000000000b', 'aaaa0098-0000-4000-8000-0000000000b2',
        'aaaa0098-0000-4000-8000-00000000eb01', 'aaaa0098-0000-4000-8000-00000000fb01',
        10, 'USD', 0.03, 0.30, 12, 40, 'BCV test', now());

select set_config('request.jwt.claims',
  '{"sub":"aaaa0098-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from public.igtf_perceptions
            where company_id = 'aaaa0098-0000-4000-8000-0000000000b2'),
  0, 'el JWT de A no lee ninguna percepción de B (ip_select)');
select ok((select count(*) from public.igtf_perceptions
            where company_id = 'aaaa0098-0000-4000-8000-0000000000a2') > 0,
  'y sí lee las de A: la lectura permitida funciona, no solo la negada');
select is(platform.document_balance('aaaa0098-0000-4000-8000-0000000000a2',
                                    'aaaa0098-0000-4000-8000-00000000f002'),
  0::numeric, 'document_balance funciona como authenticated (antes: 42501 sobre igtf_perceptions)');
reset role;

-- Variante rota: con la policy sin la condición de empresa, A lee B. Si esto NO pasara, el 0 de
-- arriba lo estaría dando otra capa y no ip_select.
drop policy ip_select on public.igtf_perceptions;
create policy ip_select on public.igtf_perceptions for select to authenticated using (true);
set local role authenticated;
select ok((select count(*) from public.igtf_perceptions
            where company_id = 'aaaa0098-0000-4000-8000-0000000000b2') > 0,
  'variante rota: sin la condición de empresa, A lee B — el 0 de arriba mide ip_select');
reset role;

-- ── Variante rota: sin el CHECK, la absorbida con ND entra ──────────────────
-- Si esto NO dejara pasar la fila, el primer throws_ok estaría cazando otra cosa (el índice
-- único, por ejemplo), y no el CHECK que dice probar.
alter table public.igtf_perceptions drop constraint ip_absorbed_no_note_chk;
drop index public.ip_debit_note_key;
select lives_ok($$
  insert into public.igtf_perceptions
    (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
     functional_amount, fx_rate, rate_source, occurred_at, absorbed, debit_note_id)
  values ('aaaa0098-0000-4000-8000-00000000000a', 'aaaa0098-0000-4000-8000-0000000000a2',
          'aaaa0098-0000-4000-8000-00000000e003', 'aaaa0098-0000-4000-8000-00000000f001',
          1, 'USD', 0.03, 0.03, 1.20, 40, 'BCV test', now(), true,
          'aaaa0098-0000-4000-8000-00000000f002')
$$, 'variante rota: sin el CHECK ni el único, la absorbida con ND entra — los dos throws_ok miden esas defensas');

select * from finish();
rollback;
