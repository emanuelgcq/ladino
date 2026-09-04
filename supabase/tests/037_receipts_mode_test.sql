-- =============================================================================
-- Ladino — pgTAP 37 · MODO RECIBOS (migración 37) — RIGOR MÁXIMO
--
-- Lo que esto prueba, con sus variantes rotas:
--   1. el régimen sin_facturacion existe: {receipt} / internal_only;
--   2. EL GATE DE KIND: bajo formatos_libres un receipt NO se emite (nadie con
--      RIF vende por recibo — uso evasor), y bajo sin_facturacion una invoice
--      NO se emite (sin RIF no existe factura, art. 13.5). Ambos LAD49;
--   3. el receipt legítimo se emite: correlativo propio, SIN número de
--      control, y su línea acepta el tratamiento no_fiscal;
--   4. el coverage EXIGE asiento-o-cola también al recibo (el invariante
--      cambió su enunciado), y el libro de ventas NO lo ve.
-- =============================================================================

begin;
select plan(8);

-- ── Fixtures: dos empresas, dos regímenes ────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0037-0000-4000-8000-00000000000a', 'Tenant 37');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0037-0000-4000-8000-0000000000a1', 'aaaa0037-0000-4000-8000-00000000000a',
   'J-37-FISCAL', 'Con RIF, C.A.', 'ordinario'),
  ('aaaa0037-0000-4000-8000-0000000000a2', 'aaaa0037-0000-4000-8000-00000000000a',
   'PENDIENTE-37', 'Sin RIF todavía', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0037-0000-4000-8000-00000000e101', 'aaaa0037-0000-4000-8000-00000000000a',
   'aaaa0037-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01'),
  ('aaaa0037-0000-4000-8000-00000000e102', 'aaaa0037-0000-4000-8000-00000000000a',
   'aaaa0037-0000-4000-8000-0000000000a2', 'sin_facturacion', '2026-01-01');
insert into public.customers (id, tenant_id, company_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0037-0000-4000-8000-00000000c001', 'aaaa0037-0000-4000-8000-00000000000a',
   'aaaa0037-0000-4000-8000-0000000000a1', 'Cliente 37 A', 'natural', 'consumidor_final'),
  ('aaaa0037-0000-4000-8000-00000000c002', 'aaaa0037-0000-4000-8000-00000000000a',
   'aaaa0037-0000-4000-8000-0000000000a2', 'Cliente 37 B', 'natural', 'consumidor_final');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0037-0000-4000-8000-00000000d001', 'aaaa0037-0000-4000-8000-00000000000a',
   'aaaa0037-0000-4000-8000-0000000000a2', 'P37', 'Producto 37', 'service', 'active',
   'unidad', 'gravado_general');

-- ── 1. El régimen ────────────────────────────────────────────────────────────
select is(
  (select numbering_mode || '·' || array_to_string(allowed_kinds, ',')
     from public.fiscal_regimes where code = 'sin_facturacion'),
  'internal_only·receipt',
  'sin_facturacion existe: internal_only y SOLO receipt');

-- ── 2. El gate de kind, en las dos direcciones ───────────────────────────────
select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0037-0000-4000-8000-00000000000a', 'aaaa0037-0000-4000-8000-0000000000a1',
            'receipt', 'A', 'aaaa0037-0000-4000-8000-00000000c001', 'issued', now(), 1,
            'aaaa0037-0000-4000-8000-00000000e101', 'test-037',
            'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100)$$,
  'LAD49',
  null,
  'Con RIF (formatos_libres) un RECIBO no se emite: el kind no está permitido');

select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0037-0000-4000-8000-00000000000a', 'aaaa0037-0000-4000-8000-0000000000a2',
            'invoice', 'A', 'aaaa0037-0000-4000-8000-00000000c002', 'issued', now(), 1,
            'aaaa0037-0000-4000-8000-00000000e102', 'test-037',
            'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116)$$,
  'LAD49',
  null,
  'Sin RIF (sin_facturacion) una FACTURA no se emite: art. 13.5');

-- ── 3. El recibo legítimo ────────────────────────────────────────────────────
select lives_ok(
  $$insert into public.documents
      (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0037-0000-4000-8000-00000000f001',
            'aaaa0037-0000-4000-8000-00000000000a', 'aaaa0037-0000-4000-8000-0000000000a2',
            'receipt', 'R', 'aaaa0037-0000-4000-8000-00000000c002', 'issued', now(), 1,
            'aaaa0037-0000-4000-8000-00000000e102', 'test-037',
            'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100)$$,
  'El recibo bajo sin_facturacion se emite: correlativo propio y SIN número de control');

select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0037-0000-4000-8000-00000000000a', 'aaaa0037-0000-4000-8000-0000000000a2',
            'receipt', 'R', 'aaaa0037-0000-4000-8000-00000000c002', 'issued', now(), 2,
            777, 'aaaa0037-0000-4000-8000-00000000e102', 'test-037',
            'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100)$$,
  'LAD49',
  null,
  'Un recibo CON número de control es un dato inventado: internal_only lo rechaza');

select lives_ok(
  $$insert into public.document_lines
      (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
       unit_price_transaction, unit_price_functional, line_subtotal_transaction,
       line_subtotal_functional, line_total_transaction, line_total_functional,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id,
       tax_rate_snapshot, tax_amount, tax_treatment)
    values ('aaaa0037-0000-4000-8000-00000000000a', 'aaaa0037-0000-4000-8000-0000000000a2',
            'aaaa0037-0000-4000-8000-00000000f001', 1,
            'aaaa0037-0000-4000-8000-00000000d001', 'Producto 37', 1,
            100, 100, 100, 100, 100, 100, 100, 'VES', 1, 100, 'VES', 'identidad', now(),
            'sales:document:8:HALF_UP', 0, 0, 'no_fiscal')$$,
  'La línea del recibo acepta el tratamiento no_fiscal: sin regla, y el snapshot lo dice');

-- ── 4. Coverage lo exige; el libro no lo ve ──────────────────────────────────
select is(
  (select problem from platform.accounting_coverage_gaps('aaaa0037-0000-4000-8000-0000000000a2')
    where source_kind = 'sales_receipt'
      and source_id = 'aaaa0037-0000-4000-8000-00000000f001'),
  'missing',
  'El coverage EXIGE asiento-o-cola también al recibo: el enunciado del invariante creció');

select is(
  (select count(*) from platform.sales_book('aaaa0037-0000-4000-8000-0000000000a2',
                                            current_date - 1, current_date + 1)),
  0::bigint,
  'El libro de ventas NO ve recibos: un documento no fiscal jamás pisa un libro fiscal');

select * from finish();
rollback;
