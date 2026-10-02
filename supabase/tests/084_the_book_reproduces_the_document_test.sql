-- =============================================================================
-- 084 — el libro reproduce el documento; el documento se guarda de una manera
--
-- Migraciones 20260928170100 y 20260928170200 (revisión y re-revisión de la familia «documento
-- de identidad», 2026-09-28):
--   · hallazgo 1 / B1: cambiar el RIF, el nombre o el TIPO de un cliente NO cambia el libro de
--     ventas de un período ya emitido (lee los snapshots del documento); un cliente emitido SIN
--     RIF sigue sin RIF aunque después se le cargue; solo el documento anterior a los snapshots
--     (sin snapshot del nombre) cae al maestro;
--   · B2: el libro de compras da el snapshot de la factura aunque el maestro cambie, y la
--     factura sin snapshot (anterior a 20260928170100) da el maestro;
--   · B3: el snapshot del tipo de contribuyente se fija al emitir y después no cambia (LAD68);
--   · hallazgo 4: el mismo documento con otra grafía no entra dos veces, ni en proveedores ni en
--     empresas (índices únicos normalizados); los marcadores PEND- quedan fuera;
--   · hallazgo 10: la reparación P-02 lista lo que normaliza a vacío y no toca nada.
-- =============================================================================
begin;
select plan(20);

insert into public.tenants (id, name) values
  ('aaaa0084-0000-4000-8000-00000000000a', 'Tenant 84');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0084-0000-4000-8000-0000000000a1', 'aaaa0084-0000-4000-8000-00000000000a',
   'J408400001', 'Empresa 84', 'VES');
insert into public.customers
  (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
values
  ('aaaa0084-0000-4000-8000-0000000000c1', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', 'J408887776', 'Bodegón 84', 'juridica', 'ordinario');
-- Desde 20260928190000 (ADR-0072) emitir exige el tipo de contribuyente declarado vigente.
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a1', 'ordinario',
        '2026-01-01', null, 'Fixture pgTAP 84', 'test-084');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0084-0000-4000-8000-0000000000f1', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
-- La factura, con el adquirente congelado como se emitió.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   control_number, regime_version_id, rules_version,
   issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
   customer_name_snapshot, customer_tax_id_snapshot, customer_taxpayer_type_snapshot,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0084-0000-4000-8000-0000000000d1', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a1', 'invoice', 'A',
        'aaaa0084-0000-4000-8000-0000000000c1', 'issued', '2026-09-10 15:00-04', 1, 1,
        'aaaa0084-0000-4000-8000-0000000000f1', 'pgtap-084',
        'Empresa 84', 'J408400001', 'Calle 84, Valencia',
        'Bodegón 84', 'J408887776', 'ordinario',
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);

-- ── 1. Ventas: el maestro cambia después de emitir; el libro, no ────────────
update public.customers set tax_id = 'J409999990', legal_name = 'Otro nombre 84'
 where id = 'aaaa0084-0000-4000-8000-0000000000c1';
select is((select customer_tax_id from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')),
          'J408887776', 'el libro de ventas imprime el RIF del documento, no el del maestro vivo');
select is((select customer_name from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')),
          'Bodegón 84', 'y el nombre del documento');

-- ── 1-bis. B1: emitido SIN RIF, sigue sin RIF; anterior a los snapshots, del maestro ─
insert into public.customers
  (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
values
  ('aaaa0084-0000-4000-8000-0000000000c3', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', null, 'Natural 84', 'natural', 'consumidor_final'),
  ('aaaa0084-0000-4000-8000-0000000000c4', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', 'J408400044', 'Antiguo 84', 'juridica', 'ordinario');
-- La factura emitida SIN RIF del adquirente es la de un talonario de CONTINGENCIA: desde la
-- migración 20260928190400 una factura nueva sobre forma libre exige al adquirente identificado
-- (art. 13.7, P-57), y la contingencia refleja un papel que ya existe (A-3, 20260928190500). Lo que
-- se prueba no cambia: el libro reproduce el snapshot SIN RIF aunque después se le cargue.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0084-0000-4000-8000-0000000000b1', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a1', null, 'contingencia-84', 1, 50, 1,
        'Talonario físico 84');
insert into public.contingency_ranges (tenant_id, company_id, fiscal_number_range_id, reason,
                                       failure_started_at)
values ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a1',
        'aaaa0084-0000-4000-8000-0000000000b1', 'Falla de internet', '2026-09-11 08:00-04');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   control_number, regime_version_id, rules_version,
   issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
   customer_name_snapshot, customer_tax_id_snapshot, customer_taxpayer_type_snapshot,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0084-0000-4000-8000-0000000000d3', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a1', 'invoice', 'contingencia-84',
        'aaaa0084-0000-4000-8000-0000000000c3', 'issued', '2026-09-11 15:00-04', 3, 3,
        'aaaa0084-0000-4000-8000-0000000000f1', 'pgtap-084',
        'Empresa 84', 'J408400001', 'Calle 84, Valencia',
        'Natural 84', null, 'consumidor_final',
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116),
       -- El documento ANTERIOR a los snapshots: ninguno lleno.
       ('aaaa0084-0000-4000-8000-0000000000d4', 'aaaa0084-0000-4000-8000-00000000000a',
        'aaaa0084-0000-4000-8000-0000000000a1', 'invoice', 'A',
        'aaaa0084-0000-4000-8000-0000000000c4', 'issued', '2026-09-12 15:00-04', 4, 4,
        'aaaa0084-0000-4000-8000-0000000000f1', 'pgtap-084',
        'Empresa 84', 'J408400001', 'Calle 84, Valencia',
        null, null, null,
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
update public.customers set tax_id = 'V18222333', taxpayer_type_code = 'ordinario'
 where id = 'aaaa0084-0000-4000-8000-0000000000c3';
select is((select customer_tax_id from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where document_id = 'aaaa0084-0000-4000-8000-0000000000d3'),
          null, 'B1: emitido sin RIF, el libro sigue sin RIF aunque después se le cargue');
select is((select customer_taxpayer_type from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where document_id = 'aaaa0084-0000-4000-8000-0000000000d3'),
          'consumidor_final', 'B3: y con el tipo de contribuyente del día de la emisión');
select is((select customer_tax_id from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where document_id = 'aaaa0084-0000-4000-8000-0000000000d4'),
          'J408400044', 'B1: el documento anterior a los snapshots cae al maestro');

-- ── 1-ter. B3: el tipo del documento 1 se congela ─────────────────────────────
update public.customers set taxpayer_type_code = 'especial'
 where id = 'aaaa0084-0000-4000-8000-0000000000c1';
select is((select customer_taxpayer_type from platform.sales_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where document_id = 'aaaa0084-0000-4000-8000-0000000000d1'),
          'ordinario', 'B3: cambiar el tipo del cliente no cambia el libro de un período emitido');
select throws_ok($$ update public.documents set customer_taxpayer_type_snapshot = 'especial'
                     where id = 'aaaa0084-0000-4000-8000-0000000000d1' $$,
  'LAD68', null, 'B3: el snapshot del tipo, una vez fijado al emitir, no cambia');

-- ── 2. Compras: la factura con snapshot y la anterior sin él ────────────────
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
values
  ('aaaa0084-0000-4000-8000-0000000000b1', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', 'J405551234', 'Proveedor 84', 'nacional',
   'juridica', 'ordinario');
select has_column('public', 'supplier_invoices', 'supplier_tax_id_snapshot',
                  'la factura de proveedor guarda el RIF como se registró');
select has_column('public', 'supplier_invoices', 'supplier_name_snapshot',
                  'y la razón social');
select is((select count(*)::int from information_schema.columns
            where table_schema = 'public' and table_name = 'supplier_invoices'
              and column_name like 'supplier_%_snapshot' and is_nullable = 'YES'),
          2, 'los dos snapshots son nullable: sin backfill de lo ya posteado');

-- B2: una factura CON snapshot y otra SIN él (anterior a 20260928170100); después cambia el
-- maestro del proveedor.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount,
   supplier_tax_id_snapshot, supplier_name_snapshot) values
  ('aaaa0084-0000-4000-8000-00000000f101', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', 'aaaa0084-0000-4000-8000-0000000000b1',
   'FP-84-1', 'CTRL-84-1', '2026-09-10', 'posted', now(), 100, 16, 116, true,
   'VES', 'VES', 1, 116, 116, 'J405551234', 'Proveedor 84'),
  ('aaaa0084-0000-4000-8000-00000000f102', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', 'aaaa0084-0000-4000-8000-0000000000b1',
   'FP-84-2', 'CTRL-84-2', '2026-09-11', 'posted', now(), 100, 16, 116, true,
   'VES', 'VES', 1, 116, 116, null, null);
update public.suppliers set tax_id = 'J409999991', legal_name = 'Proveedor 84 renombrado'
 where id = 'aaaa0084-0000-4000-8000-0000000000b1';
select is((select supplier_tax_id || ' · ' || supplier_name from platform.purchases_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where invoice_id = 'aaaa0084-0000-4000-8000-00000000f101'),
          'J405551234 · Proveedor 84',
          'B2: la factura con snapshot da el proveedor como se registró, aunque el maestro cambie');
select is((select supplier_tax_id || ' · ' || supplier_name from platform.purchases_book(
             'aaaa0084-0000-4000-8000-0000000000a1', '2026-09-01', '2026-09-30')
            where invoice_id = 'aaaa0084-0000-4000-8000-00000000f102'),
          'J409999991 · Proveedor 84 renombrado',
          'B2: la factura sin snapshot (anterior) da el maestro');
-- El maestro vuelve a su RIF: el caso del índice de abajo choca contra él.
update public.suppliers set tax_id = 'J405551234'
 where id = 'aaaa0084-0000-4000-8000-0000000000b1';

-- ── 3. Hallazgo 4: el mismo documento no entra dos veces ─────────────────────
select throws_ok($$ insert into public.suppliers
    (tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
  values ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a1',
          'J.40555123.4', 'El mismo, con puntos', 'nacional', 'juridica', 'ordinario') $$,
  '23505', null, 'proveedores: la otra grafía del mismo RIF choca (lower() la dejaba pasar)');
select throws_ok($$ insert into public.companies (tenant_id, tax_id, legal_name)
  values ('aaaa0084-0000-4000-8000-00000000000a', 'j-40840000-1', 'Empresa 84 bis') $$,
  '23505', null, 'empresas: la otra grafía del mismo RIF en el tenant choca');
select lives_ok($$ insert into public.companies (tenant_id, tax_id, legal_name)
  values ('aaaa0084-0000-4000-8000-00000000000a', 'PEND-0084AAAA01', 'Sin RIF 1'),
         ('aaaa0084-0000-4000-8000-00000000000a', 'PEND-0084AAAA02', 'Sin RIF 2') $$,
  'los marcadores PEND- quedan fuera del índice normalizado');
select ok(exists (select 1 from pg_indexes where schemaname = 'public'
                   and indexname = 'suppliers_company_tax_id_normalized_uidx'
                   and indexdef like '%regexp_replace%'),
          'el único de proveedores es sobre la forma normalizada');

-- VARIANTE ROTA: sin el índice normalizado, la otra grafía entra (el viejo lower() no la ve).
drop index public.suppliers_company_tax_id_normalized_uidx;
select lives_ok($$ insert into public.suppliers
    (tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code, taxpayer_type_code)
  values ('aaaa0084-0000-4000-8000-00000000000a', 'aaaa0084-0000-4000-8000-0000000000a1',
          'J.40555123.4', 'El mismo, con puntos', 'nacional', 'juridica', 'ordinario') $$,
  'sin el índice nuevo el duplicado entra: el throws_ok de arriba mide el índice nuevo');

-- ── 4. Hallazgo 10: lo que normaliza a vacío se lista y no se toca nada ─────
-- (El duplicado de la variante rota también se listaría: se retira antes.)
delete from public.suppliers where tax_id = 'J.40555123.4';
insert into public.customers
  (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
values
  ('aaaa0084-0000-4000-8000-0000000000c2', 'aaaa0084-0000-4000-8000-00000000000a',
   'aaaa0084-0000-4000-8000-0000000000a1', '---', 'Cliente vacío 84', 'natural',
   'consumidor_final');
select throws_like($$ select * from platform.tax_id_normalization_repair() $$,
  '%normalizan a vacío%cliente aaaa0084-0000-4000-8000-0000000000c2: «---»%',
  'la reparación lista el documento que normaliza a vacío');
select is((select tax_id from public.customers where id = 'aaaa0084-0000-4000-8000-0000000000c2'),
          '---', 'y no tocó nada');
select is((select tax_id from public.customers where id = 'aaaa0084-0000-4000-8000-0000000000c1'),
          'J409999990', 'ni siquiera lo que sí se podía normalizar');

select * from finish();
rollback;
