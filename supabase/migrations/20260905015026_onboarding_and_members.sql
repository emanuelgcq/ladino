-- ═══════════════════════════════════════════════════════════════════════════
-- Migración 41 — El primer día real: onboarding y gestión de miembros
--                (ADR-0049)
--
-- La auditoría de superficie destapó que el arranque de una cuenta nueva no
-- estaba cableado: la demo sembraba tenant, membresía, rol, almacén y
-- bindings POR SQL, y un usuario real que se registrara quedaba autenticado
-- y sin poder hacer nada. Tres piezas:
--
--   1. EL DUEÑO VUELVE A PLANO. Las operaciones de NIVEL TENANT (crear
--      empresa, gestionar miembros) exigen un rol `not requires_scope` — y el
--      owner de la migración 40 quedó acotado por llevar los 8 verbos de
--      almacén. Se le retiran esos 8 (la coherencia LAD25 lo exige) y nace el
--      sexto rol de sistema `warehouse_ops` («Operación de almacén»),
--      acotado, con EXACTAMENTE esos 8. El onboarding asigna los dos al
--      fundador; el par owner+warehouse_ops cubre el catálogo entero (el
--      pgTAP 040 lo exige como CERO fuera del par).
--
--   2. `platform.bootstrap_tenant()` — security definer, porque ladino_api
--      NO tiene INSERT sobre tenants a propósito: conceder un tenant es
--      privilegiado. Crea tenant + membresía + las DOS asignaciones del
--      fundador, con el guard de un-negocio-por-usuario-autoservicio.
--
--   3. `platform.user_id_by_email()` / `platform.user_email()` — lectura
--      puntual de auth.users (ladino_api no puede leerla): agregar a un
--      empleado es «por su correo», y la lista de miembros necesita enseñar
--      a quién. Solo el correo y el id: nada más de auth sale de aquí.
--
-- Reversibilidad: funciones y filas de catálogo. HOMOLOGATION_IMPACT: NO.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1. El dueño plano y el sexto rol ────────────────────────────────────────
do $$
declare
  v_owner uuid;
  v_ops uuid;
  v_n int;
begin
  select id into v_owner from public.roles where key = 'owner' and tenant_id is null;
  if v_owner is null then raise exception 'LAD52: falta el rol owner de la migración 40'; end if;

  -- Primero se retiran los permisos acotados, DESPUÉS se aplana el rol: en el
  -- orden contrario la coherencia LAD25 rechaza el UPDATE, y con razón.
  delete from public.role_permissions rp
   using public.permissions p
   where rp.role_id = v_owner and p.key = rp.permission_key and p.is_scoped;
  update public.roles set requires_scope = false where id = v_owner;

  insert into public.roles (tenant_id, key, name, requires_scope) values
    (null, 'warehouse_ops', 'Operación de almacén', true) returning id into v_ops;
  insert into public.role_permissions (role_id, permission_key, tenant_id)
  select v_ops, p.key, null from public.permissions p where p.is_scoped;

  -- El PAR cubre el catálogo entero: cero permisos fuera de owner ∪ warehouse_ops.
  select count(*) into v_n from public.permissions p
   where not exists (select 1 from public.role_permissions rp
                      where rp.role_id in (v_owner, v_ops) and rp.permission_key = p.key);
  if v_n <> 0 then
    raise exception 'LAD52: el par owner+warehouse_ops deja % permisos fuera', v_n;
  end if;
end $$;

-- ── 2. El bootstrap del tenant ──────────────────────────────────────────────
create function platform.bootstrap_tenant(p_user uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_membership uuid;
begin
  if p_user is null or length(btrim(coalesce(p_name, ''))) < 2 then
    raise exception 'el negocio necesita un nombre' using errcode = 'LAD80';
  end if;
  -- Un usuario autoservicio funda UN negocio. Pertenecer ya a un tenant
  -- (fundado o invitado) cierra esta puerta: la segunda empresa se crea
  -- DENTRO del tenant, y unirse a otro negocio es una invitación, no un
  -- bootstrap.
  if exists (select 1 from public.memberships m
              where m.user_id = p_user and m.status = 'active') then
    raise exception 'este usuario ya pertenece a un negocio' using errcode = 'LAD81';
  end if;

  insert into public.tenants (name) values (btrim(p_name)) returning id into v_tenant;
  insert into public.memberships (tenant_id, user_id, created_by)
  values (v_tenant, p_user, p_user) returning id into v_membership;
  -- Las DOS asignaciones del fundador, a nivel tenant (company null): el
  -- owner plano manda en todo; warehouse_ops concede los verbos de almacén
  -- cuando existan sus bindings — que crea el caso de uso al crear almacenes.
  insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id, created_by)
  select v_tenant, v_membership, r.id, null, p_user
    from public.roles r
   where r.tenant_id is null and r.key in ('owner', 'warehouse_ops');

  return v_tenant;
end;
$$;
comment on function platform.bootstrap_tenant(uuid, text) is
  'ADR-0049: el ÚNICO camino para nacer un tenant desde la API (ladino_api no '
  'tiene INSERT sobre tenants a propósito). Crea tenant + membresía + las dos '
  'asignaciones del fundador. LAD81 si el usuario ya pertenece a un negocio.';
revoke execute on function platform.bootstrap_tenant(uuid, text) from public;
grant execute on function platform.bootstrap_tenant(uuid, text) to ladino_api;

-- ── 3. El correo, puntual y nada más ────────────────────────────────────────
create function platform.user_id_by_email(p_email text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select u.id from auth.users u
   where lower(u.email) = lower(btrim(p_email))
   limit 1
$$;
comment on function platform.user_id_by_email(text) is
  'ADR-0049: agregar a un empleado es «por su correo» — la persona se registra '
  'sola y el dueño la suma. Devuelve NULL si no existe; no filtra nada más de auth.';
revoke execute on function platform.user_id_by_email(text) from public;
grant execute on function platform.user_id_by_email(text) to ladino_api;

create function platform.user_email(p_user uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select u.email from auth.users u where u.id = p_user
$$;
comment on function platform.user_email(uuid) is
  'ADR-0049: el correo de un miembro, para la lista de usuarios. Solo el correo.';
revoke execute on function platform.user_email(uuid) from public;
grant execute on function platform.user_email(uuid) to ladino_api;

-- ── Autochequeo ─────────────────────────────────────────────────────────────
do $$
begin
  if (select requires_scope from public.roles where key = 'owner' and tenant_id is null) then
    raise exception 'LAD52: owner debía quedar plano';
  end if;
  if (select count(*) from public.roles where tenant_id is null) <> 6 then
    raise exception 'LAD52: debían existir seis roles de sistema';
  end if;
end $$;
