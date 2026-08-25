-- =============================================================================
-- Ladino — migración 16 · Catálogo de productos (primer maestro, bloque 4)
--
-- Módulo: products   Spec: docs/03_MODULES/PRODUCTS_CATALOG_SPEC.md ·
--                          docs/03_MODULES/MASTER_DATA_SPEC.md ·
--                          docs/02_COMPLIANCE/TAX_ENGINE_SPEC.md · decisiones D-1..D-10
-- Reversible: SÍ mientras las tablas estén vacías (drop); con datos, expand/contract.
-- Homologación: NO (cero tasas, cero emisión; solo clasificación referencial)
--
-- ALCANCE — un producto sin stock es un catálogo:
--   AQUÍ:      products, product_categories (comercial, por company),
--              product_tax_categories (clasificación fiscal, global),
--              units y currencies (maestros globales mínimos).
--   INVENTARIO (ni una columna aquí): stock, costeo, ubicaciones, mínimos.
--   DIFERIDO CON RAZÓN ESCRITA — lotes, seriales y BOM: las specs los listan
--   en el catálogo (PRODUCTS_CATALOG §Entidades) Y en inventario (INVENTORY
--   §Entidades) sin aclarar la frontera entre «definición» e «instancia
--   física». Un flag `tracks_lots` hoy DECIDIRÍA esa frontera de contrabando,
--   sin spec y sin necesidad: se decide cuando inventario exista y la
--   pregunta sea real. (Decisión del plan de productos, 2026-08-25.)
--   PRECIOS: migración 17 (rigor máximo, ADR-0032). Cero dinero en products.
--
-- LA TASA NUNCA ES UN NÚMERO EN LA TABLA (regla 8, ADR-0027): el producto
-- referencia `product_tax_categories.code`; el motor tributario futuro
-- (TAX_ENGINE_SPEC: tax_rules con product_tax_category, effective_from/to,
-- legal_source, version) cruzará esa categoría con la tasa vigente al
-- facturar. Hoy la categoría es etiqueta sin consecuencia; con una tasa
-- detrás, importa — por eso el seed va marcado VALIDAR-TRIBUTARIO.
-- =============================================================================

-- ── Maestros GLOBALES (sin tenant_id: excepción declarada, como permissions) ──

create table public.units (
  code       text        primary key,
  name       text        not null,
  symbol     text        not null,
  created_at timestamptz not null default now(),
  constraint units_code_chk check (code ~ '^[a-z][a-z0-9_]{0,19}$')
);
comment on table public.units is
  'Unidades de medida (MASTER_DATA_SPEC). Catálogo GLOBAL sin tenant_id: '
  'vocabulario del sistema, no dato de nadie — la misma excepción declarada '
  'que permissions (ADR-0025 §3). SIN conversiones entre unidades: llegan con '
  'inventario/compras cuando exista el caso (D-4). Se puebla por migración.';

create table public.currencies (
  code             text        primary key,
  name             text        not null,
  symbol           text        not null,
  -- Decimales de PRESENTACIÓN. No es redondeo fiscal: eso es RoundingPolicy
  -- versionada (MONEY_AND_ROUNDING_SPEC §6, VALIDAR-TRIBUTARIO pendiente).
  display_decimals smallint    not null default 2,
  created_at       timestamptz not null default now(),
  constraint currencies_code_chk check (code ~ '^[A-Z]{3}$'),
  constraint currencies_decimals_chk check (display_decimals between 0 and 8)
);
comment on table public.currencies is
  'Monedas (MASTER_DATA_SPEC). Tabla y no CHECK ISO-4217: añadir una moneda '
  'no debe requerir migración de esquema (D-5, ajuste del usuario) — requiere '
  'una fila, que sí es migración de DATOS con su fuente. Global, como units.';

create table public.product_tax_categories (
  code        text        primary key,
  name        text        not null,
  description text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  constraint product_tax_categories_code_chk   check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint product_tax_categories_status_chk check (status in ('active', 'inactive'))
);
comment on table public.product_tax_categories is
  'Clasificación TRIBUTARIA del producto (TAX_ENGINE_SPEC: la columna '
  'product_tax_category de tax_rules apunta aquí). DELIBERADAMENTE distinta '
  'en FORMA de product_categories (código text semántico vs uuid por company): '
  'si compartieran forma, alguien las intercambiaría algún día (D-3/D-7). '
  'NINGUNA tasa vive aquí ni en products: el motor tributario resolverá la '
  'tasa vigente por categoría, con vigencia y fuente legal, al facturar.';

-- ── Maestros POR COMPANY ─────────────────────────────────────────────────────

create table public.product_categories (
  id         uuid        primary key default platform.uuidv7(),
  tenant_id  uuid        not null,
  company_id uuid        not null,
  name       text        not null,
  status     text        not null default 'active',
  created_by uuid,
  created_at timestamptz not null,
  version    integer     not null,
  constraint product_categories_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint product_categories_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint product_categories_name_chk
    check (name = btrim(name) and length(name) between 1 and 100),
  constraint product_categories_status_chk check (status in ('active', 'inactive')),
  constraint product_categories_company_name_key unique (company_id, name),
  -- Ancla del FK compuesto desde products: una categoría no puede referenciarse
  -- desde otra company (la fuga silenciosa que las FK simples no ven).
  constraint product_categories_company_id_key unique (company_id, id)
);
comment on table public.product_categories is
  'Categoría COMERCIAL, por company y plana (D-7): clasificación de negocio, '
  'sin jerarquía hasta que exista el caso. Nada fiscal aquí — eso es '
  'product_tax_categories, con forma deliberadamente incompatible.';

-- ── El producto ──────────────────────────────────────────────────────────────

create table public.products (
  id                uuid        primary key default platform.uuidv7(),
  tenant_id         uuid        not null,
  company_id        uuid        not null,

  sku               text        not null,
  name              text        not null,
  -- bien | servicio (D-8). Inmutable tras salir de draft: inventario y
  -- contabilidad van a colgar de esto (trigger LAD33 abajo).
  kind              text        not null,
  status            text        not null default 'draft',

  unit_code         text        not null,
  tax_category_code text        not null,
  category_id       uuid,
  barcode           text,

  created_by        uuid,
  created_at        timestamptz not null,
  version           integer     not null,

  constraint products_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint products_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint products_unit_fk
    foreign key (unit_code) references public.units (code),
  -- FISCAL: código text semántico y global.
  constraint products_tax_category_fk
    foreign key (tax_category_code) references public.product_tax_categories (code),
  -- COMERCIAL: uuid compuesto POR COMPANY. Las dos referencias no se pueden
  -- intercambiar ni por tipo ni por alcance (D-3/D-7; ejercido en pgTAP 016).
  constraint products_category_fk
    foreign key (company_id, category_id) references public.product_categories (company_id, id),

  -- SKU manual, 1-60 tras trim; el trim se EXIGE, no se aplica en silencio
  -- (modo de fallo ruidoso): '  abc  ' es un error del cliente, no un dato.
  constraint products_sku_chk
    check (sku = btrim(sku) and length(sku) between 1 and 60),
  constraint products_name_chk
    check (name = btrim(name) and length(name) between 1 and 200),
  constraint products_kind_chk   check (kind in ('good', 'service')),
  constraint products_status_chk check (status in ('draft', 'active', 'inactive')),
  constraint products_barcode_chk
    check (barcode is null or (barcode = btrim(barcode) and length(barcode) between 1 and 64))
);
comment on table public.products is
  'Catálogo de productos (D-1: por company). Sin stock, sin costeo, sin '
  'precios (migración 17), sin lotes/seriales/BOM (diferidos con razón en la '
  'cabecera). La clave natural es (company_id, sku) case-insensitive — es lo '
  'que cierra el borde T1/T2 de la idempotencia para create-product.';
comment on column public.products.tax_category_code is
  'Referencia a la clasificación fiscal versionable. NUNCA una tasa: la tasa '
  'la resolverá tax_rules por vigencia y fuente (regla 8, ADR-0027).';

-- La clave natural (D-2): única por company, case-insensitive también en
-- unicode (lower() con la collation UTF-8 del proyecto: 'ÑOÑO' == 'ñoño').
create unique index products_company_sku_uidx on public.products (company_id, lower(sku));
-- Barcode único por company cuando existe; varios productos sin barcode conviven (D-6).
create unique index products_company_barcode_uidx on public.products (company_id, barcode)
  where barcode is not null;

create index products_tenant_company_idx on public.products (tenant_id, company_id);
create index products_company_status_idx on public.products (company_id, status);
create index products_company_category_idx on public.products (company_id, category_id);
create index product_categories_tenant_company_idx on public.product_categories (tenant_id, company_id);

-- ── Triggers: procedencia, anclas, y el kind congelado ───────────────────────

create trigger products_provenance
  before insert or update on public.products
  for each row execute function platform.set_row_provenance();
create trigger products_anchors_immutable
  before update on public.products
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger product_categories_provenance
  before insert or update on public.product_categories
  for each row execute function platform.set_row_provenance();
create trigger product_categories_anchors_immutable
  before update on public.product_categories
  for each row execute function platform.assert_isolation_anchors_immutable();

-- LAD33 reservado en ERROR_CATALOG.md antes de usarse (regla de la migración 8).
create function platform.assert_product_kind_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind is distinct from old.kind and old.status <> 'draft' then
    raise exception
      'el tipo (bien/servicio) de un producto no se cambia después de draft: '
      'inventario y contabilidad dependen de él. Crea otro producto.'
      using errcode = 'LAD33', hint = 'productos: kind es inmutable tras activarse (D-8)';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_product_kind_frozen() from public;

create trigger products_kind_frozen
  before update on public.products
  for each row execute function platform.assert_product_kind_frozen();

-- ── RLS: habilitada y FORZADA en todo; escritura solo por la API ─────────────

alter table public.units                  enable row level security;
alter table public.units                  force row level security;
alter table public.currencies             enable row level security;
alter table public.currencies             force row level security;
alter table public.product_tax_categories enable row level security;
alter table public.product_tax_categories force row level security;
alter table public.product_categories     enable row level security;
alter table public.product_categories     force row level security;
alter table public.products               enable row level security;
alter table public.products               force row level security;

-- Globales: lectura para todos los caminos; escritura DENEGADA POR ESCRITO
-- (se pueblan por migración; 'ausencia de policy' es indistinguible de un olvido).
create policy units_select on public.units for select to authenticated, ladino_api using (true);
create policy units_insert on public.units for insert to authenticated, ladino_api with check (false);
create policy units_update on public.units for update to authenticated, ladino_api using (false);
create policy units_delete on public.units for delete to authenticated, ladino_api using (false);

create policy currencies_select on public.currencies for select to authenticated, ladino_api using (true);
create policy currencies_insert on public.currencies for insert to authenticated, ladino_api with check (false);
create policy currencies_update on public.currencies for update to authenticated, ladino_api using (false);
create policy currencies_delete on public.currencies for delete to authenticated, ladino_api using (false);

create policy product_tax_categories_select on public.product_tax_categories
  for select to authenticated, ladino_api using (true);
create policy product_tax_categories_insert on public.product_tax_categories
  for insert to authenticated, ladino_api with check (false);
create policy product_tax_categories_update on public.product_tax_categories
  for update to authenticated, ladino_api using (false);
create policy product_tax_categories_delete on public.product_tax_categories
  for delete to authenticated, ladino_api using (false);

-- Por company: authenticated LEE lo suyo (los datos van por la API — la web no
-- escribe maestros por PostgREST); ladino_api escribe acotada a su tenant.
-- SIN DELETE para nadie: un maestro referenciado se desactiva, no se borra
-- (MASTER_DATA_SPEC), y la ausencia se escribe.
create policy product_categories_select on public.product_categories for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy product_categories_insert on public.product_categories for insert to authenticated
  with check (false);
create policy product_categories_update on public.product_categories for update to authenticated
  using (false);
create policy product_categories_delete on public.product_categories
  for delete to authenticated, ladino_api using (false);
create policy product_categories_api_select on public.product_categories for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_categories_api_insert on public.product_categories for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_categories_api_update on public.product_categories for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy products_select on public.products for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy products_insert on public.products for insert to authenticated
  with check (false);
create policy products_update on public.products for update to authenticated
  using (false);
create policy products_delete on public.products
  for delete to authenticated, ladino_api using (false);
create policy products_api_select on public.products for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy products_api_insert on public.products for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy products_api_update on public.products for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

-- ── GRANTS: lo mínimo, y el DELETE no existe para nadie ─────────────────────
revoke all on public.units, public.currencies, public.product_tax_categories,
              public.product_categories, public.products
  from anon, authenticated, service_role, ladino_api, ladino_worker;

grant select on public.units, public.currencies, public.product_tax_categories
  to authenticated, ladino_api;
grant select on public.product_categories, public.products to authenticated;
grant select, insert, update on public.product_categories, public.products to ladino_api;

-- ── SEEDS ────────────────────────────────────────────────────────────────────

insert into public.units (code, name, symbol) values
  ('unidad',   'Unidad',   'und'),
  ('kg',       'Kilogramo','kg'),
  ('litro',    'Litro',    'L'),
  ('hora',     'Hora',     'h'),
  ('servicio', 'Servicio', 'serv');

insert into public.currencies (code, name, symbol, display_decimals) values
  ('VES', 'Bolívar', 'Bs.', 2),
  ('USD', 'Dólar estadounidense', '$', 2);

-- ⚠ VALIDAR-TRIBUTARIO — SEED PROVISIONAL, decisión D-3 (2026-08-25).
-- Estas seis clasificaciones siguen la estructura general de la LIVA (gravado
-- a alícuota general / reducida / adicional, exento, exonerado, no sujeto),
-- pero NO llevan tasa, artículo ni fuente: hoy son etiquetas sin consecuencia.
-- ANTES de que el motor tributario (tax_rules) las consuma con una tasa
-- detrás, este vocabulario se confirma con el asesor tributario: nombres,
-- cobertura y correspondencia legal exacta. Si el asesor cambia el
-- vocabulario, se corrige con migración de datos, no editando esta.
insert into public.product_tax_categories (code, name, description) values
  ('gravado_general',  'Gravado — alícuota general',
   'Sujeto a IVA a la alícuota general vigente. VALIDAR-TRIBUTARIO.'),
  ('gravado_reducida', 'Gravado — alícuota reducida',
   'Sujeto a IVA a alícuota reducida. VALIDAR-TRIBUTARIO.'),
  ('gravado_adicional','Gravado — alícuota adicional',
   'Sujeto a IVA con alícuota adicional (suntuario). VALIDAR-TRIBUTARIO.'),
  ('exento',           'Exento',
   'Exención objetiva por ley. VALIDAR-TRIBUTARIO.'),
  ('exonerado',        'Exonerado',
   'Exoneración por decreto, temporal por naturaleza. VALIDAR-TRIBUTARIO.'),
  ('no_sujeto',        'No sujeto',
   'Fuera del hecho imponible del IVA. VALIDAR-TRIBUTARIO.');

-- Permisos del maestro (D-10): manage y mapeo tributario SEPARADOS — «contador
-- aprueba mapeo contable/tributario» (PRODUCTS_CATALOG §Permisos) pide
-- segregación. price_list.manage se siembra aquí para que la migración 17 no
-- toque el catálogo de permisos.
insert into public.permissions (key, description, is_scoped) values
  ('product.manage',           'Crear y editar productos y categorías comerciales', false),
  ('product.tax_category.set', 'Asignar o cambiar la clasificación tributaria de un producto', false),
  ('price_list.manage',        'Crear y editar listas de precios y sus importes', false)
on conflict (key) do nothing;

-- La migración comprueba lo que sembró (la lección del noveno caso de S0.4:
-- consultar, no suponer).
do $$
begin
  if (select count(*) from public.permissions
       where key in ('product.manage', 'product.tax_category.set', 'price_list.manage')) <> 3 then
    raise exception 'LAD34: faltan permisos del catálogo de productos tras el seed';
  end if;
  if (select count(*) from public.product_tax_categories where status = 'active') <> 6 then
    raise exception 'LAD34: el seed de product_tax_categories no dejó las seis clasificaciones';
  end if;
end $$;
