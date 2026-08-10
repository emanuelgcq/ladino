-- =============================================================================
-- Ladino — 3/4 · Modelo RBAC, alcance por recurso y funciones de resolución
--
-- Módulo:         identidad y permisos (S0.3)
-- Spec:           ADR-0025 §3, §4, §5 y §9; ADR-0014
-- Reversibilidad: SÍ mientras no haya datos:
--                   drop table public.scope_bindings, public.user_role_assignments,
--                              public.role_permissions, public.permissions,
--                              public.roles, public.memberships;
--                   drop function platform.ladino_has_scope(text,text,uuid), ...
-- HOMOLOGATION_IMPACT: NO
--
-- Tercera de cuatro. Depende de 1/4 (platform.uuidv7()) y 2/4 (la jerarquía,
-- a la que apuntan los scope_bindings).
--
-- LAS CUATRO FUNCIONES VAN EN `platform`, NO EN `auth`.
-- La versión monolítica de esta migración las creaba en `auth` siguiendo a
-- ADR-0014 y SUPABASE_DESIGN.md, y Postgres la tumbó en la sentencia 63:
--   ERROR: permission denied for schema auth (SQLSTATE 42501)
-- El esquema `auth` lo posee supabase_auth_admin (GoTrue); las migraciones
-- corren como `postgres`, que no tiene CREATE sobre él. Y aunque se forzara,
-- Supabase reescribe ese esquema en sus actualizaciones. Los tres documentos
-- coincidían entre sí y ninguno se había contrastado contra la plataforma.
-- Corregido en ADR-0025 §5.
--
-- RLS queda habilitada Y FORZADA sin policies: las policies de las once tablas
-- llegan en 4/4. Estado intermedio seguro.
-- =============================================================================

-- 3.6 memberships — el vínculo es usuario ↔ TENANT, no usuario ↔ company
--     (ADR-0025 §2). El alcance por company lo da user_role_assignments.
-- -----------------------------------------------------------------------------
create table public.memberships (
  id          uuid primary key default platform.uuidv7(),
  tenant_id   uuid        not null references public.tenants (id) on delete restrict,
  user_id     uuid        not null references auth.users (id) on delete restrict,
  status      text        not null default 'active',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint memberships_status_chk check (status in ('active', 'inactive')),

  constraint memberships_tenant_user_key unique (tenant_id, user_id),
  constraint memberships_tenant_id_id_key unique (tenant_id, id)
);

comment on table public.memberships is
  'Pertenencia de un usuario a un tenant. Es la tabla que leen las funciones '
  'platform.ladino_* y por tanto el punto en el que se revoca el acceso: quitar el '
  'membership corta el acceso en la consulta siguiente, sin esperar a que '
  'expire ningún token (ADR-0014).';
comment on column public.memberships.status is
  'Solo los memberships `active` conceden alcance. Un membership `inactive` '
  'conserva la trazabilidad histórica sin conceder nada.';

-- -----------------------------------------------------------------------------
-- 3.7 roles — tenant_id NULLABLE: null = rol de sistema (ADR-0025 §3)
-- -----------------------------------------------------------------------------
create table public.roles (
  id              uuid primary key default platform.uuidv7(),
  tenant_id       uuid references public.tenants (id) on delete restrict,
  key             text        not null,
  name            text        not null,
  -- SIN DEFAULT, a propósito: ADR-0025 §4 exige que un rol nuevo obligue a
  -- DECIDIR requires_scope en vez de heredar un default invisible.
  requires_scope  boolean     not null,
  version         bigint      not null default 1,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete restrict,

  constraint roles_key_chk  check (key ~ '^[a-z][a-z0-9_]*$'),
  constraint roles_name_chk check (length(btrim(name)) > 0)
);

comment on table public.roles is
  'tenant_id NULL = rol de sistema (tenant_owner, company_admin, cashier); con '
  'valor = rol propio de ese tenant. Permite el catálogo fijo de hoy sin cerrar '
  'la puerta a roles personalizados (ADR-0025 §3). El ADR escribe el rol de '
  'caja como "cajero"; aquí las claves son inglesas por CLAUDE.md '
  '(identificadores en inglés, comentarios en español).';
comment on column public.roles.requires_scope is
  'true  -> sin scope_bindings el rol NO OPERA NADA; con bindings opera solo '
  'lo enlazado (cajero, almacenista). '
  'false -> opera toda la company (company_admin, contador). '
  'Es una columna y no una convención para que sea auditable con una consulta '
  'y para que un rol nuevo obligue a decidir. El fallo por omisión RESTA '
  'permisos, nunca los suma (ADR-0025 §4).';

-- Unicidad de la clave del rol. Dos índices parciales en lugar de un UNIQUE
-- sobre (tenant_id, key): con tenant_id NULL los NULL son distintos entre sí y
-- el UNIQUE no deduplicaría los roles de sistema.
create unique index roles_system_key_uidx
  on public.roles (key) where tenant_id is null;
create unique index roles_tenant_key_uidx
  on public.roles (tenant_id, key) where tenant_id is not null;

-- -----------------------------------------------------------------------------
-- 3.8 permissions — CATÁLOGO GLOBAL. EXCEPCIÓN DECLARADA a la regla de que
--     toda tabla lleve tenant_id (ADR-0025 §3).
-- -----------------------------------------------------------------------------
create table public.permissions (
  key         text primary key,
  description text        not null,
  -- SIN DEFAULT: clasificar el permiso es una decisión de quien lo añade.
  is_scoped   boolean     not null,
  created_at  timestamptz not null default now(),

  constraint permissions_key_chk
    check (key ~ '^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$'),
  constraint permissions_description_chk check (length(btrim(description)) > 0)
);

comment on table public.permissions is
  'EXCEPCIÓN DECLARADA: esta tabla NO lleva tenant_id, y romper esa regla es '
  'deliberado, no un olvido (ADR-0025 §3). `permissions` es el catálogo de '
  'acciones que el SISTEMA sabe hacer: no es dato de nadie, es vocabulario. '
  'Ponerle tenant_id obligaría a replicar el catálogo en cada tenant y abriría '
  'la puerta a vocabularios divergentes, que es justo lo que haría imposible '
  'razonar sobre segregación de funciones a nivel de producto. '
  'Una excepción sin declarar es indistinguible de un olvido, y el '
  'rls-security-auditor no debe tener que adivinar cuál de las dos cosas es. '
  'RLS igualmente ENABLE + FORCE, con una única policy de SELECT para '
  '`authenticated`: el catálogo se puebla por migración. '
  'Segunda excepción menor: la PK es la propia `key` (text) y no un uuid, '
  'porque el vocabulario es estable y las tablas que lo referencian guardan '
  'permission_key legible (ADR-0025 §7 nombra el índice role_permissions '
  '(role_id, permission_key)).';
comment on column public.permissions.is_scoped is
  'true = el permiso opera sobre un recurso acotado (cash_register.operate, '
  'warehouse.move). false = actúa a nivel de company (company.read, '
  'report.export). ES EL PUNTO ÚNICO DE FALLO del modelo (ADR-0025, '
  'Consecuencias): un cash_register.operate registrado con is_scoped=false '
  'desactiva la comprobación entera para ese permiso y nada lo detecta. '
  'Se toca por migración, se revisa en PR y es una lista corta.';

-- -----------------------------------------------------------------------------
-- 3.9 role_permissions — qué permisos concede cada rol.
--     tenant_id "sigue a roles" (ADR-0025 §2): nullable, denormalizado, y
--     mantenido coherente por trigger porque una FK compuesta contra una
--     columna nullable no puede forzarlo (MATCH SIMPLE se salta la
--     comprobación cuando hay NULL).
-- -----------------------------------------------------------------------------
create table public.role_permissions (
  role_id         uuid not null references public.roles (id) on delete restrict,
  permission_key  text not null references public.permissions (key) on delete restrict,
  tenant_id       uuid references public.tenants (id) on delete restrict,
  created_at      timestamptz not null default now(),
  created_by      uuid references auth.users (id) on delete restrict,

  primary key (role_id, permission_key)
);

comment on table public.role_permissions is
  'Concesión de permisos a roles. tenant_id sigue a roles.tenant_id (NULL para '
  'roles de sistema) y se denormaliza para que la policy sea un predicado '
  'directo sin join — ADR-0025 §7 se toma en serio el coste por consulta. La '
  'coherencia la fuerza platform.assert_rbac_tenant_coherence().';

-- -----------------------------------------------------------------------------
-- 3.10 user_role_assignments — usuario (vía membership) + rol + company.
--      company_id NULLABLE: null = alcance tenant-wide (ADR-0025 §2).
-- -----------------------------------------------------------------------------
create table public.user_role_assignments (
  id             uuid primary key default platform.uuidv7(),
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  membership_id  uuid not null,
  role_id        uuid not null references public.roles (id) on delete restrict,
  company_id     uuid,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete restrict,

  constraint user_role_assignments_membership_fk
    foreign key (tenant_id, membership_id)
    references public.memberships (tenant_id, id) on delete restrict,

  constraint user_role_assignments_company_fk
    foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id) on delete restrict,

  constraint user_role_assignments_tenant_id_id_key unique (tenant_id, id)
);

comment on table public.user_role_assignments is
  'company_id NULL = la asignación alcanza todas las companies del tenant. '
  'La coherencia de tenant con el rol (un rol de tenant ajeno no se asigna) la '
  'fuerza platform.assert_rbac_tenant_coherence(): no puede ser una FK '
  'compuesta porque roles.tenant_id es nullable y MATCH SIMPLE se saltaría la '
  'comprobación justo para los roles de sistema.';

-- Unicidad de la asignación. Dos índices parciales por el mismo motivo que en
-- roles: company_id NULL no deduplica bajo un UNIQUE ordinario.
create unique index user_role_assignments_tenant_wide_uidx
  on public.user_role_assignments (membership_id, role_id)
  where company_id is null;
create unique index user_role_assignments_company_uidx
  on public.user_role_assignments (membership_id, role_id, company_id)
  where company_id is not null;

-- -----------------------------------------------------------------------------
-- 3.11 scope_bindings — alcance por recurso. POLIMÓRFICA, sin FK real.
-- -----------------------------------------------------------------------------
create table public.scope_bindings (
  id             uuid primary key default platform.uuidv7(),
  tenant_id      uuid not null references public.tenants (id) on delete restrict,
  company_id     uuid not null,
  assignment_id  uuid not null,
  scope_type     text not null,
  scope_id       uuid not null,
  created_at     timestamptz not null default now(),
  created_by     uuid references auth.users (id) on delete restrict,

  constraint scope_bindings_scope_type_chk
    check (scope_type in ('branch', 'warehouse', 'cash_register')),

  constraint scope_bindings_company_fk
    foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id) on delete restrict,

  constraint scope_bindings_assignment_fk
    foreign key (tenant_id, assignment_id)
    references public.user_role_assignments (tenant_id, id) on delete restrict,

  constraint scope_bindings_assignment_scope_key
    unique (assignment_id, scope_type, scope_id)
);

comment on table public.scope_bindings is
  'Recursos concretos que alcanza una asignación de rol. EXCEPCIÓN CONSCIENTE '
  'a la regla de "FK reales" de ENGINEERING_STANDARDS.md §SQL: la forma '
  'polimórfica (scope_type + scope_id) no admite FK. La alternativa —tres '
  'columnas nullables con tres FK— se rompe al cuarto tipo de recurso, y en un '
  'ERP lo habrá (vehículos de reparto, puntos de venta, centros de coste). '
  'Se compensa con platform.assert_scope_binding_target() para la existencia y '
  'la company, y con triggers BEFORE DELETE en las tablas de recurso que '
  'replican el ON DELETE RESTRICT (ADR-0025, Consecuencias).';
comment on column public.scope_bindings.scope_id is
  'Sin FK real. La integridad referencial se hace a mano en '
  'platform.assert_scope_binding_target() (INSERT/UPDATE) y en '
  'platform.assert_no_scope_bindings() (DELETE del recurso).';


-- =============================================================================
-- 4. Integridad a mano de lo que la forma polimórfica y los NULL impiden
-- =============================================================================

-- Resuelve la company de un recurso acotado. Centraliza el despacho
-- polimórfico: añadir un cuarto tipo de recurso toca esta función y el CHECK de
-- scope_type, nada más.
--
-- SECURITY DEFINER porque tiene que ver el recurso aunque la RLS del llamante
-- no se lo muestre — si no, un binding a un recurso invisible pasaría la
-- validación por no encontrarlo. Sin GRANT a authenticated: solo la invocan
-- otras funciones SECURITY DEFINER, que se ejecutan como el dueño.
create or replace function platform.resource_company_id(
  p_scope_type text,
  p_scope_id   uuid
)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select case p_scope_type
           when 'branch' then
             (select b.company_id from public.branches b where b.id = p_scope_id)
           when 'warehouse' then
             (select w.company_id from public.warehouses w where w.id = p_scope_id)
           when 'cash_register' then
             (select c.company_id from public.cash_registers c where c.id = p_scope_id)
         end;
$$;

comment on function platform.resource_company_id(text, uuid) is
  'Despacho polimórfico de scope_type -> company del recurso. Punto único a '
  'tocar cuando aparezca un cuarto tipo de recurso acotable.';

revoke execute on function platform.resource_company_id(text, uuid) from public;

-- -----------------------------------------------------------------------------
-- 4.1 Coherencia de tenant donde la FK no llega
-- -----------------------------------------------------------------------------
create or replace function platform.assert_rbac_tenant_coherence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_tenant uuid;
  v_role_exists boolean;
begin
  select r.tenant_id, true
    into v_role_tenant, v_role_exists
    from public.roles r
   where r.id = new.role_id;

  -- Si el rol no existe, la FK lo rechazará al final de la sentencia; aquí no
  -- se inventa un error distinto.
  if not coalesce(v_role_exists, false) then
    return new;
  end if;

  if tg_table_name = 'role_permissions' then
    if new.tenant_id is distinct from v_role_tenant then
      raise exception 'LADINO_TENANT_COHERENCE: role_permissions.tenant_id (%) debe coincidir con roles.tenant_id (%) del rol %.',
        new.tenant_id, v_role_tenant, new.role_id
        using errcode = 'LAD27';
    end if;

  elsif tg_table_name = 'user_role_assignments' then
    -- Un rol de sistema (tenant_id NULL) es asignable desde cualquier tenant.
    -- Un rol propio de un tenant, solo dentro de ese tenant.
    if v_role_tenant is not null and v_role_tenant <> new.tenant_id then
      raise exception 'LADINO_TENANT_COHERENCE: el rol % pertenece al tenant % y la asignación declara el tenant %.',
        new.role_id, v_role_tenant, new.tenant_id
        using errcode = 'LAD27';
    end if;
  end if;

  return new;
end;
$$;

comment on function platform.assert_rbac_tenant_coherence() is
  'Sustituye a la FK compuesta que roles.tenant_id nullable hace imposible: '
  'MATCH SIMPLE no comprueba nada cuando alguna columna es NULL, que es justo '
  'el caso de los roles de sistema. SQLSTATE LAD27.';

create trigger role_permissions_tenant_coherence
  before insert or update on public.role_permissions
  for each row execute function platform.assert_rbac_tenant_coherence();

create trigger user_role_assignments_tenant_coherence
  before insert or update on public.user_role_assignments
  for each row execute function platform.assert_rbac_tenant_coherence();

-- -----------------------------------------------------------------------------
-- 4.2 Validación de existencia y company del recurso apuntado por un binding
-- -----------------------------------------------------------------------------
create or replace function platform.assert_scope_binding_target()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_resource_company   uuid;
  v_assignment_company uuid;
begin
  v_resource_company := platform.resource_company_id(new.scope_type, new.scope_id);

  if v_resource_company is null then
    raise exception 'LADINO_SCOPE_TARGET: no existe ningún % con id %. scope_bindings es polimórfica y no tiene FK: esta comprobación la sustituye.',
      new.scope_type, new.scope_id
      using errcode = 'LAD26';
  end if;

  if v_resource_company <> new.company_id then
    raise exception 'LADINO_SCOPE_TARGET: el % % pertenece a la company % y el binding declara la company %.',
      new.scope_type, new.scope_id, v_resource_company, new.company_id
      using errcode = 'LAD26';
  end if;

  select ura.company_id
    into v_assignment_company
    from public.user_role_assignments ura
   where ura.id = new.assignment_id;

  -- Una asignación acotada a una company no puede enlazar recursos de otra.
  -- Una asignación tenant-wide (company_id NULL) sí puede enlazar recursos de
  -- cualquier company del tenant; la FK compuesta ya garantiza el tenant.
  if v_assignment_company is not null
     and v_assignment_company <> new.company_id then
    raise exception 'LADINO_SCOPE_TARGET: la asignación % está acotada a la company % y el binding declara la company %.',
      new.assignment_id, v_assignment_company, new.company_id
      using errcode = 'LAD26';
  end if;

  return new;
end;
$$;

comment on function platform.assert_scope_binding_target() is
  'Integridad referencial a mano para scope_bindings: existencia del recurso y '
  'pertenencia a la misma company. Hace lo que haría la FK salvo el ON DELETE '
  'RESTRICT, que replica platform.assert_no_scope_bindings(). SQLSTATE LAD26.';

create trigger scope_bindings_target_valid
  before insert or update on public.scope_bindings
  for each row execute function platform.assert_scope_binding_target();

-- -----------------------------------------------------------------------------
-- 4.3 ON DELETE RESTRICT replicado en las tablas de recurso
-- -----------------------------------------------------------------------------
create or replace function platform.assert_no_scope_bindings()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count bigint;
begin
  select count(*)
    into v_count
    from public.scope_bindings sb
   where sb.scope_type = tg_argv[0]
     and sb.scope_id   = old.id;

  if v_count > 0 then
    -- Se lanza como foreign_key_violation a propósito: para el cliente esto ES
    -- la FK que la forma polimórfica no permite declarar.
    raise exception 'LADINO_SCOPE_RESTRICT: no se puede eliminar el % % porque tiene % scope_bindings que lo referencian. Elimine primero los bindings.',
      tg_argv[0], old.id, v_count
      using errcode = '23503';
  end if;

  return old;
end;
$$;

comment on function platform.assert_no_scope_bindings() is
  'Replica ON DELETE RESTRICT para la referencia polimórfica de '
  'scope_bindings.scope_id. Recibe el scope_type por TG_ARGV[0].';

create trigger branches_scope_bindings_restrict
  before delete on public.branches
  for each row execute function platform.assert_no_scope_bindings('branch');

create trigger warehouses_scope_bindings_restrict
  before delete on public.warehouses
  for each row execute function platform.assert_no_scope_bindings('warehouse');

create trigger cash_registers_scope_bindings_restrict
  before delete on public.cash_registers
  for each row execute function platform.assert_no_scope_bindings('cash_register');


-- =============================================================================
-- 5. El invariante de alcance (ADR-0025 §4)
--
--   Un rol que tenga ALGÚN permiso con is_scoped = true debe tener
--   requires_scope = true.
--
-- No es expresable con un CHECK (necesita subconsulta), así que va como
-- constraint trigger DIFERIDO sobre las TRES tablas que pueden romperlo.
-- La tercera es la que se escapa si no se piensa: reclasificar un permiso
-- existente rompe el invariante en todos los roles que ya lo tenían, y esa
-- transacción no toca ni roles ni role_permissions.
-- =============================================================================

create or replace function platform.assert_role_scope_coherence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role_id  uuid;
  v_role_key text;
  v_perm_key text;
begin
  if tg_table_name = 'role_permissions' then
    select r.id, r.key, p.key
      into v_role_id, v_role_key, v_perm_key
      from public.roles r
      join public.permissions p on p.key = new.permission_key
     where r.id = new.role_id
       and p.is_scoped
       and not r.requires_scope
     limit 1;

  elsif tg_table_name = 'roles' then
    select r.id, r.key, p.key
      into v_role_id, v_role_key, v_perm_key
      from public.roles r
      join public.role_permissions rp on rp.role_id = r.id
      join public.permissions p on p.key = rp.permission_key
     where r.id = new.id
       and p.is_scoped
       and not r.requires_scope
     limit 1;

  elsif tg_table_name = 'permissions' then
    select r.id, r.key, p.key
      into v_role_id, v_role_key, v_perm_key
      from public.permissions p
      join public.role_permissions rp on rp.permission_key = p.key
      join public.roles r on r.id = rp.role_id
     where p.key = new.key
       and p.is_scoped
       and not r.requires_scope
     limit 1;
  end if;

  if v_role_id is not null then
    -- El mensaje identifica rol y permiso concretos a propósito: el trigger es
    -- diferido y el error aparece al cerrar la transacción, lejos del INSERT
    -- que lo causó. Sin estos datos el diagnóstico sería penoso
    -- (ADR-0025, Consecuencias).
    raise exception 'LADINO_SCOPE_COHERENCE: el rol "%" (%) declara requires_scope=false pero tiene concedido el permiso acotado "%" (is_scoped=true). ADR-0025 §4: un rol con algún permiso acotado debe declarar requires_scope=true, o el fallo por omisión concedería toda la company.',
      v_role_key, v_role_id, v_perm_key
      using errcode = 'LAD25',
            hint    = 'Ponga requires_scope=true en el rol o retire el permiso acotado.';
  end if;

  return null;
end;
$$;

comment on function platform.assert_role_scope_coherence() is
  'Invariante de ADR-0025 §4 forzado en la base. SECURITY DEFINER para que la '
  'comprobación no dependa de lo que la RLS del llamante le deje ver: un falso '
  'negativo aquí es un rol company-wide con permisos acotados que nadie '
  'detecta. Diferido a COMMIT para que poblar el catálogo por migración no '
  'dependa del orden de los INSERT. SQLSTATE LAD25.';

create constraint trigger role_permissions_scope_coherence
  after insert or update on public.role_permissions
  deferrable initially deferred
  for each row execute function platform.assert_role_scope_coherence();

create constraint trigger roles_scope_coherence
  after update of requires_scope on public.roles
  deferrable initially deferred
  for each row execute function platform.assert_role_scope_coherence();

-- El tercer flanco: reclasificar un permiso ya concedido.
create constraint trigger permissions_scope_coherence
  after update of is_scoped on public.permissions
  deferrable initially deferred
  for each row execute function platform.assert_role_scope_coherence();


-- =============================================================================
-- 6. Las cuatro funciones de alcance (ADR-0025 §5)
--
-- Las cuatro son:
--   STABLE          — dependen de datos de tabla que cambian; VOLATILE haría
--                     que el planificador las evaluara por fila SIEMPRE, y la
--                     diferencia es de tres órdenes de magnitud (§7).
--   SECURITY DEFINER— tienen que leer memberships y user_role_assignments por
--                     debajo de la RLS que ellas mismas alimentan; si no, la
--                     recursión es inevitable.
--   search_path=''  — contra el secuestro por resolución de nombres. Todo va
--                     cualificado; pg_catalog se busca siempre implícitamente.
--   REVOKE/GRANT    — search_path fijado NO basta: EXECUTE se concede a PUBLIC
--                     por defecto, y una función que lee memberships por debajo
--                     de la RLS y puede llamarse sin autenticar es una fuga de
--                     la estructura organizativa completa.
--
-- SIN CACHÉ DE SESIÓN, a propósito. Ni SET LOCAL, ni tabla temporal, ni
-- memoización en el pooler: cachear el resultado por conexión anula el diseño
-- entero de ADR-0014, cuyo punto es que quitar un membership corte el acceso en
-- la consulta siguiente.
-- =============================================================================

create or replace function platform.ladino_tenant_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.tenant_id
    from public.memberships m
   where m.user_id = auth.uid()
     and m.status = 'active';
$$;

comment on function platform.ladino_tenant_ids() is
  'Tenants en los que el usuario actual tiene un membership activo. Base sobre '
  'la que se construyen las demás; separarla evita repetir la misma subconsulta '
  'en cada policy (ADR-0025 §5).';

create or replace function platform.ladino_company_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select c.id
    from public.companies c
   where exists (
     select 1
       from public.memberships m
       join public.user_role_assignments ura on ura.membership_id = m.id
      where m.user_id   = auth.uid()
        and m.status    = 'active'
        and m.tenant_id = c.tenant_id
        and (ura.company_id = c.id or ura.company_id is null)
   );
$$;

comment on function platform.ladino_company_ids() is
  'Companies alcanzadas por alguna asignación de rol del usuario: la asignación '
  'con company_id NULL alcanza todas las del tenant. Un membership SIN ninguna '
  'asignación no ve ninguna company — el fallo por omisión deniega. No filtra '
  'por companies.status: una company suspendida sigue siendo visible para quien '
  'debe reactivarla.';

create or replace function platform.ladino_has_permission(
  p_permission text,
  p_company_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.companies c
      join public.memberships m
        on m.tenant_id = c.tenant_id
       and m.user_id   = auth.uid()
       and m.status    = 'active'
      join public.user_role_assignments ura
        on ura.membership_id = m.id
       and (ura.company_id = c.id or ura.company_id is null)
      join public.roles r
        on r.id = ura.role_id
      join public.role_permissions rp
        on rp.role_id = r.id
       and rp.permission_key = p_permission
     where c.id = p_company_id
       and (
             not r.requires_scope
          -- ADR-0025 §4: un rol acotado SIN bindings no opera nada. Aquí la
          -- pregunta es "¿puede hacer esto en algún sitio de esta company?",
          -- así que basta con que exista al menos un binding en ella.
          or exists (
               select 1
                 from public.scope_bindings sb
                where sb.assignment_id = ura.id
                  and sb.company_id    = c.id
             )
       )
  );
$$;

comment on function platform.ladino_has_permission(text, uuid) is
  'Responde "¿puede el usuario ejercer este permiso en ALGÚN punto de esta '
  'company?". Para un rol con requires_scope=true exige al menos un '
  'scope_binding: sin bindings no opera nada. La pregunta por un recurso '
  'CONCRETO es platform.ladino_has_scope().';

create or replace function platform.ladino_has_scope(
  p_permission text,
  p_scope_type text,
  p_scope_id   uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
      from public.companies c
      join public.memberships m
        on m.tenant_id = c.tenant_id
       and m.user_id   = auth.uid()
       and m.status    = 'active'
      join public.user_role_assignments ura
        on ura.membership_id = m.id
       and (ura.company_id = c.id or ura.company_id is null)
      join public.roles r
        on r.id = ura.role_id
      join public.role_permissions rp
        on rp.role_id = r.id
       and rp.permission_key = p_permission
     where c.id = platform.resource_company_id(p_scope_type, p_scope_id)
       and (
             not r.requires_scope
          or exists (
               select 1
                 from public.scope_bindings sb
                where sb.assignment_id = ura.id
                  and sb.scope_type    = p_scope_type
                  and sb.scope_id      = p_scope_id
             )
       )
  );
$$;

comment on function platform.ladino_has_scope(text, text, uuid) is
  'La que consultarán las policies de las tablas operativas de fases '
  'posteriores (movimientos de caja, de almacén). Se crea ahora porque la regla '
  'que implementa se decide ahora, y dejarla para después invitaría a que cada '
  'tabla se invente la suya (ADR-0025 §5). Un recurso inexistente devuelve '
  'false: resource_company_id() da NULL y ninguna company casa.';

-- Las cuatro, sin excepción: EXECUTE revocado a PUBLIC y concedido solo a
-- `authenticated`. `anon` no las invoca.
revoke execute on function platform.ladino_tenant_ids()                  from public;
revoke execute on function platform.ladino_company_ids()                 from public;
revoke execute on function platform.ladino_has_permission(text, uuid)    from public;
revoke execute on function platform.ladino_has_scope(text, text, uuid)   from public;

grant execute on function platform.ladino_tenant_ids()                   to authenticated;
grant execute on function platform.ladino_company_ids()                  to authenticated;
grant execute on function platform.ladino_has_permission(text, uuid)     to authenticated;
grant execute on function platform.ladino_has_scope(text, text, uuid)    to authenticated;


-- =============================================================================
-- 7. Índices (ADR-0025 §7) — desde esta migración, no cuando duela.

-- =============================================================================
-- Índices del RBAC (ADR-0025 §7)
--
-- Cada policy invoca platform.ladino_*(), y cada invocación consulta estas
-- tablas. Sin estos índices el objetivo p95 < 500 ms de ADR-0014 no se sostiene.
-- =============================================================================

-- Sirven directamente a las cuatro funciones de alcance:
create index memberships_user_tenant_idx
  on public.memberships (user_id, tenant_id);                 -- ladino_tenant_ids()
create index user_role_assignments_membership_company_idx
  on public.user_role_assignments (membership_id, company_id); -- ladino_company_ids()
-- role_permissions (role_id, permission_key) ya es la PK.     -- ladino_has_permission()
-- scope_bindings (assignment_id, scope_type, scope_id) ya es UNIQUE. -- ladino_has_scope()

-- Búsqueda inversa: qué roles tienen un permiso. La usa el tercer flanco del
-- invariante (constraint trigger sobre permissions).
create index role_permissions_permission_key_idx
  on public.role_permissions (permission_key);
create index role_permissions_tenant_idx
  on public.role_permissions (tenant_id);
create index user_role_assignments_role_idx
  on public.user_role_assignments (role_id);

-- El BEFORE DELETE que replica ON DELETE RESTRICT busca por aquí.
create index scope_bindings_scope_idx
  on public.scope_bindings (scope_type, scope_id);

-- (tenant_id, company_id): el predicado de toda policy.
create index user_role_assignments_tenant_company_idx
  on public.user_role_assignments (tenant_id, company_id);
create index scope_bindings_tenant_company_idx  on public.scope_bindings (tenant_id, company_id);

-- (company_id, status) y (company_id, fecha desc): mínimos de
-- ENGINEERING_STANDARDS.md §SQL.
create index memberships_tenant_status_idx      on public.memberships (tenant_id, status);
create index roles_tenant_idx                   on public.roles (tenant_id);



-- =============================================================================
-- RLS: ENABLE y FORCE en las seis tablas del RBAC. Sin policies todavía.
-- =============================================================================

alter table public.memberships            enable row level security;
alter table public.memberships            force  row level security;
alter table public.roles                  enable row level security;
alter table public.roles                  force  row level security;
alter table public.permissions            enable row level security;
alter table public.permissions            force  row level security;
alter table public.role_permissions       enable row level security;
alter table public.role_permissions       force  row level security;
alter table public.user_role_assignments  enable row level security;
alter table public.user_role_assignments  force  row level security;
alter table public.scope_bindings         enable row level security;
alter table public.scope_bindings         force  row level security;

-- 11. Catálogo de permisos
--
-- Vocabulario que el sistema sabe hacer, en formato `resource.action`
-- (MULTITENANCY_AND_RBAC.md). Se puebla por migración; no hay policy de INSERT.
--
-- is_scoped = true SOLO donde el permiso actúa sobre un recurso acotable
-- (sucursal, almacén, caja). Recordatorio de ADR-0025: esta columna es el
-- punto único de fallo del modelo. Clasificar mal un permiso aquí desactiva
-- la comprobación de coherencia para ese permiso, y nada lo detecta.
-- =============================================================================

insert into public.permissions (key, description, is_scoped) values
  -- Estructura organizacional
  ('tenant.read',            'Consultar los datos del tenant',                         false),
  ('company.read',           'Consultar los datos de la empresa',                      false),
  ('company.manage',         'Crear y modificar empresas y su estado',                 false),
  ('branch.read',            'Consultar sucursales',                                   false),
  ('branch.manage',          'Crear, modificar y desactivar sucursales',               false),
  ('warehouse.read',         'Consultar almacenes',                                    false),
  ('warehouse.manage',       'Crear, modificar y desactivar almacenes',                false),
  ('warehouse.move',         'Registrar movimientos de inventario en un almacén',      true),
  ('cash_register.read',     'Consultar cajas',                                        false),
  ('cash_register.manage',   'Crear, modificar y desactivar cajas',                    false),
  ('cash_register.operate',  'Abrir, operar y cerrar una caja',                        true),

  -- Identidad y permisos
  ('membership.read',        'Consultar los usuarios del tenant',                      false),
  ('membership.manage',      'Invitar, activar y desactivar usuarios del tenant',      false),
  ('role.read',              'Consultar roles y sus permisos',                         false),
  ('role.manage',            'Crear roles y asignarlos, incluido su alcance',          false),

  -- Contabilidad
  ('journal.post',           'Contabilizar un asiento',                                false),
  ('journal.reverse',        'Revertir un asiento contabilizado',                      false),
  ('period.close',           'Cerrar un período contable',                             false),
  ('period.reopen',          'Reabrir un período contable cerrado',                    false),

  -- Fiscal y tesorería
  ('invoice.issue',          'Emitir una factura fiscal',                              false),
  ('supplier.bank_account.approve',
                             'Aprobar la cuenta bancaria de un proveedor',             false),
  ('fiscal.audit.read',      'Consultar la pista de auditoría fiscal',                 false),

  -- Transversal
  ('report.export',          'Exportar reportes y libros',                             false);

comment on column public.permissions.key is
  'Formato `resource.action` (MULTITENANCY_AND_RBAC.md). Los permisos no se '
  'renombran ni se borran: se añade el nuevo y se deja de conceder el viejo.';

-- VALIDAR-RBAC: `invoice.issue` queda clasificado con is_scoped = false. La
-- emisión fiscal es una atribución a nivel de empresa; la dimensión de recurso
-- (qué caja, qué serie) la cubren `cash_register.operate` y la serie fiscal.
-- Si al construir packages/fiscal resulta que la emisión debe acotarse por
-- recurso, el cambio es `update permissions set is_scoped = true` en una
-- migración nueva — y el constraint trigger del bloque 5 hará fallar el COMMIT
-- si algún rol company-wide ya lo tenía concedido. El error será ruidoso, que
-- es justo lo que se quiere.
