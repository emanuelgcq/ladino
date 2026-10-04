-- Módulo: permisos y aislamiento (ola 3 del recorrido 2026-09-24, «permisos que terminan en verde")
-- Spec: RESPUESTA_RECORRIDO_2026-09-24.md §2.8 y §2.15 · ADR-0068 §7 y §8
-- Hallazgos: E-12, N-07, O-03 (y la base de J-03/G-20/H-14/D-11 y de A-14)
-- Reversible: SÍ, con datos vivos (ver REVERSIÓN al final). Homologación: NO.
--
-- Qué cambia, en cinco piezas:
--
--   1. E-12 · seis tablas con `tenant_id` dejaban a `ladino_api` ver y escribir TODAS las
--      empresas (`using (true)`): su aislamiento dependía solo del WHERE del caso de uso. Entran
--      en la misma política que las otras setenta y cuatro:
--      `tenant_id in (select platform.ladino_service_tenant_ids())`. La séptima, `pos_carts`, la
--      alinea la migración 20261003100000 (POS, la misma ola); el invariante de abajo las mira a
--      las siete y a cualquiera que venga.
--
--   2. N-07 · cualquier miembro activo, incluso sin rol, leía por PostgREST todas las membresías,
--      asignaciones y alcances del negocio. Ahora se leen con `membership.read` (el `members.read`
--      del documento del dueño: no se renombra, como `sales.void` en ADR-0068 §2); cada quien ve
--      siempre las suyas. Los helpers son plpgsql `security definer` (SKILL: un envoltorio SQL
--      sobre una función no inlinable replanifica por fila).
--
--   3. O-03 · `memberships`, `user_role_assignments`, `scope_bindings`, `roles` y
--      `role_permissions` tenían `created_by` sin el trigger de procedencia: la API no ponía el
--      autor y 7 de cada 15 asignaciones quedaban sin él. Reciben `set_row_provenance`, el mismo
--      de las otras noventa tablas. Tres de ellas no tenían `version` y la función la escribe: se
--      añade (`bigint not null default 1`, la forma de la familia). Las filas viejas sin autor se
--      quedan así: el autor de ayer no se inventa (está en `audit_events`, N-10).
--
--   4. Separación de funciones (§2.8; terreno de J-03, G-20, H-14 y D-11). Decidido por criterio
--      (ADR-0068 §8):
--        · tres permisos propios, del Dueño por ahora: `sales.refund` (reembolsar),
--          `treasury.overdraft` (confirmar un sobregiro) y `purchase.payment.approve` (aprobar un
--          pago a proveedor por encima del umbral). `supplier.bank_account.approve` ya existía.
--          Cada hallazgo que los haga cumplir decide si el administrativo también los recibe;
--        · `company_settings.four_eyes`: NULL = automático (activo si la empresa tiene más de una
--          persona activa), true/false = lo que decida el dueño;
--        · `company_settings.supplier_payment_approval_threshold` (+ su moneda): USD 1.000 por
--          omisión. Es una regla INTERNA, no una cifra legal;
--        · `platform.four_eyes_active(empresa)` y `platform.approval_allowed(empresa, quien
--          registró, quien aprueba)`: quien registra no aprueba cuando los cuatro ojos están
--          activos; en la bodega de una persona, la aprobación es el permiso más el motivo.
--
--   5. A-14 · `platform.company_logo_purgeable(empresa)`: los objetos de logo que se pueden
--      purgar — más de 30 días, no son el logo vigente y ningún documento se emitió mientras
--      fueron el logo de la empresa. La API purga con eso tras cada logo nuevo (la base no borra
--      del almacenamiento: eso pasa por la API de Storage).
-- =============================================================================

-- ── 1. E-12: la segunda capa de aislamiento en las seis tablas ───────────────
-- igtf_perceptions
drop policy if exists ip_api_select on public.igtf_perceptions;
drop policy if exists ip_api_insert on public.igtf_perceptions;
drop policy if exists ip_api_update on public.igtf_perceptions;
create policy ip_api_select on public.igtf_perceptions for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ip_api_insert on public.igtf_perceptions for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ip_api_update on public.igtf_perceptions for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- igtf_company_instruments
drop policy if exists ici_api_select on public.igtf_company_instruments;
drop policy if exists ici_api_insert on public.igtf_company_instruments;
drop policy if exists ici_api_update on public.igtf_company_instruments;
create policy ici_api_select on public.igtf_company_instruments for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ici_api_insert on public.igtf_company_instruments for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ici_api_update on public.igtf_company_instruments for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- iva_period_results
drop policy if exists ipr_api_select on public.iva_period_results;
drop policy if exists ipr_api_insert on public.iva_period_results;
create policy ipr_api_select on public.iva_period_results for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy ipr_api_insert on public.iva_period_results for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- supported_retention_receipts
drop policy if exists srr_api_select on public.supported_retention_receipts;
drop policy if exists srr_api_insert on public.supported_retention_receipts;
drop policy if exists srr_api_update on public.supported_retention_receipts;
create policy srr_api_select on public.supported_retention_receipts for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy srr_api_insert on public.supported_retention_receipts for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy srr_api_update on public.supported_retention_receipts for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- company_fiscal_deadlines
drop policy if exists cfd_api_select on public.company_fiscal_deadlines;
drop policy if exists cfd_api_insert on public.company_fiscal_deadlines;
drop policy if exists cfd_api_delete on public.company_fiscal_deadlines;
create policy cfd_api_select on public.company_fiscal_deadlines for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cfd_api_insert on public.company_fiscal_deadlines for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cfd_api_delete on public.company_fiscal_deadlines for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- inventory_ledger_cutovers
drop policy if exists ilc_api_select on public.inventory_ledger_cutovers;
create policy ilc_api_select on public.inventory_ledger_cutovers for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- ── 2. N-07: membresías, asignaciones y alcances se leen con membership.read ─
-- Las empresas donde el usuario AUTENTICADO tiene membership.read. plpgsql a propósito (ver
-- cabecera): reescribirla en SQL parece equivalente y replanifica por fila.
create or replace function platform.ladino_membership_reader_company_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select c.id
      from public.companies c
     where c.id in (select platform.ladino_company_ids())
       and platform.ladino_has_permission('membership.read', c.id);
end;
$$;
comment on function platform.ladino_membership_reader_company_ids() is
  'N-07 (2026-10-03): empresas donde auth.uid() tiene membership.read. Solo para las policies '
  'TO authenticated de memberships/user_role_assignments/scope_bindings. plpgsql a propósito.';

-- Los tenants de esas empresas: una membresía es de la cuenta, no de una empresa.
create or replace function platform.ladino_membership_reader_tenant_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select distinct c.tenant_id
      from public.companies c
     where c.id in (select platform.ladino_membership_reader_company_ids());
end;
$$;

-- Las membresías del propio usuario autenticado (para ver SUS asignaciones sin recursión de RLS).
create or replace function platform.ladino_my_membership_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return query
    select m.id from public.memberships m where m.user_id = (select auth.uid());
end;
$$;

revoke all on function platform.ladino_membership_reader_company_ids() from public;
revoke all on function platform.ladino_membership_reader_tenant_ids() from public;
revoke all on function platform.ladino_my_membership_ids() from public;
grant execute on function platform.ladino_membership_reader_company_ids() to authenticated;
grant execute on function platform.ladino_membership_reader_tenant_ids() to authenticated;
grant execute on function platform.ladino_my_membership_ids() to authenticated;

drop policy if exists memberships_select on public.memberships;
create policy memberships_select on public.memberships for select to authenticated
  using (user_id = (select auth.uid())
         or tenant_id in (select platform.ladino_membership_reader_tenant_ids()));

-- Una asignación de empresa la ve quien lee las personas de ESA empresa; una de nivel cuenta
-- (company_id nulo, la del Titular) la ve quien lee las personas de alguna empresa de la cuenta.
drop policy if exists user_role_assignments_select on public.user_role_assignments;
create policy user_role_assignments_select on public.user_role_assignments for select
  to authenticated
  using (membership_id in (select platform.ladino_my_membership_ids())
         or company_id in (select platform.ladino_membership_reader_company_ids())
         or (company_id is null
             and tenant_id in (select platform.ladino_membership_reader_tenant_ids())));

drop policy if exists scope_bindings_select on public.scope_bindings;
create policy scope_bindings_select on public.scope_bindings for select to authenticated
  using (company_id in (select platform.ladino_membership_reader_company_ids())
         or assignment_id in (select u.id from public.user_role_assignments u
                               where u.membership_id in
                                     (select platform.ladino_my_membership_ids())));

-- ── 3. O-03: el autor en la fila de las altas de personas y roles ───────────
alter table public.user_role_assignments add column if not exists version bigint not null default 1;
alter table public.scope_bindings add column if not exists version bigint not null default 1;
alter table public.role_permissions add column if not exists version bigint not null default 1;

create trigger memberships_00_provenance
  before insert or update on public.memberships
  for each row execute function platform.set_row_provenance();
create trigger user_role_assignments_00_provenance
  before insert or update on public.user_role_assignments
  for each row execute function platform.set_row_provenance();
create trigger scope_bindings_00_provenance
  before insert or update on public.scope_bindings
  for each row execute function platform.set_row_provenance();
create trigger roles_00_provenance
  before insert or update on public.roles
  for each row execute function platform.set_row_provenance();
create trigger role_permissions_00_provenance
  before insert or update on public.role_permissions
  for each row execute function platform.set_row_provenance();

-- ── 4. Separación de funciones: permisos, ajustes y la regla ────────────────
insert into public.permissions (key, description, is_scoped) values
  ('sales.refund',
   'Devolver dinero al cliente por una devolución (reembolso); exige motivo y deja rastro', false),
  ('treasury.overdraft',
   'Confirmar un pago o un gasto que deja una cuenta en negativo; exige motivo y deja rastro', false),
  ('purchase.payment.approve',
   'Aprobar un pago a proveedor por encima del umbral de la empresa; exige motivo y deja rastro',
   false)
on conflict (key) do nothing;

-- Del Dueño (el par owner + warehouse_ops cubre el catálogo entero: 040, §2). No se toca ninguna
-- fila de otro permiso ni de otro rol.
insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, v.permiso, null
  from (values ('sales.refund'), ('treasury.overdraft'), ('purchase.payment.approve')) as v(permiso)
  join public.roles r on r.key = 'owner' and r.tenant_id is null
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null and r.key = 'owner'
       where rp.permission_key in ('sales.refund', 'treasury.overdraft',
                                   'purchase.payment.approve', 'supplier.bank_account.approve'))
     <> 4 then
    raise exception 'LAD37: los cuatro permisos de aprobación no quedaron en el Dueño';
  end if;
end $$;

alter table public.company_settings
  add column if not exists four_eyes boolean,
  add column if not exists supplier_payment_approval_threshold numeric(24,8) not null default 1000,
  add column if not exists supplier_payment_approval_currency text not null default 'USD'
    references public.currencies (code);
alter table public.company_settings
  add constraint company_settings_approval_threshold_chk
  check (supplier_payment_approval_threshold >= 0);
comment on column public.company_settings.four_eyes is
  'Cuatro ojos (§2.8): NULL = automático (activo con más de una persona activa en la empresa); '
  'true/false = lo que decidió el dueño. Con cuatro ojos, quien registra no aprueba.';
comment on column public.company_settings.supplier_payment_approval_threshold is
  'Pagos a proveedor por encima de este monto (en supplier_payment_approval_currency) exigen '
  'purchase.payment.approve. Regla INTERNA, no legal: USD 1.000 decidido por criterio (ADR-0068 §8).';

-- ¿Están activos los cuatro ojos en la empresa? Personas activas con al menos un rol en ella
-- (o de nivel cuenta, que mandan en todas).
create or replace function platform.four_eyes_active(p_company_id uuid)
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
  select count(distinct m.user_id) into v_personas
    from public.companies c
    join public.memberships m on m.tenant_id = c.tenant_id and m.status = 'active'
    join public.user_role_assignments u
      on u.membership_id = m.id and (u.company_id = c.id or u.company_id is null)
   where c.id = p_company_id;
  return v_personas > 1;
end;
$$;

-- La regla de la aprobación: con cuatro ojos activos, quien registró no aprueba. El permiso y el
-- motivo los exige el caso de uso; esta función responde solo «¿puede ESTA persona aprobar lo que
-- registró ESA?».
create or replace function platform.approval_allowed(
  p_company_id uuid, p_registered_by uuid, p_approver uuid)
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
  return not platform.four_eyes_active(p_company_id)
         or p_registered_by is distinct from p_approver;
end;
$$;

revoke all on function platform.four_eyes_active(uuid) from public;
revoke all on function platform.approval_allowed(uuid, uuid, uuid) from public;
grant execute on function platform.four_eyes_active(uuid) to ladino_api;
grant execute on function platform.approval_allowed(uuid, uuid, uuid) to ladino_api;

-- ── 5. A-14: qué versiones del logo se pueden purgar ─────────────────────────
-- Una versión es la carpeta `<empresa>/logo/<contenido>/`. Se conserva si es la vigente o si
-- algún documento (factura, NC, ND, recibo, comprobante de retención) se emitió mientras fue el
-- logo de la empresa (las ventanas salen de las actas `company.logo_set`). El resto se purga
-- pasados 30 días. Sin el esquema de Storage (stack local sin el servicio) no devuelve nada.
create or replace function platform.company_logo_purgeable(
  p_company_id uuid, p_grace interval default interval '30 days')
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
             a.occurred_at as desde,
             lead(a.occurred_at) over (order by a.occurred_at, a.id) as hasta
        from public.audit_events a
       where a.company_id = p_company_id and a.event_type = 'company.logo_set'
    ),
    referenciadas as (
      select v.dir from ventanas v
       where v.dir is not null
         and (exists (select 1 from public.documents d
                       where d.company_id = p_company_id and d.issued_at is not null
                         and d.issued_at >= v.desde
                         and (v.hasta is null or d.issued_at < v.hasta))
              or exists (select 1 from public.retention_receipts r
                          where r.company_id = p_company_id and r.issued_at is not null
                            and r.issued_at >= v.desde
                            and (v.hasta is null or r.issued_at < v.hasta)))
    ),
    vigente as (
      select regexp_replace(c.logo_path, '/[^/]+$', '') as dir
        from public.companies c where c.id = p_company_id
    )
    select o.name::text
      from storage.objects o
     where o.bucket_id = 'company-logos'
       and o.name like p_company_id::text || '/logo/%'
       and greatest(o.created_at, coalesce(o.updated_at, o.created_at)) < now() - p_grace
       and regexp_replace(o.name, '/[^/]+$', '') is distinct from (select dir from vigente)
       and not exists (select 1 from referenciadas r
                        where r.dir = regexp_replace(o.name, '/[^/]+$', ''));
end;
$$;
revoke all on function platform.company_logo_purgeable(uuid, interval) from public;
grant execute on function platform.company_logo_purgeable(uuid, interval) to ladino_api;

-- =============================================================================
-- REVERSIÓN, con datos vivos (otra migración, nunca editando esta):
--   · 1: recrear las policies con `true` reabre E-12; no hay datos que mover. No se recomienda.
--   · 2: recrear las tres policies `select` con `platform.ladino_tenant_ids()` y borrar los tres
--     helpers. Sin datos.
--   · 3: `drop trigger` de los cinco `_00_provenance`; las columnas `version` pueden quedarse
--     (default 1) o borrarse sin pérdida. Los `created_by` que escribieron los triggers son
--     ciertos y se quedan: no hay forma honesta de «des-escribir» un autor.
--   · 4: borrar las filas de `role_permissions` y `permissions` de las tres claves (hoy ningún
--     caso de uso las exige: no hay datos que dependan de ellas), las dos funciones y las tres
--     columnas de `company_settings` (sus valores por omisión no los usa nadie todavía; si un
--     dueño ya cambió `four_eyes` o el umbral, ese ajuste se pierde y hay que anotarlo antes).
--   · 5: borrar la función; la API vuelve a no purgar (los logos viejos se quedan, como antes).
-- =============================================================================
