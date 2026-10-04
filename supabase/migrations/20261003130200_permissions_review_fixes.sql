-- Módulo: permisos y aislamiento (ola 3, arreglos de la revisión)   Spec: ADR-0068 §7–§9
-- Reversible: SÍ, con datos vivos (ver REVERSIÓN). Homologación: NO.
--
-- Arregla tres piezas de 20261003130000/130100 que la revisión encontró, con la misma auditoría
-- que la migración que corrige (CLAUDE.md §3):
--
--   H2/H3 · `company_logo_purgeable`. El logo es PRESENTACIÓN (no lo exige el art. 13 de la PA
--     00071): el PDF usa siempre el vigente y ningún documento congela una versión, así que la rama
--     «referenciada por un documento» protegía algo que no existe y se quita (decidido por
--     criterio; alternativa: congelar el logo al emitir). La gracia de 30 días cuenta desde que la
--     versión QUEDA huérfana —el fin de su última ventana en las actas `company.logo_set`—, no
--     desde que nació el objeto: un logo viejo reemplazado hoy no se borra hoy. Una versión que
--     nunca quedó puesta es huérfana desde que nació. Se añade `p_at` (el reloj, por omisión
--     now()): el acta es append-only y «dentro de 31 días» se prueba moviendo el reloj, no el acta.
--
--   H4 · Cuatro ojos POR PERMISO. `four_eyes_active(empresa, permiso)` cuenta las personas
--     activas que TIENEN ese permiso en la empresa: solo con más de una hay alguien más que pueda
--     aprobar. Una bodega con dueño y cajero no tiene cuatro ojos para aprobar un pago a proveedor
--     (solo el dueño puede), y sí para vender. Decidido por criterio; alternativa: dar los permisos
--     de aprobación también al administrativo. `approval_allowed` recibe el permiso.
--
--   H5 · `memberships_select`: quien lee las personas de UNA empresa ve las membresías con
--     asignación en esa empresa (y las del nivel cuenta, que operan en todas), no las del tenant
--     entero; todas solo con membership.read de nivel cuenta (el Titular).
--
-- Ninguna migración posterior toca estas funciones ni la policy.
-- =============================================================================

-- ── H2/H3: la purga del logo ─────────────────────────────────────────────────
drop function if exists platform.company_logo_purgeable(uuid, interval);

create or replace function platform.company_logo_purgeable(
  p_company_id uuid,
  p_grace interval default interval '30 days',
  p_at timestamptz default now())
returns table (object_name text)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if to_regclass('storage.objects') is null then
    return;
  end if;
  -- Solo la empresa de un tenant del actor de servicio: la función ve storage.objects entero.
  if not exists (select 1 from public.companies c
                  where c.id = p_company_id
                    and c.tenant_id in (select platform.ladino_service_tenant_ids())) then
    return;
  end if;
  return query
    with ventanas as (
      select regexp_replace(a.payload ->> 'to', '/[^/]+$', '') as dir,
             lead(a.occurred_at) over (order by a.occurred_at, a.id) as hasta
        from public.audit_events a
       where a.company_id = p_company_id and a.event_type = 'company.logo_set'
    ),
    por_carpeta as (
      select v.dir, bool_or(v.hasta is null) as abierta, max(v.hasta) as huerfana_desde
        from ventanas v
       where v.dir is not null
       group by v.dir
    ),
    vigente as (
      select regexp_replace(c.logo_path, '/[^/]+$', '') as dir
        from public.companies c where c.id = p_company_id
    )
    select o.name::text
      from storage.objects o
      left join por_carpeta p on p.dir = regexp_replace(o.name, '/[^/]+$', '')
     where o.bucket_id = 'company-logos'
       and o.name like p_company_id::text || '/logo/%'
       and regexp_replace(o.name, '/[^/]+$', '') is distinct from (select dir from vigente)
       and not coalesce(p.abierta, false)
       -- Huérfana desde el fin de su última ventana; si nunca estuvo puesta, desde que nació.
       -- `created_at`, no `updated_at`: Storage reescribe updated_at en todo UPDATE (130100).
       and greatest(coalesce(p.huerfana_desde, o.created_at), o.created_at) < p_at - p_grace;
end;
$$;
revoke all on function platform.company_logo_purgeable(uuid, interval, timestamptz) from public;
grant execute on function platform.company_logo_purgeable(uuid, interval, timestamptz)
  to ladino_api;

-- ── H4: cuatro ojos por permiso ──────────────────────────────────────────────
drop function if exists platform.approval_allowed(uuid, uuid, uuid);
drop function if exists platform.four_eyes_active(uuid);

create or replace function platform.four_eyes_active(p_company_id uuid, p_permission text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_ajuste boolean;
  v_personas int;
begin
  select s.four_eyes into v_ajuste from public.company_settings s where s.company_id = p_company_id;
  if v_ajuste is not null then
    return v_ajuste;
  end if;
  -- Personas activas que pueden aprobar ESO en la empresa: la misma resolución que el servidor.
  select count(*) into v_personas
    from public.companies c
    join public.memberships m on m.tenant_id = c.tenant_id and m.status = 'active'
   where c.id = p_company_id
     and platform.ladino_user_has_permission(m.user_id, p_permission, c.id);
  return v_personas > 1;
end;
$$;

create or replace function platform.approval_allowed(
  p_company_id uuid, p_permission text, p_registered_by uuid, p_approver uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_approver is null then
    return false;
  end if;
  return not platform.four_eyes_active(p_company_id, p_permission)
         or p_registered_by is distinct from p_approver;
end;
$$;

revoke all on function platform.four_eyes_active(uuid, text) from public;
revoke all on function platform.approval_allowed(uuid, text, uuid, uuid) from public;
grant execute on function platform.four_eyes_active(uuid, text) to ladino_api;
grant execute on function platform.approval_allowed(uuid, text, uuid, uuid) to ladino_api;

comment on column public.company_settings.four_eyes is
  'Cuatro ojos (§2.8): NULL = automático, POR PERMISO (activo si más de una persona activa tiene '
  'el permiso de aprobar eso en la empresa); true/false = lo que decidió el dueño.';

-- ── H5: memberships_select acotada a las empresas del lector ────────────────
-- plpgsql a propósito (un envoltorio SQL sobre funciones no inlinables replanifica por fila).
create or replace function platform.ladino_visible_membership_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    -- Con membership.read de NIVEL CUENTA (asignación sin empresa): todas las del tenant.
    select m.id
      from public.memberships m
     where m.tenant_id in (
             select me.tenant_id
               from public.memberships me
               join public.user_role_assignments u
                 on u.membership_id = me.id and u.company_id is null
               join public.roles r on r.id = u.role_id and not r.requires_scope
               join public.role_permissions rp
                 on rp.role_id = r.id and rp.permission_key = 'membership.read'
              where me.user_id = (select auth.uid()) and me.status = 'active')
    union
    -- Con membership.read en una empresa: las que tienen asignación en ESA empresa…
    select u.membership_id
      from public.user_role_assignments u
     where u.company_id in (select platform.ladino_membership_reader_company_ids())
    union
    -- …y las de nivel cuenta de ese tenant, que operan también en ella.
    select u.membership_id
      from public.user_role_assignments u
     where u.company_id is null
       and u.tenant_id in (select platform.ladino_membership_reader_tenant_ids());
end;
$$;
revoke all on function platform.ladino_visible_membership_ids() from public;
grant execute on function platform.ladino_visible_membership_ids() to authenticated;

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid())
         or id in (select platform.ladino_visible_membership_ids()));

-- =============================================================================
-- REVERSIÓN, con datos vivos (otra migración, nunca editando esta): recrear las firmas de
-- 20261003130000/130100 (purga de dos argumentos con la rama de documentos, cuatro ojos sin
-- permiso) y la policy con `platform.ladino_membership_reader_tenant_ids()`. Ninguna escribe
-- datos; ningún caso de uso llama todavía a las de cuatro ojos.
-- =============================================================================
