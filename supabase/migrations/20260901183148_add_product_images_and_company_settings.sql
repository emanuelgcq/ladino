-- =============================================================================
-- Ladino — migración 28 · FASE C: fotos de producto y ajustes de empresa
--
-- Módulo: catálogo (rigor normal)  Spec: Fase C partes 7 y 14
-- Reversible: SÍ (columna nullable + tabla nueva; el bucket se puede vaciar).
-- Homologación: NO.
--
-- Dos piezas chicas que la experiencia de persona necesita:
--   · la FOTO del producto — la cuadrícula de Vender es visual o no es;
--   · company_settings — los tres interruptores del negocio (vende al mayor,
--     bloquear venta sin existencia, clasificación fiscal por defecto de los
--     productos creados por el alta simple) y el almacén por defecto.
-- =============================================================================

-- ── 1. La foto ──────────────────────────────────────────────────────────────
-- `image_path` es la RUTA en el bucket (company/product/…), no una URL: el
-- bucket es privado y las URLs firmadas caducan — persistir una URL firmada
-- sería persistir un secreto con fecha de muerte. La API firma al servir.
alter table public.products add column image_path text;
alter table public.products add constraint products_image_path_chk
  check (image_path is null
         or (image_path = btrim(image_path) and length(image_path) between 3 and 300));

-- El bucket, GUARDADO: en el stack local `db:start` excluye el servicio de
-- storage y el esquema podría no estar; sin esta guarda, `db:reset` entero
-- moriría por una feature que no es de base de datos. En el remoto existe.
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('product-images', 'product-images', false)
    on conflict (id) do nothing;
    -- Lectura para usuarios autenticados SOLO de las carpetas de sus
    -- empresas (primer segmento de la ruta = company_id). La ESCRITURA no se
    -- concede a nadie por policy: sube la API con su credencial de servicio,
    -- que valida tipo y tamaño antes.
    if not exists (select 1 from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname = 'product_images_select') then
      execute $pol$
        create policy product_images_select on storage.objects for select to authenticated
          using (bucket_id = 'product-images'
                 and split_part(name, '/', 1) in
                     (select id::text from public.companies
                       where id in (select platform.ladino_company_ids())))
      $pol$;
    end if;
  end if;
end $$;

-- ── 2. Ajustes de empresa ───────────────────────────────────────────────────
-- UNA fila por empresa, creada bajo demanda (upsert del caso de uso). Aquí
-- viven los interruptores que cambian la EXPERIENCIA, no la verdad fiscal:
-- la clasificación por defecto es la que el alta simple asigna a productos
-- nuevos, y el contador puede corregirla por producto en /admin.
create table public.company_settings (
  company_id uuid        primary key,
  tenant_id  uuid        not null,
  sells_wholesale            boolean not null default false,
  block_sale_without_stock   boolean not null default false,
  default_tax_category_code  text    not null default 'gravado_general',
  default_warehouse_id       uuid,

  created_by uuid,
  created_at timestamptz not null,
  version    integer     not null,

  constraint company_settings_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint company_settings_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint company_settings_tax_category_fk
    foreign key (default_tax_category_code) references public.product_tax_categories (code),
  constraint company_settings_warehouse_fk
    foreign key (company_id, default_warehouse_id)
    references public.warehouses (company_id, id)
);

alter table public.company_settings enable row level security;
alter table public.company_settings force row level security;
create policy company_settings_select on public.company_settings for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy company_settings_insert on public.company_settings for insert to authenticated
  with check (false);
create policy company_settings_update on public.company_settings for update to authenticated
  using (false);
create policy company_settings_delete on public.company_settings for delete to authenticated
  using (false);
create policy company_settings_api_select on public.company_settings for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_settings_api_insert on public.company_settings for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_settings_api_update on public.company_settings for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_settings_api_delete on public.company_settings for delete to ladino_api
  using (false);

revoke all on public.company_settings from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.company_settings to authenticated;
grant select, insert, update on public.company_settings to ladino_api;

create trigger company_settings_00_provenance
  before insert or update on public.company_settings
  for each row execute function platform.set_row_provenance();
create trigger company_settings_01_anchors
  before update on public.company_settings
  for each row execute function platform.assert_isolation_anchors_immutable();

-- Permisos de la fase (el gate de configuración del negocio).
insert into public.permissions (key, description, is_scoped) values
  ('company.settings.manage', 'Cambiar los ajustes del negocio (mayor, stock, defaults)', false)
on conflict (key) do nothing;

-- ── 3. Autochequeo ─────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.products where image_path is not null) <> 0 then
    raise exception 'migración 28: image_path debe nacer NULL en todo lo existente';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'company_settings'
         and c.relrowsecurity and c.relforcerowsecurity) <> 1 then
    raise exception 'migración 28: company_settings sin RLS forzada';
  end if;
end $$;
