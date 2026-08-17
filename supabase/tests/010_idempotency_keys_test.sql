-- =============================================================================
-- Ladino — pgTAP 10 · `idempotency_keys`
--
-- Cubre la migración 3/4 de S0.4.
--
-- EL CASO QUE IMPORTA ES EL DEL NULL. Un UNIQUE ordinario sobre columnas
-- nullables no deduplica: en SQL, NULL no es igual a NULL, así que la misma
-- clave entra tantas veces como se quiera mientras `company_id` sea NULL, sin
-- error y sin aviso. Probar el caso fácil —company_id con valor— pasaría en
-- verde con la idempotencia rota justo donde no se mira.
--
-- Por eso este fichero hace DOS cosas con ese caso: lo ejerce, y después QUITA
-- `nulls not distinct` a propósito para comprobar que sin la cláusula el
-- duplicado entra. Una prueba que nunca ha fallado no se sabe si detecta algo.
-- =============================================================================

begin;
select plan(32);

insert into auth.users (id) values ('aaaaaaaa-1111-4111-8111-00000000000a');

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
  ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001', 'J-A1', 'Empresa A1'),
  ('11111111-1111-4111-8111-0000000000a2', '11111111-1111-4111-8111-000000000001', 'J-A2', 'Empresa A2'),
  ('22222222-2222-4222-8222-0000000000b1', '22222222-2222-4222-8222-000000000001', 'J-B1', 'Empresa B1');

insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001',
   'aaaaaaaa-1111-4111-8111-00000000000a');

-- Desde la migración 6/6, `actor_id` es NOT NULL y lo fija el middleware.
-- Este fichero prueba la semántica del ÚNICO frente a `company_id` NULL, no el
-- alcance por actor —eso es el test 013—, así que se fija un default dentro de
-- la transacción de prueba para no repetir el mismo actor en diez inserciones.
-- El DDL se revierte con el rollback; el NOT NULL sigue probado en 013.
alter table public.idempotency_keys
  alter column actor_id set default 'aaaaaaaa-1111-4111-8111-00000000000a';


-- =============================================================================
-- 1. Privilegios — y el camino autorizado EJERCIDO, no consultado
-- =============================================================================

select ok(not has_table_privilege('authenticated', 'public.idempotency_keys', 'SELECT'),
  'authenticated no lee las claves: leerlas revelaría qué operaciones hizo otro');
select ok(not has_table_privilege('authenticated', 'public.idempotency_keys', 'INSERT'),
  'ni reserva claves: reservar la de otro le bloquearía su operación legítima');
select ok(not has_table_privilege('authenticated', 'public.idempotency_keys', 'UPDATE'),
  'ni marca completed con una respuesta falsa que el replay devolvería');
select ok(not has_table_privilege('anon', 'public.idempotency_keys', 'SELECT'),
  'anon, nada');
select ok(not has_table_privilege('service_role', 'public.idempotency_keys', 'TRUNCATE'),
  'ni service_role puede TRUNCATE');

set local role service_role;
select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'clave-de-servicio', 'POST /invoices', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  'service_role SÍ puede reservar una clave de verdad: es el único camino');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select count(*) from public.idempotency_keys $$,
  '42501', null,
  'un miembro del tenant tampoco lee: muere en el privilegio');
reset role;
select set_config('request.jwt.claims', null, true);


-- =============================================================================
-- 2. EL ÍNDICE ÚNICO — primero el caso fácil, para tenerlo cubierto
-- =============================================================================

insert into public.idempotency_keys
  (tenant_id, company_id, key, endpoint, request_hash, expires_at)
values ('11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-0000000000a1',
        'K-1', 'POST /invoices', sha256('cuerpo'::bytea), now() + interval '24 hours');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'K-1', 'POST /invoices', sha256('cuerpo'::bytea), now() + interval '24 hours') $$,
  '23505', null,
  'misma clave, misma company: rechazada. Es el caso fácil');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'K-1', 'POST /payments', sha256('otro'::bytea), now() + interval '24 hours') $$,
  '23505', null,
  'y con OTRO endpoint también se rechaza: `endpoint` no entra en el único '
  '(ADR-0026 D5). Si entrara, un cliente que reusa la clave por error obtendría '
  'DOS efectos y ninguno parecería un fallo');

select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a2',
             'K-1', 'POST /invoices', sha256('cuerpo'::bytea), now() + interval '24 hours') $$,
  'la misma clave en OTRA company del mismo tenant sí entra: el alcance es por '
  'company, no global');

select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('22222222-2222-4222-8222-000000000001',
             '22222222-2222-4222-8222-0000000000b1',
             'K-1', 'POST /invoices', sha256('cuerpo'::bytea), now() + interval '24 hours') $$,
  'y en otro tenant también: dos clientes distintos no se pisan las claves');


-- =============================================================================
-- 3. EL CASO QUE IMPORTA: company_id NULL
--
-- Operación de nivel tenant. Sin `nulls not distinct`, aquí NO hay error: las
-- dos filas entran y la idempotencia queda rota en silencio.
-- =============================================================================

insert into public.idempotency_keys
  (tenant_id, company_id, key, endpoint, request_hash, expires_at)
values ('11111111-1111-4111-8111-000000000001', null,
        'K-TENANT', 'POST /companies', sha256('cuerpo'::bytea), now() + interval '24 hours');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001', null,
             'K-TENANT', 'POST /companies', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  '23505', null,
  'CON company_id NULL la clave repetida TAMBIÉN se rechaza. Es el caso que un '
  'UNIQUE ordinario deja pasar, porque en SQL NULL no es igual a NULL');

select is(
  (select count(*) from public.idempotency_keys
    where tenant_id = '11111111-1111-4111-8111-000000000001'
      and company_id is null and key = 'K-TENANT'),
  1::bigint,
  'y queda UNA sola fila: se comprueba el dato, no solo que hubo excepción');

select ok(
  (select indnullsnotdistinct from pg_index
    where indexrelid = 'public.idempotency_keys_scope_uq'::regclass),
  'el catálogo confirma NULLS NOT DISTINCT en el índice');


-- =============================================================================
-- 4. LA VARIANTE ROTA — ¿de verdad lo detecta la cláusula?
--
-- Se quita `nulls not distinct` a propósito, dentro de esta transacción, y se
-- comprueba que el duplicado ENTRA. Si no entrara, las tres aserciones de
-- arriba estarían pasando por otro motivo y no medirían lo que dicen medir.
--
-- Todo esto vive dentro del `begin; … rollback;` del fichero: el esquema real no
-- se toca.
-- =============================================================================

drop index public.idempotency_keys_scope_uq;
create unique index idempotency_keys_scope_uq
  on public.idempotency_keys (tenant_id, company_id, actor_id, key);   -- SIN nulls not distinct

select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001', null,
             'K-TENANT', 'POST /companies', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  'SIN la cláusula, el duplicado ENTRA sin un solo error. Esto es lo que prueba '
  'que las aserciones de arriba miden la cláusula y no otra cosa');

select is(
  (select count(*) from public.idempotency_keys
    where tenant_id = '11111111-1111-4111-8111-000000000001'
      and company_id is null and key = 'K-TENANT'),
  2::bigint,
  'y quedan DOS filas con la misma clave: idempotencia rota, cero señales. La '
  'operación de nivel tenant se ejecutaría dos veces');

-- Se restituye el índice bueno. La fila duplicada estorba, así que se quita
-- primero: si no, el índice correcto no se puede crear — que es, por cierto,
-- otra confirmación de que la cláusula hace algo.
delete from public.idempotency_keys
 where ctid in (
   select ctid from public.idempotency_keys
    where tenant_id = '11111111-1111-4111-8111-000000000001'
      and company_id is null and key = 'K-TENANT'
    offset 1);

drop index public.idempotency_keys_scope_uq;
create unique index idempotency_keys_scope_uq
  on public.idempotency_keys (tenant_id, company_id, actor_id, key)
  nulls not distinct;

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001', null,
             'K-TENANT', 'POST /companies', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  '23505', null,
  'restituido el índice, el duplicado vuelve a rechazarse: la prueba deja el '
  'esquema como lo encontró');


-- =============================================================================
-- 5. Coherencia estado/dato
-- =============================================================================

select throws_ok(
  $$ update public.idempotency_keys set status = 'completed'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  '23514', null,
  'completed SIN respuesta se rechaza. Es el peor estado representable de esta '
  'tabla: un replay encontraría la clave, concluiría que ya se hizo, y '
  'devolvería NADA — un éxito vacío sobre una operación que sí ocurrió');

select lives_ok(
  $$ update public.idempotency_keys
        set status = 'completed', response = '{"id":"inv-1","total":"100.00"}'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  'completed CON respuesta sí: es el camino del replay');

select throws_ok(
  $$ update public.idempotency_keys
        set status = 'in_progress', response = '{"a":1}'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  '23514', null,
  'in_progress CON respuesta se rechaza: el replay devolvería una respuesta a '
  'medio construir');

select lives_ok(
  $$ update public.idempotency_keys
        set status = 'failed', response = '{"error":"VALIDATION"}'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  'failed sí admite respuesta: el error también se devuelve en el replay');

select throws_ok(
  $$ update public.idempotency_keys set status = 'esperando'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  '23514', null,
  'un estado inventado se rechaza');


-- =============================================================================
-- 6. El resto de constraints
-- =============================================================================

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'K-CADUCA', 'POST /invoices', sha256('c'::bytea),
             now() - interval '1 hour') $$,
  '23514', null,
  'una clave que caduca ANTES de existir se rechaza: no deduplicaría nada');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             repeat('x', 256), 'POST /invoices', sha256('c'::bytea),
             now() + interval '24 hours') $$,
  '23514', null,
  'clave de más de 255: se corta aquí y no en el btree, que reventaría en '
  'producción con la primera clave larga de un cliente');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '22222222-2222-4222-8222-0000000000b1',
             'K-CRUZADA', 'POST /invoices', sha256('c'::bytea),
             now() + interval '24 hours') $$,
  '23503', null,
  'CRUZADO: una clave del tenant A no se cuelga de una company de B');


-- =============================================================================
-- 7. Anclas, procedencia y catálogo
-- =============================================================================

set local role service_role;
select throws_ok(
  $$ update public.idempotency_keys
        set tenant_id = '22222222-2222-4222-8222-000000000001'
      where key = 'K-1' and company_id = '11111111-1111-4111-8111-0000000000a1' $$,
  'LAD28', null,
  'ni service_role mueve una clave de tenant: liberaría la clave en A y la '
  'ocuparía en B de golpe');
reset role;

select ok(
  (select created_at from public.idempotency_keys where key = 'K-TENANT') is not null,
  'created_at lo pone el servidor');

select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.idempotency_keys'::regclass),
  'RLS habilitada Y FORZADA');

select is(
  (select count(*) from pg_policy
    where polrelid = 'public.idempotency_keys'::regclass),
  4::bigint,
  'las cuatro denegaciones ESCRITAS');

select ok(
  not exists (select 1 from pg_trigger
               where tgrelid = 'public.idempotency_keys'::regclass
                 and tgfoid = 'platform.reject_mutation()'::regprocedure),
  'no lleva reject_mutation(): in_progress → completed exige UPDATE, y cerrarlo '
  'dejaría la tabla inservible');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.idempotency_keys'::regclass
             and tgfoid = 'platform.assert_isolation_anchors_immutable()'::regprocedure),
  'sí lleva el trigger de anclas');

select ok(
  (select conkey is not null from pg_constraint
    where conrelid = 'public.idempotency_keys'::regclass
      and conname = 'idempotency_keys_completed_chk'),
  'y el CHECK de completed sigue en el catálogo');

select * from finish();
rollback;
