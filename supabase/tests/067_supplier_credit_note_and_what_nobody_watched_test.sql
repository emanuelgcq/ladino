-- =============================================================================
-- Ladino — pgTAP 67 · LA NOTA DEL PROVEEDOR, LA ANULADA Y LOS CONTROLES
--                     (migración 67, ADR-0065)
--
-- Lo que se prueba, con las cifras del QA fiscal del 2026-09-17:
--   1. el libro de compras y la planilla dicen LA MISMA cifra con una factura
--      anulada de por medio — la prueba que faltaba;
--   2. la factura anulada aparece en el libro, con importes en CERO
--      (Reglamento art. 70: traza; Ley art. 37: sin crédito fiscal);
--   3. la nota de crédito recibida entra al libro en NEGATIVO y resta en la
--      planilla, en el período de la NOTA (LIVA arts. 56 y 37);
--   4. la cobertura contable ve la nota sin asiento (antes no miraba la tabla);
--   5. VARIANTE ROTA: una línea nueva en un asiento POSTEADO se rechaza;
--   6. el invariante kardex ↔ mayor respeta el corte de la regularización.
-- =============================================================================

begin;
select plan(9);

insert into public.tenants (id, name) values
  ('aaaa0067-0000-4000-8000-00000000000a', 'Tenant 67');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code)
values ('aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-00000000000a',
        'J-67-A', 'Libros 67', 'VES', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
values ('aaaa0067-0000-4000-8000-0000000000b1', 'aaaa0067-0000-4000-8000-00000000000a',
        'aaaa0067-0000-4000-8000-0000000000a1', 'J-67-PROV', 'Proveedor 67', 'nacional',
        'ordinario', 'juridica');

-- Factura buena (1.600 de IVA), factura ANULADA (800) y nota de crédito recibida (800).
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source)
values
  ('aaaa0067-0000-4000-8000-0000000000c1', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-0000000000b1',
   'F67-1', '00-671', '2026-03-10', 'posted', now(), 10000, 1600, 11600, true,
   'VES', 'VES', 1, 'identidad'),
  ('aaaa0067-0000-4000-8000-0000000000c2', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-0000000000b1',
   'F67-2', '00-672', '2026-03-11', 'annulled', now(), 5000, 800, 5800, true,
   'VES', 'VES', 1, 'identidad');
insert into public.supplier_credit_notes
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
   supplier_control_number, note_date, status, posted_at, reason,
   subtotal_amount, tax_amount, total_amount, amount_transaction_currency, transaction_currency,
   fx_rate, functional_amount, functional_currency, rate_source, rate_timestamp,
   rounding_policy_id)
values ('aaaa0067-0000-4000-8000-0000000000d1', 'aaaa0067-0000-4000-8000-00000000000a',
        'aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-0000000000b1',
        'aaaa0067-0000-4000-8000-0000000000c1', 'NC67-1', '00-673', '2026-03-20', 'posted',
        now(), 'Devolución de mercancía', 5000, 800, 5800, 5800, 'VES', 1, 5800, 'VES',
        'identidad', now(), 'money:2:HALF_UP');

-- ── 1 y 2. Libro y planilla dicen lo mismo; la anulada va en cero ───────────
select is(
  (select coalesce(sum(iva_credito), 0)
     from platform.purchases_book('aaaa0067-0000-4000-8000-0000000000a1',
                                  '2026-03-01', '2026-03-31')),
  800::numeric,
  'el libro de compras declara 800: 1.600 de la factura, −800 de la nota, 0 de la anulada');

select is(
  (select creditos from platform.recompute_iva_period('aaaa0067-0000-4000-8000-0000000000a1',
                                                      '2026-03-01', '2026-03-31', 0)),
  800::numeric,
  'y la planilla declara LO MISMO: antes el libro decía 2.400 y la planilla 1.600');

select is(
  (select iva_credito from platform.purchases_book('aaaa0067-0000-4000-8000-0000000000a1',
                                                   '2026-03-01', '2026-03-31')
    where supplier_document_number = 'F67-2'),
  0::numeric,
  'la factura ANULADA está en el libro (traza, Reglamento art. 70) con importes en cero');

select is(
  (select total_amount from platform.purchases_book('aaaa0067-0000-4000-8000-0000000000a1',
                                                    '2026-03-01', '2026-03-31')
    where supplier_document_number = 'NC67-1'),
  -5800::numeric,
  'la nota de crédito recibida entra al libro en NEGATIVO (Reglamento art. 75 lit. a)');

-- ── 3. El período de la nota es el SUYO, no el de la factura ────────────────
select is(
  (select creditos from platform.recompute_iva_period('aaaa0067-0000-4000-8000-0000000000a1',
                                                      '2026-03-01', '2026-03-15', 0)),
  1600::numeric,
  'en la quincena de la FACTURA el crédito es 1.600: la nota resta en el período de la nota');

-- ── 4. La cobertura contable mira la tabla de notas ─────────────────────────
select is(
  (select count(*) from platform.accounting_coverage_gaps('aaaa0067-0000-4000-8000-0000000000a1')
    where source_kind = 'purchase_credit_note'),
  1::bigint,
  'una nota posteada sin asiento es un hueco: antes la cobertura ni miraba esa tabla');

-- ── 5. VARIANTE ROTA: una línea nueva en un asiento POSTEADO ────────────────
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature) values
  ('aaaa0067-0000-4000-8000-0000000000e1', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', '1.1', 'Caja 67', 'activo', 'deudora'),
  ('aaaa0067-0000-4000-8000-0000000000e2', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', '4.1', 'Ventas 67', 'ingreso', 'acreedora');
insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0067-0000-4000-8000-0000000000f1', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', 2026, 3);
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0067-0000-4000-8000-0000000000f2', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-0000000000f1',
   '2026-03-10', 'manual', 'Asiento 67');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
   functional_debit, functional_credit) values
  ('aaaa0067-0000-4000-8000-00000000000a', 'aaaa0067-0000-4000-8000-0000000000a1',
   'aaaa0067-0000-4000-8000-0000000000f2', 1, 'aaaa0067-0000-4000-8000-0000000000e1',
   100, 0, 100, 'VES', 100, 'VES', 100, 0),
  ('aaaa0067-0000-4000-8000-00000000000a', 'aaaa0067-0000-4000-8000-0000000000a1',
   'aaaa0067-0000-4000-8000-0000000000f2', 2, 'aaaa0067-0000-4000-8000-0000000000e2',
   0, 100, 100, 'VES', 100, 'VES', 0, 100);
insert into auth.users (id) values ('aaaa0067-0000-4000-8000-0000000000aa')
  on conflict (id) do nothing;
update public.journal_entries
   set status = 'posted', posted_at = now(),
       posted_by = 'aaaa0067-0000-4000-8000-0000000000aa',
       entry_number = platform.claim_entry_number('aaaa0067-0000-4000-8000-0000000000a1', 2026)
 where id = 'aaaa0067-0000-4000-8000-0000000000f2';

select throws_ok($$
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit)
  values ('aaaa0067-0000-4000-8000-00000000000a', 'aaaa0067-0000-4000-8000-0000000000a1',
          'aaaa0067-0000-4000-8000-0000000000f2', 3, 'aaaa0067-0000-4000-8000-0000000000e1',
          50, 0, 50, 'VES', 50, 'VES', 50, 0)
$$, 'LAD06', null,
  'VARIANTE ROTA: una línea nueva en un asiento POSTEADO se rechaza (antes entraba y rompía el cuadre)');

insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, description) values
  ('aaaa0067-0000-4000-8000-0000000000f3', 'aaaa0067-0000-4000-8000-00000000000a',
   'aaaa0067-0000-4000-8000-0000000000a1', 'aaaa0067-0000-4000-8000-0000000000f1',
   '2026-03-12', 'manual', 'Borrador 67');
select lives_ok($$
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit)
  values ('aaaa0067-0000-4000-8000-00000000000a', 'aaaa0067-0000-4000-8000-0000000000a1',
          'aaaa0067-0000-4000-8000-0000000000f3', 1, 'aaaa0067-0000-4000-8000-0000000000e1',
          50, 0, 50, 'VES', 50, 'VES', 50, 0)
$$, 'y en un BORRADOR se sigue pudiendo: la guarda mira el estado, no prohíbe insertar');

-- ── 6. El invariante kardex ↔ mayor respeta el corte ────────────────────────
insert into public.inventory_ledger_cutovers
  (tenant_id, company_id, cutover_at, kardex_value, ledger_balance, difference, reason)
values ('aaaa0067-0000-4000-8000-00000000000a', 'aaaa0067-0000-4000-8000-0000000000a1',
        now() + interval '1 hour', 0, 0, 0,
        'pgTAP 67: corte por delante de todo lo sembrado');
select is(
  (select kardex from platform.inventory_ledger_gap('aaaa0067-0000-4000-8000-0000000000a1')),
  0::numeric,
  'con el corte por delante, el invariante no cuenta el histórico: nace en cero, no en rojo');

select * from finish();
rollback;
