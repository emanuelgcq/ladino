-- =============================================================================
-- El acta de revocación dice de qué empresa era la asignación (ADR-0077, segunda revisión:
-- E1, E4, E7). Módulo: miembros / plataforma   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
--
-- Qué pasaba (migraciones 20261003120000 y 20261003120200, todavía sin desplegar):
--   · E1 (aislamiento): `lost_access_to_company` creía al `company_id` del acta
--     `member.role_revoked`, y `removeAssignment` la anclaba a la empresa de la CABECERA de quien
--     quitaba el rol. El Titular, con la cabecera de A, quita a P su rol en B: P pide A, donde
--     nunca trabajó, y recibe «tu acceso ya no está activo» (se le revela que A existe); pide B,
--     donde sí lo perdió, y recibe el 404 genérico. Es la fuga que cerró 20261003120100, por otra
--     puerta. Y `my_lost_access` llamaba «acceso perdido» a cualquier membresía sin empresa
--     visible, tuviera o no historia: las dos funciones no decían lo mismo;
--   · E4: en `accept_member_invitation`, `if v_status <> 'active'` dejaba pasar un NULL;
--   · E7: `invitation_preview` le decía a quien NO es el destinatario (estado `other_email`) a
--     qué negocio lo invitaban y de parte de quién: un enlace reenviado filtraba eso.
--
-- Qué hace:
--   1. platform.lost_access_to_company(empresa) — parte de 20261003120200. ENUNCIADO: el actor
--      perdió el acceso a la empresa X (que hoy no ve) si y solo si tiene una membresía en el
--      tenant de X y
--        (a) está DESACTIVADA y alguna de sus asignaciones alcanzaba X (de X, o de nivel tenant); o
--        (b) existe un acta `member.role_revoked` de esa membresía cuyo payload trae la clave
--            `assignment_company_id` con X, o con null (la asignación quitada era de nivel tenant
--            y alcanzaba todas las empresas del negocio).
--      El `company_id` del acta NO se lee. Un acta SIN la clave `assignment_company_id` (las
--      escritas antes de esta migración: solo existen en local y en pruebas) NO cuenta para
--      ninguna empresa: la regla es una sola, sin lista de excepciones.
--   2. platform.my_lost_access() — parte de 20261003120000. La MISMA regla, llamando a la función
--      de arriba: los negocios donde alguna empresa cumple `lost_access_to_company`.
--   3. platform.accept_member_invitation(token) — parte de 20261003120200. Solo cambia la segunda
--      comprobación de estado: `is distinct from 'active'`.
--   4. platform.invitation_preview(token) — parte de 20261003120000. Con `other_email` devuelve
--      solo el estado; empresa, negocio, rol, quién invita y vencimiento van NULL.
--
-- El dominio (packages/domain/src/members.ts, removeAssignment) escribe desde esta ola el acta
-- anclada a la empresa de la ASIGNACIÓN, con `assignment_company_id` en el payload.
--
-- Funciones que esta migración redefine: lost_access_to_company(uuid), my_lost_access(),
-- accept_member_invitation(text), invitation_preview(text). Ninguna migración posterior
-- (20261003130000 en adelante) las toca.
--
-- Reversible: SÍ, con datos vivos: son cuatro funciones sin estado y no hay cambio de tablas.
-- Revertir = `create or replace` con las definiciones de 20261003120200 (las dos primeras de la
-- lista de arriba que vienen de ahí) y 20261003120000, lo que REABRE la fuga E1. Las actas que la
-- API nueva ya escribió (con `assignment_company_id` y ancladas a la empresa de la asignación) se
-- quedan como están: son append-only y la definición vieja las lee por `company_id`, que en ellas
-- es la empresa correcta.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control, documentos ni libros.
-- =============================================================================

-- ── 1. El acceso perdido: por el alcance de la asignación, nunca por la cabecera ──
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
         -- (a) Desactivada, con un rol que alcanzaba ESTA empresa.
         (m.status <> 'active'
          and exists (select 1 from public.user_role_assignments u
                       where u.membership_id = m.id
                         and (u.company_id = c.id or u.company_id is null)))
         -- (b) El acta de que perdió una asignación que alcanzaba ESTA empresa. Se lee el
         --     alcance de la asignación (payload), no el company_id del acta. Sin la clave, el
         --     acta no cuenta.
         or exists (select 1 from public.audit_events a
                     where a.aggregate_type = 'membership' and a.aggregate_id = m.id
                       and a.event_type = 'member.role_revoked'
                       and a.tenant_id = c.tenant_id
                       and a.payload ? 'assignment_company_id'
                       and (a.payload->'assignment_company_id' = 'null'::jsonb
                            or a.payload->>'assignment_company_id' = c.id::text))
       ));
end;
$$;

-- ── 2. La lista de negocios perdidos: la misma regla ────────────────────────
create or replace function platform.my_lost_access()
returns table (business_name text, admin_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.ladino_service_actor_id();
begin
  if v_actor is null then
    raise exception 'el acceso perdido exige un actor' using errcode = '42501';
  end if;
  return query
  select t.name,
         (select up.full_name
            from public.memberships m2
            join public.user_role_assignments u on u.membership_id = m2.id and u.company_id is null
            join public.roles r on r.id = u.role_id and r.key = 'owner' and r.tenant_id is null
            left join public.users_profile up on up.user_id = m2.user_id
           where m2.tenant_id = m.tenant_id and m2.status = 'active'
           order by m2.created_at, m2.id
           limit 1)
    from public.memberships m
    join public.tenants t on t.id = m.tenant_id
   where m.user_id = v_actor
     -- Un negocio está «perdido» si alguna de sus empresas lo está, por la ÚNICA regla.
     and exists (
           select 1 from public.companies c
            where c.tenant_id = m.tenant_id
              and platform.lost_access_to_company(c.id))
   order by t.name, t.id;
end;
$$;

-- ── 3. Aceptar: el estado nulo no pasa (E4) ─────────────────────────────────
create or replace function platform.accept_member_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor uuid := platform.ladino_service_actor_id();
  i public.member_invitations%rowtype;
  v_membership uuid;
  v_status text;
  v_role uuid;
  v_requires boolean;
  v_assignment uuid;
begin
  if v_actor is null then
    raise exception 'aceptar una invitación exige un actor' using errcode = '42501';
  end if;

  select * into i from public.member_invitations
   where token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex')
   for update;
  if not found then
    raise exception 'esa invitación no existe' using errcode = 'LAD85';
  end if;
  if i.accepted_at is not null then
    -- La misma persona que repite (doble clic, recarga): ya está dentro, sin efecto doble.
    if i.accepted_by = v_actor then
      return i.company_id;
    end if;
    raise exception 'la invitación ya se usó' using errcode = 'LAD86';
  end if;
  if i.revoked_at is not null then
    raise exception 'la invitación fue anulada' using errcode = 'LAD86';
  end if;
  if i.expires_at <= now() then
    raise exception 'la invitación venció' using errcode = 'LAD87';
  end if;
  if i.email is not null and i.email is distinct from lower(platform.user_email(v_actor)) then
    raise exception 'la invitación es para otro correo' using errcode = 'LAD88';
  end if;

  -- Las aceptaciones de una persona en un negocio van de una en una (H8).
  perform pg_advisory_xact_lock(hashtext('ladino-invite-' || i.tenant_id::text || v_actor::text));

  -- H1: una membresía desactivada NO se reactiva con una invitación. Reactivar devuelve todas
  -- sus asignaciones; eso lo hace quien administra, desde Usuarios.
  select m.status into v_status
    from public.memberships m
   where m.tenant_id = i.tenant_id and m.user_id = v_actor;
  if v_status is not null and v_status <> 'active' then
    raise exception 'tu acceso a este negocio está desactivado' using errcode = 'LAD89';
  end if;

  -- Quien invitó tiene que poder seguir agregando personas a ESA empresa hoy.
  if i.created_by is null
     or not platform.ladino_user_has_permission(i.created_by, 'membership.manage', i.company_id) then
    raise exception 'quien invitó ya no gestiona las personas de esa empresa' using errcode = 'LAD90';
  end if;

  insert into public.memberships (tenant_id, user_id, created_by)
  values (i.tenant_id, v_actor, v_actor)
  on conflict (tenant_id, user_id) do nothing;
  select m.id, m.status into v_membership, v_status
    from public.memberships m
   where m.tenant_id = i.tenant_id and m.user_id = v_actor
   for update;
  -- E4: aquí la membresía TIENE que existir y estar activa. Un NULL (no se encontró) no pasa.
  if v_membership is null or v_status is distinct from 'active' then
    raise exception 'tu acceso a este negocio está desactivado' using errcode = 'LAD89';
  end if;

  select r.id, r.requires_scope into v_role, v_requires
    from public.roles r where r.key = i.role_key and r.tenant_id is null;

  select u.id into v_assignment
    from public.user_role_assignments u
   where u.membership_id = v_membership and u.role_id = v_role and u.company_id = i.company_id;
  if v_assignment is null then
    insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id,
                                              created_by)
    values (i.tenant_id, v_membership, v_role, i.company_id, v_actor)
    returning id into v_assignment;
    if v_requires then
      insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
      select i.tenant_id, i.company_id, v_assignment, 'warehouse', w.id
        from public.warehouses w
       where w.company_id = i.company_id;
    end if;
  end if;

  -- El Dueño invitado opera también su almacén (ADR-0049, ADR-0068 §3), como en addMember.
  if i.role_key = 'owner' then
    with wo as (
      insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id,
                                                created_by)
      select i.tenant_id, v_membership, r.id, i.company_id, v_actor
        from public.roles r
       where r.key = 'warehouse_ops' and r.tenant_id is null
         and not exists (
               select 1 from public.user_role_assignments u
                where u.membership_id = v_membership and u.role_id = r.id
                  and u.company_id = i.company_id)
      returning id
    )
    insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
    select i.tenant_id, i.company_id, wo.id, 'warehouse', w.id
      from wo cross join public.warehouses w
     where w.company_id = i.company_id;
  end if;

  update public.member_invitations
     set accepted_at = now(), accepted_by = v_actor
   where id = i.id;

  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values (i.tenant_id, i.company_id, 'membership', v_membership, 'member.invitation_accepted',
          'user', now(),
          coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'sin-version'),
          jsonb_build_object('invitation_id', i.id, 'user_id', v_actor, 'role_key', i.role_key,
                             'assignment_id', v_assignment, 'invited_by', i.created_by));
  return i.company_id;
end;
$$;

-- ── 4. La vista previa: a quien no es el destinatario, solo el estado (E7) ──
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
      select case
               when i.accepted_at is not null then 'used'
               when i.revoked_at is not null then 'revoked'
               when i.expires_at <= now() then 'expired'
               when i.email is not null
                    and i.email is distinct from lower(platform.user_email(v_actor))
                 then 'other_email'
               else 'pending'
             end as estado) v
    join public.companies c on c.id = i.company_id
    join public.tenants t on t.id = i.tenant_id
    left join public.users_profile up on up.user_id = i.created_by
   where i.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;

revoke all on function platform.lost_access_to_company(uuid) from public;
revoke all on function platform.my_lost_access() from public;
revoke all on function platform.accept_member_invitation(text) from public;
revoke all on function platform.invitation_preview(text) from public;
grant execute on function platform.lost_access_to_company(uuid) to ladino_api;
grant execute on function platform.my_lost_access() to ladino_api;
grant execute on function platform.accept_member_invitation(text) to ladino_api;
grant execute on function platform.invitation_preview(text) to ladino_api;
