-- =============================================================================
-- La revisión de la invitación y del acceso perdido (ADR-0077, nota de la revisión; H1, H4, H6,
-- H7, H8). Módulo: miembros / plataforma   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
--
-- Qué pasaba (migraciones 20261003120000 y 20261003120100, todavía sin desplegar):
--   · H1: aceptar una invitación REACTIVABA una membresía desactivada si quien invitó gobernaba
--     la cuenta, y con ella volvían TODAS sus asignaciones (un Dueño desactivado invitado como
--     cajero recuperaba su owner). Una invitación no es una reactivación;
--   · H4: `lost_access_to_company` decía «acceso perdido» a cualquier miembro activo sin roles,
--     tuviera o no historia en esa empresa, y no se lo decía a quien perdió A1 y conserva A2;
--   · H6: `bootstrap_another_tenant` aceptaba cualquier `p_user` (la API pasa el suyo, pero la
--     función no lo exigía);
--   · H7: una invitación de Dueño podía ir sin correo: quien tuviera el enlace entraba como Dueño;
--   · H8: dos invitaciones del mismo negocio aceptadas a la vez por la misma persona chocaban en
--     el único (tenant_id, user_id) de memberships y respondían 500.
--
-- Qué hace (cada función parte de su definición VIVA: 20261003120000 para las dos primeras,
-- 20261003120100 para lost_access_to_company):
--   1. accept_member_invitation: una membresía desactivada → LAD89, SIEMPRE (no se reactiva);
--      quien invitó sin membership.manage sobre la empresa pasa a LAD90 (antes compartía LAD89);
--      candado por (tenant, persona) y `on conflict (tenant_id, user_id) do nothing` con relectura
--      `for update`: la segunda aceptación simultánea espera y reutiliza la membresía.
--   2. bootstrap_another_tenant: `p_user` tiene que ser el actor del GUC (42501 si no).
--   3. lost_access_to_company: cuenta como acceso perdido una membresía desactivada cuyo rol
--      alcanzaba la empresa, o el ACTA `member.role_revoked` de esa membresía en esa empresa.
--   4. CHECK: la invitación de Dueño lleva correo. Las de Dueño sin correo que estén ABIERTAS se
--      anulan antes (revoked_at); el CHECK nace NOT VALID para no juzgar las filas ya cerradas,
--      que el guardián impide volver a tocar.
--
-- Funciones que esta migración redefine: platform.accept_member_invitation(text),
-- platform.bootstrap_another_tenant(uuid, text, text), platform.lost_access_to_company(uuid).
-- Ninguna migración posterior las toca.
--
-- Reversible: SÍ, con datos vivos. Las tres funciones vuelven a su definición anterior con
-- `create or replace` (la de 20261003120000 / 120100); el CHECK se retira con `drop constraint`.
-- Lo que NO se deshace solo: las invitaciones de Dueño sin correo que esta migración anuló quedan
-- anuladas (se reconocen por `role_key = 'owner' and email is null and revoked_at` posterior a la
-- migración); se reinvita.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control, documentos ni libros.
-- =============================================================================

-- ── 1. Aceptar: nunca reactiva, y sin 500 en la carrera ─────────────────────
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
  if v_status <> 'active' then
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

-- ── 2. «Crear otra empresa»: solo para el propio actor ──────────────────────
create or replace function platform.bootstrap_another_tenant(p_user uuid, p_name text, p_tax_id text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_membership uuid;
  v_nombre text := regexp_replace(lower(btrim(coalesce(p_name, ''))), '[[:space:]]+', ' ', 'g');
begin
  -- H6: nadie abre un negocio a nombre de otra persona.
  if p_user is distinct from platform.ladino_service_actor_id() then
    raise exception 'solo se abre un negocio a nombre propio' using errcode = '42501';
  end if;
  if p_user is null or length(v_nombre) < 2 then
    raise exception 'el negocio necesita un nombre' using errcode = 'LAD80';
  end if;
  -- El MISMO candado que bootstrap_tenant: los altas de una persona van de una en una.
  perform pg_advisory_xact_lock(hashtext('ladino-bootstrap-' || p_user::text));

  -- Lo de la cuenta lo gobierna el TITULAR (ADR-0068 §3): la asignación `owner` de nivel tenant,
  -- en una membresía activa de un tenant activo.
  if not exists (
    select 1
      from public.memberships m
      join public.tenants t on t.id = m.tenant_id and t.status = 'active'
      join public.user_role_assignments u on u.membership_id = m.id and u.company_id is null
      join public.roles r on r.id = u.role_id and r.key = 'owner' and r.tenant_id is null
     where m.user_id = p_user and m.status = 'active') then
    raise exception 'crear otra empresa es del Titular de una cuenta' using errcode = 'LAD93';
  end if;

  -- La clave natural: ni el mismo nombre ni el mismo RIF entre los negocios de la persona.
  if exists (
    select 1
      from public.memberships m
      join public.tenants t on t.id = m.tenant_id
     where m.user_id = p_user and m.status = 'active'
       and regexp_replace(lower(btrim(t.name)), '[[:space:]]+', ' ', 'g') = v_nombre)
  or (p_tax_id is not null and exists (
    select 1
      from public.memberships m
      join public.companies c on c.tenant_id = m.tenant_id
     where m.user_id = p_user and m.status = 'active'
       and upper(regexp_replace(c.tax_id, '[^A-Za-z0-9]', '', 'g'))
           = upper(regexp_replace(p_tax_id, '[^A-Za-z0-9]', '', 'g')))) then
    raise exception 'ya tienes un negocio con ese nombre o ese RIF' using errcode = 'LAD94';
  end if;

  insert into public.tenants (name) values (btrim(p_name)) returning id into v_tenant;
  insert into public.memberships (tenant_id, user_id, created_by)
  values (v_tenant, p_user, p_user) returning id into v_membership;
  insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id, created_by)
  select v_tenant, v_membership, r.id, null, p_user
    from public.roles r
   where r.tenant_id is null and r.key in ('owner', 'warehouse_ops');
  return v_tenant;
end;
$$;

-- ── 3. El acceso perdido exige historia ─────────────────────────────────────
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
         -- Desactivada, con un rol que alcanzaba ESTA empresa.
         (m.status <> 'active'
          and exists (select 1 from public.user_role_assignments u
                       where u.membership_id = m.id
                         and (u.company_id = c.id or u.company_id is null)))
         -- El acta de que perdió su rol en ESTA empresa (aunque conserve otra).
         or exists (select 1 from public.audit_events a
                     where a.aggregate_type = 'membership' and a.aggregate_id = m.id
                       and a.event_type = 'member.role_revoked' and a.company_id = c.id)
       ));
end;
$$;

revoke all on function platform.accept_member_invitation(text) from public;
revoke all on function platform.bootstrap_another_tenant(uuid, text, text) from public;
revoke all on function platform.lost_access_to_company(uuid) from public;
grant execute on function platform.accept_member_invitation(text) to ladino_api;
grant execute on function platform.bootstrap_another_tenant(uuid, text, text) to ladino_api;
grant execute on function platform.lost_access_to_company(uuid) to ladino_api;

-- ── 4. La invitación de Dueño lleva correo (H7) ─────────────────────────────
update public.member_invitations
   set revoked_at = now()
 where role_key = 'owner' and email is null and accepted_at is null and revoked_at is null;
alter table public.member_invitations
  add constraint member_invitations_owner_email_chk
  check (role_key <> 'owner' or email is not null) not valid;
