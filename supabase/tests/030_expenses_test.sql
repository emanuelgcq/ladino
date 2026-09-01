-- =============================================================================
-- Ladino — pgTAP 30 · GASTOS (migración 30) — RIGOR MÁXIMO
--
-- Un gasto toca dos verdades a la vez: el saldo de una cuenta y la cobertura
-- contable. Esto prueba:
--
--   1. el gasto SALE de su cuenta y la moneda es la de la cuenta (LAD67);
--   2. es append-only con la única corrección del backlink al asiento (LAD06);
--   3. la conciliación de tesorería sigue cuadrando con la fuente nueva — el
--      trigger y el recómputo aprendieron JUNTOS, no uno solo;
--   4. gasto ⇒ asiento o cola, dentro de accounting_coverage_gaps: la familia
--      creció, el enunciado es el mismo, la respuesta útil sigue siendo cero;
--   5. el vocabulario nuevo existe en sus tres casas y el preset trae el mapeo.
-- =============================================================================

begin;
select plan(14);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0030-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0030-0000-4000-8000-00000000000a', 'Tenant 30');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0030-0000-4000-8000-0000000000a2', 'aaaa0030-0000-4000-8000-00000000000a',
   'J-30-A', 'Empresa 30', 'ordinario');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0030-0000-4000-8000-0000000000e1', 'aaaa0030-0000-4000-8000-00000000000a',
   'aaaa0030-0000-4000-8000-0000000000a2', 'Caja Bs', 'VES', 'cash');
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0030-0000-4000-8000-00000000b001', 'aaaa0030-0000-4000-8000-00000000000a',
   'aaaa0030-0000-4000-8000-0000000000a2', 2026, 8);

-- ── 1. Estructura: RLS forzada, sin escritura de navegador ──────────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'expenses'
      and c.relrowsecurity and c.relforcerowsecurity),
  1::bigint, 'expenses con RLS habilitada Y forzada');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'expenses'
      and grantee in ('anon', 'authenticated', 'service_role', 'ladino_worker')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0::bigint, 'y solo la API escribe gastos: un navegador no registra plata que salió');

-- ── 2. El gasto sale de su cuenta ───────────────────────────────────────────
insert into public.expenses
  (id, tenant_id, company_id, category, description, paid_at, account_id,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency) values
  ('aaaa0030-0000-4000-8000-00000000f301', 'aaaa0030-0000-4000-8000-00000000000a',
   'aaaa0030-0000-4000-8000-0000000000a2', 'Alquiler', 'Alquiler del local, agosto',
   '2026-08-05T10:00:00Z', 'aaaa0030-0000-4000-8000-0000000000e1',
   100, 'VES', 1, 100, 'VES');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0030-0000-4000-8000-0000000000e1'),
  -100::numeric, 'el gasto de 100 deja la cuenta en −100: salió de donde se dijo que salió');
select throws_ok($$
  insert into public.expenses
    (tenant_id, company_id, category, paid_at, account_id,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency)
  values ('aaaa0030-0000-4000-8000-00000000000a', 'aaaa0030-0000-4000-8000-0000000000a2',
          'Flete', '2026-08-05T11:00:00Z', 'aaaa0030-0000-4000-8000-0000000000e1',
          10, 'USD', 40, 400, 'VES')
$$, 'LAD67', null, 'un gasto en USD no sale de una cuenta VES: la moneda es la de la cuenta');

-- ── 3. Append-only con backlink corregible ──────────────────────────────────
select throws_ok($$
  update public.expenses set category = 'Luz'
   where id = 'aaaa0030-0000-4000-8000-00000000f301'
$$, 'LAD06', null, 'un gasto registrado no se edita: se corrige con contra-asiento del contador');
select throws_ok($$
  delete from public.expenses where id = 'aaaa0030-0000-4000-8000-00000000f301'
$$, 'LAD06', null, 'y no se borra');

-- El backlink SÍ: es el mismo patrón que documents.journal_entry_id. Y el
-- asiento se crea con source_kind = expense, que prueba el CHECK extendido.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description) values
  ('aaaa0030-0000-4000-8000-00000000b101', 'aaaa0030-0000-4000-8000-00000000000a',
   'aaaa0030-0000-4000-8000-0000000000a2', 'aaaa0030-0000-4000-8000-00000000b001',
   '2026-08-05', 'expense', 'aaaa0030-0000-4000-8000-00000000f301',
   'treasury.expense.registered', 'Alquiler de agosto');
select lives_ok($$
  update public.expenses set journal_entry_id = 'aaaa0030-0000-4000-8000-00000000b101'
   where id = 'aaaa0030-0000-4000-8000-00000000f301'
$$, 'el backlink al asiento es LO ÚNICO corregible: la cola de ADR-0042 lo rellena al procesar');

-- ── 4. La conciliación de tesorería aprendió la fuente nueva ────────────────
select is(
  (select count(*) from platform.treasury_reconciliation('aaaa0030-0000-4000-8000-0000000000a2')
    where not ok),
  0::bigint,
  'materializado == recomputado CON el gasto dentro: trigger y recómputo aprendieron juntos');

-- ── 5. Gasto ⇒ asiento o cola (la familia del invariante creció) ────────────
insert into public.expenses
  (id, tenant_id, company_id, category, paid_at, account_id,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency) values
  ('aaaa0030-0000-4000-8000-00000000f302', 'aaaa0030-0000-4000-8000-00000000000a',
   'aaaa0030-0000-4000-8000-0000000000a2', 'Luz', '2026-08-06T10:00:00Z',
   'aaaa0030-0000-4000-8000-0000000000e1', 50, 'VES', 1, 50, 'VES');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0030-0000-4000-8000-0000000000a2')
    where source_kind = 'expense' and problem = 'missing'),
  1::bigint,
  'un gasto sin asiento NI cola es un hueco que el invariante acusa: no hay gasto contablemente invisible');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0030-0000-4000-8000-00000000000a', 'aaaa0030-0000-4000-8000-0000000000a2',
   'expense', 'aaaa0030-0000-4000-8000-00000000f302', 'treasury.expense.registered',
   '{"functional_amount": "50"}', 'sin cuenta con papel operating_expense');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0030-0000-4000-8000-0000000000a2')),
  0::bigint, 'encolado, el hueco se cierra: la cola es cobertura legítima, no un limbo');
select lives_ok($$
  update public.expenses set journal_entry_id = 'aaaa0030-0000-4000-8000-00000000b101'
   where id = 'aaaa0030-0000-4000-8000-00000000f302'
$$, 'se le pone también el asiento…');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0030-0000-4000-8000-0000000000a2')
    where source_kind = 'expense' and problem = 'duplicated'),
  1::bigint,
  '…y tener asiento Y cola pendiente a la vez también es defecto: duplicated, no éxito doble');

-- ── 6. El vocabulario nuevo, en sus tres casas y en el preset ───────────────
select is(
  (select count(*) from public.chart_template_accounts
    where template_code = 've_basico' and code in ('5.1.05', '5.1.06')),
  2::bigint, 've_basico trae Gastos operativos y Faltantes y sobrantes de caja');
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'expense'),
  2::bigint, 'el preset mapea el gasto en dos patas: gasto contra caja, en moneda funcional');

select * from finish();
rollback;
