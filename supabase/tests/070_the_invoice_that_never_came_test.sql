-- =============================================================================
-- Ladino — pgTAP 70 · LA FACTURA QUE NO LLEGÓ (migración 70, ADR-0066 §8)
--
-- Lo que se prueba:
--   1. lo recibido y no facturado aparece, con su antigüedad en días;
--   2. y con el importe que sigue vivo en la cuenta puente;
--   3. facturado a medias, sigue apareciendo por lo que falta;
--   4. facturado del todo, desaparece;
--   5. una factura ANULADA no cuenta como facturada — si contara, la cuenta puente
--      quedaría con saldo y la lista diría que no falta nada.
-- =============================================================================

begin;
select plan(5);

insert into public.tenants (id, name) values
  ('aaaa0070-0000-4000-8000-00000000000a', 'Tenant 70');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0070-0000-4000-8000-0000000000a1', 'aaaa0070-0000-4000-8000-00000000000a',
        'J-70-A', 'Depósito 70', 'VES', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0070-0000-4000-8000-0000000000b1', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'J-70-PROV', 'Proveedor 70', 'nacional',
        'ordinario', 'juridica');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0070-0000-4000-8000-00000000000d', 'aaaa0070-0000-4000-8000-00000000000a',
   'aaaa0070-0000-4000-8000-0000000000a1', 'W70', 'Depósito');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code)
values ('aaaa0070-0000-4000-8000-00000000000e', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'SKU70', 'Producto 70', 'good', 'active',
        'unidad', 'gravado_general');

-- Una recepción de hace diez días: 10 unidades a 100.
insert into public.goods_receipts
  (id, tenant_id, company_id, supplier_id, warehouse_id, status, receipt_number, received_at,
   delivery_note_ref,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values ('aaaa0070-0000-4000-8000-00000000000c', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'aaaa0070-0000-4000-8000-0000000000b1',
        'aaaa0070-0000-4000-8000-00000000000d', 'confirmed', 1, now() - interval '10 days',
        'GUIA-70', 1000, 'VES', 1, 1000, 'VES', 'identidad', now(),
        'purchases:document:8:HALF_UP');
insert into public.goods_receipt_lines
  (id, tenant_id, company_id, goods_receipt_id, line_number, product_id, quantity,
   unit_price_transaction, unit_cost_functional, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0070-0000-4000-8000-00000000000f', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'aaaa0070-0000-4000-8000-00000000000c', 1,
        'aaaa0070-0000-4000-8000-00000000000e', 10, 100, 100, 1000, 'VES', 1, 1000, 'VES',
        'identidad', now(), 'purchases:document:8:HALF_UP');

select is(
  (select age_days from platform.receipts_pending_invoice(
     'aaaa0070-0000-4000-8000-0000000000a1')),
  10,
  'lo recibido y no facturado aparece, y dice cuántos días lleva esperando la factura');

select is(
  (select pending_amount from platform.receipts_pending_invoice(
     'aaaa0070-0000-4000-8000-0000000000a1')),
  1000::numeric,
  'con el importe que sigue vivo en «mercancía recibida por facturar»');

-- Llega la factura, pero solo por 4 de las 10 unidades.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0070-0000-4000-8000-0000000000af', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'aaaa0070-0000-4000-8000-0000000000b1',
        'F70-1', '00-701', current_date, 'posted', now(), 400, 64, 464, true,
        'VES', 'VES', 1, 'identidad');
insert into public.supplier_invoice_lines
  (tenant_id, company_id, supplier_invoice_id, line_number, goods_receipt_line_id, product_id,
   description, quantity, unit_price_transaction, unit_price_functional, tax_rate_snapshot,
   tax_amount, line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0070-0000-4000-8000-00000000000a', 'aaaa0070-0000-4000-8000-0000000000a1',
        'aaaa0070-0000-4000-8000-0000000000af', 1, 'aaaa0070-0000-4000-8000-00000000000f',
        'aaaa0070-0000-4000-8000-00000000000e', 'Producto 70', 4, 100, 100, 0.16, 64, 400, 464,
        400, 'VES', 1, 464, 'VES', 'identidad', now(), 'purchases:document:8:HALF_UP');

select is(
  (select pending_amount from platform.receipts_pending_invoice(
     'aaaa0070-0000-4000-8000-0000000000a1')),
  600::numeric,
  'facturada a medias, sigue esperando por lo que falta: 6 de 10 a 100');

-- Y el resto.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0070-0000-4000-8000-0000000000bf', 'aaaa0070-0000-4000-8000-00000000000a',
        'aaaa0070-0000-4000-8000-0000000000a1', 'aaaa0070-0000-4000-8000-0000000000b1',
        'F70-2', '00-702', current_date, 'posted', now(), 600, 96, 696, true,
        'VES', 'VES', 1, 'identidad');
insert into public.supplier_invoice_lines
  (tenant_id, company_id, supplier_invoice_id, line_number, goods_receipt_line_id, product_id,
   description, quantity, unit_price_transaction, unit_price_functional, tax_rate_snapshot,
   tax_amount, line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0070-0000-4000-8000-00000000000a', 'aaaa0070-0000-4000-8000-0000000000a1',
        'aaaa0070-0000-4000-8000-0000000000bf', 1, 'aaaa0070-0000-4000-8000-00000000000f',
        'aaaa0070-0000-4000-8000-00000000000e', 'Producto 70', 6, 100, 100, 0.16, 96, 600, 696,
        600, 'VES', 1, 696, 'VES', 'identidad', now(), 'purchases:document:8:HALF_UP');

select is(
  (select count(*) from platform.receipts_pending_invoice(
     'aaaa0070-0000-4000-8000-0000000000a1')),
  0::bigint,
  'facturada del todo, desaparece de la lista: ya no falta nada');

-- Y la anulada no cuenta como facturada.
update public.supplier_invoices set status = 'annulled'
 where id = 'aaaa0070-0000-4000-8000-0000000000bf';
select is(
  (select pending_amount from platform.receipts_pending_invoice(
     'aaaa0070-0000-4000-8000-0000000000a1')),
  600::numeric,
  'y si la factura se anula vuelve a faltar: una anulada no factura nada');

select * from finish();
rollback;
