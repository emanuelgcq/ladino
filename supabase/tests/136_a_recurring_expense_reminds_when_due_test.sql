-- =============================================================================
-- Ladino — pgTAP 136 · EL GASTO QUE SE REPITE AVISA CUANDO TOCA (H-07)
--
--   1. RLS habilitada y forzada en las dos tablas;
--   2. las ocurrencias: `date` contra `date`, siempre desde el ancla. FIN DE MES: un gasto del
--      31 toca el último día del mes corto y vuelve al 31; el 29 de febrero, el 28 en año no
--      bisiesto; la secuencia es estrictamente creciente para todo ancla de cuatro meses con bisiesto;
--   3. aislamiento como ladino_api en las cuatro operaciones, con un usuario de UN tenant y otro
--      de LOS DOS; el ancla; `next_due_on` no es escribible por la API;
--   4. los CHECK y el único del recordatorio vivo por categoría;
--   5. atender un período: solo el que toca, avanza `next_due_on`, y el segundo intento se
--      rechaza — con sus variantes rotas (sin el trigger lo caza el único; sin los dos, entra);
--   6. la guarda del recordatorio y el append-only de los períodos.
-- =============================================================================

begin;
select plan(48);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0136-0000-4000-8000-0000000000a1'),   -- de A
  ('aaaa0136-0000-4000-8000-0000000000c1');   -- de A y de B
insert into public.tenants (id, name) values
  ('aaaa0136-0000-4000-8000-00000000000a', 'Tenant 136-A'),
  ('aaaa0136-0000-4000-8000-00000000000b', 'Tenant 136-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0136-0000-4000-8000-0000000000a2', 'aaaa0136-0000-4000-8000-00000000000a',
   'J-136-A', 'Gastos 136 A'),
  ('aaaa0136-0000-4000-8000-0000000000b2', 'aaaa0136-0000-4000-8000-00000000000b',
   'J-136-B', 'Gastos 136 B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0136-0000-4000-8000-0000000000a3', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000a1'),
  ('aaaa0136-0000-4000-8000-0000000000c3', 'aaaa0136-0000-4000-8000-00000000000a',
   'aaaa0136-0000-4000-8000-0000000000c1'),
  ('aaaa0136-0000-4000-8000-0000000000c4', 'aaaa0136-0000-4000-8000-00000000000b',
   'aaaa0136-0000-4000-8000-0000000000c1');

select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000a1', true);
-- Datos hostiles: categoría con unicode de más de un byte; ancla el 31.
insert into public.recurring_expenses
  (id, tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
values ('aaaa0136-0000-4000-8000-0000000000d1', 'aaaa0136-0000-4000-8000-00000000000a',
        'aaaa0136-0000-4000-8000-0000000000a2', 'Alquiler del galpón — ñandú 木', 'monthly',
        date '2026-01-31', date '2026-01-31');
select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000c1', true);
insert into public.recurring_expenses
  (id, tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
values ('aaaa0136-0000-4000-8000-0000000000d2', 'aaaa0136-0000-4000-8000-00000000000b',
        'aaaa0136-0000-4000-8000-0000000000b2', 'Luz', 'weekly',
        date '2026-09-01', date '2026-09-01');

-- ── 1. RLS ───────────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.recurring_expenses'::regclass),
  'recurring_expenses: RLS habilitada y forzada');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.recurring_expense_periods'::regclass),
  'recurring_expense_periods: RLS habilitada y forzada');
select ok((select count(*) = 2 from pg_trigger t
            where t.tgrelid in ('public.recurring_expenses'::regclass,
                                'public.recurring_expense_periods'::regclass)
              and t.tgfoid = 'platform.assert_isolation_anchors_immutable()'::regprocedure),
  'las dos tablas llevan su trigger de ancla (test 006, sin excepciones)');

-- ── 2. Las ocurrencias ───────────────────────────────────────────────────────
select is(platform.recurring_due_after(date '2026-01-31', 'monthly', date '2026-01-31'),
  date '2026-02-28', 'mensual del 31: en febrero toca el 28 (último día del mes corto)');
select is(platform.recurring_due_after(date '2026-01-31', 'monthly', date '2026-02-28'),
  date '2026-03-31', '…y en marzo VUELVE al 31: se calcula desde el ancla, no desde el 28');
select is(platform.recurring_due_after(date '2026-01-31', 'monthly', date '2026-03-31'),
  date '2026-04-30', '…y en abril, el 30');
select is(platform.recurring_due_after(date '2027-12-31', 'monthly', date '2028-01-31'),
  date '2028-02-29', 'mensual del 31 en año bisiesto: 29 de febrero');
select is(platform.recurring_due_after(date '2028-02-29', 'yearly', date '2028-02-29'),
  date '2029-02-28', 'anual del 29 de febrero: el 28 en año no bisiesto');
select is(platform.recurring_due_after(date '2028-02-29', 'yearly', date '2031-03-01'),
  date '2032-02-29', '…y vuelve al 29 en el siguiente bisiesto');
select is(platform.recurring_due_after(date '2026-09-24', 'weekly', date '2026-09-24'),
  date '2026-10-01', 'semanal: siete días después');
select is(platform.recurring_due_after(date '2026-09-24', 'semimonthly', date '2026-09-24'),
  date '2026-10-09', 'quincenal: quince días después del ancla');
select is(platform.recurring_due_after(date '2026-09-24', 'semimonthly', date '2026-10-09'),
  date '2026-10-24', '…y luego el día del ancla del mes siguiente: dos veces al mes');
select is(platform.recurring_due_after(date '2026-01-31', 'semimonthly', date '2026-02-15'),
  date '2026-02-28', 'quincenal del 31: 15 de febrero y luego 28 de febrero');
select is(platform.recurring_due_after(date '2026-09-24', 'monthly', date '2026-09-01'),
  date '2026-09-24', 'antes del ancla, lo que toca es el ancla');
select is(platform.recurring_due_after(date '2026-09-24', 'monthly', date '2026-10-23'),
  date '2026-10-24', 'la víspera todavía no tocó: la ocurrencia es la de mañana');
select is(platform.recurring_due_after(date '2026-09-24', 'monthly', date '2026-10-24'),
  date '2026-11-24', 'ESTRICTAMENTE posterior: el mismo día ya no cuenta como «después»');
select is(platform.recurring_due_after(date '2026-09-24', 'cada_luna_llena', date '2026-10-24'),
  null, 'una periodicidad que no existe no inventa una fecha');
-- Un ancla de hace décadas no recorre su historia entera ni se pasa de la primera posterior.
select ok(platform.recurring_due_after(date '1970-01-01', 'weekly', date '2026-09-24')
            between date '2026-09-25' and date '2026-10-01',
  'ancla remota: la siguiente semanal cae dentro de los siete días siguientes');
select is((select count(*)
             from generate_series(date '2027-12-01', date '2028-03-31', interval '1 day') a(dia),
                  unnest(array['weekly', 'semimonthly', 'monthly', 'yearly']) p(per),
                  generate_series(0, 30) k
            where platform.recurring_occurrence(a.dia::date, p.per, k + 1)
                    <= platform.recurring_occurrence(a.dia::date, p.per, k)),
  0::bigint, 'para todo ancla de diciembre a marzo de un año bisiesto (todos los días del mes, y el 29 de febrero) y las cuatro periodicidades, la '
             'secuencia de ocurrencias es estrictamente creciente');
select is((select count(*)
             from generate_series(date '2027-12-01', date '2028-03-31', interval '1 day') a(dia),
                  unnest(array['weekly', 'semimonthly', 'monthly', 'yearly']) p(per),
                  generate_series(0, 30) k
            where platform.recurring_due_after(
                    a.dia::date, p.per, platform.recurring_occurrence(a.dia::date, p.per, k))
                  <> platform.recurring_occurrence(a.dia::date, p.per, k + 1)),
  0::bigint, '…y «la siguiente después de la ocurrencia k» es siempre la k+1: no salta ninguna');

-- ── 3. Aislamiento ───────────────────────────────────────────────────────────
select is((select created_by from public.recurring_expenses
            where id = 'aaaa0136-0000-4000-8000-0000000000d1'),
  'aaaa0136-0000-4000-8000-0000000000a1'::uuid, 'created_by sale del actor, no del cliente');

select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*) from public.recurring_expenses
            where id in ('aaaa0136-0000-4000-8000-0000000000d1',
                         'aaaa0136-0000-4000-8000-0000000000d2')),
  1::bigint, 'ladino_api con actor de A ve SOLO el recordatorio de A');
update public.recurring_expenses set description = 'SECUESTRADO'
 where id = 'aaaa0136-0000-4000-8000-0000000000d2';
select throws_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
     values ('aaaa0136-0000-4000-8000-00000000000b', 'aaaa0136-0000-4000-8000-0000000000b2',
             'Agua', 'monthly', date '2026-09-01', date '2026-09-01') $$,
  '42501', null, 'ladino_api con actor de A no crea un recordatorio en B: 42501');
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000b', 'aaaa0136-0000-4000-8000-0000000000b2',
             'aaaa0136-0000-4000-8000-0000000000d2', date '2026-09-01', 'skipped') $$,
  '42501', null, 'ladino_api con actor de A no atiende un período en B: 42501');
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d2', date '2026-09-01', 'skipped') $$,
  '23503', null, 'ni diciendo que es de A: el recordatorio de B no existe en la empresa de A');
select throws_ok($$ delete from public.recurring_expenses $$, '42501', null,
  'nadie borra un recordatorio: ladino_api no tiene DELETE');
select throws_ok(
  $$ update public.recurring_expenses set next_due_on = date '2030-01-31'
      where id = 'aaaa0136-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'la API no mueve el próximo día que toca: solo lo mueve un período atendido');
select throws_ok(
  $$ update public.recurring_expenses
        set tenant_id = 'aaaa0136-0000-4000-8000-00000000000b'
      where id = 'aaaa0136-0000-4000-8000-0000000000d1' $$,
  '42501', null, 'la API no puede ni nombrar tenant_id en un UPDATE');
reset role;
select is((select description from public.recurring_expenses
            where id = 'aaaa0136-0000-4000-8000-0000000000d2'),
  null, 'el UPDATE de A sobre el recordatorio de B no cambió NADA');
select is((select next_due_on from public.recurring_expenses
            where id = 'aaaa0136-0000-4000-8000-0000000000d2'),
  date '2026-09-01', '…y sus intentos de atenderle un período no movieron su próximo día');

select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is((select count(*) from public.recurring_expenses
            where id in ('aaaa0136-0000-4000-8000-0000000000d1',
                         'aaaa0136-0000-4000-8000-0000000000d2')),
  2::bigint, 'el usuario de los dos tenants ve los dos (legítimo)');
reset role;
-- El ancla, ejercida donde el privilegio no corta antes: ni el dueño de la tabla traslada.
select throws_ok(
  $$ update public.recurring_expenses
        set tenant_id = 'aaaa0136-0000-4000-8000-00000000000b',
            company_id = 'aaaa0136-0000-4000-8000-0000000000b2'
      where id = 'aaaa0136-0000-4000-8000-0000000000d1' $$,
  'LAD28', null, 'un recordatorio de A no se traslada a B (ancla)');

-- ── 4. Los CHECK y el único ──────────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0136-0000-4000-8000-0000000000a1', true);
select throws_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'Internet', 'monthly', date '2026-01-31', date '2026-02-27') $$,
  '23514', null, 'el próximo día que toca tiene que ser una ocurrencia del ancla');
select throws_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'Internet', 'cada_luna_llena', date '2026-01-31', date '2026-01-31') $$,
  '23514', null, 'la periodicidad sale de la lista cerrada');
select throws_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on,
        suggested_amount, currency)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'Internet', 'monthly', date '2026-01-31', date '2026-01-31', -5, 'VES') $$,
  '23514', null, 'el importe sugerido no es cero ni negativo');
select throws_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             '  ALQUILER DEL GALPÓN — ÑANDÚ 木 ', 'weekly', date '2026-09-01',
             date '2026-09-01') $$,
  '23505', null, 'un solo recordatorio VIVO por categoría, sin mirar mayúsculas ni bordes');
savepoint roto_categoria;
drop index public.recurring_expenses_active_category_key;
select lives_ok(
  $$ insert into public.recurring_expenses
       (tenant_id, company_id, category, periodicity, anchor_date, next_due_on)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             '  ALQUILER DEL GALPÓN — ÑANDÚ 木 ', 'weekly', date '2026-09-01',
             date '2026-09-01') $$,
  'ROTO: sin el único, el segundo recordatorio de lo mismo entra');
rollback to savepoint roto_categoria;

-- ── 5. Atender un período ────────────────────────────────────────────────────
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-02-28', 'skipped') $$,
  '55000', null, 'un período que todavía no es el que toca no se atiende');
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-01-31', 'registered') $$,
  '23514', null, '«registrado» sin su gasto ni su factura no existe');
set local role ladino_api;
select lives_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-01-31', 'skipped') $$,
  'como ladino_api, el período que toca se atiende de verdad (no solo en el catálogo)');
reset role;
select is((select next_due_on from public.recurring_expenses
            where id = 'aaaa0136-0000-4000-8000-0000000000d1'),
  date '2026-02-28', 'atenderlo AVANZA el próximo día que toca (31 de enero → 28 de febrero)');
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-01-31', 'skipped') $$,
  '55000', null, 'el segundo clic sobre el mismo período se rechaza: ya no es el que toca');
savepoint roto_trigger;
alter table public.recurring_expense_periods disable trigger recurring_expense_periods_02_attend;
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-01-31', 'skipped') $$,
  '23505', null, 'ROTO a medias: sin el trigger, el segundo lo caza la clave natural');
alter table public.recurring_expense_periods drop constraint recurring_expense_periods_key;
select lives_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-01-31', 'skipped') $$,
  'ROTO del todo: sin trigger ni clave, el período doble entra — las dos de arriba miden eso');
rollback to savepoint roto_trigger;

-- ── 6. La guarda y el append-only ────────────────────────────────────────────
select throws_ok(
  $$ update public.recurring_expense_periods set outcome = 'registered' $$,
  'LAD06', null, 'un período atendido no se reescribe (append-only)');
select throws_ok(
  $$ delete from public.recurring_expense_periods $$,
  'LAD06', null, 'ni se borra');
select throws_ok(
  $$ update public.recurring_expenses set periodicity = 'weekly'
      where id = 'aaaa0136-0000-4000-8000-0000000000d1' $$,
  '55000', null, 'la periodicidad de un recordatorio no cambia: se deja de pagar y se crea otro');
update public.recurring_expenses set status = 'stopped', stopped_at = now()
 where id = 'aaaa0136-0000-4000-8000-0000000000d1';
select throws_ok(
  $$ insert into public.recurring_expense_periods
       (tenant_id, company_id, recurring_expense_id, due_on, outcome)
     values ('aaaa0136-0000-4000-8000-00000000000a', 'aaaa0136-0000-4000-8000-0000000000a2',
             'aaaa0136-0000-4000-8000-0000000000d1', date '2026-02-28', 'skipped') $$,
  '55000', null, 'a un recordatorio que ya no se paga no se le atienden períodos');

select * from finish();
rollback;
