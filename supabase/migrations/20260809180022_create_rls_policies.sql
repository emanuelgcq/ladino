-- =============================================================================
-- Ladino — 4/4 · Privilegios de tabla y policies RLS
--
-- Módulo:         aislamiento multi-tenant (S0.3)
-- Spec:           ADR-0025 §2, §5, §6 y §9; MULTITENANCY_AND_RBAC.md
-- Reversibilidad: SÍ. drop policy ... on ...; revoke ... ;
--                 El esquema queda intacto; solo se cierra el acceso.
-- HOMOLOGATION_IMPACT: NO
--
-- Cuarta y última. Depende de 1/4, 2/4 y 3/4.
--
-- Hasta aquí las once tablas tenían RLS habilitada Y FORZADA pero SIN policies:
-- nadie sin BYPASSRLS leía ni escribía nada. Ese era el estado seguro
-- intermedio. Esta migración abre el acceso, y lo abre por partes.
--
-- DOS CAPAS, y la de abajo actúa primero:
--   1. privilegios de tabla (GRANT)  -> sin ellos, 42501 antes de llegar a la RLS
--   2. policies                       -> filtran filas
-- Las dos son necesarias. Conviene no confundirlas al depurar: un "no veo nada"
-- puede ser cualquiera de las dos, y el diagnóstico es distinto.
--
-- ESCRITURA RBAC: NINGUNA para authenticated (ADR-0025 §9). Las funciones de
-- alcance resuelven permisos POR COMPANY, y crear una company o gestionar
-- memberships es alcance de tenant, sin company_id contra el que preguntar.
-- Escribir ese predicado en línea recurriría sobre memberships. Todo el bloque
-- RBAC pasa por la API con service_role. Que nadie pueda concederse permisos
-- por PostgREST es una propiedad deseada, no un efecto lateral.
-- =============================================================================

-- 9. Privilegios de tabla — la capa que hay DEBAJO de la RLS
--
-- Supabase concede ALL sobre las tablas nuevas de `public` a anon,
-- authenticated y service_role vía ALTER DEFAULT PRIVILEGES. Se revoca y se
-- concede a mano: una policy solo se evalúa si el rol tiene además el
-- privilegio, y dejar el privilegio puesto "porque la policy ya deniega" es
-- confiar en una sola capa.
--
-- `anon` no recibe NADA en ninguna de las once tablas.
-- =============================================================================

revoke all on public.tenants, public.companies, public.branches,
              public.warehouses, public.cash_registers, public.memberships,
              public.roles, public.permissions, public.role_permissions,
              public.user_role_assignments, public.scope_bindings
  from anon, authenticated;

-- Solo lectura para `authenticated`. Las escrituras de estas tablas o son
-- operación de plataforma (tenants) o son concesión de privilegios (todo el
-- bloque RBAC), y ninguna de las dos se hace por PostgREST: pasan por el caso
-- de uso transaccional de la API, que valida permisos, audita y emite evento
-- (CLAUDE.md §7). Ver el comentario del bloque 10.
grant select on public.tenants               to authenticated;
grant select on public.memberships           to authenticated;
grant select on public.roles                 to authenticated;
grant select on public.permissions           to authenticated;
grant select on public.role_permissions      to authenticated;
grant select on public.user_role_assignments to authenticated;
grant select on public.scope_bindings        to authenticated;

-- companies: se lee y se actualiza; el alta y la baja no son operaciones de
-- usuario final.
grant select, update on public.companies to authenticated;

-- Estructura operativa: CRUD completo, gobernado por permisos en las policies.
grant select, insert, update, delete on public.branches       to authenticated;
grant select, insert, update, delete on public.warehouses     to authenticated;
grant select, insert, update, delete on public.cash_registers to authenticated;

grant all on public.tenants, public.companies, public.branches,
             public.warehouses, public.cash_registers, public.memberships,
             public.roles, public.permissions, public.role_permissions,
             public.user_role_assignments, public.scope_bindings
  to service_role;


-- =============================================================================
-- 10. Policies — SEPARADAS POR OPERACIÓN, nunca FOR ALL, siempre TO authenticated
--
-- Las operaciones deliberadamente denegadas llevan policy explícita con
-- `false` en vez de no llevar policy. Funcionalmente es lo mismo; la diferencia
-- es que una denegación escrita es una decisión y una policy ausente es
-- indistinguible de un olvido — que es el mismo argumento con el que ADR-0025
-- §3 exige declarar la excepción de `permissions`.
--
-- LÍMITE CONOCIDO: las cuatro funciones de ADR-0025 §5 resuelven permisos POR
-- COMPANY. No existe una función de permiso a nivel de TENANT, y escribir ese
-- predicado en línea dentro de una policy de `memberships` recurriría sobre la
-- propia tabla. Por eso las escrituras cuyo permiso es tenant-level (alta de
-- tenant, alta de company, todo el bloque RBAC) quedan denegadas a
-- `authenticated` y pasan por la API con service_role. Habilitarlas por
-- PostgREST exigiría una quinta función SECURITY DEFINER, y eso es un ADR
-- nuevo, no una decisión de esta migración.
-- =============================================================================

-- ----------------------------------------------------------------- tenants ---
create policy tenants_select on public.tenants
  for select to authenticated
  using (id in (select platform.ladino_tenant_ids()));

create policy tenants_insert on public.tenants
  for insert to authenticated
  with check (false);

create policy tenants_update on public.tenants
  for update to authenticated
  using (false);

create policy tenants_delete on public.tenants
  for delete to authenticated
  using (false);

comment on policy tenants_insert on public.tenants is
  'Denegación deliberada: el alta de un tenant es una operación de plataforma '
  '(alta de cliente), no de usuario final.';
comment on policy tenants_update on public.tenants is
  'Denegación deliberada: no hay función de permiso a nivel de tenant '
  '(ADR-0025 §5 fija cuatro, todas por company). Pasa por la API.';
comment on policy tenants_delete on public.tenants is
  'Denegación deliberada: un tenant no se borra, se suspende.';

-- --------------------------------------------------------------- companies ---
create policy companies_select on public.companies
  for select to authenticated
  using (id in (select platform.ladino_company_ids()));

create policy companies_insert on public.companies
  for insert to authenticated
  with check (false);

create policy companies_update on public.companies
  for update to authenticated
  using (
    id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('company.manage', id)
  )
  with check (
    id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('company.manage', id)
    and tenant_id in (select platform.ladino_tenant_ids())
  );

create policy companies_delete on public.companies
  for delete to authenticated
  using (false);

comment on policy companies_insert on public.companies is
  'Denegación deliberada: crear una company exige un permiso a nivel de tenant '
  'y la company todavía no existe, así que no hay company_id contra el que '
  'preguntar. Es el caso de uso "crear empresa" de S0.5.';
comment on policy companies_delete on public.companies is
  'Denegación deliberada: sin soft-delete y sin hard-delete en lo fiscal. '
  'Una empresa se suspende (status), no se borra.';

-- ---------------------------------------------------------------- branches ---
create policy branches_select on public.branches
  for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));

create policy branches_insert on public.branches
  for insert to authenticated
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('branch.manage', company_id)
  );

create policy branches_update on public.branches
  for update to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('branch.manage', company_id)
  )
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('branch.manage', company_id)
  );

create policy branches_delete on public.branches
  for delete to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('branch.manage', company_id)
  );

-- -------------------------------------------------------------- warehouses ---
create policy warehouses_select on public.warehouses
  for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));

create policy warehouses_insert on public.warehouses
  for insert to authenticated
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('warehouse.manage', company_id)
  );

create policy warehouses_update on public.warehouses
  for update to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('warehouse.manage', company_id)
  )
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('warehouse.manage', company_id)
  );

create policy warehouses_delete on public.warehouses
  for delete to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('warehouse.manage', company_id)
  );

-- ---------------------------------------------------------- cash_registers ---
create policy cash_registers_select on public.cash_registers
  for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));

create policy cash_registers_insert on public.cash_registers
  for insert to authenticated
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('cash_register.manage', company_id)
  );

create policy cash_registers_update on public.cash_registers
  for update to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('cash_register.manage', company_id)
  )
  with check (
    company_id in (select platform.ladino_company_ids())
    and tenant_id in (select platform.ladino_tenant_ids())
    and platform.ladino_has_permission('cash_register.manage', company_id)
  );

create policy cash_registers_delete on public.cash_registers
  for delete to authenticated
  using (
    company_id in (select platform.ladino_company_ids())
    and platform.ladino_has_permission('cash_register.manage', company_id)
  );

-- ------------------------------------------------------------- memberships ---
create policy memberships_select on public.memberships
  for select to authenticated
  using (
    tenant_id in (select platform.ladino_tenant_ids())
    or user_id = (select auth.uid())
  );

create policy memberships_insert on public.memberships
  for insert to authenticated
  with check (false);

create policy memberships_update on public.memberships
  for update to authenticated
  using (false);

create policy memberships_delete on public.memberships
  for delete to authenticated
  using (false);

comment on policy memberships_select on public.memberships is
  'El propio usuario ve siempre su membership, incluso inactivo: si no, un '
  'membership desactivado sería invisible y el usuario no podría ni saber por '
  'qué perdió el acceso.';
comment on policy memberships_insert on public.memberships is
  'Denegación deliberada: conceder acceso a un tenant es una operación '
  'privilegiada y auditada. Nunca por PostgREST.';

-- ------------------------------------------------------------------- roles ---
create policy roles_select on public.roles
  for select to authenticated
  using (
    tenant_id is null
    or tenant_id in (select platform.ladino_tenant_ids())
  );

create policy roles_insert on public.roles
  for insert to authenticated
  with check (false);

create policy roles_update on public.roles
  for update to authenticated
  using (false);

create policy roles_delete on public.roles
  for delete to authenticated
  using (false);

comment on policy roles_select on public.roles is
  'Los roles de sistema (tenant_id NULL) son vocabulario visible por todos; los '
  'roles propios, solo dentro de su tenant.';

-- ------------------------------------------------------------- permissions ---
-- Única policy, y es la que manda ADR-0025 §3: SELECT para `authenticated`.
-- Sin INSERT, UPDATE ni DELETE — el catálogo se puebla por migración. La
-- ausencia de esas tres policies es intencional y está respaldada por el
-- privilegio: `authenticated` solo tiene SELECT sobre esta tabla (bloque 9).
create policy permissions_select on public.permissions
  for select to authenticated
  using (true);

comment on policy permissions_select on public.permissions is
  'Catálogo global legible por cualquier usuario autenticado: es vocabulario, '
  'no dato de nadie. No existen policies de escritura a propósito (ADR-0025 §3).';

-- -------------------------------------------------------- role_permissions ---
create policy role_permissions_select on public.role_permissions
  for select to authenticated
  using (
    tenant_id is null
    or tenant_id in (select platform.ladino_tenant_ids())
  );

create policy role_permissions_insert on public.role_permissions
  for insert to authenticated
  with check (false);

create policy role_permissions_update on public.role_permissions
  for update to authenticated
  using (false);

create policy role_permissions_delete on public.role_permissions
  for delete to authenticated
  using (false);

comment on policy role_permissions_insert on public.role_permissions is
  'Denegación deliberada: si un usuario pudiera escribir aquí por PostgREST, '
  'podría concederse a sí mismo cualquier permiso del catálogo.';

-- --------------------------------------------------- user_role_assignments ---
create policy user_role_assignments_select on public.user_role_assignments
  for select to authenticated
  using (tenant_id in (select platform.ladino_tenant_ids()));

create policy user_role_assignments_insert on public.user_role_assignments
  for insert to authenticated
  with check (false);

create policy user_role_assignments_update on public.user_role_assignments
  for update to authenticated
  using (false);

create policy user_role_assignments_delete on public.user_role_assignments
  for delete to authenticated
  using (false);

-- ---------------------------------------------------------- scope_bindings ---
create policy scope_bindings_select on public.scope_bindings
  for select to authenticated
  using (tenant_id in (select platform.ladino_tenant_ids()));

create policy scope_bindings_insert on public.scope_bindings
  for insert to authenticated
  with check (false);

create policy scope_bindings_update on public.scope_bindings
  for update to authenticated
  using (false);

create policy scope_bindings_delete on public.scope_bindings
  for delete to authenticated
  using (false);

comment on policy scope_bindings_insert on public.scope_bindings is
  'Denegación deliberada: asignar el alcance de un rol es exactamente lo que '
  'decide qué caja opera un cajero. Pasa por la API, con auditoría.';


-- =============================================================================
