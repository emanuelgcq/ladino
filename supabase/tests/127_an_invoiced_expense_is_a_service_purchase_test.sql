-- =============================================================================
-- 127 · El gasto con factura es una compra de servicio (H-09) y el comprobante lo
--       lee quien tiene expense.read (H-08). Migraciones 20261004170000 y 20261004170100.
-- =============================================================================
-- Lo que prueba:
--   a. una línea SIN producto en una factura de MERCANCÍA no entra: LADH9 (y no LAD98, que es
--      de otro invariante: dos caminos no comparten código);
--   b. la misma línea en la factura de un GASTO (expense_category) sí entra;
--   c. una línea sin producto necesita su categoría tributaria congelada (23514): de ahí saca
--      el libro de compras la base por alícuota;
--   d. un gasto con factura es CON soporte fiscal (23514), y el comprobante y la recurrencia
--      solo viven en la factura de un gasto (23514);
--   e. la variante rota: sin el trigger, la línea sin producto entra en la factura de mercancía.
--      Si no entrara, el LADH9 de (a) lo estaría produciendo otra cosa;
--   f. la plantilla contable del gasto con factura existe, debita gasto y NUNCA el puente de
--      mercancía por facturar, y toda empresa con la plantilla de compras tiene también esta;
--   g. el bucket `receipts`: 6 MB; lo lee quien tiene `expense.read` EN ESA empresa. El usuario
--      de DOS tenants (el atacante realista) ve el de la empresa donde tiene el permiso y no el
--      de la otra; el cajero de la empresa —miembro, sin el permiso— no ve ninguno;
--   h. la variante rota: con la policy anterior (solo pertenencia) el cajero SÍ lo lee.
-- =============================================================================
begin;
select plan(16);

insert into auth.users (id) values
  ('aaaa0127-0000-4000-8000-0000000000a1'),  -- lleva los gastos de A; cajero en B
  ('aaaa0127-0000-4000-8000-0000000000c1');  -- cajero de A
insert into public.tenants (id, name) values
  ('aaaa0127-0000-4000-8000-00000000000a', 'Tenant 127 A'),
  ('aaaa0127-0000-4000-8000-00000000000b', 'Tenant 127 B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0127-0000-4000-8000-0000000000a2', 'aaaa0127-0000-4000-8000-00000000000a',
   'J127000001', 'Bodega 127 A'),
  ('aaaa0127-0000-4000-8000-0000000000b2', 'aaaa0127-0000-4000-8000-00000000000b',
   'J127000002', 'Bodega 127 B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0127-0000-4000-8000-0000000000d1', 'aaaa0127-0000-4000-8000-00000000000a',
   'aaaa0127-0000-4000-8000-0000000000a1'),
  ('aaaa0127-0000-4000-8000-0000000000d2', 'aaaa0127-0000-4000-8000-00000000000b',
   'aaaa0127-0000-4000-8000-0000000000a1'),
  ('aaaa0127-0000-4000-8000-0000000000d3', 'aaaa0127-0000-4000-8000-00000000000a',
   'aaaa0127-0000-4000-8000-0000000000c1');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0127-0000-4000-8000-0000000000e1', null, 't127_gastos', 'Lleva los gastos (127)', false),
  ('aaaa0127-0000-4000-8000-0000000000e2', null, 't127_cajero', 'Cajero (127)', false);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0127-0000-4000-8000-0000000000e1', 'expense.read'),
  ('aaaa0127-0000-4000-8000-0000000000e2', 'sales.invoice.issue');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id) values
  ('aaaa0127-0000-4000-8000-00000000000a', 'aaaa0127-0000-4000-8000-0000000000d1',
   'aaaa0127-0000-4000-8000-0000000000e1', null),
  ('aaaa0127-0000-4000-8000-00000000000b', 'aaaa0127-0000-4000-8000-0000000000d2',
   'aaaa0127-0000-4000-8000-0000000000e2', null),
  ('aaaa0127-0000-4000-8000-00000000000a', 'aaaa0127-0000-4000-8000-0000000000d3',
   'aaaa0127-0000-4000-8000-0000000000e2', null);
select set_config('ladino.actor_id', 'aaaa0127-0000-4000-8000-0000000000a1', true);

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0127-0000-4000-8000-00000000e001', 'aaaa0127-0000-4000-8000-00000000000a',
   'aaaa0127-0000-4000-8000-0000000000a2', 'J-LUZ-127', 'Electricidad 127', 'nacional',
   'juridica', 'ordinario');

-- Dos facturas en borrador: una de mercancía y una de gasto.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
   fiscal_support, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount, expense_category)
values
  ('aaaa0127-0000-4000-8000-00000000f001', 'aaaa0127-0000-4000-8000-00000000000a',
   'aaaa0127-0000-4000-8000-0000000000a2', 'aaaa0127-0000-4000-8000-00000000e001',
   'F-127-MERC', 'C-127-1', '2026-10-01', 'draft', 0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0,
   null),
  ('aaaa0127-0000-4000-8000-00000000f002', 'aaaa0127-0000-4000-8000-00000000000a',
   'aaaa0127-0000-4000-8000-0000000000a2', 'aaaa0127-0000-4000-8000-00000000e001',
   'F-127-LUZ', 'C-127-2', '2026-10-01', 'draft', 0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0,
   'Luz');

-- Una línea SIN producto, con o sin su categoría tributaria congelada.
create function pg_temp.linea_de_servicio(p_factura uuid, p_n int, p_categoria text)
returns void language sql as $$
  insert into public.supplier_invoice_lines
    (tenant_id, company_id, supplier_invoice_id, line_number, product_id, description, quantity,
     unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
     line_subtotal_transaction, line_total_transaction, amount_transaction_currency,
     transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
     rate_timestamp, rounding_policy_id, tax_category_snapshot, tax_treatment, operation_type)
  values ('aaaa0127-0000-4000-8000-00000000000a', 'aaaa0127-0000-4000-8000-0000000000a2',
          p_factura, p_n, null, 'Luz de septiembre', 1, 1000, 1000, 0.16, 160, 1000, 1160, 1000,
          'VES', 1, 1160, 'VES', 'identidad', now(), 'test:127', p_categoria,
          platform.tax_treatment_of(p_categoria), 'interna');
$$;

-- a. En la factura de mercancía: LADH9.
select throws_ok(
  $$ select pg_temp.linea_de_servicio('aaaa0127-0000-4000-8000-00000000f001', 1, 'gravado_general') $$,
  'LADH9', null,
  'a. una línea sin producto en una factura de MERCANCÍA no entra (LADH9)');

-- b. En la factura de un gasto: entra.
select lives_ok(
  $$ select pg_temp.linea_de_servicio('aaaa0127-0000-4000-8000-00000000f002', 1, 'gravado_general') $$,
  'b. la misma línea en la factura de un GASTO entra');
select is(
  (select count(*)::int from public.supplier_invoice_lines
    where supplier_invoice_id = 'aaaa0127-0000-4000-8000-00000000f002' and product_id is null
      and tax_treatment = 'gravado'),
  1, 'b''. y quedó sin producto, con su tratamiento tributario congelado');

-- c. Sin categoría tributaria congelada, ni en la factura de un gasto.
select throws_ok(
  $$ select pg_temp.linea_de_servicio('aaaa0127-0000-4000-8000-00000000f002', 2, null) $$,
  '23514', null,
  'c. una línea sin producto necesita su categoría tributaria: de ahí sale la base del libro');

-- d. El gasto con factura es CON soporte fiscal; el comprobante solo vive en un gasto.
select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, invoice_date, status, subtotal_amount, tax_amount,
     total_amount, tax_is_recoverable, fiscal_support, transaction_currency, functional_currency,
     fx_rate, amount_transaction_currency, functional_amount, expense_category)
  values ('aaaa0127-0000-4000-8000-00000000000a', 'aaaa0127-0000-4000-8000-0000000000a2',
          'aaaa0127-0000-4000-8000-00000000e001', '2026-10-01', 'draft', 0, 0, 0, false, false,
          'VES', 'VES', 1, 0, 0, 'Luz')
$$, '23514', null, 'd. un gasto SIN soporte fiscal no es una factura de gasto: es un gasto llano');
select throws_ok($$
  update public.supplier_invoices set expense_attachment_path = 'x/receipts/a.png'
   where id = 'aaaa0127-0000-4000-8000-00000000f001'
$$, '23514', null, 'd''. el comprobante solo vive en la factura de un gasto');
select throws_ok($$
  update public.supplier_invoices set expense_is_recurring = true
   where id = 'aaaa0127-0000-4000-8000-00000000f001'
$$, '23514', null, 'd''''. y la recurrencia también');

-- e. La variante rota: sin el trigger, la línea sin producto entra en la de mercancía.
set local lock_timeout = '4s';
alter table public.supplier_invoice_lines disable trigger supplier_invoice_lines_02_service_line;
select lives_ok(
  $$ select pg_temp.linea_de_servicio('aaaa0127-0000-4000-8000-00000000f001', 1, 'gravado_general') $$,
  'e. sin el trigger la línea sin producto entra en la factura de mercancía: (a) mide el trigger');
alter table public.supplier_invoice_lines enable trigger supplier_invoice_lines_02_service_line;

-- f. La plantilla contable.
select is(
  (select count(*)::int
     from public.journal_template_preset_entries e
     join public.journal_template_preset_lines l on l.entry_id = e.id
    where e.preset_code = 've_basico' and e.source_kind = 'purchase_invoice'
      and e.source_event = 'ap.expense_invoice_posted'),
  6, 'f. el preset trae la plantilla del gasto con factura, con sus seis líneas');
select is(
  (select string_agg(distinct l.account_purpose, ',' order by l.account_purpose)
     from public.journal_template_preset_entries e
     join public.journal_template_preset_lines l on l.entry_id = e.id
    where e.preset_code = 've_basico' and e.source_event = 'ap.expense_invoice_posted'
      and l.side = 'debit'),
  'iva_credit_fiscal,operating_expense',
  'f''. debita gasto y crédito fiscal: nunca «mercancía recibida por facturar»');
select is(
  (select count(*)::int
     from (select distinct company_id from public.journal_templates
            where source_kind = 'purchase_invoice' and source_event = 'ap.invoice_posted') c
    where not exists (select 1 from public.journal_templates t
                       where t.company_id = c.company_id and t.source_kind = 'purchase_invoice'
                         and t.source_event = 'ap.expense_invoice_posted')),
  0, 'f''''. toda empresa con la plantilla de compras tiene la del gasto con factura');

-- g. El bucket de comprobantes.
select is((select file_size_limit from storage.buckets where id = 'receipts'), 6291456::bigint,
  'g. el bucket receipts limita el archivo a 6 MB');
insert into storage.objects (bucket_id, name) values
  ('receipts', 'aaaa0127-0000-4000-8000-0000000000a2/receipts/luz.png'),
  ('receipts', 'aaaa0127-0000-4000-8000-0000000000b2/receipts/agua.png'),
  ('receipts', 'no-es-un-uuid/receipts/x.png');

-- El usuario de DOS tenants: expense.read en A, cajero en B.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0127-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select string_agg(split_part(name, '/', 1), ',') from storage.objects
    where bucket_id = 'receipts' and name like '%/receipts/%.png'
      and split_part(name, '/', 1) in ('aaaa0127-0000-4000-8000-0000000000a2',
                                       'aaaa0127-0000-4000-8000-0000000000b2',
                                       'no-es-un-uuid')),
  'aaaa0127-0000-4000-8000-0000000000a2',
  'g''. quien es de dos tenants lee el comprobante de la empresa donde tiene expense.read, y no el de la otra');
reset role;

-- El cajero de A: miembro de la empresa, sin el permiso.
select set_config('request.jwt.claims',
  '{"sub":"aaaa0127-0000-4000-8000-0000000000c1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'receipts'
      and split_part(name, '/', 1) = 'aaaa0127-0000-4000-8000-0000000000a2'),
  0, 'g''''. el cajero de la empresa, sin expense.read, no lee ningún comprobante');
reset role;

-- h. La variante rota: la policy de antes (solo pertenencia).
drop policy receipts_select on storage.objects;
create policy receipts_select on storage.objects for select to authenticated
  using (bucket_id = 'receipts'
         and split_part(name, '/', 1) in
             (select id::text from public.companies
               where id in (select platform.ladino_company_ids())));
set local role authenticated;
select is(
  (select count(*)::int from storage.objects
    where bucket_id = 'receipts'
      and split_part(name, '/', 1) = 'aaaa0127-0000-4000-8000-0000000000a2'),
  1, 'h. con la policy anterior el cajero SÍ lo lee: (g'''') mide el permiso, no otra cosa');
reset role;

-- Y lo permitido se ejerce: quien lleva los gastos lee el suyo (tras la variante, por pertenencia).
select set_config('request.jwt.claims',
  '{"sub":"aaaa0127-0000-4000-8000-0000000000a1","role":"authenticated"}', true);
set local role authenticated;
select ok(
  (select count(*) from storage.objects
    where bucket_id = 'receipts'
      and split_part(name, '/', 1) = 'aaaa0127-0000-4000-8000-0000000000a2') = 1,
  'y quien lleva los gastos sigue leyendo el comprobante de su empresa');
reset role;

select * from finish();
rollback;
