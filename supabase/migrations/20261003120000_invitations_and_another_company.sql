-- =============================================================================
-- La invitación por enlace, la segunda empresa y el acceso perdido (ADR-0077).
-- Módulo: miembros / plataforma   Spec: docs/04_PLATFORM/MULTITENANCY_AND_RBAC.md
-- Hallazgos: A-13, E-15 (segunda empresa), N-08, K-09 (invitación), N-03, N-06 (acceso perdido).
--
-- Qué pasaba:
--   · `platform.bootstrap_tenant` impone un negocio por persona (LAD81) y la web solo ofrecía el
--     alta con cero empresas: no había forma de abrir una segunda desde dentro (A-13, E-15);
--   · agregar a alguien exigía que ya tuviera cuenta, y quien se registraba para que lo agregaran
--     caía en «Vamos a montar tu negocio» (N-08, K-09);
--   · quien perdía el rol o la membresía veía la misma pantalla de alta, y su caja abierta
--     respondía el 404 genérico «Eso no existe o no está disponible para ti» (N-03, N-06).
--
-- Qué hace:
--   1. `public.member_invitations`: la invitación por enlace. Guarda la HUELLA del token
--      (sha256 en hex), nunca el token; la empresa, el rol, el correo opcional al que se liga, la
--      expiración (como mucho 30 días), y el cierre: aceptada (quién y cuándo) o revocada. Una
--      fila cerrada no cambia más, y de una abierta solo cambia su cierre (trigger guardián).
--      Ancla de aislamiento, procedencia, sin DELETE ni TRUNCATE. RLS: `authenticated` solo lee
--      las de empresas donde tiene `membership.read`; nada más. `ladino_api` lee, inserta y
--      cierra dentro de los tenants del actor.
--   2. `platform.invitation_preview(token)`: lo que la persona invitada puede ver ANTES de ser
--      miembro (empresa, negocio, rol, quién invita, estado). Por eso es SECURITY DEFINER: la
--      persona todavía no pertenece al tenant y la RLS no le deja ver la fila.
--   3. `platform.accept_member_invitation(token)`: consume la invitación UNA vez, con la fila
--      bloqueada: crea (o reactiva, si quien invitó gobierna la cuenta) la membresía, la
--      asignación acotada a la empresa con sus bindings de almacén, el `warehouse_ops` del Dueño
--      invitado (ADR-0068 §3), cierra la invitación y deja el acta. La misma persona que repite
--      recibe la empresa sin efecto doble; otra persona, LAD86.
--   4. `platform.bootstrap_another_tenant(usuario, nombre, rif)`: «Crear otra empresa». Solo el
--      TITULAR de alguna cuenta (asignación `owner` de nivel tenant, ADR-0068 §3). Cada empresa es
--      su propio tenant y la persona nace Titular y Dueño, como en el registro. La clave natural
--      (la idempotencia de este alta): el mismo nombre de negocio, o el mismo RIF, entre los
--      negocios de la persona → LAD94. `bootstrap_tenant` NO se toca: el registro sigue siendo
--      uno por persona y LAD81 sigue protegiendo el doble clic del primer día.
--   5. `platform.my_lost_access()` y `platform.lost_access_to_company(empresa)`: los negocios donde
--      el actor tiene membresía pero ninguna empresa visible (desactivado, o sin rol), con el
--      nombre de quien administra (el Titular). Solo ve SU propia historia: quien nunca fue
--      miembro de un negocio no sabe por aquí que existe.
--
-- Funciones que esta migración CREA (ninguna redefine una existente).
--
-- Reversible: SÍ, con datos vivos, así:
--   · las cinco funciones se retiran con `drop function` (la API desplegada antes de esta versión
--     no las llama);
--   · `member_invitations` se retira con `drop table`. Lo que se PIERDE es la lista de
--     invitaciones (pendientes y cerradas); las ACEPTADAS ya produjeron su membresía, su
--     asignación y su acta en `audit_events`, que no dependen de la tabla y quedan;
--   · los tenants creados con «Crear otra empresa» son tenants normales: revertir no los borra,
--     igual que no se borra uno fundado por el registro.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control, documentos ni libros.
-- =============================================================================

-- ── 1. La tabla ──────────────────────────────────────────────────────────────
create table public.member_invitations (
  id           uuid        primary key default platform.uuidv7(),
  tenant_id    uuid        not null,
  company_id   uuid        not null,
  role_key     text        not null,
  -- Opcional: si se da, solo la cuenta con ese correo acepta (un enlace reenviado no sirve).
  email        text,
  -- La HUELLA del token (sha256, hex). El token solo existe en la respuesta que lo crea.
  token_hash   text        not null,
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  accepted_by  uuid,
  revoked_at   timestamptz,

  created_by   uuid,
  created_at   timestamptz not null,
  version      integer     not null,

  constraint member_invitations_tenant_fk foreign key (tenant_id)
    references public.tenants (id),
  constraint member_invitations_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint member_invitations_accepted_by_fk foreign key (accepted_by)
    references auth.users (id),
  -- Los seis roles de sistema asignables (los mismos que AddMemberRequest).
  constraint member_invitations_role_chk check (
    role_key in ('owner', 'cashier', 'store_manager', 'back_office', 'accountant',
                 'warehouse_ops')),
  constraint member_invitations_token_hash_key unique (token_hash),
  constraint member_invitations_token_hash_chk check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint member_invitations_email_chk check (
    email is null
    or (email = lower(btrim(email)) and length(email) <= 320 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  constraint member_invitations_expiry_chk check (
    expires_at > created_at and expires_at <= created_at + interval '30 days'),
  constraint member_invitations_accepted_chk check ((accepted_at is null) = (accepted_by is null)),
  constraint member_invitations_one_end_chk check (accepted_at is null or revoked_at is null)
);
create index member_invitations_company_idx
  on public.member_invitations (company_id, created_at desc);
create index member_invitations_tenant_idx on public.member_invitations (tenant_id);
comment on table public.member_invitations is
  'Invitación por enlace (ADR-0077 §3). Guarda la huella sha256 del token, nunca el token. Un '
  'solo uso: aceptada o revocada, la fila no cambia más. Se consume por '
  'platform.accept_member_invitation, que es la única vía que crea la membresía del invitado.';

-- El guardián: de una invitación abierta solo cambia su cierre; una cerrada no cambia.
create function platform.member_invitations_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.accepted_at is not null or old.revoked_at is not null then
    raise exception 'la invitación % ya se cerró y no cambia', old.id using errcode = 'LAD06';
  end if;
  if (new.id, new.tenant_id, new.company_id, new.role_key, new.email, new.token_hash,
      new.expires_at)
     is distinct from
     (old.id, old.tenant_id, old.company_id, old.role_key, old.email, old.token_hash,
      old.expires_at) then
    raise exception 'de una invitación solo cambia su cierre (aceptada o revocada)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;

create trigger member_invitations_00_provenance
  before insert or update on public.member_invitations
  for each row execute function platform.set_row_provenance();
create trigger member_invitations_01_anchors
  before update on public.member_invitations
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger member_invitations_02_guard
  before update on public.member_invitations
  for each row execute function platform.member_invitations_guard();
create trigger member_invitations_no_delete
  before delete on public.member_invitations
  for each row execute function platform.reject_mutation();
create trigger member_invitations_no_truncate
  before truncate on public.member_invitations
  for each statement execute function platform.reject_mutation();

alter table public.member_invitations enable row level security;
alter table public.member_invitations force  row level security;
create policy member_invitations_select on public.member_invitations for select
  to authenticated
  using (company_id in (select platform.ladino_company_ids())
         and platform.ladino_has_permission('membership.read', company_id));
create policy member_invitations_insert on public.member_invitations for insert
  to authenticated with check (false);
create policy member_invitations_update on public.member_invitations for update
  to authenticated using (false);
create policy member_invitations_delete on public.member_invitations for delete
  to authenticated using (false);
create policy member_invitations_api_select on public.member_invitations for select
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy member_invitations_api_insert on public.member_invitations for insert
  to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy member_invitations_api_update on public.member_invitations for update
  to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy member_invitations_api_delete on public.member_invitations for delete
  to ladino_api using (false);

grant select on public.member_invitations to authenticated;
grant select, insert, update on public.member_invitations to ladino_api;

-- ── 2. Lo que ve la persona invitada antes de entrar ────────────────────────
create function platform.invitation_preview(p_token text)
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
  select case
           when i.accepted_at is not null then 'used'
           when i.revoked_at is not null then 'revoked'
           when i.expires_at <= now() then 'expired'
           when i.email is not null
                and i.email is distinct from lower(platform.user_email(v_actor)) then 'other_email'
           else 'pending'
         end,
         coalesce(c.trade_name, c.legal_name), t.name, i.role_key, up.full_name, i.expires_at
    from public.member_invitations i
    join public.companies c on c.id = i.company_id
    join public.tenants t on t.id = i.tenant_id
    left join public.users_profile up on up.user_id = i.created_by
   where i.token_hash = encode(extensions.digest(coalesce(p_token, ''), 'sha256'), 'hex');
end;
$$;

-- ── 3. Aceptar: una vez, con la fila bloqueada ──────────────────────────────
create function platform.accept_member_invitation(p_token text)
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
  -- Quien invitó tiene que poder seguir agregando personas a ESA empresa hoy.
  if i.created_by is null
     or not platform.ladino_user_has_permission(i.created_by, 'membership.manage', i.company_id) then
    raise exception 'quien invitó ya no gestiona las personas de esa empresa' using errcode = 'LAD89';
  end if;

  select m.id, m.status into v_membership, v_status
    from public.memberships m
   where m.tenant_id = i.tenant_id and m.user_id = v_actor
   for update;
  if v_membership is null then
    insert into public.memberships (tenant_id, user_id, created_by)
    values (i.tenant_id, v_actor, v_actor) returning id into v_membership;
  elsif v_status <> 'active' then
    -- Reactivar es devolver el acceso a la CUENTA entera: solo si quien invitó la gobierna
    -- (membership.manage de nivel tenant). Un gestor acotado no reactiva por la puerta de atrás.
    if not exists (
      select 1
        from public.memberships m
        join public.user_role_assignments u on u.membership_id = m.id and u.company_id is null
        join public.roles r on r.id = u.role_id and not r.requires_scope
        join public.role_permissions rp
          on rp.role_id = r.id and rp.permission_key = 'membership.manage'
       where m.tenant_id = i.tenant_id and m.user_id = i.created_by and m.status = 'active') then
      raise exception 'tu acceso a esa cuenta lo desactivó quien la administra'
        using errcode = 'LAD89';
    end if;
    update public.memberships set status = 'active' where id = v_membership;
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

-- ── 4. «Crear otra empresa»: solo el Titular, y no la misma dos veces ───────
create function platform.bootstrap_another_tenant(p_user uuid, p_name text, p_tax_id text)
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
  -- Las dos asignaciones del fundador, como bootstrap_tenant: Titular y Dueño de la nueva.
  insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id, created_by)
  select v_tenant, v_membership, r.id, null, p_user
    from public.roles r
   where r.tenant_id is null and r.key in ('owner', 'warehouse_ops');
  return v_tenant;
end;
$$;

-- ── 5. El acceso perdido: solo la historia propia ───────────────────────────
-- Negocios donde el actor tiene membresía (activa o no) y ninguna empresa visible.
create function platform.my_lost_access()
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
     and not exists (
           select 1 from public.companies c
            where c.tenant_id = m.tenant_id
              and c.id in (select platform.ladino_user_company_ids(v_actor)))
   order by t.name, t.id;
end;
$$;

-- ¿El actor TUVO acceso a esta empresa (membresía en su tenant) y hoy no lo tiene? Solo lo
-- pregunta el middleware de alcance cuando la empresa no es visible: a un extraño le sigue
-- respondiendo el 404 de siempre.
create function platform.lost_access_to_company(p_company uuid)
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
       and c.id not in (select platform.ladino_user_company_ids(v_actor)));
end;
$$;

-- ── 6. Quién ejecuta qué: solo la API ───────────────────────────────────────
revoke all on function platform.member_invitations_guard() from public;
revoke all on function platform.invitation_preview(text) from public;
revoke all on function platform.accept_member_invitation(text) from public;
revoke all on function platform.bootstrap_another_tenant(uuid, text, text) from public;
revoke all on function platform.my_lost_access() from public;
revoke all on function platform.lost_access_to_company(uuid) from public;
grant execute on function platform.invitation_preview(text) to ladino_api;
grant execute on function platform.accept_member_invitation(text) to ladino_api;
grant execute on function platform.bootstrap_another_tenant(uuid, text, text) to ladino_api;
grant execute on function platform.my_lost_access() to ladino_api;
grant execute on function platform.lost_access_to_company(uuid) to ladino_api;
