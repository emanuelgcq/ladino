-- =============================================================================
-- Ladino — pgTAP 130 · UNA SOLA REGLA DE LA TASA DEL DÍA (migración 20261004195900)
--
-- Regla 8 de CLAUDE.md; resto de D-09 (ola 3) y de ADR-0075 §6. «La tasa del día» es la OFICIAL
-- más reciente no posterior a la fecha Y no más antigua que el margen de plataforma
-- (`platform.parameters.official_rate_max_age_days`). La regla vive en UN sitio,
-- `platform.rate_for`; `rate_at` y `closing_rate` son esa misma consulta reducida al número.
--
-- Fechas de 2020 a propósito: ninguna otra prueba ni fixture deja tasas oficiales allí. El margen
-- se FIJA en 7 dentro de la transacción: las cifras de abajo no dependen del valor que la base
-- tenga sembrado (es un dato, y puede cambiar).
--
--   1-3.  dentro del margen (mismo día y el borde exacto) hay tasa, con su fecha;
--   4-6.  fuera del margen NO hay tasa: ni fila, ni número, ni tasa de cierre;
--   7.    `closing_rate` y `rate_at` son la misma regla en los dos lados del borde;
--   8-10. datos hostiles: una tasa posterior a la fecha no rige; una TECLEADA dentro del margen no
--         rescata a una oficial vencida; fecha NULL no devuelve nada;
--   11-12.el filtro por fuente respeta el margen;
--   13-15.el margen es DATO: con 30 la tasa vieja vale; con 0 solo la del mismo día;
--   16-18.el nombre viejo es un alias de verdad: cambiar uno cambia el otro, en las dos direcciones;
--   19-20.se EJERCE como `ladino_api` y como `authenticated` (no se pregunta por el privilegio);
--   21.   sin el parámetro, falla CERRADA: ninguna tasa, ni la del mismo día;
--   22.   VARIANTE ROTA — con la definición anterior (20260916180000) la tasa vencida vuelve a
--         servirse: lo que miden 4-6 es el margen, no otra cosa.
-- =============================================================================

begin;
select plan(22);

insert into public.tenants (id, name) values
  ('aaaa0130-0000-4000-8000-00000000000a', 'Tenant 130');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0130-0000-4000-8000-0000000000a1', 'aaaa0130-0000-4000-8000-00000000000a',
   'J-130-A', 'Tasa 130');

-- El margen de esta prueba: 7 días, por cualquiera de los dos nombres.
update platform.parameters set value = 7 where key = 'official_rate_max_age_days';

-- Oficiales: 2020-03-01 (10) y 2020-03-20 (20, posterior a todo lo que se pregunta en marzo).
-- Tecleada (historia anterior a la migración 66): 2020-03-08 (99), dentro del margen del día 9.
insert into public.exchange_rates
  (from_currency, to_currency, rate, source, rate_date, rate_timestamp, tenant_id, company_id)
values
  ('USD', 'VES', 10, 'BCV oficial prueba-130', '2020-03-01', now(), null, null),
  ('USD', 'VES', 20, 'BCV oficial prueba-130', '2020-03-20', now(), null, null),
  ('USD', 'VES', 99, 'Carga manual 130', '2020-03-08', now(),
   'aaaa0130-0000-4000-8000-00000000000a', 'aaaa0130-0000-4000-8000-0000000000a1');

-- ── Dentro del margen ────────────────────────────────────────────────────────
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-01'),
  10::numeric, 'el mismo día: la tasa de ese día');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-08'),
  10::numeric, 'a 7 días exactos (el borde del margen) la última publicada todavía rige');
select is(
  (select rate_date from platform.rate_for('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                           '2020-03-08')),
  '2020-03-01'::date, 'y dice de qué día es');

-- ── Fuera del margen ─────────────────────────────────────────────────────────
select is(
  (select count(*) from platform.rate_for('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                          '2020-03-09')),
  0::bigint, 'a 8 días la tasa está vencida: rate_for no devuelve fila');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-09'),
  null::numeric, 'rate_at devuelve NULL: quien convierte se detiene, no usa la tasa rancia');
select is(platform.closing_rate('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                '2020-03-09'),
  null::numeric, 'y la tasa de cierre, lo mismo');

select is(
  (select array_agg(platform.closing_rate('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', d)
                    is not distinct from
                    platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', d)
                    order by d)
     from unnest(array['2020-02-29', '2020-03-01', '2020-03-08', '2020-03-09', '2020-03-19',
                       '2020-03-20', '2020-03-27', '2020-03-28']::date[]) d),
  array[true, true, true, true, true, true, true, true],
  'closing_rate y rate_at dicen lo mismo a los dos lados de cada borde: una sola regla');

-- ── Datos hostiles ───────────────────────────────────────────────────────────
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-19'),
  null::numeric, 'una tasa POSTERIOR a la fecha (la del 20) no rige el día 19, y la del 1 venció');
select is(
  (select count(*) from platform.rate_for('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                          '2020-03-09')),
  0::bigint, 'una tecleada dentro del margen (día 8) no rescata a la oficial vencida');
select is(
  (select count(*) from platform.rate_for('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES',
                                          null::date)),
  0::bigint, 'sin fecha no hay tasa');

select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-08',
                           'BCV oficial prueba-130'),
  10::numeric, 'pedida por su fuente y dentro del margen: la de esa fuente');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-09',
                           'BCV oficial prueba-130'),
  null::numeric, 'pedida por su fuente y fuera del margen: tampoco');

-- ── El margen es un DATO ─────────────────────────────────────────────────────
update platform.parameters set value = 30 where key = 'official_rate_max_age_days';
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-09'),
  10::numeric, 'con un margen de 30 días, la del día 1 rige el día 9');
update platform.parameters set value = 0 where key = 'official_rate_max_age_days';
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-02'),
  null::numeric, 'con margen 0, la de ayer ya no rige');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-01'),
  10::numeric, 'con margen 0, la del mismo día sí');

-- ── El nombre viejo es un alias, no otra regla ───────────────────────────────
select is((select value from platform.parameters where key = 'closing_rate_max_age_days'),
  0::numeric, 'cambiar official_rate_max_age_days cambió closing_rate_max_age_days');
update platform.parameters set value = 7 where key = 'closing_rate_max_age_days';
select is((select value from platform.parameters where key = 'official_rate_max_age_days'),
  7::numeric, 'y cambiar el nombre viejo cambia el nuevo: quien todavía lo escribe mueve la regla');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-08'),
  10::numeric, 'la regla lee el valor que se escribió por el alias');

-- ── Ejercida por los roles que la usan ───────────────────────────────────────
select set_config('ladino.actor_id', '00000000-0000-4000-8000-000000000000', true);
set local role ladino_api;
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-08'),
  10::numeric, 'como ladino_api la regla funciona de verdad (lee el parámetro y la tasa)');
reset role;
set local role authenticated;
-- El VALOR, no solo que no lance: un `lives_ok` da verde también si el rol no ve el parámetro
-- o la tasa y la función devuelve NULL (la regla fallaría cerrada para toda la web).
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-08'),
  10::numeric, 'como authenticated la regla devuelve la tasa (lee el parámetro y la tasa global)');
reset role;

-- ── Sin parámetro, falla cerrada ─────────────────────────────────────────────
delete from platform.parameters
 where key in ('official_rate_max_age_days', 'closing_rate_max_age_days');
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-01'),
  null::numeric, 'sin el parámetro no hay tasa, ni la del mismo día: la regla falla cerrada');

-- ── VARIANTE ROTA: la definición anterior, sin margen ────────────────────────
create or replace function platform.rate_for(
  p_company uuid, p_from text, p_to text, p_fecha date, p_source text default null)
returns table (rate numeric, source text, rate_date date, rate_timestamp timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.rate, r.source, r.rate_date, r.rate_timestamp
    from public.exchange_rates r
   where r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_fecha
     and r.company_id is null
     and (p_source is null or r.source = p_source)
   order by r.rate_date desc, r.created_at desc
   limit 1
$$;
select is(platform.rate_at('aaaa0130-0000-4000-8000-0000000000a1', 'USD', 'VES', '2020-03-09'),
  10::numeric,
  'VARIANTE ROTA: sin el margen en rate_for, la tasa vencida vuelve a servirse (y closing_rate ya no la filtra por su cuenta)');

select * from finish();
rollback;
