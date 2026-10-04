-- =============================================================================
-- pgTAP 113 · EL LIBRO DE COMPRAS CONCILIA A LOS DOS LADOS DEL CORTE DEL CÉNTIMO
-- (ADR-0075 §7 · L-02 «libro fiscal = mayor + cola» · migración 20261003190400)
--
-- Una compra en DIVISA registrada ANTES del corte se asentó a 8 decimales; la regularización del
-- céntimo corrige el saldo con un asiento fechado HOY. Con el libro convirtiendo al céntimo en
-- TODOS los períodos, la conciliación del período viejo descuadraba por la fracción (y la del
-- período de la regularización, por el asiento que la lleva). La historia entera cuadraba, y eso
-- lo tapaba. La regla (20261003190400):
--   · el renglón de un documento registrado ANTES del corte se reproduce como se generó, a 8
--     decimales; el de uno posterior va al céntimo. El corte es el instante del acta
--     `accounting.cent_regularized` más antigua de la empresa, contra el `created_at` del documento
--     (instante contra instante);
--   · la declaración (`recompute_iva_period`) convierte igual que el libro a los dos lados;
--   · la conciliación no cuenta en el mayor el asiento de la regularización del céntimo, que no
--     es un hecho fiscal (se reconoce por el registro privado, no por una etiqueta);
--   · una empresa SIN acta convierte todo al céntimo: si tuviera fracciones heredadas, `cent_gaps`
--     ya la señala hasta que regularice.
-- now() es constante en la transacción: «posterior al corte» se fabrica con created_at + 1 min.
-- =============================================================================
begin;
select plan(15);

insert into auth.users (id) values ('aaaa0113-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0113-0000-4000-8000-0000000000e1', true);
select set_config('ladino.rules_version', 'pgtap-113', true);
insert into public.tenants (id, name) values ('aaaa0113-0000-4000-8000-00000000000a', 'Tenant 113');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code, activity_start_date) values
  ('aaaa0113-0000-4000-8000-0000000000a1', 'aaaa0113-0000-4000-8000-00000000000a', 'J-113-A',
   'Compras 113 con corte', 'VES', 'ordinario', '2026-01-01'),
  ('aaaa0113-0000-4000-8000-0000000000a2', 'aaaa0113-0000-4000-8000-00000000000a', 'J-113-B',
   'Compras 113 sin acta', 'VES', 'ordinario', '2026-01-01');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              taxpayer_type_code, person_type_code)
select ('aaaa0113-0000-4000-8000-0000000000c' || n)::uuid, 'aaaa0113-0000-4000-8000-00000000000a',
       ('aaaa0113-0000-4000-8000-0000000000a' || n)::uuid, 'J-113-PROV-' || n, 'Proveedor 113',
       'nacional', 'ordinario', 'juridica'
  from generate_series(1, 2) n;
insert into public.products (id, tenant_id, company_id, sku, name, kind, unit_code,
                             tax_category_code)
values ('aaaa0113-0000-4000-8000-00000000d001', 'aaaa0113-0000-4000-8000-00000000000a',
        'aaaa0113-0000-4000-8000-0000000000a1', 'SKU-113', 'Servicio 113', 'service', 'unidad',
        'gravado_general');
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, rules_version) values
  ('aaaa0113-0000-4000-8000-000000000ac1', 'aaaa0113-0000-4000-8000-00000000000a',
   'aaaa0113-0000-4000-8000-0000000000a1', '1', 'IVA crédito fiscal', 'activo', 'deudora', 'test'),
  ('aaaa0113-0000-4000-8000-000000000ac2', 'aaaa0113-0000-4000-8000-00000000000a',
   'aaaa0113-0000-4000-8000-0000000000a1', '2', 'Cuentas por pagar', 'pasivo', 'acreedora', 'test'),
  ('aaaa0113-0000-4000-8000-000000000ac5', 'aaaa0113-0000-4000-8000-00000000000a',
   'aaaa0113-0000-4000-8000-0000000000a1', '5', 'Diferencias por redondeo', 'gasto', 'deudora', 'test');
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
   'iva_credit_fiscal', 'aaaa0113-0000-4000-8000-000000000ac1'),
  ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
   'rounding_difference', 'aaaa0113-0000-4000-8000-000000000ac5');

create temporary table hoy on commit drop as select platform.caracas_day(now()) as d;
create sequence pg_temp.numero_113 start 9000;
-- Un asiento IVA crédito contra CxP, por `p_importe`, fechado `p_fecha`, posteado.
create function pg_temp.asiento(p_id uuid, p_fecha date, p_importe numeric) returns void
language plpgsql as $$
begin
  insert into public.journal_entries
    (id, tenant_id, company_id, period_id, posting_date, source_kind, description, rules_version)
  values (p_id, 'aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
          platform.period_for_date('aaaa0113-0000-4000-8000-0000000000a1', p_fecha), p_fecha,
          'manual', 'Compra 113', 'test');
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  values ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1', p_id, 1,
          'aaaa0113-0000-4000-8000-000000000ac1', p_importe, 0, p_importe, 'VES', 1, p_importe,
          'VES', 'identidad', now(), p_importe, 0),
         ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1', p_id, 2,
          'aaaa0113-0000-4000-8000-000000000ac2', 0, p_importe, p_importe, 'VES', 1, p_importe,
          'VES', 'identidad', now(), 0, p_importe);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0113-0000-4000-8000-0000000000e1',
         entry_number = nextval('pg_temp.numero_113')
   where id = p_id;
end $$;
create function pg_temp.conc(p_from date, p_to date)
returns table (libro numeric, mayor numeric, cuadra boolean) language sql as $$
  select r.libro, r.mayor, r.cuadra
    from platform.book_ledger_reconciliation('aaaa0113-0000-4000-8000-0000000000a1', p_from, p_to) r
   where r.concepto = 'iva_credito_fiscal';
$$;

-- ── La compra VIEJA: julio, 3,20 USD de IVA × 36,12345679 = 115,595061728 → a 8: 115,59506173 ──
-- Su asiento, como se asentaba entonces: a 8 decimales (hoy no entraría: guarda apagado).
set constraints all immediate;
alter table public.journal_entries disable trigger journal_entries_02_balanced;
select pg_temp.asiento('aaaa0113-0000-4000-8000-0000000e0001', '2026-07-05', 115.59506173);
alter table public.journal_entries enable trigger journal_entries_02_balanced;
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   journal_entry_id)
values
  ('aaaa0113-0000-4000-8000-0000000000f1', 'aaaa0113-0000-4000-8000-00000000000a',
   'aaaa0113-0000-4000-8000-0000000000a1', 'aaaa0113-0000-4000-8000-0000000000c1', 'F113-1',
   '00-1131', '2026-07-05', 'posted', now(), 20.00, 3.20, 23.20, true, 'USD', 'VES',
   36.12345679, 'BCV', 'aaaa0113-0000-4000-8000-0000000e0001'),
  -- La misma compra en la empresa SIN acta (y sin contabilidad: su asiento está «en cola»).
  ('aaaa0113-0000-4000-8000-0000000000f9', 'aaaa0113-0000-4000-8000-00000000000a',
   'aaaa0113-0000-4000-8000-0000000000a2', 'aaaa0113-0000-4000-8000-0000000000c2', 'F113-9',
   '00-1139', '2026-07-05', 'posted', now(), 20.00, 3.20, 23.20, true, 'USD', 'VES',
   36.12345679, 'BCV', null);
insert into public.supplier_invoice_lines
  (tenant_id, company_id, supplier_invoice_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, line_subtotal_transaction,
   line_total_transaction, tax_amount, tax_rate_snapshot, tax_category_snapshot, tax_treatment,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id)
values ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
        'aaaa0113-0000-4000-8000-0000000000f1', 1, 'aaaa0113-0000-4000-8000-00000000d001', 'Línea',
        1, 20, 722.4691358, 20, 23.20, 3.20, 0.16, 'gravado_general', 'gravado', 23.20, 'USD',
        36.12345679, 838.06419753, 'VES', 'BCV', now(), 'purchases:document:8:HALF_UP');

-- ── La regularización del céntimo: el corte ─────────────────────────────────
create temp table _prep as
  select platform.cent_regularization_prepare('aaaa0113-0000-4000-8000-0000000000a1') as r;
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0113-0000-4000-8000-0000000000e1',
       entry_number = nextval('pg_temp.numero_113')
 where id = ((select r from _prep) ->> 'entry_id')::uuid;
select platform.cent_regularization_finish((select r from _prep));
select is((select count(*)::int from platform.cent_gaps('aaaa0113-0000-4000-8000-0000000000a1')), 0,
  'tras regularizar, cent_gaps = 0 (el saldo de IVA crédito queda en 115,60)');

-- ── La compra NUEVA: hoy, posterior al corte, 2,22 USD × 36,12345679 = 80,194074 → 80,19 ──
select pg_temp.asiento('aaaa0113-0000-4000-8000-0000000e0002', (select d from hoy), 80.19);
alter table public.supplier_invoices disable trigger supplier_invoices_00_provenance;
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate, rate_source,
   journal_entry_id, created_at, version)
values ('aaaa0113-0000-4000-8000-0000000000f2', 'aaaa0113-0000-4000-8000-00000000000a',
        'aaaa0113-0000-4000-8000-0000000000a1', 'aaaa0113-0000-4000-8000-0000000000c1', 'F113-2',
        '00-1132', (select d from hoy), 'posted', now(), 13.88, 2.22, 16.10, true, 'USD', 'VES',
        36.12345679, 'BCV', 'aaaa0113-0000-4000-8000-0000000e0002', now() + interval '1 minute', 1);
alter table public.supplier_invoices enable trigger supplier_invoices_00_provenance;

-- ── 1. El período ANTERIOR al corte ─────────────────────────────────────────
select is((select libro from pg_temp.conc('2026-07-01', '2026-07-31')), 115.59506173::numeric,
  'julio: el renglón de la compra anterior al corte se reproduce como se generó, a 8 decimales');
select ok((select cuadra from pg_temp.conc('2026-07-01', '2026-07-31')),
  'julio: libro = mayor + cola, exacto (antes: libro 115,60 contra mayor 115,59506173)');
select is(
  (select array[iva_alicuota_general, iva_sin_clasificar, base_gravada_sin_alicuota]
     from platform.purchases_book_by_rate('aaaa0113-0000-4000-8000-0000000000a1',
                                          '2026-07-01', '2026-07-31')),
  array[115.59506173, 0, 0]::numeric[],
  'julio: el libro por alícuota convierte con la misma escala que el renglón: nada sin clasificar');
select is(
  (select d.creditos from platform.recompute_iva_period(
     'aaaa0113-0000-4000-8000-0000000000a1', '2026-07-01', '2026-07-31', 0, 0) d),
  115.59506173::numeric,
  'julio: la declaración da el mismo crédito que el libro (RLIVA art. 72), como se declaró entonces');

-- ── 2. El período POSTERIOR al corte (el mes en curso, donde cae la regularización) ──
select is((select libro from pg_temp.conc(date_trunc('month', (select d from hoy))::date,
                                         (select d from hoy))), 80.19::numeric,
  'mes en curso: el renglón de la compra posterior al corte va al céntimo');
select is((select mayor from pg_temp.conc(date_trunc('month', (select d from hoy))::date,
                                         (select d from hoy))), 80.19::numeric,
  'mes en curso: el mayor de la conciliación no cuenta el asiento de la regularización del céntimo (no es un hecho fiscal)');
select ok((select cuadra from pg_temp.conc(date_trunc('month', (select d from hoy))::date,
                                          (select d from hoy))),
  'mes en curso: libro = mayor + cola, exacto');
select is(
  (select d.creditos from platform.recompute_iva_period(
     'aaaa0113-0000-4000-8000-0000000000a1', date_trunc('month', (select d from hoy))::date,
     (select d from hoy), 0, 0) d),
  80.19::numeric, 'mes en curso: la declaración, al céntimo, igual que el libro');

-- ── 3. Toda la historia ─────────────────────────────────────────────────────
select ok((select cuadra from pg_temp.conc('1900-01-01', '2999-12-31')),
  'toda la historia: cuadra');
select is((select libro from pg_temp.conc('1900-01-01', '2999-12-31')),
  (115.59506173 + 80.19)::numeric, 'y es la suma de los dos renglones, cada uno con su regla');

-- ── 4. VARIANTE ROTA: el invariante sigue viendo un descuadre real ──────────
select pg_temp.asiento('aaaa0113-0000-4000-8000-0000000e0003', '2026-07-20', 0.01);
select ok(not (select cuadra from pg_temp.conc('2026-07-01', '2026-07-31')),
  'variante rota: un céntimo en IVA crédito sin documento en julio descuadra julio');
select ok(not (select cuadra from pg_temp.conc('1900-01-01', '2999-12-31')),
  'y la historia entera');
-- Un asiento que LLEVE la etiqueta de la regularización, sin estar en el registro, SÍ cuenta.
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description, rules_version)
values ('aaaa0113-0000-4000-8000-0000000e0004', 'aaaa0113-0000-4000-8000-00000000000a',
        'aaaa0113-0000-4000-8000-0000000000a1',
        platform.period_for_date('aaaa0113-0000-4000-8000-0000000000a1', '2026-08-10'),
        '2026-08-10', 'inventory_move', 'aaaa0113-0000-4000-8000-0000000000f7',
        'stock.cent_regularized', 'Etiquetado 113', 'test');
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
values ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
        'aaaa0113-0000-4000-8000-0000000e0004', 1, 'aaaa0113-0000-4000-8000-000000000ac1',
        0.02, 0, 0.02, 'VES', 1, 0.02, 'VES', 'identidad', now(), 0.02, 0),
       ('aaaa0113-0000-4000-8000-00000000000a', 'aaaa0113-0000-4000-8000-0000000000a1',
        'aaaa0113-0000-4000-8000-0000000e0004', 2, 'aaaa0113-0000-4000-8000-000000000ac2',
        0, 0.02, 0.02, 'VES', 1, 0.02, 'VES', 'identidad', now(), 0, 0.02);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0113-0000-4000-8000-0000000000e1',
       entry_number = nextval('pg_temp.numero_113')
 where id = 'aaaa0113-0000-4000-8000-0000000e0004';
select ok(not (select cuadra from pg_temp.conc('2026-08-01', '2026-08-31')),
  'ni se esconde con la etiqueta de la regularización: un asiento etiquetado en agosto descuadra agosto — lo que excluye es el registro privado');

-- ── 5. La empresa SIN acta ──────────────────────────────────────────────────
select is(
  (select iva_credito from platform.purchases_book('aaaa0113-0000-4000-8000-0000000000a2',
                                                   '2026-07-01', '2026-07-31')),
  115.60::numeric,
  'sin acta de regularización no hay corte: la misma compra se convierte al céntimo');

select * from finish();
rollback;
