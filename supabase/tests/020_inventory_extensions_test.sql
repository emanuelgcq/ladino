-- =============================================================================
-- Ladino — pgTAP 20 · Inventario, segunda vuelta (migración 20)
--
-- Lo que el encargo pide, ejercido:
--   RECETAS   vender el compuesto genera N salidas de ingredientes con el costo
--             correcto; recibir stock del compuesto muere con LAD43; y la
--             VARIANTE ROTA: sin esa validación, el stock del compuesto entra.
--   UNIDADES  la receta en gramos descuenta kilos; sin conversión, se rechaza.
--   FEFO      expiring_lots devuelve solo los lotes correctos; un lote vencido
--             no se despacha salvo con inventory.expired.
--   VARIANTES una talla no se mueve como si fuera otra; el kardex agrupa por
--             template y desglosa por variante.
--   UMBRALES  low_stock_products encuentra lo que falta, incluido lo que está
--             en cero.
-- =============================================================================

begin;
select plan(45);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0020-0000-4000-8000-0000000000a1'),   -- UA: mueve y ajusta en W1
  ('aaaa0020-0000-4000-8000-0000000000b1');   -- UB: además puede despachar vencido
insert into public.tenants (id, name) values
  ('aaaa0020-0000-4000-8000-00000000000a', 'Tenant 20');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0020-0000-4000-8000-0000000000a2', 'aaaa0020-0000-4000-8000-00000000000a', 'J-20', 'Restaurante 20');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'W1', 'Cocina');

insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0020-0000-4000-8000-0000000000e1', null, 'inv20_cocina', 'Cocina', true),
  ('aaaa0020-0000-4000-8000-0000000000e2', null, 'inv20_jefe', 'Jefe de cocina', true);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0020-0000-4000-8000-0000000000e1', 'inventory.move'),
  ('aaaa0020-0000-4000-8000-0000000000e2', 'inventory.move'),
  ('aaaa0020-0000-4000-8000-0000000000e2', 'inventory.expired');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0020-0000-4000-8000-0000000000a3', 'aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a1'),
  ('aaaa0020-0000-4000-8000-0000000000b3', 'aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000b1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0020-0000-4000-8000-0000000000a4', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a3', 'aaaa0020-0000-4000-8000-0000000000e1', null),
  ('aaaa0020-0000-4000-8000-0000000000b4', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000b3', 'aaaa0020-0000-4000-8000-0000000000e2', null);
insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id) values
  ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
   'aaaa0020-0000-4000-8000-0000000000a4', 'warehouse', 'aaaa0020-0000-4000-8000-00000000ff01'),
  ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
   'aaaa0020-0000-4000-8000-0000000000b4', 'warehouse', 'aaaa0020-0000-4000-8000-00000000ff01');

-- Ingredientes: harina en KG, leche en LITRO. El plato, compuesto.
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0020-0000-4000-8000-0000000000d1', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'HARINA', 'Harina', 'good', 'active', 'kg', 'gravado_general'),
  ('aaaa0020-0000-4000-8000-0000000000d2', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'LECHE', 'Leche', 'good', 'active', 'litro', 'gravado_general'),
  ('aaaa0020-0000-4000-8000-0000000000d3', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'AREPA', 'Arepa', 'good', 'active', 'unidad', 'gravado_general'),
  -- Producto con vencimiento (lleva lotes) y un cuarto sin conversión posible.
  ('aaaa0020-0000-4000-8000-0000000000d4', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'QUESO', 'Queso', 'good', 'active', 'kg', 'gravado_general'),
  ('aaaa0020-0000-4000-8000-0000000000d5', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'SAL', 'Sal', 'good', 'active', 'unidad', 'gravado_general');
update public.products set is_composed = true where id = 'aaaa0020-0000-4000-8000-0000000000d3';
update public.products set tracks_lots = true, tracks_expiry = true
 where id = 'aaaa0020-0000-4000-8000-0000000000d4';

-- ── 1. La receta y sus invariantes ──────────────────────────────────────────
select lives_ok(
  $$ insert into public.product_recipes (tenant_id, company_id, parent_product_id, child_product_id, quantity, unit_code)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-0000000000d3', 'aaaa0020-0000-4000-8000-0000000000d1', 200, 'gramo'),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-0000000000d3', 'aaaa0020-0000-4000-8000-0000000000d2', 300, 'mililitro') $$,
  'la receta de la arepa: 200 g de harina y 300 ml de leche, en unidades distintas a las del producto');
select throws_ok(
  $$ insert into public.product_recipes (tenant_id, company_id, parent_product_id, child_product_id, quantity, unit_code)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-0000000000d1', 'aaaa0020-0000-4000-8000-0000000000d2', 1, 'litro') $$,
  'LAD44', null, 'un producto NO compuesto no tiene receta: LAD44');
select throws_ok(
  $$ update public.products set is_composed = true where id = 'aaaa0020-0000-4000-8000-0000000000d1' $$,
  'LAD44', null,
  'marcar compuesto un producto que YA es ingrediente de otra receta: LAD44 — es el flanco que '
  'no toca product_recipes y rompería el invariante igual');
select throws_ok(
  $$ update public.products set is_composed = false where id = 'aaaa0020-0000-4000-8000-0000000000d3' $$,
  'LAD44', null, 'y dejar de ser compuesto con receta viva también');
select throws_ok(
  $$ insert into public.product_recipes (tenant_id, company_id, parent_product_id, child_product_id, quantity, unit_code)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-0000000000d3', 'aaaa0020-0000-4000-8000-0000000000d3', 1, 'unidad') $$,
  'LAD44', null,
  'un producto no se contiene a sí mismo. Muere con LAD44 y no con el CHECK '
  'products_recipes_no_self_chk porque el trigger BEFORE corre ANTES que las CHECK '
  'constraints y ve primero que el hijo es compuesto: dos defensas, y la de arriba '
  'llega primero. El CHECK sigue ahí como cinturón para el día que la de arriba cambie.');

-- ── 2. Conversión de unidades ───────────────────────────────────────────────
select is(platform.convert_quantity(200, 'gramo', 'kg'), 0.2::numeric,
  '200 g son 0,2 kg: la receta habla en gramos y el almacén en kilos');
select is(platform.convert_quantity(2.5, 'kg', 'gramo'), 2500::numeric, 'y 2,5 kg son 2500 g');
select is(platform.convert_quantity(5, 'unidad', 'unidad'), 5::numeric,
  'la misma unidad no necesita fila: la identidad no se carga');
select is(platform.convert_quantity(1, 'kg', 'litro'), null::numeric,
  'de kilos a litros NO hay conversión y devuelve NULL: el sistema no adivina la densidad');

-- ── 3. Como ladino_api: existencias de los ingredientes ─────────────────────
select set_config('ladino.actor_id', 'aaaa0020-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'test-020', true);
set local role ladino_api;

-- 10 kg de harina a 30,00/kg = 300,00 · 8 L de leche a 12,50/L = 100,00
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d1',
             'entrada', 10, 300, 'VES', 1, 300, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 30, now()),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d2',
             'entrada', 8, 100, 'VES', 1, 100, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 12.5, now()) $$,
  'existencias de los ingredientes: 10 kg de harina a 30,00 y 8 L de leche a 12,50');

-- EL INVARIANTE CENTRAL (LAD43): el compuesto no tiene existencias propias.
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d3',
             'entrada', 5, 100, 'VES', 1, 100, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 20, now()) $$,
  'LAD43', null,
  'RECIBIR stock del COMPUESTO muere con LAD43: una arepa no se almacena, se hace');
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d3',
             'salida', -1, -20, 'VES', 1, -20, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 20, now()) $$,
  'LAD43', null, 'y SACARLO también: en ninguna dirección hay stock del compuesto');

-- ── 4. Vender 12 arepas: 12 × 200 g = 2,4 kg y 12 × 300 ml = 3,6 L ─────────
-- Las salidas comparten source_document_id: son UN hecho de negocio.
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, source_document_id, reference)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d1',
             'salida', -2.4, -72, 'VES', 1, -72, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 30, now(),
             'aaaa0020-0000-4000-8000-00000000cc01', 'VTA-AREPA-12'),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d2',
             'salida', -3.6, -45, 'VES', 1, -45, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 12.5, now(),
             'aaaa0020-0000-4000-8000-00000000cc01', 'VTA-AREPA-12') $$,
  'vender 12 arepas genera DOS salidas de ingredientes, ligadas por source_document_id');
select is(
  (select count(*) from public.inventory_moves
    where source_document_id = 'aaaa0020-0000-4000-8000-00000000cc01'),
  2::bigint, 'las N salidas del compuesto quedan ligadas al mismo documento de origen');
select is(
  (select quantity::text from public.stock_balances
    where product_id = 'aaaa0020-0000-4000-8000-0000000000d1'),
  '7.60000000',
  'A MANO: 10 kg − (12 arepas × 200 g) = 7,6 kg. La receta habla en gramos, el kardex en kilos');
select is(
  (select quantity::text from public.stock_balances
    where product_id = 'aaaa0020-0000-4000-8000-0000000000d2'),
  '4.40000000', 'y 8 L − (12 × 300 ml) = 4,4 L');
select is(
  (select sum(-functional_amount)::text from public.inventory_moves
    where source_document_id = 'aaaa0020-0000-4000-8000-00000000cc01'),
  '117.00000000',
  'COSTO DEL COMPUESTO A MANO: 2,4 kg × 30,00 = 72,00 más 3,6 L × 12,50 = 45,00 → 117,00');
reset role;

-- El costo ESTIMADO por la función coincide con lo que costó de verdad, porque
-- el promedio no cambió: 0,2 kg × 30 + 0,3 L × 12,50 = 9,75 por arepa; ×12 = 117.
select is(
  platform.recipe_cost('aaaa0020-0000-4000-8000-0000000000a2',
                       'aaaa0020-0000-4000-8000-00000000ff01',
                       'aaaa0020-0000-4000-8000-0000000000d3'),
  9.75::numeric,
  'recipe_cost estima 9,75 por arepa: 0,2 kg × 30,00 + 0,3 L × 12,50');

-- Sin conversión cargada, la estimación es NULL y no un número a medias.
insert into public.product_recipes (tenant_id, company_id, parent_product_id, child_product_id, quantity, unit_code)
  values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
          'aaaa0020-0000-4000-8000-0000000000d3', 'aaaa0020-0000-4000-8000-0000000000d5', 2, 'gramo');
select is(
  platform.recipe_cost('aaaa0020-0000-4000-8000-0000000000a2',
                       'aaaa0020-0000-4000-8000-00000000ff01',
                       'aaaa0020-0000-4000-8000-0000000000d3'),
  null::numeric,
  'con un ingrediente en gramos cuyo producto se lleva en unidades, el costo estimado es NULL: '
  'un costo a medias sería peor que ninguno');
delete from public.product_recipes
 where parent_product_id = 'aaaa0020-0000-4000-8000-0000000000d3'
   and child_product_id = 'aaaa0020-0000-4000-8000-0000000000d5';

-- ── 5. VARIANTE ROTA: sin la validación del compuesto, el stock ENTRA ───────
-- Se quita la comprobación de is_composed reemplazando el trigger por uno que
-- no la hace, y se ve entrar lo que LAD43 impedía. Es la prueba de que las dos
-- aserciones de arriba miden la regla y no una casualidad.
-- La cola de eventos diferidos se vacía primero: el FK de la contraparte encola
-- uno por cada inserción y con la cola llena un ALTER TABLE muere con 55006, que
-- se confundiría con el fallo que se quiere provocar (la misma trampa que en 019).
select lives_ok(
  $$ set constraints all immediate $$,
  'la cola de eventos diferidos se vacía sin fallos antes de tocar los triggers');

create function pg_temp.roto_apply() returns trigger language plpgsql as $$
begin
  new.quantity_after := new.quantity;
  new.value_after    := new.functional_amount;
  new.unit_cost      := coalesce(new.unit_cost, 0);
  return new;
end;
$$;
alter table public.inventory_moves disable trigger inventory_moves_10_apply;
create trigger inventory_moves_10_roto
  before insert on public.inventory_moves
  for each row execute function pg_temp.roto_apply();
select set_config('ladino.actor_id', 'aaaa0020-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at, reference)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d3',
             'entrada', 5, 100, 'VES', 1, 100, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 20, now(), 'ROTO-COMPUESTO') $$,
  'ROTO: sin la validación, el stock del COMPUESTO entra — un almacén con arepas '
  'guardadas que la receta ya descontó, contadas dos veces');
select is(
  (select count(*) from public.inventory_moves
    where product_id = 'aaaa0020-0000-4000-8000-0000000000d3'),
  1::bigint,
  '…y queda el movimiento imposible en el kardex: las aserciones LAD43 miden la regla');
reset role;
drop trigger inventory_moves_10_roto on public.inventory_moves;
alter table public.inventory_moves enable trigger inventory_moves_10_apply;
-- El movimiento imposible NO se limpia con un DELETE: el append-only lo prohíbe
-- (LAD06) y tiene razón. Se queda ahí hasta el rollback del test, que es la única
-- forma de deshacerlo — exactamente como en producción, donde no habría rollback
-- y quedaría para siempre. Esa es la parte incómoda de la variante rota.

-- ── 6. Vencimientos y FEFO ──────────────────────────────────────────────────
insert into public.lots (id, tenant_id, company_id, product_id, code, expires_at) values
  ('aaaa0020-0000-4000-8000-00000000aa01', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'aaaa0020-0000-4000-8000-0000000000d4',
   'Q-VIEJO', current_date - 2),
  ('aaaa0020-0000-4000-8000-00000000aa02', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'aaaa0020-0000-4000-8000-0000000000d4',
   'Q-PRONTO', current_date + 5),
  ('aaaa0020-0000-4000-8000-00000000aa03', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'aaaa0020-0000-4000-8000-0000000000d4',
   'Q-LEJOS', current_date + 90);

select set_config('ladino.actor_id', 'aaaa0020-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa01', 'entrada', 2, 40, 'VES', 1, 40, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa02', 'entrada', 3, 60, 'VES', 1, 60, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa03', 'entrada', 5, 100, 'VES', 1, 100, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()) $$,
  'tres lotes de queso con existencia: uno vencido, uno que vence en 5 días y uno lejano');

-- Un lote VENCIDO no sale sin el permiso.
select throws_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa01', 'salida', -1, -20, 'VES', 1, -20, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()) $$,
  'LAD46', null,
  'despachar un lote VENCIDO sin inventory.expired: LAD46 — es control, no preferencia');
-- Pero ENTRAR sí puede: una devolución o una regularización de un lote vencido
-- es un hecho real, y el control es sobre lo que llega al cliente.
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa01', 'entrada', 1, 20, 'VES', 1, 20, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()) $$,
  'entrar existencia a un lote vencido SÍ se puede: el control es sobre la salida');
reset role;

-- Con el permiso (UB), la salida del vencido vive.
select set_config('ladino.actor_id', 'aaaa0020-0000-4000-8000-0000000000b1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d4',
             'aaaa0020-0000-4000-8000-00000000aa01', 'salida', -1, -20, 'VES', 1, -20, 'VES',
             'identidad', now(), 'inventory:cost:8:HALF_UP', 20, now()) $$,
  'con inventory.expired sobre ese almacén, la salida del lote vencido vive');
reset role;

select is(
  (select count(*) from platform.expiring_lots('aaaa0020-0000-4000-8000-0000000000a2', 7)),
  2::bigint,
  'expiring_lots(7): el vencido y el que vence en 5 días. El de 90 días NO');
select is(
  (select lot_code from platform.expiring_lots('aaaa0020-0000-4000-8000-0000000000a2', 7) limit 1),
  'Q-VIEJO', 'y viene primero el más urgente: el ya vencido (days_left negativo)');
select is(
  (select days_left from platform.expiring_lots('aaaa0020-0000-4000-8000-0000000000a2', 7) limit 1),
  -2, 'con los días en negativo, que es lo que lo hace urgente');
select is(
  (select count(*) from platform.expiring_lots('aaaa0020-0000-4000-8000-0000000000a2', 365)),
  3::bigint, 'a 365 días entran los tres');
select is(
  platform.suggest_lot_fefo('aaaa0020-0000-4000-8000-0000000000a2',
                            'aaaa0020-0000-4000-8000-00000000ff01',
                            'aaaa0020-0000-4000-8000-0000000000d4'),
  'aaaa0020-0000-4000-8000-00000000aa02'::uuid,
  'FEFO sugiere Q-PRONTO: el NO vencido que caduca primero — el vencido no se sugiere');

-- ── 7. Variantes ────────────────────────────────────────────────────────────
insert into public.product_templates (id, tenant_id, company_id, name, attribute_keys) values
  ('aaaa0020-0000-4000-8000-00000000bb01', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'Camisa', array['talla', 'color']);
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, template_id, attributes) values
  ('aaaa0020-0000-4000-8000-0000000000c1', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'CAM-M-AZ', 'Camisa M azul', 'good', 'active', 'unidad',
   'gravado_general', 'aaaa0020-0000-4000-8000-00000000bb01', '{"talla":"M","color":"azul"}'),
  ('aaaa0020-0000-4000-8000-0000000000c2', 'aaaa0020-0000-4000-8000-00000000000a',
   'aaaa0020-0000-4000-8000-0000000000a2', 'CAM-L-AZ', 'Camisa L azul', 'good', 'active', 'unidad',
   'gravado_general', 'aaaa0020-0000-4000-8000-00000000bb01', '{"talla":"L","color":"azul"}');

select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, template_id, attributes)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'CAM-DUP', 'Camisa M azul otra vez', 'good', 'active', 'unidad', 'gravado_general',
             'aaaa0020-0000-4000-8000-00000000bb01', '{"talla":"M","color":"azul"}') $$,
  '23505', null,
  'dos variantes con los MISMOS atributos: duplicado. Dos «M azul» con dos SKU serían dos '
  'existencias y nadie sabría cuál usar');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, template_id, attributes)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'CAM-INC', 'Camisa solo azul', 'good', 'active', 'unidad', 'gravado_general',
             'aaaa0020-0000-4000-8000-00000000bb01', '{"color":"azul"}') $$,
  'LAD47', null, 'una variante a la que le falta un eje que la plantilla exige: LAD47');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, template_id, attributes)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'CAM-EXTRA', 'Camisa con eje inventado', 'good', 'active', 'unidad', 'gravado_general',
             'aaaa0020-0000-4000-8000-00000000bb01', '{"talla":"M","color":"azul","largo":"corto"}') $$,
  'LAD47', null, 'y una que inventa un eje que la plantilla no declara, también');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, attributes)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'SIN-TPL', 'Atributos sin plantilla', 'good', 'active', 'unidad', 'gravado_general',
             '{"talla":"M"}') $$,
  '23514', null, 'atributos sin plantilla: CHECK — un producto autónomo no tiene ejes de variación');
select throws_ok(
  $$ insert into public.products (tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code, template_id, attributes)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'CAM-ANID', 'Atributos anidados', 'good', 'active', 'unidad', 'gravado_general',
             'aaaa0020-0000-4000-8000-00000000bb01', '{"talla":{"eu":"38"},"color":"azul"}') $$,
  '23514', null, 'atributos que no son texto plano: CHECK — el jsonb no es un cajón de sastre');

-- Cada talla es un producto: mover una NO mueve la otra.
select set_config('ladino.actor_id', 'aaaa0020-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok(
  $$ insert into public.inventory_moves
       (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
        amount_transaction_currency, transaction_currency, fx_rate,
        functional_amount, functional_currency, rate_source, rate_timestamp,
        rounding_policy_id, unit_cost, occurred_at)
     values ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000c1',
             'entrada', 5, 250, 'VES', 1, 250, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 50, now()),
            ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
             'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000c2',
             'entrada', 7, 420, 'VES', 1, 420, 'VES', 'identidad', now(),
             'inventory:cost:8:HALF_UP', 60, now()) $$,
  '5 camisas M y 7 camisas L, cada una su producto y su costo');
reset role;
select is(
  (select quantity::text from public.stock_balances
    where product_id = 'aaaa0020-0000-4000-8000-0000000000c1'),
  '5.00000000', 'la M tiene 5…');
select is(
  (select quantity::text from public.stock_balances
    where product_id = 'aaaa0020-0000-4000-8000-0000000000c2'),
  '7.00000000',
  '…y la L tiene 7: una talla no se mueve como si fuera otra, porque son productos distintos');
select is(
  (select last_unit_cost::text from public.stock_balances
    where product_id = 'aaaa0020-0000-4000-8000-0000000000c2'),
  '60.00000000', 'y el costeo por variante es natural: la L cuesta 60, la M 50');
select is(
  (select count(*) from platform.stock_by_template('aaaa0020-0000-4000-8000-0000000000a2')),
  2::bigint, 'el kardex por plantilla DESGLOSA por variante: dos filas');
select is(
  (select distinct template_quantity::text
     from platform.stock_by_template('aaaa0020-0000-4000-8000-0000000000a2')),
  '12.00000000',
  'y AGRUPA por plantilla: las dos filas llevan el total del template, 5 + 7 = 12');

-- ── 8. Umbrales de reposición ───────────────────────────────────────────────
insert into public.product_stock_thresholds (tenant_id, company_id, warehouse_id, product_id, stock_min) values
  ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
   'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d1', 10),
  ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
   'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000c1', 3),
  -- La sal no tiene NI UNA existencia: es justo la que hay que reponer.
  ('aaaa0020-0000-4000-8000-00000000000a', 'aaaa0020-0000-4000-8000-0000000000a2',
   'aaaa0020-0000-4000-8000-00000000ff01', 'aaaa0020-0000-4000-8000-0000000000d5', 4);
select is(
  (select count(*) from platform.low_stock_products('aaaa0020-0000-4000-8000-0000000000a2')),
  2::bigint,
  'low_stock: la harina (7,6 < 10) y la sal (0 < 4). La camisa M (5 >= 3) no está');
select is(
  (select product_id from platform.low_stock_products('aaaa0020-0000-4000-8000-0000000000a2') limit 1),
  'aaaa0020-0000-4000-8000-0000000000d5'::uuid,
  'y primero la que MÁS falta: la sal, con 4 de 4 — un producto SIN existencias sale en el '
  'reporte, que es lo que un INNER JOIN habría escondido');
select is(
  (select missing::text from platform.low_stock_products('aaaa0020-0000-4000-8000-0000000000a2')
    where product_id = 'aaaa0020-0000-4000-8000-0000000000d1'),
  '2.40000000', 'y dice cuánto falta de la harina: 10 − 7,6 = 2,4');

select * from finish();
rollback;
