-- =============================================================================
-- Ladino — pgTAP 99 · LA ND POR IGTF NO ES UNA VENTA; LA RETENCIÓN QUE LLEGA TARDE; EL LIBRO DE
-- VENTAS REGISTRA EL COMPROBANTE SOPORTADO
-- Migraciones 20261002120200_the_igtf_note_is_not_a_sale.sql y 20261002120300 (la marca system_code). Auditoría fiscal, 2.ª ronda:
-- H1 (PA SNAT/2022/000013 arts. 5-6; LIVA art. 34), H4 (PA SNAT/2025/000054 art. 7) y H5
-- (PA SNAT/2025/000054 art. 16 in fine).
--
--   1. con una factura gravada y una ND por IGTF en la quincena, la prorrata NO se activa, y la ND
--      no suma como «no sujeta» en el libro ni en el resumen del art. 72: sale aparte, como IGTF
--      percibido, con su número y control;
--   2. la retención entregada a tiempo cuenta en el período de su fecha; la entregada después de
--      declarar ese período, en el de su entrega (variante: sin fecha de entrega, en el suyo);
--   3. el libro de ventas registra el comprobante en el período de su ENTREGA, en el renglón de su
--      factura o como renglón propio si la factura es de otro período.
-- =============================================================================

begin;
select plan(17);

insert into auth.users (id) values ('aaaa0099-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0099-0000-4000-8000-0000000000aa', true);
insert into public.tenants (id, name) values
  ('aaaa0099-0000-4000-8000-00000000000a', 'Tenant 99');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0099-0000-4000-8000-0000000000a1', 'aaaa0099-0000-4000-8000-00000000000a',
        'J-99-A', 'Especial 99', 'VES', 'especial');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0099-0000-4000-8000-00000000c001', 'aaaa0099-0000-4000-8000-00000000000a',
   'aaaa0099-0000-4000-8000-0000000000a1', 'J-CLI-99', 'Agente 99', 'juridica', 'especial');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code, system_code) values
  ('aaaa0099-0000-4000-8000-00000000d001', 'aaaa0099-0000-4000-8000-00000000000a',
   'aaaa0099-0000-4000-8000-0000000000a1', 'SKU-99', 'Producto 99', 'good', 'active', 'unidad',
   'gravado_general', null),
  -- El producto de SISTEMA de la ND por IGTF, como lo crea emitirNdIgtf (sales.ts): se reconoce
  -- por system_code = 'igtf' (20261002100100), NO por el sku, que lleva un sufijo propio.
  ('aaaa0099-0000-4000-8000-00000000d002', 'aaaa0099-0000-4000-8000-00000000000a',
   'aaaa0099-0000-4000-8000-0000000000a1', 'LADINO-IGTF-99', 'IGTF sobre pagos en divisas',
   'service', 'inactive', 'unidad', 'no_sujeto', 'igtf');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0099-0000-4000-8000-00000000e101', 'aaaa0099-0000-4000-8000-00000000000a',
        'aaaa0099-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
        'especial', '2000-01-01', '2000-01-01', 'pgTAP 99', 'pgtap');

-- f001: factura 1000 + 160 (05-07-2026). f002: ND por IGTF de 30, sobre f001 (06-07-2026).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0099-0000-4000-8000-00000000f001', 'aaaa0099-0000-4000-8000-00000000000a',
   'aaaa0099-0000-4000-8000-0000000000a1', 'invoice', 'A', 'aaaa0099-0000-4000-8000-00000000c001',
   1, 9901, 'issued', '2026-07-05T14:00:00Z', 'aaaa0099-0000-4000-8000-00000000e101', 'test-099',
   null, 'VES', 'VES', 1, 'identidad', 1160, 1160, 1000, 160, 1160),
  ('aaaa0099-0000-4000-8000-00000000f002', 'aaaa0099-0000-4000-8000-00000000000a',
   'aaaa0099-0000-4000-8000-0000000000a1', 'debit_note', 'A',
   'aaaa0099-0000-4000-8000-00000000c001', 1, 9902, 'issued', '2026-07-06T14:00:00Z',
   'aaaa0099-0000-4000-8000-00000000e101', 'test-099', 'aaaa0099-0000-4000-8000-00000000f001',
   'VES', 'VES', 1, 'identidad', 30, 30, 30, 0, 30);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values
  ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
   'aaaa0099-0000-4000-8000-00000000f001', 1, 'aaaa0099-0000-4000-8000-00000000d001',
   'Producto', 1, 1000, 1000, 0.16, 160, 1000, 1000, 1160, 1160, 1160, 'VES', 1, 1160, 'VES',
   'identidad', now(), 'sales:document:2:HALF_UP', 'gravado_general', 'gravado'),
  ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
   'aaaa0099-0000-4000-8000-00000000f002', 1, 'aaaa0099-0000-4000-8000-00000000d002',
   'IGTF 3 % sobre pago en divisas', 1, 30, 30, 0, 0, 30, 30, 30, 30, 30, 'VES', 1, 30, 'VES',
   'identidad', now(), 'sales:document:2:HALF_UP', 'no_sujeto', 'no_sujeto');

-- ── 1. H1 · la ND por IGTF no es una venta no sujeta ─────────────────────────
select is((select prorrata_pct from platform.recompute_iva_period(
             'aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15', 0, 0)),
  null::numeric,
  'H1: factura gravada + ND por IGTF en la quincena → la prorrata NO se activa (antes: 1000/1030)');
select is((select debitos::text from platform.recompute_iva_period(
             'aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15', 0, 0)),
  '160.00000000', 'el débito es el de la factura: la ND por IGTF no aporta nada');
select is((select count(*)::int from public.document_lines dl
             join public.documents d on d.id = dl.document_id
            where d.company_id = 'aaaa0099-0000-4000-8000-0000000000a1' and dl.tax_amount = 0),
  1, 'variante: la línea de la ND tiene impuesto 0 — sin la exclusión contaría como venta sin impuesto');
select is((select row(base_no_sujeta, total_amount, igtf_percibido)::text
             from platform.sales_book('aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15')
            where kind = 'debit_note'),
  '(0,0,30.00000000)',
  'el libro muestra la ND con su número y control, SIN base no sujeta ni total de venta, y con el IGTF percibido aparte');
select is((select sum(base_no_sujeta)::text
             from platform.sales_book('aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15')),
  '0', 'la columna de lo no sujeto del libro no suma la ND por IGTF');
select is((select count(*)::int
             from platform.sales_book_summary('aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15')
            where concept = 'no_sujeto'),
  0, 'el resumen del art. 72 no trae «no sujeto» por la ND por IGTF');
select is((select igtf_percibido::text
             from platform.sales_book_by_rate('aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15')
            where kind = 'debit_note'),
  '30.00000000', 'el libro por alícuota (el que se exporta) también lleva el IGTF percibido aparte');

-- ── 2. H4 · la retención que llega tarde ─────────────────────────────────────
-- La 1.ª quincena de julio ya está DECLARADA (hoy).
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
values ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
        '2026-07-01', '2026-07-15', 160, 0, 0, 0, 0, 160, 0, '[]', 'iva-declarations/1.1.0',
        'hash-099');
-- R1: a tiempo (sin fecha de entrega → la de la retención). R2: retenida el 12-07, ENTREGADA hoy,
-- después de declarar su quincena.
insert into public.supported_retention_receipts
  (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on, received_on,
   base, rate, amount, functional_currency, ar_valuation)
values
  ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
   'aaaa0099-0000-4000-8000-00000000c001', 'aaaa0099-0000-4000-8000-00000000f001',
   '20260700000001', '2026-07-10', null, 160, 0.75, 120, 'VES', 'invoice_rate'),
  ('aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
   'aaaa0099-0000-4000-8000-00000000c001', 'aaaa0099-0000-4000-8000-00000000f001',
   '20260700000002', '2026-07-12', platform.caracas_day(now()), 160, 1, 160, 'VES', 'invoice_rate');

select is((select retenciones_soportadas::text from platform.recompute_iva_period(
             'aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15', 0, 0)),
  '120.00000000',
  'H4: la quincena de la retención cuenta la entregada a tiempo (120), no la que llegó después de declararla');
select is((select r.retenciones_soportadas::text
             from platform.fiscal_fortnight(platform.caracas_day(now())) q,
                  platform.recompute_iva_period('aaaa0099-0000-4000-8000-0000000000a1',
                                                q.period_from, q.period_to, 0, 0) r),
  '160.00000000', 'la entregada tarde (160) cuenta en el período de su ENTREGA (art. 7)');
select throws_ok($$ insert into public.supported_retention_receipts
                     (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on,
                      received_on, base, rate, amount, functional_currency, ar_valuation)
                   values ('aaaa0099-0000-4000-8000-00000000000a',
                           'aaaa0099-0000-4000-8000-0000000000a1',
                           'aaaa0099-0000-4000-8000-00000000c001',
                           'aaaa0099-0000-4000-8000-00000000f001', '20260700000003',
                           '2026-07-12', '2026-07-11', 160, 0.75, 120, 'VES', 'invoice_rate') $$,
  '23514', null, 'un comprobante no se entrega antes de la retención (CHECK)');

-- ── 3. H5 · el libro de ventas registra el comprobante en el período de su entrega ──
select is((select row(retention_receipt_number, retention_received_on, retention_iva)::text
             from platform.sales_book_with_receipts('aaaa0099-0000-4000-8000-0000000000a1',
                                                    '2026-07-01', '2026-07-15')
            where kind = 'invoice'),
  '(20260700000001,2026-07-10,120.00000000)',
  'H5: el renglón de la factura identifica el comprobante entregado en su período');
select is((select row(status, base_gravada, iva_debito, retention_receipt_number, retention_iva)::text
             from platform.fiscal_fortnight(platform.caracas_day(now())) q,
                  platform.sales_book_with_receipts('aaaa0099-0000-4000-8000-0000000000a1',
                                                    q.period_from, q.period_to)),
  '(comprobante_retencion,0,0,20260700000002,160.00000000)',
  'el entregado en otro período que su factura sale en el de su entrega, como renglón propio con importes en cero');
select is((select count(*)::int
             from platform.sales_book_with_receipts('aaaa0099-0000-4000-8000-0000000000a1',
                                                    '2026-07-01', '2026-07-15')),
  (select count(*)::int
     from platform.sales_book_by_rate('aaaa0099-0000-4000-8000-0000000000a1',
                                      '2026-07-01', '2026-07-15')),
  'sin comprobantes de otro período, el libro con comprobantes tiene los mismos renglones');

-- ── 4. B-1 · una vista previa no «declara» (20261002120400) ──────────────────
-- Una generación HOY de la quincena EN CURSO (todavía abierta) es una vista previa. R3 se retuvo
-- al empezar la quincena y se entregó al empezar la siguiente: se queda en su quincena.
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
   retenciones_soportadas, excedente_anterior, cuota_a_pagar, excedente_siguiente, detalle,
   generator_version, dataset_hash)
select 'aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
       q.period_from, q.period_to, 0, 0, 0, 0, 0, 0, 0, '[]', 'iva-declarations/1.1.0', 'hash-099-previa'
  from platform.fiscal_fortnight(platform.caracas_day(now())) q;
insert into public.supported_retention_receipts
  (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on, received_on,
   base, rate, amount, functional_currency, ar_valuation)
select 'aaaa0099-0000-4000-8000-00000000000a', 'aaaa0099-0000-4000-8000-0000000000a1',
       'aaaa0099-0000-4000-8000-00000000c001', 'aaaa0099-0000-4000-8000-00000000f001',
       '20260700000004', q.period_from, q.period_to + 1, 160, 0.75, 7, 'VES', 'invoice_rate'
  from platform.fiscal_fortnight(platform.caracas_day(now())) q;

select is((select r.retenciones_soportadas::text
             from platform.fiscal_fortnight(platform.caracas_day(now())) q,
                  platform.recompute_iva_period('aaaa0099-0000-4000-8000-0000000000a1',
                                                q.period_from, q.period_to, 0, 0) r),
  '167.00000000',
  'B-1: con solo una vista previa de la quincena abierta, R3 (7) se queda en su quincena: 160 de R2 + 7');
select is((select r.retenciones_soportadas::text
             from platform.fiscal_fortnight(platform.caracas_day(now())) q,
                  platform.fiscal_fortnight(q.period_to + 1) s,
                  platform.recompute_iva_period('aaaa0099-0000-4000-8000-0000000000a1',
                                                s.period_from, s.period_to, 0, 0) r),
  '0', '… y NO se va a la quincena de su entrega');
select ok((select exists (select 1 from public.iva_period_results p
                           where p.company_id = 'aaaa0099-0000-4000-8000-0000000000a1'
                             and p.dataset_hash = 'hash-099-previa'
                             and platform.caracas_day(p.created_at) <= q.period_to + 1)
             from platform.fiscal_fortnight(platform.caracas_day(now())) q),
  'variante: con la regla de la 120200/120300 (sin exigir el cierre) la vista previa contaba como declaración y R3 se habría ido a la siguiente');
-- Y la generación rehecha DESPUÉS de cerrar sí declara: es el caso de julio (R2, arriba), cuya
-- generación de hoy cubre un período ya cerrado y manda R2 al período de su entrega.
select is((select retenciones_soportadas::text from platform.recompute_iva_period(
             'aaaa0099-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-15', 0, 0)),
  '120.00000000',
  'la generación hecha después de cerrar julio sigue declarándolo: R2 no vuelve a la 1.ª quincena de julio');

select * from finish();
rollback;
