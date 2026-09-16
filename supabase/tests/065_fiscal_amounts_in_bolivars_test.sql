-- =============================================================================
-- Ladino — pgTAP 65 · LO FISCAL SE LLEVA EN BOLÍVARES (migración 65)
--
-- Una venta de USD 116 (100 + 16 de IVA) a 40 y una compra de USD 58 (50 + 8)
-- a 40. En bolívares: venta 4.000 + 640; compra 2.000 + 320.
--
--   1. la planilla declara 640 de débito, no «16» (los dólares) …
--   2. … sobre una base de 4.000, no de 4.640 (el total con IVA);
--   3. y 320 de crédito, no «8»;
--   4. VARIANTE ROTA: la suma vieja (IVA del renglón) daba 16;
--   5. el libro de ventas: base gravada 4.000;
--   6. el libro de compras: base 2.000, IVA 320, total 2.320, y dice su moneda;
--   7. lo que se le debe HOY al proveedor, a la tasa de HOY (45, no la de la factura): 2.610;
--   8. y la antigüedad de cuentas por pagar suma eso, no «58».
--
-- La tasa del día (45) es DISTINTA de la de las facturas (40) a propósito: así se ve qué
-- cifra usa cuál. Libros y planilla, la de la factura; la deuda de hoy, la de hoy.
-- =============================================================================

begin;
select plan(8);

insert into public.tenants (id, name) values
  ('aaaa0065-0000-4000-8000-00000000000a', 'Tenant 65');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0065-0000-4000-8000-0000000000a2', 'aaaa0065-0000-4000-8000-00000000000a',
   'J-65-A', 'Ferretería 65', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0065-0000-4000-8000-00000000c001', 'aaaa0065-0000-4000-8000-00000000000a',
   'aaaa0065-0000-4000-8000-0000000000a2', 'J-CLI-65', 'Cliente 65', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0065-0000-4000-8000-00000000d001', 'aaaa0065-0000-4000-8000-00000000000a',
   'aaaa0065-0000-4000-8000-0000000000a2', 'SKU-65', 'Taladro 65', 'good', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0065-0000-4000-8000-00000000e101', 'aaaa0065-0000-4000-8000-00000000000a',
        'aaaa0065-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.exchange_rates
  (from_currency, to_currency, rate, source, rate_date, rate_timestamp, tenant_id, company_id)
values ('USD', 'VES', 45, 'prueba-065', platform.caracas_day(now()), now(),
        'aaaa0065-0000-4000-8000-00000000000a', 'aaaa0065-0000-4000-8000-0000000000a2');

-- La venta: USD 100 + 16, congelada en bolívares a 40.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0065-0000-4000-8000-00000000f001', 'aaaa0065-0000-4000-8000-00000000000a',
        'aaaa0065-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0065-0000-4000-8000-00000000c001', 1, 6501, 'issued', now(),
        'aaaa0065-0000-4000-8000-00000000e101', 'test-065', 'USD', 'VES', 40, 'prueba-065',
        116, 4640, 4000, 640, 4640);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values ('aaaa0065-0000-4000-8000-00000000000a', 'aaaa0065-0000-4000-8000-0000000000a2',
        'aaaa0065-0000-4000-8000-00000000f001', 1, 'aaaa0065-0000-4000-8000-00000000d001',
        'Taladro', 1, 100, 4000, 0.16, 16, 100, 4000, 116, 4640, 116, 'USD', 40, 4640, 'VES',
        'prueba-065', now(), 'sales:document:2:HALF_UP', 'gravado_general', 'gravado');

-- La compra: el proveedor factura USD 50 + 8, a 40.
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0065-0000-4000-8000-00000000e001', 'aaaa0065-0000-4000-8000-00000000000a',
   'aaaa0065-0000-4000-8000-0000000000a2', 'J-PRO-65', 'Proveedor 65', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount)
values ('aaaa0065-0000-4000-8000-00000000f101', 'aaaa0065-0000-4000-8000-00000000000a',
        'aaaa0065-0000-4000-8000-0000000000a2', 'aaaa0065-0000-4000-8000-00000000e001',
        'FP-65', 'CTRL-65', platform.caracas_day(now()), 'posted', now(), 50, 8, 58, true,
        'USD', 'VES', 40, 58, 2320);
insert into public.supplier_invoice_lines
  (tenant_id, company_id, supplier_invoice_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, line_subtotal_transaction,
   line_total_transaction, tax_amount, amount_transaction_currency, transaction_currency,
   fx_rate, functional_amount, functional_currency, rate_source, rate_timestamp,
   rounding_policy_id, tax_category_snapshot, tax_treatment)
values ('aaaa0065-0000-4000-8000-00000000000a', 'aaaa0065-0000-4000-8000-0000000000a2',
        'aaaa0065-0000-4000-8000-00000000f101', 1, 'aaaa0065-0000-4000-8000-00000000d001',
        'Taladros', 1, 50, 2000, 50, 58, 8, 50, 'USD', 40, 2320, 'VES', 'prueba-065', now(),
        'purchases:document:8:HALF_UP', 'gravado_general', 'gravado');

-- ── La planilla ─────────────────────────────────────────────────────────────
select is(
  (select debitos from platform.recompute_iva_period(
     'aaaa0065-0000-4000-8000-0000000000a2', platform.caracas_day(now()),
     platform.caracas_day(now()), 0)),
  640::numeric,
  'la planilla declara el débito en bolívares (640), no los dólares del renglón');

select is(
  (select (d->>'base')::numeric
     from platform.recompute_iva_period(
            'aaaa0065-0000-4000-8000-0000000000a2', platform.caracas_day(now()),
            platform.caracas_day(now()), 0) r,
          jsonb_array_elements(r.detalle) d),
  4000::numeric,
  'sobre la base SIN IVA en bolívares (4.000), no sobre el total con IVA');

select is(
  (select creditos from platform.recompute_iva_period(
     'aaaa0065-0000-4000-8000-0000000000a2', platform.caracas_day(now()),
     platform.caracas_day(now()), 0)),
  320::numeric,
  'y el crédito es el IVA de la compra en bolívares (8 × 40)');

select isnt(
  (select sum(tax_amount) from public.document_lines
    where document_id = 'aaaa0065-0000-4000-8000-00000000f001'),
  640::numeric,
  'VARIANTE ROTA: el IVA del renglón está en dólares — sumarlo declaraba 16');

-- ── Los libros ──────────────────────────────────────────────────────────────
select is(
  (select base_gravada from platform.sales_book(
     'aaaa0065-0000-4000-8000-0000000000a2', platform.caracas_day(now()),
     platform.caracas_day(now()))),
  4000::numeric,
  'libro de ventas: la base gravada en bolívares, junto a un IVA en bolívares');

select results_eq(
  $$select transaction_currency, base_gravada, iva_credito, total_amount
      from platform.purchases_book('aaaa0065-0000-4000-8000-0000000000a2',
                                   platform.caracas_day(now()), platform.caracas_day(now()))$$,
  $$values ('USD'::text, 2000::numeric, 320::numeric, 2320::numeric)$$,
  'libro de compras: todo en bolívares a la tasa de la factura, y dice que venía en USD');

-- ── Lo que se le debe al proveedor ──────────────────────────────────────────
select is(
  platform.supplier_debt_today('aaaa0065-0000-4000-8000-0000000000a2',
                               'aaaa0065-0000-4000-8000-00000000f101'),
  2610.00::numeric,
  'la deuda de hoy con el proveedor, en bolívares y a la tasa de hoy: 58 × 45');

select is(
  (select sum(amount) from platform.ap_aging('aaaa0065-0000-4000-8000-0000000000a2')),
  2610.00::numeric,
  'la antigüedad de cuentas por pagar suma bolívares de hoy, no «58»');

select * from finish();
rollback;
