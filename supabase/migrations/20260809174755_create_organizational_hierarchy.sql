-- =============================================================================
-- Ladino — 2/4 · Jerarquía organizacional
--
-- Módulo:         identidad organizacional (S0.3)
-- Spec:           ADR-0025 §1, §2 y §9.1; COMPANIES_BRANCHES_WAREHOUSES_SPEC.md
-- Reversibilidad: SÍ mientras no haya datos:
--                   drop table public.cash_registers, public.warehouses,
--                              public.branches, public.companies, public.tenants;
-- HOMOLOGATION_IMPACT: NO
--
-- Segunda de cuatro. Depende de 1/4 (platform.uuidv7()).
--
-- RLS queda habilitada Y FORZADA pero SIN POLICIES: hasta 4/4 nadie que no
-- tenga BYPASSRLS lee ni escribe estas tablas. Es el estado seguro intermedio
-- — denegar por defecto y abrir después, nunca al revés.
--
-- Las FK COMPUESTAS (tenant_id, company_id) -> companies (tenant_id, id) no son
-- decoración (ADR-0025 §9.1): `tenant_id` está denormalizado para que el
-- predicado de cada policy empiece por él sin un join, y un tenant_id mal
-- copiado convertiría el ancla de aislamiento en mentira sin que ninguna policy
-- lo notara. Con la FK compuesta la incoherencia es imposible de insertar.
-- =============================================================================

-- 3. Jerarquía organizacional
--
-- tenants ──┬─▶ companies ──┬─▶ branches ──┬─▶ warehouses  (branch_id nullable)
--           │               │              └─▶ cash_registers
--           └─▶ memberships └─▶ ...
--
-- Las anclas de aislamiento (tenant_id / company_id) siguen exactamente la
-- tabla de ADR-0025 §2, decididas tabla por tabla y no por convención genérica.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 3.1 tenants — la raíz. No es una entidad legal.
-- -----------------------------------------------------------------------------
create table public.tenants (
  id          uuid primary key default platform.uuidv7(),
  name        text        not null,
  status      text        not null default 'active',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint tenants_name_chk   check (length(btrim(name)) > 0),
  constraint tenants_status_chk check (status in ('active', 'suspended'))
);

comment on table public.tenants is
  'Agrupa una o varias companies. Es el caso de la firma contable que lleva '
  'veinte clientes (ADR-0014). NO es una entidad legal: la entidad/RIF es la '
  'company. Sin tenant_id porque es la raíz (ADR-0025 §2).';

-- -----------------------------------------------------------------------------
-- 3.2 companies — una empresa = una entidad/RIF. Nivel de toda transacción.
-- -----------------------------------------------------------------------------
create table public.companies (
  id          uuid primary key default platform.uuidv7(),
  tenant_id   uuid        not null references public.tenants (id) on delete restrict,
  legal_name  text        not null,
  trade_name  text,
  tax_id      text        not null,
  status      text        not null default 'onboarding',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint companies_legal_name_chk check (length(btrim(legal_name)) > 0),
  constraint companies_tax_id_chk     check (length(btrim(tax_id)) > 0),
  constraint companies_status_chk
    check (status in ('onboarding', 'active', 'suspended')),

  -- Unicidad del RIF DENTRO del tenant, no global: dos firmas contables
  -- distintas pueden llevar legítimamente la misma entidad legal.
  constraint companies_tenant_tax_id_key unique (tenant_id, tax_id),
  -- Ancla para las FK compuestas que garantizan coherencia de tenant en las
  -- tablas hijas. Ver 3.3.
  constraint companies_tenant_id_id_key unique (tenant_id, id)
);

comment on table public.companies is
  'Una empresa representa una entidad/RIF. Es el nivel al que pertenece toda '
  'transacción. Sin company_id porque ella ES la company (ADR-0025 §2).';
comment on column public.companies.tax_id is
  'RIF. Se almacena como texto sin validar el formato: cualquier regla de '
  'formato del RIF es materia normativa y debe salir de docs/02_COMPLIANCE/ '
  'con fuente citada. VALIDAR-SENIAT antes de producción.';

-- -----------------------------------------------------------------------------
-- 3.3 branches — sucursales
--
-- Nota sobre las FK: en lugar de una FK simple a companies(id) se usa una FK
-- COMPUESTA (tenant_id, company_id) -> companies(tenant_id, id). Hace dos
-- trabajos con una sola constraint: la company existe Y el tenant_id
-- denormalizado no puede divergir del de la company. Sin ella, un tenant_id
-- copiado mal convierte el ancla de aislamiento en mentira, y ninguna policy
-- lo detectaría.
-- -----------------------------------------------------------------------------
create table public.branches (
  id          uuid primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  code        text        not null,
  name        text        not null,
  status      text        not null default 'active',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint branches_code_chk   check (length(btrim(code)) > 0),
  constraint branches_name_chk   check (length(btrim(name)) > 0),
  constraint branches_status_chk check (status in ('active', 'inactive')),

  constraint branches_company_fk
    foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id) on delete restrict,

  constraint branches_company_code_key unique (company_id, code),
  constraint branches_company_id_id_key unique (company_id, id)
);

comment on table public.branches is
  'Sucursales de una company. Estados active/inactive '
  '(COMPANIES_BRANCHES_WAREHOUSES_SPEC.md).';

-- -----------------------------------------------------------------------------
-- 3.4 warehouses — almacenes. branch_id NULLABLE (ADR-0025 §1).
-- -----------------------------------------------------------------------------
create table public.warehouses (
  id          uuid primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  branch_id   uuid,
  code        text        not null,
  name        text        not null,
  status      text        not null default 'active',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint warehouses_code_chk   check (length(btrim(code)) > 0),
  constraint warehouses_name_chk   check (length(btrim(name)) > 0),
  constraint warehouses_status_chk check (status in ('active', 'inactive')),

  constraint warehouses_company_fk
    foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id) on delete restrict,

  -- FK compuesta con branch_id nullable: MATCH SIMPLE no comprueba nada cuando
  -- alguna columna es NULL, que es exactamente el comportamiento buscado —
  -- almacén central sin sucursal permitido; almacén con sucursal obligado a que
  -- esa sucursal sea de la misma company.
  constraint warehouses_branch_fk
    foreign key (company_id, branch_id)
    references public.branches (company_id, id) on delete restrict,

  constraint warehouses_company_code_key unique (company_id, code),
  constraint warehouses_company_id_id_key unique (company_id, id)
);

comment on table public.warehouses is
  'Almacenes de una company. branch_id es NULLABLE: la spec dice que un almacén '
  '*puede* pertenecer a una sucursal y un almacén central que sirve a varias '
  'sucursales es una operación normal (ADR-0025 §1).';

-- -----------------------------------------------------------------------------
-- 3.5 cash_registers — cajas. La tabla se llama así por el contrato ya
--     publicado POST /v1/cash-registers (ADR-0025 §1).
-- -----------------------------------------------------------------------------
create table public.cash_registers (
  id          uuid primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  branch_id   uuid        not null,
  code        text        not null,
  name        text        not null,
  status      text        not null default 'active',
  version     bigint      not null default 1,
  created_at  timestamptz not null default now(),
  created_by  uuid references auth.users (id) on delete restrict,

  constraint cash_registers_code_chk   check (length(btrim(code)) > 0),
  constraint cash_registers_name_chk   check (length(btrim(name)) > 0),
  constraint cash_registers_status_chk check (status in ('active', 'inactive')),

  constraint cash_registers_company_fk
    foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id) on delete restrict,

  constraint cash_registers_branch_fk
    foreign key (company_id, branch_id)
    references public.branches (company_id, id) on delete restrict,

  constraint cash_registers_company_code_key unique (company_id, code),
  constraint cash_registers_company_id_id_key unique (company_id, id)
);

comment on table public.cash_registers is
  'Cajas. branch_id es NOT NULL, a diferencia de warehouses.branch_id: el '
  'diagrama de ADR-0025 §1 las cuelga de la sucursal y una caja sin ubicación '
  'no tiene sentido operativo. Relajarlo después (drop not null) es una '
  'migración compatible; apretarlo después no lo es.';

-- -----------------------------------------------------------------------------

-- =============================================================================
-- Índices (ADR-0025 §7 y ENGINEERING_STANDARDS.md §SQL)
--
-- Desde la migración que crea la tabla, no cuando duela: añadirlos después con
-- datos y tráfico es un CREATE INDEX CONCURRENTLY y una ventana de riesgo.
-- =============================================================================

create index branches_tenant_company_idx        on public.branches (tenant_id, company_id);
create index warehouses_tenant_company_idx      on public.warehouses (tenant_id, company_id);
create index cash_registers_tenant_company_idx  on public.cash_registers (tenant_id, company_id);

create index companies_tenant_status_idx        on public.companies (tenant_id, status);
create index companies_tenant_created_idx       on public.companies (tenant_id, created_at desc);
create index branches_company_status_idx        on public.branches (company_id, status);
create index branches_company_created_idx       on public.branches (company_id, created_at desc);
create index warehouses_company_status_idx      on public.warehouses (company_id, status);
create index warehouses_company_created_idx     on public.warehouses (company_id, created_at desc);
create index warehouses_company_branch_idx      on public.warehouses (company_id, branch_id);
create index cash_registers_company_status_idx  on public.cash_registers (company_id, status);
create index cash_registers_company_created_idx on public.cash_registers (company_id, created_at desc);
create index cash_registers_company_branch_idx  on public.cash_registers (company_id, branch_id);


-- =============================================================================
-- RLS: ENABLE **y** FORCE, sin policies todavía
--
-- FORCE aplica la RLS también al PROPIETARIO de la tabla, que por defecto queda
-- exento. Lo que NO hace es contener a un rol con BYPASSRLS — Postgres lo
-- exceptúa por diseño y en Supabase `service_role` lo tiene. Por eso la
-- inmutabilidad de las append-only es un trigger y no una policy (ADR-0025 §6).
-- =============================================================================

alter table public.tenants         enable row level security;
alter table public.tenants         force  row level security;
alter table public.companies       enable row level security;
alter table public.companies       force  row level security;
alter table public.branches        enable row level security;
alter table public.branches        force  row level security;
alter table public.warehouses      enable row level security;
alter table public.warehouses      force  row level security;
alter table public.cash_registers  enable row level security;
alter table public.cash_registers  force  row level security;
