-- =============================================================================
-- Ladino — pgTAP 132 · EL FIADO TIENE VENCIMIENTO
-- Migración 20261004210000 (P-05, E-22; ADR-0075, nota «el vencimiento»).
--
-- Qué se prueba (con su variante rota donde el invariante es crítico):
--   1. el CHECK: el vencimiento no es anterior al DÍA DE CARACAS de la emisión (23514), y el
--      mismo día vale también a las 23:30 de Caracas, que en UTC ya es mañana;
--   2. platform.document_due_day: el día en que vence un documento sin fecha es el de Caracas
--      de su emisión, a las 20:30 y a las 23:30 (y NO el de UTC);
--   3. platform.customer_overdue_today con `p_today`: vencer hoy no es estar vencido; un
--      documento sin fecha está vencido desde el día siguiente a su emisión; lo que vence después
--      no cuenta; cuando todo venció, lo vencido ES la deuda de platform.customer_debt_today;
--   4. sin tasa de hoy, lo vencido en divisa lleva su nominal y el funcional en NULL (nunca 0);
--   5. el vencimiento de un documento emitido no se cambia (LAD06) — y sin el trigger sí;
--   6. aislamiento de la lectura nueva como ladino_api: el actor de A no ve lo vencido de B; el
--      usuario de los dos tenants sí ve los dos — y sin RLS (el dueño de la base) B se ve.
-- =============================================================================
begin;
select plan(27);

insert into auth.users (id) values
  ('aaaa0132-0000-4000-8000-0000000000a1'),
  ('aaaa0132-0000-4000-8000-0000000000c1');
select set_config('ladino.actor_id', 'aaaa0132-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'pgtap-132', true);
insert into public.tenants (id, name) values
  ('aaaa0132-0000-4000-8000-00000000000a', 'Tenant 132 A'),
  ('aaaa0132-0000-4000-8000-00000000000b', 'Tenant 132 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000000a',
   'J-132-A', 'Empresa 132 A', 'VES', 'ordinario'),
  ('aaaa0132-0000-4000-8000-0000000000b2', 'aaaa0132-0000-4000-8000-00000000000b',
   'J-132-B', 'Empresa 132 B', 'VES', 'ordinario');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
select c.tenant_id, c.id, 'ordinario', '2000-01-01', 'Montaje pgTAP 132', 'pgtap'
  from public.companies c
 where c.id in ('aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-0000000000b2');
-- A1 es de A. C1 es de los DOS tenants: el atacante realista.
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0132-0000-4000-8000-0000000000a3', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a1'),
  ('aaaa0132-0000-4000-8000-0000000000c3', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000c1'),
  ('aaaa0132-0000-4000-8000-0000000000c4', 'aaaa0132-0000-4000-8000-00000000000b',
   'aaaa0132-0000-4000-8000-0000000000c1');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0132-0000-4000-8000-00000000c00a', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'J-CLI-132A', 'Cliente 132 A', 'juridica', 'ordinario'),
  ('aaaa0132-0000-4000-8000-00000000c00c', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'J-CLI-132C', 'Cliente 132 en divisa', 'juridica',
   'ordinario'),
  ('aaaa0132-0000-4000-8000-00000000c00d', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'J-CLI-132D', 'Cliente 132 del CHECK', 'juridica',
   'ordinario'),
  ('aaaa0132-0000-4000-8000-00000000c00b', 'aaaa0132-0000-4000-8000-00000000000b',
   'aaaa0132-0000-4000-8000-0000000000b2', 'J-CLI-132B', 'Cliente 132 B', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0132-0000-4000-8000-00000000e10a', 'aaaa0132-0000-4000-8000-00000000000a',
        'aaaa0132-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01'),
       ('aaaa0132-0000-4000-8000-00000000e10b', 'aaaa0132-0000-4000-8000-00000000000b',
        'aaaa0132-0000-4000-8000-0000000000b2', 'formatos_libres', '2026-01-01');

-- Sin tasas: lo que está en divisa no se puede valorar hoy (caso 4). Dentro de la transacción.
delete from public.exchange_rates;

-- Los documentos, con el instante de emisión ELEGIDO (nunca now()):
--   F1 · 10 de junio, 20:30 de Caracas (en UTC ya es el 11) · sin fecha · Bs 100
--   F2 · 10 de junio, 23:30 de Caracas (en UTC ya es el 11) · sin fecha · Bs 200
--   F3 · 10 de junio, 23:30 de Caracas · vence el 25 de junio        · Bs 400
--   F5 · 10 de junio, 12:00 de Caracas · sin fecha · USD 10 (otro cliente; sin tasa de hoy)
--   FB · empresa B · 1 de junio · sin fecha · Bs 999
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, due_date, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0132-0000-4000-8000-00000000f001', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0132-0000-4000-8000-00000000c00a', 1, 13201, 'issued',
   '2026-06-10 20:30:00-04', null,
   'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
   100, 100, 100, 0, 100),
  ('aaaa0132-0000-4000-8000-00000000f002', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0132-0000-4000-8000-00000000c00a', 2, 13202, 'issued',
   '2026-06-10 23:30:00-04', null,
   'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
   200, 200, 200, 0, 200),
  ('aaaa0132-0000-4000-8000-00000000f003', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0132-0000-4000-8000-00000000c00a', 3, 13203, 'issued',
   '2026-06-10 23:30:00-04', '2026-06-25',
   'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
   400, 400, 400, 0, 400),
  ('aaaa0132-0000-4000-8000-00000000f005', 'aaaa0132-0000-4000-8000-00000000000a',
   'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0132-0000-4000-8000-00000000c00c', 5, 13205, 'issued',
   '2026-06-10 12:00:00-04', null,
   'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'USD', 'VES', 40, 'BCV test',
   10, 400, 400, 0, 400),
  ('aaaa0132-0000-4000-8000-00000000fb01', 'aaaa0132-0000-4000-8000-00000000000b',
   'aaaa0132-0000-4000-8000-0000000000b2', 'invoice', 'A',
   'aaaa0132-0000-4000-8000-00000000c00b', 1, 13291, 'issued',
   '2026-06-01 10:00:00-04', null,
   'aaaa0132-0000-4000-8000-00000000e10b', 'test-132', 'VES', 'VES', 1, 'identidad',
   999, 999, 999, 0, 999);

-- ── 1. El CHECK: dos date, el día de Caracas ─────────────────────────────────
select throws_ok($$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
     status, issued_at, due_date, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values
    ('aaaa0132-0000-4000-8000-00000000f0d1', 'aaaa0132-0000-4000-8000-00000000000a',
     'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
     'aaaa0132-0000-4000-8000-00000000c00d', 11, 13211, 'issued',
     '2026-06-10 23:30:00-04', '2026-06-09',
     'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
     50, 50, 50, 0, 50) $$,
  '23514', null, 'un vencimiento anterior al día de la emisión no entra (CHECK)');

select lives_ok($$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
     status, issued_at, due_date, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values
    ('aaaa0132-0000-4000-8000-00000000f0d2', 'aaaa0132-0000-4000-8000-00000000000a',
     'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
     'aaaa0132-0000-4000-8000-00000000c00d', 12, 13212, 'issued',
     '2026-06-10 23:30:00-04', '2026-06-10',
     'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
     50, 50, 50, 0, 50) $$,
  'vencer el MISMO día vale a las 23:30 de Caracas: en UTC ya es el 11, y el CHECK mira Caracas');

-- ── 2. El día en que vence un documento sin fecha ────────────────────────────
select is(platform.document_due_day(null, '2026-06-10 20:30:00-04'::timestamptz),
          '2026-06-10'::date, 'sin fecha, a las 20:30 de Caracas vence ESE día de Caracas');
select is(platform.document_due_day(null, '2026-06-10 23:30:00-04'::timestamptz),
          '2026-06-10'::date, 'y a las 23:30 también');
select isnt(platform.document_due_day(null, '2026-06-10 23:30:00-04'::timestamptz),
            ('2026-06-10 23:30:00-04'::timestamptz at time zone 'UTC')::date,
            'VARIANTE ROTA: el día de UTC sería el 11 — la función no deja que el cast elija');
select is(platform.document_due_day('2026-06-25', '2026-06-10 23:30:00-04'::timestamptz),
          '2026-06-25'::date, 'con fecha acordada, vence esa fecha');

-- ── 3. Lo vencido, con «hoy» como parámetro ──────────────────────────────────
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     '2026-06-10'::date)),
  0, 'el 10 de junio nada está vencido: vencer hoy no es estar vencido');
select is(
  (select nominal::text || '|' || functional_today::text || '|' || document_count::text
     from platform.customer_overdue_today(
       'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
       '2026-06-11'::date)),
  '300.00|300.00000000|2',
  'el 11: vencidos F1 (20:30) y F2 (23:30), emitidos el 10 de Caracas y sin fecha');
select is(
  (select currency from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     '2026-06-11'::date)),
  'VES', 'en la moneda del documento');
select is(
  (select functional_today::text from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     '2026-06-25'::date)),
  '300.00000000', 'el 25, F3 vence HOY: todavía no cuenta');
select is(
  (select functional_today::text || '|' || document_count::text
     from platform.customer_overdue_today(
       'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
       '2026-06-26'::date)),
  '700.00000000|3', 'el 26 ya venció todo');
select is(
  (select functional_today from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     '2026-06-26'::date)),
  platform.customer_debt_today('aaaa0132-0000-4000-8000-0000000000a2',
                               'aaaa0132-0000-4000-8000-00000000c00a')::numeric(24,8),
  'y entonces lo vencido ES la deuda del cliente: sale de la misma función de deuda');
-- Por omisión, «hoy» es el día de Caracas de ahora: todo lo de junio está vencido.
select is(
  (select functional_today::text from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a')),
  (select functional_today::text from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     platform.caracas_day(now()))),
  'sin p_today se usa el día de Caracas de ahora');
-- Todos los clientes de la empresa de una vez (p_customer null): una fila por cliente y moneda.
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', null, '2026-06-26'::date)),
  3, 'sin cliente: el de Bs, el de divisa y el del CHECK, cada uno con su fila');

-- ── 4. En divisa y sin tasa de hoy: nominal sí, funcional NULL (nunca 0) ─────
select is(
  (select currency || '|' || nominal::text from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00c',
     '2026-06-11'::date)),
  'USD|10.00', 'lo vencido en divisa dice su nominal en su moneda');
select ok(
  (select functional_today is null from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00c',
     '2026-06-11'::date)),
  'y sin tasa de hoy su valor en bolívares es NULL: no se inventa ni se pone en cero');

-- ── 5. El vencimiento de un documento emitido no se cambia ───────────────────
select throws_ok($$
  update public.documents set due_date = '2026-12-31'
   where id = 'aaaa0132-0000-4000-8000-00000000f003' $$,
  'LAD06', null, 'mover el vencimiento de un documento emitido: LAD06');
select throws_ok($$
  update public.documents set due_date = '2026-06-30'
   where id = 'aaaa0132-0000-4000-8000-00000000f001' $$,
  'LAD06', null, 'ponerle fecha después a uno que nació sin ella: LAD06');
select throws_ok($$
  update public.documents set due_date = null
   where id = 'aaaa0132-0000-4000-8000-00000000f003' $$,
  'LAD06', null, 'y quitársela: LAD06');
select is(
  (select due_date::text from public.documents
    where id = 'aaaa0132-0000-4000-8000-00000000f003'),
  '2026-06-25', 'la fecha sigue siendo la acordada');

-- ── 6. Aislamiento de la lectura nueva (ladino_api) ──────────────────────────
set local role ladino_api;
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000b2', null, '2026-06-26'::date)),
  0, 'el actor de A no ve lo vencido de la empresa B');
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00a',
     '2026-06-26'::date)),
  1, 'y sí ve lo de la suya: el camino autorizado funciona, no solo el cerrado');
reset role;
select set_config('ladino.actor_id', 'aaaa0132-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is(
  (select nominal::text from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000b2', null, '2026-06-26'::date)),
  '999.00', 'el usuario de los DOS tenants ve lo vencido de B, pidiendo B');
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000a2', 'aaaa0132-0000-4000-8000-00000000c00b',
     '2026-06-26'::date)),
  0, 'pero pidiendo la empresa A con el cliente de B no cruza nada: cero filas');
reset role;
select set_config('ladino.actor_id', 'aaaa0132-0000-4000-8000-0000000000a1', true);
-- VARIANTE ROTA: sin RLS (el dueño de la base la salta) lo de B se ve. Lo que aísla la lectura
-- es la RLS de `documents` — la función es SECURITY INVOKER a propósito.
select is(
  (select count(*)::int from platform.customer_overdue_today(
     'aaaa0132-0000-4000-8000-0000000000b2', null, '2026-06-26'::date)),
  1, 'VARIANTE ROTA: saltándose la RLS, lo vencido de B aparece');

-- ── Variantes rotas del trigger y del CHECK (al final: dejan el esquema roto) ─
alter table public.documents disable trigger documents_06_due_date_frozen;
select lives_ok($$
  update public.documents set due_date = '2026-12-31'
   where id = 'aaaa0132-0000-4000-8000-00000000f003' $$,
  'VARIANTE ROTA: sin el trigger, el vencimiento de un documento emitido se mueve — '
  'platform.assert_document_immutable no conoce la columna');
alter table public.documents drop constraint documents_due_date_chk;
select lives_ok($$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
     status, issued_at, due_date, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values
    ('aaaa0132-0000-4000-8000-00000000f0d1', 'aaaa0132-0000-4000-8000-00000000000a',
     'aaaa0132-0000-4000-8000-0000000000a2', 'invoice', 'A',
     'aaaa0132-0000-4000-8000-00000000c00d', 11, 13211, 'issued',
     '2026-06-10 23:30:00-04', '2026-06-09',
     'aaaa0132-0000-4000-8000-00000000e10a', 'test-132', 'VES', 'VES', 1, 'identidad',
     50, 50, 50, 0, 50) $$,
  'VARIANTE ROTA: sin el CHECK, el vencimiento anterior a la emisión entra');

select * from finish();
rollback;
