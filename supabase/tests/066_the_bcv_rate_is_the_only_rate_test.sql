-- =============================================================================
-- Ladino — pgTAP 66 · LA TASA DEL BCV ES LA ÚNICA TASA (migración 66, ADR-0064 §1)
--
-- Fechas de 2020 a propósito: ninguna otra prueba siembra tasas allí. Las filas
-- «tecleadas» se insertan como postgres (sin RLS): son la HISTORIA anterior a la
-- migración 66, que ya nadie puede escribir.
--
--   1. a igual día, la tecleada no cuenta: manda la oficial — con RIF y sin RIF;
--   2. un día sin publicación usa la última oficial, no la tecleada de ese día;
--   3. antes de toda oficial no hay tasa, aunque haya una tecleada;
--   4. la fuente devuelta es la de la oficial;
--   5. VARIANTE ROTA — el actor de USUARIO ya no escribe ni la tasa de su empresa;
--   6. el actor de sistema sigue escribiendo la oficial.
-- =============================================================================

begin;
select plan(7);

insert into public.tenants (id, name) values
  ('aaaa0066-0000-4000-8000-00000000000a', 'Tenant 66');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0066-0000-4000-8000-0000000000a1', 'aaaa0066-0000-4000-8000-00000000000a',
   'J-66-A', 'Factura 66'),
  ('aaaa0066-0000-4000-8000-0000000000a2', 'aaaa0066-0000-4000-8000-00000000000a',
   'PEND-0066A00002', 'Recibos 66');

-- Oficiales: 2020-01-01 (10) y 2020-01-02 (12). Tecleadas (historia): 2019-12-31 (9),
-- 2020-01-02 (15, el mismo día que una oficial) y 2020-01-03 (13, un día sin oficial).
insert into public.exchange_rates
  (from_currency, to_currency, rate, source, rate_date, rate_timestamp, tenant_id, company_id)
values
  ('USD', 'VES', 10, 'BCV oficial prueba-066', '2020-01-01', now(), null, null),
  ('USD', 'VES', 12, 'BCV oficial prueba-066 dia2', '2020-01-02', now(), null, null),
  ('USD', 'VES', 15, 'Carga manual 066', '2020-01-02', now(),
   'aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a1'),
  ('USD', 'VES', 15, 'Carga manual 066', '2020-01-02', now(),
   'aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a2'),
  ('USD', 'VES', 13, 'Carga manual 066 dia3', '2020-01-03', now(),
   'aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a1'),
  ('USD', 'VES', 9, 'Carga manual 066 vieja', '2019-12-31', now(),
   'aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a1');

select is(
  (select array_agg(platform.rate_at(c, 'USD', 'VES', '2020-01-02') order by c)
     from unnest(array['aaaa0066-0000-4000-8000-0000000000a1',
                       'aaaa0066-0000-4000-8000-0000000000a2']::uuid[]) c),
  array[12, 12]::numeric[],
  'a igual día manda la oficial (12), no la tecleada (15) — con RIF y sin RIF');

select is(
  platform.rate_at('aaaa0066-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-01-03'),
  12::numeric,
  'un día sin publicación usa la última oficial (12), no la tecleada de ese día (13)');

select is(
  (select count(*) from platform.rate_for('aaaa0066-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                          '2019-12-31')),
  0::bigint,
  'antes de toda oficial no hay tasa, aunque exista una tecleada (9)');

select is(
  (select source from platform.rate_for('aaaa0066-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                        '2020-01-03')),
  'BCV oficial prueba-066 dia2',
  'la fuente devuelta es la de la oficial');

-- ── Nadie escribe una tasa de empresa ───────────────────────────────────────
select set_config('ladino.actor_id', '00000000-0000-4000-8000-0000000066aa', true);
set local role ladino_api;
select throws_ok($$
  insert into public.exchange_rates
    (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a1',
          'USD', 'VES', 900, 'Carga manual 066 nueva', '2020-01-04', now())
$$, '42501', null,
  'VARIANTE ROTA: la API ya no escribe una tasa de empresa, ni para la suya (antes sí)');
reset role;

select set_config('ladino.actor_id', '00000000-0000-4000-8000-000000000000', true);
set local role ladino_api;
select throws_ok($$
  insert into public.exchange_rates
    (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0066-0000-4000-8000-00000000000a', 'aaaa0066-0000-4000-8000-0000000000a1',
          'USD', 'VES', 900, 'Carga manual 066 sistema', '2020-01-04', now())
$$, '42501', null, 'ni siquiera el actor de sistema escribe una tasa con empresa');
select lives_ok($$
  insert into public.exchange_rates
    (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('USD', 'VES', 14, 'BCV oficial prueba-066 sistema', '2020-01-04', now())
$$, 'el actor de sistema sigue escribiendo la oficial');
reset role;

select * from finish();
rollback;
