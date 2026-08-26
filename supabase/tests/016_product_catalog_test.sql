-- =============================================================================
-- Ladino — pgTAP 16 · Catálogo de productos (migración 16)
--
-- Lo que este fichero ejerce, por encargo explícito:
--   · el ÚNICO case-insensitive del SKU con datos hostiles: unicode (Ñ/ñ),
--     espacios al borde, mayúsculas mezcladas — y su VARIANTE ROTA (sin el
--     índice, el duplicado entra: la aserción mide el índice, no la suerte);
--   · que la categoría COMERCIAL y la TRIBUTARIA no se pueden confundir:
--     difieren en tipo (uuid vs text) y en alcance (company vs global), y las
--     dos direcciones del intercambio REVIENTAN — más la aserción estructural
--     de que las formas siguen siendo distintas en el catálogo de columnas;
--   · aislamiento por las CUATRO vías como ladino_api y como authenticated,
--     kind congelado tras draft (LAD33), barcode único por company con NULLs
--     convivientes, y las prohibiciones ESCRITAS (delete para nadie).
-- =============================================================================

begin;
select plan(30);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0016-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0016-0000-4000-8000-00000000000a', 'Tenant 16-A'),
  ('aaaa0016-0000-4000-8000-00000000000b', 'Tenant 16-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0016-0000-4000-8000-0000000000a2', 'aaaa0016-0000-4000-8000-00000000000a', 'J-16-A1', 'Empresa 16-A1'),
  ('aaaa0016-0000-4000-8000-0000000000a3', 'aaaa0016-0000-4000-8000-00000000000a', 'J-16-A2', 'Empresa 16-A2'),
  ('aaaa0016-0000-4000-8000-0000000000b2', 'aaaa0016-0000-4000-8000-00000000000b', 'J-16-B1', 'Empresa 16-B1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0016-0000-4000-8000-0000000000e1', null, 'lector16', 'Lector', false);
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0016-0000-4000-8000-0000000000a4', 'aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0016-0000-4000-8000-0000000000a5', 'aaaa0016-0000-4000-8000-00000000000a',
   'aaaa0016-0000-4000-8000-0000000000a4', 'aaaa0016-0000-4000-8000-0000000000e1', null);
-- Categorías comerciales: una en A1 y una en B1 (para el FK cruzado).
insert into public.product_categories (id, tenant_id, company_id, name) values
  ('aaaa0016-0000-4000-8000-0000000000f1', 'aaaa0016-0000-4000-8000-00000000000a',
   'aaaa0016-0000-4000-8000-0000000000a2', 'Bebidas'),
  ('aaaa0016-0000-4000-8000-0000000000f2', 'aaaa0016-0000-4000-8000-00000000000b',
   'aaaa0016-0000-4000-8000-0000000000b2', 'Ferretería');
-- Un producto del tenant B, sembrado como postgres: nadie de A debe verlo.
insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code) values
  ('aaaa0016-0000-4000-8000-00000000000b', 'aaaa0016-0000-4000-8000-0000000000b2',
   'B-001', 'Producto de B', 'good', 'unidad', 'gravado_general');

-- ── Esquema y seeds ──────────────────────────────────────────────────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('units','currencies','product_tax_categories','product_categories','products')
      and c.relrowsecurity and c.relforcerowsecurity),
  5::bigint, 'las CINCO tablas nuevas tienen RLS habilitada y FORZADA');
-- La PROPIEDAD, no el recuento: que estén las cinco de D-4. Decía `= 5` y la
-- migración 20 lo puso en rojo al sembrar gramo, mililitro y minuto — un recuento
-- fijo se rompe cuando se AÑADE algo correcto, que es el mismo defecto que S0.4
-- corrigió en el test 004 («no comprueba la propiedad: pasa a rojo cuando se
-- añade una tabla, y seguiría en verde si a una le quitaran sus policies»).
select is(
  (select count(*) from public.units
    where code in ('unidad', 'kg', 'litro', 'hora', 'servicio')),
  5::bigint, 'seed de unidades: las cinco de D-4 siguen ahí');
select is((select count(*) from public.currencies), 2::bigint, 'seed de monedas: VES y USD (tabla, no CHECK: D-5)');
select is((select count(*) from public.product_tax_categories where status = 'active'),
  6::bigint, 'seed tributario: las seis clasificaciones, marcadas VALIDAR-TRIBUTARIO');
select is(
  (select count(*) from public.permissions
    where key in ('product.manage','product.tax_category.set','price_list.manage')),
  3::bigint, 'los tres permisos del maestro existen, con el mapeo tributario SEPARADO (D-10)');

-- ── Anti-confusión comercial/tributaria: estructural y ejercida ─────────────
select is(
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'tax_category_code'),
  'text', 'la referencia FISCAL es un código text global…');
select is(
  (select data_type from information_schema.columns
    where table_schema = 'public' and table_name = 'products' and column_name = 'category_id'),
  'uuid', '…y la COMERCIAL un uuid por company: formas incompatibles a propósito');

-- ── Como ladino_api, actor UA (tenant A) ─────────────────────────────────────
select set_config('ladino.actor_id', 'aaaa0016-0000-4000-8000-0000000000a1', true);
set local role ladino_api;

select lives_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, category_id, barcode)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'ÑOÑO-1', 'Café ñoño', 'good', 'unidad', 'gravado_general',
             'aaaa0016-0000-4000-8000-0000000000f1', '7591234567890') $$,
  'alta completa como ladino_api: uuidv7, provenance, FKs, todo el camino vivo');

-- El único case-insensitive, con datos hostiles:
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             '  ñoño-1  ', 'Espacios al borde', 'good', 'unidad', 'gravado_general') $$,
  '23514', null,
  'espacios al borde: RECHAZADOS por CHECK, no recortados en silencio (fallo ruidoso)');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'ñoño-1', 'Duplicado unicode', 'good', 'unidad', 'gravado_general') $$,
  '23505', null,
  'ÑOÑO-1 vs ñoño-1: el único es case-insensitive TAMBIÉN en unicode');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'ÑoÑo-1', 'Mayúsculas mezcladas', 'good', 'unidad', 'gravado_general') $$,
  '23505', null, 'mayúsculas mezcladas: mismo SKU, mismo rechazo');
select lives_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a3',
             'ñoño-1', 'Mismo SKU, OTRA company', 'good', 'unidad', 'gravado_general') $$,
  'el mismo SKU en OTRA company del tenant vive: la unicidad es por company (D-2)');

-- El intercambio de categorías, en las dos direcciones:
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'MIX-1', 'Uuid en el campo fiscal', 'good', 'unidad',
             'aaaa0016-0000-4000-8000-0000000000f1') $$,
  '23503', null,
  'CONFUSIÓN 1: una categoría comercial en el campo tributario muere en el FK');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, category_id)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'MIX-2', 'Código fiscal en el campo comercial', 'good', 'unidad',
             'gravado_general', 'gravado_general') $$,
  '22P02', null,
  'CONFUSIÓN 2: un código tributario en el campo comercial ni siquiera es un uuid');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, category_id)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'MIX-3', 'Categoría de otra company', 'good', 'unidad', 'gravado_general',
             'aaaa0016-0000-4000-8000-0000000000f2') $$,
  '23503', null,
  'la categoría comercial de OTRA company muere en el FK compuesto (company_id, id)');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'U-1', 'Unidad inexistente', 'good', 'docena', 'gravado_general') $$,
  '23503', null, 'una unidad fuera del catálogo muere en el FK');

-- Barcode: único por company, NULLs conviven.
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, barcode)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'BC-1', 'Barcode repetido', 'good', 'unidad', 'gravado_general', '7591234567890') $$,
  '23505', null, 'barcode duplicado en la company → 23505');
select lives_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'SIN-BC-1', 'Sin barcode 1', 'service', 'servicio', 'no_sujeto') $$,
  'varios productos sin barcode conviven (único PARCIAL, D-6)');

-- Kind congelado (D-8): mutable en draft, LAD33 después.
select lives_ok(
  $$ update public.products set kind = 'service'
      where sku = 'ÑOÑO-1' and company_id = 'aaaa0016-0000-4000-8000-0000000000a2' $$,
  'en draft, el tipo se puede corregir');
select lives_ok(
  $$ update public.products set kind = 'good', status = 'active'
      where sku = 'ÑOÑO-1' and company_id = 'aaaa0016-0000-4000-8000-0000000000a2' $$,
  'activar (y corregir el tipo en el MISMO update: el viejo aún era draft)');
select throws_ok(
  $$ update public.products set kind = 'service'
      where sku = 'ÑOÑO-1' and company_id = 'aaaa0016-0000-4000-8000-0000000000a2' $$,
  'LAD33', null, 'activo: cambiar el tipo muere con LAD33 — inventario colgará de él');

-- Aislamiento como ladino_api: lo de B no existe.
select is((select count(*) from public.products where sku = 'B-001'), 0::bigint,
  'el producto del tenant B: invisible para el actor de A');
select throws_ok(
  $$ delete from public.products
      where sku = 'SIN-BC-1' and company_id = 'aaaa0016-0000-4000-8000-0000000000a2' $$,
  '42501', null,
  'DELETE no existe ni para la API: un maestro se desactiva (privilegio ausente + policy escrita)');
select throws_ok(
  $$ update public.units set name = 'Hackeada' where code = 'unidad' $$,
  '42501', null, 'los maestros globales no se escriben desde la API: se pueblan por migración');
reset role;

-- Procedencia del alta hecha por la API:
select is(
  (select created_by from public.products
    where company_id = 'aaaa0016-0000-4000-8000-0000000000a2' and lower(sku) = 'ñoño-1'),
  'aaaa0016-0000-4000-8000-0000000000a1'::uuid,
  'created_by = el actor del GUC (provenance por withTransaction)');
select cmp_ok(
  (select version from public.products
    where company_id = 'aaaa0016-0000-4000-8000-0000000000a2' and lower(sku) = 'ñoño-1'),
  '>', 1, 'los updates incrementaron version (concurrencia optimista viva)');

-- ── Como authenticated (JWT de UA) ───────────────────────────────────────────
select set_config('ladino.actor_id', '', true);
select set_config('request.jwt.claims',
  '{"sub":"aaaa0016-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select cmp_ok((select count(*) from public.products), '>=', 3::bigint,
  'authenticated LEE el catálogo de sus companies (la web lista por la API, pero la policy de lectura existe)');
select is((select count(*) from public.products where sku = 'B-001'), 0::bigint,
  'y lo del tenant B tampoco existe para él');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'WEB-1', 'Colado por PostgREST', 'good', 'unidad', 'gravado_general') $$,
  '42501', null,
  'authenticated NO escribe maestros: los datos van por la API (prohibición escrita + sin grant)');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── VARIANTE ROTA del único case-insensitive ─────────────────────────────────
drop index public.products_company_sku_uidx;
select set_config('ladino.actor_id', 'aaaa0016-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code)
     values ('aaaa0016-0000-4000-8000-00000000000a', 'aaaa0016-0000-4000-8000-0000000000a2',
             'ñoño-1', 'ROTO: duplicado entra', 'good', 'unidad', 'gravado_general') $$,
  'ROTO: sin el índice, el duplicado unicode ENTRA — las aserciones de arriba miden el índice');
reset role;

select * from finish();
rollback;
