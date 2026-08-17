-- =============================================================================
-- Ladino — pgTAP 13 · Gate de coste de `ladino_has_permission` y correcciones 6/6
--
-- ESTE FICHERO EXISTE PORQUE FALTABA UN GATE ENTERO.
--
-- La migración 5/5 introdujo una regresión de rendimiento de 28× en la función
-- que usan más de CUARENTA policies, y los 348 asserts la dejaron pasar en
-- verde por un motivo simple: **ninguno medía coste**. Todos comprobaban
-- corrección. Una regresión de rendimiento en el camino de la RLS no es un
-- detalle de optimización — con el objetivo p95 < 500 ms de ADR-0014, es la
-- diferencia entre un producto usable y uno que no lo es.
--
-- QUÉ ES Y QUÉ NO ES ESTE GATE:
--
--   Es un DETECTOR DE REGRESIÓN, no un objetivo de rendimiento. El presupuesto
--   está calibrado con ~11× de margen sobre el coste real medido, así que no
--   dice «esto es rápido»: dice «esto no se ha vuelto catastróficamente lento».
--   Un gate ajustado al milisegundo sería flaky en cualquier máquina distinta, y
--   un gate flaky se aprende a reejecutar hasta que pase, que es peor que no
--   tenerlo.
--
--   Y trae su VARIANTE ROTA, como manda la skill: reintroduce a propósito el
--   envoltorio SQL que causó la regresión y comprueba que el presupuesto SÍ se
--   excede. Sin eso, un gate de coste que nunca ha fallado no se sabe si mide
--   algo — podría estar midiendo una tabla vacía.
-- =============================================================================

begin;
select plan(23);

insert into auth.users (id) values
  ('aaaaaaaa-1111-4111-8111-00000000000a'),
  ('bbbbbbbb-2222-4222-8222-00000000000b');
insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001',
   'J-A1', 'Empresa A1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('33333333-3333-4333-8333-000000000001', null, 'auditor', 'Auditor', false);
insert into public.role_permissions (role_id, permission_key) values
  ('33333333-3333-4333-8333-000000000001', 'fiscal.audit.read');
insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001',
   'aaaaaaaa-1111-4111-8111-00000000000a');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('55555555-5555-4555-8555-000000000001', '11111111-1111-4111-8111-000000000001',
   '44444444-4444-4444-8444-00000000000a', '33333333-3333-4333-8333-000000000001',
   '11111111-1111-4111-8111-0000000000a1');

-- 2.000 filas. Calibrado: con el envoltorio correcto cuesta ~130 ms; con el que
-- causó la regresión, ~3.300 ms. El presupuesto de 1.500 ms deja 11× de margen
-- hacia arriba y caza la regresión con 2× de holgura.
insert into public.audit_events
  (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   actor_type, occurred_at, rules_version, payload)
select '11111111-1111-4111-8111-000000000001',
       '11111111-1111-4111-8111-0000000000a1', 'invoice',
       platform.uuidv7(), 'invoice.issued', 'system', now(), '2026.1', '{}'
  from generate_series(1, 2000);

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);


-- =============================================================================
-- 1. EL GATE — coste de la ruta REAL de RLS
--
-- No se mide la función en aislamiento: se mide un SELECT bajo la policy de
-- audit_events, que la invoca POR FILA. Es la ruta que se degradó, y medir la
-- función suelta no la habría detectado.
-- =============================================================================

create temporary table medicion (etiqueta text, ms numeric) on commit drop;

do $medir$
declare t0 timestamptz; t1 timestamptz; n bigint;
begin
  set local role authenticated;
  t0 := clock_timestamp();
  select count(*) into n from public.audit_events;
  t1 := clock_timestamp();
  -- reset ANTES de escribir: la tabla temporal es del owner y authenticated
  -- no tiene privilegios sobre ella.
  reset role;
  insert into medicion values ('actual',
    extract(epoch from (t1 - t0)) * 1000);
end
$medir$;

select ok(
  (select ms from medicion where etiqueta = 'actual') < 1500,
  'GATE DE COSTE: un SELECT bajo la policy de audit_events sobre 2.000 filas '
  'cuesta menos de 1.500 ms. Con el envoltorio correcto son ~130 ms; el '
  'presupuesto es un detector de regresión, no un objetivo');


-- =============================================================================
-- 2. LA VARIANTE ROTA — ¿el gate mide algo?
--
-- Se reintroduce el envoltorio SQL que causó la regresión, se mide, y se
-- comprueba que EXCEDE el presupuesto. Si no lo excediera, el gate estaría
-- midiendo cualquier otra cosa y su verde no valdría nada.
--
-- Todo dentro del begin/rollback del fichero: la función real no se toca.
-- =============================================================================

create or replace function platform.ladino_has_permission(
  p_permission text, p_company_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select platform.ladino_user_has_permission(auth.uid(), p_permission, p_company_id);
$$;

do $medir$
declare t0 timestamptz; t1 timestamptz; n bigint;
begin
  set local role authenticated;
  t0 := clock_timestamp();
  select count(*) into n from public.audit_events;
  t1 := clock_timestamp();
  -- reset ANTES de escribir: la tabla temporal es del owner y authenticated
  -- no tiene privilegios sobre ella.
  reset role;
  insert into medicion values ('roto',
    extract(epoch from (t1 - t0)) * 1000);
end
$medir$;

select ok(
  (select ms from medicion where etiqueta = 'roto') > 1500,
  'y con el envoltorio SQL que causó la regresión, el MISMO gate se dispara: '
  'mide lo que dice medir. Un gate de coste que nunca ha fallado podría estar '
  'midiendo una tabla vacía');

select ok(
  (select ms from medicion where etiqueta = 'roto')
    > 5 * (select ms from medicion where etiqueta = 'actual'),
  'y la diferencia es de un orden de magnitud, no de ruido: es replanificación '
  'por fila, no una máquina ocupada');

-- Se restituye el envoltorio bueno y se comprueba que vuelve al presupuesto.
create or replace function platform.ladino_has_permission(
  p_permission text, p_company_id uuid)
returns boolean language plpgsql stable security definer set search_path = ''
as $$
begin
  return platform.ladino_user_has_permission(auth.uid(), p_permission, p_company_id);
end;
$$;

do $medir$
declare t0 timestamptz; t1 timestamptz; n bigint;
begin
  set local role authenticated;
  t0 := clock_timestamp();
  select count(*) into n from public.audit_events;
  t1 := clock_timestamp();
  -- reset ANTES de escribir: la tabla temporal es del owner y authenticated
  -- no tiene privilegios sobre ella.
  reset role;
  insert into medicion values ('restituido',
    extract(epoch from (t1 - t0)) * 1000);
end
$medir$;

select ok(
  (select ms from medicion where etiqueta = 'restituido') < 1500,
  'restituido el envoltorio plpgsql, vuelve al presupuesto: el test deja el '
  'esquema como lo encontró');

-- Y la propiedad estructural que causa todo esto, fijada en el catálogo para
-- que un `create or replace` descuidado la rompa en rojo y no en producción.
select is(
  (select l.lanname from pg_proc p join pg_language l on l.oid = p.prolang
    where p.oid = 'platform.ladino_has_permission(text,uuid)'::regprocedure),
  'plpgsql',
  'ladino_has_permission está en plpgsql. Reescribirla en SQL —que parece '
  'equivalente y más limpio— reintroduce la regresión de 28×');


-- =============================================================================
-- 3. El oráculo RBAC, cerrado
-- =============================================================================

select ok(
  not has_function_privilege('authenticated',
    'platform.ladino_user_has_permission(uuid,text,uuid)', 'EXECUTE'),
  'authenticated ya NO puede ejecutar la función parametrizada: acepta un '
  'p_user arbitrario y es security definer, así que era un oráculo de permisos '
  'de cualquier usuario en cualquier tenant');

select ok(
  has_function_privilege('authenticated',
    'platform.ladino_has_permission(text,uuid)', 'EXECUTE'),
  'pero SÍ la que resuelve sobre su propio auth.uid(): cerrar la parametrizada '
  'no cierra el camino de las policies');

-- Y se ejerce: la policy sigue funcionando con el GRANT retirado.
set local role authenticated;
select is(
  (select count(*) from public.audit_events), 2001::bigint,
  'y la policy de audit_events sigue devolviendo filas tras el revoke: los '
  'llamantes son security definer y la invocan como el owner. Son 2.001 y no '
  '2.000 porque el alta de la company deja su propio evento');
reset role;


-- =============================================================================
-- 4. `occurred_at` contra el reloj de PARED
-- =============================================================================

select ok(
  not exists (select 1 from pg_constraint
               where conrelid = 'public.audit_events'::regclass
                 and conname = 'audit_events_occurred_at_chk'),
  'el CHECK contra created_at se retiró: comparaba con la hora de INICIO de '
  'transacción, así que la tolerancia se gastaba en la duración de la propia '
  'transacción');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.audit_events'::regclass
             and tgfoid = 'platform.assert_occurred_at_not_future()'::regprocedure),
  'y la validación vive ahora en un trigger, que sí puede usar clock_timestamp()');

select throws_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000f001', 'invoice.issued',
             'system', clock_timestamp() + interval '5 minutes', '2026.1', '{}') $$,
  'LAD30', null,
  '5 minutos por delante del reloj de pared se sigue rechazando, ahora con un '
  'error propio que dice qué pasa');

-- La prueba que importa: una transacción LARGA ya no rompe la auditoría. Esta
-- transacción lleva abierta desde el `begin` del fichero, así que `now()` ya
-- quedó atrás; con el CHECK anterior esto habría fallado en cuanto el fichero
-- tardara más de 30 s.
select lives_ok(
  $$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000f002', 'invoice.issued',
             'system', clock_timestamp(), '2026.1', '{}') $$,
  'y el reloj de pared entra sin importar cuánto lleve abierta la transacción: '
  'el presupuesto de 30 s ya no se comparte con su duración');


-- =============================================================================
-- 5. `actor_id`: semántica de la clave, no procedencia
-- =============================================================================

select ok(
  (select attnotnull from pg_attribute
    where attrelid = 'public.idempotency_keys'::regclass and attname = 'actor_id'),
  'idempotency_keys.actor_id es NOT NULL: si el middleware no lo pone, falla '
  'ACTIVAMENTE. Es lo contrario de created_by, cuyo contrato admite quedarse '
  'NULL en silencio');

select ok(
  not exists (select 1 from pg_attribute a
                join pg_index i on i.indexrelid = 'public.idempotency_keys_scope_uq'::regclass
               where a.attrelid = 'public.idempotency_keys'::regclass
                 and a.attnum = any(i.indkey) and a.attname = 'created_by'),
  'y created_by YA NO está en el índice único: una restricción de unicidad no '
  'se construye sobre una columna best-effort');

-- El caso exacto que la migración anterior dejaba pasar.
insert into public.idempotency_keys
  (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
values ('11111111-1111-4111-8111-000000000001',
        '11111111-1111-4111-8111-0000000000a1',
        'aaaaaaaa-1111-4111-8111-00000000000a',
        'K-1', 'POST /invoices', sha256('cuerpo'::bytea), now() + interval '24 hours');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'aaaaaaaa-1111-4111-8111-00000000000a',
             'K-1', 'POST /invoices', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  '23505', null,
  'mismo actor y misma clave: deduplica. Y ahora NO depende de que la API se '
  'acordara de fijar un GUC — el reintento sin GUC creaba una segunda reserva '
  'y la operación se ejecutaba dos veces');

select throws_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'K-2', 'POST /invoices', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  '23502', null,
  'y omitir actor_id no cuela: falla al insertar en vez de deduplicar mal '
  'después. Ausencia de mecanismo no es prohibición');

select lives_ok(
  $$ insert into public.idempotency_keys
       (tenant_id, company_id, actor_id, key, endpoint, request_hash, expires_at)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1',
             'bbbbbbbb-2222-4222-8222-00000000000b',
             'K-1', 'POST /invoices', sha256('cuerpo'::bytea),
             now() + interval '24 hours') $$,
  'y otro actor con la misma clave sí entra: es el aislamiento por actor que '
  'esta columna existe para dar');


-- =============================================================================
-- 6. Cota de longitud de `event_type`
-- =============================================================================

select throws_ok(
  format($$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000f003', %L,
             'system', now(), '2026.1', '{}') $$,
    'a.' || repeat('b', 3000)),
  '23514', null,
  'un event_type de 3.000 caracteres se rechaza con 23514 y no revienta en el '
  'btree con «index row size exceeds maximum», que ninguna capa mapea');

-- La frontera, que es donde una cota se equivoca. Y en `outbox`, que tenía la
-- misma constraint sin una sola aserción: dos gemelas y solo una probada.
select lives_ok(
  format($$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000f004', %L,
             'system', now(), '2026.1', '{}') $$,
    'a.' || repeat('b', 126)),
  'exactamente 128 caracteres entra: la cota es inclusiva por arriba');

select throws_ok(
  format($$ insert into public.outbox
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        schema_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-00000000f005', %L, 1, '{}') $$,
    'a.' || repeat('b', 127)),
  '23514', null,
  '129 se rechaza — y en OUTBOX, cuya constraint gemela no tenía ni una '
  'aserción. Dos restricciones idénticas con una sola probada es media prueba');


-- =============================================================================
-- 7. Migración 7/7 — el actor se clava y `aggregate_type` se acota
-- =============================================================================

-- `actor_id` sostiene el alcance del único. `created_by` estaba CLAVADO por
-- set_row_provenance(); al mover la dimensión de actor a una columna nueva, la
-- defensa no vino con el dato. Se ejerce el UPDATE, no se consulta el trigger.
set local role service_role;
select throws_ok(
  $$ update public.idempotency_keys
        set actor_id = '99999999-9999-4999-8999-999999999999'
      where key = 'K-1'
        and actor_id = 'aaaaaaaa-1111-4111-8111-00000000000a' $$,
  'LAD31', null,
  'mover actor_id se rechaza: liberaría la reserva del actor original y su '
  'operación se ejecutaría dos veces. Antes de la 7/7 esto devolvía UPDATE 1');

select lives_ok(
  $$ update public.idempotency_keys
        set status = 'completed', response = '{"id":"inv-1"}'
      where key = 'K-1'
        and actor_id = 'aaaaaaaa-1111-4111-8111-00000000000a' $$,
  'y el UPDATE que la tabla existe para permitir —in_progress a completed— sigue '
  'funcionando: clavar una columna no puede cerrar el ciclo de vida');
reset role;

-- `aggregate_type` entra en audit_events_aggregate_idx y no tenía cota.
-- OJO: con `repeat('z', 3000)` NO se reproduce — TOAST comprime la cadena
-- repetitiva y la entrada del índice cabe. Hace falta texto INCOMPRESIBLE, que
-- es por lo que una prueba con datos bonitos pasa en verde sobre un esquema roto.
select throws_ok(
  format($$ insert into public.audit_events
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        actor_type, occurred_at, rules_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', %L,
             '77777777-7777-4777-8777-00000000f006', 'invoice.issued',
             'system', now(), '2026.1', '{}') $$,
    (select string_agg(substr('abcdefghijklmnopqrstuvwxyz',
                              1 + floor(random() * 26)::int, 1), '')
       from generate_series(1, 3000))),
  '23514', null,
  'aggregate_type incompresible de 3.000 caracteres se rechaza con 23514. Antes '
  'de la 7/7 daba «index row size 3064 exceeds btree maximum 2704» sobre '
  'audit_events_aggregate_idx: el mismo error que la migración anterior decía '
  'haber eliminado, en la misma tabla, por la otra columna');

select * from finish();
rollback;
