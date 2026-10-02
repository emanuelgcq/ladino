-- =============================================================================
-- Ladino — pgTAP 97 · EL CALENDARIO DEL ESPECIAL, LA QUINCENA Y LOS DOS ARRASTRES
-- Migración 20261002120000_the_special_declares_by_fortnight.sql. Hallazgos L-04, L-05, L-09
-- (ADR-0072 §7 y §8, enmienda de ADR-0052).
--
-- Qué se prueba (cada defensa con su variante rota):
--   1. la siembra: 970 filas, 24 pendientes de cotejo, cada una con norma, gaceta y fuente;
--   2. una MUESTRA contra CALENDARIO_SPE_2026.md. El documento tiene UNA sola fuente textual
--      (Nayma Consultores): LEGA, Moore, MV3 y gerenciaytributos publican la tabla como imagen y
--      no se pudieron cotejar (§5.4 del documento). La muestra se compara con esa única fuente, y
--      este test lo dice: la segunda comparación queda VALIDAR-SENIAT;
--   3. las celdas ⚠ no se ofrecen: tax_due_date las devuelve con la fecha en NULL;
--   4. el vencimiento por TERMINAL del RIF, y solo para el especial;
--   5. la quincena en sus bordes (15/16, febrero, bisiesto, fin de año) y sin depender de la zona;
--   6. la propuesta de período por tipo;
--   7. los dos arrastres de recompute_iva_period viajan cada uno por su lado;
--   8. el catálogo no se escribe desde la API, y el CHECK de vencimiento con su variante rota.
-- =============================================================================

begin;
select plan(39);

insert into public.tenants (id, name) values
  ('aaaa0097-0000-4000-8000-00000000000a', 'Tenant 97');
-- Terminal 6 especial, terminal 6 ordinario, terminal 2 especial, y una sin RIF.
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0097-0000-4000-8000-0000000000e6', 'aaaa0097-0000-4000-8000-00000000000a',
   'J405559876', 'Especial terminal 6'),
  ('aaaa0097-0000-4000-8000-0000000000d6', 'aaaa0097-0000-4000-8000-00000000000a',
   'J405559886', 'Ordinaria terminal 6'),
  ('aaaa0097-0000-4000-8000-0000000000e2', 'aaaa0097-0000-4000-8000-00000000000a',
   'J405559872', 'Especial terminal 2'),
  ('aaaa0097-0000-4000-8000-0000000000f0', 'aaaa0097-0000-4000-8000-00000000000a',
   'PEND-0970000', 'Sin RIF'),
  -- H3: especial hasta el 30-09-2026 y ordinaria desde el 01-10-2026.
  ('aaaa0097-0000-4000-8000-0000000000e7', 'aaaa0097-0000-4000-8000-00000000000a',
   'J405559877', 'Especial que pasa a ordinaria');
insert into auth.users (id) values ('aaaa0097-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0097-0000-4000-8000-0000000000a1', true);
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values
  ('aaaa0097-0000-4000-8000-00000000000a', 'aaaa0097-0000-4000-8000-0000000000e6', 'especial',
   '2000-01-01', '2000-01-01', 'pgTAP 97', 'pgtap'),
  ('aaaa0097-0000-4000-8000-00000000000a', 'aaaa0097-0000-4000-8000-0000000000d6', 'ordinario',
   '2000-01-01', null, 'pgTAP 97', 'pgtap'),
  ('aaaa0097-0000-4000-8000-00000000000a', 'aaaa0097-0000-4000-8000-0000000000e2', 'especial',
   '2000-01-01', '2000-01-01', 'pgTAP 97', 'pgtap'),
  ('aaaa0097-0000-4000-8000-00000000000a', 'aaaa0097-0000-4000-8000-0000000000e7', 'especial',
   '2000-01-01', '2000-01-01', 'pgTAP 97', 'pgtap');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values
  ('aaaa0097-0000-4000-8000-00000000000a', 'aaaa0097-0000-4000-8000-0000000000e7', 'ordinario',
   '2026-10-01', null, 'pgTAP 97: deja de ser especial', 'pgtap');

-- ── 1. La siembra ────────────────────────────────────────────────────────────
select is((select count(*)::int from public.tax_calendar_entries), 970,
  'la PA 000091 sembrada: 2 tablas quincenales × 10 terminales × 12 meses × 4 obligaciones + 10 de la definitiva');
select is((select count(*)::int from public.tax_calendar_entries
            where review_status = 'pending_review'), 970,
  'pendientes de cotejo: TODAS (970) desde 20261002120200 — el terminal del RIF está en duda (H11, P-10.2), además del mapeo de la tabla 1.2');
select is((select count(*)::int from public.tax_calendar_entries
            where legal_norm <> 'PA SNAT/2025/000091' or gazette not like '%43.283%'
               or secondary_source not like '%naymaconsultores.com%'), 0,
  'cada fecha lleva su norma, la reimpresión de la G.O. 43.283 y la fuente de la que se transcribió');
select is((select count(*)::int from public.tax_calendar_entries
            where obligation = 'islr_retenciones'), 0,
  'las retenciones de ISLR NO se siembran: el documento no tiene fuente textual (R2)');

-- ── 2. La muestra contra la ÚNICA fuente textual (Nayma) ─────────────────────
-- Una sola fuente: el documento no tiene una segunda legible (CALENDARIO_SPE_2026.md §5.4).
select is((select due_date from public.tax_calendar_entries
            where obligation = 'iva' and period_from = '2026-01-01' and period_to = '2026-01-15'
              and rif_terminal = 0), date '2026-01-28',
  'muestra (fuente única: Nayma) · IVA 1.ª quincena de enero, terminal 0 → 28-01-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'iva' and period_from = '2026-09-01' and rif_terminal = 4),
  date '2026-09-30',
  'muestra (fuente única: Nayma) · IVA 1.ª quincena de septiembre, terminal 4 → 30-09-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'igtf' and period_from = '2026-03-01' and rif_terminal = 9),
  date '2026-03-17',
  'muestra (fuente única: Nayma) · IGTF 1.ª quincena de marzo, terminal 9 → 17-03-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'ret_iva' and period_from = '2025-12-16'
              and period_to = '2025-12-31' and rif_terminal = 9), date '2026-01-14',
  'muestra (fuente única: Nayma) · la columna «Ene» de la 2.ª quincena declara diciembre de 2025: terminal 9 → 14-01-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'islr_anticipo' and period_from = '2026-09-16'
              and period_to = '2026-09-30' and rif_terminal = 9), date '2026-10-01',
  'muestra (fuente única: Nayma) · anticipo de ISLR 2.ª quincena de septiembre, terminal 9 → 01-10-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'iva' and period_from = '2026-11-16'
              and period_to = '2026-11-30' and rif_terminal = 1), date '2026-12-15',
  'muestra (fuente única: Nayma) · IVA 2.ª quincena de noviembre, terminal 1 → 15-12-2026');
select is((select due_date from public.tax_calendar_entries
            where obligation = 'islr_definitiva' and rif_terminal = 6), date '2026-03-16',
  'muestra (fuente única: Nayma) · ISLR definitiva 2025, terminales 6 y 7 → 16-03-2026');
select is((select count(*)::int from public.tax_calendar_entries
            where period_from = '2026-12-16'), 0,
  'la 2.ª quincena de diciembre de 2026 es del calendario de 2027: no está');

-- ── 3. Las celdas ⚠ no se ofrecen ────────────────────────────────────────────
select is((select review_status from public.tax_calendar_entries
            where obligation = 'iva' and period_from = '2026-02-01' and rif_terminal = 2),
  'pending_review', 'febrero, terminal 2 (día 18 repetido en la fuente) está pendiente de cotejo');
select is((select due_date from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000e2',
                                                       'iva', '2026-02-01', '2026-02-15')),
  null::date, 'la celda ⚠ NO se ofrece: tax_due_date la devuelve con la fecha en NULL');
select is((select review_status from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000e2',
                                                            'iva', '2026-02-01', '2026-02-15')),
  'pending_review', '… y dice por qué: pendiente de cotejo');
select is((select due_date from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000e2',
                                                       'iva', '2026-03-01', '2026-03-15')),
  null::date, 'H11 (20261002120200): tampoco una celda sin ⚠ — el terminal está en duda (P-10.2), no se ofrece ninguna');

-- ── 4. Por terminal, y solo el especial ──────────────────────────────────────
select is(platform.rif_terminal('J405559876'), 6::smallint, 'el terminal es el último dígito del RIF');
select is(platform.rif_terminal('PEND-0970000'), null::smallint, 'un RIF provisional no tiene terminal');
select is((select due_date from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000e6',
                                                       'iva', '2026-01-01', '2026-01-15')),
  null::date, 'especial de terminal 6: la fecha existe (20-01-2026) pero no se ofrece hasta saber qué es el terminal');
select is((select count(*)::int from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000d6',
                                                            'iva', '2026-01-01', '2026-01-15')),
  0, 'la ordinaria con el mismo terminal no recibe fecha: la providencia es de los especiales');

-- ── 5. La quincena ───────────────────────────────────────────────────────────
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2026-02-15')),
  '(2026-02-01,2026-02-15)', 'el 15 cierra la primera quincena');
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2026-02-16')),
  '(2026-02-16,2026-02-28)', 'el 16 abre la segunda, que en febrero acaba el 28');
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2028-02-29')),
  '(2028-02-16,2028-02-29)', 'en año bisiesto, el 29');
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2026-12-31')),
  '(2026-12-16,2026-12-31)', 'fin de año: no se va a enero');
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2026-04-20')),
  '(2026-04-16,2026-04-30)', 'abril: la segunda quincena acaba el 30, no el 31');
select is((select count(*)::int
             from generate_series(date '2024-01-01', date '2028-12-31', interval '1 day') g (d)
            where (select row(r.fortnight_start, r.fortnight_end)
                     from platform.retention_fortnight(g.d::date) r)
                  is distinct from
                  (select row(f.period_from, f.period_to)
                     from platform.fiscal_fortnight(g.d::date) f)), 0,
  'retention_fortnight es fiscal_fortnight: el mismo corte todos los días de 2024 a 2028 (H8)');
set local timezone = 'Pacific/Kiritimati';
select is((select row(period_from, period_to)::text from platform.fiscal_fortnight('2026-03-01')),
  '(2026-03-01,2026-03-15)', 'con la sesión en UTC+14 el 1 de marzo sigue siendo la 1.ª quincena de marzo');
reset timezone;

-- ── 6. La propuesta de período ───────────────────────────────────────────────
select is((select row(periodicity, period_from, period_to, due_date)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000e6', '2026-10-02')),
  '(quincenal,2026-09-16,2026-09-30,)',
  'el especial, el 02-10: la 2.ª quincena de septiembre, SIN fecha: la tabla 1.2 está pendiente de cotejo');
select is((select row(periodicity, period_from, period_to, due_date)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000e6', '2026-10-20')),
  '(quincenal,2026-10-01,2026-10-15,)',
  'el especial, el 20-10: la 1.ª quincena de octubre, sin fecha mientras el terminal esté en duda');
select is((select row(periodicity, period_from, period_to, due_date)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000d6', '2026-10-02')),
  '(mensual,2026-09-01,2026-09-30,)',
  'la ordinaria: el mes anterior, sin fecha de la providencia de especiales');
select is((select row(periodicity, period_from, period_to, due_date, due_date_status)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000e2', '2026-02-20')),
  '(quincenal,2026-02-01,2026-02-15,,pending_review)',
  'la propuesta tampoco ofrece la celda ⚠: período sí, fecha no');

select is((select due_date from platform.tax_due_date('aaaa0097-0000-4000-8000-0000000000e6',
                                                       'iva', '2026-09-16', '2026-09-30')),
  null::date, 'H1: ninguna celda de la tabla 1.2 se ofrece hasta el cotejo con la G.O. 43.283');
-- H3: el tipo se evalúa al CIERRE del período candidato.
select is((select row(periodicity, period_from, period_to)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000e7', '2026-10-20')),
  '(quincenal,2026-09-16,2026-09-30)',
  'transición especial→ordinaria (01-10): el 20-10 se propone la última quincena que tocaba como especial');
select is((select row(periodicity, period_from, period_to)::text
             from platform.iva_period_proposal('aaaa0097-0000-4000-8000-0000000000e7', '2026-11-02')),
  '(mensual,2026-10-01,2026-10-31)',
  'y el 02-11, ya ordinaria al cierre de octubre: el mes de octubre');

-- ── 7. Los dos arrastres, cada uno por su lado ───────────────────────────────
select is((select row(cuota_a_pagar, excedente_siguiente, retenciones_acumuladas_por_descontar)::text
             from platform.recompute_iva_period('aaaa0097-0000-4000-8000-0000000000e6',
                                                '2026-09-01', '2026-09-15', 100, 50)),
  '(0,100,50)',
  'sin actividad: 100 de crédito y 50 de retenciones pasan SEPARADOS (antes salía una sola cifra: 150)');
select is((select row(excedente_siguiente, retenciones_acumuladas_por_descontar)::text
             from platform.recompute_iva_period('aaaa0097-0000-4000-8000-0000000000e6',
                                                '2026-09-01', '2026-09-15', 100)),
  '(100,0)', 'la llamada de cuatro argumentos sigue resolviendo, con 0 retenciones anteriores');

-- ── 8. El catálogo no se escribe desde la API; el CHECK de vencimiento ───────
set local role ladino_api;
select throws_ok($$ insert into public.tax_calendar_entries
                     (obligation, period_from, period_to, rif_terminal, due_date, legal_norm,
                      gazette, secondary_source, review_status)
                   values ('iva', '2027-01-01', '2027-01-15', 0, '2027-01-20', 'x', 'x', 'x',
                           'secondary_source') $$,
  '42501', null, 'ladino_api no siembra el calendario: es dato de plataforma, va por migración');
reset role;
select throws_ok($$ insert into public.tax_calendar_entries
                     (obligation, period_from, period_to, rif_terminal, due_date, legal_norm,
                      gazette, secondary_source, review_status)
                   values ('iva', '2027-01-16', '2027-01-31', 0, '2027-01-10', 'PA', 'G.O.', 'F',
                           'secondary_source') $$,
  '23514', null, 'un vencimiento anterior al cierre del período se rechaza');
alter table public.tax_calendar_entries drop constraint tax_calendar_entries_due_chk;
select lives_ok($$ insert into public.tax_calendar_entries
                    (obligation, period_from, period_to, rif_terminal, due_date, legal_norm,
                     gazette, secondary_source, review_status)
                  values ('iva', '2027-01-16', '2027-01-31', 0, '2027-01-10', 'PA', 'G.O.', 'F',
                          'secondary_source') $$,
  'variante rota: sin el CHECK el vencimiento imposible entra — el throws_ok medía el CHECK');

select * from finish();
rollback;
