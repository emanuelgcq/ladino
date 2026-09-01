-- =============================================================================
-- Ladino — pgTAP 25 · CONTABILIDAD (migración 25) — RIGOR MÁXIMO, SIN ZONAS
--
-- Lo que este fichero está aquí para demostrar:
--   1. la partida doble se comprueba EN POSTGRES, en moneda funcional, y
--      rechaza con código propio — no vive en la API;
--   2. una cuenta que agrupa, una desactivada o una que exige dimensiones sin
--      traerlas, rechazan el asiento;
--   3. un período cerrado no admite asientos, y reabrirlo exige motivo escrito;
--   4. un asiento posteado es inmutable en las DOS capas de ADR-0006, y sus
--      líneas también — cabecera inmutable con líneas editables sería peor que
--      nada, porque parece protegida;
--   5. el mayor materializado reproduce lo que dicen los asientos crudos
--      (mismo par que stock_balances ↔ recompute_stock);
--   6. el balance de comprobación a fecha X no ve nada posterior a X;
--   7. la reversión deja CADA cuenta en cero, y conserva el correlativo;
--   8. el INVARIANTE de ADR-0042: documento posteado tiene asiento O fila
--      pendiente, nunca ninguno de los dos, nunca los dos;
--   9. la idempotencia contable es por EVENTO, no por documento;
--  10. aislamiento por company y catálogos globales de solo lectura.
-- =============================================================================

begin;
select plan(53);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0025-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0025-0000-4000-8000-00000000000a', 'Tenant 25'),
  ('aaaa0025-0000-4000-8000-00000000000b', 'Tenant 25-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-00000000000a',
   'J-25-A', 'Empresa 25', 'ordinario'),
  ('aaaa0025-0000-4000-8000-0000000000b2', 'aaaa0025-0000-4000-8000-00000000000b',
   'J-25-B', 'Empresa 25-B', 'ordinario');

-- ── 1. Los catálogos nacen como deben (ADR-0041/0043) ───────────────────────
select is((select count(*) from public.journal_templates), 0::bigint,
  'journal_templates nace VACÍA (ADR-0041): sin mapeo no se inventa una cuenta');
select is((select count(*) from public.accounts), 0::bigint,
  'accounts nace VACÍA (ADR-0043): el plan de cuentas no se hard-codea');
select cmp_ok((select count(*) from public.chart_templates), '>=', 1::bigint,
  'sí hay UNA plantilla GLOBAL de plan de cuentas, para poder arrancar');
select is((select count(*) from public.chart_templates
            where description not like '%VALIDAR-CONTABLE%'), 0::bigint,
  'y va marcada VALIDAR-CONTABLE: Ladino no afirma que sea el plan correcto de nadie');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname in
      ('accounts','account_purposes','company_account_settings','fiscal_periods',
       'journal_entries','journal_lines','ledger_balances','journal_templates',
       'journal_template_lines','journal_generation_queue','chart_templates',
       'chart_template_accounts')
      and c.relrowsecurity and c.relforcerowsecurity),
  12::bigint, 'las doce tablas de contabilidad con RLS habilitada y FORZADA');

-- ── 2. El plan de cuentas: jerarquía, naturaleza y hojas ─────────────────────
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature) values
  ('aaaa0025-0000-4000-8000-0000000000c1', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', '1', 'Activo', 'activo', 'deudora');
insert into public.accounts (id, tenant_id, company_id, code, name, parent_id, kind, nature) values
  ('aaaa0025-0000-4000-8000-0000000000c2', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', '1.1', 'Caja',
   'aaaa0025-0000-4000-8000-0000000000c1', 'activo', 'deudora');

select is((select path from public.accounts where id = 'aaaa0025-0000-4000-8000-0000000000c2'),
  '1/1.1',
  'el materialized path lo mantiene el esquema, y separa con / porque un CÓDIGO puede llevar puntos');
select is((select level from public.accounts where id = 'aaaa0025-0000-4000-8000-0000000000c2'),
  2, 'y el nivel también');
select is((select is_leaf from public.accounts where id = 'aaaa0025-0000-4000-8000-0000000000c1'),
  false,
  'el padre DEJA de ser hoja al tener un hijo: «hoja con descendencia» sería un estado imposible que aceptaría asientos');

select throws_ok($$
  insert into public.accounts (tenant_id, company_id, code, name, kind, nature)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          '9', 'Activo acreedor', 'activo', 'acreedora')
$$, '23514', null,
  'una cuenta de activo con naturaleza acreedora se rechaza: la naturaleza la impone el tipo');

select throws_ok($$
  insert into public.accounts (tenant_id, company_id, code, name, kind, nature)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          '1', 'Duplicada', 'activo', 'deudora')
$$, '23505', null, 'el código de cuenta es único por empresa');

-- El resto del plan mínimo para poder asentar.
insert into public.accounts (id, tenant_id, company_id, code, name, parent_id, kind, nature,
                             requires_analytical) values
  ('aaaa0025-0000-4000-8000-0000000000c3', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', '4', 'Ventas', null, 'ingreso', 'acreedora', false),
  ('aaaa0025-0000-4000-8000-0000000000c4', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', '5', 'Gastos con centro', null, 'gasto', 'deudora', true),
  ('aaaa0025-0000-4000-8000-0000000000c5', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', '2', 'Cuentas por pagar', null, 'pasivo', 'acreedora', false);
update public.accounts set is_active = false where code = '2'
  and company_id = 'aaaa0025-0000-4000-8000-0000000000a2';

-- ── 3. Períodos ─────────────────────────────────────────────────────────────
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0025-0000-4000-8000-0000000000d1', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 2026, 2),
  ('aaaa0025-0000-4000-8000-0000000000d2', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 2026, 1);
update public.fiscal_periods
   set status = 'closed', closed_at = now(), closed_by = 'aaaa0025-0000-4000-8000-0000000000a1'
 where id = 'aaaa0025-0000-4000-8000-0000000000d2';

select throws_ok($$
  update public.fiscal_periods
     set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0025-0000-4000-8000-0000000000a1', reopened_reason = 'corto'
   where id = 'aaaa0025-0000-4000-8000-0000000000d2'
$$, '23514', null,
  'reabrir con un motivo de cuatro letras se rechaza: «corto» no es una justificación');

-- ── 4. LA PARTIDA DOBLE, en Postgres ────────────────────────────────────────
-- Un asiento se construye en borrador y se postea. El trigger dispara al postear.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0025-0000-4000-8000-0000000000e1', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000d1',
   '2026-02-15', 'manual', 'Asiento desbalanceado a propósito');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
   'aaaa0025-0000-4000-8000-0000000000e1', 1, 'aaaa0025-0000-4000-8000-0000000000c2',
   1000, 0, 1000, 'VES', 1000, 'VES', 1000, 0),
  ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
   'aaaa0025-0000-4000-8000-0000000000e1', 2, 'aaaa0025-0000-4000-8000-0000000000c3',
   0, 900, 900, 'VES', 900, 'VES', 0, 900);

select throws_ok($$
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = 'aaaa0025-0000-4000-8000-0000000000a1', entry_number = 1
   where id = 'aaaa0025-0000-4000-8000-0000000000e1'
$$, 'LAD59', null,
  'la partida doble NO cuadra y el ESQUEMA lo rechaza con código propio: el invariante no vive en la API');

-- Una línea que debita en transacción y acredita en funcional cuadraría el
-- asiento por accidente. El CHECK lo impide.
select throws_ok($$
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-0000000000e1', 3, 'aaaa0025-0000-4000-8000-0000000000c2',
          100, 0, 100, 'VES', 100, 'VES', 0, 100)
$$, '23514', null,
  'una línea que debita en transacción y acredita en funcional se rechaza: cuadraría por accidente');

select throws_ok($$
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-0000000000e1', 4, 'aaaa0025-0000-4000-8000-0000000000c2',
          100, 50, 100, 'VES', 100, 'VES', 100, 50)
$$, '23514', null, 'y una línea con débito Y crédito también: eso son dos líneas');

-- Ahora uno que sí cuadra.
update public.journal_lines set credit_amount = 1000, functional_credit = 1000,
       amount_transaction_currency = 1000, functional_amount = 1000
 where entry_id = 'aaaa0025-0000-4000-8000-0000000000e1' and line_number = 2;
update public.journal_entries
   set status = 'posted', posted_at = now(),
       posted_by = 'aaaa0025-0000-4000-8000-0000000000a1',
       entry_number = platform.claim_entry_number('aaaa0025-0000-4000-8000-0000000000a2', 2026)
 where id = 'aaaa0025-0000-4000-8000-0000000000e1';
select is((select entry_number from public.journal_entries
            where id = 'aaaa0025-0000-4000-8000-0000000000e1'), 1::bigint,
  'el primer asiento del año lleva el número 1');
select is((select status from public.journal_entries
            where id = 'aaaa0025-0000-4000-8000-0000000000e1'), 'posted',
  'y cuadrado, se postea');

-- ── 5. Cuentas que no admiten movimiento ────────────────────────────────────
create or replace function pg_temp.asiento_con(p_cuenta uuid, p_dim jsonb, p_periodo uuid,
                                               p_fecha date)
returns void language plpgsql as $$
declare v_id uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          p_periodo, p_fecha, 'manual', 'Sonda de cuenta') returning id into v_id;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit, analytical_dimensions)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          v_id, 1, p_cuenta, 500, 0, 500, 'VES', 500, 'VES', 500, 0, p_dim),
         ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          v_id, 2, 'aaaa0025-0000-4000-8000-0000000000c3', 0, 500, 500, 'VES', 500, 'VES', 0, 500, null);
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = 'aaaa0025-0000-4000-8000-0000000000a1',
         entry_number = platform.claim_entry_number('aaaa0025-0000-4000-8000-0000000000a2', 2026)
   where id = v_id;
end $$;

select throws_ok($$
  select pg_temp.asiento_con('aaaa0025-0000-4000-8000-0000000000c1', null,
                             'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-15')
$$, 'LAD62', null, 'una cuenta que AGRUPA no recibe asientos: usa una de sus hojas');
select throws_ok($$
  select pg_temp.asiento_con('aaaa0025-0000-4000-8000-0000000000c5', null,
                             'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-15')
$$, 'LAD62', null, 'una cuenta DESACTIVADA tampoco');
select throws_ok($$
  select pg_temp.asiento_con('aaaa0025-0000-4000-8000-0000000000c4', null,
                             'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-15')
$$, 'LAD62', null,
  'una cuenta que exige dimensiones analíticas y no las trae, tampoco: la exigencia sin comprobación es decoración');
select lives_ok($$
  select pg_temp.asiento_con('aaaa0025-0000-4000-8000-0000000000c4',
                             '{"centro_costo": "ventas"}'::jsonb,
                             'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-15')
$$, 'y con las dimensiones, sí');

-- ── 6. Período cerrado ──────────────────────────────────────────────────────
select throws_ok($$
  select pg_temp.asiento_con('aaaa0025-0000-4000-8000-0000000000c2', null,
                             'aaaa0025-0000-4000-8000-0000000000d2', '2026-01-15')
$$, 'LAD61', null, 'un asiento con fecha en un período CERRADO se rechaza, con código propio');

-- ── 7. Append-only, en las dos capas ────────────────────────────────────────
select throws_ok($$
  update public.journal_entries set description = 'cambiada a posteriori'
   where id = 'aaaa0025-0000-4000-8000-0000000000e1'
$$, 'LAD06', null, 'un asiento POSTEADO no se edita: se corrige con una reversión');
select throws_ok($$
  delete from public.journal_entries where id = 'aaaa0025-0000-4000-8000-0000000000e1'
$$, 'LAD06', null, 'ni se borra');
select throws_ok($$
  update public.journal_lines set debit_amount = 99999
   where entry_id = 'aaaa0025-0000-4000-8000-0000000000e1' and line_number = 1
$$, 'LAD06', null,
  'y sus LÍNEAS menos: cabecera inmutable con importes editables sería peor que nada, porque parece protegida');
select throws_ok($$
  delete from public.journal_lines
   where entry_id = 'aaaa0025-0000-4000-8000-0000000000e1' and line_number = 1
$$, 'LAD06', null, 'ni se borran');
-- Se truncan TODAS las que se referencian entre sí (desde la fase C, también
-- expenses y cash_closings apuntan al diario con su backlink). Truncar solo la
-- cabecera fallaría por la FK con 0A000, y el test pasaría por la razón
-- equivocada sin llegar nunca al trigger — que es justo lo que se quiere
-- comprobar.
select throws_ok($$
  truncate public.journal_lines, public.journal_generation_queue,
           public.expenses, public.cash_closings, public.journal_entries
$$, 'LAD06', null,
  'TRUNCATE sobre el diario: rechazado por trigger (capa 2 de ADR-0006), no por la FK');

-- Capa 1: ni siquiera hay GRANT de mutación para nadie sobre las líneas de un
-- asiento posteado… salvo el que necesita editar borradores. Lo que NO hay es
-- BYPASSRLS ni policy de authenticated.
select is((select count(*) from information_schema.role_table_grants
            where table_schema = 'public' and table_name = 'journal_lines'
              and grantee in ('anon', 'authenticated', 'service_role')
              and privilege_type in ('UPDATE', 'DELETE', 'TRUNCATE')), 0::bigint,
  'capa 1: ni anon, ni authenticated, ni service_role tienen UPDATE/DELETE sobre journal_lines');

-- Un borrador SÍ se edita: es lo que distingue un borrador de un hecho.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0025-0000-4000-8000-0000000000e2', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000d1',
   '2026-02-16', 'manual', 'Borrador editable');
select lives_ok($$
  update public.journal_entries set description = 'Borrador ya editado'
   where id = 'aaaa0025-0000-4000-8000-0000000000e2'
$$, 'un asiento en BORRADOR sí se edita: para eso es un borrador');
select lives_ok($$
  delete from public.journal_entries where id = 'aaaa0025-0000-4000-8000-0000000000e2'
$$, 'y se borra');

-- Un asiento de una sola línea no es partida doble.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0025-0000-4000-8000-0000000000e3', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000d1',
   '2026-02-16', 'manual', 'Una sola línea');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
   'aaaa0025-0000-4000-8000-0000000000e3', 1, 'aaaa0025-0000-4000-8000-0000000000c2',
   100, 0, 100, 'VES', 100, 'VES', 100, 0);
select throws_ok($$
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = 'aaaa0025-0000-4000-8000-0000000000a1', entry_number = 99
   where id = 'aaaa0025-0000-4000-8000-0000000000e3'
$$, 'LAD59', null, 'un asiento de UNA línea no es partida doble, aunque «cuadre» consigo mismo');

-- ── 8. Mayor materializado ↔ recalculado ────────────────────────────────────
select is(
  (select debit_total from public.ledger_balances
    where company_id = 'aaaa0025-0000-4000-8000-0000000000a2'
      and account_id = 'aaaa0025-0000-4000-8000-0000000000c2'
      and period_id = 'aaaa0025-0000-4000-8000-0000000000d1'),
  (select debit_total from platform.recompute_ledger(
     'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000c2')),
  'el mayor MATERIALIZADO reproduce lo que dicen los asientos crudos (débitos)');
select is(
  (select credit_total from public.ledger_balances
    where company_id = 'aaaa0025-0000-4000-8000-0000000000a2'
      and account_id = 'aaaa0025-0000-4000-8000-0000000000c3'
      and period_id = 'aaaa0025-0000-4000-8000-0000000000d1'),
  (select credit_total from platform.recompute_ledger(
     'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000c3')),
  'y también los créditos: es el mismo par que stock_balances ↔ recompute_stock');

select is((select count(*) from public.ledger_balances
            where account_id = 'aaaa0025-0000-4000-8000-0000000000c2'
              and period_id = 'aaaa0025-0000-4000-8000-0000000000d1'), 1::bigint,
  'una fila por (cuenta, período): el mayor se agrega, no se duplica');

-- Un asiento en BORRADOR no llega al mayor: todavía no es un hecho.
select is(
  (select debit_total from platform.recompute_ledger(
     'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000c2')),
  1000::numeric,
  'el asiento en borrador de una línea NO entra al mayor: un borrador no es un hecho');

-- ── 9. Balance de comprobación: la fecha es PARÁMETRO ───────────────────────
select cmp_ok((select count(*) from platform.trial_balance(
                 'aaaa0025-0000-4000-8000-0000000000a2', '2026-02-28')), '>', 0::bigint,
  'el balance de comprobación a fin de febrero tiene filas');
select is((select count(*) from platform.trial_balance(
             'aaaa0025-0000-4000-8000-0000000000a2', '2026-02-14')), 0::bigint,
  'y al 14 de febrero, NINGUNA: un asiento del día 15 no puede aparecer en un balance del 14');
select is(
  (select sum(period_debit) - sum(period_credit) from platform.trial_balance(
     'aaaa0025-0000-4000-8000-0000000000a2', '2026-12-31')),
  0::numeric,
  'Σ débitos = Σ créditos en el balance: si no, hay un asiento roto en la base');

-- ── 10. Reversión ───────────────────────────────────────────────────────────
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description, is_reversal_of)
values
  ('aaaa0025-0000-4000-8000-0000000000e9', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000d1',
   '2026-02-20', 'manual', 'Reversión del asiento 1',
   'aaaa0025-0000-4000-8000-0000000000e1');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit)
select 'aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
       'aaaa0025-0000-4000-8000-0000000000e9', jl.line_number, jl.account_id,
       jl.credit_amount, jl.debit_amount, jl.amount_transaction_currency, jl.transaction_currency,
       jl.functional_amount, jl.functional_currency, jl.functional_credit, jl.functional_debit
  from public.journal_lines jl where jl.entry_id = 'aaaa0025-0000-4000-8000-0000000000e1';
update public.journal_entries
   set status = 'posted', posted_at = now(),
       posted_by = 'aaaa0025-0000-4000-8000-0000000000a1',
       entry_number = platform.claim_entry_number('aaaa0025-0000-4000-8000-0000000000a2', 2026)
 where id = 'aaaa0025-0000-4000-8000-0000000000e9';
update public.journal_entries
   set status = 'reversed', reversed_by_entry_id = 'aaaa0025-0000-4000-8000-0000000000e9'
 where id = 'aaaa0025-0000-4000-8000-0000000000e1';

select is(
  (select balance from platform.recompute_ledger(
     'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000c2',
     '2026-02-15', '2026-02-20')),
  0::numeric,
  'original + reversión deja la cuenta de caja EN CERO — la propiedad que define una reversión');
select is((select entry_number from public.journal_entries
            where id = 'aaaa0025-0000-4000-8000-0000000000e1'), 1::bigint,
  'y el asiento reversado CONSERVA su número: reversar no es borrar');
select is((select status from public.journal_entries
            where id = 'aaaa0025-0000-4000-8000-0000000000e1'), 'reversed',
  'queda marcado como reversado, y ambos siguen visibles en la cuenta');
select isnt((select reversed_by_entry_id from public.journal_entries
              where id = 'aaaa0025-0000-4000-8000-0000000000e1'), null,
  'con la cadena de reversión en las dos direcciones');

select throws_ok($$
  update public.journal_entries set status = 'draft'
   where id = 'aaaa0025-0000-4000-8000-0000000000e9'
$$, 'LAD06', null, 'un asiento posteado no vuelve a borrador');

-- ── 11. Idempotencia contable POR EVENTO (ADR-0042) ─────────────────────────
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description)
values
  ('aaaa0025-0000-4000-8000-00000000ea01', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'aaaa0025-0000-4000-8000-0000000000d1',
   '2026-02-21', 'sales_invoice', 'aaaa0025-0000-4000-8000-00000000fa01',
   'fiscal.invoice.issued', 'Asiento de la factura');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-21', 'sales_invoice',
          'aaaa0025-0000-4000-8000-00000000fa01', 'fiscal.invoice.issued', 'Duplicado')
$$, '23505', null, 'el MISMO evento del mismo documento no genera dos asientos');
select lives_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-22', 'sales_invoice',
          'aaaa0025-0000-4000-8000-00000000fa01', 'ar.payment_applied', 'Cobro de la misma factura')
$$,
  'pero OTRO evento del mismo documento sí: sin el eje del evento, una factura no podría asentarse al emitirse Y al cobrarse');

select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-21', 'sales_invoice',
          'Automático sin origen')
$$, '23514', null,
  'un asiento automático SIN documento origen ni evento se rechaza: la trazabilidad es obligatoria');

-- ── 12. El invariante de ADR-0042 ───────────────────────────────────────────
select is((select count(*) from platform.accounting_coverage_gaps(
             'aaaa0025-0000-4000-8000-0000000000a2')), 0::bigint,
  'sin documentos, no hay huecos de cobertura contable — y la consulta EXISTE, que es lo que la hace comprobable');

-- ── 13. Mapeo: vocabulario CERRADO (ADR-0041) ───────────────────────────────
insert into public.company_account_settings
  (tenant_id, company_id, purpose, account_id) values
  ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
   'income_general', 'aaaa0025-0000-4000-8000-0000000000c3');
select throws_ok($$
  insert into public.company_account_settings (tenant_id, company_id, purpose, account_id)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'income_general', 'aaaa0025-0000-4000-8000-0000000000c2')
$$, '23P01', null,
  'dos cuentas para el MISMO papel vigentes a la vez se rechazan: sería un asiento que no se sabe dónde va');

insert into public.journal_templates
  (id, tenant_id, company_id, source_kind, source_event, description) values
  ('aaaa0025-0000-4000-8000-00000000fb01', 'aaaa0025-0000-4000-8000-00000000000a',
   'aaaa0025-0000-4000-8000-0000000000a2', 'sales_invoice', 'fiscal.invoice.issued',
   'Venta: CxC contra ingresos e IVA');
select throws_ok($$
  insert into public.journal_template_lines
    (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-00000000fb01', 1, 'income_general',
          'select * from users', 'credit')
$$, '23514', null,
  'un `amount_source` libre se rechaza: sería acceso dinámico a datos desde una tabla de configuración (ADR-0041)');
select throws_ok($$
  insert into public.journal_template_lines
    (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side,
     condition_kind)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-00000000fb01', 2, 'income_general', 'subtotal', 'credit',
          'if_moon_is_full')
$$, '23514', null, 'y una condición fuera del vocabulario cerrado, también');
select lives_ok($$
  insert into public.journal_template_lines
    (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side)
  values ('aaaa0025-0000-4000-8000-00000000000a', 'aaaa0025-0000-4000-8000-0000000000a2',
          'aaaa0025-0000-4000-8000-00000000fb01', 3, 'income_general', 'subtotal', 'credit')
$$, 'con el vocabulario cerrado, sí');

-- ── 14. Catálogos globales y aislamiento ────────────────────────────────────
select is((select count(*) from public.accounts
            where company_id = 'aaaa0025-0000-4000-8000-0000000000b2'), 0::bigint,
  'la empresa B no ve cuentas de la A: aislamiento por company');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0025-0000-4000-8000-00000000000b', 'aaaa0025-0000-4000-8000-0000000000b2',
          'aaaa0025-0000-4000-8000-0000000000d1', '2026-02-15', 'manual', 'Cruzado')
$$, '23503', null,
  'un asiento de la empresa B contra un período de la A se rechaza por la FK compuesta');

select is(
  (select count(*) from pg_policies
    where schemaname = 'public' and tablename = 'chart_templates'
      and cmd in ('INSERT', 'UPDATE', 'DELETE')
      and coalesce(qual, with_check) = 'false'),
  3::bigint,
  'los catálogos globales deniegan INSERT, UPDATE y DELETE POR ESCRITO, no por omisión');

select * from finish();
rollback;
