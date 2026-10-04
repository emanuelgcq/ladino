-- =============================================================================
-- 128 · El sobregiro que se cubre al cerrar la caja se le debe al dueño
--       (J-02, migraciones 20261004180000 a 20261004180300)
-- =============================================================================
-- Lo que prueba (propiedades duraderas del esquema final, no estados intermedios):
--   a. el papel `owner_payable` existe y es una cuenta configurada (no la caja del hecho);
--   b. el plan ve_basico lo trae como PASIVO de naturaleza acreedora, hoja, bajo 2.1;
--   c. el preset ve_basico tiene el hecho `cash_closing_overdraft` (un ORIGEN propio con el evento
--      real del outbox, `treasury.cash_register.closed`; 20261004180200) con sus tres
--      líneas exactas: la caja al debe por el total; al haber, lo del dueño y, solo si lo hay, el
--      sobrante. NINGUNA línea del sobregiro abona otra cosa, y ninguna es incondicional
--      (20261004180100: el invariante de pgTAP 031 §6 vale para toda la familia del cierre);
--   d. la plantilla de siempre (`treasury.cash_register.closed`) sigue como estaba: sus cuatro
--      líneas con `functional_amount` y el signo eligiendo el lado;
--   e. el vocabulario de importes NO perdió nada al reconstruir el CHECK: los catorce de antes y
--      el nuevo entran, ejerciendo el INSERT (no preguntando al catálogo);
--   f. un importe inventado se rechaza (23514) en las DOS tablas de líneas, y `owner_contribution`
--      entra también en la plantilla de una empresa;
--   h. el origen `cash_closing_overdraft`: la cobertura, la caja del hecho, su importe original y
--      la cola lo cuentan como al cierre de siempre, y un origen desconocido no resuelve nada;
--   i. el invariante `platform.overdraft_closing_gaps` (20261004180300): acusa el cierre en
--      negativo que espera en la cola con el origen de siempre, calla cuando la fila se descarta
--      y no confunde −0,004 con un sobregiro;
--   j. los bordes del céntimo: −0,005 (redondea a −0,01) y −0,01 son sobregiro;
--   k. una caja de OTRA escala (el esquema admite de 0 a 8 decimales): «negativo» se mide en la
--      escala de la moneda de la caja, con su variante rota (la misma cifra a 2 decimales);
--   l. la rama `posted_as_surplus` con un asiento de verdad: en borrador no acusa, posteado sí;
--   g. la variante rota: sin el CHECK, el importe inventado entra. Si no entrara, el 23514 de (f)
--      lo estaría produciendo otra cosa.
-- Aislamiento: la migración no crea tablas. Las plantillas y cuentas que añade a cada empresa
-- viven en tablas cuyo aislamiento prueban 025/026 (plantillas) y 024 (plan de cuentas).
-- El asiento en sí (qué cuenta abona un cierre en sobregiro, con y sin sobrante, y los cuatro
-- invariantes en cero) lo ejerce apps/api/test/e2e-cierre-en-sobregiro-y-mayor.test.ts.
-- =============================================================================
begin;
select plan(40);

-- a. El papel.
select is(
  (select resolved_by from public.account_purposes where code = 'owner_payable'),
  'company_setting',
  'a. el papel owner_payable existe y se resuelve con una cuenta configurada');

-- b. La cuenta del plan.
select results_eq($$
  select code, parent_code, kind, nature, is_leaf
    from public.chart_template_accounts
   where template_code = 've_basico' and suggested_purpose = 'owner_payable'
$$, $$ values ('2.1.92'::text, '2.1'::text, 'pasivo'::text, 'acreedora'::text, true) $$,
  'b. ve_basico trae la cuenta por pagar a socios: pasivo, acreedora, hoja de 2.1');

select is(
  (select kind from public.chart_template_accounts
    where template_code = 've_basico' and code = '2.1'),
  'pasivo',
  'b. y su cuenta madre 2.1 existe en el plan y es pasivo');

-- c. El hecho nuevo, línea por línea.
select results_eq($$
  select l.line_number::int, l.account_purpose, l.amount_source, l.side, l.condition_kind
    from public.journal_template_preset_lines l
    join public.journal_template_preset_entries e on e.id = l.entry_id
   where e.preset_code = 've_basico' and e.source_kind = 'cash_closing_overdraft'
     and e.source_event = 'treasury.cash_register.closed'
   order by l.line_number
$$, $$ values
  (1, 'treasury_account'::text, 'total'::text,              'debit'::text,  'if_positive'::text),
  (2, 'owner_payable'::text,    'owner_contribution'::text, 'credit'::text, 'if_positive'::text),
  (3, 'cash_over_short'::text,  'functional_amount'::text,  'credit'::text, 'if_positive'::text)
$$, 'c. el cierre en sobregiro: caja al debe; al haber, el dueño y (si lo hay) el sobrante');

-- d. La plantilla de siempre no cambió.
select results_eq($$
  select l.line_number::int, l.account_purpose, l.amount_source, l.side, l.condition_kind
    from public.journal_template_preset_lines l
    join public.journal_template_preset_entries e on e.id = l.entry_id
   where e.preset_code = 've_basico' and e.source_kind = 'cash_closing'
   order by l.line_number
$$, $$ values
  (1, 'treasury_account'::text, 'functional_amount'::text, 'debit'::text,  'if_positive'::text),
  (2, 'cash_over_short'::text,  'functional_amount'::text, 'credit'::text, 'if_positive'::text),
  (3, 'cash_over_short'::text,  'functional_amount'::text, 'debit'::text,  'if_negative'::text),
  (4, 'treasury_account'::text, 'functional_amount'::text, 'credit'::text, 'if_negative'::text)
$$, 'd. sobrante y faltante sin sobregiro se asientan con la plantilla de siempre');

-- e. El vocabulario entero, EJERCIDO sobre el preset.
insert into public.journal_template_preset_entries (id, preset_code, source_kind, source_event,
                                                    description)
values ('aaaa0128-0000-4000-8000-0000000000e1', 've_basico', 'cash_closing',
        'test.vocabulario_128', 'Hecho de prueba 128: el vocabulario de importes');

select lives_ok(format($f$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values ('aaaa0128-0000-4000-8000-0000000000e1', %s, 'cash_over_short', %L, 'debit', 'always',
          'línea de prueba 128')
$f$, v.n, v.fuente), format('e. el importe «%s» sigue en el vocabulario', v.fuente))
  from unnest(array[
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr', 'retained_total',
    'net_amount', 'cost_amount', 'landed_to_inventory', 'landed_to_variance',
    'exchange_difference', 'functional_amount', 'revaluation_to_inventory',
    'revaluation_to_variance', 'owner_contribution']) with ordinality as v(fuente, n);

-- f. Lo inventado no entra, en ninguna de las dos tablas.
select throws_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values ('aaaa0128-0000-4000-8000-0000000000e1', 90, 'cash_over_short', 'importe_inventado',
          'debit', 'always', 'línea de prueba 128')
$$, '23514', null, 'f. el preset rechaza un importe que no está en el vocabulario');

insert into auth.users (id) values ('aaaa0128-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0128-0000-4000-8000-00000000000a', 'Tenant 128 A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-00000000000a',
   'J128000001', 'Bodega 128');
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0128-0000-4000-8000-0000000000a1', true);
insert into public.journal_templates (id, tenant_id, company_id, source_kind, source_event,
                                      description, effective_from)
values ('aaaa0128-0000-4000-8000-0000000000b1', 'aaaa0128-0000-4000-8000-00000000000a',
        'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing_overdraft',
        'treasury.cash_register.closed', 'Plantilla de prueba 128', '-infinity');

select lives_ok($$
  insert into public.journal_template_lines
    (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side,
     condition_kind, description)
  values ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
          'aaaa0128-0000-4000-8000-0000000000b1', 1, 'owner_payable', 'owner_contribution',
          'credit', 'always', 'línea de prueba 128')
$$, 'f. la plantilla de una empresa admite owner_contribution contra owner_payable');

select throws_ok($$
  insert into public.journal_template_lines
    (tenant_id, company_id, template_id, line_number, account_purpose, amount_source, side,
     condition_kind, description)
  values ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
          'aaaa0128-0000-4000-8000-0000000000b1', 2, 'owner_payable', 'importe_inventado',
          'credit', 'always', 'línea de prueba 128')
$$, '23514', null, 'f. la plantilla de una empresa rechaza un importe inventado');

-- h. El ORIGEN nuevo (20261004180200): mismo registro, mismo evento, otro hecho contable.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0128-0000-4000-8000-0000000000c1', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'Caja Bs 128', 'VES', 'cash');
insert into public.cash_closings
  (id, tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
   counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, reason) values
  ('aaaa0128-0000-4000-8000-0000000000f1', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c1',
   '2026-08-05', '2026-08-05T22:00:00Z', -100, 0, 100, 'VES', 1, 100, 'VES',
   'el pago del café salió de mi bolsillo');

select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0128-0000-4000-8000-0000000000a2')
    where source_id = 'aaaa0128-0000-4000-8000-0000000000f1' and problem = 'missing'),
  1::bigint, 'h. un cierre en sobregiro sin asiento ni cola es un hueco, como cualquier cierre');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
   'cash_closing_overdraft', 'aaaa0128-0000-4000-8000-0000000000f1',
   'treasury.cash_register.closed',
   '{"total": "100", "owner_contribution": "100", "functional_amount": "0"}',
   'sin cuenta con papel owner_payable');
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0128-0000-4000-8000-0000000000a2')),
  0::bigint,
  'h. encolado con el origen nuevo, el hueco se cierra: la cobertura mira el cierre, no el origen');
select is(
  platform.treasury_account_of('aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing_overdraft',
                               'aaaa0128-0000-4000-8000-0000000000f1'),
  'aaaa0128-0000-4000-8000-0000000000c1'::uuid,
  'h. la caja del hecho se resuelve también para el origen nuevo');
select is(
  (select amount from platform.treasury_original_of(
     'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing_overdraft',
     'aaaa0128-0000-4000-8000-0000000000f1')),
  100::numeric, 'h. y su importe original, en la moneda de la caja');
select is(
  platform.treasury_queue_pending('aaaa0128-0000-4000-8000-0000000000a2',
                                  'aaaa0128-0000-4000-8000-0000000000c1'),
  100::numeric,
  'h. un cierre en sobregiro que espera en la cola cuenta en la igualdad caja = mayor + cola');
-- Variante rota: un origen que nadie conoce no resuelve caja. Si la resolviera, lo de arriba
-- lo estaría produciendo el id y no el origen.
select is(
  platform.treasury_account_of('aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing_inventado',
                               'aaaa0128-0000-4000-8000-0000000000f1'),
  null::uuid, 'h. un origen desconocido no resuelve ninguna caja');
select throws_ok($$
  insert into public.journal_templates (tenant_id, company_id, source_kind, source_event,
                                        description, effective_from)
  values ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
          'cash_closing_inventado', 'treasury.cash_register.closed', 'Plantilla inventada 128',
          '-infinity')
$$, '23514', null, 'h. y el vocabulario de orígenes sigue cerrado');

-- i. EL INVARIANTE (20261004180300): un cierre con lo esperado en negativo no tiene vigente el
--    origen cash_closing, ni asentado ni en la cola. La rama del asiento POSTEADO la ejerce, con
--    asientos de verdad, apps/api/test/e2e-reparacion-sobregiro-al-cierre.test.ts.
select is(
  (select count(*) from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')),
  0::bigint, 'i. encolado con el origen del sobregiro, el cierre en negativo no es un hueco');
-- La API anterior lo habría encolado así. ESTA es la variante que tiene que acusar: si diera
-- cero, el cero de arriba no estaría midiendo el origen.
insert into public.journal_generation_queue
  (id, tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0128-0000-4000-8000-0000000000d1', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing',
   'aaaa0128-0000-4000-8000-0000000000f1', 'treasury.cash_register.closed',
   '{"functional_amount": "100"}', 'encolado por la API anterior');
select results_eq($$
  select cash_closing_id, problem, reference_id
    from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')
$$, $$ values ('aaaa0128-0000-4000-8000-0000000000f1'::uuid, 'queued_as_surplus'::text,
               'aaaa0128-0000-4000-8000-0000000000d1'::uuid) $$,
  'i. el mismo cierre, en la cola con el origen de siempre: el invariante lo acusa y dice cuál');
update public.journal_generation_queue set status = 'discarded', processed_at = now()
 where id = 'aaaa0128-0000-4000-8000-0000000000d1';
select is(
  (select count(*) from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')),
  0::bigint, 'i. descartada la fila vieja (lo que hace la reparación), vuelve a cero');
-- «En negativo» es menor que cero EN CÉNTIMOS: −0,004 no es un sobregiro, y su sobrante de
-- siempre no es un hueco (el mismo borde que decide hechoContableDelCierre).
insert into public.cash_closings
  (id, tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
   counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, reason) values
  ('aaaa0128-0000-4000-8000-0000000000f2', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c1',
   '2026-08-06', '2026-08-06T22:00:00Z', -0.004, 15, 15.004, 'VES', 1, 15.004, 'VES',
   'sobraron quince');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
   'cash_closing', 'aaaa0128-0000-4000-8000-0000000000f2', 'treasury.cash_register.closed',
   '{"functional_amount": "15.004"}', 'sin cuenta con papel cash_over_short');
select is(
  (select count(*) from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')),
  0::bigint, 'i. un saldo de −0,004 no es un sobregiro: su sobrante de siempre no es un hueco');

-- j. LOS BORDES DEL CÉNTIMO (revisión en contexto limpio). −0,005 redondea a −0,01 (half-up, lejos
--    del cero: lo mismo que decide hechoContableDelCierre) y −0,01 es el primer sobregiro.
insert into public.cash_closings
  (id, tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
   counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, reason) values
  ('aaaa0128-0000-4000-8000-0000000000f3', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c1',
   '2026-08-07', '2026-08-07T22:00:00Z', -0.005, 0, 0.005, 'VES', 1, 0.01, 'VES', 'medio céntimo'),
  ('aaaa0128-0000-4000-8000-0000000000f4', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c1',
   '2026-08-08', '2026-08-08T22:00:00Z', -0.01, 0, 0.01, 'VES', 1, 0.01, 'VES', 'un céntimo');
insert into public.journal_generation_queue
  (id, tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0128-0000-4000-8000-0000000000d3', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing',
   'aaaa0128-0000-4000-8000-0000000000f3', 'treasury.cash_register.closed',
   '{"functional_amount": "0.01"}', 'encolado por la API anterior'),
  ('aaaa0128-0000-4000-8000-0000000000d4', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing',
   'aaaa0128-0000-4000-8000-0000000000f4', 'treasury.cash_register.closed',
   '{"functional_amount": "0.01"}', 'encolado por la API anterior');
select results_eq($$
  select cash_closing_id, problem
    from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')
   order by closing_date
$$, $$ values ('aaaa0128-0000-4000-8000-0000000000f3'::uuid, 'queued_as_surplus'::text),
              ('aaaa0128-0000-4000-8000-0000000000f4'::uuid, 'queued_as_surplus'::text) $$,
  'j. los bordes: −0,005 (redondea a −0,01) y −0,01 SÍ son sobregiro; −0,004 sigue sin serlo');
update public.journal_generation_queue set status = 'discarded', processed_at = now()
 where id in ('aaaa0128-0000-4000-8000-0000000000d3', 'aaaa0128-0000-4000-8000-0000000000d4');

-- k. UNA CAJA CON OTRA ESCALA. El esquema la admite (currencies.display_decimals, de 0 a 8); el
--    catálogo de hoy solo trae VES y USD, las dos a 2. Con una moneda sin decimales, «en negativo»
--    se mide en unidades enteras: −0,4 no es un sobregiro y −0,5 (que redondea a −1) sí.
insert into public.currencies (code, name, symbol, display_decimals)
values ('XTS', 'Moneda de prueba 128 sin decimales', 'X', 0);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0128-0000-4000-8000-0000000000c2', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'Caja XTS 128', 'XTS', 'cash');
insert into public.cash_closings
  (id, tenant_id, company_id, account_id, closing_date, closed_at, expected_amount,
   counted_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, reason) values
  ('aaaa0128-0000-4000-8000-0000000000f5', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c2',
   '2026-08-09', '2026-08-09T22:00:00Z', -0.4, 3, 3.4, 'XTS', 1, 3.4, 'VES', 'escala cero, −0,4'),
  ('aaaa0128-0000-4000-8000-0000000000f6', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'aaaa0128-0000-4000-8000-0000000000c2',
   '2026-08-10', '2026-08-10T22:00:00Z', -0.5, 3, 3.5, 'XTS', 1, 3.5, 'VES', 'escala cero, −0,5');
insert into public.journal_generation_queue
  (id, tenant_id, company_id, source_kind, source_id, source_event, context, reason) values
  ('aaaa0128-0000-4000-8000-0000000000d5', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing',
   'aaaa0128-0000-4000-8000-0000000000f5', 'treasury.cash_register.closed',
   '{"functional_amount": "3.40"}', 'encolado por la API anterior'),
  ('aaaa0128-0000-4000-8000-0000000000d6', 'aaaa0128-0000-4000-8000-00000000000a',
   'aaaa0128-0000-4000-8000-0000000000a2', 'cash_closing',
   'aaaa0128-0000-4000-8000-0000000000f6', 'treasury.cash_register.closed',
   '{"functional_amount": "3.50"}', 'encolado por la API anterior');
select results_eq($$
  select cash_closing_id, reference_id
    from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')
$$, $$ values ('aaaa0128-0000-4000-8000-0000000000f6'::uuid,
               'aaaa0128-0000-4000-8000-0000000000d6'::uuid) $$,
  'k. en una caja de escala 0, −0,4 no es sobregiro y −0,5 sí: «negativo» se mide en la escala de la caja');
-- Variante rota: la MISMA cifra, −0,4, en una caja de escala 2 sí es un sobregiro. Si no lo
-- acusara, el cero de −0,4 de arriba no lo estaría produciendo la escala de la moneda.
update public.currencies set display_decimals = 2 where code = 'XTS';
select is(
  (select count(*) from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')
    where cash_closing_id = 'aaaa0128-0000-4000-8000-0000000000f5'),
  1::bigint, 'k. variante rota: con la moneda a 2 decimales, el mismo −0,4 pasa a ser sobregiro');
update public.journal_generation_queue set status = 'discarded', processed_at = now()
 where id in ('aaaa0128-0000-4000-8000-0000000000d5', 'aaaa0128-0000-4000-8000-0000000000d6');

-- l. LA RAMA `posted_as_surplus`, con un asiento de verdad. El cierre f1 (−100) recibe un asiento
--    del origen de siempre: en BORRADOR no es un hueco (no está vigente); POSTEADO, sí.
insert into public.accounts (id, tenant_id, company_id, code, name, parent_id, kind, nature)
values ('aaaa0128-0000-4000-8000-000000001001', 'aaaa0128-0000-4000-8000-00000000000a',
        'aaaa0128-0000-4000-8000-0000000000a2', '1', 'Caja 128', null, 'activo', 'deudora'),
       ('aaaa0128-0000-4000-8000-000000004001', 'aaaa0128-0000-4000-8000-00000000000a',
        'aaaa0128-0000-4000-8000-0000000000a2', '4', 'Faltantes y sobrantes 128', null,
        'ingreso', 'acreedora');
select set_config('ladino.rules_version', 'domain-s0.5', true);
insert into public.journal_entries (id, tenant_id, company_id, period_id, posting_date, source_kind,
                                    source_id, source_event, description, rules_version)
values ('aaaa0128-0000-4000-8000-0000000e0001', 'aaaa0128-0000-4000-8000-00000000000a',
        'aaaa0128-0000-4000-8000-0000000000a2',
        platform.period_for_date('aaaa0128-0000-4000-8000-0000000000a2',
                                 (now() at time zone 'America/Caracas')::date),
        (now() at time zone 'America/Caracas')::date, 'cash_closing',
        'aaaa0128-0000-4000-8000-0000000000f1', 'treasury.cash_register.closed',
        'Cierre de caja 128: sobrante (API anterior)', 'domain-s0.5');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, functional_debit, functional_credit)
values ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
        'aaaa0128-0000-4000-8000-0000000e0001', 1, 'aaaa0128-0000-4000-8000-000000001001',
        100, 0, 100, 'VES', 1, 100, 'VES', 100, 0),
       ('aaaa0128-0000-4000-8000-00000000000a', 'aaaa0128-0000-4000-8000-0000000000a2',
        'aaaa0128-0000-4000-8000-0000000e0001', 2, 'aaaa0128-0000-4000-8000-000000004001',
        0, 100, 100, 'VES', 1, 100, 'VES', 0, 100);
select is(
  (select count(*) from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')),
  0::bigint,
  'l. variante que NO debe acusar: el asiento del origen de siempre en borrador no está vigente');
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = '00000000-0000-0000-0000-000000000000',
       entry_number = platform.claim_entry_number(company_id, extract(year from posting_date)::int)
 where id = 'aaaa0128-0000-4000-8000-0000000e0001';
select results_eq($$
  select cash_closing_id, problem, reference_id
    from platform.overdraft_closing_gaps('aaaa0128-0000-4000-8000-0000000000a2')
$$, $$ values ('aaaa0128-0000-4000-8000-0000000000f1'::uuid, 'posted_as_surplus'::text,
               'aaaa0128-0000-4000-8000-0000000e0001'::uuid) $$,
  'l. posteado, el cierre en sobregiro asentado como sobrante es un hueco, y dice qué asiento');

-- g. Variante rota: sin el CHECK, lo inventado entra.
alter table public.journal_template_preset_lines
  drop constraint journal_template_preset_lines_amount_chk;
select lives_ok($$
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values ('aaaa0128-0000-4000-8000-0000000000e1', 90, 'cash_over_short', 'importe_inventado',
          'debit', 'always', 'línea de prueba 128')
$$, 'g. sin el CHECK entra: el 23514 de (f) lo produce el vocabulario cerrado y nada más');

select * from finish();
rollback;
