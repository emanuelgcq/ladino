-- =============================================================================
-- Ladino — pgTAP 76 · CADA CUENTA DE TESORERÍA TIENE SU SUBCUENTA (ADR-0070, J-01)
--
--   1. un asiento posteado con DOS líneas sobre la MISMA cuenta actualiza `ledger_balances` sin
--      error, y `recompute_ledger` coincide (el 500 de J-01 era esto);
--   2. en una empresa con historia en la cuenta de familia y sin reparar, una caja nueva se sigue
--      mapeando a la familia (crear una hija rompería las cajas viejas con LAD62), y el
--      invariante lo dice: `compartida`;
--   3. la reparación (prepare → posteo → finish, como la hace el dominio) crea una subcuenta por
--      caja, hija de la familia y con su nombre; reclasifica el saldo que la tesorería les
--      atribuye; la familia queda agrupadora y en CERO; lo que ninguna caja explica va a
--      «Por conciliar»; el invariante da cero; deja acta con autor system y versión de reglas;
--   4. la reparación es idempotente;
--   5. una caja nueva en la empresa reparada, y en una empresa nueva, nace con su subcuenta;
--   6. el invariante DETECTA: un asiento que mueve la subcuenta sin hecho de tesorería da
--      `saldo_distinto`;
--   7. VARIANTE ROTA: con el `apply_ledger_balance` de antes (upsert por línea), el asiento del
--      punto 1 muere con 21000 — el test 1 mide el `group by`, no otra cosa.
-- =============================================================================

begin;
select plan(32);

-- ── Escenario: una empresa con su plan mínimo ───────────────────────────────
insert into public.tenants (id, name) values ('aaaa0076-0000-4000-8000-00000000000a', 'Tenant 76');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0076-0000-4000-8000-0000000000a1', 'aaaa0076-0000-4000-8000-00000000000a',
        'J-76-A', 'Subcuentas 76', 'VES'),
       ('aaaa0076-0000-4000-8000-0000000000a2', 'aaaa0076-0000-4000-8000-00000000000a',
        'J-76-B', 'Nueva 76', 'VES');
-- Las de los casos de reparación: divisa real (3), período cerrado (4), cola pendiente (5),
-- plantilla que nombra la familia (6) y `finish` con el asiento en borrador (7).
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
select ('aaaa0076-0000-4000-8000-0000000000a' || n)::uuid, 'aaaa0076-0000-4000-8000-00000000000a',
       'J-76-' || n, 'Reparación 76-' || n, 'VES'
  from generate_series(3, 7) as n;

insert into public.accounts (id, tenant_id, company_id, code, name, parent_id, kind, nature)
select v.id::uuid, 'aaaa0076-0000-4000-8000-00000000000a', c.company::uuid, v.code, v.name,
       v.parent::uuid,
       v.kind, v.nature
  from (select 'aaaa0076-0000-4000-8000-0000000000a' || n, n::text
          from generate_series(1, 7) as n) as c(company, suf)
  cross join lateral (values
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '001', '1', 'Activo', null, 'activo', 'deudora'),
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '011', '1.1', 'Activo circulante',
     'aaaa0076-0000-4000-8000-00000000' || c.suf || '001', 'activo', 'deudora'),
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '101', '1.1.01', 'Caja y bancos en bolívares',
     'aaaa0076-0000-4000-8000-00000000' || c.suf || '011', 'activo', 'deudora'),
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '102', '1.1.02', 'Caja y bancos en divisas',
     'aaaa0076-0000-4000-8000-00000000' || c.suf || '011', 'activo', 'deudora'),
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '003', '3', 'Patrimonio', null,
     'patrimonio', 'acreedora'),
    ('aaaa0076-0000-4000-8000-00000000' || c.suf || '031', '3.1', 'Capital',
     'aaaa0076-0000-4000-8000-00000000' || c.suf || '003', 'patrimonio', 'acreedora')
  ) as v(id, code, name, parent, kind, nature)
 order by c.suf, length(v.code);

insert into public.company_account_settings (tenant_id, company_id, purpose, account_id, effective_from)
select 'aaaa0076-0000-4000-8000-00000000000a', c.company::uuid, p.purpose,
       ('aaaa0076-0000-4000-8000-00000000' || c.suf || p.suf)::uuid, '-infinity'
  from (select 'aaaa0076-0000-4000-8000-0000000000a' || n, n::text
          from generate_series(1, 7) as n) as c(company, suf)
  cross join (values ('cash_bs', '101'), ('cash_usd', '102')) as p(purpose, suf);

-- Postear como lo hace el dominio: número y estado.
create temporary table _postear (entry uuid);
create function pg_temp.postear(p_entry uuid) returns void language sql as $$
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = '00000000-0000-0000-0000-000000000000',
         entry_number = platform.claim_entry_number(company_id, extract(year from posting_date)::int)
   where id = p_entry;
$$;
-- Un asiento manual en borrador con N líneas (cuenta, debe, haber).
create function pg_temp.borrador(p_company uuid, p_lineas jsonb) returns uuid language plpgsql as $$
declare v_e uuid; v_l jsonb; v_n int := 0;
begin
  insert into public.journal_entries (tenant_id, company_id, period_id, posting_date, source_kind,
                                      description, rules_version)
  values ('aaaa0076-0000-4000-8000-00000000000a', p_company,
          platform.period_for_date(p_company, (now() at time zone 'America/Caracas')::date),
          (now() at time zone 'America/Caracas')::date, 'manual', 'Asiento de prueba 76', 'test')
  returning id into v_e;
  for v_l in select jsonb_array_elements(p_lineas) loop
    v_n := v_n + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, functional_debit, functional_credit)
    values ('aaaa0076-0000-4000-8000-00000000000a', p_company, v_e, v_n, (v_l ->> 0)::uuid,
            (v_l ->> 1)::numeric, (v_l ->> 2)::numeric,
            greatest((v_l ->> 1)::numeric, (v_l ->> 2)::numeric), 'VES', 1,
            greatest((v_l ->> 1)::numeric, (v_l ->> 2)::numeric), 'VES',
            (v_l ->> 1)::numeric, (v_l ->> 2)::numeric);
  end loop;
  return v_e;
end $$;

-- ── 1. Dos líneas sobre la MISMA cuenta ─────────────────────────────────────
-- 100 + 50 al debe de 1.1.01 y 150 al haber del capital: la historia de la caja «de antes».
insert into _postear select pg_temp.borrador('aaaa0076-0000-4000-8000-0000000000a1',
  '[["aaaa0076-0000-4000-8000-000000001101", "100", "0"],
    ["aaaa0076-0000-4000-8000-000000001101", "50", "0"],
    ["aaaa0076-0000-4000-8000-000000001031", "0", "150"]]');
select lives_ok($$ select pg_temp.postear(entry) from _postear $$,
  'un asiento con dos líneas sobre la misma cuenta se postea sin error');
select is((select debit_total from public.ledger_balances
            where account_id = 'aaaa0076-0000-4000-8000-000000001101'),
          150.00000000::numeric(24,8), 'ledger_balances suma las DOS líneas de la cuenta');
select is((select debit_total from public.ledger_balances
            where account_id = 'aaaa0076-0000-4000-8000-000000001101'),
          (select debit_total from platform.recompute_ledger(
             'aaaa0076-0000-4000-8000-0000000000a1', 'aaaa0076-0000-4000-8000-000000001101')),
          'el materializado coincide con el recalculado');

-- ── 2. Empresa con historia y sin reparar: la caja nueva va a la familia ────
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0076-0000-4000-8000-0000000000c1', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a1', 'Caja Bs', 'VES', 'cash'),
  ('aaaa0076-0000-4000-8000-0000000000c2', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a1', 'Banco Mercantil', 'VES', 'bank'),
  ('aaaa0076-0000-4000-8000-0000000000c3', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a1', 'Caja USD', 'USD', 'cash');
select is((select count(*) from public.company_accounts
            where company_id = 'aaaa0076-0000-4000-8000-0000000000a1'
              and ledger_account_id = 'aaaa0076-0000-4000-8000-000000001101'),
          2::bigint, 'sin reparar, las cajas en Bs se siguen mapeando a la familia');
select is((select is_leaf from public.accounts where id = 'aaaa0076-0000-4000-8000-000000001101'),
          true, 'y la familia sigue siendo hoja: las cajas viejas pueden seguir asentando');
-- La tesorería les atribuye 100 y 40 (10 menos que el mayor: una diferencia previa).
select platform.bump_account_balance('aaaa0076-0000-4000-8000-0000000000c1', 100);
select platform.bump_account_balance('aaaa0076-0000-4000-8000-0000000000c2', 40);
select platform.bump_account_balance('aaaa0076-0000-4000-8000-0000000000c3', 7);
select is((select array_agg(problem order by account_name)
             from platform.treasury_ledger_gaps('aaaa0076-0000-4000-8000-0000000000a1')),
          array['compartida', 'compartida'],
          'el invariante lo dice: dos cajas comparten la cuenta de familia');

-- ── 3. La reparación, como la hace el dominio ───────────────────────────────
create temporary table _rep (r jsonb);
select set_config('ladino.rules_version', 'test-76', true);
insert into _rep select platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a1');
select pg_temp.postear((r ->> 'entry_id')::uuid) from _rep;
select lives_ok($$ select platform.treasury_subaccounts_repair_finish(r, 'test-76') from _rep $$,
  'la reparación se completa: prepare → posteo → finish');

select is((select array_agg(a.code || ' ' || a.name order by a.code)
             from public.company_accounts ca join public.accounts a on a.id = ca.ledger_account_id
            where ca.company_id = 'aaaa0076-0000-4000-8000-0000000000a1'),
          array['1.1.01.01 Caja Bs', '1.1.01.02 Banco Mercantil', '1.1.02.01 Caja USD'],
          'cada caja tiene su subcuenta, hija de su familia y con su nombre');
select is((select array_agg(p.code order by a.code)
             from public.company_accounts ca
             join public.accounts a on a.id = ca.ledger_account_id
             join public.accounts p on p.id = a.parent_id
            where ca.company_id = 'aaaa0076-0000-4000-8000-0000000000a1'),
          array['1.1.01', '1.1.01', '1.1.02'], 'el padre es la cuenta de familia de su moneda');
select is((select balance from platform.recompute_ledger('aaaa0076-0000-4000-8000-0000000000a1',
             'aaaa0076-0000-4000-8000-000000001101')),
          0::numeric, 'la familia en Bs queda en CERO: su historia pasó a las hijas');
select is((select is_leaf from public.accounts where id = 'aaaa0076-0000-4000-8000-000000001101'),
          false, 'y vuelve a ser agrupadora');
select is((select r.balance from public.company_accounts ca
             cross join lateral platform.recompute_ledger(ca.company_id, ca.ledger_account_id) r
            where ca.id = 'aaaa0076-0000-4000-8000-0000000000c2'),
          40::numeric, 'la subcuenta del banco lleva lo que la tesorería le atribuye');
select is((select r.balance from public.accounts a
             cross join lateral platform.recompute_ledger(a.company_id, a.id) r
            where a.company_id = 'aaaa0076-0000-4000-8000-0000000000a1'
              and a.name = 'Por conciliar (reparación ADR-0070)'),
          10::numeric, 'lo que ninguna caja explica va a «Por conciliar», no a una caja');
select is((select count(*) from platform.treasury_ledger_gaps('aaaa0076-0000-4000-8000-0000000000a1')),
          0::bigint, 'el invariante tesorería ↔ mayor da CERO tras la reparación');
select is((select actor_type || '/' || rules_version from public.audit_events
            where company_id = 'aaaa0076-0000-4000-8000-0000000000a1'
              and event_type = 'treasury.subaccounts_repaired'),
          'system/test-76', 'el acta queda con autor system y la versión de reglas');

-- ── 4. Idempotente ──────────────────────────────────────────────────────────
select is((platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a1')
           ->> 'repaired')::int, 0, 'una segunda pasada no encuentra nada que reparar');
select is((select count(*) from public.journal_entries
            where company_id = 'aaaa0076-0000-4000-8000-0000000000a1'
              and description like 'Reclasificación:%'),
          1::bigint, 'y no escribe un segundo asiento');

-- ── 5. Las cajas nuevas nacen con subcuenta ─────────────────────────────────
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0076-0000-4000-8000-0000000000c4', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a1', 'Pago móvil', 'VES', 'bank'),
  ('aaaa0076-0000-4000-8000-0000000000d1', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a2', 'Caja de la nueva', 'VES', 'cash');
select is((select a.code || ' ' || a.name from public.company_accounts ca
             join public.accounts a on a.id = ca.ledger_account_id
            where ca.id = 'aaaa0076-0000-4000-8000-0000000000c4'),
          '1.1.01.04 Pago móvil', 'en la empresa reparada, la caja nueva nace con su subcuenta');
select is((select a.code || ' ' || a.name from public.company_accounts ca
             join public.accounts a on a.id = ca.ledger_account_id
            where ca.id = 'aaaa0076-0000-4000-8000-0000000000d1'),
          '1.1.01.01 Caja de la nueva', 'y en una empresa nueva, también');

-- ── 6. El invariante detecta ────────────────────────────────────────────────
truncate _postear;
insert into _postear select pg_temp.borrador('aaaa0076-0000-4000-8000-0000000000a2',
  jsonb_build_array(
    jsonb_build_array((select ledger_account_id from public.company_accounts
                        where id = 'aaaa0076-0000-4000-8000-0000000000d1')::text, '5', '0'),
    jsonb_build_array('aaaa0076-0000-4000-8000-000000002031', '0', '5')));
select pg_temp.postear(entry) from _postear;
select is((select array_agg(problem)
             from platform.treasury_ledger_gaps('aaaa0076-0000-4000-8000-0000000000a2')),
          array['saldo_distinto'],
          'un asiento que mueve la subcuenta sin hecho de tesorería sale como saldo_distinto');

-- ── 8. La rama de DIVISA de la reparación, con historia real en 1.1.02 ──────
-- La historia (1000 Bs en 1.1.02) existe ANTES que las cajas: así las cajas nacen en la familia
-- y es la REPARACIÓN, no el trigger de alta, la que reparte. Dos cajas en USD con 30 y 10.
truncate _postear;
insert into _postear select pg_temp.borrador('aaaa0076-0000-4000-8000-0000000000a3',
  '[["aaaa0076-0000-4000-8000-000000003102", "1000", "0"],
    ["aaaa0076-0000-4000-8000-000000003031", "0", "1000"]]');
select pg_temp.postear(entry) from _postear;
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0076-0000-4000-8000-0000000000e1', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a3', 'Zelle', 'USD', 'wallet'),
  ('aaaa0076-0000-4000-8000-0000000000e2', 'aaaa0076-0000-4000-8000-00000000000a',
   'aaaa0076-0000-4000-8000-0000000000a3', 'Caja USD', 'USD', 'cash');
select platform.bump_account_balance('aaaa0076-0000-4000-8000-0000000000e1', 30);
select platform.bump_account_balance('aaaa0076-0000-4000-8000-0000000000e2', 10);
truncate _rep;
insert into _rep select platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a3');
select pg_temp.postear((r ->> 'entry_id')::uuid) from _rep;
select platform.treasury_subaccounts_repair_finish(r, 'test-76') from _rep;
select is((select (x ->> 'reclassified_functional')::numeric
             from _rep, jsonb_array_elements(r -> 'accounts') x
            where x ->> 'company_account_id' = 'aaaa0076-0000-4000-8000-0000000000e1'),
          750::numeric, 'divisa: la caja con 30 de 40 USD se lleva 3/4 de los Bs de 1.1.02');
select is((select (x ->> 'reclassified_functional')::numeric
             from _rep, jsonb_array_elements(r -> 'accounts') x
            where x ->> 'company_account_id' = 'aaaa0076-0000-4000-8000-0000000000e2'),
          250::numeric, 'y la última, el resto exacto');
select is((select sum((x ->> 'reclassified_functional')::numeric)
             from _rep, jsonb_array_elements(r -> 'accounts') x),
          1000::numeric, 'la suma reclasificada es la historia entera de 1.1.02');
select is((select balance from platform.recompute_ledger('aaaa0076-0000-4000-8000-0000000000a3',
             'aaaa0076-0000-4000-8000-000000003102')),
          0::numeric, 'y 1.1.02 queda en CERO, sin «Por conciliar»');

-- ── 9. Cuándo NO repara ─────────────────────────────────────────────────────
-- Cuatro empresas con historia en 1.1.01 y una caja que nace en la familia.
truncate _postear;
insert into _postear
select pg_temp.borrador(('aaaa0076-0000-4000-8000-0000000000a' || n)::uuid,
  jsonb_build_array(jsonb_build_array('aaaa0076-0000-4000-8000-00000000' || n || '101', '20', '0'),
                    jsonb_build_array('aaaa0076-0000-4000-8000-00000000' || n || '031', '0', '20')))
  from generate_series(4, 7) as n;
select pg_temp.postear(entry) from _postear;
insert into public.company_accounts (tenant_id, company_id, name, currency, kind)
select 'aaaa0076-0000-4000-8000-00000000000a', ('aaaa0076-0000-4000-8000-0000000000a' || n)::uuid,
       'Caja Bs', 'VES', 'cash'
  from generate_series(4, 7) as n;

-- (a) El período del día, cerrado.
update public.fiscal_periods
   set status = 'closed', closed_at = now(), closed_by = '00000000-0000-0000-0000-000000000076'
 where company_id = 'aaaa0076-0000-4000-8000-0000000000a4'
   and year = extract(year from (now() at time zone 'America/Caracas'))::int
   and month = extract(month from (now() at time zone 'America/Caracas'))::int;
select is(platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a4') ->> 'skipped',
          'periodo_cerrado', 'con el período del día cerrado, salta con su razón');
select is((select count(*) from public.accounts
            where parent_id = 'aaaa0076-0000-4000-8000-000000004101'),
          0::bigint, '… sin crear ni una subcuenta');
select is((select count(*) from public.journal_entries
            where company_id = 'aaaa0076-0000-4000-8000-0000000000a4'
              and description like 'Reclasificación:%'),
          0::bigint, '… ni un asiento');
select is((select payload ->> 'reason' from public.audit_events
            where company_id = 'aaaa0076-0000-4000-8000-0000000000a4'
              and event_type = 'treasury.subaccounts_repair_skipped'),
          'periodo_cerrado', '… y deja el acta del salto');

-- (b) Un hecho pendiente en la cola.
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0076-0000-4000-8000-00000000000a', 'aaaa0076-0000-4000-8000-0000000000a5', 'expense',
        gen_random_uuid(), 'treasury.expense.registered', '{}', 'pendiente de prueba 76');
select is(platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a5') ->> 'skipped',
          'cola_pendiente', 'con un hecho en la cola, salta: al reprocesarlo contaría dos veces');

-- (c) Una plantilla vigente que nombra la cuenta de familia.
with t as (
  insert into public.journal_templates (tenant_id, company_id, source_kind, source_event, description)
  values ('aaaa0076-0000-4000-8000-00000000000a', 'aaaa0076-0000-4000-8000-0000000000a6', 'expense',
          'treasury.expense.registered', 'Gasto con caja fija (prueba 76)')
  returning id)
insert into public.journal_template_lines
  (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side)
select 'aaaa0076-0000-4000-8000-00000000000a', 'aaaa0076-0000-4000-8000-0000000000a6', t.id, 1,
       'cash_bs', 'functional_amount', 'credit' from t;
select is(platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a6') ->> 'skipped',
          'plantilla_nombra_familia',
          'si una plantilla vigente nombra cash_bs, salta: tras reparar, sus hechos morirían en LAD62');

-- (d) `finish` con el asiento aún en borrador.
truncate _rep;
insert into _rep select platform.treasury_subaccounts_repair_prepare('aaaa0076-0000-4000-8000-0000000000a7');
select throws_ok($$ select platform.treasury_subaccounts_repair_finish(r, 'test-76') from _rep $$,
  'LAD82', null, 'finish con el asiento de reclasificación en BORRADOR no cierra: LAD82');

-- ── 7. VARIANTE ROTA: el upsert por línea de antes ──────────────────────────
create or replace function platform.apply_ledger_balance()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_funcional text;
begin
  if new.status not in ('posted', 'reversed') then return new; end if;
  if tg_op = 'UPDATE' and old.status in ('posted', 'reversed') then return new; end if;
  select functional_currency_code into v_funcional from public.companies where id = new.company_id;
  insert into public.ledger_balances
    (tenant_id, company_id, account_id, period_id, debit_total, credit_total, functional_currency)
  select new.tenant_id, new.company_id, jl.account_id, new.period_id,
         jl.functional_debit, jl.functional_credit, v_funcional
    from public.journal_lines jl where jl.entry_id = new.id
  on conflict (company_id, account_id, period_id) do update
    set debit_total  = public.ledger_balances.debit_total  + excluded.debit_total,
        credit_total = public.ledger_balances.credit_total + excluded.credit_total;
  return new;
end $$;
truncate _postear;
insert into _postear select pg_temp.borrador('aaaa0076-0000-4000-8000-0000000000a2',
  '[["aaaa0076-0000-4000-8000-000000002031", "3", "0"],
    ["aaaa0076-0000-4000-8000-000000002031", "4", "0"],
    ["aaaa0076-0000-4000-8000-000000002102", "0", "7"]]');
select throws_ok($$ select pg_temp.postear(entry) from _postear $$, '21000', null,
  'VARIANTE ROTA: sin el group by, dos líneas sobre la misma cuenta mueren con 21000 (el 500 de J-01)');

select * from finish();
rollback;
