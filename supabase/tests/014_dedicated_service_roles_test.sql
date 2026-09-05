-- =============================================================================
-- Ladino — pgTAP 14 · Roles de servicio sin BYPASSRLS (migración 14, ADR-0031)
--
-- LO QUE PRUEBA, en el orden en que importa:
--   1. Catálogo: ninguno de los dos roles tiene BYPASSRLS ni SUPERUSER. Se
--      consulta, no se supone.
--   2. SEPARACIÓN DE CAMINOS: las policies de `authenticated` no leen el GUC.
--      Con JWT de A y el GUC apuntando a B, se ve A; sin JWT, el GUC no da
--      acceso NINGUNO. Esta propiedad tumbó el primer diseño (un coalesce en
--      las funciones compartidas) rompiendo seis suites: ahora es estructural
--      y tiene su variante rota abajo.
--   3. EJERCICIO como ladino_api, no bits de privilegio: con actor A, los datos
--      de B no se leen, no se actualizan (0 filas, dato intacto) y no se
--      insertan (42501). Con actor multi-tenant —la firma contable, el atacante
--      realista— se ven los dos. Sin actor, nada.
--   4. ladino_worker: lee y actualiza outbox de TODOS los tenants (es su
--      trabajo) y no puede ni nombrar companies (42501: privilegio, no RLS).
--   5. VARIANTES ROTAS, cada una con su restauración: una policy using(true)
--      hace visible a B (la aserción de aislamiento mide la RLS); un GRANT al
--      worker le deja leer companies (mide el privilegio); una policy de
--      authenticated que use las funciones DE SERVICIO deja que el GUC dé
--      acceso sin JWT (mide la separación de caminos).
--
-- COSTE: el predicado de servicio es un InitPlan por sentencia; el camino
-- caliente de authenticated (ladino_has_permission) no se tocó y lo sigue
-- midiendo el gate 013 contra el esquema final.
-- =============================================================================

begin;
select plan(35);

-- (pgTAP vive en `extensions`; los roles de servicio tienen USAGE ahí desde la
-- migración 14 — lo necesitan para pgcrypto — así que `is()` resuelve también
-- bajo ellos.)

-- ── Fixtures (como postgres, sin actor: created_by NULL, es fixture) ─────────
insert into auth.users (id) values
  ('aaaa0014-0000-4000-8000-0000000000a1'),   -- UA: solo tenant A
  ('aaaa0014-0000-4000-8000-0000000000b1'),   -- UB: solo tenant B
  ('aaaa0014-0000-4000-8000-0000000000c1');   -- UM: A y B (multi-tenant)
insert into public.tenants (id, name) values
  ('aaaa0014-0000-4000-8000-00000000000a', 'Tenant A'),
  ('aaaa0014-0000-4000-8000-00000000000b', 'Tenant B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0014-0000-4000-8000-0000000000a2', 'aaaa0014-0000-4000-8000-00000000000a', 'J-A1', 'Empresa A1'),
  ('aaaa0014-0000-4000-8000-0000000000b2', 'aaaa0014-0000-4000-8000-00000000000b', 'J-B1', 'Empresa B1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0014-0000-4000-8000-0000000000e1', null, 'lector14', 'Lector', false);
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0014-0000-4000-8000-0000000000a3', 'aaaa0014-0000-4000-8000-00000000000a', 'aaaa0014-0000-4000-8000-0000000000a1'),
  ('aaaa0014-0000-4000-8000-0000000000b3', 'aaaa0014-0000-4000-8000-00000000000b', 'aaaa0014-0000-4000-8000-0000000000b1'),
  ('aaaa0014-0000-4000-8000-0000000000c3', 'aaaa0014-0000-4000-8000-00000000000a', 'aaaa0014-0000-4000-8000-0000000000c1'),
  ('aaaa0014-0000-4000-8000-0000000000c4', 'aaaa0014-0000-4000-8000-00000000000b', 'aaaa0014-0000-4000-8000-0000000000c1');
-- Asignación tenant-wide para UA: la policy de `authenticated` sobre companies
-- pasa por ladino_company_ids(), que exige asignación.
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0014-0000-4000-8000-0000000000a4', 'aaaa0014-0000-4000-8000-00000000000a',
   'aaaa0014-0000-4000-8000-0000000000a3', 'aaaa0014-0000-4000-8000-0000000000e1', null);
insert into public.outbox (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version) values
  ('aaaa0014-0000-4000-8000-00000000000a', 'aaaa0014-0000-4000-8000-0000000000a2', 'company', platform.uuidv7(), 'company.created', 1),
  ('aaaa0014-0000-4000-8000-00000000000b', 'aaaa0014-0000-4000-8000-0000000000b2', 'company', platform.uuidv7(), 'company.created', 1);
-- Una clave de idempotencia de OTRO actor (UB) en el tenant A: UA no debe verla.
insert into public.idempotency_keys (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at) values
  ('aaaa0014-0000-4000-8000-00000000000a', null, 'aaaa0014-0000-4000-8000-0000000000b1',
   'K-DE-B', 'POST /x', '\x00'::bytea, now() + interval '1 hour');

-- ── 1. Catálogo ──────────────────────────────────────────────────────────────
select is(
  (select count(*) from pg_roles where rolname in ('ladino_api', 'ladino_worker')),
  2::bigint, 'existen los dos roles de servicio');
select is(
  (select count(*) from pg_roles
    where rolname in ('ladino_api', 'ladino_worker') and (rolbypassrls or rolsuper)),
  0::bigint, 'ninguno tiene BYPASSRLS ni SUPERUSER — consultado en pg_roles, no supuesto');

-- ── 2. Separación de caminos: el GUC no toca a authenticated ─────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaa0014-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
select set_config('ladino.actor_id', 'aaaa0014-0000-4000-8000-0000000000b1', true);
set local role authenticated;
select is((select count(*) from public.companies), 1::bigint,
  'authenticated con JWT de A y el GUC apuntando a B ve UNA company: la de A');
reset role;
select set_config('request.jwt.claims', '', true);
set local role authenticated;
select is((select count(*) from public.companies), 0::bigint,
  'y SIN JWT, el GUC no da acceso ninguno: las policies de authenticated no lo leen');
reset role;
select set_config('ladino.actor_id', '', true);

-- ── 3. ladino_api con actor A ────────────────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0014-0000-4000-8000-0000000000a1', true);
set local role ladino_api;

select is(platform.ladino_service_actor_id(), 'aaaa0014-0000-4000-8000-0000000000a1'::uuid,
  'el actor de servicio es el GUC');
select is((select count(*) from public.companies), 1::bigint,
  'ladino_api con actor A ve UNA company');
select is((select id from public.companies limit 1), 'aaaa0014-0000-4000-8000-0000000000a2'::uuid,
  'y es la de A');
select is((select count(*) from public.companies where id = 'aaaa0014-0000-4000-8000-0000000000b2'),
  0::bigint, 'la company de B por id: 0 filas');
-- UPDATE cross-tenant: no lanza, afecta 0 filas. Se comprueba el DATO después.
update public.companies set legal_name = 'SECUESTRADA'
 where id = 'aaaa0014-0000-4000-8000-0000000000b2';
select throws_ok(
  $$ insert into public.companies (tenant_id, tax_id, legal_name)
     values ('aaaa0014-0000-4000-8000-00000000000b', 'J-B9', 'Colada en B') $$,
  '42501', null, 'INSERT de una company en el tenant B con actor A → 42501 (RLS)');
select lives_ok(
  $$ insert into public.companies (tenant_id, tax_id, legal_name)
     values ('aaaa0014-0000-4000-8000-00000000000a', 'J-A9', 'Nueva en A') $$,
  'INSERT en el propio tenant funciona DE VERDAD (uuidv7, provenance, audit_tax_id: todo el camino)');
select is((select count(*) from public.tenants), 1::bigint, 'tenants: solo A');
select is(
  (select count(*) from (select id from public.tenants
     where id = 'aaaa0014-0000-4000-8000-00000000000a' for update) t),
  1::bigint, 'SELECT … FOR UPDATE sobre el propio tenant funciona (exige privilegio UPDATE)');
select is(
  (select count(*) from (select id from public.tenants
     where id = 'aaaa0014-0000-4000-8000-00000000000b' for update) t),
  0::bigint, 'FOR UPDATE sobre el tenant B: 0 filas, no se bloquea nada ajeno');
select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('aaaa0014-0000-4000-8000-00000000000b', 'aaaa0014-0000-4000-8000-0000000000b2',
             'company', platform.uuidv7(), 'company.created', 'user', now(), 'x', '{}') $$,
  '42501', null, 'audit_events en el tenant B → 42501');
select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('aaaa0014-0000-4000-8000-00000000000a', 'aaaa0014-0000-4000-8000-0000000000a2',
             'company', platform.uuidv7(), 'company.created', 'user', now(), 'x', '{"k":1}') $$,
  'audit_events en A funciona — incluida la columna generada payload_hash (EXECUTE concedido)');
select throws_ok(
  $$ insert into public.outbox (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('aaaa0014-0000-4000-8000-00000000000b', 'aaaa0014-0000-4000-8000-0000000000b2',
             'company', platform.uuidv7(), 'company.created', 1) $$,
  '42501', null, 'outbox en el tenant B → 42501');
select lives_ok(
  $$ insert into public.outbox (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('aaaa0014-0000-4000-8000-00000000000a', 'aaaa0014-0000-4000-8000-0000000000a2',
             'company', platform.uuidv7(), 'company.created', 1) $$,
  'outbox en A funciona');
select is((select count(*) from public.outbox), 2::bigint,
  'ladino_api ve solo el outbox de A (la fila sembrada y la recién insertada)');
select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
     values ('aaaa0014-0000-4000-8000-00000000000a', null, 'aaaa0014-0000-4000-8000-0000000000a1',
             'K-DE-A', 'POST /x', '\x00'::bytea, now() + interval '1 hour') $$,
  'idempotency_keys: reservar una clave como actor A funciona');
select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
     values ('aaaa0014-0000-4000-8000-00000000000a', null, 'aaaa0014-0000-4000-8000-0000000000b1',
             'K-FALSA', 'POST /x', '\x00'::bytea, now() + interval '1 hour') $$,
  '42501', null, 'reservar una clave A NOMBRE DE OTRO ACTOR → 42501');
select is((select count(*) from public.idempotency_keys where key = 'K-DE-B'), 0::bigint,
  'la clave del actor B no se ve aunque esté en el tenant A');
-- Desde la migración 40 existen ADEMÁS los cinco roles de sistema sembrados;
-- lo que este assert protege es que lo global SE LEE, no cuántos hay.
select ok(
  exists (select 1 from public.roles
           where tenant_id is null and id = 'aaaa0014-0000-4000-8000-0000000000e1'),
  'los roles GLOBALES (tenant_id null) se leen: el JOIN de autorización los necesita');
reset role;

select is((select legal_name from public.companies where id = 'aaaa0014-0000-4000-8000-0000000000b2'),
  'Empresa B1', 'el UPDATE cross-tenant no cambió NADA: el dato de B está intacto');
select is((select created_by from public.companies where tax_id = 'J-A9'),
  'aaaa0014-0000-4000-8000-0000000000a1'::uuid,
  'la company creada por ladino_api lleva created_by = actor (provenance por el GUC)');

-- ── 3b. Actor multi-tenant: ve los dos ───────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0014-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select is((select count(*) from public.companies), 3::bigint,
  'el usuario con membership en A y B ve las tres companies (A1, A9, B1)');
reset role;

-- ── 3c. Sin actor: nada, y ruidoso ───────────────────────────────────────────
select set_config('ladino.actor_id', '', true);
set local role ladino_api;
select is((select count(*) from public.companies), 0::bigint,
  'sin actor, ladino_api no ve NINGUNA company');
select throws_ok(
  $$ insert into public.companies (tenant_id, tax_id, legal_name)
     values ('aaaa0014-0000-4000-8000-00000000000a', 'J-A0', 'Sin actor') $$,
  '42501', null, 'sin actor, tampoco inserta: 42501, no una fila huérfana');
reset role;

-- ── 4. ladino_worker ─────────────────────────────────────────────────────────
set local role ladino_worker;
select is((select count(*) from public.outbox), 3::bigint,
  'el worker ve el outbox de TODOS los tenants: es su trabajo');
-- Un WITH modificante no puede vivir dentro de un subselect: se ejecuta el
-- UPDATE y se comprueba el DATO (attempts pasó de 0 a 1).
update public.outbox set attempts = attempts + 1
 where tenant_id = 'aaaa0014-0000-4000-8000-00000000000b';
select is(
  (select attempts from public.outbox where tenant_id = 'aaaa0014-0000-4000-8000-00000000000b'),
  1, 'y actualiza filas de B (T1/T2/reaper): attempts 0 → 1');
select throws_ok($$ select count(*) from public.companies $$, '42501', null,
  'el worker no puede ni leer companies: 42501 por PRIVILEGIO, sin llegar a la RLS');
select throws_ok(
  $$ insert into public.outbox (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('aaaa0014-0000-4000-8000-00000000000a', null, 'company', platform.uuidv7(), 'company.created', 1) $$,
  '42501', null, 'el worker no encola: solo consume');
select lives_ok($$ delete from public.idempotency_keys where expires_at < now() - interval '7 days' $$,
  'la purga de claves caducadas funciona como worker');
reset role;

-- ── 5. VARIANTES ROTAS ───────────────────────────────────────────────────────
-- 5a. Una policy permisiva hace visible a B: la aserción de aislamiento mide la RLS.
create policy roto_14a on public.companies for select to ladino_api using (true);
select set_config('ladino.actor_id', 'aaaa0014-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select is((select count(*) from public.companies), 3::bigint,
  'ROTO: con una policy using(true) el actor A ve las tres — la aserción de arriba mide la RLS');
reset role;
drop policy roto_14a on public.companies;

-- 5b. Un GRANT deja leer al worker: la aserción del worker mide el privilegio.
grant select on public.companies to ladino_worker;
set local role ladino_worker;
select lives_ok($$ select count(*) from public.companies $$,
  'ROTO: con el GRANT el worker lee companies — la aserción de arriba mide el privilegio');
reset role;
revoke select on public.companies from ladino_worker;

-- 5c. Si una policy de authenticated usara las funciones DE SERVICIO, el GUC
--     daría acceso sin JWT — que es exactamente lo que la separación impide, y
--     lo que el primer diseño (coalesce compartido) hacía posible.
grant execute on function platform.ladino_service_tenant_ids() to authenticated;
grant execute on function platform.ladino_service_actor_id()   to authenticated;
create policy roto_14c on public.companies for select to authenticated
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
select set_config('request.jwt.claims', '', true);
select set_config('ladino.actor_id', 'aaaa0014-0000-4000-8000-0000000000a1', true);
set local role authenticated;
select is((select count(*) from public.companies), 2::bigint,
  'ROTO: mezclando los caminos, authenticated SIN JWT ve por el GUC — la aserción 4 mide la separación');
reset role;
drop policy roto_14c on public.companies;
revoke execute on function platform.ladino_service_tenant_ids() from authenticated;
revoke execute on function platform.ladino_service_actor_id()   from authenticated;

select * from finish();
rollback;
