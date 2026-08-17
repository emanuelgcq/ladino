-- =============================================================================
-- Ladino — pgTAP 9 · `outbox`
--
-- Cubre la migración 2/4 de S0.4. Lo que pgTAP puede probar en UNA conexión:
-- esquema, privilegios, policies, constraints y la máquina de estados.
--
-- Lo que NO puede, y por eso no se finge aquí: la concurrencia de la toma de
-- trabajo. Eso vive en `scripts/outbox-concurrency.mjs`, con pgbench y sesiones
-- de verdad. Un test de concurrencia en una sola conexión sería una prueba que
-- no prueba, que es peor que no tenerla.
-- =============================================================================

begin;
select plan(33);

insert into auth.users (id) values ('aaaaaaaa-1111-4111-8111-00000000000a');

insert into public.tenants (id, name) values
  ('11111111-1111-4111-8111-000000000001', 'Tenant A'),
  ('22222222-2222-4222-8222-000000000001', 'Tenant B');

insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('11111111-1111-4111-8111-0000000000a1', '11111111-1111-4111-8111-000000000001', 'J-A1', 'Empresa A1'),
  ('22222222-2222-4222-8222-0000000000b1', '22222222-2222-4222-8222-000000000001', 'J-B1', 'Empresa B1');

insert into public.memberships (id, tenant_id, user_id) values
  ('44444444-4444-4444-8444-00000000000a', '11111111-1111-4111-8111-000000000001',
   'aaaaaaaa-1111-4111-8111-00000000000a');

insert into public.outbox
  (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type,
   schema_version, payload) values
  ('99999999-9999-4999-8999-000000000001', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-0000000000a1', 'invoice',
   '77777777-7777-4777-8777-000000000001', 'invoice.issued', 1, '{"total":"100.00"}'),
  -- Segunda fila para el camino de FALLO. No se reutiliza la primera: desde
  -- `published` no se va a `dead`, porque `published` es terminal y el CHECK de
  -- coherencia lo impide. Reutilizarla era un error del test, no del esquema.
  ('99999999-9999-4999-8999-000000000002', '11111111-1111-4111-8111-000000000001',
   '11111111-1111-4111-8111-0000000000a1', 'invoice',
   '77777777-7777-4777-8777-000000000002', 'invoice.issued', 1, '{"total":"200.00"}');


-- =============================================================================
-- 1. Privilegios: el outbox es fontanería
-- =============================================================================

select ok(not has_table_privilege('authenticated', 'public.outbox', 'SELECT'),
  'authenticated NO puede leer el outbox: no es un producto para el usuario');
select ok(not has_table_privilege('authenticated', 'public.outbox', 'INSERT'),
  'ni encolar: sería fabricar un efecto que ningún caso de uso autorizó');
select ok(not has_table_privilege('authenticated', 'public.outbox', 'UPDATE'),
  'ni avanzar estados: eso es del worker');
select ok(not has_table_privilege('authenticated', 'public.outbox', 'DELETE'),
  'ni purgar');
select ok(not has_table_privilege('anon', 'public.outbox', 'SELECT'),
  'anon, nada');
select ok(not has_table_privilege('service_role', 'public.outbox', 'TRUNCATE'),
  'ni service_role puede TRUNCATE: vaciar la cola es perder efectos sin '
  'publicar, y eso no puede ser un descuido de una línea');

-- Y ahora se EJERCE el camino autorizado, que no es lo mismo que consultar el
-- bit. En `audit_events` esta distinción destapó que la tabla nacía escribible
-- por nadie: el privilegio estaba y el INSERT fallaba dos capas más abajo.
set local role service_role;
select lives_ok(
  $$ insert into public.outbox
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
        schema_version, payload)
     values ('11111111-1111-4111-8111-000000000001',
             '11111111-1111-4111-8111-0000000000a1', 'invoice',
             '77777777-7777-4777-8777-0000000000e1', 'invoice.issued', 1, '{}') $$,
  'service_role SÍ puede encolar de verdad: es el único camino y está abierto');

select lives_ok(
  $$ update public.outbox set status = 'in_flight', attempts = attempts + 1
      where id = '99999999-9999-4999-8999-000000000001' $$,
  'y SÍ puede avanzar el estado: el outbox NO es append-only (ADR-0026 D7), y '
  'prohibírselo lo dejaría inservible');
reset role;


-- =============================================================================
-- 2. `authenticated` no ve nada — ejercido, no deducido
-- =============================================================================

select set_config('request.jwt.claims',
  '{"sub":"aaaaaaaa-1111-4111-8111-00000000000a","role":"authenticated"}', true);
set local role authenticated;
select throws_ok(
  $$ select count(*) from public.outbox $$,
  '42501',
  null,
  'un miembro legítimo del tenant A tampoco lee el outbox: muere en el '
  'privilegio, antes de llegar a la policy');
reset role;
select set_config('request.jwt.claims', null, true);


-- =============================================================================
-- 3. La máquina de estados vive en el ESQUEMA, no solo en TypeScript
-- =============================================================================

select throws_ok(
  $$ update public.outbox set status = 'entregando'
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514',
  null,
  'un estado inventado se rechaza: pending, in_flight, published o dead');

select throws_ok(
  $$ update public.outbox set status = 'published'
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514',
  null,
  'COHERENCIA: published SIN published_at se rechaza. Sin este CHECK, un panel '
  'que cuente por status y otro que cuente por published_at darían cifras '
  'distintas, y las dos parecerían correctas');

select throws_ok(
  $$ update public.outbox set published_at = now()
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514',
  null,
  'y al revés: published_at sin status published tampoco. La coherencia se '
  'comprueba en las DOS direcciones, que es lo que la hace una equivalencia');

select throws_ok(
  $$ update public.outbox set status = 'dead'
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514',
  null,
  'dead SIN last_error se rechaza: una fila en la cola de fallos sin motivo '
  'obliga a reconstruir el porqué desde los logs, si es que quedan');

select lives_ok(
  $$ update public.outbox
        set status = 'published', published_at = now()
      where id = '99999999-9999-4999-8999-000000000001' $$,
  'el camino feliz completo SÍ pasa: pending → in_flight → published');

select throws_ok(
  $$ update public.outbox
        set status = 'dead', last_error = 'ya no toca'
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514', null,
  'y una vez published NO se pasa a dead: published es TERMINAL, y el CHECK de '
  'coherencia lo impide porque published_at seguiría puesto. Lo descubrió este '
  'mismo test intentándolo');

-- El camino de fallo, sobre la segunda fila.
select lives_ok(
  $$ update public.outbox
        set status = 'dead', last_error = 'imprenta no responde tras 5 intentos'
      where id = '99999999-9999-4999-8999-000000000002' $$,
  'dead CON motivo sí pasa. `dead` es un estado, no una tabla aparte: '
  'reprocesar es un UPDATE, no mover filas entre tablas');

select lives_ok(
  $$ update public.outbox
        set status = 'pending', last_error = null, available_at = now()
      where id = '99999999-9999-4999-8999-000000000002' $$,
  'y desde dead se vuelve a pending: la cola de fallos es REPROCESABLE, que es '
  'la razón entera de que sea un estado y no una tabla aparte');


-- =============================================================================
-- 4. Constraints del resto de columnas
-- =============================================================================

select throws_ok(
  $$ insert into public.outbox
       (tenant_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'Se emitió', 1) $$,
  '23514', null,
  'event_type con forma libre se rechaza, igual que en audit_events');

select throws_ok(
  $$ insert into public.outbox
       (tenant_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('11111111-1111-4111-8111-000000000001', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued', 0) $$,
  '23514', null,
  'schema_version < 1 se rechaza: EVENT_CATALOG.md exige versión de esquema, y '
  'un cero es la versión que nadie declaró');

select throws_ok(
  $$ update public.outbox set attempts = -1
      where id = '99999999-9999-4999-8999-000000000001' $$,
  '23514', null,
  'attempts negativo se rechaza');

select throws_ok(
  $$ insert into public.outbox
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('11111111-1111-4111-8111-000000000001',
             '22222222-2222-4222-8222-0000000000b1', 'invoice',
             '77777777-7777-4777-8777-000000000009', 'invoice.issued', 1) $$,
  '23503', null,
  'CRUZADO: un evento del tenant A no se cuelga de una company de B');

select lives_ok(
  $$ insert into public.outbox
       (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version)
     values ('11111111-1111-4111-8111-000000000001', null, 'company',
             '77777777-7777-4777-8777-00000000000c', 'company.created', 1) $$,
  'company_id NULL sí: hay efectos de nivel tenant');


-- =============================================================================
-- 5. Anclas de aislamiento
-- =============================================================================

set local role service_role;
select throws_ok(
  $$ update public.outbox set tenant_id = '22222222-2222-4222-8222-000000000001'
      where id = '99999999-9999-4999-8999-000000000001' $$,
  'LAD28', null,
  'ni service_role mueve una fila del outbox de tenant: entregaría a B un '
  'efecto de A');
reset role;


-- =============================================================================
-- 6. Procedencia — aquí `version` SÍ está viva
-- =============================================================================

-- Medido, no contado a mano. Un número fijo aquí caduca en cuanto alguien
-- añade o quita un update más arriba, y entonces el test falla por un motivo
-- que no tiene nada que ver con lo que dice comprobar.
create temporary table v_antes as
  select version from public.outbox where id = '99999999-9999-4999-8999-000000000002';

update public.outbox set attempts = attempts + 1
 where id = '99999999-9999-4999-8999-000000000002';

select is(
  (select version from public.outbox where id = '99999999-9999-4999-8999-000000000002')
    - (select version from v_antes),
  1,
  'version sube exactamente 1 por UPDATE: a diferencia de audit_events, aquí no '
  'es columna muerta y sirve de concurrencia optimista');

select ok(
  (select created_at from public.outbox
    where id = '99999999-9999-4999-8999-000000000001') is not null,
  'created_at lo pone el servidor');


-- =============================================================================
-- 7. Propiedades del catálogo
-- =============================================================================

select ok(
  (select relrowsecurity and relforcerowsecurity
     from pg_class where oid = 'public.outbox'::regclass),
  'RLS habilitada Y FORZADA, aunque authenticated no tenga privilegios: el día '
  'que alguien conceda un GRANT amplio, es lo único que queda');

select is(
  (select count(*) from pg_policy where polrelid = 'public.outbox'::regclass),
  4::bigint,
  'las cuatro denegaciones están ESCRITAS, no son ausencia de policy');

select is(
  (select count(*) from pg_policy p
    where p.polrelid = 'public.outbox'::regclass and p.polcmd = '*'),
  0::bigint,
  'ninguna es FOR ALL: separadas por operación');

select ok(
  not exists (select 1 from pg_trigger
               where tgrelid = 'public.outbox'::regclass
                 and tgfoid = 'platform.reject_mutation()'::regprocedure),
  'el outbox NO lleva reject_mutation(): se actualiza por diseño, y una defensa '
  'que cierra el único camino autorizado es una avería, no una defensa');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.outbox'::regclass
             and tgfoid = 'platform.assert_isolation_anchors_immutable()'::regprocedure),
  'pero SÍ lleva el trigger de anclas');

select ok(
  exists (select 1 from pg_trigger
           where tgrelid = 'public.outbox'::regclass
             and tgfoid = 'platform.set_row_provenance()'::regprocedure),
  'y el de procedencia');

-- El índice de toma de trabajo es PARCIAL a propósito. Si alguien lo convierte
-- en total, deja de escalar: `published` crece sin límite y el índice con él.
select ok(
  (select indpred is not null from pg_index
    where indexrelid = 'public.outbox_pickup_idx'::regclass),
  'outbox_pickup_idx es PARCIAL: su tamaño depende del atraso, no del histórico '
  'publicado. Total, degeneraría a medida que la cola se vacía');

select is(
  (select count(*) from public.outbox where status not in
     ('pending', 'in_flight', 'published', 'dead')),
  0::bigint,
  'ninguna fila con estado fuera de la máquina');

select * from finish();
rollback;
