-- =============================================================================
-- Ladino — pgTAP 19 · Inventario (migración 19, ADR-0034 — RIGOR MÁXIMO: dinero
-- en una tabla append-only)
--
-- Lo que el encargo pide, ejercido explícitamente:
--   1. un movimiento no se edita ni se borra por NINGUNA vía, incluida
--      service_role y TRUNCATE (las dos capas de ADR-0006, distinguibles);
--   2. MATERIALIZADO == RECALCULADO desde cero, con VARIANTE ROTA: desactivado
--      el trigger, un movimiento entra y las existencias divergen;
--   3. negativo en las tres direcciones: sin bandera, con bandera y sin permiso,
--      con las dos;
--   4. costeo: secuencia de entradas a precios distintos contra un valor
--      CALCULADO A MANO EN EL TEST; datos hostiles: importe al límite de
--      numeric(24,8) y una entrada en moneda extranjera con los siete campos;
--   5. transferencia atómica: no existe instante con el stock en ningún lado ni
--      en los dos — una pata sola NO puede confirmarse;
--   6. aislamiento con un usuario en DOS tenants;
--   7. alcance por almacén: un almacenista con binding a un almacén no mueve otro.
-- =============================================================================

begin;
select plan(60);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0019-0000-4000-8000-0000000000a1'),   -- UA: opera en A (los dos almacenes)
  ('aaaa0019-0000-4000-8000-0000000000b1'),   -- UB: almacenista, binding SOLO a W1
  ('aaaa0019-0000-4000-8000-0000000000c1');   -- UC: membership en A **y** en B
insert into public.tenants (id, name) values
  ('aaaa0019-0000-4000-8000-00000000000a', 'Tenant 19-A'),
  ('aaaa0019-0000-4000-8000-00000000000b', 'Tenant 19-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000000a', 'J-19-A1', 'Empresa 19-A1'),
  ('aaaa0019-0000-4000-8000-0000000000b2', 'aaaa0019-0000-4000-8000-00000000000b', 'J-19-B1', 'Empresa 19-B1');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'W1', 'Principal'),
  ('aaaa0019-0000-4000-8000-00000000ff02', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'W2', 'Sucursal'),
  ('aaaa0019-0000-4000-8000-00000000ff09', 'aaaa0019-0000-4000-8000-00000000000b',
   'aaaa0019-0000-4000-8000-0000000000b2', 'WB', 'Almacén de B');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0019-0000-4000-8000-0000000000d1', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'INV-1', 'Producto costeado', 'good', 'active', 'unidad', 'gravado_general'),
  ('aaaa0019-0000-4000-8000-0000000000d2', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'INV-LIM', 'Producto al límite', 'good', 'active', 'unidad', 'gravado_general'),
  ('aaaa0019-0000-4000-8000-0000000000d3', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'INV-SRV', 'Un servicio', 'service', 'active', 'servicio', 'gravado_general'),
  ('aaaa0019-0000-4000-8000-0000000000d4', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a2', 'INV-SER', 'Con seriales', 'good', 'active', 'unidad', 'gravado_general'),
  ('aaaa0019-0000-4000-8000-0000000000d9', 'aaaa0019-0000-4000-8000-00000000000b',
   'aaaa0019-0000-4000-8000-0000000000b2', 'INV-B', 'Producto de B', 'good', 'active', 'unidad', 'gravado_general');
update public.products set tracks_serials = true where id = 'aaaa0019-0000-4000-8000-0000000000d4';

-- Roles. LOS DOS que mueven existencias declaran requires_scope = true, y no es
-- decoración del test: el invariante LAD25 de ADR-0025 §4 RECHAZA que un rol
-- company-wide tenga un permiso acotado, y los cuatro de inventario lo son. Lo
-- descubrió este mismo test al forzar las constraints diferidas. Consecuencia real
-- para el producto: no existe un «jefe de inventario» que opere toda la empresa por
-- omisión — opera los almacenes que tenga enlazados, uno por uno.
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0019-0000-4000-8000-0000000000e1', null, 'inv19_jefe', 'Jefe de inventario', true),
  ('aaaa0019-0000-4000-8000-0000000000e2', null, 'inv19_almacenista', 'Almacenista', true),
  ('aaaa0019-0000-4000-8000-0000000000e3', null, 'inv19_lector', 'Lector', false);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0019-0000-4000-8000-0000000000e1', 'inventory.move'),
  ('aaaa0019-0000-4000-8000-0000000000e1', 'inventory.adjust'),
  ('aaaa0019-0000-4000-8000-0000000000e1', 'inventory.transfer'),
  ('aaaa0019-0000-4000-8000-0000000000e2', 'inventory.move'),
  ('aaaa0019-0000-4000-8000-0000000000e3', 'warehouse.read');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0019-0000-4000-8000-0000000000a3', 'aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a1'),
  ('aaaa0019-0000-4000-8000-0000000000b3', 'aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000b1'),
  -- UC pertenece a LOS DOS tenants: el aislamiento se prueba con quien sí existe en ambos.
  ('aaaa0019-0000-4000-8000-0000000000c3', 'aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000c1'),
  ('aaaa0019-0000-4000-8000-0000000000c4', 'aaaa0019-0000-4000-8000-00000000000b', 'aaaa0019-0000-4000-8000-0000000000c1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0019-0000-4000-8000-0000000000a4', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000a3', 'aaaa0019-0000-4000-8000-0000000000e1', null),
  ('aaaa0019-0000-4000-8000-0000000000b4', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000b3', 'aaaa0019-0000-4000-8000-0000000000e2', null),
  ('aaaa0019-0000-4000-8000-0000000000c5', 'aaaa0019-0000-4000-8000-00000000000a',
   'aaaa0019-0000-4000-8000-0000000000c3', 'aaaa0019-0000-4000-8000-0000000000e3', null),
  ('aaaa0019-0000-4000-8000-0000000000c6', 'aaaa0019-0000-4000-8000-00000000000b',
   'aaaa0019-0000-4000-8000-0000000000c4', 'aaaa0019-0000-4000-8000-0000000000e3', null);
-- LOS BINDINGS: el jefe alcanza LOS DOS almacenes; el almacenista, SOLO W1.
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
  ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
   'aaaa0019-0000-4000-8000-0000000000a4', 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff01'),
  ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
   'aaaa0019-0000-4000-8000-0000000000a4', 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff02'),
  ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
   'aaaa0019-0000-4000-8000-0000000000b4', 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff01');

-- ── 1. Estructural ───────────────────────────────────────────────────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('inventory_settings','lots','inventory_moves','stock_balances')
      and c.relrowsecurity and c.relforcerowsecurity),
  4::bigint, 'las cuatro tablas nuevas tienen RLS habilitada y FORZADA');
select is(
  (select count(*) from public.permissions
    where key in ('inventory.move','inventory.adjust','inventory.transfer','inventory.negative')
      and is_scoped),
  4::bigint, 'los cuatro permisos de inventario existen y son ACOTADOS (is_scoped)');
-- Capa 1 del append-only: el privilegio no existe para NADIE, service_role incluido.
-- Sobre los roles de APLICACIÓN: el dueño de la tabla (postgres) tiene los
-- privilegios por serlo, y eso no se puede revocar — es justo por lo que la
-- inmutabilidad no puede ser solo privilegio y hay un trigger (capa 2, abajo).
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'inventory_moves'
      and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
      and privilege_type in ('UPDATE','DELETE','TRUNCATE')),
  0::bigint,
  'NINGÚN rol de aplicación tiene UPDATE/DELETE/TRUNCATE sobre inventory_moves por '
  'GRANT: tampoco service_role');

-- ── 2. Como ladino_api, actor UA — el costeo A MANO ─────────────────────────
select set_config('ladino.actor_id', 'aaaa0019-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'test-019', true);
set local role ladino_api;

-- Entrada 1: 10 unidades a 100,00 = 1 000,00. Promedio = 100,00000000.
select lives_ok(
  $$ insert into public.inventory_moves
       (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-0000000000f1', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
             'aaaa0019-0000-4000-8000-0000000000d1', 'entrada', 10,
             1000, 'VES', 1, 1000, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 100, 10, 1000, now(), 'CMP-1') $$,
  'entrada 1: 10 @ 100,00 — el trigger acepta los saldos declarados porque coinciden');

-- Entrada 2: 5 unidades a 130,00 = 650,00. Valor 1 650,00 / 15 = 110,00000000.
select lives_ok(
  $$ insert into public.inventory_moves
       (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-0000000000f2', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
             'aaaa0019-0000-4000-8000-0000000000d1', 'entrada', 5,
             650, 'VES', 1, 650, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 110, 15, 1650, now(), 'CMP-2') $$,
  'entrada 2: 5 @ 130,00 — promedio recalculado en la entrada');
select is(
  (select last_unit_cost::text from public.stock_balances
    where warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '110.00000000',
  'PROMEDIO PONDERADO A MANO: (1000 + 650) / (10 + 5) = 110,00000000 exacto');

-- Un promedio EQUIVOCADO muere: es el oráculo del esquema, no una anotación.
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 5, 650, 'VES', 1, 650, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 999.99, now()) $$,
  'LAD41', null,
  'un costo unitario resultante que NO es valor/cantidad muere: LAD41 (el oráculo del esquema)');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, quantity_after, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 5, 650, 'VES', 1, 650, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 110, 999, now()) $$,
  'LAD41', null, 'un saldo declarado que no cuadra con el calculado también: LAD41');

-- Salida de 3 al promedio: 3 × 110 = 330,00. Valor 1 320,00 / 12 = 110 (intacto).
select lives_ok(
  $$ insert into public.inventory_moves
       (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-0000000000f3', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
             'aaaa0019-0000-4000-8000-0000000000d1', 'salida', -3,
             -330, 'VES', 1, -330, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 110, now(), 'VTA-1') $$,
  'salida de 3 al promedio: 3 × 110 = 330,00');
select is(
  (select quantity::text || ' / ' || value::text from public.stock_balances
    where warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '12.00000000 / 1320.00000000',
  'A MANO: quedan 12 unidades por 1 320,00 — la salida no cambió el promedio');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'salida', -3, -300, 'VES', 1, -300, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 110, now()) $$,
  'LAD41', null,
  'una salida valorada a 300 en vez de 330 muere: LAD41 — sacar barato es inflar el margen');

-- Entrada en MONEDA EXTRANJERA: 7 unidades a 3,00 USD con tasa 41,1522663366667
-- → 21,00 USD × tasa = 864,19759... El funcional se declara y los siete campos viajan.
-- Valor 2 184,19752307 / 19 = 114,957764372105… → HALF_UP a 8 → 114,95776437.
select lives_ok(
  $$ insert into public.inventory_moves
       (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-0000000000f4', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
             'aaaa0019-0000-4000-8000-0000000000d1', 'entrada', 7,
             21.00000000, 'USD', 41.15226301, 864.19752307, 'VES',
             'BCV:tasa-oficial', '2026-08-26T10:00:00Z',
             'inventory:cost:8:HALF_UP', 114.95776437, now(), 'IMP-1') $$,
  'entrada en USD: los SIETE campos de ADR-0020 viajan y el funcional es el que cuesta');
select is(
  (select last_unit_cost::text from public.stock_balances
    where warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '114.95776437',
  'A MANO: 2 184,19752307 / 19 = 114,957764372105… → HALF_UP a 8 decimales');
select is(
  (select rate_source || ' @ ' || fx_rate::text from public.inventory_moves
    where id = 'aaaa0019-0000-4000-8000-0000000000f4'),
  'BCV:tasa-oficial @ 41.15226301',
  'la fuente de la tasa y la tasa quedan EN EL MOVIMIENTO: reproducible años después');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 1, 1, 'VES', 2, 2, 'VES', 'inventada', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  '23514', null,
  'misma moneda con tasa 2: CHECK — la identidad no es una conversión (ADR-0020)');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 1, 1, 'USD', 41.15, 41.15, 'VES', '   ', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  '23514', null,
  'una conversión SIN fuente de tasa no se persiste: CHECK (regla 8, ADR-0020)');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 1, 1, 'VES', 1, 1, 'USD', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  'LAD38', null,
  'un movimiento en moneda funcional distinta a la de la empresa muere: el costeo va en funcional');

-- Datos hostiles: el importe al LÍMITE de numeric(24,8) entra y sale entero.
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d2',
             'entrada', 1, 9999999999999999.99999999, 'VES', 1,
             9999999999999999.99999999, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 9999999999999999.99999999, now(), 'LIM-1') $$,
  'el importe MÁXIMO representable en numeric(24,8) entra');
select is(
  (select value::text from public.stock_balances
    where product_id = 'aaaa0019-0000-4000-8000-0000000000d2'),
  '9999999999999999.99999999',
  'y sale con los 24 dígitos intactos: sin pérdida en el kardex materializado');

-- ── 3. Materializado == recalculado (criterio «kardex reproduce balance») ────
select is(
  (select count(*) from platform.stock_reconciliation('aaaa0019-0000-4000-8000-0000000000a2')),
  0::bigint,
  'CERO divergencias entre el kardex materializado y el recalculado desde los movimientos');
select is(
  (select b.quantity::text || ' / ' || b.value::text
     from public.stock_balances b
    where b.warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and b.product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  (select r.quantity::text || ' / ' || r.value::text
     from platform.recompute_stock('aaaa0019-0000-4000-8000-0000000000a2',
                                   'aaaa0019-0000-4000-8000-00000000ff01',
                                   'aaaa0019-0000-4000-8000-0000000000d1') r),
  'la posición del producto costeado: materializado == recompute_stock(), campo a campo');

-- ── 4. Producto: qué NO puede moverse ───────────────────────────────────────
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d3',
             'entrada', 1, 10, 'VES', 1, 10, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  'LAD38', null, 'un SERVICIO no tiene existencias: LAD38');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d4',
             'entrada', 1, 10, 'VES', 1, 10, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  'LAD38', null,
  'un producto que declara SERIALES no se mueve: el rastreo no existe todavía y se dice, '
  'no se ignora (ausencia de mecanismo no es prohibición)');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff09', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 1, 10, 'VES', 1, 10, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  '23503', null,
  'un almacén de OTRA company muere en el FK compuesto, con el MISMO cuerpo que un '
  '404 (23503 → NOT_FOUND): invisible e inexistente son indistinguibles');
-- Un ajuste SIN motivo no existe; con motivo, sí.
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'ajuste', 1, 114.95776437, 'VES', 1, 114.95776437, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  '23514', null, 'un AJUSTE sin motivo es un CHECK, no una convención');

-- ── 5. Negativo: las tres direcciones ───────────────────────────────────────
-- 5a. Sin bandera: rechazado. Quedan 19 unidades del producto costeado.
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'salida', -20, -2299.15528740, 'VES', 1, -2299.15528740, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  'LAD39', null,
  'SIN allow_negative_stock la salida que deja negativo muere: LAD39, nunca negativo silencioso');
reset role;

-- 5b. Con la bandera pero SIN el permiso acotado del actor: sigue muriendo.
insert into public.inventory_settings (company_id, tenant_id, allow_negative_stock)
  values ('aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000000a', true);
set local role ladino_api;
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'salida', -20, -2299.15528740, 'VES', 1, -2299.15528740, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  'LAD39', null,
  'CON la bandera pero sin inventory.negative del actor sobre ESE almacén: LAD39 igualmente');
reset role;

-- 5c. Con las dos: entra, y el costeo del tramo negativo es el del encargo.
insert into public.role_permissions (role_id, permission_key)
  values ('aaaa0019-0000-4000-8000-0000000000e1', 'inventory.negative');
select set_config('ladino.actor_id', 'aaaa0019-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
-- 19 unidades por 2 184,19752307; salen 20: todo el valor + 1 × 114,95776437.
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'salida', -20, -2299.15528744, 'VES', 1, -2299.15528744, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 114.95776437, now(), 'VTA-NEG') $$,
  'con bandera Y permiso: la salida a negativo entra (y solo entonces)');
select is(
  (select quantity::text || ' / ' || value::text || ' / ' || last_unit_cost::text
     from public.stock_balances
    where warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '-1.00000000 / -114.95776437 / 114.95776437',
  'A MANO: −1 unidad por −114,95776437 (todo el valor + 1 × promedio) y el promedio ARRASTRADO, '
  'nunca negativo');
select is(
  (select count(*) from platform.stock_reconciliation('aaaa0019-0000-4000-8000-0000000000a2')),
  0::bigint, 'y con la posición en negativo el materializado SIGUE cuadrando con el kardex');

-- ── 6. Transferencia atómica ────────────────────────────────────────────────
-- Primero repongo W1 para tener qué transferir: +11 a 114,95776437 = 1 264,53540807.
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 11, 1264.53540807, 'VES', 1, 1264.53540807, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 114.95776437, now(), 'CMP-3') $$,
  'reposición de 11 unidades para poder transferir');

-- Las DOS patas, en la misma transacción y con referencia mutua.
select lives_ok(
  $$ insert into public.inventory_moves
       (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, transfer_id, counterpart_move_id)
     values ('aaaa0019-0000-4000-8000-00000000ee01', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
             'aaaa0019-0000-4000-8000-0000000000d1', 'transferencia_out', -4,
             -459.83105748, 'VES', 1, -459.83105748, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 114.95776437, now(),
             'aaaa0019-0000-4000-8000-00000000ee00', 'aaaa0019-0000-4000-8000-00000000ee02'),
            ('aaaa0019-0000-4000-8000-00000000ee02', 'aaaa0019-0000-4000-8000-00000000000a',
             'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff02',
             'aaaa0019-0000-4000-8000-0000000000d1', 'transferencia_in', 4,
             459.83105748, 'VES', 1, 459.83105748, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 114.95776437, now(),
             'aaaa0019-0000-4000-8000-00000000ee00', 'aaaa0019-0000-4000-8000-00000000ee01') $$,
  'transferencia de 4 unidades W1 → W2: las dos patas, mismo transfer_id, referencia mutua');
select is(
  (select b.quantity::text from public.stock_balances b
    where b.warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff02'
      and b.product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '4.00000000', 'el destino recibió las 4 unidades…');
select is(
  (select b.quantity::text from public.stock_balances b
    where b.warehouse_id = 'aaaa0019-0000-4000-8000-00000000ff01'
      and b.product_id = 'aaaa0019-0000-4000-8000-0000000000d1'),
  '6.00000000', '…y el origen quedó con 6: 10 − 4, sin instante intermedio');
select is(
  (select sum(m.quantity)::text || ' / ' || sum(m.functional_amount)::text
     from public.inventory_moves m
    where m.transfer_id = 'aaaa0019-0000-4000-8000-00000000ee00'),
  '0.00000000 / 0.00000000',
  'la transferencia suma CERO en cantidad y en valor: el stock no se crea ni se destruye');
select is(
  (select count(*) from platform.stock_reconciliation('aaaa0019-0000-4000-8000-0000000000a2')),
  0::bigint, 'y tras la transferencia el materializado sigue cuadrando');
reset role;

-- El cuadre diferido se fuerza AQUÍ: es el instante del COMMIT, y una transferencia
-- completa lo pasa. Además vacía la cola de eventos diferidos — sin esto, cualquier
-- TRUNCATE o ALTER TABLE posterior muere con 55006 «pending trigger events» y el
-- diagnóstico se confunde con el de la defensa que se quería probar.
select lives_ok(
  $$ set constraints public.inventory_moves_transfer_balanced immediate $$,
  'la transferencia COMPLETA pasa el cuadre en el instante del commit');
-- Y se devuelve a DIFERIDO: SET CONSTRAINTS dura toda la transacción, y en modo
-- inmediato la pata sola de abajo moriría en su propio INSERT — probando otra cosa
-- (que el trigger existe) en vez de lo que dice probar (que al cerrar no cuadra).
set constraints public.inventory_moves_transfer_balanced deferred;

-- UNA PATA SOLA NO PUEDE CONFIRMARSE. El trigger es DIFERIDO: el fallo llega al
-- COMMIT, y dentro de un test no hay COMMIT que provocar. Se fuerza el mismo
-- instante con SET CONSTRAINTS ... IMMEDIATE, que es exactamente lo que Postgres
-- hace al cerrar la transacción, dentro de un savepoint que se deshace después
-- (si no, el evento diferido queda pendiente y tumba lo que venga detrás — es lo
-- que pasó al escribir este test con `begin/commit` embebido).
savepoint una_pata_sola;
select set_config('ladino.actor_id', 'aaaa0019-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
insert into public.inventory_moves
  (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp,
   rounding_policy_id, unit_cost, occurred_at, transfer_id, counterpart_move_id)
values ('aaaa0019-0000-4000-8000-00000000ee03', 'aaaa0019-0000-4000-8000-00000000000a',
        'aaaa0019-0000-4000-8000-0000000000a2', 'aaaa0019-0000-4000-8000-00000000ff01',
        'aaaa0019-0000-4000-8000-0000000000d1', 'transferencia_out', -1,
        -114.95776437, 'VES', 1, -114.95776437, 'VES', 'identidad', now(),
        -- La contraparte apunta a un movimiento REAL que no es de esta transferencia:
        -- así el CHECK de forma y el FK quedan satisfechos y lo ÚNICO que puede
        -- fallar es el cuadre de las dos patas.
        'inventory:cost:8:HALF_UP', 114.95776437, now(),
        'aaaa0019-0000-4000-8000-00000000ee09', 'aaaa0019-0000-4000-8000-0000000000f1');
reset role;
select throws_ok(
  $$ set constraints public.inventory_moves_transfer_balanced immediate $$,
  'LAD40', null,
  'UNA PATA SOLA no puede confirmarse: LAD40 en el instante del COMMIT — no existe '
  'momento con el stock en ningún lado ni en los dos');
rollback to savepoint una_pata_sola;
select is(
  (select count(*) from public.inventory_moves
    where transfer_id = 'aaaa0019-0000-4000-8000-00000000ee09'),
  0::bigint, 'y la pata huérfana no queda: cero filas de esa transferencia en el kardex');

-- ── 7. Alcance por almacén: el almacenista con binding solo a W1 ────────────
select is(
  platform.ladino_user_has_scope('aaaa0019-0000-4000-8000-0000000000b1', 'inventory.move',
                                 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff01'),
  true, 'el almacenista SÍ opera el almacén al que está enlazado (W1)');
select is(
  platform.ladino_user_has_scope('aaaa0019-0000-4000-8000-0000000000b1', 'inventory.move',
                                 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff02'),
  false,
  'y NO opera W2: el binding acota, y sin él un rol requires_scope no opera nada (ADR-0025 §4)');
select is(
  platform.ladino_user_has_scope('aaaa0019-0000-4000-8000-0000000000a1', 'inventory.move',
                                 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff02'),
  true,
  'el jefe opera los dos almacenes porque tiene binding a los dos — NO por ser '
  '«company-wide»: con permisos acotados eso no existe (LAD25)');
select is(
  platform.ladino_user_has_scope('aaaa0019-0000-4000-8000-0000000000b1', 'inventory.negative',
                                 'warehouse', 'aaaa0019-0000-4000-8000-00000000ff01'),
  false,
  'el almacenista NO tiene inventory.negative ni en su propio almacén: permisos separados');

-- ── 8. Aislamiento con un usuario en DOS tenants ───────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaa0019-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*) from public.inventory_moves
    where company_id = 'aaaa0019-0000-4000-8000-0000000000a2'),
  (select count(*) from public.inventory_moves),
  'UC pertenece a los dos tenants y ve SOLO los movimientos de la company de A: '
  'no hay filas de B que se cuelen');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 1, 10, 'VES', 1, 10, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now()) $$,
  '42501', null, 'authenticated NO escribe el kardex: los movimientos van por la API');
select throws_ok(
  $$ update public.stock_balances set quantity = 999 $$,
  '42501', null, 'ni toca las existencias materializadas: las escribe el trigger');
reset role;
select set_config('request.jwt.claims', '', true);

-- ── 9. APPEND-ONLY: las dos capas, distinguibles ───────────────────────────
-- Antes de nada, la cola de eventos diferidos se vacía y se comprueba que pasa.
-- El otro emisor es el FK DIFERIDO de la contraparte (la referencia mutua de una
-- transferencia no se puede declarar de otra forma): encola un evento por cada
-- inserción, y con la cola llena un TRUNCATE devuelve 55006 en vez de LAD06 —
-- el mismo fallo diría «no puedo» por el motivo equivocado.
select lives_ok(
  $$ set constraints all immediate $$,
  'la cola de eventos diferidos se vacía sin un solo fallo: los FK mutuos de la '
  'transferencia resuelven');

-- Capa 1 (privilegio) como la API.
set local role ladino_api;
select throws_ok(
  $$ update public.inventory_moves set quantity = 999
      where id = 'aaaa0019-0000-4000-8000-0000000000f1' $$,
  '42501', null, 'UPDATE como la API: 42501 — ni llega al trigger (capa de privilegio)');
select throws_ok(
  $$ delete from public.inventory_moves where id = 'aaaa0019-0000-4000-8000-0000000000f1' $$,
  '42501', null, 'DELETE como la API: 42501');
reset role;

-- Capa 2 (trigger) como SERVICE_ROLE, que tiene BYPASSRLS: se le CONCEDE el
-- privilegio a propósito dentro de la transacción de prueba para poder llegar al
-- trigger. Sin esto, «falla» sería indistinguible de «falla por el otro motivo».
-- El SELECT va en el mismo GRANT a propósito: sin él el WHERE de un UPDATE muere
-- con el MISMO 42501 de la capa 1, y el test parecería probar la capa 2 mientras
-- prueba otra vez la primera. (Dos caminos, un solo código: la lección de S0.5.)
grant select, update, delete, truncate on public.inventory_moves to service_role;
set local role service_role;
select throws_ok(
  $$ update public.inventory_moves set quantity = 999
      where id = 'aaaa0019-0000-4000-8000-0000000000f1' $$,
  'LAD06', null,
  'UPDATE como service_role CON el privilegio concedido: LAD06 — el trigger alcanza a '
  'quien los GRANT no contienen');
select throws_ok(
  $$ delete from public.inventory_moves where id = 'aaaa0019-0000-4000-8000-0000000000f1' $$,
  'LAD06', null, 'DELETE como service_role: LAD06');
select throws_ok(
  $$ truncate public.inventory_moves $$,
  'LAD06', null,
  'TRUNCATE como service_role: LAD06 — ignora la RLS y no dispara triggers de FILA, '
  'por eso hay un trigger de STATEMENT');
reset role;
revoke select, update, delete, truncate on public.inventory_moves from service_role;

-- ── 10. Banderas de rastreo congeladas con movimientos (LAD38) ─────────────
select throws_ok(
  $$ update public.products set tracks_lots = true
      where id = 'aaaa0019-0000-4000-8000-0000000000d1' $$,
  'LAD38', null,
  'las banderas de lotes/seriales no se cambian con movimientos registrados: las '
  'existencias ya están llevadas de una forma');
select lives_ok(
  $$ update public.products set tracks_lots = true
      where id = 'aaaa0019-0000-4000-8000-0000000000d9' $$,
  'pero sí en un producto sin movimientos');

-- ── 11. stock_at: la FECHA es parámetro, nunca now() ───────────────────────
-- Un movimiento fechado AYER: la existencia de anteayer no lo incluye.
select set_config('ladino.actor_id', 'aaaa0019-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff02', 'aaaa0019-0000-4000-8000-0000000000d2',
             'entrada', 3, 30, 'VES', 1, 30, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 10, now() - interval '1 day', 'AYER-1') $$,
  'un movimiento fechado ayer entra (occurred_at <= created_at)');
reset role;
select is(
  (select quantity::text from platform.stock_at('aaaa0019-0000-4000-8000-0000000000a2',
     'aaaa0019-0000-4000-8000-00000000ff02', 'aaaa0019-0000-4000-8000-0000000000d2',
     now() - interval '2 days')),
  '0', 'stock_at ANTEAYER: cero — el movimiento de ayer no había ocurrido');
select is(
  (select quantity::text from platform.stock_at('aaaa0019-0000-4000-8000-0000000000a2',
     'aaaa0019-0000-4000-8000-00000000ff02', 'aaaa0019-0000-4000-8000-0000000000d2', now())),
  '3.00000000', 'stock_at HOY: 3 — la fecha es parámetro y responde por fecha');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff02', 'aaaa0019-0000-4000-8000-0000000000d2',
             'entrada', 1, 10, 'VES', 1, 10, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', null, now() + interval '1 day') $$,
  '23514', null, 'un movimiento en el FUTURO no: CHECK occurred_at <= created_at');

-- ── 12. VARIANTE ROTA: sin el trigger, el materializado MIENTE ─────────────
-- Es la prueba de que la aserción «materializado == recalculado» mide el trigger
-- y no una coincidencia.
alter table public.inventory_moves disable trigger inventory_moves_10_apply;
select set_config('ladino.actor_id', 'aaaa0019-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, quantity_after, value_after, occurred_at, reference)
     values ('aaaa0019-0000-4000-8000-00000000000a', 'aaaa0019-0000-4000-8000-0000000000a2',
             'aaaa0019-0000-4000-8000-00000000ff01', 'aaaa0019-0000-4000-8000-0000000000d1',
             'entrada', 100, 1000, 'VES', 1, 1000, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 1, 0, 0, now(), 'ROTO-1') $$,
  'ROTO: sin el trigger, un movimiento entra sin tocar las existencias…');
reset role;
select cmp_ok(
  (select count(*) from platform.stock_reconciliation('aaaa0019-0000-4000-8000-0000000000a2')),
  '>', 0::bigint,
  '…y el materializado DIVERGE del recalculado: la aserción de arriba mide el trigger, '
  'no una casualidad');
alter table public.inventory_moves enable trigger inventory_moves_10_apply;

select * from finish();
rollback;
