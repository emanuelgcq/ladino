-- =============================================================================
-- Ladino — pgTAP 79 · LOS PERÍODOS TIENEN HISTORIA (ADR-0069; K-01, K-02, K-03, K-05, K-06)
--
--   1. cerrar → reabrir → cerrar → reabrir sobre el MISMO período funciona, y cada
--      paso deja su evento en `fiscal_period_events` (append-only, con su ancla);
--   2. la reapertura exige motivo, y es el CHECK el que lo exige (variante rota);
--   3. el período de cierre «13»: solo cierre y ajustes, fechados 31-12; diciembre
--      puede estar cerrado;
--   4. `period_for_date` no da períodos antes del inicio de actividades ni futuros;
--   5. un asiento (también un borrador) no se crea en un período cerrado (variante rota);
--   6. un borrador se descarta, y un descartado no vuelve a moverse;
--   7. la fecha contable de un documento de compra de un mes cerrado es hoy en Caracas;
--   8. aislamiento de los eventos como ladino_api, con un usuario de LOS DOS tenants.
-- =============================================================================

begin;
select plan(44);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0079-0000-4000-8000-0000000000a1'),   -- de A
  ('aaaa0079-0000-4000-8000-0000000000c1');   -- de A y de B
insert into public.tenants (id, name) values
  ('aaaa0079-0000-4000-8000-00000000000a', 'Tenant 79-A'),
  ('aaaa0079-0000-4000-8000-00000000000b', 'Tenant 79-B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0079-0000-4000-8000-0000000000a2', 'aaaa0079-0000-4000-8000-00000000000a',
        'J-79-A', 'Períodos 79 A', 'VES'),
       ('aaaa0079-0000-4000-8000-0000000000b2', 'aaaa0079-0000-4000-8000-00000000000b',
        'J-79-B', 'Períodos 79 B', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0079-0000-4000-8000-0000000000a3', 'aaaa0079-0000-4000-8000-00000000000a',
   'aaaa0079-0000-4000-8000-0000000000a1'),
  ('aaaa0079-0000-4000-8000-0000000000c3', 'aaaa0079-0000-4000-8000-00000000000a',
   'aaaa0079-0000-4000-8000-0000000000c1'),
  ('aaaa0079-0000-4000-8000-0000000000c4', 'aaaa0079-0000-4000-8000-00000000000b',
   'aaaa0079-0000-4000-8000-0000000000c1');

select is((select activity_start_date from public.companies
            where id = 'aaaa0079-0000-4000-8000-0000000000a2'),
          (now() at time zone 'America/Caracas')::date,
  'K-05: por omisión, el inicio de actividades es el día del alta EN CARACAS');
update public.companies set activity_start_date = '2025-01-01'
 where id = 'aaaa0079-0000-4000-8000-0000000000a2';

-- ── 1. La tabla ──────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.fiscal_period_events'::regclass),
  'fiscal_period_events: RLS habilitada y forzada');
select ok(exists (select 1 from pg_trigger t join pg_proc p on p.oid = t.tgfoid
                   where t.tgrelid = 'public.fiscal_period_events'::regclass
                     and p.proname = 'assert_isolation_anchors_immutable'),
  'fiscal_period_events lleva su ancla (test 006, sin excepciones)');

-- ── 2. El ciclo completo, n veces (K-01 + K-02) ─────────────────────────────
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0079-0000-4000-8000-0000000000d5', 'aaaa0079-0000-4000-8000-00000000000a',
   'aaaa0079-0000-4000-8000-0000000000a2', 2026, 5),
  ('aaaa0079-0000-4000-8000-0000000000e5', 'aaaa0079-0000-4000-8000-00000000000b',
   'aaaa0079-0000-4000-8000-0000000000b2', 2026, 5);

select lives_ok($$
  update public.fiscal_periods set status = 'closed', closed_at = now(),
         closed_by = 'aaaa0079-0000-4000-8000-0000000000a1'
   where id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'cerrar: vive');
-- EL CAMINO REAL de reopenFiscalPeriod: pone el estado y la reapertura y NO limpia
-- closed_at/closed_by. Con el CHECK viejo esto fallaba siempre (K-01).
select lives_ok($$
  update public.fiscal_periods set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0079-0000-4000-8000-0000000000a1',
         reopened_reason = 'Llegó una factura de mayo que faltaba'
   where id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'K-01: reabrir con motivo, dejando el último cierre en la fila: vive');
select lives_ok($$
  update public.fiscal_periods set status = 'closed', closed_at = now(),
         closed_by = 'aaaa0079-0000-4000-8000-0000000000a1'
   where id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'K-02: volver a cerrar un reabierto, con la reapertura anterior en la fila: vive');
select lives_ok($$
  update public.fiscal_periods set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0079-0000-4000-8000-0000000000a1',
         reopened_reason = 'Segunda reapertura: ajuste del contador'
   where id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'y reabrirlo otra vez: vive (n ciclos)');
select is((select count(*) from public.fiscal_period_events
            where period_id = 'aaaa0079-0000-4000-8000-0000000000d5'), 4::bigint,
  'cuatro cambios de estado, cuatro eventos');
select is((select array_agg(event_type order by occurred_at, id) from public.fiscal_period_events
            where period_id = 'aaaa0079-0000-4000-8000-0000000000d5'),
          array['closed', 'reopened', 'closed', 'reopened'],
  'la historia en su orden: cerrado, reabierto, cerrado, reabierto');
select is((select array_agg(reason order by id) from public.fiscal_period_events
            where period_id = 'aaaa0079-0000-4000-8000-0000000000d5'
              and event_type = 'reopened'),
          array['Llegó una factura de mayo que faltaba', 'Segunda reapertura: ajuste del contador'],
  'cada reapertura conserva SU motivo: la segunda no borró la primera');
select is((select status from public.fiscal_periods
            where id = 'aaaa0079-0000-4000-8000-0000000000d5'), 'reopened',
  'la fila guarda solo el estado actual');

-- Reapertura sin motivo suficiente.
update public.fiscal_periods set status = 'closed', closed_at = now(),
       closed_by = 'aaaa0079-0000-4000-8000-0000000000a1'
 where id = 'aaaa0079-0000-4000-8000-0000000000d5';
-- Se asevera el MENSAJE, no solo el código: el CHECK de la historia también daría 23514.
select throws_ok($$
  update public.fiscal_periods set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0079-0000-4000-8000-0000000000a1', reopened_reason = 'corto'
   where id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  '23514',
  'new row for relation "fiscal_periods" violates check constraint "fiscal_periods_reopened_chk"',
  'reabrir con «corto» como motivo se rechaza, y lo rechaza el CHECK de la fila');
select throws_ok($$
  insert into public.fiscal_period_events
    (tenant_id, company_id, period_id, event_type, reason, actor_id, occurred_at)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          'aaaa0079-0000-4000-8000-0000000000d5', 'reopened', 'corto',
          'aaaa0079-0000-4000-8000-0000000000a1', now()) $$,
  '23514', null, 'un evento de reapertura sin motivo tampoco entra');

-- Append-only.
select throws_ok($$ update public.fiscal_period_events set reason = 'reescrito, reescrito'
                     where period_id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'LAD06', null, 'la historia no se reescribe');
select throws_ok($$ delete from public.fiscal_period_events
                     where period_id = 'aaaa0079-0000-4000-8000-0000000000d5' $$,
  'LAD06', null, 'ni se borra');

-- ── 3. Aislamiento, con el usuario de los dos tenants ───────────────────────
update public.fiscal_periods set status = 'closed', closed_at = now(),
       closed_by = 'aaaa0079-0000-4000-8000-0000000000c1'
 where id = 'aaaa0079-0000-4000-8000-0000000000e5';
select set_config('ladino.actor_id', 'aaaa0079-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*) from public.fiscal_period_events
            where company_id = 'aaaa0079-0000-4000-8000-0000000000b2'), 0::bigint,
  'ladino_api con actor de A no ve los eventos de B');
select throws_ok($$
  insert into public.fiscal_period_events
    (tenant_id, company_id, period_id, event_type, actor_id, occurred_at)
  values ('aaaa0079-0000-4000-8000-00000000000b', 'aaaa0079-0000-4000-8000-0000000000b2',
          'aaaa0079-0000-4000-8000-0000000000e5', 'closed',
          'aaaa0079-0000-4000-8000-0000000000a1', now()) $$,
  '42501', null, 'ni inserta un evento en B');
select throws_ok($$ update public.fiscal_period_events set reason = 'SECUESTRADA SECUESTRADA'
                     where company_id = 'aaaa0079-0000-4000-8000-0000000000b2' $$,
  '42501', null, 'ladino_api no tiene UPDATE sobre la historia (capa 1)');
reset role;
select is((select reason from public.fiscal_period_events
            where company_id = 'aaaa0079-0000-4000-8000-0000000000b2'), null,
  'un UPDATE de A sobre un evento de B no cambia nada');
select set_config('ladino.actor_id', 'aaaa0079-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is((select count(*) from public.fiscal_period_events
            where company_id in ('aaaa0079-0000-4000-8000-0000000000a2',
                                 'aaaa0079-0000-4000-8000-0000000000b2')), 6::bigint,
  'el usuario de los dos tenants ve la historia de los dos (lo legítimo, ejercido)');
reset role;
select set_config('ladino.actor_id', '', true);

-- ── 4. K-05 · Límites de fecha ───────────────────────────────────────────────
select throws_ok($$ select platform.period_for_date('aaaa0079-0000-4000-8000-0000000000a2',
                                                     '2024-12-31') $$,
  'LAD91', null, 'una fecha anterior al inicio de actividades no crea período');
insert into public.fiscal_periods (tenant_id, company_id, year, month) values
  ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2', 2024, 6);
select throws_ok($$ select platform.period_for_date('aaaa0079-0000-4000-8000-0000000000a2',
                                                     '2024-06-15') $$,
  'LAD91', null, 'ni devuelve uno que ya existía antes del inicio (el agosto de E2)');
select throws_ok($$ select platform.period_for_date('aaaa0079-0000-4000-8000-0000000000a2',
  ((now() at time zone 'America/Caracas')::date + interval '2 months')::date) $$,
  'LAD91', null, 'ni un período futuro más allá del en curso');
select lives_ok($$ select platform.period_for_date('aaaa0079-0000-4000-8000-0000000000a2',
                     (now() at time zone 'America/Caracas')::date) $$,
  'hoy en Caracas sí');
select lives_ok($$ select platform.period_for_date('aaaa0079-0000-4000-8000-0000000000a2',
                     '2025-01-01') $$,
  'y el mismo día del inicio también: date contra date, sin medianoche de por medio');

insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0079-0000-4000-8000-0000000000d6', 'aaaa0079-0000-4000-8000-00000000000a',
   'aaaa0079-0000-4000-8000-0000000000a2', 2026, 6);

-- ── 5. Un asiento no se crea en un período cerrado (K-05) ───────────────────
insert into public.fiscal_periods (id, tenant_id, company_id, year, month, status, closed_at,
                                   closed_by) values
  ('aaaa0079-0000-4000-8000-0000000000dc', 'aaaa0079-0000-4000-8000-00000000000a',
   'aaaa0079-0000-4000-8000-0000000000a2', 2025, 12, 'closed', now(),
   'aaaa0079-0000-4000-8000-0000000000a1');
select is((select count(*) from public.fiscal_period_events
            where period_id = 'aaaa0079-0000-4000-8000-0000000000dc'), 1::bigint,
  'un período que NACE cerrado también deja su evento');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          'aaaa0079-0000-4000-8000-0000000000dc', '2025-12-10', 'manual', 'Borrador zombi') $$,
  'LAD61', null, 'un BORRADOR en un período cerrado no se crea (antes: 201 y zombi)');

-- ── 6. K-03 · El período de cierre ──────────────────────────────────────────
select lives_ok($$ select platform.closing_period_for_year(
                     'aaaa0079-0000-4000-8000-0000000000a2', 2025) $$,
  'el período de cierre de 2025 se crea aunque diciembre esté cerrado');
select is((select kind || '/' || month::text || '/' || status from public.fiscal_periods
            where company_id = 'aaaa0079-0000-4000-8000-0000000000a2'
              and year = 2025 and month = 13), 'closing/13/open',
  'es el «13»: mes 13, marcado de cierre, abierto');
select lives_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          platform.closing_period_for_year('aaaa0079-0000-4000-8000-0000000000a2', 2025),
          '2025-12-31', 'year_end_close', 'aaaa0079-0000-4000-8000-0000000000a2',
          'accounting.year_end_close.2025', 'Cierre del ejercicio 2025') $$,
  'el asiento de cierre entra en el 13 con diciembre cerrado');
select lives_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          platform.closing_period_for_year('aaaa0079-0000-4000-8000-0000000000a2', 2025),
          '2025-12-31', 'manual', 'Ajuste del contador') $$,
  'y un ajuste manual del contador también');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          platform.closing_period_for_year('aaaa0079-0000-4000-8000-0000000000a2', 2025),
          '2025-12-31', 'sales_invoice', 'aaaa0079-0000-4000-8000-0000000000f1',
          'sales.invoice_issued', 'Una venta') $$,
  'LAD92', null, 'una venta no entra en el período de cierre');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          platform.closing_period_for_year('aaaa0079-0000-4000-8000-0000000000a2', 2025),
          '2025-12-30', 'manual', 'Ajuste mal fechado') $$,
  'LAD92', null, 'ni un asiento del 13 con fecha distinta del 31-12');
select throws_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          'aaaa0079-0000-4000-8000-0000000000d6', '2026-06-30', 'year_end_close',
          'aaaa0079-0000-4000-8000-0000000000a2', 'accounting.year_end_close.2026',
          'Cierre en un mes') $$,
  'LAD92', null, 'y el asiento de cierre no va en un mes');
select throws_ok($$ select platform.closing_period_for_year(
                     'aaaa0079-0000-4000-8000-0000000000a2',
                     extract(year from now() at time zone 'America/Caracas')::int + 1) $$,
  'LAD91', null, 'el ejercicio que todavía no termina no tiene cierre');

-- ── 7. K-06 · Descartar un borrador ─────────────────────────────────────────
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description)
values ('aaaa0079-0000-4000-8000-0000000000f6', 'aaaa0079-0000-4000-8000-00000000000a',
        'aaaa0079-0000-4000-8000-0000000000a2', 'aaaa0079-0000-4000-8000-0000000000d6',
        '2026-06-20', 'manual', 'Borrador que se descarta');
select lives_ok($$ update public.journal_entries set status = 'discarded'
                    where id = 'aaaa0079-0000-4000-8000-0000000000f6' $$,
  'un borrador pasa a descartado');
select throws_ok($$ update public.journal_entries set status = 'draft'
                     where id = 'aaaa0079-0000-4000-8000-0000000000f6' $$,
  'LAD06', null, 'un descartado no vuelve a borrador');
-- A 'reversed' y no a 'posted': al postear dispara antes la partida doble (LAD59) y el
-- test mediría la falta de líneas, no la inmutabilidad del descartado.
select throws_ok($$ update public.journal_entries set status = 'reversed'
                     where id = 'aaaa0079-0000-4000-8000-0000000000f6' $$,
  'LAD06', null, 'ni pasa a ningún otro estado: un descartado está congelado');

-- ── 8. K-04 · La fecha contable de un documento de compra ───────────────────
select is(platform.accounting_date_for('aaaa0079-0000-4000-8000-0000000000a2', '2025-12-10'),
          (now() at time zone 'America/Caracas')::date,
  'K-04: una factura de un mes CERRADO se registra hoy (en Caracas)');
select is(platform.accounting_date_for('aaaa0079-0000-4000-8000-0000000000a2', '2024-12-10'),
          (now() at time zone 'America/Caracas')::date,
  'y una anterior al inicio de actividades, también');
select is(platform.accounting_date_for('aaaa0079-0000-4000-8000-0000000000a2', '2025-03-10'),
          '2025-03-10'::date,
  'una de un mes abierto, en su fecha');

-- ── 9. Variantes rotas: sin la defensa, el caso malo pasa ───────────────────
alter table public.fiscal_periods drop constraint fiscal_periods_reopened_chk;
select throws_ok($$
  update public.fiscal_periods set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0079-0000-4000-8000-0000000000a1', reopened_reason = 'corto'
   where id = 'aaaa0079-0000-4000-8000-0000000000e5' $$,
  '23514',
  'new row for relation "fiscal_period_events" violates check constraint "fiscal_period_events_reason_chk"',
  'ROTA 1: sin el CHECK de la fila, el motivo corto lo para el de la HISTORIA (segunda defensa)');
alter table public.fiscal_period_events drop constraint fiscal_period_events_reason_chk;
select lives_ok($$
  update public.fiscal_periods set status = 'reopened', reopened_at = now(),
         reopened_by = 'aaaa0079-0000-4000-8000-0000000000a1', reopened_reason = 'corto'
   where id = 'aaaa0079-0000-4000-8000-0000000000e5' $$,
  'ROTA 2: sin los dos CHECK, el motivo corto entra: los 23514 de arriba son de ellos');
drop trigger journal_entries_02a_period_admits on public.journal_entries;
select lives_ok($$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, description)
  values ('aaaa0079-0000-4000-8000-00000000000a', 'aaaa0079-0000-4000-8000-0000000000a2',
          'aaaa0079-0000-4000-8000-0000000000dc', '2025-12-10', 'manual', 'Borrador zombi') $$,
  'ROTA: sin el trigger de admisión, el borrador zombi entra: el LAD61 de arriba es suyo');

select * from finish();
rollback;
