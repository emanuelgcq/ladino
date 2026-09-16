-- =============================================================================
-- Ladino — pgTAP 61 · MOVER DINERO ENTRE DOS CUENTAS (migración 61, ADR-0062 §3)
--
--   1. la transferencia mueve los DOS saldos: sale de una, entra en la otra;
--   2-3. el saldo recomputado desde los hechos incluye las dos patas (si
--      `recompute_account_balance` no aprendiera la fuente nueva, aquí se ve);
--   4. VARIANTE ROTA: dos cuentas de MONEDA distinta no se transfieren;
--   5. ni dos cuentas de empresas distintas;
--   6. la cobertura contable la vigila: sin asiento ni cola, es un hueco;
--   7. registrada no se edita (append-only) …
--   8. … salvo el backlink al asiento;
--   9. ni se borra;
--  10. `treasury_account_of` resuelve la caja de DESTINO y
--      `treasury_from_account_of` la de ORIGEN — las dos, cajas reales;
--  11. el papel `treasury_account_from` no se resuelve por ajuste.
-- =============================================================================

begin;
select plan(11);

insert into public.tenants (id, name) values
  ('aaaa0061-0000-4000-8000-00000000000a', 'Tenant 61');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0061-0000-4000-8000-0000000000a1', 'aaaa0061-0000-4000-8000-00000000000a',
   'J-61-A', 'Empresa 61', 'VES'),
  ('aaaa0061-0000-4000-8000-0000000000a2', 'aaaa0061-0000-4000-8000-00000000000a',
   'J-61-B', 'Otra 61', 'VES');

-- Las cuentas contables a las que apuntan las cajas.
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, rules_version) values
  ('aaaa0061-0000-4000-8000-0000000000b1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', '1101', 'Caja 61', 'activo', 'deudora', 'test'),
  ('aaaa0061-0000-4000-8000-0000000000b2', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', '1102', 'Banco 61', 'activo', 'deudora', 'test');

-- Dos cajas en bolívares (origen y destino), una en dólares y una de otra empresa.
insert into public.company_accounts
  (id, tenant_id, company_id, name, currency, kind, ledger_account_id) values
  ('aaaa0061-0000-4000-8000-0000000000c1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 'Caja del local 61', 'VES', 'cash',
   'aaaa0061-0000-4000-8000-0000000000b1'),
  ('aaaa0061-0000-4000-8000-0000000000c2', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 'Banco 61', 'VES', 'bank',
   'aaaa0061-0000-4000-8000-0000000000b2'),
  ('aaaa0061-0000-4000-8000-0000000000c3', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 'Zelle 61', 'USD', 'wallet', null),
  ('aaaa0061-0000-4000-8000-0000000000c9', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a2', 'Caja ajena 61', 'VES', 'cash', null);

-- Lo que había en la caja del local antes de repartir (el saldo materializado vive en su
-- propia tabla: company_account_balances).
insert into public.company_account_balances (account_id, tenant_id, company_id, balance) values
  ('aaaa0061-0000-4000-8000-0000000000c1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 500);

insert into public.treasury_transfers
  (id, tenant_id, company_id, from_account_id, to_account_id, reason,
   amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
values
  ('aaaa0061-0000-4000-8000-0000000000d1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 'aaaa0061-0000-4000-8000-0000000000c1',
   'aaaa0061-0000-4000-8000-0000000000c2', 'Depósito del efectivo del día',
   200, 'VES', 200, 'VES');

select results_eq(
  $$select balance from public.company_account_balances
     where account_id in ('aaaa0061-0000-4000-8000-0000000000c1',
                          'aaaa0061-0000-4000-8000-0000000000c2')
     order by account_id$$,
  $$values (300::numeric), (200::numeric)$$,
  'la transferencia mueve los dos saldos: sale de una y entra en la otra');

select is(
  platform.recompute_account_balance('aaaa0061-0000-4000-8000-0000000000c2'),
  200::numeric,
  'el saldo recomputado desde los hechos incluye la pata que ENTRA');

select is(
  platform.recompute_account_balance('aaaa0061-0000-4000-8000-0000000000c1'),
  -200::numeric,
  'y la que SALE (los 500 se pusieron a mano: aquí el único hecho es la transferencia)');

-- ── VARIANTE ROTA: la transferencia no cambia de moneda ni de empresa ───────
select throws_ok(
  $$insert into public.treasury_transfers
      (tenant_id, company_id, from_account_id, to_account_id, reason,
       amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
    values ('aaaa0061-0000-4000-8000-00000000000a', 'aaaa0061-0000-4000-8000-0000000000a1',
            'aaaa0061-0000-4000-8000-0000000000c1', 'aaaa0061-0000-4000-8000-0000000000c3',
            'Pasar bolívares a Zelle', 100, 'VES', 100, 'VES')$$,
  'LAD67', 'una transferencia mueve la MISMA moneda: VES y USD no coinciden con VES',
  'una transferencia mueve la MISMA moneda: bolívares no van a una cuenta en dólares');

select throws_ok(
  $$insert into public.treasury_transfers
      (tenant_id, company_id, from_account_id, to_account_id, reason,
       amount_transaction_currency, transaction_currency, functional_amount, functional_currency)
    values ('aaaa0061-0000-4000-8000-00000000000a', 'aaaa0061-0000-4000-8000-0000000000a1',
            'aaaa0061-0000-4000-8000-0000000000c1', 'aaaa0061-0000-4000-8000-0000000000c9',
            'A la caja de la otra empresa', 100, 'VES', 100, 'VES')$$,
  'LAD67', 'las dos cuentas de una transferencia son de la misma empresa',
  'ni cruza empresas: la caja de otra empresa no es destino válido');

-- ── La cobertura contable, ANTES de que el asiento exista ───────────────────
select results_eq(
  $$select source_id, problem
      from platform.accounting_coverage_gaps('aaaa0061-0000-4000-8000-0000000000a1')
     where source_kind = 'treasury_transfer'$$,
  $$values ('aaaa0061-0000-4000-8000-0000000000d1'::uuid, 'missing'::text)$$,
  'transferencia sin asiento ni fila en cola: la cobertura contable la ve como hueco');

-- ── Append-only ─────────────────────────────────────────────────────────────
select throws_ok(
  $$update public.treasury_transfers set amount_transaction_currency = 999
     where id = 'aaaa0061-0000-4000-8000-0000000000d1'$$,
  'LAD06', 'una transferencia registrada no se edita: se corrige con otra en sentido contrario',
  'una transferencia registrada no se edita, y el mensaje lo dice');

insert into public.fiscal_periods (id, tenant_id, company_id, year, month) values
  ('aaaa0061-0000-4000-8000-0000000000f1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1',
   extract(year from current_date)::int, extract(month from current_date)::int);
insert into public.journal_entries
  (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
   description, rules_version)
values
  ('aaaa0061-0000-4000-8000-0000000000e1', 'aaaa0061-0000-4000-8000-00000000000a',
   'aaaa0061-0000-4000-8000-0000000000a1', 'aaaa0061-0000-4000-8000-0000000000f1',
   current_date, 'treasury_transfer', 'aaaa0061-0000-4000-8000-0000000000d1',
   'treasury.transfer.registered', 'Transferencia 61', 'test');

select lives_ok(
  $$update public.treasury_transfers
       set journal_entry_id = 'aaaa0061-0000-4000-8000-0000000000e1'
     where id = 'aaaa0061-0000-4000-8000-0000000000d1'$$,
  'salvo el backlink al asiento, que es lo único que se escribe después');

select throws_ok(
  $$delete from public.treasury_transfers
     where id = 'aaaa0061-0000-4000-8000-0000000000d1'$$,
  'LAD06',
  'LADINO_APPEND_ONLY: DELETE sobre public.treasury_transfers está prohibido. Esta tabla es append-only: se corrige con una reversión, nunca con una mutación.',
  'y no se borra: lo rechaza el trigger append-only, no la falta de permiso');

-- ── Las dos cajas del asiento salen de las cajas REALES (ADR-0060 §4) ───────
select results_eq(
  $$select platform.treasury_account_of('aaaa0061-0000-4000-8000-0000000000a1',
             'treasury_transfer', 'aaaa0061-0000-4000-8000-0000000000d1'),
           platform.treasury_from_account_of('aaaa0061-0000-4000-8000-0000000000a1',
             'treasury_transfer', 'aaaa0061-0000-4000-8000-0000000000d1')$$,
  $$values ('aaaa0061-0000-4000-8000-0000000000c2'::uuid,
            'aaaa0061-0000-4000-8000-0000000000c1'::uuid)$$,
  'el asiento resuelve destino y origen desde las cajas reales, no desde una cuenta fija');

select is(
  (select resolved_by from public.account_purposes where code = 'treasury_account_from'),
  'treasury_account_from',
  'el papel de la caja de origen no se resuelve por ajuste: lo resuelve la caja');

select * from finish();
rollback;
