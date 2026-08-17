-- =============================================================================
-- Ladino — pgTAP 8 · `audit_events`
--
-- Cubre la migración 1/4 de S0.4. El foco no es "la tabla existe": es que las
-- DOS capas de inmutabilidad funcionan POR SEPARADO, que el aislamiento
-- aguanta con un usuario multi-tenant, y que la columna generada no se puede
-- falsificar.
--
-- LO QUE ESTE FICHERO HACE Y NO ES OBVIO: para probar el trigger de
-- append-only hay que CONCEDER a propósito el privilegio que la migración
-- revoca. Sin eso, el `update` como service_role falla con 42501 —privilegio—
-- y nunca llega al trigger: se probaría la capa de arriba dos veces y la de
-- abajo ninguna, creyendo tener dos defensas. Es la lección "dos capas, la de
-- abajo actúa primero" de la skill, aplicada al revés: para auditar la de
-- abajo hay que apartar la de arriba.
-- =============================================================================

begin;
select plan(45);

-- =============================================================================
-- Escenario: UN usuario con membership en DOS tenants — obligatorio desde S0.3
--
-- U tiene fiscal.audit.read en A1 y en B1, y NO en A2. A2 es el caso que
-- importa: misma company del MISMO tenant, sin el permiso. Un aislamiento que
-- solo separa tenants no dice nada sobre él.
-- =============================================================================

insert into auth.users (id) values
  ('aaaaaaaa-1111-4111-8111-00000000000a'),   -- U, multi-tenant, con permiso
  ('bbbbbbbb-2222-4222-8222-00000000000b');   -- V, miembro de A, sin permiso

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
  ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001', 'J-A1', 'Empresa A1'),
  ('11111111-1111-4111-8111-0000000000a2', '11111111-1111-4111-8111-000000000001', 'J-A2', 'Empresa A2'),
  ('22222222-2222-4222-8222-0000000000b1', '22222222-2222-4222-8222-000000000001', 'J-B1', 'Empresa B1');

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('33333333-3333-4333-8333-000000000001', null, 'auditor', 'Auditor', false);
insert into public.role_permissions (role_id, permission_key) values
  ('33333333-3333-4333-8333-000000000001', 'fiscal.audit.read');

insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001', 'aaaaaaaa-1111-4111-8111-00000000000a'),
  ('44444444-4444-4444-8444-00000000000b', '22222222-2222-4222-8222-000000000001', 'aaaaaaaa-1111-4111-8111-00000000000a'),
  ('44444444-4444-4444-8444-00000000000c', '11111111-1111-4111-8111-000000000001', 'bbbbbbbb-2222-4222-8222-00000000000b');

-- U es auditor en A1 y en B1. En A2, nada.
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('55555555-5555-4555-8555-000000000001', '11111111-1111-4111-8111-000000000001',
   '44444444-4444-4444-8444-00000000000a', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-0000000000a1'),
  ('55555555-5555-4555-8555-000000000002', '22222222-2222-4222-8222-000000000001',
   '44444444-4444-4444-8444-00000000000b', '33333333-3333-4333-8333-000000000001',
   '22222222-2222-4222-8222-0000000000b1');

-- Cuatro eventos: A1, A2, B1 y uno de NIVEL TENANT (company_id NULL).
insert into public.audit_events
  (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   actor_type, occurred_at, rules_version, payload) values
  ('66666666-6666-4666-8666-0000000000a1', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-0000000000a1', 'invoice',
   '77777777-7777-4777-8777-000000000001', 'invoice.issued', 'user', now(), '2026.1',
   '{"total":"100.00"}'),
  ('66666666-6666-4666-8666-0000000000a2', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-0000000000a2', 'invoice',
   '77777777-7777-4777-8777-000000000002', 'invoice.issued', 'user', now(), '2026.1',
   '{"total":"SECRETO DE A2"}'),
  ('66666666-6666-4666-8666-0000000000b1', '22222222-2222-4222-8222-000000000001',
   '22222222-2222-4222-8222-0000000000b1', 'invoice',
   '77777777-7777-4777-8777-000000000003', 'invoice.issued', 'user', now(), '2026.1',
   '{"total":"300.00"}'),
  ('66666666-6666-4666-8666-0000000000ff', '11111111-1111-4111-8111-000000000001',
   null, 'company',
   '11111111-1111-4111-8111-0000000000a1', 'company.created', 'system', now(), '2026.1',
   '{"nivel":"tenant"}');


-- =============================================================================
-- 1. INMUTABILIDAD, CAPA DE ARRIBA: los privilegios
--
-- service_role tiene BYPASSRLS y escapa a las policies, pero NO a los GRANT.
-- =============================================================================

select ok(not has_table_privilege('service_role', 'public.audit_events', 'UPDATE'),
  'CAPA 1: service_role NO tiene privilegio de UPDATE sobre audit_events');
select ok(not has_table_privilege('service_role', 'public.audit_events', 'DELETE'),
  'CAPA 1: service_role NO tiene privilegio de DELETE');
select ok(not has_table_privilege('service_role', 'public.audit_events', 'TRUNCATE'),
  'CAPA 1: service_role NO tiene privilegio de TRUNCATE');

-- Y el camino autorizado SÍ está abierto. Una defensa que cierra la única vía
-- legítima no es una defensa, es una avería silenciosa (ADR-0023): si
-- service_role no pudiera insertar, no habría auditoría en absoluto y los tres
-- checks de arriba seguirían en verde.
select ok(has_table_privilege('service_role', 'public.audit_events', 'INSERT'),
  'pero service_role SÍ puede INSERT: el camino autorizado queda abierto');
select ok(has_table_privilege('service_role', 'public.audit_events', 'SELECT'),
  'y SÍ puede SELECT');

-- Y AHORA SE EJERCE, que no es lo mismo. Los dos checks de arriba consultan un
-- BIT del catálogo; este ejecuta el camino. La diferencia no es teórica: la
-- primera versión de la migración no concedía EXECUTE sobre
-- platform.audit_payload_hash(), y como una columna generada evalúa su
-- expresión con los privilegios de quien inserta, service_role recibía
-- «permission denied for function audit_payload_hash». La tabla estaba
-- ESCRIBIBLE POR NADIE — auditoría muerta — con los dos checks de arriba en
-- verde. Un privilegio concedido no es un camino que funcione.
set local role service_role;
select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-0000000000e1', 'invoice.issued', 'system',
             now(), '2026.1', '{"via":"service_role"}') $$,
  'y el INSERT como service_role FUNCIONA de verdad, no solo en el catálogo: '
  'es el único camino por el que se escribe auditoría y tiene que estar abierto');
reset role;

set local role service_role;
select throws_ok(
  $$ update public.audit_events set rules_version = 'falsificada' $$,
  '42501',
  null,
  'como service_role, el UPDATE muere en los privilegios antes de llegar a la RLS');
reset role;


-- =============================================================================
-- 2. INMUTABILIDAD, CAPA DE ABAJO: el trigger
--
-- Se concede el privilegio A PROPÓSITO para apartar la capa de arriba y poder
-- comprobar que debajo hay algo. Es el escenario real de "alguien concede un
-- GRANT amplio dentro de un año y nadie recuerda por qué la tabla estaba a
-- salvo".
-- =============================================================================

grant update, delete, truncate on public.audit_events to service_role;

set local role service_role;
select throws_ok(
  $$ update public.audit_events set rules_version = 'falsificada' $$,
  'LAD06',
  null,
  'CAPA 2: concedido el UPDATE, el trigger lo rechaza igual con LAD06');
select throws_ok(
  $$ delete from public.audit_events $$,
  'LAD06',
  null,
  'CAPA 2: concedido el DELETE, LAD06');
select throws_ok(
  $$ truncate public.audit_events $$,
  'LAD06',
  null,
  'CAPA 2: concedido el TRUNCATE, LAD06. Es el enganche FOR EACH STATEMENT: '
  'TRUNCATE ignora la RLS y no dispara triggers de fila');
reset role;

revoke update, delete, truncate on public.audit_events from service_role;

-- Y alcanza también al dueño de la tabla, que no pasa por GRANT ninguno.
select throws_ok(
  $$ update public.audit_events set rules_version = 'falsificada' $$,
  'LAD06',
  null,
  'el trigger alcanza incluso al DUEÑO de la tabla: no hay rol que lo esquive');
select throws_ok(
  $$ truncate public.audit_events $$,
  'LAD06',
  null,
  'y el TRUNCATE del dueño también');


-- =============================================================================
-- 3. `authenticated` no escribe auditoría. Ni una sola vía.
-- =============================================================================

select ok(not has_table_privilege('authenticated', 'public.audit_events', 'INSERT'),
  'authenticated NO tiene privilegio de INSERT: no puede fabricar eventos');
select ok(not has_table_privilege('authenticated', 'public.audit_events', 'UPDATE'),
  'ni de UPDATE');
select ok(not has_table_privilege('authenticated', 'public.audit_events', 'DELETE'),
  'ni de DELETE');
select ok(not has_table_privilege('authenticated', 'public.audit_events', 'TRUNCATE'),
  'ni de TRUNCATE');
select ok(has_table_privilege('authenticated', 'public.audit_events', 'SELECT'),
  'authenticated SÍ puede SELECT: la auditoría es un producto para el usuario');
select ok(not has_table_privilege('anon', 'public.audit_events', 'SELECT'),
  'anon no tiene NADA, ni siquiera SELECT');

-- Las denegaciones están ESCRITAS, no son ausencia de policy.
select is(
  (select count(*) from pg_policy where polrelid = 'public.audit_events'::regclass),
  4::bigint,
  'hay CUATRO policies: una de lectura y tres denegaciones escritas. Una policy '
  'ausente es indistinguible de un olvido');


-- =============================================================================
-- 4. AISLAMIENTO con el usuario multi-tenant
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;

select is((select count(*) from public.audit_events
            where company_id = '11111111-1111-4111-8111-0000000000a1'
              and event_type = 'invoice.issued'), 2::bigint,
  'U ve los eventos de A1, donde tiene fiscal.audit.read');

select is((select count(*) from public.audit_events
            where company_id = '22222222-2222-4222-8222-0000000000b1'
              and event_type = 'invoice.issued'), 1::bigint,
  'y los de B1, en el OTRO tenant, donde también lo tiene');

-- Desde la migración 5/5, dar de alta una company deja su propio evento
-- (`company.tax_id_established`): sin él, la identidad fiscal bajo la que se
-- emiten los primeros documentos no tenía rastro. Se comprueba que ese evento
-- nuevo respeta el MISMO aislamiento que los demás y no abre una vía lateral.
select is((select count(*) from public.audit_events
            where event_type = 'company.tax_id_established'), 2::bigint,
  'U ve el alta del RIF de A1 y de B1 — y solo esas dos de las tres companies '
  'creadas: el evento nuevo respeta el aislamiento por permiso');

select is((select payload ->> 'tax_id_anterior' from public.audit_events
            where event_type = 'company.tax_id_established'
              and company_id = '11111111-1111-4111-8111-0000000000a1'),
  null,
  'y en el alta `tax_id_anterior` es NULL EXPLÍCITO, no una clave ausente: se '
  'distingue «no había anterior» de «no se registró»');

select is((select count(*) from public.audit_events
            where company_id = '11111111-1111-4111-8111-0000000000a2'), 0::bigint,
  'pero NO los de A2: misma company del MISMO tenant, sin el permiso. El '
  'aislamiento no es solo entre tenants, es también dentro de uno');

select is((select count(*) from public.audit_events where company_id is null), 0::bigint,
  'ni el evento de NIVEL TENANT: company_id NULL queda fuera por decisión '
  'explícita (ADR-0026 D3), no por descuido. No hay función de permiso a nivel '
  'de tenant, y abrirlo por "company_id is null or ..." lo haría visible a '
  'CUALQUIER miembro del tenant');

select is((select count(*) from public.audit_events), 5::bigint,
  'en total U ve exactamente CINCO: tres de A1 (dos facturas y el alta del RIF) '
  'y dos de B1 (una factura y su alta). Fuera quedan los de A2 y el de nivel '
  'tenant');

select is((select count(*) from public.audit_events
            where payload::text like '%SECRETO%'), 0::bigint,
  'y el payload de A2 no se filtra por ninguna vía');

reset role;

-- V es miembro de A pero no tiene el permiso.
select set_config('request.jwt.claims',
  '{"sub":"bbbbbbbb-2222-4222-8222-00000000000b","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.audit_events), 0::bigint,
  'V es miembro de A pero sin fiscal.audit.read: no ve NADA. Pertenecer al '
  'tenant no basta');
reset role;
select set_config('request.jwt.claims', null, true);


-- =============================================================================
-- 5. La columna generada
-- =============================================================================

select is(
  (select payload_hash from public.audit_events
    where id = '66666666-6666-4666-8666-0000000000a1'),
  sha256(convert_to('{"total": "100.00"}'::jsonb #>> '{}', 'UTF8')),
  'payload_hash es reproducible desde el payload: es verificable, no decorativo');

select is(
  (select platform.audit_payload_hash('{"a":1,"b":2}'::jsonb)),
  platform.audit_payload_hash('{"b":2,"a":1}'::jsonb),
  'CANONICIDAD: el mismo objeto con las claves en otro orden da el MISMO hash. '
  'No hace falta implementar RFC 8785: jsonb ya guarda las claves ordenadas');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, aggregate_type, aggregate_id, event_type, actor_type,
        occurred_at, rules_version, payload_hash)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued', 'system',
             now(), '2026.1', '\x00') $$,
  '428C9',
  null,
  'el hash NO se puede fijar a mano ni siendo dueño de la tabla: una columna '
  'generada es más fuerte que un trigger, que se puede olvidar de enganchar');


-- =============================================================================
-- 6. Constraints
-- =============================================================================

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued', 'user',
             now() + interval '1 hour', '2026.1') $$,
  'LAD30',
  null,
  'occurred_at en el FUTURO se rechaza, con LAD30 desde la migración 6/6: la '
  'validación se movió a un trigger porque comparar contra created_at gastaba '
  'la tolerancia en la duración de la transacción');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, aggregate_type, aggregate_id, event_type, actor_type,
        occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'Se emitió la factura',
             'system', now(), '2026.1') $$,
  '23514',
  null,
  'event_type con forma libre se rechaza: impide que el campo degenere en prosa '
  'mientras el catálogo de eventos se difiere (R-04)');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, aggregate_type, aggregate_id, event_type, actor_type,
        occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued',
             'root', now(), '2026.1') $$,
  '23514',
  null,
  'actor_type solo admite user o system');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001',
             '22222222-2222-4222-8222-0000000000b1', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued', 'system',
             now(), '2026.1') $$,
  '23503',
  null,
  'CRUZADO: un evento del tenant A no se puede colgar de una company de B. La '
  'FK compuesta (tenant_id, company_id) lo impide');

select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version)
     values ('11111111-1111-4111-8111-000000000001', null, 'company',
             '77777777-7777-4777-8777-000000000009', 'company.created', 'system',
             now(), '2026.1') $$,
  'pero company_id NULL SÍ se admite: la FK compuesta no se evalúa (MATCH '
  'SIMPLE), que es justo lo que necesitan los eventos de nivel tenant');


-- =============================================================================
-- 7. Procedencia: el cliente no elige quién ni cuándo
-- =============================================================================

select set_config('ladino.actor_id', 'aaaaaaaa-1111-4111-8111-00000000000a', true);

insert into public.audit_events
  (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   actor_type, occurred_at, rules_version,
   created_by, created_at, version)
values
  ('88888888-8888-4888-8888-000000000001', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-0000000000a1', 'invoice',
   '77777777-7777-4777-8777-00000000000f', 'invoice.voided', 'user', now(), '2026.1',
   -- lo que el cliente INTENTA imponer:
   '00000000-0000-4000-8000-000000000000', '1999-01-01T00:00:00Z', 99);

select is(
  (select created_by from public.audit_events
    where id = '88888888-8888-4888-8888-000000000001'),
  'aaaaaaaa-1111-4111-8111-00000000000a'::uuid,
  'created_by lo pone el servidor desde el GUC, NO el cliente: la fila que el '
  'cliente atribuía a 00000000… queda atribuida a su actor real');

select ok(
  (select created_at from public.audit_events
    where id = '88888888-8888-4888-8888-000000000001') > '2020-01-01'::timestamptz,
  'y created_at es de ahora, no el 1999 que mandó el cliente. Antedatar la '
  'pista de auditoría es falsificarla (regla 3 de CLAUDE.md)');

select is(
  (select version from public.audit_events
    where id = '88888888-8888-4888-8888-000000000001'),
  1,
  'version arranca en 1 aunque el cliente mandara 99 (columna muerta aquí, '
  'viva por uniformidad del trigger)');

select set_config('ladino.actor_id', null, true);


-- =============================================================================
-- 8. Propiedades del catálogo — que no dependan de acordarse
-- =============================================================================

select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.audit_events'::regclass),
  'RLS habilitada Y FORZADA');

select is(
  (select count(*) from pg_trigger
    where tgrelid = 'public.audit_events'::regclass and not tgisinternal),
  5::bigint,
  'los CINCO triggers están enganchados: procedencia, anclas, append-only de '
  'fila, append-only de statement y la validación de occurred_at (6/6)');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.audit_events'::regclass
             and tgname = 'audit_events_no_truncate'
             and (tgtype::int & 32) <> 0),   -- 32 = TRUNCATE
  'y el de TRUNCATE es realmente de TRUNCATE, no un FOR EACH ROW mal puesto que '
  'nunca dispararía');

select ok(
  exists (select 1 from public.permissions where key = 'fiscal.audit.read'),
  'fiscal.audit.read tiene FILA en permissions. Una policy que exige un permiso '
  'inexistente cierra la lectura a todo el mundo con aspecto de estar configurada');

select is(
  (select count(*) from pg_attribute
    where attrelid = 'public.audit_events'::regclass
      and attname in ('actor_id', 'server_received_at') and not attisdropped),
  0::bigint,
  'NO existen actor_id ni server_received_at: son created_by y created_at con '
  'otro nombre, y dos columnas para el mismo dato acaban divergiendo (D8)');

select ok(
  (select attgenerated = 's' from pg_attribute
    where attrelid = 'public.audit_events'::regclass and attname = 'payload_hash'),
  'payload_hash es GENERATED ALWAYS STORED en el catálogo, no un trigger que '
  'alguien pueda desenganchar');

select * from finish();
rollback;
