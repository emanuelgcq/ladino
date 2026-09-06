-- =============================================================================
-- Ladino — pgTAP 42 · «cashea» es instrumento de cobro de ventas (migración 42)
--
--   1. el CHECK de payments acepta cashea (por definición del constraint);
--   2. el de supplier_payments NO lo acepta — a un proveedor no se le paga
--      con crédito de consumo;
--   3. una forma de pago kind=cashea se puede configurar de verdad;
--   4. el CHECK sigue mordiendo: un kind inventado se rechaza.
-- =============================================================================

begin;
select plan(4);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0042-0000-4000-8000-00000000000a', 'Tenant 42');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0042-0000-4000-8000-0000000000a1', 'aaaa0042-0000-4000-8000-00000000000a',
   'J-42-A', 'Bodega que cobra por Cashea, C.A.', 'ordinario');
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind) values
  ('aaaa0042-0000-4000-8000-000000000ca1', 'aaaa0042-0000-4000-8000-00000000000a',
   'aaaa0042-0000-4000-8000-0000000000a1', 'Banco liquidador 42', 'VES', 'bank');

-- ── 1. payments acepta cashea ────────────────────────────────────────────────
select ok(
  (select pg_get_constraintdef(oid) like '%cashea%'
     from pg_constraint
    where conname = 'payments_instrument_chk'
      and conrelid = 'public.payments'::regclass),
  'payments_instrument_chk incluye cashea');

-- ── 2. supplier_payments NO ──────────────────────────────────────────────────
select ok(
  (select pg_get_constraintdef(oid) not like '%cashea%'
     from pg_constraint
    where conname = 'supplier_payments_instrument_chk'
      and conrelid = 'public.supplier_payments'::regclass),
  'supplier_payments_instrument_chk NO incluye cashea: a un proveedor no se le paga así');

-- ── 3. la forma de pago Cashea se configura ──────────────────────────────────
select lives_ok(
  $$insert into public.payment_methods (id, tenant_id, company_id, name, kind, account_id)
    values ('aaaa0042-0000-4000-8000-00000000f001',
            'aaaa0042-0000-4000-8000-00000000000a', 'aaaa0042-0000-4000-8000-0000000000a1',
            'Cashea', 'cashea', 'aaaa0042-0000-4000-8000-000000000ca1')$$,
  'una forma de pago kind=cashea se puede crear');

-- ── 4. el CHECK sigue mordiendo ──────────────────────────────────────────────
select throws_ok(
  $$insert into public.payment_methods (id, tenant_id, company_id, name, kind, account_id)
    values ('aaaa0042-0000-4000-8000-00000000f002',
            'aaaa0042-0000-4000-8000-00000000000a', 'aaaa0042-0000-4000-8000-0000000000a1',
            'Bitcoin', 'bitcoin', 'aaaa0042-0000-4000-8000-000000000ca1')$$,
  '23514', null,
  'un kind inventado se rechaza: el CHECK no se aflojó, se ensanchó');

select * from finish();
rollback;
