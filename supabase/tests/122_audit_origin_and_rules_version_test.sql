-- =============================================================================
-- pgTAP 122 · EL ACTA DICE DE DÓNDE VINO Y LAS REGLAS TIENEN VERSIÓN
-- (A-16, B-06, B-14 · ADR-0079 · migraciones 20261004120000, 120100, 120200, 120300, 205000 y
--  205200)
--
--   · QUINTA PASADA (20261004205200, sección 12): una fila YA emitida o posteada conserva su
--     `rules_version` ante un UPDATE que la nombre, sea de reglas, heredada (`domain-s0.5`), nula u
--     otra registrada que traiga la sentencia (B1); un borrador que PASA a estado final declarando
--     de nuevo se sella con la versión de ese día (B2, lado de la base); y la cláusula (2) del
--     invariante juzga por el instante del estado final, no solo por `created_at` (B3). Con la
--     variante rota de B1 (la definición literal de la 205000, que resella) y la de B3;
--   · rules_version = semver + hash del conjunto de reglas: quien declara `domain-s0.5` recibe la
--     versión vigente, REGISTRADA. En un acta, una cuenta o la historia del tipo de contribuyente
--     otra cadena se respeta (es procedencia); en un documento fiscal o un asiento NO: todo lo que
--     no sea una versión de reglas registrada se sustituye por la vigente (C3, sección 11);
--   · la memoria de la transacción y el «ya registrada» solo valen para `kind = 'rules'` (C1);
--   · un cambio de regla de la empresa cambia SU versión y no la de otra; uno global, la de todas;
--     subir la versión semántica la cambia, y 1.10.0 va después de 1.9.0;
--   · congelada es congelada: volver a declarar en un UPDATE no cambia la versión con la que nació;
--   · toda tabla de public con `rules_version` lleva el trigger (familia, sin excepciones);
--   · rules_version_gaps, desde el corte: (1) toda `rules_version` escrita, en toda tabla que la
--     lleva, está registrada; (2) todo documento fiscal emitido (venta issued/paid/annulled;
--     factura de proveedor posted/paid/annulled; comprobante de retención; retención; nota de
--     retiro) y todo asiento posteado o revertido lleva una versión `kind = 'rules'`. Sin la fila
--     de su corte no devuelve cero: falla (C5);
--   · rule_set_drift: el hash global guardado es el recalculado; de platform.parameters entra la
--     clave y el valor normalizado, no la nota (C7);
--   · global_rate_record_gaps: toda tasa global desde el corte tiene su acta;
--   · cada ajuste que entra en el hash cambia la versión; TODA columna de company_settings y
--     purchase_settings está clasificada regla / no regla (C6); y el conjunto EXACTO de tablas
--     con `zz_rule_set_state` (13) y `zz_rules_version_cache` (8) (C5);
--   · el origen del acta lo ponen los GUC de la transacción, no la fila; una ip mal formada no
--     tumba la escritura; sin GUC, el canal lo dice el rol;
--   · system_audit_events: solo el actor de sistema, por la API; append-only; nadie la lee;
--   · cada defensa con su VARIANTE ROTA (al final: desactivar un trigger toma un candado).
-- =============================================================================
begin;
select plan(104);

insert into auth.users (id) values
  ('aaaa0122-0000-4000-8000-0000000000e1'),   -- de A y de B (el usuario multi-tenant)
  ('aaaa0122-0000-4000-8000-0000000000e2');   -- solo de B
select set_config('ladino.actor_id', 'aaaa0122-0000-4000-8000-0000000000e1', true);
insert into public.tenants (id, name) values
  ('aaaa0122-0000-4000-8000-00000000000a', 'Tenant 122 A'),
  ('aaaa0122-0000-4000-8000-00000000000b', 'Tenant 122 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0122-0000-4000-8000-0000000000a1', 'aaaa0122-0000-4000-8000-00000000000a', 'J-122-A',
   'Ferretería 122 A', 'VES', 'ordinario'),
  ('aaaa0122-0000-4000-8000-0000000000b1', 'aaaa0122-0000-4000-8000-00000000000b', 'J-122-B',
   'Ferretería 122 B', 'VES', 'ordinario');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0122-0000-4000-8000-0000000000aa', 'aaaa0122-0000-4000-8000-00000000000a',
   'aaaa0122-0000-4000-8000-0000000000e1'),
  ('aaaa0122-0000-4000-8000-0000000000ab', 'aaaa0122-0000-4000-8000-00000000000b',
   'aaaa0122-0000-4000-8000-0000000000e1'),
  ('aaaa0122-0000-4000-8000-0000000000bb', 'aaaa0122-0000-4000-8000-00000000000b',
   'aaaa0122-0000-4000-8000-0000000000e2');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0122-0000-4000-8000-00000000c001', 'aaaa0122-0000-4000-8000-00000000000a',
   'aaaa0122-0000-4000-8000-0000000000a1', 'J-CLI-122', 'Constructora 122', 'juridica',
   'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0122-0000-4000-8000-00000000e101', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 122', 'pgtap');

create function pg_temp.vigente(p_company uuid) returns text language sql as $$
  select c.version from platform.current_rules_version(p_company) c;
$$;
-- Un acta de la empresa p_company del tenant p_tenant: devuelve la versión con la que quedó.
create function pg_temp.acta(p_tenant uuid, p_company uuid, p_rules text, p_evento text)
returns text language sql as $$
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
     rules_version, payload)
  values (p_tenant, p_company, 'company', p_company, p_evento, 'user', now(), p_rules, '{}')
  returning rules_version;
$$;
-- El acta de A: devuelve la versión con la que quedó.
create function pg_temp.acta_a(p_rules text, p_evento text) returns text language sql as $$
  select pg_temp.acta('aaaa0122-0000-4000-8000-00000000000a',
                      'aaaa0122-0000-4000-8000-0000000000a1', p_rules, p_evento);
$$;
-- Un documento fiscal emitido de A.
create function pg_temp.doc(p_id uuid, p_numero bigint, p_rules text) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
     status, issued_at, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values
    (p_id, 'aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1',
     'invoice', 'A', 'aaaa0122-0000-4000-8000-00000000c001', p_numero, 12200 + p_numero,
     'issued', now(), 'aaaa0122-0000-4000-8000-00000000e101', p_rules,
     'VES', 'VES', 1, 'pgtap', 116, 116, 100, 16, 116);
$$;
-- Los huecos de A en DOCUMENTOS (las secciones 1-9 siembran actas con cadenas sin registrar a
-- propósito; el invariante entero, tabla por tabla, se mira en la sección 10).
create function pg_temp.gaps() returns int language sql as $$
  select count(*)::int from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
   where table_name = 'documents';
$$;
create function pg_temp.gaps_de(p_tabla text, p_cadena text) returns int language sql as $$
  select count(*)::int from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
   where table_name = p_tabla and rules_version = p_cadena;
$$;

-- ── 1. La versión: forma, determinismo, registro ────────────────────────────
select matches(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  '^[0-9]+\.[0-9]+\.[0-9]+\+[0-9a-f]{16}$',
  'la versión es semver + «+» + 16 hex del hash');
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'dos cálculos seguidos dan la misma versión (sin reloj dentro del hash)');
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
            pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'),
  'A (con régimen y tipo) y B (sin ellos) no comparten versión: el hash cubre lo de la empresa');
select is((select count(*)::int from platform.rule_set_drift()), 0,
  'rule_set_drift: el hash global guardado es el recalculado');

select is(pg_temp.acta_a('domain-s0.5', 'test.rules.a'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'quien declara domain-s0.5 recibe la versión vigente de SU empresa');
select ok(exists (select 1 from platform.rules_versions v
                   where v.version = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1')),
  'y esa versión queda registrada');
select is(pg_temp.acta_a('db-guard', 'test.rules.b'), 'db-guard',
  'otra cadena (db-guard: no la escribió un caso de uso) se respeta');
select is(pg_temp.acta_a('2026.08', 'test.rules.c'), '2026.08',
  'y una declarada por quien llama, también');

-- Por el camino real: la API (ladino_api, sin BYPASSRLS, con el actor multi-tenant).
set local role ladino_api;
select lives_ok($$ select pg_temp.acta('aaaa0122-0000-4000-8000-00000000000a',
  'aaaa0122-0000-4000-8000-0000000000a1', 'domain-s0.5', 'test.rules.api') $$,
  'como ladino_api el acta se escribe: el trigger no pide privilegios que la API no tiene');
reset role;
select is((select rules_version from public.audit_events where event_type = 'test.rules.api'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'y lleva la misma versión que calcula el dueño de la base (la RLS no cambia el hash)');

-- ── 2. Un cambio de regla cambia la versión ─────────────────────────────────
create temp table antes as
  select pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1') as a,
         pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1') as b;
grant select on antes to public;

-- La aceptación en pantalla: una alícuota de la empresa A.
insert into public.tax_rules
  (jurisdiction, tax_code, transaction_type, product_tax_category, rate, effective_from,
   legal_source, priority, status, tenant_id, company_id)
values ('VE', 'iva', 'sale', 'gravado_general', 0.16, platform.caracas_day(now()) - 1,
        'pgTAP 122: alícuota aceptada por el dueño', 5, 'active',
        'aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1');
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from antes),
  'aceptar una alícuota en la empresa A cambia la versión de A');
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from antes),
  'y NO la de B: la regla de una empresa no versiona a otra');
select is(pg_temp.acta_a('domain-s0.5', 'test.rules.d'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'el acta siguiente, en la MISMA transacción, ya lleva la versión nueva (la memoria se olvidó)');

-- Una regla global (un umbral de platform.parameters): cambia para todas.
update antes set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
update platform.parameters set value = value + 1 where key = 'closing_rate_max_age_days';
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from antes),
  'cambiar un umbral global cambia la versión de A');
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from antes),
  'y la de B');
select is((select count(*)::int from platform.rule_set_drift()), 0,
  'rule_set_drift sigue en cero: el trigger recalculó el hash global');

-- La versión semántica la sube una migración con un insert, y se ordena como número.
insert into platform.rules_releases (semver, note) values
  ('1.9.0', 'pgTAP 122: una versión intermedia'), ('1.10.0', 'pgTAP 122: la más nueva');
select alike(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), '1.10.0+%',
  'subir la versión semántica cambia la versión, y 1.10.0 va después de 1.9.0');
select throws_ok($$ insert into platform.rules_releases (semver, note)
                    values ('v2', 'pgTAP 122: no es una versión semántica') $$,
  '23514', null, 'una versión que no es semver no entra');

-- ── 3. Los documentos congelan, y el invariante mira ────────────────────────
select pg_temp.doc('aaaa0122-0000-4000-8000-00000000d001', 1, 'domain-s0.5');
select is((select rules_version from public.documents
            where id = 'aaaa0122-0000-4000-8000-00000000d001'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'un documento que declara domain-s0.5 nace con la versión vigente');
select is(pg_temp.gaps(), 0, 'rules_version_gaps = 0 con el documento versionado');

-- Congelada es congelada: cambia una regla y el documento vuelve a declarar.
update antes set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
update platform.parameters set value = value + 1 where key = 'closing_rate_max_age_days';
update public.documents set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-00000000d001';
select is((select rules_version from public.documents
            where id = 'aaaa0122-0000-4000-8000-00000000d001'), (select a from antes),
  'un UPDATE que vuelve a declarar NO cambia la versión con la que nació el documento');
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from antes),
  '(y la vigente sí era ya otra: lo que la retuvo fue el congelado, no la casualidad)');

-- C3 (migración 20261004205000): un documento fiscal no admite otra cosa que una versión de
-- REGLAS. Una cadena cualquiera se sustituye por la vigente: no hay documento «con test-122».
select pg_temp.doc('aaaa0122-0000-4000-8000-00000000d002', 2, 'test-122');
select is((select rules_version from public.documents
            where id = 'aaaa0122-0000-4000-8000-00000000d002'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'C3: un documento que declara una cadena que no es una versión de reglas se sella con la vigente');
select is(pg_temp.gaps(), 0, 'y rules_version_gaps sigue en cero para los documentos');
-- (Que el invariante VE un documento mal sellado, y que el corte va en el enunciado, se prueba
-- en 8.1, donde el trigger se desactiva: con él puesto no se puede fabricar el caso.)

-- ── 4. Familia: toda tabla con rules_version lleva el trigger ───────────────
select is(
  (select count(*)::int
     from information_schema.columns c
     join information_schema.tables t
       on t.table_schema = c.table_schema and t.table_name = c.table_name
      and t.table_type = 'BASE TABLE'
    where c.table_schema = 'public' and c.column_name = 'rules_version'
      and not exists (
        select 1 from pg_trigger g
         where g.tgrelid = format('public.%I', c.table_name)::regclass
           and g.tgfoid = 'platform.stamp_rules_version'::regproc
           and g.tgenabled <> 'D' and g.tgtype & 2 = 2 and g.tgtype & 4 = 4)),
  0, 'toda tabla de public con rules_version lleva el trigger que la congela (cero excepciones)');

-- ── 5. Registros append-only ────────────────────────────────────────────────
select throws_ok($$ update platform.rules_versions set semver = '9.9.9' $$, 'LAD06', null,
  'rules_versions es append-only: UPDATE');
select throws_ok($$ delete from platform.rules_releases $$, 'LAD06', null,
  'rules_releases es append-only: DELETE');
set local role ladino_api;
select throws_ok($$ select * from platform.rules_versions $$, '42501', null,
  'la API no lee el registro de versiones directamente');
reset role;

-- ── 6. El origen del acta ───────────────────────────────────────────────────
select is((select channel from public.audit_events where event_type = 'test.rules.a'), 'db',
  'sin origen declarado y fuera de la API, el canal es db');
select is((select channel from public.audit_events where event_type = 'test.rules.api'), 'api',
  'sin origen declarado y como ladino_api (la API anterior a esta migración), el canal es api');

select set_config('ladino.origin_channel', 'web', true),
       set_config('ladino.origin_ip', '203.0.113.7', true),
       -- Datos hostiles: 3.000 caracteres incompresibles y de más de un byte.
       set_config('ladino.origin_user_agent',
                  (select string_agg(substr('añüßçøабвгдежзийклмнопрстуфхцчшщ€',
                                            1 + floor(random() * 33)::int, 1), '')
                     from generate_series(1, 3000)), true),
       set_config('ladino.origin_session', 'aaaa0122-sesion', true),
       set_config('ladino.origin_build', 'web@1.2.3 api@abc1234', true);
-- La fila intenta decir otra cosa: no manda.
insert into public.audit_events
  (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
   rules_version, payload, channel, ip, session_id, app_build)
values ('aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1', 'company',
        'aaaa0122-0000-4000-8000-0000000000a1', 'test.origin.web', 'user', now(), 'pgtap', '{}',
        'worker', '10.0.0.1', 'falsa', 'falso');
select is(
  (select channel || ' ' || host(ip) || ' ' || session_id || ' ' || app_build
     from public.audit_events where event_type = 'test.origin.web'),
  'web 203.0.113.7 aaaa0122-sesion web@1.2.3 api@abc1234',
  'canal, ip, sesión y build salen de la transacción, no de lo que diga la fila');
select is((select length(user_agent) from public.audit_events
            where event_type = 'test.origin.web'), 512,
  'el user-agent hostil (3.000 caracteres multibyte) se recorta a 512 y la escritura vive');

select set_config('ladino.origin_ip', 'no-es-una-ip, 1.2.3.4', true);
select lives_ok($$ select pg_temp.acta('aaaa0122-0000-4000-8000-00000000000a',
  'aaaa0122-0000-4000-8000-0000000000a1', 'pgtap', 'test.origin.ipmala') $$,
  'una ip mal formada no tumba la escritura que se audita');
select is((select ip from public.audit_events where event_type = 'test.origin.ipmala'), null,
  'queda vacía');

select set_config('ladino.origin_channel', 'hacker', true);
select pg_temp.acta('aaaa0122-0000-4000-8000-00000000000a',
                    'aaaa0122-0000-4000-8000-0000000000a1', 'pgtap', 'test.origin.canalmalo');
select is((select channel from public.audit_events where event_type = 'test.origin.canalmalo'),
  'db', 'un canal que no existe no se guarda: lo dice el rol');
select set_config('ladino.origin_channel', '', true), set_config('ladino.origin_ip', '', true),
       set_config('ladino.origin_user_agent', '', true),
       set_config('ladino.origin_session', '', true), set_config('ladino.origin_build', '', true);

-- ── 7. El acta de plataforma ────────────────────────────────────────────────
create function pg_temp.acta_sistema() returns void language sql as $$
  insert into public.system_audit_events
    (aggregate_type, aggregate_id, event_type, occurred_at, payload)
  values ('exchange_rate', 'aaaa0122-0000-4000-8000-00000000f001', 'fx.rate.captured', now(),
          '{"rate": "40.00000000"}');
$$;
set local role ladino_api;
select throws_ok($$ select pg_temp.acta_sistema() $$, '42501', null,
  'la API con un actor PERSONA (aunque sea de dos tenants) no escribe el acta de plataforma');
select set_config('ladino.actor_id', '00000000-0000-4000-8000-000000000000', true);
select lives_ok($$ select pg_temp.acta_sistema() $$,
  'la API con el actor de sistema sí: el único camino autorizado funciona');
select throws_ok($$ select count(*) from public.system_audit_events $$, '42501', null,
  'y ni así la lee: no sale por la API');
reset role;
select set_config('ladino.actor_id', 'aaaa0122-0000-4000-8000-0000000000e1', true);
select is((select count(*)::int from public.system_audit_events
            where aggregate_id = 'aaaa0122-0000-4000-8000-00000000f001'
              and actor_type = 'system' and payload_hash is not null), 1,
  'el acta está, con actor system y su hash');
set local role authenticated;
select set_config('request.jwt.claims',
  '{"sub":"aaaa0122-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
select throws_ok($$ select count(*) from public.system_audit_events $$, '42501', null,
  'una persona autenticada (miembro de A y de B) no la lee');
select throws_ok($$ select pg_temp.acta_sistema() $$, '42501', null, 'ni la escribe');
reset role;
select throws_ok($$ update public.system_audit_events set event_type = 'fx.rate.forged' $$,
  'LAD06', null, 'es append-only: UPDATE');
select throws_ok($$ delete from public.system_audit_events $$, 'LAD06', null,
  'es append-only: DELETE');
select throws_ok($$ insert into public.system_audit_events
    (aggregate_type, aggregate_id, event_type, actor_type, occurred_at)
  values ('exchange_rate', gen_random_uuid(), 'fx.rate.captured', 'user', now()) $$,
  '23514', null, 'el actor de un acta de plataforma solo es system');

-- ── 8. VARIANTES ROTAS (cada ALTER toma un candado: con plazo, y al final) ───
set local lock_timeout = '4s';

-- 8.1 Sin el trigger que congela, el documento se queda con la cadena fija y el invariante lo ve.
alter table public.documents disable trigger documents_90_rules_version;
select pg_temp.doc('aaaa0122-0000-4000-8000-00000000d003', 3, 'domain-s0.5');
alter table public.documents enable trigger documents_90_rules_version;
select is(
  (select string_agg(problem, ',' order by problem)
     from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
    where table_name = 'documents' and rules_version = 'domain-s0.5'),
  'emitted_without_rules_version,unregistered',
  'ROTA: sin el trigger el documento nace con domain-s0.5, y rules_version_gaps lo saca por '
  'las dos cláusulas: cadena sin registrar y documento emitido sin versión de reglas');
-- Y una cadena de sistema REGISTRADA en un documento emitido: pasa la cláusula (1) y la caza la
-- (2). Es lo que antes dejaba un asiento con `db-repair` sin que nadie lo viera.
alter table public.documents disable trigger documents_90_rules_version;
select pg_temp.doc('aaaa0122-0000-4000-8000-00000000d004', 4, 'db-repair');
alter table public.documents enable trigger documents_90_rules_version;
select is(
  (select string_agg(problem, ',' order by problem)
     from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
    where table_name = 'documents' and rules_version = 'db-repair'),
  'emitted_without_rules_version',
  'C3: un documento emitido con una cadena de sistema registrada sale igual: exige kind = rules');
-- El corte va en el enunciado.
update platform.invariant_cutoffs set since = now() + interval '1 hour'
 where invariant = 'rules_version_gaps';
select is(pg_temp.gaps(), 0, 'antes del corte no se juzga (regla 1: lo emitido no se edita)');
update platform.invariant_cutoffs set since = now() - interval '1 hour'
 where invariant = 'rules_version_gaps';
select is(pg_temp.gaps(), 3, 'y con el corte atrás vuelven a salir (dos del primero, una del segundo)');
-- C1: el UPDATE que declara domain-s0.5 sobre una fila con cadena de SISTEMA la resella con la
-- vigente (antes, «db-repair está registrada» bastaba para conservarla). Sobre un BORRADOR: un
-- documento emitido no cambia de versión por ninguna vía (lo impide documents_immutable).
alter table public.documents disable trigger documents_90_rules_version;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0122-0000-4000-8000-00000000d006', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'quote', 'A',
        'aaaa0122-0000-4000-8000-00000000c001', 'draft', 'db-repair', 'VES', 'VES', 1, 'pgtap',
        116, 116, 100, 16, 116);
alter table public.documents enable trigger documents_90_rules_version;
update public.documents set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-00000000d006';
select is((select rules_version from public.documents
            where id = 'aaaa0122-0000-4000-8000-00000000d006'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'C1: declarar de nuevo sobre una cadena de sistema la sustituye por la versión vigente');

-- 8.2 Sin el trigger de la tabla global, el hash guardado se queda viejo y rule_set_drift lo ve.
alter table platform.parameters disable trigger zz_rule_set_state;
update platform.parameters set value = value + 1 where key = 'closing_rate_max_age_days';
alter table platform.parameters enable trigger zz_rule_set_state;
select is((select count(*)::int from platform.rule_set_drift()), 1,
  'ROTA: una regla global que cambia sin su trigger deja el hash viejo, y rule_set_drift lo saca');

-- 8.3 Sin el trigger que olvida, el acta siguiente a un cambio de regla lleva la versión VIEJA:
-- lo que hace cierta la aserción «en la MISMA transacción ya lleva la nueva» es ese trigger.
select pg_temp.acta_a('domain-s0.5', 'test.rules.memoria');   -- deja la memoria caliente
alter table public.tax_rules disable trigger zz_rules_version_cache;
insert into public.tax_rules
  (jurisdiction, tax_code, transaction_type, product_tax_category, rate, effective_from,
   legal_source, priority, status, tenant_id, company_id)
values ('VE', 'iva', 'sale', 'exento', 0, platform.caracas_day(now()) - 1,
        'pgTAP 122: otra regla aceptada', 5, 'active',
        'aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1');
alter table public.tax_rules enable trigger zz_rules_version_cache;
select isnt(pg_temp.acta_a('domain-s0.5', 'test.rules.vieja'),
            pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'ROTA: sin el trigger que olvida la memoria, el acta lleva la versión anterior al cambio');

-- 8.4 Sin el trigger de origen, nadie rellena: lo que llena las columnas es él.
select set_config('ladino.origin_channel', 'web', true);
alter table public.audit_events disable trigger audit_events_origin;
select pg_temp.acta('aaaa0122-0000-4000-8000-00000000000a',
                    'aaaa0122-0000-4000-8000-0000000000a1', 'pgtap', 'test.origin.sin');
select is((select channel from public.audit_events where event_type = 'test.origin.sin'), null,
  'ROTA: sin el trigger de origen el canal queda vacío aunque la transacción lo declare');
select throws_ok($$ insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
     rules_version, payload, channel)
  values ('aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1',
          'company', 'aaaa0122-0000-4000-8000-0000000000a1', 'test.origin.check', 'user', now(),
          'pgtap', '{}', 'hacker') $$,
  '23514', null, 'y el CHECK del canal rechaza por sí solo lo que no es un canal');
alter table public.audit_events enable trigger audit_events_origin;

-- ── 9. Ninguna tasa GLOBAL se queda sin acta (migración 20261004120100, R-81.7) ──
-- El trigger es DIFERIDO (dispara al cierre): aquí se le pide que dispare ya.
select set_config('ladino.origin_channel', '', true);
create function pg_temp.tasa(p_id uuid, p_dia date, p_fuente text) returns void language sql as $$
  insert into public.exchange_rates
    (id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
  values (p_id, 'USD', 'VES', 36.12345678, p_fuente, p_dia, now());
$$;
create function pg_temp.actas_tasa(p_id uuid) returns text language sql as $$
  select coalesce(string_agg(a.event_type, ',' order by a.event_type), '(ninguna)')
    from public.system_audit_events a
   where a.aggregate_type = 'exchange_rate' and a.aggregate_id = p_id;
$$;
-- Un insert directo (una semilla, una reparación, la API anterior al despliegue).
select pg_temp.tasa('aaaa0122-0000-4000-8000-00000000f0a1', '2001-02-01', 'pgTAP 122 directo');
-- El camino del dominio: la tasa y, en la misma transacción, su acta de captura.
select pg_temp.tasa('aaaa0122-0000-4000-8000-00000000f0a2', '2001-02-02', 'pgTAP 122 dominio');
insert into public.system_audit_events
  (aggregate_type, aggregate_id, event_type, occurred_at, payload)
values ('exchange_rate', 'aaaa0122-0000-4000-8000-00000000f0a2', 'fx.rate.captured', now(), '{}');
set constraints all immediate;
select is(pg_temp.actas_tasa('aaaa0122-0000-4000-8000-00000000f0a1'),
  'fx.rate.inserted_without_capture',
  'una tasa global insertada sin acta recibe la suya al cierre, y dice que entró sin captura');
select is(
  (select payload->>'rate' || ' ' || (payload->>'source')
     from public.system_audit_events
    where aggregate_id = 'aaaa0122-0000-4000-8000-00000000f0a1'),
  '36.12345678 pgTAP 122 directo', 'con el valor y la fuente que traía la fila');
select is(pg_temp.actas_tasa('aaaa0122-0000-4000-8000-00000000f0a2'), 'fx.rate.captured',
  'la que entra por el dominio conserva SOLO su acta de captura: el trigger no añade otra');
set constraints all deferred;
-- ROTA: sin el trigger, la tasa directa se queda sin rastro.
alter table public.exchange_rates disable trigger exchange_rates_zz_record;
select pg_temp.tasa('aaaa0122-0000-4000-8000-00000000f0a3', '2001-02-03', 'pgTAP 122 sin trigger');
alter table public.exchange_rates enable trigger exchange_rates_zz_record;
select is(pg_temp.actas_tasa('aaaa0122-0000-4000-8000-00000000f0a3'), '(ninguna)',
  'ROTA: sin el trigger la tasa global entra sin acta — lo que la deja es él');

-- ── 10. Revisión en contexto limpio (migración 20261004120200) ──────────────
create temp table rev as
  select pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1') as a,
         pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1') as b;
grant select on rev to public;

-- H1: el hash no depende del huso de la sesión. A tiene un régimen con `effective_from`
-- timestamptz, que `to_jsonb` serializa con el huso vigente.
set local timezone = 'UTC';
update rev set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
set local timezone = 'America/Caracas';
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from rev),
  'H1: la misma empresa da la misma versión con la sesión en UTC y en Caracas');
alter function platform.current_rules_version(uuid) reset timezone;
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from rev),
  'ROTA: sin el huso fijado en la función, Caracas y UTC dan versiones distintas');
alter function platform.current_rules_version(uuid) set timezone to 'UTC';
set local timezone = 'UTC';

-- H2: los privilegios EXACTOS del acta de plataforma, por rol (sin contar a su dueño).
select results_eq(
  $$ select coalesce(r.rolname::text collate "default", 'PUBLIC'),
            string_agg(a.privilege_type, ',' order by a.privilege_type)
       from pg_class c
       cross join lateral aclexplode(c.relacl) a
       left join pg_roles r on r.oid = a.grantee
      where c.oid = 'public.system_audit_events'::regclass and a.grantee <> c.relowner
      group by 1 order by 1 $$,
  $$ values ('ladino_api'::text, 'INSERT'::text) $$,
  'H2: sobre system_audit_events solo ladino_api tiene algo, y es INSERT (ni TRUNCATE ni '
  'TRIGGER ni REFERENCES para service_role)');

-- H3: el invariante mira TODA tabla con rules_version, y una cadena solo pasa si está registrada.
select is(pg_temp.gaps_de('audit_events', '2026.08'), 1,
  'H3: un ACTA con una cadena sin registrar sale en rules_version_gaps (ya no solo documentos)');
select is(pg_temp.gaps_de('company_taxpayer_types', 'pgtap'), 1,
  'y una fila de company_taxpayer_types, también: la lista de tablas sale del catálogo');
select is(pg_temp.gaps_de('audit_events', 'db-guard'), 0,
  'db-guard está REGISTRADA como cadena de sistema: no sale');
insert into platform.rules_versions (version, kind, note) values
  ('pgtap', 'system', 'pgTAP 122: cadena declarada para la prueba');
select is(pg_temp.gaps_de('company_taxpayer_types', 'pgtap'), 0,
  'registrarla la saca del invariante: lo que decide es el registro, no una lista de perdones');
select throws_ok($$ insert into platform.rules_versions (version, kind) values ('sin-nota', 'system') $$,
  '23514', null, 'una cadena de sistema sin nota que diga qué la escribe no se registra');
select throws_ok($$ insert into platform.rules_versions (version, kind, note)
                    values ('9.9.9+abcdef0123456789', 'system', 'pgTAP 122: se hace pasar por reglas') $$,
  '23514', null, 'ni una que se haga pasar por una versión de reglas');

-- H4: las reglas que faltaban entran en el hash.
update rev set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
               b = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1');
update public.igtf_instrument_classes set legal_source = legal_source || ' (pgTAP 122)';
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from rev),
  'H4: cambiar qué instrumento causa IGTF (global) cambia la versión de todas');
select is((select count(*)::int from platform.rule_set_drift()), 0,
  'y rule_set_drift vuelve a cero: el trigger de la tabla nueva recalculó');
-- «Sin fila de ajustes» y «la fila con sus valores por omisión» son la MISMA regla (migración
-- 20261004120300): si no, el acta que escribe el trigger del RIF al nacer la empresa y la de
-- `company.created` llevarían dos versiones. Y vigila los DEFAULT escritos en la función: si
-- alguien cambia uno en la tabla y no en el hash, esto se pone en rojo.
update rev set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
delete from public.company_settings where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
delete from public.purchase_settings where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
update rev set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
insert into public.company_settings (tenant_id, company_id)
values ('aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1');
insert into public.purchase_settings (tenant_id, company_id)
values ('aaaa0122-0000-4000-8000-00000000000a', 'aaaa0122-0000-4000-8000-0000000000a1');
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from rev),
  'crear las filas de ajustes con sus valores por omisión NO cambia la versión de la empresa');
update rev set a = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
               b = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1');
update public.company_settings set print_control_number = not print_control_number
 where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from rev),
  'un ajuste que NO es regla (imprimir el control) no cambia la versión');
update public.company_settings set absorb_igtf = not absorb_igtf
 where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'), (select a from rev),
  'H4: absorber el IGTF (ajuste fiscal de la empresa) cambia la versión de A');
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from rev),
  'y no la de B');
select is(pg_temp.acta_a('domain-s0.5', 'test.rules.ajuste'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'el acta siguiente lleva la versión nueva: company_settings olvida la memoria');
alter table public.igtf_instrument_classes disable trigger zz_rule_set_state;
update public.igtf_instrument_classes set legal_source = legal_source || ' (otra vez)';
alter table public.igtf_instrument_classes enable trigger zz_rule_set_state;
select is((select count(*)::int from platform.rule_set_drift()), 1,
  'ROTA: sin su trigger, la tabla nueva cambia y deja el hash viejo — rule_set_drift la ve');

-- S4: quien calcula el hash tiene que ver TODAS las reglas. Con un dueño sin BYPASSRLS la
-- función leería cero filas en silencio: falla, y lo dice.
grant create on schema platform to ladino_api;
grant execute on function platform.assert_rules_reader_sees_all() to ladino_api;
alter function platform.rules_global_hash() owner to ladino_api;
select throws_ok($$ select platform.rules_global_hash() $$, 'LAD00', null,
  'S4: el hash calculado por un rol sin BYPASSRLS no devuelve un hash de cero reglas: revienta');
alter function platform.rules_global_hash() owner to postgres;

-- ── 11. Segunda revisión (migración 20261004205000) ─────────────────────────
-- C1: la memoria de la transacción solo vale si nombra una versión de REGLAS.
select set_config('ladino.rules_version_cache',
                  'aaaa0122-0000-4000-8000-0000000000a1|db-guard', true);
select is(pg_temp.acta_a('domain-s0.5', 'test.c1.memoria'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'C1: con la memoria apuntando a una cadena de sistema (db-guard), el acta lleva la vigente');

-- C3: en un movimiento contable la procedencia no vive en rules_version. La MISMA expresión de
-- las funciones de reparación (GUC vacío ⇒ db-repair) deja el asiento con versión de reglas.
select set_config('ladino.rules_version', '', true);
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description, rules_version)
values ('aaaa0122-0000-4000-8000-00000000ae01', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1',
        platform.period_for_date('aaaa0122-0000-4000-8000-0000000000a1',
                                 platform.caracas_day(now())),
        platform.caracas_day(now()), 'exchange_diff', platform.uuidv7(),
        'treasury.currency_regularized', 'pgTAP 122: asiento de una reparación',
        coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'));
select is((select rules_version from public.journal_entries
            where id = 'aaaa0122-0000-4000-8000-00000000ae01'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'C3: un asiento que una reparación declara db-repair nace con la versión de reglas vigente');
select is(pg_temp.acta_a('db-repair', 'test.c3.acta'), 'db-repair',
  'en un ACTA la cadena de sistema sigue valiendo: ahí es procedencia');

-- C4: una factura de proveedor posteada por SQL sin versión (los fixtures de los E2E) se sella.
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0122-0000-4000-8000-0000000000c9', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'J-122-PROV', 'Proveedor 122', 'nacional',
        'ordinario', 'juridica');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount)
values ('aaaa0122-0000-4000-8000-0000000000f9', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'aaaa0122-0000-4000-8000-0000000000c9',
        'F122-1', '00-1221', platform.caracas_day(now()), 'posted', now(), 500, 80, 580, true,
        'VES', 'VES', 1, 'identidad', 580, 580);
select is((select rules_version from public.supplier_invoices
            where id = 'aaaa0122-0000-4000-8000-0000000000f9'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'C4: una factura de proveedor posteada sin versión nace con la vigente');
alter table public.supplier_invoices disable trigger supplier_invoices_90_rules_version;
update public.supplier_invoices set supplier_document_number = 'F122-1'
 where id = 'aaaa0122-0000-4000-8000-0000000000f9';
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount)
values ('aaaa0122-0000-4000-8000-0000000000fa', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'aaaa0122-0000-4000-8000-0000000000c9',
        'F122-2', '00-1222', platform.caracas_day(now()), 'posted', now(), 500, 80, 580, true,
        'VES', 'VES', 1, 'identidad', 580, 580);
alter table public.supplier_invoices enable trigger supplier_invoices_90_rules_version;
select is(
  (select count(*)::int from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
    where table_name = 'supplier_invoices' and problem = 'emitted_without_rules_version'), 1,
  'ROTA: sin el trigger la factura de proveedor posteada queda sin versión, y el invariante la ve');

-- Un borrador no congela: al emitirse declara de nuevo y se sella con la versión de ESE día.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0122-0000-4000-8000-00000000d005', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'quote', 'A',
        'aaaa0122-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'pgtap',
        116, 116, 100, 16, 116);
update rev set a = (select rules_version from public.documents
                     where id = 'aaaa0122-0000-4000-8000-00000000d005');
update public.company_settings set absorb_igtf = not absorb_igtf
 where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
update public.documents set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-00000000d005';
select ok(
  (select rules_version = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1')
          and rules_version <> (select a from rev)
     from public.documents where id = 'aaaa0122-0000-4000-8000-00000000d005'),
  'un BORRADOR que vuelve a declarar tras un cambio de regla se sella con la versión nueva');

-- C5: un invariante sin su corte no afirma cero: revienta.
create temp table cortes as select * from platform.invariant_cutoffs
 where invariant in ('rules_version_gaps', 'global_rate_record_gaps');
delete from platform.invariant_cutoffs
 where invariant in ('rules_version_gaps', 'global_rate_record_gaps');
select throws_ok(
  $$ select * from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1') $$,
  'LAD00', null, 'C5: rules_version_gaps sin la fila de su corte falla, no devuelve cero filas');
select throws_ok($$ select * from platform.global_rate_record_gaps() $$,
  'LAD00', null, 'C5: global_rate_record_gaps, igual');
insert into platform.invariant_cutoffs select * from cortes;

-- C5: CADA ajuste que entra en el hash cambia la versión de la empresa.
create function pg_temp.cambia(p_sql text) returns boolean language plpgsql as $$
declare v0 text := pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1');
begin
  execute p_sql;
  return pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1') <> v0;
end $$;
select ok(pg_temp.cambia(format(
         'update public.%s where company_id = %L', a.cambio,
         'aaaa0122-0000-4000-8000-0000000000a1')),
       'C5: cambiar ' || a.nombre || ' cambia la versión')
  from (values
    ('company_settings.absorb_igtf', 'company_settings set absorb_igtf = not absorb_igtf'),
    ('company_settings.retention_received_voucher_rate',
     'company_settings set retention_received_voucher_rate = not retention_received_voucher_rate'),
    ('company_settings.four_eyes', 'company_settings set four_eyes = true'),
    ('company_settings.supplier_payment_approval_threshold',
     'company_settings set supplier_payment_approval_threshold = supplier_payment_approval_threshold + 1'),
    ('company_settings.supplier_payment_approval_currency',
     'company_settings set supplier_payment_approval_currency = ''VES'''),
    ('purchase_settings.price_tolerance_pct',
     'purchase_settings set price_tolerance_pct = price_tolerance_pct + 1'),
    ('purchase_settings.retention_voucher_mode',
     'purchase_settings set retention_voucher_mode = ''per_fortnight''')
  ) as a(nombre, cambio);

-- C6: TODA columna de los ajustes está clasificada «regla» o «no regla». Una columna nueva sin
-- clasificar pone esto en rojo: quien la añade decide si entra en el hash (ADR-0079 §2).
select set_eq(
  $$ select table_name::text || '.' || column_name::text from information_schema.columns
      where table_schema = 'public' and table_name in ('company_settings', 'purchase_settings') $$,
  array[
    -- REGLA: entran en platform.current_rules_version.
    'company_settings.absorb_igtf', 'company_settings.retention_received_voucher_rate',
    'company_settings.four_eyes', 'company_settings.supplier_payment_approval_threshold',
    'company_settings.supplier_payment_approval_currency',
    'purchase_settings.price_tolerance_pct', 'purchase_settings.retention_voucher_mode',
    -- NO REGLA: identidad, procedencia y operación.
    'company_settings.company_id', 'company_settings.tenant_id', 'company_settings.created_by',
    'company_settings.created_at', 'company_settings.version',
    'company_settings.sells_wholesale', 'company_settings.block_sale_without_stock',
    'company_settings.default_tax_category_code', 'company_settings.default_warehouse_id',
    'company_settings.allow_unidentified_sales', 'company_settings.default_price_list_id',
    'company_settings.print_control_number', 'company_settings.rows_per_free_form',
    'purchase_settings.company_id', 'purchase_settings.tenant_id',
    'purchase_settings.created_by', 'purchase_settings.created_at', 'purchase_settings.version'],
  'C6: toda columna de company_settings y purchase_settings está clasificada regla / no regla');

-- C5: el conjunto EXACTO de tablas con cada trigger. Si uno desaparece, rojo.
select set_eq(
  $$ select tgrelid::regclass::text from pg_trigger
      where tgname = 'zz_rule_set_state' and tgenabled <> 'D' $$,
  array['tax_calendar_entries', 'tax_units', 'igtf_rules', 'igtf_instrument_classes',
        'igtf_exemptions', 'iva_retention_portions', 'retention_concepts',
        'retention_exclusions', 'tax_exemption_literals', 'tax_reduced_rate_literals',
        'tax_rule_templates', 'fiscal_regimes', 'platform.parameters'],
  'C5: las 13 tablas de reglas globales, y solo ellas, recalculan el hash global');
select set_eq(
  $$ select tgrelid::regclass::text from pg_trigger
      where tgname = 'zz_rules_version_cache' and tgenabled <> 'D' $$,
  array['tax_rules', 'retention_rules', 'company_fiscal_regimes', 'company_taxpayer_types',
        'igtf_company_instruments', 'company_fiscal_deadlines', 'company_settings',
        'purchase_settings'],
  'C5: las 8 tablas de reglas de empresa, y solo ellas, olvidan la versión recordada');

-- C7: de platform.parameters entra la clave y el valor normalizado; la nota es prosa.
update platform.parameters set value = value where false;   -- recalcula tras la ROTA de H4
update platform.parameters set note = note where key = 'closing_rate_max_age_days';
update rev set b = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1');
update platform.parameters set note = note || ' (pgTAP 122: nota reescrita)'
 where key = 'closing_rate_max_age_days';
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from rev),
  'C7: reescribir la NOTA de un parámetro no cambia la versión de nadie');
update platform.parameters set value = value + 0.0 where key = 'closing_rate_max_age_days';
select is(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from rev),
  'C7: 7 y 7.0 son el mismo umbral');
update platform.parameters set value = value + 1 where key = 'closing_rate_max_age_days';
select isnt(pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000b1'), (select b from rev),
  'y cambiar el VALOR sí la cambia');

-- Toda tasa global tiene su acta. De las tres de la sección 9: la directa recibió la suya, la
-- del dominio trae la de captura, y la que entró con el trigger desactivado no tiene ninguna.
select results_eq(
  $$ select rate_id from platform.global_rate_record_gaps()
      where rate_id::text like 'aaaa0122-0000-4000-8000-00000000f0a%' $$,
  $$ values ('aaaa0122-0000-4000-8000-00000000f0a3'::uuid) $$,
  'global_rate_record_gaps: solo sale la tasa que entró sin trigger (la variante rota de 9)');

-- ── 12. Quinta pasada (migración 20261004205200): B1 y B3 ───────────────────
-- B1 · CONGELADA ES CONGELADA, sea cual sea la clase de la versión vieja. Un asiento POSTEADO
-- heredado, con la cadena fija `domain-s0.5` (así están todos los anteriores a ADR-0079): se
-- fabrica con el trigger de la versión y el de la partida doble apagados, que es la única forma de que exista hoy.
alter table public.journal_entries disable trigger journal_entries_90_rules_version;
alter table public.journal_entries disable trigger journal_entries_02_balanced;
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description, rules_version,
   status, posted_at, posted_by, entry_number)
values ('aaaa0122-0000-4000-8000-00000000ae12', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1',
        platform.period_for_date('aaaa0122-0000-4000-8000-0000000000a1',
                                 platform.caracas_day(now())),
        platform.caracas_day(now()), 'manual', 'pgTAP 122: asiento posteado heredado',
        'domain-s0.5', 'posted', now(), 'aaaa0122-0000-4000-8000-0000000000e1',
        platform.claim_entry_number('aaaa0122-0000-4000-8000-0000000000a1',
                                    extract(year from platform.caracas_day(now()))::int));
alter table public.journal_entries enable trigger journal_entries_02_balanced;
alter table public.journal_entries enable trigger journal_entries_90_rules_version;
-- El UPDATE que nombra la columna con el MISMO valor pasa journal_entries_03_immutable (nada
-- cambió todavía) y llega al trigger de la versión, que corre después: es el camino que resellaba.
update public.journal_entries set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-00000000ae12';
select is((select rules_version from public.journal_entries
            where id = 'aaaa0122-0000-4000-8000-00000000ae12'), 'domain-s0.5',
  'B1: un asiento posteado HEREDADO (domain-s0.5) que recibe un UPDATE nombrando rules_version la conserva: no se resella con la versión de hoy');

-- La factura de proveedor posteada SIN versión de la sección 11 (entró con el trigger apagado):
-- heredada también, y tampoco se resella.
update public.supplier_invoices set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-0000000000fa';
select is((select rules_version from public.supplier_invoices
            where id = 'aaaa0122-0000-4000-8000-0000000000fa'), null,
  'B1: una factura de proveedor posteada heredada sin versión sigue sin versión: no se le inventa la de hoy');

-- Y una fila ya emitida no acepta OTRA versión de reglas registrada: la f9 nació con la vigente
-- de su momento; cambia una regla y el UPDATE trae, a mano, la versión nueva.
create temp table quinta (f9 text, borrador text);
grant all on quinta to public;
insert into quinta (f9) select rules_version from public.supplier_invoices
 where id = 'aaaa0122-0000-4000-8000-0000000000f9';
update public.company_settings set absorb_igtf = not absorb_igtf
 where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
select platform.freeze_rules_version('aaaa0122-0000-4000-8000-0000000000a1');
update public.supplier_invoices
   set rules_version = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1')
 where id = 'aaaa0122-0000-4000-8000-0000000000f9';
select ok(
  (select s.rules_version = q.f9
          and s.rules_version <> pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1')
     from public.supplier_invoices s, quinta q
    where s.id = 'aaaa0122-0000-4000-8000-0000000000f9'),
  'B1: una factura ya posteada no cambia su versión por OTRA versión de reglas registrada que traiga el UPDATE');

-- Lo que SÍ sella: un borrador que PASA a estado final declarando de nuevo (B2, lado de la base).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount)
values ('aaaa0122-0000-4000-8000-0000000000fb', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'aaaa0122-0000-4000-8000-0000000000c9',
        'F122-3', '00-1223', platform.caracas_day(now()), 'draft', 500, 80, 580, true,
        'VES', 'VES', 1, 'identidad', 580, 580);
update quinta set borrador = (select rules_version from public.supplier_invoices
                               where id = 'aaaa0122-0000-4000-8000-0000000000fb');
update public.company_settings set absorb_igtf = not absorb_igtf
 where company_id = 'aaaa0122-0000-4000-8000-0000000000a1';
update public.supplier_invoices
   set status = 'posted', posted_at = now(), rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-0000000000fb';
select ok(
  (select s.rules_version = pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1')
          and s.rules_version <> q.borrador
     from public.supplier_invoices s, quinta q
    where s.id = 'aaaa0122-0000-4000-8000-0000000000fb'),
  'B2: el borrador guardado con una versión y posteado tras un cambio de regla lleva la versión del día del POSTEO');

-- B3 · el invariante juzga por el instante del ESTADO FINAL. Un documento creado ANTES del corte
-- y emitido DESPUÉS, con una cadena de sistema (entra con el trigger apagado): la cláusula (1) no
-- lo mira (su `created_at` es anterior) y la (2) sí.
alter table public.documents disable trigger documents_90_rules_version;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0122-0000-4000-8000-00000000d012', 'aaaa0122-0000-4000-8000-00000000000a',
        'aaaa0122-0000-4000-8000-0000000000a1', 'invoice', 'A',
        'aaaa0122-0000-4000-8000-00000000c001', 12, 12212, 'issued', now() + interval '2 hours',
        'aaaa0122-0000-4000-8000-00000000e101', 'regularizacion-ola2',
        'VES', 'VES', 1, 'pgtap', 116, 116, 100, 16, 116);
alter table public.documents enable trigger documents_90_rules_version;
update platform.invariant_cutoffs set since = now() + interval '1 hour'
 where invariant = 'rules_version_gaps';
select results_eq(
  $$ select problem from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
      where row_id = 'aaaa0122-0000-4000-8000-00000000d012' $$,
  $$ values ('emitted_without_rules_version'::text) $$,
  'B3: el borrador anterior al corte que se emite DESPUÉS del corte se juzga (por issued_at), y solo por la cláusula (2)');
-- Variante rota: con el corte después de su emisión, ni ese se juzga. Si saliera igual, lo de
-- arriba no lo estaría decidiendo el instante de emisión.
update platform.invariant_cutoffs set since = now() + interval '3 hours'
 where invariant = 'rules_version_gaps';
select is(
  (select count(*)::int from platform.rules_version_gaps('aaaa0122-0000-4000-8000-0000000000a1')
    where row_id = 'aaaa0122-0000-4000-8000-00000000d012'), 0,
  'B3 · ROTA: con el corte posterior a su emisión el mismo documento no se juzga: lo decide issued_at');
update platform.invariant_cutoffs set since = now() - interval '1 hour'
 where invariant = 'rules_version_gaps';

-- B1 · VARIANTE ROTA, al final porque sustituye la función: con la definición de la 20261004205000
-- (literal) el MISMO UPDATE sobre el MISMO asiento posteado heredado lo resella con la versión de
-- hoy, en silencio: journal_entries_03_immutable corre antes y no ve cambio. Si aquí no se
-- resellara, la aserción de arriba no estaría midiendo la 20261004205200.
create or replace function platform.stamp_rules_version()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  -- Documento fiscal o movimiento contable (regla 3): solo admite una versión de REGLAS.
  -- Una tabla nueva con `rules_version` que sea una de las dos cosas se añade AQUÍ y al
  -- enunciado de platform.rules_version_gaps.
  v_estricta boolean := tg_table_name in (
    'documents', 'supplier_invoices', 'retention_vouchers', 'supplier_retentions',
    'inventory_withdrawal_notes', 'journal_entries');
  v_key   text;
  v_cache text;
  v       text;
  v_estado text;
begin
  -- Lo que trae la fila: ¿es ya una versión de reglas registrada? Entonces se respeta.
  if new.rules_version is not null and new.rules_version <> 'domain-s0.5' then
    if exists (select 1 from platform.rules_versions r
                where r.version = new.rules_version and r.kind = 'rules') then
      return new;
    end if;
    -- En un acta, una cuenta o la historia del tipo de contribuyente, otra cadena es
    -- PROCEDENCIA (db-guard, db-migration…) y se deja; si no está registrada, lo dice el
    -- invariante. En un documento o un asiento no se admite: se sella.
    if not v_estricta then
      return new;
    end if;
  elsif new.rules_version is null and not v_estricta then
    return new;
  end if;

  -- Congelada es congelada: un UPDATE que vuelve a declarar no cambia la versión de reglas de
  -- una fila ya emitida. Un borrador (draft, confirmed, cancelled) todavía no congeló nada: al
  -- emitirse declara de nuevo y se sella con la versión del día en que se emite.
  if tg_op = 'UPDATE' and exists (
       select 1 from platform.rules_versions r
        where r.version = old.rules_version and r.kind = 'rules') then
    v_estado := pg_catalog.to_jsonb(old) ->> 'status';
    if v_estado is null or v_estado not in ('draft', 'confirmed', 'cancelled') then
      new.rules_version := old.rules_version;
      return new;
    end if;
  end if;

  -- Una transacción, una versión por empresa. La memoria es un GUC local que borra todo cambio
  -- de regla; solo vale si nombra una versión de REGLAS registrada (C1): escribir a mano una
  -- cadena de sistema en el GUC no hace nacer una fila con ella.
  v_key := coalesce(new.company_id::text, '-');
  v_cache := pg_catalog.current_setting('ladino.rules_version_cache', true);
  if v_cache is not null and pg_catalog.split_part(v_cache, '|', 1) = v_key then
    v := pg_catalog.split_part(v_cache, '|', 2);
    if exists (select 1 from platform.rules_versions r
                where r.version = v and r.kind = 'rules') then
      new.rules_version := v;
      return new;
    end if;
  end if;
  v := platform.freeze_rules_version(new.company_id);
  perform pg_catalog.set_config('ladino.rules_version_cache', v_key || '|' || v, true);
  new.rules_version := v;
  return new;
end;
$function$;
update public.journal_entries set rules_version = 'domain-s0.5'
 where id = 'aaaa0122-0000-4000-8000-00000000ae12';
select is((select rules_version from public.journal_entries
            where id = 'aaaa0122-0000-4000-8000-00000000ae12'),
          pg_temp.vigente('aaaa0122-0000-4000-8000-0000000000a1'),
  'ROTA: con la definición de la 205000 el asiento posteado heredado se resella con la versión de hoy; lo que lo conserva es la 205200');

select * from finish();
rollback;
