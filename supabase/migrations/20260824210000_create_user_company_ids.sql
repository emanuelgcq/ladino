-- =============================================================================
-- Ladino — migración 15 · platform.ladino_user_company_ids(uuid) — la visibilidad
-- por company, parametrizada por usuario (bloque 4, maestros)
--
-- Módulo: platform   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md · ADR-0025 · ADR-0027 §3-bis
-- Reversible: SÍ (drop de la función nueva; ladino_company_ids() vuelve a su cuerpo anterior)
-- Homologación: NO
--
-- POR QUÉ EXISTE. Los maestros (clientes, productos, impuestos) son de alcance
-- company, y `X-Company-Id` se rechaza hoy con COMPANY_SCOPE_NOT_IMPLEMENTED a
-- propósito: validarlo exige preguntar «¿qué companies ve ESTE usuario?» desde
-- la API (que no tiene JWT: el actor va en el GUC / como parámetro). Escribir
-- el JOIN a mano en el middleware sería la segunda copia de la resolución RBAC
-- (ADR-0027 §3-bis) — y la primera copia parcial (el JOIN de create-company)
-- ya tuvo una escalada por un filtro omitido.
--
-- DISEÑO: la versión PARAMETRIZADA es ahora LA copia única del JOIN, y
-- `ladino_company_ids()` (la de las policies de authenticated) DELEGA en ella.
-- El envoltorio va en plpgsql, NO en SQL: un envoltorio SQL sobre una función
-- SQL no inlinable replanifica el cuerpo EN CADA INVOCACIÓN (28× en S0.4;
-- skill migracion-supabase). El gate de coste de 015 reproduce esa trampa como
-- variante rota y comprueba que dispara.
-- =============================================================================

create or replace function platform.ladino_user_company_ids(p_user uuid)
returns setof uuid
language sql
stable security definer
set search_path = ''
as $$
  select c.id
    from public.companies c
   where exists (
     select 1
       from public.memberships m
       join public.user_role_assignments ura on ura.membership_id = m.id
      where m.user_id   = p_user
        and m.status    = 'active'
        and m.tenant_id = c.tenant_id
        and (ura.company_id = c.id or ura.company_id is null)
   );
$$;

comment on function platform.ladino_user_company_ids(uuid) is
  'Companies visibles para p_user: membership ACTIVO en el tenant y alguna '
  'asignación de rol que alcance la company (directa o tenant-wide con '
  'company_id null). LA copia única del JOIN de visibilidad (ADR-0027 §3-bis): '
  'ladino_company_ids() delega aquí, y el middleware de scope la consulta por '
  'petición con el actor del GUC. Los roles acotados (requires_scope) VEN la '
  'company: el alcance fino lo deciden los permisos, no la visibilidad.';

revoke execute on function platform.ladino_user_company_ids(uuid) from public;
-- La API la consulta con el actor explícito (middleware de scope). El camino
-- authenticated NO la ejecuta directamente: pasa por ladino_company_ids().
grant execute on function platform.ladino_user_company_ids(uuid) to ladino_api;

-- El envoltorio: MISMO contrato, MISMA ACL, cuerpo delegado. plpgsql a
-- propósito — ver cabecera. CREATE OR REPLACE conserva la ACL existente
-- (postgres + authenticated).
create or replace function platform.ladino_company_ids()
returns setof uuid
language plpgsql
stable security definer
set search_path = ''
as $$
begin
  return query select platform.ladino_user_company_ids(auth.uid());
end;
$$;

comment on function platform.ladino_company_ids() is
  'Companies visibles para auth.uid(). Desde la migración 15 DELEGA en '
  'ladino_user_company_ids(uuid) — una sola copia del JOIN. El envoltorio es '
  'plpgsql y NO SQL: un envoltorio SQL replanificaría el cuerpo por invocación '
  '(la regresión de 28× de S0.4). Se invoca como InitPlan en las policies: '
  'una vez por sentencia.';
