-- =============================================================================
-- El acceso perdido se dice solo donde lo hubo (ADR-0077 §3, N-06).
-- Módulo: plataforma / alcance   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
--
-- Qué pasaba (en la migración anterior, 20261003120000, antes de salir de local):
--   `platform.lost_access_to_company` respondía «sí» a CUALQUIER miembro del tenant que pidiera
--   una empresa no visible. Un cajero con rol en la empresa A que pidiera la B del mismo tenant,
--   donde nunca trabajó, recibía «tu acceso ya no está activo» en vez del 404 de siempre: el
--   middleware de alcance revelaba que B existe. Lo cazó `apps/api/test/scope.test.ts` («los
--   TRES 404 son indistinguibles»), que es exactamente la defensa que la función no debía tocar.
--
-- Qué hace: redefine la función (parte de su única definición, 20261003120000). Cuenta como
-- acceso perdido SOLO:
--   · una membresía DESACTIVADA cuyas asignaciones alcanzaban esta empresa (de la empresa o de
--     nivel tenant), o que no tiene ninguna asignación;
--   · una membresía ACTIVA sin ninguna asignación (le quitaron el único rol).
-- Un miembro con rol en otra empresa del tenant, y un extraño, siguen recibiendo el 404.
--
-- Funciones que esta migración redefine: platform.lost_access_to_company(uuid). Ninguna migración
-- posterior la toca.
--
-- Reversible: SÍ, con datos vivos: es una función sin estado. Revertir = volver a la definición
-- de 20261003120000 (que reabre la revelación descrita arriba) o `drop function` junto con la
-- anterior; ningún dato depende de ella.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control, documentos ni libros.
-- =============================================================================

create or replace function platform.lost_access_to_company(p_company uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.ladino_service_actor_id();
begin
  if v_actor is null then
    return false;
  end if;
  return exists (
    select 1
      from public.companies c
      join public.memberships m on m.tenant_id = c.tenant_id and m.user_id = v_actor
     where c.id = p_company
       and c.id not in (select platform.ladino_user_company_ids(v_actor))
       and (
         -- Sin ningún rol en la cuenta (activa o desactivada): le quitaron el último.
         not exists (select 1 from public.user_role_assignments u where u.membership_id = m.id)
         -- Desactivada, con un rol que alcanzaba ESTA empresa.
         or (m.status <> 'active'
             and exists (select 1 from public.user_role_assignments u
                          where u.membership_id = m.id
                            and (u.company_id = c.id or u.company_id is null)))
       ));
end;
$$;

revoke all on function platform.lost_access_to_company(uuid) from public;
grant execute on function platform.lost_access_to_company(uuid) to ladino_api;
