-- =============================================================================
-- 135 · La nota de crédito del proveedor (H-03, ADR-0083). Migraciones 20261005110000,
--       110100, 110200, 110300 y 110700 (el kardex en cola, la nota que cierra y la pata
--       auxiliar ↔ declarado de 110500 y 110600 los ejerce `e2e-nc-proveedor` con el caso de uso).
-- =============================================================================
-- Lo que prueba (el kardex, el asiento y los invariantes en cero los prueba el E2E, que ejerce
-- el caso de uso: `e2e-nc-proveedor`, `e2e-inventario-en-el-mayor`, `e2e-gasto-con-factura`):
--   a. `correction_kind` solo admite devolucion | rebaja, y el saldo a favor no es negativo;
--   b. «incompleta» es exactamente «fiscal y sin número de control» —una referencia no exime
--      (20261005110700)—; y `is_fiscal` se
--      DERIVA de la factura al insertar: lo que venga en la fila se pisa;
--   c. la variante rota de (b): sin el CHECK, la nota sin control entra diciéndose completa;
--   d. la línea SIN producto solo corrige una línea de SERVICIO de SU factura —tampoco la de
--      una factura de OTRO tenant—; y una línea de factura se abona UNA vez por nota;
--   e. las variantes rotas de (d): sin el trigger y sin el índice único;
--   f. las plantillas: la nota de un gasto no toca inventario, el ajuste del kardex solo toca
--      inventario y variación, las dos de la nota llevan el saldo a favor a SU cuenta y el
--      diferencial a resultado, y toda empresa con la plantilla de la nota las tiene todas;
--   g. una nota ASENTADA admite el cambio que la guarda permite (también el enlace con su
--      asiento), y la variante rota: con la columna generada, la guarda lo rechaza (LAD06);
--   h. `supplier_credit_ledger_gap`: un saldo a favor declarado SIN asiento da fila; con su
--      asiento esperando en la cola, no; y la empresa de OTRO tenant no ve nada de esto.
--      (X ⇒ 0 filas y X − 0,01 ⇒ 1 fila los ejerce `e2e-nc-proveedor`, con el mayor de verdad.)
-- =============================================================================
begin;
select plan(30);

insert into auth.users (id) values ('aaaa0135-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0135-0000-4000-8000-00000000000a', 'Tenant 135 A'),
  ('aaaa0135-0000-4000-8000-00000000000b', 'Tenant 135 B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0135-0000-4000-8000-0000000000a2', 'aaaa0135-0000-4000-8000-00000000000a',
   'J135000001', 'Bodega 135 A'),
  ('aaaa0135-0000-4000-8000-0000000000b2', 'aaaa0135-0000-4000-8000-00000000000b',
   'J135000002', 'Bodega 135 B');
select set_config('ladino.actor_id', 'aaaa0135-0000-4000-8000-0000000000a1', true);

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0135-0000-4000-8000-00000000e001', 'aaaa0135-0000-4000-8000-00000000000a',
   'aaaa0135-0000-4000-8000-0000000000a2', 'J-PRV-135', 'Proveedor 135', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0135-0000-4000-8000-00000000e002', 'aaaa0135-0000-4000-8000-00000000000b',
   'aaaa0135-0000-4000-8000-0000000000b2', 'J-PRV-135B', 'Proveedor 135 B', 'nacional',
   'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0135-0000-4000-8000-00000000c001', 'aaaa0135-0000-4000-8000-00000000000a',
   'aaaa0135-0000-4000-8000-0000000000a2', 'P-135', 'Harina 135', 'good', 'active', 'unidad',
   'gravado_general');

-- Facturas en borrador: mercancía, dos gastos, una SIN soporte fiscal, y un gasto del tenant B.
create function pg_temp.factura(p_id uuid, p_tenant uuid, p_empresa uuid, p_proveedor uuid,
                                p_numero text, p_control text, p_fiscal boolean, p_gasto text)
returns void language sql as $$
  insert into public.supplier_invoices
    (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount, expense_category)
  values (p_id, p_tenant, p_empresa, p_proveedor, p_numero, p_control, '2026-10-01', 'draft',
          0, 0, 0, p_fiscal, p_fiscal, 'VES', 'VES', 1, 0, 0, p_gasto);
$$;
select pg_temp.factura('aaaa0135-0000-4000-8000-00000000f001',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000e001', 'F-135-MERC', 'C-135-1', true, null);
select pg_temp.factura('aaaa0135-0000-4000-8000-00000000f002',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000e001', 'F-135-LUZ', 'C-135-2', true, 'Luz');
select pg_temp.factura('aaaa0135-0000-4000-8000-00000000f003',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000e001', 'F-135-AGUA', 'C-135-3', true, 'Agua');
select pg_temp.factura('aaaa0135-0000-4000-8000-00000000f004',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000e001', null, null, false, null);
select pg_temp.factura('aaaa0135-0000-4000-8000-00000000f005',
  'aaaa0135-0000-4000-8000-00000000000b', 'aaaa0135-0000-4000-8000-0000000000b2',
  'aaaa0135-0000-4000-8000-00000000e002', 'F-135-B', 'C-135-5', true, 'Luz');

create function pg_temp.linea_de_factura(p_id uuid, p_tenant uuid, p_empresa uuid,
                                         p_factura uuid, p_producto uuid)
returns void language sql as $$
  insert into public.supplier_invoice_lines
    (id, tenant_id, company_id, supplier_invoice_id, line_number, product_id, description,
     quantity, unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
     transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
     rate_timestamp, rounding_policy_id, tax_category_snapshot, tax_treatment, operation_type)
  values (p_id, p_tenant, p_empresa, p_factura, 1, p_producto, 'Línea 135', 1, 1000, 1000, 0.16,
          160, 1000, 1160, 1000, 'VES', 1, 1160, 'VES', 'identidad', now(), 'test:135',
          'gravado_general', platform.tax_treatment_of('gravado_general'), 'interna');
$$;
select pg_temp.linea_de_factura('aaaa0135-0000-4000-8000-00000000a101',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000f001', 'aaaa0135-0000-4000-8000-00000000c001');
select pg_temp.linea_de_factura('aaaa0135-0000-4000-8000-00000000a102',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000f002', null);
select pg_temp.linea_de_factura('aaaa0135-0000-4000-8000-00000000a103',
  'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
  'aaaa0135-0000-4000-8000-00000000f003', null);
select pg_temp.linea_de_factura('aaaa0135-0000-4000-8000-00000000a105',
  'aaaa0135-0000-4000-8000-00000000000b', 'aaaa0135-0000-4000-8000-0000000000b2',
  'aaaa0135-0000-4000-8000-00000000f005', null);

-- Una nota sobre una factura de A, con lo que se quiera probar.
create function pg_temp.nota(p_id uuid, p_factura uuid, p_numero text, p_control text,
                             p_fiscal boolean, p_incompleta boolean,
                             p_clase text default null, p_favor numeric default 0,
                             p_estado text default 'draft')
returns void language sql as $$
  insert into public.supplier_credit_notes
    (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
     supplier_control_number, note_date, status, posted_at, reason, transaction_currency,
     functional_currency, is_fiscal, document_incomplete, correction_kind,
     credit_in_favor_functional)
  values (p_id, 'aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
          'aaaa0135-0000-4000-8000-00000000e001', p_factura, p_numero, p_control, '2026-10-02',
          p_estado, case when p_estado = 'posted' then now() end, 'Prueba 135', 'VES', 'VES',
          p_fiscal, p_incompleta, p_clase, p_favor);
$$;

-- a. Los dos CHECK de las columnas nuevas.
select throws_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b001',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-A1', 'C-1', true, false, 'regalo') $$,
  '23514', null, 'correction_kind solo admite devolucion o rebaja');
select throws_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b002',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-A2', 'C-2', true, false, 'rebaja', -0.01) $$,
  '23514', null, 'el saldo a favor de una nota no es negativo');

-- b. «Incompleta» es exactamente «fiscal y sin número de control» (20261005110700).
select throws_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b003',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B1', null, true, false, 'rebaja') $$,
  '23514', null, 'una nota fiscal SIN control no puede decirse completa');
select lives_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b004',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B2', null, true, true, 'rebaja') $$,
  'la nota fiscal sin control ENTRA, marcada incompleta (antes la rechazaba el CHECK de identificación)');
select throws_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b005',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B3', 'C-5', true, true, 'rebaja') $$,
  '23514', null, 'una nota con control no puede decirse incompleta');
-- AF5-14: una REFERENCIA no es un número de control. Con la 110100 esta nota entraba completa.
select throws_ok($$ insert into public.supplier_credit_notes
    (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
     supplier_document_ref, note_date, status, reason, transaction_currency,
     functional_currency, is_fiscal, document_incomplete, correction_kind)
  values ('aaaa0135-0000-4000-8000-00000000b007', 'aaaa0135-0000-4000-8000-00000000000a',
          'aaaa0135-0000-4000-8000-0000000000a2', 'aaaa0135-0000-4000-8000-00000000e001',
          'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B5', 'Correo del proveedor',
          '2026-10-02', 'draft', 'Prueba 135', 'VES', 'VES', true, false, 'rebaja') $$,
  '23514', null, 'una nota fiscal sin control y CON referencia no puede decirse completa');
select lives_ok($$ insert into public.supplier_credit_notes
    (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
     supplier_document_ref, note_date, status, reason, transaction_currency,
     functional_currency, is_fiscal, document_incomplete, correction_kind)
  values ('aaaa0135-0000-4000-8000-00000000b008', 'aaaa0135-0000-4000-8000-00000000000a',
          'aaaa0135-0000-4000-8000-0000000000a2', 'aaaa0135-0000-4000-8000-00000000e001',
          'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B6', 'Correo del proveedor',
          '2026-10-02', 'draft', 'Prueba 135', 'VES', 'VES', true, true, 'rebaja') $$,
  'y entra marcada incompleta: la referencia no exime');
-- La factura f004 NO tiene soporte fiscal. La fila dice is_fiscal = TRUE (lo que dejaba la API
-- anterior por omisión): el trigger lo deriva de la factura, y con eso la nota sin control no
-- es «incompleta».
select lives_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b006',
  'aaaa0135-0000-4000-8000-00000000f004', 'NC-135-B4', null, true, false, 'rebaja') $$,
  'la nota de una compra sin soporte fiscal entra sin control y no es «incompleta»');
select is(
  (select is_fiscal from public.supplier_credit_notes
    where id = 'aaaa0135-0000-4000-8000-00000000b006'),
  false, 'is_fiscal se DERIVA de la factura: la fila decía true y quedó false');
select is(
  (select is_fiscal from public.supplier_credit_notes
    where id = 'aaaa0135-0000-4000-8000-00000000b004'),
  true, 'y sobre una factura con soporte fiscal, la nota es fiscal');

-- c. Variante rota: sin el CHECK, la nota sin control entra diciéndose completa.
alter table public.supplier_credit_notes
  drop constraint supplier_credit_notes_document_incomplete_chk;
select lives_ok($$ select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b003',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-B1', null, true, false, 'rebaja') $$,
  'ROTA: sin el CHECK la nota sin control figura completa — el 23514 de arriba lo da ESE CHECK');
delete from public.supplier_credit_notes where id = 'aaaa0135-0000-4000-8000-00000000b003';
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_document_incomplete_chk
  check (document_incomplete = (is_fiscal and supplier_control_number is null));

-- d. La línea sin producto, y la línea repetida.
select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b010',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-D1', 'C-10', true, false, 'rebaja');
select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b011',
  'aaaa0135-0000-4000-8000-00000000f002', 'NC-135-D2', 'C-11', true, false);

create function pg_temp.linea_de_nota(p_nota uuid, p_n int, p_producto uuid, p_linea uuid)
returns void language sql as $$
  insert into public.supplier_credit_note_lines
    (tenant_id, company_id, supplier_credit_note_id, line_number, supplier_invoice_line_id,
     product_id, description, quantity, unit_price_transaction, tax_amount,
     line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
     transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
     rate_timestamp, rounding_policy_id)
  values ('aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
          p_nota, p_n, p_linea, p_producto, 'Abono 135', 1, 100, 16, 100, 116, 100, 'VES', 1,
          116, 'VES', 'identidad', now(), 'test:135');
$$;

-- Sin producto y sin línea de factura: con el trigger puesto lo corta EL TRIGGER (corre antes
-- que el CHECK). El CHECK se prueba solo más abajo, con el trigger apartado: dos defensas que
-- dan resultados distintos se aseveran por separado, cada una por su código.
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 1,
  null, null) $$, 'LADH3', null,
  'una línea de nota sin producto y sin línea de factura no entra (la corta el trigger)');
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b010', 1,
  null, 'aaaa0135-0000-4000-8000-00000000a101') $$, 'LADH3', null,
  'una línea de nota sin producto contra una línea de MERCANCÍA no entra');
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 1,
  null, 'aaaa0135-0000-4000-8000-00000000a103') $$, 'LADH3', null,
  'una línea de nota sin producto contra la línea de servicio de OTRA factura no entra');
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 1,
  null, 'aaaa0135-0000-4000-8000-00000000a105') $$, 'LADH3', null,
  'ni contra la línea de servicio de una factura de OTRO tenant');
select lives_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 1,
  null, 'aaaa0135-0000-4000-8000-00000000a102') $$,
  'la línea sin producto que corrige una línea de servicio de SU factura entra');
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 2,
  null, 'aaaa0135-0000-4000-8000-00000000a102') $$, '23505', null,
  'la misma línea de factura no se abona dos veces en una nota');

-- e. Variantes rotas: sin el índice único, y sin el trigger.
drop index public.supplier_credit_note_lines_one_per_invoice_line;
select lives_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 2,
  null, 'aaaa0135-0000-4000-8000-00000000a102') $$,
  'ROTA: sin el índice la línea repetida entra — el 23505 de arriba lo da ESE índice');
delete from public.supplier_credit_note_lines
 where supplier_credit_note_id = 'aaaa0135-0000-4000-8000-00000000b011' and line_number = 2;
create unique index supplier_credit_note_lines_one_per_invoice_line
  on public.supplier_credit_note_lines (supplier_credit_note_id, supplier_invoice_line_id)
  where supplier_invoice_line_id is not null;

alter table public.supplier_credit_note_lines
  disable trigger supplier_credit_note_lines_02_service_line;
select throws_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b011', 3,
  null, null) $$, '23514', null,
  'sin el trigger, el CHECK sigue cortando la línea sin producto y sin línea de factura');
select lives_ok($$ select pg_temp.linea_de_nota('aaaa0135-0000-4000-8000-00000000b010', 1,
  null, 'aaaa0135-0000-4000-8000-00000000a101') $$,
  'ROTA: sin el trigger entra — el LADH3 de arriba lo da ESE trigger');
delete from public.supplier_credit_note_lines
 where supplier_credit_note_id = 'aaaa0135-0000-4000-8000-00000000b010';
alter table public.supplier_credit_note_lines
  enable trigger supplier_credit_note_lines_02_service_line;

-- f. Las plantillas.
select is(
  (select count(*) from public.journal_template_preset_entries e
     join public.journal_template_preset_lines l on l.entry_id = e.id
    where e.preset_code = 've_basico'
      and ((e.source_kind = 'purchase_credit_note'
            and e.source_event = 'ap.expense_credit_note_received'
            and l.account_purpose in ('inventory_general', 'goods_received_not_invoiced'))
        or (e.source_kind = 'purchase_revaluation'
            and e.source_event = 'ap.credit_note_received'
            and l.account_purpose not in ('inventory_general', 'purchase_cost_variance')))),
  0::bigint,
  'la nota de un gasto no toca inventario ni el puente; el ajuste del kardex solo toca inventario y variación');
select is(
  (select count(*) from public.journal_template_preset_entries e
    where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
      and e.source_event in ('ap.credit_note_received', 'ap.expense_credit_note_received')
      and (select count(*) from public.journal_template_preset_lines l
            where l.entry_id = e.id
              and ((l.amount_source = 'credit_surplus'
                    and (l.account_purpose, l.side) in
                        (('supplier_credit_receivable', 'debit'), ('ap_general', 'credit')))
                or (l.amount_source = 'exchange_difference'
                    and (l.account_purpose, l.side, l.condition_kind) in
                        (('exchange_loss', 'debit', 'if_positive'),
                         ('ap_general', 'credit', 'if_positive'),
                         ('ap_general', 'debit', 'if_negative'),
                         ('exchange_gain', 'credit', 'if_negative'))))) = 6),
  2::bigint,
  'las dos plantillas de la nota llevan el saldo a favor a SU cuenta y el diferencial a resultado, y las dos veces dejan la cuenta por pagar');
select is(
  (select count(*) from (select distinct company_id from public.journal_templates
                          where source_kind = 'purchase_credit_note'
                            and source_event = 'ap.credit_note_received') c
    where (select count(*) from public.journal_templates t
            where t.company_id = c.company_id
              and (t.source_kind, t.source_event) in
                  (('purchase_credit_note', 'ap.expense_credit_note_received'),
                   ('purchase_revaluation', 'ap.credit_note_received'))) <> 2
       or exists (select 1 from public.journal_templates t
                   where t.company_id = c.company_id and t.source_kind = 'purchase_credit_note'
                     and (select count(*) from public.journal_template_lines l
                           where l.template_id = t.id
                             and l.amount_source in ('credit_surplus', 'exchange_difference')) <> 6)),
  0::bigint, 'toda empresa con la plantilla de la nota tiene las nuevas, con sus seis líneas');

-- h. El invariante del saldo a favor (antes de (g), que rompe la tabla a propósito).
select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b030',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-H1', 'C-30', true, false, 'rebaja', 25.50,
  'posted');
select is(
  (select diferencia from platform.supplier_credit_ledger_gap('aaaa0135-0000-4000-8000-0000000000a2')),
  25.50::numeric, 'un saldo a favor declarado SIN asiento y sin cola da fila, por su importe');
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
values ('aaaa0135-0000-4000-8000-00000000000a', 'aaaa0135-0000-4000-8000-0000000000a2',
        'purchase_credit_note', 'aaaa0135-0000-4000-8000-00000000b030',
        'ap.credit_note_received', '{}'::jsonb, 'Falta configurar la cuenta de: supplier_credit_receivable');
select is(
  (select count(*) from platform.supplier_credit_ledger_gap('aaaa0135-0000-4000-8000-0000000000a2')),
  0::bigint, 'con su asiento esperando en la cola, el saldo a favor declarado no es un hueco');
select is(
  (select count(*) from platform.supplier_credit_ledger_gap('aaaa0135-0000-4000-8000-0000000000b2')),
  0::bigint, 'la empresa del OTRO tenant no ve el saldo a favor de esta');

-- g. Una nota ASENTADA admite el cambio que la guarda permite (20261005110100).
select pg_temp.nota('aaaa0135-0000-4000-8000-00000000b020',
  'aaaa0135-0000-4000-8000-00000000f001', 'NC-135-G1', 'C-20', true, false, 'rebaja', 0,
  'posted');
select lives_ok($$ update public.supplier_credit_notes set version = version + 1
                    where id = 'aaaa0135-0000-4000-8000-00000000b020' $$,
  'la guarda deja pasar un cambio permitido de una nota asentada');
-- El enlace con su asiento, que es el cambio que el generador hace de verdad. Usa un asiento
-- cualquiera de la base si lo hay (sobre una base vacía escribe NULL: el mismo camino de la
-- guarda, sin el valor).
select lives_ok($$ update public.supplier_credit_notes
                      set journal_entry_id = (select id from public.journal_entries limit 1)
                    where id = 'aaaa0135-0000-4000-8000-00000000b020' $$,
  'y el enlace con su asiento (journal_entry_id), que es lo que la columna generada impedía');
select throws_ok($$ update public.supplier_credit_notes set reason = 'otra'
                     where id = 'aaaa0135-0000-4000-8000-00000000b020' $$,
  'LAD06', null, 'lo que la guarda NO permite sigue sin poder cambiarse');
-- Variante rota: con la columna GENERADA de 20261005110000, la guarda BEFORE UPDATE ve NULL en
-- NEW y rechaza ese mismo cambio. (No se restituye: la transacción de la prueba se deshace.)
alter table public.supplier_credit_notes drop column document_incomplete;
alter table public.supplier_credit_notes
  add column document_incomplete boolean
    generated always as (is_fiscal and supplier_control_number is null
                         and supplier_document_ref is null) stored;
select throws_ok($$ update public.supplier_credit_notes set version = version + 1
                     where id = 'aaaa0135-0000-4000-8000-00000000b020' $$,
  'LAD06', null,
  'ROTA: con la columna generada la guarda rechaza el cambio permitido — por eso es una columna normal');

select * from finish();
rollback;
