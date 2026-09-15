-- =============================================================================
-- Ladino — pgTAP 57 · EL REPARTO FEFO DE UNA SALIDA SIN LOTE (migración 57)
--
-- Tres lotes de queso en el mismo depósito: uno VENCIDO (2), uno que vence en 5
-- días (3) y uno lejano (5). Y uno lejano en OTRO depósito (7).
--   1. pedir 4 → 3 del que vence antes + 1 del lejano, en ese orden;
--   2. el vencido NUNCA entra al reparto;
--   3. pedir justo lo vigente (8) lo reparte entero;
--   4. pedir de más devuelve solo lo que hay (quien llama detecta que no alcanza);
--   5. el otro depósito no cuenta;
--   6. VARIANTE ROTA: sin el filtro de vencimiento, el vencido saldría primero —
--      se ejecuta la misma consulta sin él y se ve que elegiría el lote vencido.
-- =============================================================================

begin;
select plan(6);

insert into auth.users (id) values ('aaaa0057-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0057-0000-4000-8000-0000000000e1', true);

insert into public.tenants (id, name) values ('aaaa0057-0000-4000-8000-00000000000a', 'Tenant 57');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0057-0000-4000-8000-0000000000a1', 'aaaa0057-0000-4000-8000-00000000000a', 'J-57', 'Quesera 57');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'W57-1', 'Local'),
  ('aaaa0057-0000-4000-8000-0000000000b2', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'W57-2', 'Otro');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code, tracks_lots, tracks_expiry) values
  ('aaaa0057-0000-4000-8000-0000000000d1', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'Q57', 'Queso 57', 'good', 'active', 'unidad',
   'gravado_general', true, true);
insert into public.lots (id, tenant_id, company_id, product_id, code, expires_at) values
  ('aaaa0057-0000-4000-8000-0000000000c1', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'aaaa0057-0000-4000-8000-0000000000d1', 'VENCIDO', current_date - 2),
  ('aaaa0057-0000-4000-8000-0000000000c2', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'aaaa0057-0000-4000-8000-0000000000d1', 'PRONTO', current_date + 5),
  ('aaaa0057-0000-4000-8000-0000000000c3', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'aaaa0057-0000-4000-8000-0000000000d1', 'LEJOS', current_date + 90),
  ('aaaa0057-0000-4000-8000-0000000000c4', 'aaaa0057-0000-4000-8000-00000000000a',
   'aaaa0057-0000-4000-8000-0000000000a1', 'aaaa0057-0000-4000-8000-0000000000d1', 'OTRO', current_date + 1);

insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at)
values
  ('aaaa0057-0000-4000-8000-00000000000a', 'aaaa0057-0000-4000-8000-0000000000a1',
   'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1',
   'aaaa0057-0000-4000-8000-0000000000c1', 'entrada', 2, 40, 'VES', 1, 40, 'VES', 'identidad', now(),
   'inventory:cost:8:HALF_UP', 20, now()),
  ('aaaa0057-0000-4000-8000-00000000000a', 'aaaa0057-0000-4000-8000-0000000000a1',
   'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1',
   'aaaa0057-0000-4000-8000-0000000000c2', 'entrada', 3, 60, 'VES', 1, 60, 'VES', 'identidad', now(),
   'inventory:cost:8:HALF_UP', 20, now()),
  ('aaaa0057-0000-4000-8000-00000000000a', 'aaaa0057-0000-4000-8000-0000000000a1',
   'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1',
   'aaaa0057-0000-4000-8000-0000000000c3', 'entrada', 5, 100, 'VES', 1, 100, 'VES', 'identidad', now(),
   'inventory:cost:8:HALF_UP', 20, now()),
  ('aaaa0057-0000-4000-8000-00000000000a', 'aaaa0057-0000-4000-8000-0000000000a1',
   'aaaa0057-0000-4000-8000-0000000000b2', 'aaaa0057-0000-4000-8000-0000000000d1',
   'aaaa0057-0000-4000-8000-0000000000c4', 'entrada', 7, 140, 'VES', 1, 140, 'VES', 'identidad', now(),
   'inventory:cost:8:HALF_UP', 20, now());

select is(
  (select array_agg(lot_id::text || ':' || quantity::numeric(24,2)::text order by expires_at)
     from platform.allocate_lots_fefo('aaaa0057-0000-4000-8000-0000000000a1',
          'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1', 4, current_date)),
  array['aaaa0057-0000-4000-8000-0000000000c2:3.00', 'aaaa0057-0000-4000-8000-0000000000c3:1.00'],
  'Pedir 4: 3 del que vence antes y 1 del lejano, en orden de vencimiento');

select ok(
  not exists (select 1 from platform.allocate_lots_fefo('aaaa0057-0000-4000-8000-0000000000a1',
          'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1', 10, current_date)
               where lot_id = 'aaaa0057-0000-4000-8000-0000000000c1'),
  'El lote vencido nunca entra al reparto, ni pidiendo de más');

select is(
  (select sum(quantity) from platform.allocate_lots_fefo('aaaa0057-0000-4000-8000-0000000000a1',
          'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1', 8, current_date)),
  8::numeric,
  'Pedir justo lo vigente (3 + 5) lo reparte entero');

select is(
  (select sum(quantity) from platform.allocate_lots_fefo('aaaa0057-0000-4000-8000-0000000000a1',
          'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1', 50, current_date)),
  8::numeric,
  'Pedir de más devuelve solo lo que hay: quien llama detecta que no alcanza');

select ok(
  not exists (select 1 from platform.allocate_lots_fefo('aaaa0057-0000-4000-8000-0000000000a1',
          'aaaa0057-0000-4000-8000-0000000000b1', 'aaaa0057-0000-4000-8000-0000000000d1', 50, current_date)
               where lot_id = 'aaaa0057-0000-4000-8000-0000000000c4'),
  'La existencia de otro depósito no cuenta');

-- VARIANTE ROTA: la misma selección sin el filtro de vencimiento elige primero
-- el lote VENCIDO. El filtro es lo único que lo impide.
select is(
  (select l.id from public.lots l
     join public.stock_balances b on b.lot_id = l.id
    where l.company_id = 'aaaa0057-0000-4000-8000-0000000000a1'
      and b.warehouse_id = 'aaaa0057-0000-4000-8000-0000000000b1' and b.quantity > 0
    order by l.expires_at nulls last, l.created_at limit 1),
  'aaaa0057-0000-4000-8000-0000000000c1'::uuid,
  'VARIANTE ROTA: sin el filtro de vencimiento, el primer lote del reparto sería el VENCIDO');

select * from finish();
rollback;
