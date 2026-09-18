-- =============================================================================
-- Ladino — pgTAP 71 · LO QUE LA PERSONA ESCRIBIÓ (migración 71, ADR-0066)
--
-- Dos columnas de documentación de la captura, con vocabulario CERRADO. Lo que
-- se prueba es justo eso: que el vocabulario cierra, que la moneda existe, y
-- que el histórico —nulo— sigue siendo válido, porque `inventory_moves` es
-- append-only y no admite backfill.
-- =============================================================================

begin;
select plan(4);

insert into public.tenants (id, name) values
  ('aaaa0071-0000-4000-8000-00000000000a', 'Tenant 71');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0071-0000-4000-8000-0000000000a1', 'aaaa0071-0000-4000-8000-00000000000a',
        'J-71-A', 'Captura 71', 'VES');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0071-0000-4000-8000-00000000000d', 'aaaa0071-0000-4000-8000-00000000000a',
   'aaaa0071-0000-4000-8000-0000000000a1', 'W71', 'Depósito');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code)
values ('aaaa0071-0000-4000-8000-00000000000e', 'aaaa0071-0000-4000-8000-00000000000a',
        'aaaa0071-0000-4000-8000-0000000000a1', 'SKU71', 'Producto 71', 'good', 'active',
        'unidad', 'gravado_general');

-- ── 1. El histórico, sin captura, sigue siendo válido ──────────────────────
select lives_ok($$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at)
  values ('aaaa0071-0000-4000-8000-00000000000a', 'aaaa0071-0000-4000-8000-0000000000a1',
          'aaaa0071-0000-4000-8000-00000000000d', 'aaaa0071-0000-4000-8000-00000000000e',
          'entrada', 5, 500, 'VES', 1, 500, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', now())
$$, 'un movimiento sin captura entra: el histórico anterior a la migración 71 sigue siendo válido');

-- ── 2. Lo escrito se guarda tal cual ───────────────────────────────────────
select lives_ok($$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
     capture_currency, capture_mode)
  values ('aaaa0071-0000-4000-8000-00000000000a', 'aaaa0071-0000-4000-8000-0000000000a1',
          'aaaa0071-0000-4000-8000-00000000000d', 'aaaa0071-0000-4000-8000-00000000000e',
          'entrada', 5, 500, 'VES', 1, 500, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', now(), 'USD', 'total')
$$, 'y con captura también: «lo escribí en dólares, y di el total de la llegada»');

-- ── 3 y 4. El vocabulario cierra, y la moneda existe ───────────────────────
select throws_ok($$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
     capture_mode)
  values ('aaaa0071-0000-4000-8000-00000000000a', 'aaaa0071-0000-4000-8000-0000000000a1',
          'aaaa0071-0000-4000-8000-00000000000d', 'aaaa0071-0000-4000-8000-00000000000e',
          'entrada', 5, 500, 'VES', 1, 500, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', now(), 'por_bulto')
$$, '23514', null,
  'un modo de captura inventado se rechaza: el vocabulario es cerrado, como el de las plantillas');

select throws_ok($$
  insert into public.inventory_moves
    (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, occurred_at,
     capture_currency)
  values ('aaaa0071-0000-4000-8000-00000000000a', 'aaaa0071-0000-4000-8000-0000000000a1',
          'aaaa0071-0000-4000-8000-00000000000d', 'aaaa0071-0000-4000-8000-00000000000e',
          'entrada', 5, 500, 'VES', 1, 500, 'VES', 'identidad', now(),
          'inventory:cost:8:HALF_UP', now(), 'XYZ')
$$, '23503', null,
  'y una moneda que no existe tampoco: la captura apunta al catálogo de monedas');

select * from finish();
rollback;
