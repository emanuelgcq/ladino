-- =============================================================================
-- 106 · El proveedor sin RIF (D-04, migración 20261003160000)
-- =============================================================================
-- Lo que prueba:
--   a. un proveedor NACIONAL sin RIF se guarda (antes: suppliers_tax_id_required_chk, 23514);
--   b. la clasificación del nacional sigue obligatoria (suppliers_national_shape_chk no cambió);
--   c. una factura CON soporte fiscal a ese proveedor no se inserta: LAD96 — también como
--      ladino_api, el camino real de la API —, y ni cambiando después el proveedor de una
--      factura con soporte;
--   d. la misma compra SIN soporte fiscal sí entra (la cuarta salida de ADR-0066);
--   e. el extranjero sin RIF sigue facturando con soporte (su referencia, no su RIF);
--   f. la variante rota: sin el trigger, la factura con soporte entra. Si no entrara, el LAD96
--      de arriba lo estaría produciendo otra cosa.
-- =============================================================================
begin;
select plan(9);

insert into auth.users (id) values ('aaaa0106-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'Tenant 106 A');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-00000000000a',
   'J106000001', 'Bodega 106');
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0106-0000-4000-8000-0000000000a1', true);

-- a. El nacional sin RIF se guarda.
select lives_ok($$
  insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                                person_type_code, taxpayer_type_code)
  values ('aaaa0106-0000-4000-8000-00000000e001', 'aaaa0106-0000-4000-8000-00000000000a',
          'aaaa0106-0000-4000-8000-0000000000a2', null, 'Señor de las verduras', 'nacional',
          'natural', 'no_contribuyente')
$$, 'a. un proveedor nacional sin RIF se guarda');

-- b. …pero con su clasificación: la otra CHECK sigue en pie.
select throws_ok($$
  insert into public.suppliers (tenant_id, company_id, tax_id, legal_name, supplier_kind)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
          null, 'Sin clasificar', 'nacional')
$$, '23514', null, 'b. el nacional sigue necesitando tipo de persona y de contribuyente');

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0106-0000-4000-8000-00000000e002', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a2', 'J-PRO-106', 'Proveedor con RIF', 'nacional',
   'juridica', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind) values
  ('aaaa0106-0000-4000-8000-00000000e003', 'aaaa0106-0000-4000-8000-00000000000a',
   'aaaa0106-0000-4000-8000-0000000000a2', null, 'Supplier abroad', 'extranjero');

-- c. Con soporte fiscal, al nacional sin RIF: LAD96.
select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
          'aaaa0106-0000-4000-8000-00000000e001', 'F-106-1', 'C-106-1', '2026-10-01', 'draft',
          0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0)
$$, 'LAD96', null, 'c. una factura con soporte fiscal a un nacional sin RIF no se inserta');

-- c'. Lo mismo por el camino de la API (ladino_api, sin BYPASSRLS): el trigger corre igual.
set local role ladino_api;
select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
          'aaaa0106-0000-4000-8000-00000000e001', 'F-106-2', 'C-106-2', '2026-10-01', 'draft',
          0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0)
$$, 'LAD96', null, 'c''. como ladino_api también: LAD96, no un 42501 de la RLS');
reset role;

-- d. Sin soporte fiscal, al mismo proveedor: entra.
select lives_ok($$
  insert into public.supplier_invoices
    (id, tenant_id, company_id, supplier_id, invoice_date, status, subtotal_amount, tax_amount,
     total_amount, tax_is_recoverable, fiscal_support, transaction_currency, functional_currency,
     fx_rate, amount_transaction_currency, functional_amount)
  values ('aaaa0106-0000-4000-8000-00000000f001', 'aaaa0106-0000-4000-8000-00000000000a',
          'aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-00000000e001',
          '2026-10-01', 'draft', 0, 0, 0, false, false, 'VES', 'VES', 1, 0, 0)
$$, 'd. la compra sin soporte fiscal al proveedor sin RIF entra (ADR-0066, cuarta salida)');

-- c''. Una factura con soporte a un proveedor con RIF no puede pasarse luego al que no lo tiene.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
   fiscal_support, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount)
values ('aaaa0106-0000-4000-8000-00000000f002', 'aaaa0106-0000-4000-8000-00000000000a',
        'aaaa0106-0000-4000-8000-0000000000a2', 'aaaa0106-0000-4000-8000-00000000e002',
        'F-106-3', 'C-106-3', '2026-10-01', 'draft', 0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0);
select throws_ok($$
  update public.supplier_invoices set supplier_id = 'aaaa0106-0000-4000-8000-00000000e001'
   where id = 'aaaa0106-0000-4000-8000-00000000f002'
$$, 'LAD96', null, 'c''''. cambiar el proveedor de una factura con soporte al que no tiene RIF: LAD96');
select is((select supplier_id::text from public.supplier_invoices
            where id = 'aaaa0106-0000-4000-8000-00000000f002'),
          'aaaa0106-0000-4000-8000-00000000e002', 'y la factura sigue con su proveedor con RIF');

-- e. El extranjero sin RIF sigue facturando con soporte, con su referencia.
select lives_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_document_ref,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
          'aaaa0106-0000-4000-8000-00000000e003', 'INV-106', 'REF-106', '2026-10-01', 'draft',
          0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0)
$$, 'e. el extranjero sin RIF factura con soporte, como antes');

-- f. La variante rota: sin el trigger, la factura con soporte al nacional sin RIF ENTRA.
drop trigger supplier_invoices_fiscal_needs_tax_id on public.supplier_invoices;
select lives_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount)
  values ('aaaa0106-0000-4000-8000-00000000000a', 'aaaa0106-0000-4000-8000-0000000000a2',
          'aaaa0106-0000-4000-8000-00000000e001', 'F-106-4', 'C-106-4', '2026-10-01', 'draft',
          0, 0, 0, true, true, 'VES', 'VES', 1, 0, 0)
$$, 'f. sin el trigger entra: el LAD96 de (c) lo produce el trigger y nada más');

select * from finish();
rollback;
