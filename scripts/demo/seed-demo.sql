-- Semilla de DEMO para las capturas de Fase A. Datos de mentira evidente.
-- Idempotente a base de uuids fijos + on conflict.
\set ON_ERROR_STOP on

insert into public.tenants (id, name) values
  ('deade001-0000-4000-8000-000000000001', 'Grupo Demo Ladino')
on conflict (id) do nothing;

insert into public.companies (id, tenant_id, tax_id, legal_name, trade_name,
                              functional_currency_code, taxpayer_type_code, fiscal_address) values
  ('deade001-0000-4000-8000-0000000000c0', 'deade001-0000-4000-8000-000000000001',
   'J-31415926-5', 'Distribuidora El Ávila, C.A.', 'El Ávila', 'VES', 'ordinario',
   'Av. Francisco de Miranda, local PB-3, Chacao, Caracas (dato de demostración)')
on conflict (id) do nothing;

insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('deade001-0000-4000-8000-0000000000a1', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'PRINCIPAL', 'Almacén principal')
on conflict (id) do nothing;

-- El usuario demo ya existe en auth.users (signup por GoTrue). Su membresía:
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('deade001-0000-4000-8000-00000000ee01', null, 'demo_admin_fase_a', 'Administración demo', true)
on conflict (id) do nothing;

insert into public.role_permissions (role_id, permission_key)
select 'deade001-0000-4000-8000-00000000ee01', k from (values
  ('sales.quote.manage'), ('sales.order.manage'), ('sales.invoice.issue'),
  ('sales.invoice.annul'), ('sales.payment.register'), ('sales.return.manage'),
  ('sales.price_list.override'), ('ar.read'),
  ('inventory.move'), ('inventory.adjust'),
  ('fiscal.range.manage'), ('fx.rate.manage'),
  ('accounting.account.manage'), ('accounting.template.manage'),
  ('accounting.entry.create'), ('accounting.entry.post'),
  ('accounting.entry.reverse'), ('accounting.read'), ('accounting.period.close'),
  ('fiscal_book.read'), ('fiscal_book.export'),
  -- Compras (el flujo completo detrás de la compra simple de Fase C).
  ('supplier.manage'), ('purchase.order.manage'), ('purchase.receive'),
  ('purchase.invoice.register'), ('purchase.payment.register'), ('ap.read'),
  -- Fase C: el mundo de la persona.
  ('product.manage'), ('price_list.manage'), ('customer.manage'),
  ('treasury.read'), ('treasury.account.manage'), ('treasury.reassign'),
  ('expense.register'), ('expense.read'), ('cash.close'),
  ('company.settings.manage'),
  -- El asistente de /empezar: asignar régimen y aceptar la alícuota general.
  ('fiscal.regime.manage'), ('tax.rules.manage'), ('fiscal.contingency.manage')
) as t(k)
on conflict do nothing;

insert into public.memberships (id, tenant_id, user_id)
select 'deade001-0000-4000-8000-00000000ee02', 'deade001-0000-4000-8000-000000000001', u.id
  from auth.users u where u.email = 'demo@ladino.dev'
on conflict (id) do nothing;

insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('deade001-0000-4000-8000-00000000ee03', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-00000000ee02', 'deade001-0000-4000-8000-00000000ee01', null)
on conflict (id) do nothing;

insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
  ('deade001-0000-4000-8000-000000000001', 'deade001-0000-4000-8000-0000000000c0',
   'deade001-0000-4000-8000-00000000ee03', 'warehouse', 'deade001-0000-4000-8000-0000000000a1')
on conflict do nothing;

-- ADR-0048/49: el demo es EL DUEÑO de verdad — lleva los roles de SISTEMA del
-- fundador (owner plano + warehouse_ops con su binding), como los llevaría un
-- negocio fundado por /v1/onboarding. El rol propio de Fase A se conserva por
-- historia; estos dos son los que abren Usuarios y roles, Depósitos, Reportes
-- y todo lo que el catálogo gane mañana (owner cubre el catálogo entero).
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'deade001-0000-4000-8000-00000000ee04', 'deade001-0000-4000-8000-000000000001',
       'deade001-0000-4000-8000-00000000ee02', r.id, null
  from public.roles r where r.key = 'owner' and r.tenant_id is null
on conflict (id) do nothing;
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id)
select 'deade001-0000-4000-8000-00000000ee05', 'deade001-0000-4000-8000-000000000001',
       'deade001-0000-4000-8000-00000000ee02', r.id, null
  from public.roles r where r.key = 'warehouse_ops' and r.tenant_id is null
on conflict (id) do nothing;
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
  ('deade001-0000-4000-8000-000000000001', 'deade001-0000-4000-8000-0000000000c0',
   'deade001-0000-4000-8000-00000000ee05', 'warehouse', 'deade001-0000-4000-8000-0000000000a1')
on conflict do nothing;

-- Régimen fiscal vigente (formatos libres → exige número de control de rango).
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('deade001-0000-4000-8000-0000000000f1', 'deade001-0000-4000-8000-000000000001',
        'deade001-0000-4000-8000-0000000000c0', 'formatos_libres', current_date - 30)
on conflict (id) do nothing;

-- Clientes.
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('deade001-0000-4000-8000-0000000000b1', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'J-40111222-3', 'Panadería La Espiga, C.A.',
   'juridica', 'ordinario'),
  ('deade001-0000-4000-8000-0000000000b2', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'J-40555666-7', 'Inversiones Caroní, S.A.',
   'juridica', 'ordinario'),
  ('deade001-0000-4000-8000-0000000000b3', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'J-40888999-1', 'Comercial Los Andes, C.A.',
   'juridica', 'ordinario')
on conflict (id) do nothing;

-- El cliente de sistema de la venta de mostrador (migración 32). La empresa
-- demo se crea por SQL directo, así que el seed hace lo que haría createCompany.
insert into public.customers
  (id, tenant_id, company_id, legal_name, person_type_code, taxpayer_type_code, is_system)
select 'deade001-0000-4000-8000-0000000000b0', 'deade001-0000-4000-8000-000000000001',
       'deade001-0000-4000-8000-0000000000c0', 'Consumidor final', 'natural',
       'consumidor_final', true
 where not exists (select 1 from public.customers
                    where company_id = 'deade001-0000-4000-8000-0000000000c0' and is_system);

-- Productos.
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('deade001-0000-4000-8000-0000000000d1', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'HAR-1KG', 'Harina de maíz precocida 1kg', 'good',
   'active', 'unidad', 'gravado_general'),
  ('deade001-0000-4000-8000-0000000000d2', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'CAF-500', 'Café molido 500g', 'good', 'active',
   'unidad', 'gravado_general'),
  ('deade001-0000-4000-8000-0000000000d3', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'ARZ-1KG', 'Arroz blanco 1kg', 'good', 'active',
   'unidad', 'exento'),
  ('deade001-0000-4000-8000-0000000000d4', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'AZU-1KG', 'Azúcar refinada 1kg', 'good', 'active',
   'unidad', 'gravado_general'),
  ('deade001-0000-4000-8000-0000000000d5', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'ACE-1L', 'Aceite de girasol 1L', 'good', 'active',
   'unidad', 'gravado_general'),
  ('deade001-0000-4000-8000-0000000000d6', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'PAS-1KG', 'Pasta larga 1kg', 'good', 'active',
   'unidad', 'exento')
on conflict (id) do nothing;

-- Listas de precios. LA DECISIÓN GRABADA del proyecto (ADR-0046): la lista se
-- ancla SIEMPRE en USD; el recibo o la factura sale en Bs con la tasa BCV del
-- día, y la pantalla enseña las dos monedas. La caja usa «Detal USD»
-- (predeterminada vía company_settings, abajo). No hay lista en Bs: poner
-- precios en Bs es remarcar a mano lo que la tasa mueve sola.
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'Mayorista USD', 'USD'),
  ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-000000000001',
   'deade001-0000-4000-8000-0000000000c0', 'Detal USD', 'USD')
on conflict (id) do nothing;

insert into public.company_settings (company_id, tenant_id, default_price_list_id)
values ('deade001-0000-4000-8000-0000000000c0', 'deade001-0000-4000-8000-000000000001',
        'deade001-0000-4000-8000-0000000000e3')
on conflict (company_id) do update set
  default_price_list_id = coalesce(public.company_settings.default_price_list_id,
                                   excluded.default_price_list_id);

insert into public.price_list_items (tenant_id, company_id, price_list_id, product_id, amount, effective_from)
select 'deade001-0000-4000-8000-000000000001', 'deade001-0000-4000-8000-0000000000c0',
       l, p, a::numeric, (current_date - 20)::timestamptz
  from (values
    ('deade001-0000-4000-8000-0000000000e2'::uuid, 'deade001-0000-4000-8000-0000000000d1'::uuid, '0.75000000'),
    ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-0000000000d2', '1.40000000'),
    ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-0000000000d3', '0.55000000'),
    ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-0000000000d4', '0.65000000'),
    ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-0000000000d5', '1.25000000'),
    ('deade001-0000-4000-8000-0000000000e2', 'deade001-0000-4000-8000-0000000000d6', '0.50000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d1', '0.75000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d2', '1.40000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d3', '0.55000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d4', '0.65000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d5', '1.25000000'),
    ('deade001-0000-4000-8000-0000000000e3', 'deade001-0000-4000-8000-0000000000d6', '0.50000000')
  ) as t(l, p, a)
 where not exists (select 1 from public.price_list_items i
                    where i.price_list_id = t.l and i.product_id = t.p);

update public.customers set default_price_list_id = 'deade001-0000-4000-8000-0000000000e3'
 where id in ('deade001-0000-4000-8000-0000000000b1', 'deade001-0000-4000-8000-0000000000b2')
   and default_price_list_id is null;
update public.customers set default_price_list_id = 'deade001-0000-4000-8000-0000000000e2'
 where id = 'deade001-0000-4000-8000-0000000000b3' and default_price_list_id is null;

-- Reglas de IVA (globales, guardadas — mismo criterio que los E2E).
insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                              rate, effective_from, legal_source, priority, transaction_type)
select 'VE', 'iva', 'ordinario', c, r::numeric, current_date - 30,
       'Carga DEMO — VALIDAR-SENIAT antes de producción.', 10, tt
  from (values ('gravado_general', '0.16', 'sale'), ('exento', '0', 'sale'),
               ('gravado_general', '0.16', 'purchase'), ('exento', '0', 'purchase')) as t(c, r, tt)
 where not exists (select 1 from public.tax_rules
                    where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type = 'ordinario'
                      and product_tax_category = t.c and transaction_type = t.tt);

-- Y la regla GENERAL de ventas (taxpayer_type NULL, prioridad menor): es la que
-- aplica al Consumidor final y a cualquier contraparte sin regla específica.
-- resolve_tax elige la específica cuando existe (prioridad 10 > 5).
insert into public.tax_rules (jurisdiction, tax_code, taxpayer_type, product_tax_category,
                              rate, effective_from, legal_source, priority, transaction_type)
select 'VE', 'iva', null, c, r::numeric, current_date - 30,
       'Carga DEMO — VALIDAR-SENIAT antes de producción.', 5, 'sale'
  from (values ('gravado_general', '0.16'), ('exento', '0')) as t(c, r)
 where not exists (select 1 from public.tax_rules
                    where jurisdiction = 'VE' and tax_code = 'iva' and taxpayer_type is null
                      and product_tax_category = t.c and transaction_type = 'sale');

-- Existencias: 500 de cada producto, con su costo.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at, reference)
select 'deade001-0000-4000-8000-000000000001', 'deade001-0000-4000-8000-0000000000c0',
       'deade001-0000-4000-8000-0000000000a1', p, 'entrada', 500, c::numeric, 'VES', 1,
       c::numeric, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', now(),
       'seed-demo-' || sku
  from (values
    ('deade001-0000-4000-8000-0000000000d1'::uuid, '26000', 'HAR'),
    ('deade001-0000-4000-8000-0000000000d2', '48000', 'CAF'),
    ('deade001-0000-4000-8000-0000000000d3', '18500', 'ARZ'),
    ('deade001-0000-4000-8000-0000000000d4', '23000', 'AZU'),
    ('deade001-0000-4000-8000-0000000000d5', '44500', 'ACE'),
    ('deade001-0000-4000-8000-0000000000d6', '16500', 'PAS')
  ) as t(p, c, sku)
 where not exists (select 1 from public.inventory_moves m
                    where m.reference = 'seed-demo-' || t.sku);

select 'SEED SQL OK';
