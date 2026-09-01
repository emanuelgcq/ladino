-- =============================================================================
-- Ladino — pgTAP 28 · FOTOS DE PRODUCTO Y AJUSTES DE EMPRESA (migración 28)
--
-- Rigor normal: nada de dinero. Lo que sí se prueba es lo que costaría caro
-- descubrir en producción: que `image_path` no puede guardar URLs firmadas de
-- kilómetro y medio (persistir una URL firmada es persistir un secreto con
-- fecha de muerte), y que company_settings no lo escribe un navegador.
-- =============================================================================

begin;
select plan(6);

insert into public.tenants (id, name) values
  ('aaaa0028-0000-4000-8000-00000000000a', 'Tenant 28');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0028-0000-4000-8000-0000000000a2', 'aaaa0028-0000-4000-8000-00000000000a',
   'J-28-A', 'Empresa 28', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0028-0000-4000-8000-00000000d001', 'aaaa0028-0000-4000-8000-00000000000a',
   'aaaa0028-0000-4000-8000-0000000000a2', 'SKU-28', 'Producto 28', 'good', 'unidad',
   'gravado_general');

-- ── 1. La foto es una RUTA, no una URL ──────────────────────────────────────
select is(
  (select is_nullable from information_schema.columns
    where table_schema = 'public' and table_name = 'products'
      and column_name = 'image_path'),
  'YES', 'image_path existe y es NULLABLE: los productos viejos no tienen foto y no pasa nada');
select throws_ok($$
  update public.products set image_path = rpad('x', 301, 'x')
   where id = 'aaaa0028-0000-4000-8000-00000000d001'
$$, '23514', null,
  'una ruta de más de 300 caracteres se rechaza: eso no es una ruta de bucket, es una URL firmada');
select lives_ok($$
  update public.products
     set image_path = 'aaaa0028-0000-4000-8000-0000000000a2/d001/foto.webp'
   where id = 'aaaa0028-0000-4000-8000-00000000d001'
$$, 'y una ruta company/product/archivo entra sin drama');

-- ── 2. company_settings: RLS forzada y sin escritura de navegador ───────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'company_settings'
      and c.relrowsecurity and c.relforcerowsecurity),
  1::bigint, 'company_settings con RLS habilitada Y forzada');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'company_settings'
      and grantee in ('anon', 'authenticated', 'service_role', 'ladino_worker')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0::bigint,
  'los ajustes del negocio los escribe SOLO la API: un navegador no cambia el default fiscal de nadie');

-- ── 3. El default fiscal del alta simple es el declarado ────────────────────
insert into public.company_settings (company_id, tenant_id)
values ('aaaa0028-0000-4000-8000-0000000000a2', 'aaaa0028-0000-4000-8000-00000000000a');
select is(
  (select default_tax_category_code from public.company_settings
    where company_id = 'aaaa0028-0000-4000-8000-0000000000a2'),
  'gravado_general',
  'el default de clasificación es gravado_general: el alta simple clasifica gravado y el contador corrige por producto');

select * from finish();
rollback;
