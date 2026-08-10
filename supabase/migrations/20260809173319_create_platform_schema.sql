-- =============================================================================
-- Ladino — 1/4 · Esquema `platform`: uuidv7() y reject_mutation()
--
-- Módulo:         infraestructura de base de datos (S0.3)
-- Spec:           ADR-0025 §6 y §8, ADR-0006, ENGINEERING_STANDARDS.md §SQL
-- Reversibilidad: SÍ, completa mientras nada dependa del esquema:
--                   drop schema platform cascade;
--                 pgcrypto y el esquema `extensions` se dejan: los usa Supabase.
-- HOMOLOGATION_IMPACT: NO
--
-- Primera de cuatro. La migración monolítica original (1.520 líneas) se partió
-- porque fallaba entera ante cualquier error: un `create function` sobre un
-- esquema ajeno tumbaba las 62 sentencias correctas que venían antes. Cuatro
-- migraciones aplicables y probables por separado hacen que el ciclo dure
-- segundos en vez de minutos.
--
-- Esta no crea ninguna tabla. Solo el esquema propio y las dos funciones de
-- las que depende todo lo demás.
-- =============================================================================

-- =============================================================================
-- 0. Extensiones y esquemas
-- =============================================================================

-- pgcrypto aporta gen_random_bytes(), fuente de entropía de platform.uuidv7().
-- En Supabase vive en el esquema `extensions`; se referencia cualificada para
-- que la función pueda fijar search_path = '' sin quedar expuesta a secuestro
-- por resolución de nombres.
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- `platform` es la infraestructura interna del proyecto (ADR-0025 §8).
-- No se crea en `public` porque `public` es lo que Supabase expone por
-- PostgREST: cualquier función ahí es superficie de API HTTP salvo que se
-- revoque a mano, y acordarse de revocar es otra forma de "ausencia de
-- mecanismo" (CLAUDE.md §2).
create schema if not exists platform;

comment on schema platform is
  'Infraestructura interna de Ladino (uuidv7, triggers de defensa, helpers de '
  'alcance). Fuera de `public` para no quedar expuesta por PostgREST. ADR-0025 §8.';

revoke all on schema platform from public;
grant usage on schema platform to authenticated, service_role;


-- =============================================================================
-- 1. platform.uuidv7() — generación de PK ordenable por tiempo
-- =============================================================================

-- platform.uuidv7()
--
-- UUID v7 según RFC 9562: 48 bits de timestamp Unix en milisegundos, nibble de
-- versión = 7, 2 bits de variante = 0b10, el resto aleatorio de pgcrypto.
--
-- Existe porque Supabase corre PostgreSQL 17 y uuidv7() nativo llega en 18;
-- pg_uuidv7 no está en sus extensiones (discusión abierta, sin fecha).
--
-- CAMINO DE SALIDA cuando Supabase pase a PG 18:
--   ALTER TABLE ... ALTER COLUMN id SET DEFAULT uuidv7();
-- y esta función se deja de usar. NO hay migración de datos: los ids ya
-- emitidos son UUID v7 válidos y siguen ordenando igual. Cambia el DEFAULT,
-- los datos no.
--
-- Detalle de implementación: `set_bit` sobre bytea numera los bits dentro de
-- cada byte desde el BIT MENOS SIGNIFICATIVO. Por eso el nibble de versión
-- (nibble alto del byte 6) son los bits 52..55 y la variante (2 bits altos del
-- byte 8) son los bits 70..71.
--   versión  7 = 0111 -> bit55=0, bit54=1, bit53=1, bit52=1
--   variante   = 10   -> bit71=1, bit70=0
--
-- clock_timestamp(), no now(): now() es constante dentro de la transacción y
-- destruiría la ordenación temporal de las filas insertadas en un mismo
-- asiento, que es justo el motivo de usar v7.
create or replace function platform.uuidv7()
returns uuid
language sql
volatile
set search_path = ''
as $$
  with ts as (
    select substring(
             int8send(floor(extract(epoch from clock_timestamp()) * 1000)::bigint)
             from 3 for 6) as ms
  ),
  stamped as (
    select overlay(extensions.gen_random_bytes(16) placing ts.ms from 1 for 6) as b
      from ts
  ),
  versioned as (
    select set_bit(set_bit(set_bit(set_bit(b, 55, 0), 54, 1), 53, 1), 52, 1) as b
      from stamped
  )
  select encode(set_bit(set_bit(b, 71, 1), 70, 0), 'hex')::uuid from versioned;
$$;

comment on function platform.uuidv7() is
  'UUID v7 (RFC 9562) sobre pgcrypto. Sustituible por uuidv7() nativo cuando '
  'Supabase pase a PG18: cambia el DEFAULT, los datos no. ADR-0025 §8.';

revoke execute on function platform.uuidv7() from public;
-- EXECUTE es necesario para el rol que inserta: las expresiones DEFAULT se
-- evalúan con los privilegios de quien hace el INSERT, no del dueño de la tabla.
grant execute on function platform.uuidv7() to authenticated, service_role;


-- =============================================================================
-- 2. platform.reject_mutation() — segunda capa de ADR-0006
-- =============================================================================

-- FORCE ROW LEVEL SECURITY **no** contiene a un rol con BYPASSRLS, y en
-- Supabase `service_role` lo tiene. Las policies protegen de `anon` y
-- `authenticated`; NO protegen del worker ni de los jobs. Por eso la
-- inmutabilidad de las tablas append-only es un TRIGGER y no una policy
-- restrictiva (ADR-0025 §6).
--
-- NO ES REDUNDANCIA DEFENSIVA. Quitar este trigger porque "ya lo hace la RLS"
-- abriría UPDATE sobre journal_lines a todo proceso de servidor sin que ninguna
-- prueba de RLS lo notara.
--
-- Se define como función de trigger (RETURNS trigger), no como predicado de
-- policy. La usarán journal_entries, journal_lines, fiscal_events,
-- fiscal_documents, inventory_moves, audit_events y payment_ledger a partir
-- de S0.4.
create or replace function platform.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- El formato del RAISE va en un único literal a propósito: la concatenación
  -- de literales adyacentes es del lexer de SQL y no conviene apoyarse en ella
  -- dentro de RAISE.
  raise exception 'LADINO_APPEND_ONLY: % sobre %.% no está permitido. Las correcciones son reversiones y documentos nuevos, nunca ediciones (ADR-0006).',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'LAD06',
          hint    = 'Genere un asiento de reversión o una nota de crédito/débito.';
end;
$$;

comment on function platform.reject_mutation() is
  'Trigger BEFORE UPDATE OR DELETE para tablas append-only. Efectivo también '
  'para service_role, que tiene BYPASSRLS y por tanto escapa a las policies. '
  'ADR-0006 y ADR-0025 §6. SQLSTATE LAD06.';


