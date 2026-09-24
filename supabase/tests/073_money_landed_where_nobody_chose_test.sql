-- =============================================================================
-- Ladino — pgTAP 73 · DÓNDE CAYÓ EL DINERO QUE NADIE ELIGIÓ (migración 73, ADR-0067 §4)
--
-- Lo que se prueba, con la variante que NO debe disparar delante de cada una:
--   1. un gasto pagado desde una cuenta propia del negocio no sale en el informe;
--   2. el mismo gasto desde «Sin asignar» sí, con `problem = 'sin_asignar'`;
--   3. un pago en efectivo que salió de un BANCO sale como `familia_no_corresponde`;
--   4. ese mismo pago desde una CAJA no sale: la familia corresponde.
--
-- El informe reparte por PROBLEMA, no por tabla: lo que importa es que quien lo lea sepa si el
-- dinero está en un limbo («Sin asignar») o en una cuenta que no puede ser la suya.
-- =============================================================================

begin;
select plan(4);

insert into public.tenants (id, name) values
  ('aaaa0073-0000-4000-8000-00000000000a', 'Tenant 73');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code)
values ('aaaa0073-0000-4000-8000-0000000000a1', 'aaaa0073-0000-4000-8000-00000000000a',
        'J-73-A', 'Dónde cayó 73', 'VES');

-- Tres cuentas: la caja del negocio, su banco, y la de sistema donde cae lo que nadie eligió.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind, is_system)
values
  ('aaaa0073-0000-4000-8000-0000000000c1', 'aaaa0073-0000-4000-8000-00000000000a',
   'aaaa0073-0000-4000-8000-0000000000a1', 'Caja Bs', 'VES', 'cash', false),
  ('aaaa0073-0000-4000-8000-0000000000c2', 'aaaa0073-0000-4000-8000-00000000000a',
   'aaaa0073-0000-4000-8000-0000000000a1', 'Banesco', 'VES', 'bank', false),
  ('aaaa0073-0000-4000-8000-0000000000c3', 'aaaa0073-0000-4000-8000-00000000000a',
   'aaaa0073-0000-4000-8000-0000000000a1', 'Sin asignar (VES)', 'VES', 'cash', true);

-- ── 1. Un gasto pagado de la caja del negocio: normal, no se informa ─────────
insert into public.expenses
  (tenant_id, company_id, category, paid_at, account_id, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0073-0000-4000-8000-00000000000a', 'aaaa0073-0000-4000-8000-0000000000a1',
        'Luz', now(), 'aaaa0073-0000-4000-8000-0000000000c1', 500, 'VES', 1, 500, 'VES',
        'identidad', now(), 'money:2:HALF_UP');

select is(
  (select count(*) from platform.money_landing_gaps('aaaa0073-0000-4000-8000-0000000000a1')),
  0::bigint,
  'un gasto pagado de una cuenta propia no sale: el informe no grita por existir');

-- ── 2. El mismo gasto, desde «Sin asignar» ──────────────────────────────────
insert into public.expenses
  (tenant_id, company_id, category, paid_at, account_id, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
values ('aaaa0073-0000-4000-8000-00000000000a', 'aaaa0073-0000-4000-8000-0000000000a1',
        'Agua', now(), 'aaaa0073-0000-4000-8000-0000000000c3', 700, 'VES', 1, 700, 'VES',
        'identidad', now(), 'money:2:HALF_UP');

select is(
  (select array_agg(kind || '/' || problem)
     from platform.money_landing_gaps('aaaa0073-0000-4000-8000-0000000000a1')),
  array['gasto/sin_asignar'],
  'el que salió de «Sin asignar» sale, y dice por qué');

-- ── 3 y 4. El efectivo que salió de un banco ────────────────────────────────
insert into public.suppliers
  (id, tenant_id, company_id, tax_id, legal_name, supplier_kind, person_type_code,
   taxpayer_type_code)
values ('aaaa0073-0000-4000-8000-0000000000b1', 'aaaa0073-0000-4000-8000-00000000000a',
        'aaaa0073-0000-4000-8000-0000000000a1', 'J-73-P', 'Proveedor 73', 'nacional',
        'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, invoice_date, tax_is_recoverable,
   transaction_currency, functional_currency, supplier_control_number)
values ('aaaa0073-0000-4000-8000-0000000000f1', 'aaaa0073-0000-4000-8000-00000000000a',
        'aaaa0073-0000-4000-8000-0000000000a1', 'aaaa0073-0000-4000-8000-0000000000b1',
        current_date, true, 'VES', 'VES', '00-000073');

-- Efectivo en bolívares que salió del BANCO: el arqueo de la caja no lo vería nunca.
insert into public.supplier_payments
  (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument, account_id,
   gross_amount, net_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp)
values ('aaaa0073-0000-4000-8000-00000000000a', 'aaaa0073-0000-4000-8000-0000000000a1',
        'aaaa0073-0000-4000-8000-0000000000b1', 'aaaa0073-0000-4000-8000-0000000000f1',
        now(), 'efectivo_bs', 'aaaa0073-0000-4000-8000-0000000000c2',
        900, 900, 900, 'VES', 1, 900, 'VES', 'identidad', now());

select is(
  (select array_agg(problem order by problem)
     from platform.money_landing_gaps('aaaa0073-0000-4000-8000-0000000000a1')
    where kind = 'pago a proveedor'),
  array['familia_no_corresponde'],
  'efectivo que salió de un banco: la familia no corresponde, y se dice');

-- El mismo pago, esta vez desde la caja: la familia corresponde y NO se informa.
insert into public.supplier_payments
  (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument, account_id,
   gross_amount, net_amount, amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp)
values ('aaaa0073-0000-4000-8000-00000000000a', 'aaaa0073-0000-4000-8000-0000000000a1',
        'aaaa0073-0000-4000-8000-0000000000b1', 'aaaa0073-0000-4000-8000-0000000000f1',
        now(), 'efectivo_bs', 'aaaa0073-0000-4000-8000-0000000000c1',
        400, 400, 400, 'VES', 1, 400, 'VES', 'identidad', now());

select is(
  (select count(*) from platform.money_landing_gaps('aaaa0073-0000-4000-8000-0000000000a1')
    where kind = 'pago a proveedor'),
  1::bigint,
  'y el que salió de la caja no se suma: sigue siendo uno, no dos');

select * from finish();
rollback;
