-- =============================================================================
-- Ladino — pgTAP 56 · LA CAJA DEL ASIENTO ES LA CAJA DEL MOVIMIENTO (migración 56)
--
--   1. el papel `treasury_account` existe;
--   2. una caja nace mapeada: en la moneda funcional → cash_bs;
--   3. en otra moneda → cash_usd;
--   4. un mapeo EXPLÍCITO no se pisa;
--   5-6. una caja que nació ANTES del plan de cuentas se mapea cuando se asigna
--        el papel, y deja su acta;
--   7. `treasury_account_of` no resuelve hechos que no mueven caja (NULL);
--   8. aislamiento: la caja de un hecho de OTRA empresa no se resuelve;
--   9. el preset ya no nombra cajas constantes en hechos de tesorería.
-- =============================================================================

begin;
select plan(9);

insert into public.tenants (id, name) values
  ('aaaa0056-0000-4000-8000-00000000000a', 'Tenant 56');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0056-0000-4000-8000-0000000000a1', 'aaaa0056-0000-4000-8000-00000000000a', 'J-56-A', 'Empresa 56', 'VES'),
  ('aaaa0056-0000-4000-8000-0000000000a2', 'aaaa0056-0000-4000-8000-00000000000a', 'J-56-B', 'Otra 56', 'VES');

insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, rules_version) values
  ('aaaa0056-0000-4000-8000-0000000000b1', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', '1', 'Caja Bs 56', 'activo', 'deudora', 'test'),
  ('aaaa0056-0000-4000-8000-0000000000b2', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', '2', 'Caja USD 56', 'activo', 'deudora', 'test'),
  ('aaaa0056-0000-4000-8000-0000000000b3', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', '3', 'Banco propio 56', 'activo', 'deudora', 'test');

-- Una caja en USD que nace ANTES de que exista el papel cash_usd.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0056-0000-4000-8000-0000000000c0', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', 'Zelle temprano 56', 'USD', 'wallet');

insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0056-0000-4000-8000-00000000000a', 'aaaa0056-0000-4000-8000-0000000000a1', 'cash_bs',
   'aaaa0056-0000-4000-8000-0000000000b1'),
  ('aaaa0056-0000-4000-8000-00000000000a', 'aaaa0056-0000-4000-8000-0000000000a1', 'cash_usd',
   'aaaa0056-0000-4000-8000-0000000000b2');

insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind, ledger_account_id) values
  ('aaaa0056-0000-4000-8000-0000000000c1', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', 'Caja Bs 56', 'VES', 'cash', null),
  ('aaaa0056-0000-4000-8000-0000000000c2', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', 'Caja USD 56', 'USD', 'cash', null),
  ('aaaa0056-0000-4000-8000-0000000000c3', 'aaaa0056-0000-4000-8000-00000000000a',
   'aaaa0056-0000-4000-8000-0000000000a1', 'Banco USD 56', 'USD', 'bank',
   'aaaa0056-0000-4000-8000-0000000000b3');

select ok(exists (select 1 from public.account_purposes where code = 'treasury_account'),
  'El papel treasury_account existe');

select is((select ledger_account_id from public.company_accounts
            where id = 'aaaa0056-0000-4000-8000-0000000000c1'),
  'aaaa0056-0000-4000-8000-0000000000b1'::uuid,
  'Una caja en la moneda funcional nace mapeada a cash_bs');

select is((select ledger_account_id from public.company_accounts
            where id = 'aaaa0056-0000-4000-8000-0000000000c2'),
  'aaaa0056-0000-4000-8000-0000000000b2'::uuid,
  'Una caja en otra moneda nace mapeada a cash_usd');

select is((select ledger_account_id from public.company_accounts
            where id = 'aaaa0056-0000-4000-8000-0000000000c3'),
  'aaaa0056-0000-4000-8000-0000000000b3'::uuid,
  'Un mapeo explícito no se pisa');

select is((select ledger_account_id from public.company_accounts
            where id = 'aaaa0056-0000-4000-8000-0000000000c0'),
  'aaaa0056-0000-4000-8000-0000000000b2'::uuid,
  'La caja que nació antes del papel se mapea cuando se asigna cash_usd');

select is((select count(*)::int from public.audit_events
            where aggregate_id = 'aaaa0056-0000-4000-8000-0000000000c0'
              and event_type = 'treasury.account.ledger_mapped'
              and payload->>'origin' = 'purpose_assigned'),
  1,
  '… y ese mapeo tardío deja su acta');

select is(platform.treasury_account_of('aaaa0056-0000-4000-8000-0000000000a1', 'sales_invoice',
                                       'aaaa0056-0000-4000-8000-0000000000c1'),
  null::uuid,
  'Un hecho que no mueve caja no resuelve cuenta de tesorería');

-- Un gasto real de la empresa A: con A resuelve su caja (control positivo);
-- con B, la misma consulta no resuelve nada.
insert into public.expenses (id, tenant_id, company_id, category, paid_at, account_id,
                             amount_transaction_currency, transaction_currency, functional_amount,
                             functional_currency)
values ('aaaa0056-0000-4000-8000-0000000000e1', 'aaaa0056-0000-4000-8000-00000000000a',
        'aaaa0056-0000-4000-8000-0000000000a1', 'Luz 56', now(),
        'aaaa0056-0000-4000-8000-0000000000c1', 10, 'VES', 10, 'VES');
select is(
  array[platform.treasury_account_of('aaaa0056-0000-4000-8000-0000000000a1', 'expense',
                                     'aaaa0056-0000-4000-8000-0000000000e1'),
        platform.treasury_account_of('aaaa0056-0000-4000-8000-0000000000a2', 'expense',
                                     'aaaa0056-0000-4000-8000-0000000000e1')],
  array['aaaa0056-0000-4000-8000-0000000000c1'::uuid, null::uuid],
  'El gasto resuelve SU caja con su empresa, y nada con otra (aislamiento)');

select ok(not exists (
  select 1 from public.journal_template_preset_lines l
    join public.journal_template_preset_entries e on e.id = l.entry_id
   where e.preset_code = 've_basico'
     and e.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing',
                           'igtf_perception')
     and l.account_purpose in ('cash_bs', 'cash_usd')),
  'El preset ve_basico ya no nombra cajas constantes en hechos de tesorería');

select * from finish();
rollback;
