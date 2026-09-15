-- =============================================================================
-- Ladino — pgTAP 58 · EL INVENTARIO EN EL MAYOR (migración 58)
--
--   1. los tres papeles nuevos tienen cuenta en ve_basico, sin chocar códigos;
--   2. la factura de compra del preset ya no debita el inventario;
--   3. los seis hechos de inventario están en el preset;
--   4. inventory_ledger_gap: una entrada con su asiento da diferencia 0;
--   5. VARIANTE ROTA: la misma entrada SIN asiento da diferencia = su valor;
--   6. inventory_coverage_gaps la señala como missing;
--   7. un corte posterior la deja fuera de la cobertura (la cubre la regularización);
--   8. inventory_ledger_cutovers es insert-only;
--   9. aislamiento: el invariante de OTRA empresa no ve estos movimientos.
-- =============================================================================

begin;
select plan(10);

insert into auth.users (id) values ('aaaa0058-0000-4000-8000-0000000000e1');
select set_config('ladino.actor_id', 'aaaa0058-0000-4000-8000-0000000000e1', true);

insert into public.tenants (id, name) values ('aaaa0058-0000-4000-8000-00000000000a', 'Tenant 58');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0058-0000-4000-8000-0000000000a1', 'aaaa0058-0000-4000-8000-00000000000a', 'J-58-A', 'Bodega 58'),
  ('aaaa0058-0000-4000-8000-0000000000a2', 'aaaa0058-0000-4000-8000-00000000000a', 'J-58-B', 'Otra 58');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0058-0000-4000-8000-0000000000b1', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', 'W58', 'Local');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0058-0000-4000-8000-0000000000d1', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', 'P58', 'Arroz 58', 'good', 'active', 'unidad', 'gravado_general');
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, rules_version) values
  ('aaaa0058-0000-4000-8000-0000000000c1', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', '1', 'Inventario 58', 'activo', 'deudora', 'test'),
  ('aaaa0058-0000-4000-8000-0000000000c2', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', '3', 'Aportes 58', 'patrimonio', 'acreedora', 'test');
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0058-0000-4000-8000-00000000000a', 'aaaa0058-0000-4000-8000-0000000000a1',
   'inventory_general', 'aaaa0058-0000-4000-8000-0000000000c1');

select is(
  (select count(distinct a.code)::int from public.chart_template_accounts a
    where a.template_code = 've_basico'
      and a.suggested_purpose in ('goods_received_not_invoiced', 'opening_equity', 'purchase_cost_variance')),
  3,
  'Los tres papeles nuevos tienen cuenta propia en ve_basico (ningún código pisado)');

select ok(not exists (
  select 1 from public.journal_template_preset_lines l
    join public.journal_template_preset_entries e on e.id = l.entry_id
   where e.preset_code = 've_basico' and e.source_kind = 'purchase_invoice'
     and l.account_purpose = 'inventory_general'),
  'La factura de compra del preset ya no debita el inventario: lo mueve el kardex');

select is(
  (select count(*)::int from public.journal_template_preset_entries
    where preset_code = 've_basico'
      and (source_kind, source_event) in (
            ('sales_cost', 'stock.shipped'), ('inventory_move', 'stock.shipped'),
            ('stock_opening', 'stock.received'), ('goods_receipt', 'stock.received'),
            ('sales_return', 'stock.received'), ('purchase_revaluation', 'ap.invoice_posted'))),
  6,
  'Los seis hechos de inventario están en el preset');

-- Dos entradas de 100 cada una. La primera con su asiento; la segunda sin él.
insert into public.inventory_moves
  (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at)
values
  ('aaaa0058-0000-4000-8000-0000000000f1', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', 'aaaa0058-0000-4000-8000-0000000000b1',
   'aaaa0058-0000-4000-8000-0000000000d1', 'entrada', 10, 100, 'VES', 1, 100, 'VES',
   'identidad', now(), 'inventory:cost:8:HALF_UP', 10, now());

insert into public.fiscal_periods (tenant_id, company_id, year, month)
select 'aaaa0058-0000-4000-8000-00000000000a', 'aaaa0058-0000-4000-8000-0000000000a1',
       extract(year from current_date)::int, extract(month from current_date)::int
 where not exists (select 1 from public.fiscal_periods
                    where company_id = 'aaaa0058-0000-4000-8000-0000000000a1');
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description, rules_version)
select 'aaaa0058-0000-4000-8000-00000000000e', 'aaaa0058-0000-4000-8000-00000000000a',
       'aaaa0058-0000-4000-8000-0000000000a1', p.id, current_date, 'stock_opening',
       'aaaa0058-0000-4000-8000-0000000000f1', 'stock.received', 'Entrada 58', 'test'
  from public.fiscal_periods p where p.company_id = 'aaaa0058-0000-4000-8000-0000000000a1' limit 1;
insert into public.journal_lines
  (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
values
  ('aaaa0058-0000-4000-8000-00000000000a', 'aaaa0058-0000-4000-8000-0000000000a1',
   'aaaa0058-0000-4000-8000-00000000000e', 1, 'aaaa0058-0000-4000-8000-0000000000c1', 100, 0,
   100, 'VES', 1, 100, 'VES', 'identidad', now(), 100, 0),
  ('aaaa0058-0000-4000-8000-00000000000a', 'aaaa0058-0000-4000-8000-0000000000a1',
   'aaaa0058-0000-4000-8000-00000000000e', 2, 'aaaa0058-0000-4000-8000-0000000000c2', 0, 100,
   100, 'VES', 1, 100, 'VES', 'identidad', now(), 0, 100);
update public.journal_entries
   set status = 'posted', posted_at = now(), posted_by = 'aaaa0058-0000-4000-8000-0000000000e1',
       entry_number = 1
 where id = 'aaaa0058-0000-4000-8000-00000000000e';

select is(
  (select diferencia from platform.inventory_ledger_gap('aaaa0058-0000-4000-8000-0000000000a1')),
  0::numeric,
  'Una entrada con su asiento: kardex y mayor en cero de diferencia');

insert into public.inventory_moves
  (id, tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost, occurred_at)
values
  ('aaaa0058-0000-4000-8000-0000000000f2', 'aaaa0058-0000-4000-8000-00000000000a',
   'aaaa0058-0000-4000-8000-0000000000a1', 'aaaa0058-0000-4000-8000-0000000000b1',
   'aaaa0058-0000-4000-8000-0000000000d1', 'entrada', 10, 100, 'VES', 1, 100, 'VES',
   'identidad', now(), 'inventory:cost:8:HALF_UP', 10, now());

select is(
  (select diferencia from platform.inventory_ledger_gap('aaaa0058-0000-4000-8000-0000000000a1')),
  100::numeric,
  'VARIANTE ROTA: la misma entrada SIN asiento deja el invariante en rojo por su valor exacto');

select is(
  (select array_agg(problem) from platform.inventory_coverage_gaps('aaaa0058-0000-4000-8000-0000000000a1')),
  array['missing'],
  'La cobertura de movimientos señala la entrada sin asiento como missing (y solo esa)');

select is(
  (select count(*)::int from platform.inventory_coverage_gaps('aaaa0058-0000-4000-8000-0000000000a2')),
  0,
  'Aislamiento: la cobertura de otra empresa no ve estos movimientos');

select is(
  (select kardex from platform.inventory_ledger_gap('aaaa0058-0000-4000-8000-0000000000a2')),
  0::numeric,
  'Aislamiento: el kardex de otra empresa no suma estos movimientos');

-- El corte: lo anterior lo cubre la regularización.
insert into public.inventory_ledger_cutovers
  (tenant_id, company_id, cutover_at, kardex_value, ledger_balance, difference, reason)
values ('aaaa0058-0000-4000-8000-00000000000a', 'aaaa0058-0000-4000-8000-0000000000a1',
        clock_timestamp() + interval '1 second', 200, 100, 100,
        'Corte de prueba 58: lo anterior lo cubre la regularización');
select is(
  (select count(*)::int from platform.inventory_coverage_gaps('aaaa0058-0000-4000-8000-0000000000a1')),
  0,
  'Con un corte posterior, lo anterior sale de la cobertura: lo cubre la regularización');

select throws_ok(
  $$ update public.inventory_ledger_cutovers set reason = 'otra razón cualquiera'
      where company_id = 'aaaa0058-0000-4000-8000-0000000000a1' $$,
  null, null,
  'inventory_ledger_cutovers es insert-only: un corte no se edita');

select * from finish();
rollback;
