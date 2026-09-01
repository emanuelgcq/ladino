-- =============================================================================
-- Ladino — pgTAP 31 · CIERRE DE CAJA (migración 31) — RIGOR MÁXIMO
--
-- El cierre es el momento en que el sistema y la realidad se miran: lo que
-- decían los papeles contra lo que hay en la gaveta. Esto prueba:
--
--   1. la diferencia ES contado menos esperado — no un campo libre — y una
--      diferencia sin motivo no entra;
--   2. tras cerrar, el saldo materializado queda EXACTAMENTE en lo contado,
--      y la conciliación sigue cuadrando (el recómputo aprendió los cierres);
--   3. un cierre con diferencia entra a la familia de cobertura contable; uno
--      exacto no genera asiento ni tiene por qué;
--   4. un cierre no se edita ni se borra: si se contó mal, se cierra de nuevo;
--   5. el preset trae el mapeo de sobrante/faltante en pares excluyentes.
-- =============================================================================

begin;
select plan(16);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0031-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0031-0000-4000-8000-00000000000a', 'Tenant 31');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0031-0000-4000-8000-0000000000a2', 'aaaa0031-0000-4000-8000-00000000000a',
   'J-31-A', 'Empresa 31', 'ordinario');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0031-0000-4000-8000-0000000000e1', 'aaaa0031-0000-4000-8000-00000000000a',
   'aaaa0031-0000-4000-8000-0000000000a2', 'Caja Bs', 'VES', 'cash');
-- La cuenta abre en 0 sin movimientos: el PRIMER cierre declara el conteo, que
-- es exactamente cómo un negocio real estrena su caja en Ladino.

-- ── 1. Estructura ───────────────────────────────────────────────────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'cash_closings'
      and c.relrowsecurity and c.relforcerowsecurity),
  1::bigint, 'cash_closings con RLS habilitada Y forzada');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'cash_closings'
      and grantee in ('anon', 'authenticated', 'service_role', 'ladino_worker')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0::bigint, 'y solo la API cierra cajas');

-- ── 2. La diferencia no es un campo libre ───────────────────────────────────
select throws_ok($$
  insert into public.cash_closings
    (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
     counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
     functional_amount, functional_currency, reason)
  values ('aaaa0031-0000-4000-8000-00000000000a', 'aaaa0031-0000-4000-8000-0000000000a2',
          'aaaa0031-0000-4000-8000-0000000000e1', '2026-08-05', '2026-08-05T22:00:00Z',
          500, 460, -30, 'VES', 1, -30, 'VES', 'faltó vuelto')
$$, '23514', null,
  'declarar −30 donde contado−esperado da −40 es imposible: la diferencia ES la resta, no una opinión');
select throws_ok($$
  insert into public.cash_closings
    (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
     counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
     functional_amount, functional_currency)
  values ('aaaa0031-0000-4000-8000-00000000000a', 'aaaa0031-0000-4000-8000-0000000000a2',
          'aaaa0031-0000-4000-8000-0000000000e1', '2026-08-05', '2026-08-05T22:00:00Z',
          500, 460, -40, 'VES', 1, -40, 'VES')
$$, '23514', null,
  'una diferencia SIN motivo no entra: un faltante que nadie explica hoy es un faltante que nadie explicará nunca');
select throws_ok($$
  insert into public.cash_closings
    (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
     counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
     functional_amount, functional_currency, reason)
  values ('aaaa0031-0000-4000-8000-00000000000a', 'aaaa0031-0000-4000-8000-0000000000a2',
          'aaaa0031-0000-4000-8000-0000000000e1', '2026-08-05', '2026-08-05T22:00:00Z',
          500, 460, -40, 'VES', 1, 40, 'VES', 'faltó vuelto')
$$, '23514', null,
  'y la conversión a funcional no puede cambiar el signo: un faltante no se vuelve sobrante al convertirse');

-- ── 3. El cierre deja el saldo en lo contado ────────────────────────────────
-- La cuenta abre en 0 (sin movimientos). Se cierra contando 460: sobran 460
-- respecto a los papeles, con su motivo. El saldo queda en 460.
insert into public.cash_closings
  (id, tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
   counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, reason) values
  ('aaaa0031-0000-4000-8000-00000000f401', 'aaaa0031-0000-4000-8000-00000000000a',
   'aaaa0031-0000-4000-8000-0000000000a2', 'aaaa0031-0000-4000-8000-0000000000e1',
   '2026-08-05', '2026-08-05T22:00:00Z', 0, 460, 460, 'VES', 1, 460, 'VES',
   'fondo de caja inicial que los papeles no tenían');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0031-0000-4000-8000-0000000000e1'),
  460::numeric,
  'tras el cierre el saldo materializado queda EXACTAMENTE en lo contado: mañana se arranca de la realidad');
select is(
  (select count(*) from platform.treasury_reconciliation('aaaa0031-0000-4000-8000-0000000000a2')
    where not ok),
  0::bigint, 'y la conciliación sigue cuadrando: el recómputo aprendió los cierres');

-- ── 4. Diferencia ⇒ asiento o cola; cierre exacto ⇒ nada que asentar ────────
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0031-0000-4000-8000-0000000000a2')
    where source_kind = 'cash_closing' and problem = 'missing'),
  1::bigint, 'el cierre con diferencia sin asiento ni cola es un hueco que el invariante acusa');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0031-0000-4000-8000-00000000000a', 'aaaa0031-0000-4000-8000-0000000000a2',
   'cash_closing', 'aaaa0031-0000-4000-8000-00000000f401', 'treasury.cash_register.closed',
   '{"functional_amount": "460"}', 'sin cuenta con papel cash_over_short');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0031-0000-4000-8000-0000000000a2')),
  0::bigint, 'encolado, se cierra el hueco');

select lives_ok($$
  insert into public.cash_closings
    (tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
     counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
     functional_amount, functional_currency)
  values ('aaaa0031-0000-4000-8000-00000000000a', 'aaaa0031-0000-4000-8000-0000000000a2',
          'aaaa0031-0000-4000-8000-0000000000e1', '2026-08-06', '2026-08-06T22:00:00Z',
          460, 460, 0, 'VES', 1, 0, 'VES')
$$, 'un cierre EXACTO entra sin motivo: no hay nada que explicar');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0031-0000-4000-8000-0000000000e1'),
  460::numeric, 'y no mueve el saldo: cuadrar no es un movimiento');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0031-0000-4000-8000-0000000000a2')),
  0::bigint,
  'ni exige asiento: diferencia cero, hecho contable cero — el invariante lo dice en su enunciado, no en una lista de perdones');

-- ── 5. Un cierre no se edita ni se borra ────────────────────────────────────
select throws_ok($$
  update public.cash_closings set counted_amount = 500
   where id = 'aaaa0031-0000-4000-8000-00000000f401'
$$, 'LAD06', null,
  'lo contado no se reescribe: si se contó mal, se cierra de nuevo y el cierre nuevo corrige');
select throws_ok($$
  delete from public.cash_closings where id = 'aaaa0031-0000-4000-8000-00000000f401'
$$, 'LAD06', null, 'y un cierre no se borra');

-- ── 6. El preset mapea sobrante y faltante en pares excluyentes ─────────────
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'),
  4::bigint, 'cuatro patas: dos para el sobrante (if_positive), dos para el faltante (if_negative)');
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
      and l.condition_kind = 'always'),
  0::bigint,
  'y NINGUNA incondicional: con diferencia cero el asiento no tendría patas, y un asiento vacío no es un asiento');

select * from finish();
rollback;
