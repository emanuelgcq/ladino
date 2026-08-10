-- =============================================================================
-- Ladino — pgTAP 1/4 · Esquema `platform`
--
-- Cubre la migración `create_platform_schema`: el esquema propio,
-- platform.uuidv7() y platform.reject_mutation().
--
-- Autocontenido: crea su propia tabla de sondeo para el trigger, porque las
-- append-only reales llegan en S0.4. Probar la función ahora es lo que impide
-- que S0.4 la herede sin haberla visto fallar nunca.
-- =============================================================================

begin;
select plan(25);

-- =============================================================================
-- El esquema no queda expuesto
-- =============================================================================

select has_schema('platform', 'existe el esquema platform');
select has_schema('extensions', 'existe el esquema extensions');

select ok(
  (select count(*) from pg_extension e
     join pg_namespace n on n.oid = e.extnamespace
    where e.extname = 'pgcrypto' and n.nspname = 'extensions') = 1,
  'pgcrypto está instalada en `extensions`, no en public');

-- `platform` es infraestructura interna: fuera de public para que PostgREST no
-- la exponga, y sin USAGE para anon (ADR-0025 §8).
select ok(not has_schema_privilege('anon', 'platform', 'USAGE'),
  'anon NO tiene USAGE sobre platform');
select ok(has_schema_privilege('authenticated', 'platform', 'USAGE'),
  'authenticated tiene USAGE sobre platform');
select ok(has_schema_privilege('service_role', 'platform', 'USAGE'),
  'service_role tiene USAGE sobre platform');

-- =============================================================================
-- platform.uuidv7() — RFC 9562
-- =============================================================================

select has_function('platform', 'uuidv7', 'existe platform.uuidv7()');
select function_returns('platform', 'uuidv7', 'uuid', 'platform.uuidv7() devuelve uuid');

-- VOLATILE es obligatorio: una función STABLE como DEFAULT daría el mismo id a
-- todas las filas de una misma sentencia.
select is(
  (select provolatile::text from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'platform' and p.proname = 'uuidv7'),
  'v',
  'platform.uuidv7() es VOLATILE: si fuera STABLE, un INSERT ... SELECT daría '
  'el mismo id a todas las filas');

-- Nibble de versión = 7. Falsaría una implementación que emita v4 disfrazado.
select is(
  (select count(*) from generate_series(1, 200) g
    where substring(platform.uuidv7()::text from 15 for 1) <> '7'),
  0::bigint,
  'uuidv7: el nibble de versión es 7 en 200 generaciones');

-- Bits de variante = 0b10 (RFC 9562) -> primer carácter del cuarto grupo en
-- {8,9,a,b}. Falsaría un UUID malformado que otras librerías rechazarían.
select is(
  (select count(*) from generate_series(1, 200) g
    where substring(platform.uuidv7()::text from 20 for 1) not in ('8','9','a','b')),
  0::bigint,
  'uuidv7: los 2 bits de variante son 0b10 en 200 generaciones');

-- El timestamp está de verdad en los 48 bits altos, y es el de ahora.
select ok(
  abs(extract(epoch from clock_timestamp()) * 1000
      - ('x' || substring(replace(platform.uuidv7()::text, '-', '') from 1 for 12))::bit(48)::bigint
     ) < 5000,
  'uuidv7: los 48 bits altos son el timestamp Unix en ms del momento actual');

-- Monotonía: es TODO el motivo de usar v7. Sin esto, da igual v4.
create table public._ladino_test_uuid_seq (n int, u uuid);
do $$
declare i int;
begin
  for i in 1..10 loop
    insert into public._ladino_test_uuid_seq (n, u) values (i, platform.uuidv7());
    perform pg_sleep(0.003);
  end loop;
end;
$$;

select is(
  (select count(*) from public._ladino_test_uuid_seq a
     join public._ladino_test_uuid_seq b on b.n = a.n + 1
    where b.u <= a.u),
  0::bigint,
  'uuidv7: ids generados en secuencia ordenan por tiempo (monotonía)');

-- Unicidad con alta densidad: 20.000 generaciones caen en muy pocos ms, así que
-- la mayoría comparten los 48 bits de timestamp. Es la prueba real de que la
-- entropía dentro del mismo milisegundo alcanza.
--
-- NOTA: la concurrencia REAL (N sesiones simultáneas) no se puede montar desde
-- un fichero pgTAP, que corre en una sola conexión. Aquí se prueba la causa
-- raíz. La multi-sesión queda como job de pgbench aparte. VALIDAR-QA.
select is(
  (select count(distinct u) from (
     select platform.uuidv7() as u from generate_series(1, 20000)) s),
  20000::bigint,
  'uuidv7: 20.000 generaciones densas, cero colisiones');

-- Las expresiones DEFAULT se evalúan con los privilegios de quien inserta: sin
-- este GRANT, todo INSERT fallaría.
select ok(has_function_privilege('authenticated', 'platform.uuidv7()', 'EXECUTE'),
  'authenticated puede ejecutar platform.uuidv7() (lo exige el DEFAULT)');
select ok(not has_function_privilege('anon', 'platform.uuidv7()', 'EXECUTE'),
  'anon no puede ejecutar platform.uuidv7()');

-- =============================================================================
-- platform.reject_mutation() — la segunda capa de ADR-0006
-- =============================================================================

select has_function('platform', 'reject_mutation', 'existe platform.reject_mutation()');
select function_returns('platform', 'reject_mutation', 'trigger',
  'platform.reject_mutation() devuelve trigger, no boolean: es un trigger y no '
  'un predicado de policy (ADR-0025 §6)');

-- La premisa entera de que la inmutabilidad sea un trigger. Si esto cambiara,
-- ADR-0025 §6 habría que reescribirlo.
select ok(
  (select rolbypassrls from pg_roles where rolname = 'service_role'),
  'service_role tiene BYPASSRLS: por eso la inmutabilidad NO puede ser una '
  'policy (ADR-0025 §6)');

-- Tabla de sondeo. Las append-only reales llegan en S0.4; probar la función
-- ahora es lo que impide que S0.4 la herede sin haberla visto fallar nunca.
create table public._ladino_test_append_only (id uuid primary key default platform.uuidv7(), n int);
create trigger _ladino_test_append_only_immutable
  before update or delete on public._ladino_test_append_only
  for each row execute function platform.reject_mutation();

-- Sin este grant, Postgres corta el UPDATE en el chequeo de privilegios ANTES
-- de llegar al trigger, y el test "pasaría" con 42501 en vez de LAD06 — es
-- decir, por la razón equivocada. En Supabase real service_role sí tiene estos
-- privilegios sobre las tablas de `public`; la tabla de sondeo se crea dentro
-- de la transacción del test y no los hereda.
--
-- Lo que se quiere probar es justo esto: **incluso teniendo el privilegio**, el
-- trigger lo rechaza. Aserir por SQLSTATE y no por "falla" es lo que destapó
-- que faltaba.
grant select, insert, update, delete on public._ladino_test_append_only to service_role;

insert into public._ladino_test_append_only (n) values (1);

select lives_ok(
  $$ insert into public._ladino_test_append_only (n) values (2) $$,
  'INSERT sigue permitido: append-only, no read-only');

set local role service_role;

select is(current_user::text, 'service_role',
  'este bloque corre como service_role, el rol que la RLS NO contiene');

select throws_ok(
  $$ update public._ladino_test_append_only set n = 99 $$,
  'LAD06'::char(5), null::text,
  'UPDATE sobre append-only lanza excepción INCLUSO como service_role');

select throws_ok(
  $$ delete from public._ladino_test_append_only $$,
  'LAD06'::char(5), null::text,
  'DELETE sobre append-only lanza excepción INCLUSO como service_role');

reset role;

-- El id se generó solo: prueba de extremo a extremo de que el DEFAULT funciona
-- con los privilegios del insertador.
select is(
  (select count(*) from public._ladino_test_append_only where id is null),
  0::bigint,
  'el DEFAULT platform.uuidv7() rellenó la PK en todos los INSERT');

select is(
  (select count(distinct id) from public._ladino_test_append_only),
  2::bigint,
  'dos INSERT produjeron dos ids distintos');

select * from finish();
rollback;
