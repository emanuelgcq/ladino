-- =============================================================================
-- pgTAP 103b · EL FALTANTE DE UN CONTEO LLEVA SU EVIDENCIA (20261003110200, ADR-0078 re-revisión B1)
--
--   · la evidencia cabe en un ajuste que BAJA existencia, y en ningún otro movimiento sin motivo de
--     pérdida (el hueco del CHECK de 110100: con exit_reason nulo dejaba pasar cualquiera);
--   · ningún hecho `inventory_move/stock.counted` —fila de la cola o asiento— nace para un
--     movimiento que baja existencia sin evidencia; el sobrante y el ajuste suelto no la piden;
--   · el corte está en el enunciado (`platform.invariant_cutoffs`): lo anterior no se exige;
--   · VARIANTE ROTA: sin el trigger, el hecho sin evidencia entra (la aserción mide el trigger).
--   · B2: `withdrawal_note_gaps` da CERO llamada como `authenticated` por un miembro de la empresa
--     en el estado correcto (ejercida, no preguntada al catálogo).
-- =============================================================================
begin;
select plan(13);

insert into auth.users (id) values ('aaaa103b-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa103b-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'pgtap-103b', true);
insert into public.tenants (id, name) values ('aaaa103b-0000-4000-8000-00000000000a', 'Tenant 103b');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa103b-0000-4000-8000-0000000000a1', 'aaaa103b-0000-4000-8000-00000000000a',
        'J-103B-A', 'Bodega 103b', 'VES', 'ordinario');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000000a1',
        'formatos_libres', '2026-01-01');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa103b-0000-4000-8000-0000000000b1', 'aaaa103b-0000-4000-8000-00000000000a',
   'aaaa103b-0000-4000-8000-0000000000a1', 'W103B', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa103b-0000-4000-8000-00000000d001', 'aaaa103b-0000-4000-8000-00000000000a',
   'aaaa103b-0000-4000-8000-0000000000a1', 'SKU-103B', 'Harina 103b', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.fiscal_periods (tenant_id, company_id, year, month)
select 'aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000000a1',
       extract(year from current_date)::int, extract(month from current_date)::int
 where not exists (select 1 from public.fiscal_periods
                    where company_id = 'aaaa103b-0000-4000-8000-0000000000a1');

create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_reason text, p_evidence text)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, reason, exit_evidence)
  values (p_id, 'aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000000a1',
          'aaaa103b-0000-4000-8000-0000000000b1', 'aaaa103b-0000-4000-8000-00000000d001', null,
          p_kind, p_q, p_val, 'VES', 1, p_val, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', 10, p_q_after, p_v_after, now(), p_reason, p_evidence);
$$;
create function pg_temp.encolar(p_move uuid, p_event text) returns void language sql as $$
  insert into public.journal_generation_queue
    (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
  values ('aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000000a1',
          'inventory_move', p_move, p_event, '{}'::jsonb, 'pgTAP 103b: sin plantilla');
$$;

select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e001', 'entrada', 10, 100, 10, 100, null, null);
select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e002', 'ajuste', -1, -10, 9, 90,
                     'Conteo: contado 9, sistema 10 · sin soporte', null);

-- ── 1. El CHECK de la evidencia ─────────────────────────────────────────────
select lives_ok(
  $$ select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e003', 'ajuste', -1, -10, 8, 80,
                          'Conteo: contado 8, sistema 9 · fin de mes', 'acta de conteo 0042') $$,
  'un ajuste que baja existencia admite su evidencia');
select throws_ok(
  $$ select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e0f1', 'ajuste', 1, 10, 9, 90,
                          'Conteo: sobró uno', 'acta que no aplica') $$,
  '23514', null, 'un sobrante no lleva evidencia de pérdida');
select throws_ok(
  $$ select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e0f2', 'entrada', 1, 10, 9, 90,
                          null, 'evidencia en una entrada') $$,
  '23514', null,
  'una entrada (exit_reason nulo) no admite evidencia: el NULL del CHECK de 110100 la dejaba pasar');
select pg_temp.mover('aaaa103b-0000-4000-8000-00000000e004', 'ajuste', 1, 10, 9, 90,
                     'Conteo: contado 9, sistema 8 · apareció', null);

-- ── 2. La regla en la cola ──────────────────────────────────────────────────
select throws_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e002', 'stock.counted') $$,
  '23514', null, 'el hecho de conteo de un faltante SIN evidencia no entra a la cola');
select lives_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e003', 'stock.counted') $$,
  'con evidencia, el hecho de conteo del faltante entra');
select lives_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e004', 'stock.counted') $$,
  'el sobrante de un conteo no pide evidencia');
select lives_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e002', 'stock.adjusted') $$,
  'el ajuste suelto (stock.adjusted, a 5.1.04) no es un conteo: la regla no lo alcanza');

-- ── 3. La regla en el asiento ───────────────────────────────────────────────
create function pg_temp.asentar(p_move uuid) returns void language sql as $$
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version)
  select 'aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000000a1', p.id,
         current_date, 'inventory_move', p_move, 'stock.counted', 'Conteo 103b', 'pgtap-103b'
    from public.fiscal_periods p
   where p.company_id = 'aaaa103b-0000-4000-8000-0000000000a1' limit 1;
$$;
select throws_ok(
  $$ select pg_temp.asentar('aaaa103b-0000-4000-8000-00000000e002') $$,
  '23514', null, 'el asiento de conteo de un faltante SIN evidencia no nace');
select lives_ok(
  $$ select pg_temp.asentar('aaaa103b-0000-4000-8000-00000000e003') $$,
  'con evidencia, el asiento de conteo nace');

-- ── 4. El corte está en el enunciado ────────────────────────────────────────
update platform.invariant_cutoffs set since = now() + interval '1 day'
 where invariant = 'count_shortage_evidence';
select lives_ok(
  $$ select pg_temp.asentar('aaaa103b-0000-4000-8000-00000000e002') $$,
  'un faltante anterior al corte no se exige: su asiento (o su reversa) se puede escribir');
update platform.invariant_cutoffs set since = now() - interval '1 day'
 where invariant = 'count_shortage_evidence';
select throws_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e002', 'stock.counted') $$,
  '23514', null, 'con el corte atrás, la regla vuelve a rechazar (mide el corte, no el azar)');

-- ── 5. VARIANTE ROTA ────────────────────────────────────────────────────────
alter table public.journal_generation_queue
  disable trigger journal_generation_queue_02_count_evidence;
select lives_ok(
  $$ select pg_temp.encolar('aaaa103b-0000-4000-8000-00000000e002', 'stock.counted') $$,
  'VARIANTE ROTA: sin el trigger, el faltante sin evidencia entra (la aserción mide el trigger)');
alter table public.journal_generation_queue
  enable trigger journal_generation_queue_02_count_evidence;

-- ── 6. B2: withdrawal_note_gaps, EJERCIDA como authenticated ────────────────
-- Las tablas que lee (notas, asientos, líneas, cola, papeles de cuenta) comparten policy de
-- lectura por empresa: quien ve la nota ve su asiento. Un miembro sin permisos contables obtiene
-- el mismo cero que el servidor.
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa103b-0000-4000-8000-0000000001aa', 'aaaa103b-0000-4000-8000-00000000000a',
   'aaaa103b-0000-4000-8000-0000000000aa');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa103b-0000-4000-8000-00000000000a', 'aaaa103b-0000-4000-8000-0000000001aa', r.id,
       'aaaa103b-0000-4000-8000-0000000000a1'
  from public.roles r where r.key = 'cashier' and r.tenant_id is null;
select set_config('request.jwt.claims',
  '{"sub":"aaaa103b-0000-4000-8000-0000000000aa","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*)::int from platform.withdrawal_note_gaps(
             'aaaa103b-0000-4000-8000-0000000000a1')),
  0, 'B2: como authenticated (cajero, sin accounting.read) withdrawal_note_gaps responde cero');
reset role;

select * from finish();
rollback;
