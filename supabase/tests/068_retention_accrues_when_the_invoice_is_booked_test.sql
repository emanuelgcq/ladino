-- =============================================================================
-- Ladino — pgTAP 68 · LA RETENCIÓN NACE AL REGISTRAR LA FACTURA
--                     (migración 68, ADR-0065 §3)
--
-- Lo que se prueba:
--   1. la plantilla de COMPRA acredita al proveedor el NETO y al fisco lo
--      retenido, en el mismo asiento;
--   2. la del PAGO ya no crea el pasivo con el fisco: ya existe;
--   3. el saldo del auxiliar descuenta la retención…
--   4. …convirtiéndola a la moneda de la factura, que es la trampa: la
--      retención vive en bolívares y la factura puede estar en dólares;
--   5. y pagando ese neto la factura queda saldada, sin residuo.
-- =============================================================================

begin;
select plan(6);

-- ── 1 y 2. Las plantillas del preset, que es de donde salen todas ───────────
select is(
  (select l.amount_source
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'purchase_invoice'
      and l.account_purpose = 'ap_general'),
  'net_amount',
  'la compra le acredita al proveedor el NETO: lo retenido ya no se le debe a él');

select is(
  (select count(*)
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'purchase_invoice'
      and l.account_purpose in ('retention_iva_payable', 'retention_islr_payable')
      and l.side = 'credit'),
  2::bigint,
  'y le acredita al FISCO lo retenido de IVA y de ISLR, en el asiento de la factura');

select is(
  (select count(*)
     from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico' and e.source_kind = 'payment_made'
      and l.account_purpose in ('retention_iva_payable', 'retention_islr_payable')),
  0::bigint,
  'el PAGO ya no crea el pasivo con el fisco: nació con la factura (PA SNAT/2025/000054)');

-- ── El auxiliar ─────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0068-0000-4000-8000-00000000000a', 'Tenant 68');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0068-0000-4000-8000-0000000000a1', 'aaaa0068-0000-4000-8000-00000000000a',
        'J-68-A', 'Retenciones 68', 'VES', 'especial');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0068-0000-4000-8000-0000000000b1', 'aaaa0068-0000-4000-8000-00000000000a',
        'aaaa0068-0000-4000-8000-0000000000a1', 'J-68-PROV', 'Proveedor 68', 'nacional',
        'ordinario', 'juridica');

-- Una factura en bolívares (11 600, con 1 200 retenidos) y una en dólares (116, con 480
-- BOLÍVARES retenidos: la retención se calcula sobre la base convertida, migración 65).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount, retention_total,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0068-0000-4000-8000-0000000000c1', 'aaaa0068-0000-4000-8000-00000000000a',
   'aaaa0068-0000-4000-8000-0000000000a1', 'aaaa0068-0000-4000-8000-0000000000b1',
   'F68-1', '00-681', current_date, 'posted', now(), 10000, 1600, 11600, 1200, true,
   'VES', 'VES', 1, 'identidad'),
  ('aaaa0068-0000-4000-8000-0000000000c2', 'aaaa0068-0000-4000-8000-00000000000a',
   'aaaa0068-0000-4000-8000-0000000000a1', 'aaaa0068-0000-4000-8000-0000000000b1',
   'F68-2', '00-682', current_date, 'posted', now(), 100, 16, 116, 480, true,
   'USD', 'VES', 40, 'prueba');

select is(
  platform.supplier_invoice_balance('aaaa0068-0000-4000-8000-0000000000a1',
                                    'aaaa0068-0000-4000-8000-0000000000c1'::uuid),
  10400::numeric,
  'al proveedor se le deben 10 400: los 1 200 retenidos se le deben al fisco desde el registro');

-- LA TRAMPA. `retention_total` está en BOLÍVARES y `total_amount` en DÓLARES: restarlos sin
-- convertir daría 116 − 480 = −364, un saldo negativo con toda la cara de ser correcto. Es el
-- mismo error de granularidad que este proyecto ya cometió con las fechas, en moneda.
select is(
  platform.supplier_invoice_balance('aaaa0068-0000-4000-8000-0000000000a1',
                                    'aaaa0068-0000-4000-8000-0000000000c2'::uuid),
  104::numeric,
  'y en dólares se le deben 104: los 480 Bs retenidos son 12 USD a la tasa de la factura');

-- ── El pago del neto salda la factura, sin residuo ─────────────────────────
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0068-0000-4000-8000-0000000000ca', 'aaaa0068-0000-4000-8000-00000000000a',
   'aaaa0068-0000-4000-8000-0000000000a1', 'Banco 68', 'VES', 'bank');
insert into public.supplier_payments
  (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
   gross_amount, retained_amount, net_amount, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, account_id)
values
  ('aaaa0068-0000-4000-8000-00000000000a', 'aaaa0068-0000-4000-8000-0000000000a1',
   'aaaa0068-0000-4000-8000-0000000000b1', 'aaaa0068-0000-4000-8000-0000000000c1',
   now(), 'transferencia', 10400, 0, 10400, 10400, 'VES', 1, 10400, 'VES', 'identidad', now(),
   'aaaa0068-0000-4000-8000-0000000000ca');
select is(
  platform.supplier_invoice_balance('aaaa0068-0000-4000-8000-0000000000a1',
                                    'aaaa0068-0000-4000-8000-0000000000c1'::uuid),
  0::numeric,
  'pagado el neto, la factura queda saldada: el pago no retiene nada porque ya se retuvo');

select * from finish();
rollback;
