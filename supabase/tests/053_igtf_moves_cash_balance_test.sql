-- =============================================================================
-- Ladino — pgTAP 53 · EL IGTF COBRADO ENTRA A LA CAJA (migración 53, ADR-0059)
--
-- Un cobro de 22,69 USD en efectivo con 0,68 de IGTF deja 23,37 en la caja: el
-- saldo materializado y el recómputo dicen lo mismo, redistribuir el pago
-- mueve los dos importes, y una percepción en otra moneda que su cuenta falla.
-- =============================================================================

begin;
select plan(7);

insert into public.tenants (id, name) values ('aaaa0053-0000-4000-8000-00000000000a', 'Tenant 53');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0053-0000-4000-8000-0000000000a2', 'aaaa0053-0000-4000-8000-00000000000a',
   'J-53-A', 'Empresa 53', 'especial');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0053-0000-4000-8000-00000000c001', 'aaaa0053-0000-4000-8000-00000000000a',
   'aaaa0053-0000-4000-8000-0000000000a2', 'J-CLI-53', 'Cliente 53', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0053-0000-4000-8000-00000000e101', 'aaaa0053-0000-4000-8000-00000000000a',
        'aaaa0053-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0053-0000-4000-8000-00000000f001', 'aaaa0053-0000-4000-8000-00000000000a',
   'aaaa0053-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0053-0000-4000-8000-00000000c001', 1, 5301, 'issued', now(),
   'aaaa0053-0000-4000-8000-00000000e101', 'test-053', 'VES', 'VES', 1, 'identidad',
   18884.80, 18884.80, 16280, 2604.80, 18884.80);
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0053-0000-4000-8000-00000000ca01', 'aaaa0053-0000-4000-8000-00000000000a',
   'aaaa0053-0000-4000-8000-0000000000a2', 'Caja USD 53', 'USD', 'cash'),
  ('aaaa0053-0000-4000-8000-00000000ca02', 'aaaa0053-0000-4000-8000-00000000000a',
   'aaaa0053-0000-4000-8000-0000000000a2', 'Caja USD 2', 'USD', 'cash'),
  ('aaaa0053-0000-4000-8000-00000000ca03', 'aaaa0053-0000-4000-8000-00000000000a',
   'aaaa0053-0000-4000-8000-0000000000a2', 'Caja Bs 53', 'VES', 'cash');

-- El cobro: 22,69 USD a la venta.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0053-0000-4000-8000-00000000e001', 'aaaa0053-0000-4000-8000-00000000000a',
        'aaaa0053-0000-4000-8000-0000000000a2', 'aaaa0053-0000-4000-8000-00000000f001',
        now(), 'USD', 22.69, 832.4883, 'BCV test', now(), 18889.16, 'efectivo_usd',
        'aaaa0053-0000-4000-8000-00000000ca01');
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0053-0000-4000-8000-00000000ca01'),
  22.69::numeric, 'sin IGTF todavía, la caja tiene lo cobrado a la venta');

-- Y su IGTF: 0,68 USD más, en la MISMA caja.
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at)
values ('aaaa0053-0000-4000-8000-00000000000a', 'aaaa0053-0000-4000-8000-0000000000a2',
        'aaaa0053-0000-4000-8000-00000000e001', 'aaaa0053-0000-4000-8000-00000000f001',
        22.69, 'USD', 0.03, 0.68, 566.09, 832.4883, 'BCV test', now());
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0053-0000-4000-8000-00000000ca01'),
  23.37::numeric, 'con el IGTF, la caja espera 23,37: lo que de verdad entregó el cliente');
select is(platform.recompute_account_balance('aaaa0053-0000-4000-8000-00000000ca01'),
  23.37::numeric, 'el recómputo desde los hechos dice lo mismo que el saldo materializado');

-- Redistribuir el pago a otra caja mueve el cobro Y su IGTF.
update public.payments set account_id = 'aaaa0053-0000-4000-8000-00000000ca02'
 where id = 'aaaa0053-0000-4000-8000-00000000e001';
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0053-0000-4000-8000-00000000ca01'),
  0::numeric, 'la caja de origen queda en cero: se fueron el cobro y su IGTF');
select is((select balance from public.company_account_balances
            where account_id = 'aaaa0053-0000-4000-8000-00000000ca02'),
  23.37::numeric, 'y la de destino recibe los 23,37');
select is(platform.recompute_account_balance('aaaa0053-0000-4000-8000-00000000ca02'),
  23.37::numeric, 'el recómputo de la de destino coincide');

-- Una percepción en otra moneda que la cuenta de su pago: falla.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0053-0000-4000-8000-00000000e002', 'aaaa0053-0000-4000-8000-00000000000a',
        'aaaa0053-0000-4000-8000-0000000000a2', 'aaaa0053-0000-4000-8000-00000000f001',
        now(), 'VES', 10, 1, 'identidad', now(), 10, 'efectivo_bs',
        'aaaa0053-0000-4000-8000-00000000ca03');
select throws_ok($$
  insert into public.igtf_perceptions
    (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
     functional_amount, fx_rate, rate_source, occurred_at)
  values ('aaaa0053-0000-4000-8000-00000000000a', 'aaaa0053-0000-4000-8000-0000000000a2',
          'aaaa0053-0000-4000-8000-00000000e002', 'aaaa0053-0000-4000-8000-00000000f001',
          10, 'USD', 0.03, 0.30, 250, 832.4883, 'BCV test', now())
$$, '23514', null, 'un IGTF en USD no entra a una caja en Bs: el saldo no mezcla monedas');

select * from finish();
rollback;
