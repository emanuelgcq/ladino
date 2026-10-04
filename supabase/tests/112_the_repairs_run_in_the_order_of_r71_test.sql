-- =============================================================================
-- pgTAP 112 · LAS REPARACIONES POSTERIORES AL PULL, EN EL ORDEN DE R-71 (ADR-0075 §7 · ADR-0070 ·
-- migración 20261003190300)
--
-- Una empresa con saldos HEREDADOS con fracción de céntimo y dos cajas en divisa que todavía
-- apuntan a la cuenta de su familia. Desde la 20261003190000 la base rechaza al postear una línea
-- con más de dos decimales (LAD71), así que el orden importa:
--   · la reparación de ADR-0070 ANTES del céntimo no muere en LAD71 con el mensaje del asiento
--     manual: se niega con palabras (LAD82) y dice qué correr antes, sin dejar nada a medias;
--   · en el orden de R-71 — céntimo → subcuentas (ADR-0070) → divisa del mayor (ADR-0075 §6) —
--     las tres postean, el reparto entre cajas en divisa sale al céntimo y la última se lleva el
--     resto, y los invariantes quedan en cero.
-- =============================================================================
begin;
select plan(13);

insert into auth.users (id) values ('aaaa0110-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0110-0000-4000-8000-0000000000e1', true);
select set_config('ladino.rules_version', 'pgtap-112', true);
insert into public.tenants (id, name) values ('aaaa0110-0000-4000-8000-00000000000a', 'Tenant 110');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0110-0000-4000-8000-0000000000a1', 'aaaa0110-0000-4000-8000-00000000000a',
        'J-110-A', 'Heredada 110', 'VES');

insert into public.accounts (id, tenant_id, company_id, code, name, parent_id, kind, nature)
select v.id::uuid, 'aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1',
       v.code, v.name, v.parent::uuid, v.kind, v.nature
  from (values
    ('aaaa0110-0000-4000-8000-000000001001', '1', 'Activo', null, 'activo', 'deudora'),
    ('aaaa0110-0000-4000-8000-000000001011', '1.1', 'Activo circulante',
     'aaaa0110-0000-4000-8000-000000001001', 'activo', 'deudora'),
    ('aaaa0110-0000-4000-8000-000000001101', '1.1.01', 'Caja y bancos en bolívares',
     'aaaa0110-0000-4000-8000-000000001011', 'activo', 'deudora'),
    ('aaaa0110-0000-4000-8000-000000001102', '1.1.02', 'Caja y bancos en divisas',
     'aaaa0110-0000-4000-8000-000000001011', 'activo', 'deudora'),
    ('aaaa0110-0000-4000-8000-000000001003', '3', 'Patrimonio', null, 'patrimonio', 'acreedora'),
    ('aaaa0110-0000-4000-8000-000000001031', '3.1', 'Capital',
     'aaaa0110-0000-4000-8000-000000001003', 'patrimonio', 'acreedora'),
    ('aaaa0110-0000-4000-8000-000000001005', '5', 'Gastos', null, 'gasto', 'deudora'),
    ('aaaa0110-0000-4000-8000-000000001051', '5.1', 'Diferencias por redondeo',
     'aaaa0110-0000-4000-8000-000000001005', 'gasto', 'deudora')
  ) as v(id, code, name, parent, kind, nature)
 order by length(v.code);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id, effective_from)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1', 'cash_bs',
        'aaaa0110-0000-4000-8000-000000001101', '-infinity'),
       ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1', 'cash_usd',
        'aaaa0110-0000-4000-8000-000000001102', '-infinity'),
       ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1',
        'rounding_difference', 'aaaa0110-0000-4000-8000-000000001051', '-infinity');

create function pg_temp.postear(p_entry uuid) returns void language sql as $$
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = '00000000-0000-0000-0000-000000000000',
         entry_number = platform.claim_entry_number(company_id, extract(year from posting_date)::int)
   where id = p_entry;
$$;

-- LA HISTORIA HEREDADA: 1 000,00456 Bs en 1.1.02 contra capital, a 8 decimales. Hoy no entraría
-- (LAD71): se postea con el guarda apagado dentro del test.
insert into public.journal_entries (id, tenant_id, company_id, period_id, posting_date, source_kind,
                                    description, rules_version)
values ('aaaa0110-0000-4000-8000-0000000e0001', 'aaaa0110-0000-4000-8000-00000000000a',
        'aaaa0110-0000-4000-8000-0000000000a1',
        platform.period_for_date('aaaa0110-0000-4000-8000-0000000000a1',
                                 (now() at time zone 'America/Caracas')::date),
        (now() at time zone 'America/Caracas')::date, 'manual', 'Historia heredada 110', 'test');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, functional_debit, functional_credit)
values ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1',
        'aaaa0110-0000-4000-8000-0000000e0001', 1, 'aaaa0110-0000-4000-8000-000000001102',
        1000.00456, 0, 1000.00456, 'VES', 1, 1000.00456, 'VES', 1000.00456, 0),
       ('aaaa0110-0000-4000-8000-00000000000a', 'aaaa0110-0000-4000-8000-0000000000a1',
        'aaaa0110-0000-4000-8000-0000000e0001', 2, 'aaaa0110-0000-4000-8000-000000001031',
        0, 1000.00456, 1000.00456, 'VES', 1, 1000.00456, 'VES', 0, 1000.00456);
set constraints all immediate;
alter table public.journal_entries disable trigger journal_entries_02_balanced;
select pg_temp.postear('aaaa0110-0000-4000-8000-0000000e0001');
alter table public.journal_entries enable trigger journal_entries_02_balanced;

-- Dos cajas en USD, con 30 y 7: nacen DESPUÉS de la historia, apuntando a la familia.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0110-0000-4000-8000-0000000000c1', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a1', 'Zelle', 'USD', 'wallet'),
  ('aaaa0110-0000-4000-8000-0000000000c2', 'aaaa0110-0000-4000-8000-00000000000a',
   'aaaa0110-0000-4000-8000-0000000000a1', 'Caja USD', 'USD', 'cash');
select platform.bump_account_balance('aaaa0110-0000-4000-8000-0000000000c1', 30);
select platform.bump_account_balance('aaaa0110-0000-4000-8000-0000000000c2', 7);

-- ── 1. El orden EQUIVOCADO: subcuentas antes del céntimo ────────────────────
select throws_ok(
  $$ select platform.treasury_subaccounts_repair_prepare('aaaa0110-0000-4000-8000-0000000000a1') $$,
  'LAD82', null,
  'ADR-0070 antes del céntimo NO muere en LAD71: se niega con LAD82');
select throws_like(
  $$ select platform.treasury_subaccounts_repair_prepare('aaaa0110-0000-4000-8000-0000000000a1') $$,
  '%Corre ANTES la regularización del céntimo (scripts/reparar/adr-0075-centimo.mjs)%',
  'y el mensaje dice qué correr antes');
select is(
  (select count(*)::int from public.accounts
    where company_id = 'aaaa0110-0000-4000-8000-0000000000a1' and code like '1.1.02.%'),
  0, 'sin dejar nada a medias: ninguna subcuenta creada');

-- ── 2. El orden de R-71. Primero, el céntimo ────────────────────────────────
create temp table _cent as
  select platform.cent_regularization_prepare('aaaa0110-0000-4000-8000-0000000000a1') as r;
select lives_ok($$ select pg_temp.postear(((select r from _cent) ->> 'entry_id')::uuid) $$,
  '1 · la regularización del céntimo postea');
select platform.cent_regularization_finish((select r from _cent));
select is(
  (select balance from platform.recompute_ledger('aaaa0110-0000-4000-8000-0000000000a1',
                                                 'aaaa0110-0000-4000-8000-000000001102')),
  1000.00::numeric, '1.1.02 queda al céntimo: 1 000,00');

-- ── 3. Después, las subcuentas de tesorería (ADR-0070) ──────────────────────
create temp table _sub as
  select platform.treasury_subaccounts_repair_prepare('aaaa0110-0000-4000-8000-0000000000a1') as r;
select lives_ok($$ select pg_temp.postear(((select r from _sub) ->> 'entry_id')::uuid) $$,
  '2 · la reclasificación de ADR-0070 postea: ninguna línea con más de dos decimales');
select lives_ok(
  $$ select platform.treasury_subaccounts_repair_finish((select r from _sub), 'pgtap-112') $$,
  'y cierra: la cuenta de familia queda en cero');
select is(
  (select array_agg((x ->> 'reclassified_functional')::numeric order by x ->> 'account_name' desc)
     from _sub, jsonb_array_elements(r -> 'accounts') x),
  array[810.81, 189.19]::numeric[],
  'el reparto entre las cajas en divisa va AL CÉNTIMO: 1 000 × 30/37 = 810,81 (a 8 decimales era 810,81081081) y la última se lleva el resto, 189,19');
select is(
  (select count(*)::int from public.journal_lines jl, _sub
    where jl.entry_id = (r ->> 'entry_id')::uuid
      and (jl.functional_debit <> round(jl.functional_debit, 2)
           or jl.functional_credit <> round(jl.functional_credit, 2))),
  0, 'ninguna línea del asiento de reclasificación trae fracción de céntimo');

-- ── 4. Y la divisa del mayor (ADR-0075 §6) ──────────────────────────────────
create temp table _div as
  select platform.treasury_currency_regularization_prepare('aaaa0110-0000-4000-8000-0000000000a1') as r;
select lives_ok(
  $$ select pg_temp.postear(e.id)
       from public.journal_entries e
      where e.company_id = 'aaaa0110-0000-4000-8000-0000000000a1' and e.status = 'draft' $$,
  '3 · lo que prepare la divisa del mayor también postea sin LAD71');

-- ── 5. Los invariantes, en cero ─────────────────────────────────────────────
select is((select count(*)::int from platform.cent_gaps('aaaa0110-0000-4000-8000-0000000000a1')),
  0, 'cent_gaps = 0 después de las tres');
select is(
  (select count(*)::int from platform.treasury_ledger_gaps('aaaa0110-0000-4000-8000-0000000000a1')),
  0, 'treasury_ledger_gaps = 0');
select is(
  (select count(*)::int from platform.treasury_currency_gaps('aaaa0110-0000-4000-8000-0000000000a1')),
  0, 'treasury_currency_gaps = 0');

select * from finish();
rollback;
