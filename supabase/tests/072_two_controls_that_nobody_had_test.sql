-- =============================================================================
-- Ladino — pgTAP 72 · LOS DOS CONTROLES QUE FALTABAN (migración 72, ADR-0066 §8)
--
-- Lo que se prueba, con su variante rota delante:
--   1. una entrada normal NO dispara el aviso de doble registro;
--   2. la misma cantidad, el mismo día, una CON documento y otra SIN él, SÍ;
--   3. dos entradas iguales del mismo camino (las dos sin documento) NO: eso es
--      comprar dos veces lo mismo, que es legítimo y pasa;
--   4. una llegada fechada atrás con una venta entre medias sale en el reporte,
--      con las unidades que salieron con el costo viejo.
-- =============================================================================

begin;
select plan(4);

insert into public.tenants (id, name) values
  ('aaaa0072-0000-4000-8000-00000000000a', 'Tenant 72');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0072-0000-4000-8000-0000000000a1', 'aaaa0072-0000-4000-8000-00000000000a',
        'J-72-A', 'Controles 72', 'VES');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000a',
   'aaaa0072-0000-4000-8000-0000000000a1', 'W72', 'Depósito');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code)
values ('aaaa0072-0000-4000-8000-00000000000e', 'aaaa0072-0000-4000-8000-00000000000a',
        'aaaa0072-0000-4000-8000-0000000000a1', 'SKU72', 'Harina 72', 'good', 'active',
        'unidad', 'gravado_general');

-- Una entrada sola, sin documento: el aporte de siempre.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at)
values ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'entrada', 10, 1000, 'VES', 1, 1000, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now());

select is(
  (select count(*) from platform.duplicate_stock_in_gaps('aaaa0072-0000-4000-8000-0000000000a1')),
  0::bigint,
  'una entrada normal no dispara nada: el control no grita por existir');

-- La MISMA cantidad, el mismo día, ahora con documento: alguien registró la compra y además
-- «metió» la mercancía.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
   source_document_id)
values ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'entrada', 10, 1000, 'VES', 1, 1000, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now(), 'aaaa0072-0000-4000-8000-00000000000c');

select is(
  (select moves from platform.duplicate_stock_in_gaps('aaaa0072-0000-4000-8000-0000000000a1')),
  2::bigint,
  'la misma cantidad el mismo día, una con documento y otra sin él: posible doble registro');

-- Y dos iguales del MISMO camino no son sospechosas: comprar dos veces lo mismo pasa.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
   source_document_id)
values ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'entrada', 7, 700, 'VES', 1, 700, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now(), 'aaaa0072-0000-4000-8000-00000000000c'),
       ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'entrada', 7, 700, 'VES', 1, 700, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now(), 'aaaa0072-0000-4000-8000-00000000000b');

select is(
  (select count(*) from platform.duplicate_stock_in_gaps('aaaa0072-0000-4000-8000-0000000000a1')
    where quantity = 7),
  0::bigint,
  'dos compras iguales el mismo día NO son sospechosas: eso pasa y es legítimo');

-- ── El reporte de las fechadas hacia atrás ─────────────────────────────────
-- Una salida de ayer registrada ahora, y una entrada fechada ANTEAYER registrada después: su
-- costo salió sin esta llegada, y ya no cambia.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at, created_at)
values ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'salida', -3, -300, 'VES', 1, -300, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now() - interval '1 day', now() - interval '1 hour');
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at, created_at)
values ('aaaa0072-0000-4000-8000-00000000000a', 'aaaa0072-0000-4000-8000-0000000000a1',
        'aaaa0072-0000-4000-8000-00000000000d', 'aaaa0072-0000-4000-8000-00000000000e',
        'entrada', 20, 2000, 'VES', 1, 2000, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', now() - interval '2 days', now());

select is(
  (select sold_between from platform.backdated_stock_in('aaaa0072-0000-4000-8000-0000000000a1')),
  3::numeric,
  'la llegada fechada atrás sale en el reporte, con las 3 unidades que salieron con el costo viejo');

select * from finish();
rollback;
