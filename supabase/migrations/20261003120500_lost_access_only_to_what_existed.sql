-- =============================================================================
-- El acceso perdido es solo a lo que existía (ADR-0077, tercera revisión).
-- Módulo: plataforma / alcance   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
--
-- Qué pasaba (migración 20261003120300, todavía sin desplegar): un rol de NIVEL TENANT alcanza
-- todas las empresas del negocio, y `lost_access_to_company` daba «acceso perdido» por él para
-- CUALQUIER empresa del tenant, también las creadas DESPUÉS de quitarle el rol o de desactivar la
-- membresía. A esas la persona nunca tuvo acceso: decirle «tu acceso ya no está activo» le
-- revelaba que existen.
--
-- Qué hace: redefine `platform.lost_access_to_company(uuid)` partiendo de su definición viva
-- (20261003120300). ENUNCIADO COMPLETO — el actor perdió el acceso a la empresa X (que hoy no ve)
-- si y solo si tiene una membresía en el tenant de X y se cumple una de estas:
--   (a) la membresía está DESACTIVADA y
--        · tiene una asignación de la propia X; o
--        · tiene una asignación de nivel tenant, existe un acta `member.deactivated` de esa
--          membresía, y X ya existía en el instante de la ÚLTIMA desactivación
--          (`companies.created_at <= audit_events.occurred_at`). Sin acta de desactivación no hay
--          instante fiable (`memberships` no guarda cuándo cambió de estado): no cuenta;
--   (b) existe un acta `member.role_revoked` de esa membresía cuyo payload trae
--        · `assignment_company_id` = X; o
--        · `assignment_company_id` = null (la asignación quitada era de nivel tenant) y X ya
--          existía cuando se quitó (`companies.created_at <= audit_events.occurred_at`).
-- Las dos comparaciones son de INSTANTE contra INSTANTE: `companies.created_at` y
-- `audit_events.occurred_at` son `timestamptz`; no hay ningún `date` que se convierta a medianoche.
-- El `company_id` del acta no se lee.
--
-- CORRECCIÓN a la cabecera de 20261003120300 (que no se puede editar): decía que las actas
-- `member.role_revoked` sin la clave `assignment_company_id` «solo existen en local y en
-- pruebas». No es cierto: la versión desplegada ya escribe ese acta sin la clave, así que pueden
-- existir en producción si alguien quitó un rol. La regla no cambia y sigue siendo una sola: las
-- actas anteriores no llevan la clave y NO cuentan; esa persona recibe el NOT_FOUND genérico
-- (falla cerrado: no se le revela nada, y tampoco se le avisa).
--
-- `platform.my_lost_access()` no se redefine: llama a esta función y hereda la regla.
--
-- Funciones que esta migración redefine: platform.lost_access_to_company(uuid). Ninguna
-- migración posterior (20261003130000 en adelante) la toca.
--
-- Reversible: SÍ, con datos vivos: es una función de lectura, sin estado. Revertir = `create or
-- replace` con la definición de 20261003120300, que vuelve a decir «acceso perdido» en empresas
-- creadas después. Ningún dato cambia.
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
         -- (a) Desactivada, con un rol de ESTA empresa…
         (m.status <> 'active'
          and (exists (select 1 from public.user_role_assignments u
                        where u.membership_id = m.id and u.company_id = c.id)
               -- …o con un rol de nivel tenant, si la empresa ya existía en el instante de la
               -- última desactivación (timestamptz contra timestamptz). Sin acta, no cuenta.
               or (exists (select 1 from public.user_role_assignments u
                            where u.membership_id = m.id and u.company_id is null)
                   and c.created_at <= (select max(d.occurred_at)
                                          from public.audit_events d
                                         where d.aggregate_type = 'membership'
                                           and d.aggregate_id = m.id
                                           and d.tenant_id = c.tenant_id
                                           and d.event_type = 'member.deactivated'))))
         -- (b) El acta de que perdió una asignación que alcanzaba ESTA empresa: la de la propia
         --     empresa, o una de nivel tenant quitada cuando la empresa ya existía (timestamptz
         --     contra timestamptz). Se lee el alcance del payload, nunca el company_id del acta;
         --     sin la clave, el acta no cuenta.
         or exists (select 1 from public.audit_events a
                     where a.aggregate_type = 'membership' and a.aggregate_id = m.id
                       and a.event_type = 'member.role_revoked'
                       and a.tenant_id = c.tenant_id
                       and a.payload ? 'assignment_company_id'
                       and (a.payload->>'assignment_company_id' = c.id::text
                            or (a.payload->'assignment_company_id' = 'null'::jsonb
                                and c.created_at <= a.occurred_at)))
       ));
end;
$$;

revoke all on function platform.lost_access_to_company(uuid) from public;
grant execute on function platform.lost_access_to_company(uuid) to ladino_api;
