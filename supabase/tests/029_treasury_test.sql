-- =============================================================================
-- Ladino — pgTAP 29 · TESORERÍA (migración 29) — RIGOR MÁXIMO
--
-- «¿Dónde está mi dinero?» solo tiene una respuesta creíble si el saldo
-- materializado es imposible de descuadrar por accidente. Esto prueba:
--
--   1. un pago LLEVA cuenta y la moneda del pago es la de la cuenta (LAD67);
--   2. de un pago, lo ÚNICO corregible es la atribución de cuenta: cualquier
--      otro cambio, y el borrado, son LAD06 — el hecho monetario sigue congelado;
--   3. la redistribución mueve el saldo con el pago, en las dos cuentas;
--   4. el saldo materializado == el recomputado, Y CON LA VARIANTE ROTA: un
--      saldo tocado a mano pone la conciliación en rojo. Un invariante que solo
--      se prueba cuando se cumple no se ha probado;
--   5. la cuenta «Sin asignar» de sistema está congelada;
--   6. el saldo materializado no tiene ni un GRANT de escritura: lo escriben
--      SOLO los triggers security definer.
-- =============================================================================

begin;
select plan(18);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0029-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0029-0000-4000-8000-00000000000a', 'Tenant 29');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0029-0000-4000-8000-0000000000a2', 'aaaa0029-0000-4000-8000-00000000000a',
   'J-29-A', 'Empresa 29', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0029-0000-4000-8000-00000000c001', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'J-CLI-29', 'Cliente 29', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0029-0000-4000-8000-00000000e101', 'aaaa0029-0000-4000-8000-00000000000a',
        'aaaa0029-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0029-0000-4000-8000-00000000f001', 'aaaa0029-0000-4000-8000-00000000000a',
        'aaaa0029-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0029-0000-4000-8000-00000000c001', 1, 2901, 'issued', '2026-08-05T14:00:00Z',
        'aaaa0029-0000-4000-8000-00000000e101', 'test-029', 'VES', 'VES', 1, 'identidad',
        1160, 1160, 1000, 160, 1160);
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0029-0000-4000-8000-00000000e001', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'J-PRO-29', 'Proveedor 29', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa0029-0000-4000-8000-00000000f101', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'aaaa0029-0000-4000-8000-00000000e001',
   'FP-029', 'CTRL-029', '2026-08-10', 'posted', now(), 500, 80, 580, true,
   'VES', 'VES', 1, 580, 580);

-- Las cuentas: caja, banco (ambas VES), billetera USD, y una de sistema.
insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind, is_system) values
  ('aaaa0029-0000-4000-8000-0000000000e1', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'Caja Bs', 'VES', 'cash', false),
  ('aaaa0029-0000-4000-8000-0000000000e2', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'Banesco', 'VES', 'bank', false),
  ('aaaa0029-0000-4000-8000-0000000000e3', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'Zelle', 'USD', 'wallet', false),
  ('aaaa0029-0000-4000-8000-0000000000e4', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'Sin asignar (VES)', 'VES', 'cash', true);

-- ── 1. Estructura: RLS forzada y el saldo sin GRANT de escritura ────────────
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relname in ('company_accounts', 'payment_methods', 'company_account_balances')
      and c.relrowsecurity and c.relforcerowsecurity),
  3::bigint, 'las tres tablas de tesorería con RLS habilitada Y forzada');
select is(
  (select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'company_account_balances'
      and grantee in ('anon', 'authenticated', 'service_role', 'ladino_api', 'ladino_worker')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')),
  0::bigint,
  'el saldo materializado no tiene NI UN grant de escritura: lo escriben solo los triggers');

-- ── 2. Un cobro entra a su cuenta y el saldo lo siente ──────────────────────
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id) values
  ('aaaa0029-0000-4000-8000-00000000f201', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'aaaa0029-0000-4000-8000-00000000f001',
   '2026-08-06T10:00:00Z', 'VES', 500, 1, 'identidad', '2026-08-06T10:00:00Z', 500,
   'efectivo_bs', 'aaaa0029-0000-4000-8000-0000000000e1');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e1'),
  500::numeric, 'el cobro de 500 deja Caja Bs en 500: el saldo se materializa al entrar el pago');

-- ── 3. LAD67: un Zelle no entra a Caja Bs ───────────────────────────────────
select throws_ok($$
  insert into public.payments
    (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
     rate_timestamp, functional_amount, instrument, account_id)
  values ('aaaa0029-0000-4000-8000-00000000000a', 'aaaa0029-0000-4000-8000-0000000000a2',
          'aaaa0029-0000-4000-8000-00000000f001', '2026-08-06T11:00:00Z', 'USD', 10, 40,
          'BCV', '2026-08-06T11:00:00Z', 400, 'zelle', 'aaaa0029-0000-4000-8000-0000000000e1')
$$, 'LAD67', null,
  'un pago en USD no entra a una cuenta VES: el dinero no cambia de moneda al guardarse');

-- ── 4. El hecho monetario sigue congelado ───────────────────────────────────
select throws_ok($$
  update public.payments set amount = 600
   where id = 'aaaa0029-0000-4000-8000-00000000f201'
$$, 'LAD06', null,
  'cambiar el MONTO de un pago es imposible: solo la atribución de cuenta se corrige');
select throws_ok($$
  delete from public.payments where id = 'aaaa0029-0000-4000-8000-00000000f201'
$$, 'LAD06', null, 'y borrarlo tampoco: un pago es un hecho');

-- ── 5. La redistribución mueve el saldo con el pago ─────────────────────────
update public.payments set account_id = 'aaaa0029-0000-4000-8000-0000000000e2'
 where id = 'aaaa0029-0000-4000-8000-00000000f201';
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e1'),
  0::numeric, 'redistribuido a Banesco: Caja Bs vuelve a 0');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e2'),
  500::numeric, 'y Banesco recibe los 500: el dinero se mudó entero, no se duplicó');
select is(
  (select version from public.payments where id = 'aaaa0029-0000-4000-8000-00000000f201'),
  2, 'el guard tolera el bump de version que hace el trigger de procedencia: es la pareja documentada');
select throws_ok($$
  update public.payments set account_id = 'aaaa0029-0000-4000-8000-0000000000e3'
   where id = 'aaaa0029-0000-4000-8000-00000000f201'
$$, 'LAD67', null,
  'pero redistribuir un pago VES a la billetera USD también es LAD67: la moneda manda igual al mudarse');

-- ── 6. Un pago a proveedor SALE de su cuenta, por el NETO ───────────────────
insert into public.supplier_payments
  (tenant_id, company_id, supplier_id, supplier_invoice_id, paid_at, instrument,
   gross_amount, retained_amount, net_amount, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency,
   rate_source, rate_timestamp, account_id) values
  ('aaaa0029-0000-4000-8000-00000000000a', 'aaaa0029-0000-4000-8000-0000000000a2',
   'aaaa0029-0000-4000-8000-00000000e001', 'aaaa0029-0000-4000-8000-00000000f101',
   '2026-08-11T10:00:00Z', 'transferencia', 220, 20, 200, 220, 'VES', 1, 220, 'VES',
   'identidad', '2026-08-11T10:00:00Z', 'aaaa0029-0000-4000-8000-0000000000e2');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e2'),
  300::numeric,
  'del banco salió el NETO (200), no el bruto: lo retenido se le debe al fisco, no salió de la cuenta');

-- ── 7. pago_movil existe en el vocabulario nuevo ────────────────────────────
insert into public.payments
  (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id) values
  ('aaaa0029-0000-4000-8000-00000000000a', 'aaaa0029-0000-4000-8000-0000000000a2',
   'aaaa0029-0000-4000-8000-00000000f001', '2026-08-06T12:00:00Z', 'VES', 100, 1,
   'identidad', '2026-08-06T12:00:00Z', 100, 'pago_movil',
   'aaaa0029-0000-4000-8000-0000000000e2');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e2'),
  400::numeric, 'un pago móvil entra con su instrumento nuevo y suma: 300 + 100 = 400');

-- ── 8. LA CONCILIACIÓN, y su variante ROTA ──────────────────────────────────
select is(
  (select count(*) from platform.treasury_reconciliation('aaaa0029-0000-4000-8000-0000000000a2')
    where not ok),
  0::bigint, 'materializado == recomputado en TODAS las cuentas: cero excepciones');

-- Un saldo tocado a mano (aquí, como superusuario: ningún rol de la app puede)
-- tiene que poner la conciliación en rojo. ADR-0023: la ausencia de fallo no
-- se lee como éxito sin haber visto el fallo al menos una vez.
update public.company_account_balances set balance = balance + 7
 where account_id = 'aaaa0029-0000-4000-8000-0000000000e1';
select is(
  (select count(*) from platform.treasury_reconciliation('aaaa0029-0000-4000-8000-0000000000a2')
    where not ok),
  1::bigint,
  'VARIANTE ROTA: 7 Bs fantasma en el saldo y la conciliación acusa exactamente UNA cuenta');

-- ── 9. La cuenta de sistema está congelada ──────────────────────────────────
select throws_ok($$
  update public.company_accounts set name = 'Mi caja'
   where id = 'aaaa0029-0000-4000-8000-0000000000e4'
$$, 'LAD06', null,
  '«Sin asignar» no se renombra: se vacía redistribuyendo pagos, no editando la etiqueta');

-- ── 10. El pago SIN efectivo no lleva cuenta ni mueve saldo ─────────────────
-- Aplicar un saldo a favor no mete plata en ninguna gaveta: atribuirle una
-- cuenta inventaría dinero en el saldo materializado.
insert into public.customer_credits
  (id, tenant_id, company_id, customer_id, source_document_id, amount, currency) values
  ('aaaa0029-0000-4000-8000-00000000cc01', 'aaaa0029-0000-4000-8000-00000000000a',
   'aaaa0029-0000-4000-8000-0000000000a2', 'aaaa0029-0000-4000-8000-00000000c001',
   'aaaa0029-0000-4000-8000-00000000f001', 300, 'VES');
select throws_ok($$
  insert into public.payments
    (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
     rate_timestamp, functional_amount, instrument, customer_credit_id, account_id)
  values ('aaaa0029-0000-4000-8000-00000000000a', 'aaaa0029-0000-4000-8000-0000000000a2',
          'aaaa0029-0000-4000-8000-00000000f001', '2026-08-07T10:00:00Z', 'VES', 50, 1,
          'identidad', '2026-08-07T10:00:00Z', 50, 'saldo_a_favor',
          'aaaa0029-0000-4000-8000-00000000cc01', 'aaaa0029-0000-4000-8000-0000000000e2')
$$, '23514', null,
  'un saldo a favor CON cuenta se rechaza: no entró efectivo a ningún lado');
select lives_ok($$
  insert into public.payments
    (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
     rate_timestamp, functional_amount, instrument, customer_credit_id)
  values ('aaaa0029-0000-4000-8000-00000000000a', 'aaaa0029-0000-4000-8000-0000000000a2',
          'aaaa0029-0000-4000-8000-00000000f001', '2026-08-07T10:00:00Z', 'VES', 50, 1,
          'identidad', '2026-08-07T10:00:00Z', 50, 'saldo_a_favor',
          'aaaa0029-0000-4000-8000-00000000cc01')
$$, 'y sin cuenta entra: el cobro existe, el efectivo no');
select is(
  (select balance from public.company_account_balances
    where account_id = 'aaaa0029-0000-4000-8000-0000000000e2'),
  400::numeric, 'y Banesco sigue en 400: aplicar un crédito no fabrica plata en el banco');

select * from finish();
rollback;
