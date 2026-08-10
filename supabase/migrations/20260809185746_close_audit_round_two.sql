-- =============================================================================
-- Ladino — 6/6 · Cierre de la segunda auditoría de S0.3
--
-- Módulo:         aislamiento multi-tenant (S0.3)
-- Spec:           ADR-0025 §6, §9.1, §9.5; CLAUDE.md regla 3 y §2
-- Reversibilidad: SÍ, pero revertir el punto 1 o el 3 reabre un agujero.
-- HOMOLOGATION_IMPACT: NO
--
-- Los cuatro hallazgos son defectos de la migración 5/5, no de las anteriores.
-- Arreglar una fuga introdujo otras tres.
-- =============================================================================


-- =============================================================================
-- 1. ALTO-1 — el trigger de ancla faltaba en `roles` y `role_permissions`
--
-- 5/5 escribe en su propio comentario que "el bloque RBAC también ancla en
-- tenant_id, y el mismo razonamiento aplica", y a continuación cubre tres de
-- las cinco tablas. Estas dos se quedaron fuera.
--
-- La cadena que abría es peor que la fuga original:
--
--   service_role: update roles set tenant_id = A where id = <rol de B>
--   tenant A concede a "su" rol:  insert role_permissions(..., 'warehouse.manage')
--   resultado:  un usuario de B gana ese permiso DENTRO DE B
--
-- `assert_rbac_tenant_coherence` valida al escribir `role_permissions`, pero
-- **nunca se reevalúa cuando cambia `roles.tenant_id`**: el invariante se rompe
-- por el otro lado. Es el mismo patrón que el tercer flanco de §4 —el que
-- reclasifica un permiso— y por eso allí hay tres triggers y no dos.
--
-- `tenant_id` es NULLABLE en las dos (null = rol de sistema). `is distinct from`
-- lo trata bien: convertir un rol de sistema en rol de tenant, o al revés, es
-- un cambio de propiedad y también se rechaza.
-- =============================================================================

create trigger roles_anchors_immutable
  before update on public.roles
  for each row execute function platform.assert_isolation_anchors_immutable();

create trigger role_permissions_anchors_immutable
  before update on public.role_permissions
  for each row execute function platform.assert_isolation_anchors_immutable();


-- =============================================================================
-- 2. ALTO-2 — el `revoke` que parecía proteger y no protegía
--
-- 5/5 hizo:
--     alter default privileges in schema public revoke all on functions
--       from anon, authenticated;
--
-- y eso es un NO-OP: el `EXECUTE` por defecto sobre una función lo tiene
-- **PUBLIC**, no `anon` ni `authenticated`. Revocar de quien no lo tiene no
-- quita nada. Una función nueva en `public` seguía siendo ejecutable por `anon`.
--
-- LA FORMA QUE PARECE CORRECTA TAMPOCO FUNCIONA. Verificado tres veces:
--
--     alter default privileges [for role postgres] in schema public
--       revoke execute on functions from public;
--     create function public.z() returns int language sql as 'select 1';
--     -- proacl = NULL,  has_function_privilege('anon', ...) = true
--
-- `pg_default_acl` guarda la entrada —`{postgres=X/postgres}`— y Postgres la
-- IGNORA al crear la función: sale con `proacl` NULL, o sea el default de
-- fábrica, que concede EXECUTE a PUBLIC. Con tablas y secuencias el mismo
-- `alter` sí funciona; con funciones, no.
--
-- Así que NO existe configuración que cierre esto por defecto, y escribir un
-- `alter` que no hace nada es peor que no escribirlo: el flanco parece cubierto.
-- Lo que queda son dos cosas, y ninguna es un `alter`:
--
--   1. REGLA — las funciones de dominio NO van en `public`. Van en `platform`,
--      que PostgREST no expone y donde `anon` no tiene USAGE. `public` es la
--      superficie HTTP de Supabase: poner ahí una RPC es publicarla. Está en
--      ADR-0025 §8 y en supabase/CLAUDE.md.
--
--   2. DETECTOR — un test pgTAP que afirme que NINGUNA función de `public` es
--      ejecutable por `anon`. No lo impide al crearla; lo hace fallar en CI,
--      que es donde sí se puede. Ver 006_audit_round_two_test.sql.
--
-- Lo único que esta migración puede hacer es cerrar lo ya existente. Eso sí
-- surte efecto, porque actúa sobre ACL materializadas y no sobre un default.
-- =============================================================================

revoke execute on all functions in schema public from public, anon, authenticated;



-- =============================================================================
-- 3. ALTO-3 — la defensa que cerró el único camino autorizado
--
-- 5/5 fijó `created_by := auth.uid()` sin excepción, para que el cliente no
-- pudiera atribuir una fila a otro usuario. Correcto. Pero con `service_role`
-- —que es el ÚNICO camino por el que 4/4 permite crear tenants, companies,
-- memberships y asignaciones de rol— `auth.uid()` es NULL.
--
-- Resultado: el 100 % de esas altas quedaban con autor NULL, y el servidor no
-- tenía forma de corregirlo. Se hizo `created_by` no forjable y a la vez no
-- escribible por el único que puede escribirlo. La regla 3 de CLAUDE.md quedaba
-- insatisfacible justo en el camino que 5/5 citaba para justificarse.
--
-- El arreglo es un GUC de transacción que la API fija antes de escribir:
--
--     set local ladino.actor_id = '<uuid del usuario autenticado>';
--
-- `current_setting(..., true)` devuelve NULL si no está fijado, así que no
-- rompe migraciones ni seeds.
--
-- ⚠️  ESTO ES CONTRATO CON S0.5, NO UN DETALLE DE ESTA MIGRACIÓN.
--     Si la API olvida fijar el GUC, `created_by` vuelve a NULL EN SILENCIO:
--     no hay error, la fila se escribe, y el vacío solo aparece en una
--     auditoría meses después. Ver docs/04_PLATFORM/API_SPEC.md §Procedencia.
-- =============================================================================

create or replace function platform.set_row_provenance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid;
begin
  -- auth.uid() para el camino `authenticated`; el GUC para el camino servidor,
  -- donde no hay JWT de usuario. Ninguno de los dos lo controla el cliente:
  -- el GUC lo fija la API dentro de la transacción, nunca el payload.
  v_actor := coalesce(
    auth.uid(),
    nullif(current_setting('ladino.actor_id', true), '')::uuid
  );

  if tg_op = 'INSERT' then
    new.created_by := v_actor;
    new.created_at := now();
    new.version    := 1;
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.version    := old.version + 1;
  end if;
  return new;
end;
$$;

comment on function platform.set_row_provenance() is
  'Gobierna created_by, created_at y version: el cliente no los elige. El actor '
  'sale de auth.uid() (camino authenticated) o del GUC de transacción '
  'ladino.actor_id (camino servidor con service_role, donde auth.uid() es NULL). '
  'CONTRATO S0.5: la API DEBE fijar `set local ladino.actor_id` antes de escribir; '
  'si lo olvida, created_by queda NULL en silencio. Regla 3 de CLAUDE.md.';

revoke execute on function platform.set_row_provenance() from public;


-- =============================================================================
-- 4. MEDIO-2 — `create or replace` resetea `proconfig`
--
-- El `create or replace function platform.reject_mutation()` de 5/5 no repitió
-- `set search_path = ''`, y `create or replace` **no conserva** la
-- configuración de la función: la reemplaza entera. Quedó como la única de las
-- doce funciones de `platform` sin el pin.
--
-- No es explotable —la función solo hace `raise`— pero rompe el patrón que
-- ADR-0025 §5 declara obligatorio, y el linter de Supabase lo marcará como
-- `function_search_path_mutable` en cuanto cuelgue de `journal_lines`.
--
-- La lección operativa: **un `create or replace` es un reemplazo completo.**
-- Repite SIEMPRE `security definer`, `set search_path` y la volatilidad, aunque
-- solo cambies el cuerpo.
-- =============================================================================

create or replace function platform.reject_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'LADINO_APPEND_ONLY: % sobre %.% está prohibido. Esta tabla es append-only: '
    'se corrige con una reversión, nunca con una mutación.',
    tg_op, tg_table_schema, tg_table_name
    using errcode = 'LAD06',
          hint    = 'Genere un asiento de reversión o una nota de crédito/débito.';
end;
$$;

comment on function platform.reject_mutation() is
  'Trigger para tablas append-only. Cubre UPDATE, DELETE y TRUNCATE (este '
  'último exige FOR EACH STATEMENT). Efectivo también para service_role, que '
  'tiene BYPASSRLS y escapa a las policies (ADR-0006, ADR-0025 §6). '
  'SQLSTATE LAD06.';

revoke execute on function platform.reject_mutation() from public;
