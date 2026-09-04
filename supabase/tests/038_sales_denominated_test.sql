-- =============================================================================
-- Ladino — pgTAP 38 · La venta se denomina en bolívares (migración 38, ADR-0046)
--
-- Lo que esto prueba, con sus variantes rotas:
--   1. EL GATE: una factura emitida denominada en divisa (transaction ≠
--      functional) RECHAZA con LAD70 — la lista en USD es ancla de precios,
--      no denominación;
--   2. la denominación funcional con procedencia de precio completa VIVE:
--      pricing_currency/fx_rate/source/timestamp congelan la conversión;
--   3. la procedencia A MEDIAS rechaza: los cuatro campos viajan juntos, y
--      pricing_currency igual a la funcional es una conversión que no ocurrió;
--   4. LA EXCEPCIÓN ESPEJO: la NC hereda la denominación del documento
--      HISTÓRICO en divisa que corrige (regla 1) — y sin origen, ni hablar.
-- =============================================================================

begin;
select plan(7);

-- ── Fixtures: una empresa con régimen de formatos libres ─────────────────────
insert into public.tenants (id, name) values
  ('aaaa0038-0000-4000-8000-00000000000a', 'Tenant 38');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0038-0000-4000-8000-0000000000a1', 'aaaa0038-0000-4000-8000-00000000000a',
   'J-38-FISCAL', 'Denominada, C.A.', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0038-0000-4000-8000-00000000e101', 'aaaa0038-0000-4000-8000-00000000000a',
   'aaaa0038-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
insert into public.customers (id, tenant_id, company_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0038-0000-4000-8000-00000000c001', 'aaaa0038-0000-4000-8000-00000000000a',
   'aaaa0038-0000-4000-8000-0000000000a1', 'Cliente 38', 'natural', 'consumidor_final');

-- ── 1. El gate de denominación ───────────────────────────────────────────────
select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'invoice', 'A', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 1,
            101, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'USD', 'VES', 40, 'manual', 116, 4640, 4000, 640, 4640)$$,
  'LAD70',
  null,
  'Una factura denominada en USD RECHAZA: la venta se denomina en funcional (ADR-0046)');

-- ── 2. La denominación funcional con procedencia completa ────────────────────
select lives_ok(
  $$insert into public.documents
      (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       pricing_currency, pricing_fx_rate, pricing_rate_source, pricing_rate_timestamp,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000f001',
            'aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'invoice', 'A', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 1,
            101, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'VES', 'VES', 1, 'identidad',
            'USD', 40, 'BCV', now(),
            4640, 4640, 4000, 640, 4640)$$,
  'La factura en Bs con su procedencia de precio (lista USD, tasa 40, BCV) se emite');

select is(
  (select pricing_currency || '·' || pricing_fx_rate::text || '·' || pricing_rate_source
     from public.documents where id = 'aaaa0038-0000-4000-8000-00000000f001'),
  'USD·40.00000000·BCV',
  'La procedencia quedó congelada: moneda de lista, tasa y fuente');

-- ── 3. La procedencia a medias, o imposible, rechaza ─────────────────────────
select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       pricing_currency, pricing_fx_rate,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'invoice', 'A', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 2,
            102, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'VES', 'VES', 1, 'identidad',
            'USD', 40,
            4640, 4640, 4000, 640, 4640)$$,
  '23514',
  null,
  'Tasa sin fuente ni momento es un origen a medias: los cuatro campos viajan juntos');

select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       pricing_currency, pricing_fx_rate, pricing_rate_source, pricing_rate_timestamp,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'invoice', 'A', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 3,
            103, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'VES', 'VES', 1, 'identidad',
            'VES', 1, 'identidad', now(),
            4640, 4640, 4000, 640, 4640)$$,
  '23514',
  null,
  'pricing_currency igual a la funcional es una conversión que no ocurrió: rechaza');

-- ── 4. La excepción espejo: corregir un histórico en divisa ──────────────────
-- El documento histórico se planta con el trigger APAGADO, porque así es como
-- existen de verdad: entraron antes del gate de ADR-0046. No es un bypass del
-- caso probado — el caso probado es la NC, y esa pasa por el trigger encendido.
alter table public.documents disable trigger documents_02_issuance;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   control_number, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0038-0000-4000-8000-00000000f0ff',
        'aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
        'invoice', 'H', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', '2026-08-01', 99,
        199, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038-historico',
        'USD', 'VES', 40, 'BCV', 100, 4000, 4000, 0, 4000);
alter table public.documents enable trigger documents_02_issuance;

select lives_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version, source_document_id,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'credit_note', 'H', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 1,
            201, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'aaaa0038-0000-4000-8000-00000000f0ff',
            'USD', 'VES', 40, 'BCV', 100, 4000, 4000, 0, 4000)$$,
  'La NC en USD contra el histórico en USD VIVE: la corrección es espejo del corregido');

select throws_ok(
  $$insert into public.documents
      (tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
       control_number, regime_version_id, rules_version,
       transaction_currency, functional_currency, fx_rate, rate_source,
       amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
    values ('aaaa0038-0000-4000-8000-00000000000a', 'aaaa0038-0000-4000-8000-0000000000a1',
            'credit_note', 'H', 'aaaa0038-0000-4000-8000-00000000c001', 'issued', now(), 2,
            202, 'aaaa0038-0000-4000-8000-00000000e101', 'test-038',
            'USD', 'VES', 40, 'BCV', 100, 4000, 4000, 0, 4000)$$,
  'LAD70',
  null,
  'Una NC en divisa SIN documento de origen no es espejo de nada: rechaza');

select * from finish();
rollback;
