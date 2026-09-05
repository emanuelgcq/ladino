-- =============================================================================
-- Ladino — pgTAP 40 · Los cinco roles con nombre (migración 40, ADR-0048)
--
-- Lo que esto prueba, y con los EJEMPLOS DEL DUEÑO como asserts:
--   1. los cinco roles de sistema existen (tenant null, sin alcance fino);
--   2. owner cubre el catálogo ENTERO — cero permisos fuera: si una migración
--      futura crea un permiso y olvida concedérselo, esto se pone rojo;
--   3. el cajero NO ve el dinero agregado (treasury.read) ni registra
--      mercancía (inventory.move) ni gastos — pero sí vende, cobra y fía;
--   4. el encargado mueve mercancía y CIERRA caja (SoD: el cajero no
--      supervisa su propio cierre), sin saldos ni contabilidad;
--   5. el administrador opera todo pero NO asienta ni ve libros;
--   6. el contador asienta y exporta libros pero NO vende;
--   7. ladino_user_permissions devuelve el conjunto EXACTO del rol asignado.
-- =============================================================================

begin;
select plan(20);

-- ── 1. Los seis existen, de sistema y con alcance decidido ──────────────────
-- (Migración 41: el owner es PLANO para poder operar el nivel tenant — crear
-- empresas, gestionar miembros — y warehouse_ops carga los verbos acotados.)
select is(
  (select count(*) from public.roles
    where tenant_id is null
      and key in ('owner', 'cashier', 'store_manager', 'back_office', 'accountant',
                  'warehouse_ops')),
  6::bigint, 'los seis roles de sistema existen con tenant null');
select is(
  (select count(*) from public.roles
    where tenant_id is null and requires_scope
      and key in ('store_manager', 'back_office', 'warehouse_ops')),
  3::bigint,
  'los que llevan verbos de almacén son ACOTADOS: sin binding no conceden nada (LAD25)');

-- ── 2. El PAR owner+warehouse_ops cubre el catálogo entero (cero fuera) ──────
select is(
  (select count(*) from public.permissions p
    where not exists (select 1 from public.role_permissions rp
                       join public.roles r on r.id = rp.role_id
                      where r.key in ('owner', 'warehouse_ops')
                        and rp.permission_key = p.key)),
  0::bigint,
  'CERO permisos fuera del par del fundador: un permiso nuevo sin concederse pone esto en rojo');

-- ── 3. El cajero: los ejemplos del dueño, literales ─────────────────────────
create or replace function pg_temp.rol_tiene(p_rol text, p_perm text) returns boolean
language sql as $$
  select exists (select 1 from public.role_permissions rp
                  join public.roles r on r.id = rp.role_id
                 where r.key = p_rol and r.tenant_id is null
                   and rp.permission_key = p_perm)
$$;

select ok(pg_temp.rol_tiene('cashier', 'sales.invoice.issue'),
  'el cajero vende');
select ok(pg_temp.rol_tiene('cashier', 'sales.payment.register') and pg_temp.rol_tiene('cashier', 'ar.read'),
  'el cajero cobra y ve la deuda del cliente (fiar)');
select ok(not pg_temp.rol_tiene('cashier', 'treasury.read'),
  'EL EJEMPLO DEL DUEÑO: el cajero NO ve cuánto ganó el negocio (treasury.read)');
select ok(not pg_temp.rol_tiene('cashier', 'inventory.move'),
  'EL OTRO EJEMPLO: el cajero ve inventario (lectura de miembro) pero NO registra si llegó algo');
select ok(not pg_temp.rol_tiene('cashier', 'expense.read') and not pg_temp.rol_tiene('cashier', 'cash.close'),
  'ni gastos ni el cierre: el que cajea no supervisa su propio cierre (SoD)');

-- ── 4. El encargado ─────────────────────────────────────────────────────────
select ok(pg_temp.rol_tiene('store_manager', 'inventory.move')
      and pg_temp.rol_tiene('store_manager', 'purchase.invoice.register')
      and pg_temp.rol_tiene('store_manager', 'cash.close'),
  'el encargado registra mercancía (con o sin factura) y cierra la caja');
select ok(not pg_temp.rol_tiene('store_manager', 'treasury.read')
      and not pg_temp.rol_tiene('store_manager', 'accounting.entry.create')
      and not pg_temp.rol_tiene('store_manager', 'report.export'),
  'el encargado no ve saldos, ni asienta, ni saca reportes');

-- ── 5. El administrador ─────────────────────────────────────────────────────
select ok(pg_temp.rol_tiene('back_office', 'sales.invoice.annul')
      and pg_temp.rol_tiene('back_office', 'treasury.read')
      and pg_temp.rol_tiene('back_office', 'expense.register')
      and pg_temp.rol_tiene('back_office', 'accounting.read'),
  'el administrador anula, ve el dinero, registra gastos y LEE los KPIs contables');
select ok(not pg_temp.rol_tiene('back_office', 'accounting.entry.create')
      and not pg_temp.rol_tiene('back_office', 'fiscal_book.read')
      and not pg_temp.rol_tiene('back_office', 'supplier.bank_account.approve'),
  'pero NO asienta, NO ve libros y NO aprueba cuentas bancarias de proveedor (SoD)');

-- ── 6. El contador ──────────────────────────────────────────────────────────
select ok(pg_temp.rol_tiene('accountant', 'accounting.entry.create')
      and pg_temp.rol_tiene('accountant', 'fiscal_book.export')
      and pg_temp.rol_tiene('accountant', 'product.tax_category.set')
      and pg_temp.rol_tiene('accountant', 'retention.rules.manage'),
  'el contador asienta, exporta libros, clasifica tributariamente y carga reglas de retención');
select ok(not pg_temp.rol_tiene('accountant', 'sales.invoice.issue')
      and not pg_temp.rol_tiene('accountant', 'customer.manage')
      and not pg_temp.rol_tiene('accountant', 'treasury.read'),
  'el contador no vende, no toca maestros, no ve los saldos de tesorería');

-- ── 7. ladino_user_permissions: el conjunto exacto ──────────────────────────
insert into auth.users (id) values ('aaaa0040-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0040-0000-4000-8000-00000000000a', 'Tenant 40');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0040-0000-4000-8000-0000000000c1', 'aaaa0040-0000-4000-8000-00000000000a',
   'J-40-A', 'Empresa 40');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0040-0000-4000-8000-00000000d0b1', 'aaaa0040-0000-4000-8000-00000000000a',
   'aaaa0040-0000-4000-8000-0000000000a1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'aaaa0040-0000-4000-8000-00000000a0b1', 'aaaa0040-0000-4000-8000-00000000000a',
       'aaaa0040-0000-4000-8000-00000000d0b1', r.id, 'aaaa0040-0000-4000-8000-0000000000c1'
  from public.roles r where r.key = 'cashier' and r.tenant_id is null;

select is(
  (select count(*) from platform.ladino_user_permissions(
     'aaaa0040-0000-4000-8000-0000000000a1', 'aaaa0040-0000-4000-8000-0000000000c1')),
  5::bigint, 'un cajero recién asignado tiene EXACTAMENTE sus 5 permisos');
select ok(
  'sales.invoice.issue' in (select * from platform.ladino_user_permissions(
     'aaaa0040-0000-4000-8000-0000000000a1', 'aaaa0040-0000-4000-8000-0000000000c1')),
  'y la lista coincide con lo que ladino_user_has_permission respondería uno a uno');
select ok(
  platform.ladino_user_has_permission('aaaa0040-0000-4000-8000-0000000000a1',
    'sales.invoice.issue', 'aaaa0040-0000-4000-8000-0000000000c1'),
  'la resolución uno-a-uno concuerda: mismo mecanismo, dos formas de preguntar');
select ok(
  not platform.ladino_user_has_permission('aaaa0040-0000-4000-8000-0000000000a1',
    'treasury.read', 'aaaa0040-0000-4000-8000-0000000000c1'),
  'y el cajero de verdad NO puede preguntar por el dinero del negocio');

-- ── 8. Un rol acotado SIN binding no concede nada; CON binding, todo lo suyo ─
insert into auth.users (id) values ('aaaa0040-0000-4000-8000-0000000000a2');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0040-0000-4000-8000-00000000f0b1', 'aaaa0040-0000-4000-8000-00000000000a',
   'aaaa0040-0000-4000-8000-0000000000c1', 'W40', 'Principal');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0040-0000-4000-8000-00000000d0b2', 'aaaa0040-0000-4000-8000-00000000000a',
   'aaaa0040-0000-4000-8000-0000000000a2');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'aaaa0040-0000-4000-8000-00000000a0b2', 'aaaa0040-0000-4000-8000-00000000000a',
       'aaaa0040-0000-4000-8000-00000000d0b2', r.id, 'aaaa0040-0000-4000-8000-0000000000c1'
  from public.roles r where r.key = 'store_manager' and r.tenant_id is null;

select is(
  (select count(*) from platform.ladino_user_permissions(
     'aaaa0040-0000-4000-8000-0000000000a2', 'aaaa0040-0000-4000-8000-0000000000c1')),
  0::bigint,
  'un encargado SIN binding de almacén no concede NADA: el fallo por omisión es cerrado');

insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
values ('aaaa0040-0000-4000-8000-00000000000a', 'aaaa0040-0000-4000-8000-0000000000c1',
        'aaaa0040-0000-4000-8000-00000000a0b2', 'warehouse',
        'aaaa0040-0000-4000-8000-00000000f0b1');

select is(
  (select count(*) from platform.ladino_user_permissions(
     'aaaa0040-0000-4000-8000-0000000000a2', 'aaaa0040-0000-4000-8000-0000000000c1')),
  15::bigint,
  'con su almacén asignado, el encargado tiene EXACTAMENTE sus 15 permisos');

select * from finish();
rollback;
