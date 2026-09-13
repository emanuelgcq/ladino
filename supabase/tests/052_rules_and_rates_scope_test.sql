-- =============================================================================
-- Ladino — pgTAP 52 · LO MANUAL ES DE CADA EMPRESA; LO OFICIAL, DE LA PLATAFORMA
--                     (migración 52, ADR-0057)
--
-- Dos empresas de tenants distintos. La tasa propia gana a la oficial del
-- mismo día y no existe para la otra; la oficial más reciente gana a la
-- propia más antigua. Una regla propia OCULTA las de la plataforma para su
-- empresa, no para otra. Las firmas sin empresa ya no existen. Y la RLS: el
-- actor de usuario no escribe filas de plataforma; el de sistema, sí.
-- =============================================================================

begin;
select plan(28);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0052-0000-4000-8000-0000000000a1'),   -- usuario de A
  ('aaaa0052-0000-4000-8000-0000000000b1');   -- usuario de B
insert into public.tenants (id, name) values
  ('aaaa0052-0000-4000-8000-00000000000a', 'Tenant 52 A'),
  ('aaaa0052-0000-4000-8000-00000000000b', 'Tenant 52 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0052-0000-4000-8000-0000000000a2', 'aaaa0052-0000-4000-8000-00000000000a',
   'J-52-A', 'Empresa A', 'ordinario'),
  ('aaaa0052-0000-4000-8000-0000000000b2', 'aaaa0052-0000-4000-8000-00000000000b',
   'J-52-B', 'Empresa B', 'ordinario');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0052-0000-4000-8000-000000000a01', 'aaaa0052-0000-4000-8000-00000000000a',
   'aaaa0052-0000-4000-8000-0000000000a1'),
  ('aaaa0052-0000-4000-8000-000000000b01', 'aaaa0052-0000-4000-8000-00000000000b',
   'aaaa0052-0000-4000-8000-0000000000b1');

-- ── 1. Esquema ───────────────────────────────────────────────────────────────
select has_column('public', 'exchange_rates', 'company_id', 'exchange_rates.company_id existe');
select has_column('public', 'tax_rules', 'company_id', 'tax_rules.company_id existe');
select has_column('public', 'retention_rules', 'company_id', 'retention_rules.company_id existe');
select hasnt_function('platform', 'rate_at', array['text', 'text', 'date', 'text'],
  'la firma de rate_at SIN empresa ya no existe: una lectura sin empresa falla al compilar');
select hasnt_function('platform', 'resolve_tax', array['date', 'text', 'text', 'text', 'text', 'text'],
  'la firma de resolve_tax SIN empresa ya no existe');
select hasnt_function('platform', 'resolve_retention',
  array['date', 'text', 'text', 'text', 'text', 'text'],
  'la firma de resolve_retention SIN empresa ya no existe');
select throws_ok($$
  insert into public.exchange_rates
    (company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0052-0000-4000-8000-0000000000a2', 'USD', 'VES', 1, 'x', '2026-09-01', now())
$$, '23514', null, 'company_id sin tenant_id se rechaza: la pertenencia va entera o no va');

-- ── 2. Tasas: la propia gana a la oficial del mismo día, y no existe para otro ─
insert into public.exchange_rates
  (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
values
  (null, null, 'USD', 'VES', 40, 'BCV oficial vía DolarAPI (test 052)', '2026-09-01', now()),
  ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
   'USD', 'VES', 38, 'tecleada por A', '2026-09-01', now()),
  (null, null, 'USD', 'VES', 45, 'BCV oficial vía DolarAPI (test 052)', '2026-09-02', now());

select is(platform.rate_at('aaaa0052-0000-4000-8000-0000000000a2', 'USD', 'VES', '2026-09-01'),
  38::numeric, 'para A, el 1/09 rige SU tasa (38), no la oficial del mismo día (40)');
select is(platform.rate_at('aaaa0052-0000-4000-8000-0000000000b2', 'USD', 'VES', '2026-09-01'),
  40::numeric, 'para B, el 1/09 rige la oficial (40): la tasa de A no existe para B');
select is(platform.rate_at('aaaa0052-0000-4000-8000-0000000000a2', 'USD', 'VES', '2026-09-02'),
  45::numeric, 'para A, el 2/09 rige la oficial del 2 (45): el día más reciente gana a lo propio viejo');
select is((select source from platform.rate_for('aaaa0052-0000-4000-8000-0000000000a2',
                                                 'USD', 'VES', '2026-09-01')),
  'tecleada por A', 'rate_for devuelve la fila entera, con su fuente');

-- Dos empresas pueden teclear su tasa del mismo día con la misma fuente; la
-- misma empresa, no.
insert into public.exchange_rates
  (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
values ('aaaa0052-0000-4000-8000-00000000000b', 'aaaa0052-0000-4000-8000-0000000000b2',
        'USD', 'VES', 39, 'tecleada por A', '2026-09-01', now());
select pass('B teclea su tasa del 1/09 con la misma fuente que A: el único es por ámbito');
select throws_ok($$
  insert into public.exchange_rates
    (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
          'USD', 'VES', 37, 'tecleada por A', '2026-09-01', now())
$$, '23505', null, 'pero A no carga dos veces la misma tasa (par, fuente, día): exchange_rates_day_key');

-- El ancla es inmutable, como en toda tabla con tenant_id.
select throws_ok($$
  update public.exchange_rates set company_id = 'aaaa0052-0000-4000-8000-0000000000b2'
   where rate = 38
$$, 'LAD28', null, 'una tasa no cambia de empresa: LAD28');

-- ── 3. Reglas tributarias: lo propio oculta a la plataforma, solo para su empresa ─
insert into public.tax_rules
  (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, transaction_type,
   product_tax_category, rate, effective_from, legal_source, priority)
values
  (null, null, 'VE', 'iva', null, 'sale', 'gravado_general', 0.16, '2026-01-01',
   'REGLA DE PRUEBA pgTAP 052 — plataforma', 100),
  ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
   'VE', 'iva', null, 'sale', 'gravado_general', 0.08, '2026-01-01',
   'REGLA DE PRUEBA pgTAP 052 — propia de A', 100);

select is((select rate from platform.resolve_tax('aaaa0052-0000-4000-8000-0000000000a2',
            '2026-09-01', 'VE', 'iva', 'ordinario', 'gravado_general')),
  0.08::numeric, 'A resuelve SU regla (0,08) aunque la de la plataforma tenga la misma prioridad');
select is((select rate from platform.resolve_tax('aaaa0052-0000-4000-8000-0000000000b2',
            '2026-09-01', 'VE', 'iva', 'ordinario', 'gravado_general')),
  0.16::numeric, 'B resuelve la de la plataforma (0,16): la regla de A no existe para B');
select lives_ok($$
  select * from platform.resolve_tax('aaaa0052-0000-4000-8000-0000000000a2',
            '2026-09-01', 'VE', 'iva', 'ordinario', 'gravado_general')
$$, 'la misma prioridad en dos NIVELES distintos no es catálogo ambiguo');
-- Dentro del nivel propio, la ambigüedad sigue fallando.
insert into public.tax_rules
  (tenant_id, company_id, jurisdiction, tax_code, taxpayer_type, transaction_type,
   product_tax_category, rate, effective_from, legal_source, priority)
values ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
        'VE', 'iva', null, 'sale', 'gravado_general', 0.10, '2026-01-01',
        'REGLA DE PRUEBA pgTAP 052 — propia de A, duplicada', 100);
select throws_ok($$
  select * from platform.resolve_tax('aaaa0052-0000-4000-8000-0000000000a2',
            '2026-09-01', 'VE', 'iva', 'ordinario', 'gravado_general')
$$, 'LAD50', null, 'dos reglas propias con la MISMA prioridad siguen siendo ambigüedad (ADR-0038)');
delete from public.tax_rules where rate = 0.10;
-- Sin regla en ningún nivel: LAD50, como siempre.
select throws_ok($$
  select * from platform.resolve_tax('aaaa0052-0000-4000-8000-0000000000b2',
            '2026-09-01', 'VE', 'iva', 'ordinario', 'exento')
$$, 'LAD50', null, 'sin regla propia ni de plataforma, LAD50: nunca cero');

-- ── 4. Reglas de retención: lo mismo ─────────────────────────────────────────
insert into public.retention_rules
  (tenant_id, company_id, jurisdiction, retention_code, concept_code, taxpayer_type,
   formula_kind, rate, effective_from, legal_source, priority)
values
  (null, null, 'VE', 'iva', 'iva_compras', 'especial', 'rate', 0.75, '2026-01-01',
   'REGLA DE PRUEBA pgTAP 052 — plataforma', 100),
  ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
   'VE', 'iva', 'iva_compras', 'especial', 'rate', 1.0, '2026-01-01',
   'REGLA DE PRUEBA pgTAP 052 — propia de A', 100);
select is((select rate from platform.resolve_retention('aaaa0052-0000-4000-8000-0000000000a2',
            '2026-09-01', 'VE', 'iva', 'iva_compras', 'especial', 'juridica')),
  1.0::numeric, 'A retiene con SU regla (100 %)');
select is((select rate from platform.resolve_retention('aaaa0052-0000-4000-8000-0000000000b2',
            '2026-09-01', 'VE', 'iva', 'iva_compras', 'especial', 'juridica')),
  0.75::numeric, 'B retiene con la de la plataforma (75 %): la de A no existe para B');

-- ── 5. RLS: quién ve y quién escribe ─────────────────────────────────────────
-- ladino_api con el actor de A: ve la plataforma y lo de A, nada de B.
select set_config('ladino.actor_id', 'aaaa0052-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*) from public.exchange_rates where rate_date = '2026-09-01'),
  2::bigint, 'el actor de A ve, del 1/09, la oficial y la suya: la de B no existe');
select is((select count(*) from public.tax_rules where legal_source like 'REGLA DE PRUEBA pgTAP 052%'),
  2::bigint, 'y de reglas, la de la plataforma y la suya');
select throws_ok($$
  insert into public.exchange_rates
    (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('USD', 'VES', 1, 'colada como oficial', '2026-09-03', now())
$$, '42501', null, 'un actor de USUARIO no escribe una tasa de PLATAFORMA: 42501');
select throws_ok($$
  insert into public.exchange_rates
    (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0052-0000-4000-8000-00000000000b', 'aaaa0052-0000-4000-8000-0000000000b2',
          'USD', 'VES', 1, 'colada en B', '2026-09-03', now())
$$, '42501', null, 'ni una tasa de OTRO tenant: 42501');
select lives_ok($$
  insert into public.exchange_rates
    (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('aaaa0052-0000-4000-8000-00000000000a', 'aaaa0052-0000-4000-8000-0000000000a2',
          'USD', 'VES', 41, 'tecleada por A', '2026-09-03', now())
$$, 'pero sí la suya');
reset role;

-- El actor de SISTEMA sí escribe la oficial.
select set_config('ladino.actor_id', '00000000-0000-4000-8000-000000000000', true);
set local role ladino_api;
select ok(platform.ladino_actor_is_system(), 'el GUC con el uuid de sistema es el actor de sistema');
select lives_ok($$
  insert into public.exchange_rates
    (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values ('USD', 'VES', 46, 'BCV oficial vía DolarAPI (test 052, sistema)', '2026-09-03', now())
$$, 'el actor de sistema escribe la tasa oficial (company_id nulo)');
reset role;

select * from finish();
rollback;
