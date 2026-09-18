-- =============================================================================
-- Ladino — pgTAP 69 · LA COMPRA SIN SOPORTE FISCAL (migración 69, ADR-0066 §2)
--
-- Lo que se prueba:
--   1. el libro de compras trae la factura con soporte y NO la compra sin él;
--   2. sin soporte no puede haber IVA que declarar: el CHECK lo rechaza;
--   3. sin soporte no se exige identificación del emisor…
--   4. …y CON soporte se sigue exigiendo, como antes de esta migración;
--   5. dos compras SIN número del mismo proveedor conviven (antes chocaban con
--      un 409 que no significaba nada)…
--   6. …y dos con el MISMO número siguen siendo el doble pago que la llave
--      existe para impedir.
-- =============================================================================

begin;
select plan(6);

insert into public.tenants (id, name) values
  ('aaaa0069-0000-4000-8000-00000000000a', 'Tenant 69');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0069-0000-4000-8000-0000000000a1', 'aaaa0069-0000-4000-8000-00000000000a',
        'J-69-A', 'Bodega 69', 'VES', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0069-0000-4000-8000-0000000000b1', 'aaaa0069-0000-4000-8000-00000000000a',
        'aaaa0069-0000-4000-8000-0000000000a1', 'J-69-PROV', 'Proveedor 69', 'nacional',
        'ordinario', 'juridica');

-- La factura de siempre (con soporte) y la compra del mercado (sin soporte, sin
-- número, sin control, sin IVA).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values ('aaaa0069-0000-4000-8000-0000000000c1', 'aaaa0069-0000-4000-8000-00000000000a',
        'aaaa0069-0000-4000-8000-0000000000a1', 'aaaa0069-0000-4000-8000-0000000000b1',
        'F69-1', '00-691', current_date, 'posted', now(), 10000, 1600, 11600, true,
        'VES', 'VES', 1, 'identidad');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, fiscal_support, transaction_currency, functional_currency, fx_rate,
   rate_source)
values ('aaaa0069-0000-4000-8000-0000000000c2', 'aaaa0069-0000-4000-8000-00000000000a',
        'aaaa0069-0000-4000-8000-0000000000a1', 'aaaa0069-0000-4000-8000-0000000000b1',
        null, null, current_date, 'posted', now(), 5000, 0, 5000, false, false,
        'VES', 'VES', 1, 'identidad');

-- ── 1. El libro relaciona documentos; sin documento no hay fila ─────────────
select is(
  (select count(*) from platform.purchases_book('aaaa0069-0000-4000-8000-0000000000a1',
                                                current_date, current_date)),
  1::bigint,
  'el libro trae la factura con soporte y NO la compra sin soporte: no hay documento que relacionar');

-- ── 2. Sin soporte no hay IVA que declarar ─────────────────────────────────
select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
     tax_is_recoverable, fiscal_support, transaction_currency, functional_currency, fx_rate,
     rate_source)
  values ('aaaa0069-0000-4000-8000-00000000000a', 'aaaa0069-0000-4000-8000-0000000000a1',
          'aaaa0069-0000-4000-8000-0000000000b1', null, null, current_date, 'posted', now(),
          5000, 800, 5800, true, false, 'VES', 'VES', 1, 'identidad')
$$, '23514', null,
  'una compra SIN soporte con IVA se rechaza al insertar: un crédito fiscal sin documento no nace');

-- ── 3 y 4. La identificación se exige a lo que va al libro ─────────────────
select lives_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
     tax_is_recoverable, fiscal_support, transaction_currency, functional_currency, fx_rate,
     rate_source)
  values ('aaaa0069-0000-4000-8000-00000000000a', 'aaaa0069-0000-4000-8000-0000000000a1',
          'aaaa0069-0000-4000-8000-0000000000b1', null, null, current_date, 'posted', now(),
          3000, 0, 3000, false, false, 'VES', 'VES', 1, 'identidad')
$$, 'sin soporte no se pide identificación del emisor: no la hay, y no va al libro');

select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
     tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
  values ('aaaa0069-0000-4000-8000-00000000000a', 'aaaa0069-0000-4000-8000-0000000000a1',
          'aaaa0069-0000-4000-8000-0000000000b1', 'F69-9', null, current_date, 'posted', now(),
          1000, 160, 1160, true, 'VES', 'VES', 1, 'identidad')
$$, '23514', null,
  'CON soporte se sigue exigiendo número de control o referencia: eso SÍ va al libro');

-- ── 5 y 6. La llave del doble pago, ahora condicional ──────────────────────
select is(
  (select count(*) from public.supplier_invoices
    where company_id = 'aaaa0069-0000-4000-8000-0000000000a1'
      and supplier_document_number is null),
  2::bigint,
  'dos compras sin número del mismo proveedor conviven: son dos compras, no un duplicado');

select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
     tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
  values ('aaaa0069-0000-4000-8000-00000000000a', 'aaaa0069-0000-4000-8000-0000000000a1',
          'aaaa0069-0000-4000-8000-0000000000b1', 'f69-1', '00-692', current_date, 'posted',
          now(), 10000, 1600, 11600, true, 'VES', 'VES', 1, 'identidad')
$$, '23505', null,
  'y el mismo número del mismo proveedor sigue siendo el doble pago que la llave impide');

select * from finish();
rollback;
