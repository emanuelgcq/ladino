-- =============================================================================
-- Una invitación reenviada no dice nada, en ningún estado (ADR-0077, segunda revisión: E7).
-- Módulo: miembros / plataforma   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
--
-- Qué pasaba (migración 20261003120300, todavía sin desplegar): `platform.invitation_preview`
-- escondía empresa, negocio, rol y quién invita solo cuando el estado era `other_email`, y ese
-- estado se evaluaba DESPUÉS de `used`, `revoked` y `expired`. Una invitación ligada a un correo
-- que ya se usó, se anuló o venció seguía diciéndole a quien tuviera el enlace —sin ser el
-- destinatario— a qué negocio era y de parte de quién.
--
-- Qué hace: redefine `platform.invitation_preview(text)` partiendo de su definición viva
-- (20261003120300). `other_email` se evalúa PRIMERO: quien no es el destinatario de una
-- invitación ligada a un correo recibe solo ese estado, con todo lo demás en NULL, esté como
-- esté la invitación. El destinatario, y cualquiera con una invitación sin correo, sigue viendo
-- el estado real y los datos («Tu invitación a X venció: pide otra»).
--
-- Funciones que esta migración redefine: platform.invitation_preview(text). Ninguna migración
-- posterior (20261003130000 en adelante) la toca.
--
-- Reversible: SÍ, con datos vivos: es una función de lectura, sin estado. Revertir = `create or
-- replace` con la definición de 20261003120300, que reabre lo descrito arriba. Ningún dato cambia.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control, documentos ni libros.
-- =============================================================================

create or replace function platform.invitation_preview(p_token text)
returns table (status text, company_name text, business_name text, role_key text,
               inviter_name text, expires_at timestamptz)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.ladino_service_actor_id();
begin
  if v_actor is null then
    raise exception 'la vista previa de una invitación exige un actor' using errcode = '42501';
  end if;
  return query
  select v.estado,
         case when v.estado = 'other_email' then null else coalesce(c.trade_name, c.legal_name) end,
         case when v.estado = 'other_email' then null else t.name end,
         case when v.estado = 'other_email' then null else i.role_key end,
         case when v.estado = 'other_email' then null else up.full_name end,
         case when v.estado = 'other_email' then null else i.expires_at end
    from public.member_invitations i
    cross join lateral (
      -- `other_email` va PRIMERO: a quien no es el destinatario no se le dice nada más, tampoco
      -- si la invitación ya se usó, se anuló o venció.
      select case
               when i.email is not null
                    and i.email is distinct from lower(platform.user_email(v_actor))
                 then 'other_email'
               when i.accepted_at is not null then 'used'
               when i.revoked_at is not null then 'revoked'
               when i.expires_at <= now() then 'expired'
               else 'pending'
             end as estado) v
    join public.companies c on c.id = i.company_id
    join public.tenants t on t.id = i.tenant_id
    left join public.users_profile up on up.user_id = i.created_by
   where i.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;

revoke all on function platform.invitation_preview(text) from public;
grant execute on function platform.invitation_preview(text) to ladino_api;
