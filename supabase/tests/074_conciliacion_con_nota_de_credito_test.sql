-- =============================================================================
-- Ladino — pgTAP 74 · LA CONCILIACIÓN LIBRO–MAYOR CON UNA NOTA DE CRÉDITO
-- (RESPUESTA_RECORRIDO_2026-09-24.md ola 0, punto 6(c); hallazgos L-01 y L-02)
--
-- L-01: `platform.sales_book` suma la nota de crédito con el MISMO signo que
-- una factura. L-02: nadie lo vio porque ningún pgTAP de conciliación tenía
-- una NC — el 027 solo prueba con facturas.
--
-- Este fichero es el invariante que falta: una empresa con UNA factura y UNA
-- nota de crédito íntegra sobre ella. El asiento de la NC sí reversa el IVA
-- débito (como debe ser), así que el MAYOR neta a cero. La conducta FINAL que
-- decide el dueño (criterio R-1, sección 2 de RESPUESTA_RECORRIDO): el LIBRO
-- tiene que netear igual — la NC en NEGATIVO — para que
-- `book_ledger_reconciliation` diga `cuadra = true`.
--
-- Hoy no es así: la NC entra en positivo, el libro duplica el débito fiscal
-- (160 + 160 en vez de 160 − 160) y la conciliación se pone en «NO cuadra»
-- aunque el mayor esté perfecto. Van en un bloque `todo()`: el fallo se
-- reporta pero NO rompe el fichero (R-2 de este agente: rojo permitido).
-- =============================================================================

begin;
select plan(4);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0074-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0074-0000-4000-8000-00000000000a', 'Tenant 74');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0074-0000-4000-8000-0000000000a2', 'aaaa0074-0000-4000-8000-00000000000a',
   'J-74-A', 'Empresa 74', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0074-0000-4000-8000-00000000c001', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'J-CLI-74', 'Cliente 74', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code) values
  ('aaaa0074-0000-4000-8000-00000000d001', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'SKU-74', 'Producto 74', 'good', 'unidad',
   'gravado_general');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0074-0000-4000-8000-00000000e101', 'aaaa0074-0000-4000-8000-00000000000a',
        'aaaa0074-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- La factura: 1000 de base gravada + 160 de IVA (16 %) = 1160.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0074-0000-4000-8000-00000000f001', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0074-0000-4000-8000-00000000c001', 1, 5001, 'issued', '2026-09-05T14:00:00Z',
   'aaaa0074-0000-4000-8000-00000000e101', 'test-074', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000f001', 1, 'aaaa0074-0000-4000-8000-00000000d001',
   'Gravada', 1, 1000, 1000, 0.16, 160, 1000, 1000, 1160, 1160, 1160, 'VES', 1, 1160, 'VES',
   'identidad', now(), 'sales:document:8:HALF_UP', 'gravado_general', 'gravado');

-- La nota de crédito ÍNTEGRA sobre esa factura: mismos importes, otra clase de
-- documento. `document_lines` de la NC lleva el MISMO tax_treatment: es la
-- misma línea, corregida.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, source_document_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0074-0000-4000-8000-00000000f002', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'credit_note', 'A',
   'aaaa0074-0000-4000-8000-00000000c001', 1, 5002, 'issued', '2026-09-06T14:00:00Z',
   'aaaa0074-0000-4000-8000-00000000e101', 'test-074', 'aaaa0074-0000-4000-8000-00000000f001',
   'VES', 'VES', 1, 'identidad', 1160, 1160, 1000, 160, 1160);
insert into public.document_lines
  (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional, line_total_transaction,
   line_total_functional, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp, rounding_policy_id,
   tax_category_snapshot, tax_treatment)
values
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000f002', 1, 'aaaa0074-0000-4000-8000-00000000d001',
   'Devolución de lo gravado', 1, 1000, 1000, 0.16, 160, 1000, 1000, 1160, 1160, 1160, 'VES', 1,
   1160, 'VES', 'identidad', now(), 'sales:document:8:HALF_UP', 'gravado_general', 'gravado');

-- ── El mayor: la NC SÍ reversa el IVA débito, como debe ser ─────────────────
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature) values
  ('aaaa0074-0000-4000-8000-00000000a001', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', '2.1', 'IVA débito fiscal', 'pasivo', 'acreedora'),
  ('aaaa0074-0000-4000-8000-00000000a002', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', '1.1', 'Cuentas por cobrar', 'activo', 'deudora'),
  ('aaaa0074-0000-4000-8000-00000000a003', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', '4.1', 'Ventas', 'ingreso', 'acreedora');
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'iva_debit_fiscal', 'aaaa0074-0000-4000-8000-00000000a001');
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0074-0000-4000-8000-00000000b001', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 2026, 9);

-- Asiento de la factura: débito CxC 1160, crédito IVA débito 160 (+ ventas 1000,
-- omitida a propósito: solo importa la cuenta que la conciliación mira).
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description) values
  ('aaaa0074-0000-4000-8000-00000000b101', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'aaaa0074-0000-4000-8000-00000000b001',
   '2026-09-05', 'sales_invoice', 'aaaa0074-0000-4000-8000-00000000f001',
   'fiscal.invoice.issued', 'Factura 1');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b101', 1, 'aaaa0074-0000-4000-8000-00000000a002',
   1160, 0, 1160, 'VES', 1160, 'VES', 1160, 0),
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b101', 2, 'aaaa0074-0000-4000-8000-00000000a001',
   0, 160, 160, 'VES', 160, 'VES', 0, 160),
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b101', 3, 'aaaa0074-0000-4000-8000-00000000a003',
   0, 1000, 1000, 'VES', 1000, 'VES', 0, 1000);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0074-0000-4000-8000-0000000000a1',
       entry_number = 1
 where id = 'aaaa0074-0000-4000-8000-00000000b101';
update public.documents set journal_entry_id = 'aaaa0074-0000-4000-8000-00000000b101'
 where id = 'aaaa0074-0000-4000-8000-00000000f001';

-- Asiento de la NC: exactamente el REVERSO — débito IVA débito 160 (lo baja),
-- crédito CxC 1160 (menos deuda). El mayor neta a CERO para iva_debit_fiscal.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description) values
  ('aaaa0074-0000-4000-8000-00000000b102', 'aaaa0074-0000-4000-8000-00000000000a',
   'aaaa0074-0000-4000-8000-0000000000a2', 'aaaa0074-0000-4000-8000-00000000b001',
   '2026-09-06', 'sales_credit_note', 'aaaa0074-0000-4000-8000-00000000f002',
   'fiscal.credit_note.issued', 'Nota de crédito A-1 sobre la factura A-1');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b102', 1, 'aaaa0074-0000-4000-8000-00000000a001',
   160, 0, 160, 'VES', 160, 'VES', 160, 0),
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b102', 2, 'aaaa0074-0000-4000-8000-00000000a003',
   1000, 0, 1000, 'VES', 1000, 'VES', 1000, 0),
  ('aaaa0074-0000-4000-8000-00000000000a', 'aaaa0074-0000-4000-8000-0000000000a2',
   'aaaa0074-0000-4000-8000-00000000b102', 3, 'aaaa0074-0000-4000-8000-00000000a002',
   0, 1160, 1160, 'VES', 1160, 'VES', 0, 1160);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0074-0000-4000-8000-0000000000a1',
       entry_number = 2
 where id = 'aaaa0074-0000-4000-8000-00000000b102';
update public.documents set journal_entry_id = 'aaaa0074-0000-4000-8000-00000000b102'
 where id = 'aaaa0074-0000-4000-8000-00000000f002';

-- ── Lo que SÍ es verdad hoy: el mayor neta a cero por sí solo ───────────────
select is(
  (select mayor from (
     select coalesce(sum(jl.functional_credit - jl.functional_debit), 0) as mayor
       from public.journal_lines jl
       join public.journal_entries e on e.id = jl.entry_id
      where jl.account_id = 'aaaa0074-0000-4000-8000-00000000a001'
        and e.status = 'posted' and e.posting_date between '2026-09-01' and '2026-09-30'
   ) m),
  0::numeric,
  'el MAYOR ya neta a cero: la NC reversa el IVA débito de la factura, como debe ser');

-- ── L-01 / L-02 ──────────────────────────────────────────────────────────────
-- (El bloque todo() que marcaba L-01/L-02 como rojo permitido se quitó con la
-- migración 20260928120000: las tres aserciones de abajo son las mismas.)

select is(
  (select cuadra from platform.book_ledger_reconciliation(
     'aaaa0074-0000-4000-8000-0000000000a2', '2026-09-01', '2026-09-30')
    where concepto = 'iva_debito_fiscal'),
  true,
  'libro = mayor + cola CON una nota de crédito de por medio: tiene que cuadrar igual que sin ella');

select is(
  (select base_gravada from platform.sales_book('aaaa0074-0000-4000-8000-0000000000a2',
             '2026-09-01', '2026-09-30') where kind = 'credit_note'),
  -1000::numeric,
  'la NC entra al libro de ventas con la base gravada en NEGATIVO (criterio R-1)');

select is(
  (select iva_debito from platform.sales_book('aaaa0074-0000-4000-8000-0000000000a2',
             '2026-09-01', '2026-09-30') where kind = 'credit_note'),
  -160::numeric,
  'y el IVA débito de la NC también en NEGATIVO: es lo que hace que libro y mayor cuadren');

select * from finish();
rollback;
