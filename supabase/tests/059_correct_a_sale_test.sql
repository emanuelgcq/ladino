-- =============================================================================
-- Ladino — pgTAP 59 · CORREGIR UNA VENTA (migración 59)
--
--   1. documents admite el kind receipt_return;
--   2. sin_facturacion lo permite, y sigue siendo «recibos» (modo de venta);
--   3. LAD84: un recibo de devolución contra una FACTURA muere en el trigger;
--   4. contra un RECIBO de la misma empresa, pasa el trigger de origen;
--   5. un reembolso baja el saldo de la cuenta y el recómputo coincide;
--   6. un reembolso no se borra (append-only);
--   7. un reembolso no se edita salvo el backlink;
--   8. VARIANTE ROTA: un documento anulado con su salida sin reponer aparece en
--      annulled_stock_gaps; con la reposición, desaparece.
-- =============================================================================

begin;
select plan(9);

insert into auth.users (id) values ('aaaa0059-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0059-0000-4000-8000-0000000000e1', true);

insert into public.tenants (id, name) values ('aaaa0059-0000-4000-8000-00000000000a', 'Tenant 59');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0059-0000-4000-8000-0000000000a1', 'aaaa0059-0000-4000-8000-00000000000a', 'J-59', 'Bodega 59');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0059-0000-4000-8000-0000000000b1', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'W59', 'Local');
insert into public.customers (id, tenant_id, company_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0059-0000-4000-8000-0000000000c1', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'Cliente 59', 'natural', 'consumidor_final');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0059-0000-4000-8000-0000000000ab', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'sin_facturacion', '2026-01-01');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0059-0000-4000-8000-0000000000d1', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'P59', 'Pan 59', 'good', 'active', 'unidad', 'gravado_general');

-- Documentos en borrador (el trigger de emisión solo mira el paso a issued).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0059-0000-4000-8000-0000000000f1', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'invoice', 'A', 'aaaa0059-0000-4000-8000-0000000000c1',
   'draft', 'test-059', 'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100),
  ('aaaa0059-0000-4000-8000-0000000000f2', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'receipt', 'R', 'aaaa0059-0000-4000-8000-0000000000c1',
   'draft', 'test-059', 'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100);

select ok(
  (select pg_get_constraintdef(oid) like '%receipt_return%'
     from pg_constraint where conname = 'documents_kind_chk'),
  'documents admite el kind receipt_return');

select is(
  (select allowed_kinds from public.fiscal_regimes where code = 'sin_facturacion'),
  array['receipt', 'receipt_return'],
  'sin_facturacion emite recibos y recibos de devolución');

select throws_ok(
  $$ insert into public.documents
       (tenant_id, company_id, kind, series, customer_id, status, rules_version, source_document_id,
        transaction_currency, functional_currency, fx_rate, rate_source,
        amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
     values ('aaaa0059-0000-4000-8000-00000000000a', 'aaaa0059-0000-4000-8000-0000000000a1',
             'receipt_return', 'D', 'aaaa0059-0000-4000-8000-0000000000c1', 'draft', 'test-059',
             'aaaa0059-0000-4000-8000-0000000000f1', 'VES', 'VES', 1, 'identidad',
             10, 10, 10, 0, 10) $$,
  'LAD84', null,
  'VARIANTE ROTA: un recibo de devolución contra una FACTURA muere en el trigger (LAD84)');

select lives_ok(
  $$ insert into public.documents
       (tenant_id, company_id, kind, series, customer_id, status, rules_version, source_document_id,
        transaction_currency, functional_currency, fx_rate, rate_source,
        amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
     values ('aaaa0059-0000-4000-8000-00000000000a', 'aaaa0059-0000-4000-8000-0000000000a1',
             'receipt_return', 'D', 'aaaa0059-0000-4000-8000-0000000000c1', 'draft', 'test-059',
             'aaaa0059-0000-4000-8000-0000000000f2', 'VES', 'VES', 1, 'identidad',
             10, 10, 10, 0, 10) $$,
  'Contra un RECIBO de la misma empresa, el recibo de devolución pasa');

-- El reembolso: un saldo a favor de 50 y una caja en VES.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0059-0000-4000-8000-0000000000aa', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'Caja 59', 'VES', 'cash');
insert into public.customer_credits (id, tenant_id, company_id, customer_id, source_document_id, amount, currency) values
  ('aaaa0059-0000-4000-8000-0000000000cc', 'aaaa0059-0000-4000-8000-00000000000a',
   'aaaa0059-0000-4000-8000-0000000000a1', 'aaaa0059-0000-4000-8000-0000000000c1',
   'aaaa0059-0000-4000-8000-0000000000f2', 50, 'VES');
insert into public.customer_refunds
  (id, tenant_id, company_id, customer_credit_id, account_id, reason,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
values ('aaaa0059-0000-4000-8000-0000000000dd', 'aaaa0059-0000-4000-8000-00000000000a',
        'aaaa0059-0000-4000-8000-0000000000a1', 'aaaa0059-0000-4000-8000-0000000000cc',
        'aaaa0059-0000-4000-8000-0000000000aa', 'Reembolso 59', 30, 'VES', 30, 'VES');

select is(
  (select array[materialized, recomputed] from platform.treasury_reconciliation('aaaa0059-0000-4000-8000-0000000000a1')
    where account_id = 'aaaa0059-0000-4000-8000-0000000000aa'),
  array[-30::numeric, -30::numeric],
  'El reembolso baja el saldo de la caja y el recómputo dice lo mismo');

select throws_ok(
  $$ delete from public.customer_refunds where id = 'aaaa0059-0000-4000-8000-0000000000dd' $$,
  null, null,
  'Un reembolso no se borra');

select throws_ok(
  $$ update public.customer_refunds set reason = 'otro motivo cualquiera'
      where id = 'aaaa0059-0000-4000-8000-0000000000dd' $$,
  'LAD06', null,
  'Un reembolso no se edita (solo su backlink al asiento)');

-- VARIANTE ROTA del invariante: un recibo EMITIDO, luego anulado sin reponer su salida.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   regime_version_id, rules_version, transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values (('aaaa0059-0000-4000-8000-0000000000f3'), 'aaaa0059-0000-4000-8000-00000000000a',
        'aaaa0059-0000-4000-8000-0000000000a1', 'receipt', 'R59',
        'aaaa0059-0000-4000-8000-0000000000c1', 'issued', now(), 1,
        'aaaa0059-0000-4000-8000-0000000000ab', 'test-059', 'VES', 'VES', 1, 'identidad',
        100, 100, 100, 0, 100);
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at)
values ('aaaa0059-0000-4000-8000-00000000000a', 'aaaa0059-0000-4000-8000-0000000000a1',
        'aaaa0059-0000-4000-8000-0000000000b1', 'aaaa0059-0000-4000-8000-0000000000d1',
        'entrada', 5, 50, 'VES', 1, 50, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 10, now());
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at,
   source_document_id)
values ('aaaa0059-0000-4000-8000-00000000000a', 'aaaa0059-0000-4000-8000-0000000000a1',
        'aaaa0059-0000-4000-8000-0000000000b1', 'aaaa0059-0000-4000-8000-0000000000d1',
        'salida', -2, -20, 'VES', 1, -20, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 10, now(),
        'aaaa0059-0000-4000-8000-0000000000f3');
update public.documents set status = 'annulled', annulled_at = now(), annul_reason = 'prueba 59'
 where id = 'aaaa0059-0000-4000-8000-0000000000f3';

select is(
  (select array[quantity, value] from platform.annulled_stock_gaps('aaaa0059-0000-4000-8000-0000000000a1')),
  array[-2::numeric, -20::numeric],
  'VARIANTE ROTA: el recibo anulado sin reponer aparece con lo que falta, en cantidad y valor');

insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at,
   source_document_id)
values ('aaaa0059-0000-4000-8000-00000000000a', 'aaaa0059-0000-4000-8000-0000000000a1',
        'aaaa0059-0000-4000-8000-0000000000b1', 'aaaa0059-0000-4000-8000-0000000000d1',
        'entrada', 2, 20, 'VES', 1, 20, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 10, now(),
        'aaaa0059-0000-4000-8000-0000000000f3');
select is(
  (select count(*)::int from platform.annulled_stock_gaps('aaaa0059-0000-4000-8000-0000000000a1')),
  0,
  'Con la reposición exacta, el anulado netea a cero y sale del invariante');

select * from finish();
rollback;
