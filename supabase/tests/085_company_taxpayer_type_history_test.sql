-- =============================================================================
-- Ladino — pgTAP 85 · EL TIPO DE CONTRIBUYENTE TIENE HISTORIA (ADR-0072 §1)
-- Migración 20260928190000_the_taxpayer_type_has_history.sql. Hallazgos A-03, B-07, F-11.
--
-- Qué se prueba (cada defensa con su variante rota):
--   1. sin default: ni la historia ni la columna espejo tienen tipo por omisión;
--   2. la historia es append-only (UPDATE y DELETE → LAD06), y SIN el trigger el
--      UPDATE entra (el throws_ok medía el trigger);
--   3. `especial` exige la fecha de notificación y los demás no la llevan; los
--      clasificadores de contrapartes (`no_sujeto`) no son un tipo de empresa;
--   4. taxpayer_type_at en las fechas de borde: el día antes no hay tipo, el día
--      de la vigencia sí, el cambio rige desde su día y no antes; la empresa sin
--      RIF es no_contribuyente sin declarar nada; con RIF y sin historia, NULL;
--   5. el espejo de companies se sincroniza desde la historia;
--   6. aislamiento como ladino_api con un actor de VARIOS tenants: lee y declara
--      en los suyos, no ve ni declara en uno ajeno (42501);
--   7. los permisos de la retención soportada: quien cobra carga, el contador corrige.
-- =============================================================================

begin;
select plan(24);

insert into auth.users (id) values ('aaaa0085-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0085-0000-4000-8000-00000000000a', 'Tenant 85 A'),
  ('aaaa0085-0000-4000-8000-00000000000b', 'Tenant 85 B'),
  ('aaaa0085-0000-4000-8000-00000000000c', 'Tenant 85 C');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0085-0000-4000-8000-0000000000a2', 'aaaa0085-0000-4000-8000-00000000000a',
   'J850000001', 'Empresa 85 A'),
  ('aaaa0085-0000-4000-8000-0000000000b2', 'aaaa0085-0000-4000-8000-00000000000b',
   'J850000002', 'Empresa 85 B (ajena)'),
  ('aaaa0085-0000-4000-8000-0000000000c2', 'aaaa0085-0000-4000-8000-00000000000c',
   'PEND-850000C', 'Negocio 85 C sin RIF');
-- El actor es miembro de A y de C (el atacante realista es el de los dos lados), no de B.
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a1'),
  ('aaaa0085-0000-4000-8000-00000000000c', 'aaaa0085-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0085-0000-4000-8000-0000000000a1', true);

-- ── 1. Sin default ───────────────────────────────────────────────────────────
select ok(
  (select column_default is null from information_schema.columns
    where table_schema = 'public' and table_name = 'company_taxpayer_types'
      and column_name = 'taxpayer_type_code')
  and (select column_default is null from information_schema.columns
        where table_schema = 'public' and table_name = 'companies'
          and column_name = 'taxpayer_type_code'),
  'ni la historia ni la columna espejo tienen un tipo por omisión: nunca «ordinario por omisión»');
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, effective_from, reason,
                                             rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          '2026-09-01', 'sin tipo', 'v1')
$$, '23502', null, 'declarar sin decir el tipo falla (NOT NULL), no se completa solo');

-- ── 3. Forma ─────────────────────────────────────────────────────────────────
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          'especial', '2026-09-24', 'especial sin notificación', 'v1')
$$, '23514', null, 'especial sin fecha de notificación se rechaza');
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, notified_on, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          'ordinario', '2026-09-24', '2026-09-24', 'ordinario con notificación', 'v1')
$$, '23514', null, 'la fecha de notificación es solo del especial');
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          'no_sujeto', '2026-09-24', 'clasificación de contraparte', 'v1')
$$, '23514', null, 'no_sujeto clasifica contrapartes, no a la empresa');
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          'ordinario', '2026-09-24', '  ', 'v1')
$$, '23514', null, 'sin acta no hay declaración');

-- ── 4. taxpayer_type_at en los bordes ────────────────────────────────────────
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2026-09-30'),
  null, 'con RIF y sin historia: NULL (no se factura), no un tipo inventado');
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000c2', '2026-09-30'),
  'no_contribuyente', 'sin RIF: no_contribuyente sin declarar nada');

insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
        'ordinario', '2026-09-01', 'Declaración inicial del dueño', 'v1');
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, notified_on, reason, rules_version)
values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
        'especial', '2026-09-24', '2026-09-24', 'Providencia notificada el 24-09', 'v1');

select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2026-08-31'),
  null, 'el día ANTES de la primera vigencia no hay tipo');
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2026-09-01'),
  'ordinario', 'el día de la vigencia, rige');
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2026-09-23'),
  'ordinario', 'el día antes del cambio sigue el tipo anterior: una operación fechada antes '
  'del cambio no se lee con el tipo nuevo (B-07)');
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2026-09-24'),
  'especial', 'el especial rige desde su día');
select is(platform.taxpayer_type_at('aaaa0085-0000-4000-8000-0000000000a2', '2099-12-31'),
  'especial', 'y sigue rigiendo en el futuro remoto hasta otra declaración');

-- ── 5. El espejo ─────────────────────────────────────────────────────────────
select is((select taxpayer_type_code from public.companies
            where id = 'aaaa0085-0000-4000-8000-0000000000a2'),
  'especial', 'la columna de companies se sincroniza desde la historia (tipo vigente hoy)');

-- ── 2. Append-only, con su variante rota ─────────────────────────────────────
select throws_ok($$
  update public.company_taxpayer_types set taxpayer_type_code = 'formal'
   where company_id = 'aaaa0085-0000-4000-8000-0000000000a2'
$$, 'LAD06', null, 'la historia no se edita');
select throws_ok($$
  delete from public.company_taxpayer_types
   where company_id = 'aaaa0085-0000-4000-8000-0000000000a2'
$$, 'LAD06', null, 'la historia no se borra');
savepoint roto;
drop trigger company_taxpayer_types_append_only on public.company_taxpayer_types;
select lives_ok($$
  update public.company_taxpayer_types set reason = 'Reescrita sin el trigger'
   where company_id = 'aaaa0085-0000-4000-8000-0000000000a2'
$$, 'SIN el trigger el UPDATE entra: los throws_ok de arriba medían el trigger');
rollback to savepoint roto;

-- ── 6. Aislamiento como ladino_api, actor de varios tenants ──────────────────
set local role ladino_api;
select is((select count(*) from public.company_taxpayer_types
            where company_id = 'aaaa0085-0000-4000-8000-0000000000a2'),
  2::bigint, 'ladino_api lee la historia de un tenant del actor');
select lives_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000c', 'aaaa0085-0000-4000-8000-0000000000c2',
          'ordinario', '2026-09-01', 'Declaración en el otro tenant', 'v1')
$$, 'ladino_api declara en el OTRO tenant del mismo actor (el camino permitido funciona)');
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0085-0000-4000-8000-00000000000b', 'aaaa0085-0000-4000-8000-0000000000b2',
          'ordinario', '2026-09-01', 'Intrusión', 'v1')
$$, '42501', null, 'ladino_api NO declara en un tenant ajeno');
reset role;
insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0085-0000-4000-8000-00000000000b', 'aaaa0085-0000-4000-8000-0000000000b2',
        'ordinario', '2026-09-01', 'Declaración de B', 'v1');
set local role ladino_api;
select is((select count(*) from public.company_taxpayer_types
            where company_id = 'aaaa0085-0000-4000-8000-0000000000b2'),
  0::bigint, 'ladino_api NO ve la historia de un tenant ajeno');
reset role;

-- ── 7. Permisos de la retención soportada ───────────────────────────────────
select ok(
  (select count(*) = 3 from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where r.tenant_id is null and rp.permission_key = 'ar.retention.register'
      and r.key in ('owner', 'back_office', 'cashier'))
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
                   where r.tenant_id is null and r.key = 'store_manager'
                     and rp.permission_key = 'ar.retention.register'),
  'quien cobra carga el comprobante: dueño, administrativo y cajero; el encargado no cobra (§2.8)');
select ok(
  (select count(*) = 2 from public.role_permissions rp join public.roles r on r.id = rp.role_id
    where r.tenant_id is null and rp.permission_key = 'ar.retention.correct'
      and r.key in ('owner', 'accountant'))
  and not exists (select 1 from public.role_permissions rp join public.roles r on r.id = rp.role_id
                   where r.tenant_id is null and r.key = 'cashier'
                     and rp.permission_key = 'ar.retention.correct'),
  'lo corrige el contador (y el dueño); el cajero no');
select throws_ok($$
  insert into public.supported_retention_receipts
    (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on, base, rate,
     amount, functional_currency)
  values ('aaaa0085-0000-4000-8000-00000000000a', 'aaaa0085-0000-4000-8000-0000000000a2',
          gen_random_uuid(), gen_random_uuid(), '2026-0900001', '2026-09-24', 100, 0.75, 12,
          'VES')
$$, '23514', null, 'un comprobante nuevo que no tiene 14 dígitos se rechaza (antes que la FK)');

select * from finish();
rollback;
