-- =============================================================================
-- Ladino — pgTAP 124 · Fiar exige permiso y límite (migración 20261004140000, E-09)
--
--   1. los dos permisos y su reparto por oficio: el cajero fía y NO fija límites;
--   2. un cliente NACE con límite 0 (LAD78) y el límite no es negativo (23514);
--   3. por el camino de servidor, cambiar el límite sin `customers.credit.set` muere (LAD79) y
--      el dato queda intacto; con el permiso vive y deja ACTA con el valor anterior y el nuevo;
--   4. aislamiento con el usuario de DOS tenants: su permiso en A no le sirve en B;
--   5. `platform.customer_credit`: límite, deuda y disponible en USD, sobre LA función de deuda;
--      sin tasa de hoy la deuda no se dice (NULL), nunca un cero;
--   6. la variante rota: sin el trigger, el cambio sin permiso entra y no deja rastro — las
--      aserciones de 3 miden el trigger.
-- =============================================================================
begin;
select plan(28);

-- ── Montaje ──────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0124-0000-4000-8000-0000000000a1'),   -- UA: customer.manage (como un cajero)
  ('aaaa0124-0000-4000-8000-0000000000b1'),   -- UB: customers.credit.set en A
  ('aaaa0124-0000-4000-8000-0000000000c1');   -- UC: de los DOS tenants; credit.set solo en A
insert into public.tenants (id, name) values
  ('aaaa0124-0000-4000-8000-00000000000a', 'Tenant 124 A'),
  ('aaaa0124-0000-4000-8000-00000000000b', 'Tenant 124 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0124-0000-4000-8000-0000000000a2', 'aaaa0124-0000-4000-8000-00000000000a',
   'J-124-A', 'Empresa 124 A', 'VES', 'ordinario'),
  ('aaaa0124-0000-4000-8000-0000000000b2', 'aaaa0124-0000-4000-8000-00000000000b',
   'J-124-B', 'Empresa 124 B', 'VES', 'ordinario');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
select c.tenant_id, c.id, 'ordinario', '2000-01-01', 'Montaje pgTAP 124', 'pgtap'
  from public.companies c
 where c.id in ('aaaa0124-0000-4000-8000-0000000000a2', 'aaaa0124-0000-4000-8000-0000000000b2');
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0124-0000-4000-8000-0000000000e1', null, 'gestor124', 'Gestor', false),
  ('aaaa0124-0000-4000-8000-0000000000e2', null, 'credito124', 'Crédito', false);
insert into public.role_permissions (role_id, permission_key) values
  ('aaaa0124-0000-4000-8000-0000000000e1', 'customer.manage'),
  ('aaaa0124-0000-4000-8000-0000000000e2', 'customer.manage'),
  ('aaaa0124-0000-4000-8000-0000000000e2', 'customers.credit.set');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0124-0000-4000-8000-0000000000a3', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000a1'),
  ('aaaa0124-0000-4000-8000-0000000000b3', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000b1'),
  ('aaaa0124-0000-4000-8000-0000000000c3', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000c1'),
  ('aaaa0124-0000-4000-8000-0000000000c4', 'aaaa0124-0000-4000-8000-00000000000b',
   'aaaa0124-0000-4000-8000-0000000000c1');
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0124-0000-4000-8000-0000000000a4', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000a3', 'aaaa0124-0000-4000-8000-0000000000e1', null),
  ('aaaa0124-0000-4000-8000-0000000000b4', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000b3', 'aaaa0124-0000-4000-8000-0000000000e2', null),
  -- UC: en A fija límites; en B solo gestiona clientes.
  ('aaaa0124-0000-4000-8000-0000000000c5', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000c3', 'aaaa0124-0000-4000-8000-0000000000e2', null),
  ('aaaa0124-0000-4000-8000-0000000000c6', 'aaaa0124-0000-4000-8000-00000000000b',
   'aaaa0124-0000-4000-8000-0000000000c4', 'aaaa0124-0000-4000-8000-0000000000e1', null);
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0124-0000-4000-8000-00000000c00a', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000a2', 'J-CLI-124A', 'Cliente 124 A', 'juridica', 'ordinario'),
  ('aaaa0124-0000-4000-8000-00000000c00b', 'aaaa0124-0000-4000-8000-00000000000b',
   'aaaa0124-0000-4000-8000-0000000000b2', 'J-CLI-124B', 'Cliente 124 B', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0124-0000-4000-8000-00000000e10a', 'aaaa0124-0000-4000-8000-00000000000a',
        'aaaa0124-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- ── 1. Los permisos y su reparto ─────────────────────────────────────────────
create function pg_temp.rol_tiene(p_rol text, p_permiso text) returns boolean
language sql as $$
  select exists (select 1 from public.role_permissions rp
                   join public.roles r on r.id = rp.role_id and r.tenant_id is null
                  where r.key = p_rol and rp.permission_key = p_permiso)
$$;
select is(
  (select count(*) from public.permissions where key in ('sales.credit', 'customers.credit.set')),
  2::bigint, 'los dos permisos del fiado existen');
-- Migración 20261004210100: el permiso gobierna las DOS puertas (caja y factura de administración).
select matches(
  (select description from public.permissions where key = 'sales.credit'),
  '^Vender a crédito \(fiar en la caja y facturar a crédito\)',
  'sales.credit dice lo que gobierna: la caja y la factura a crédito');
select ok(pg_temp.rol_tiene('cashier', 'sales.credit')
          and not pg_temp.rol_tiene('cashier', 'customers.credit.set'),
  'el cajero fía, y NO fija límites');
select ok(pg_temp.rol_tiene('back_office', 'customers.credit.set')
          and pg_temp.rol_tiene('owner', 'customers.credit.set')
          and pg_temp.rol_tiene('back_office', 'sales.credit')
          and pg_temp.rol_tiene('owner', 'sales.credit'),
  'el administrativo y el dueño fían y fijan límites');
select ok(not pg_temp.rol_tiene('accountant', 'sales.credit')
          and not pg_temp.rol_tiene('warehouse_ops', 'sales.credit')
          and not pg_temp.rol_tiene('store_manager', 'customers.credit.set'),
  'ni el contador ni el almacenista fían; el encargado no fija límites');

-- ── 2. Nace en 0 y no es negativo ────────────────────────────────────────────
select is(
  (select credit_limit_usd::text from public.customers
    where id = 'aaaa0124-0000-4000-8000-00000000c00a'),
  '0.00000000', 'un cliente creado sin decir nada nace con límite 0');
select throws_ok($$
  insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code,
                                taxpayer_type_code, credit_limit_usd)
  values ('aaaa0124-0000-4000-8000-00000000000a', 'aaaa0124-0000-4000-8000-0000000000a2',
          'J-CLI-124X', 'Con límite de regalo', 'juridica', 'ordinario', 500) $$,
  'LAD78', null, 'un alta con límite distinto de 0 muere (LAD78), venga de quien venga');
select throws_ok($$
  update public.customers set credit_limit_usd = -1
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  '23514', null, 'un límite negativo lo rechaza el CHECK');

-- ── 3. El camino de servidor: sin permiso muere, con permiso deja acta ───────
select set_config('ladino.rules_version', 'test-124', true);
select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select throws_ok($$
  update public.customers set credit_limit_usd = 1000
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  'LAD79', null, 'UA (customer.manage, sin customers.credit.set) no fija el límite: LAD79');
reset role;
select is(
  (select credit_limit_usd::text from public.customers
    where id = 'aaaa0124-0000-4000-8000-00000000c00a'),
  '0.00000000', '…y el límite queda intacto');
select is(
  (select count(*) from public.audit_events
    where aggregate_id = 'aaaa0124-0000-4000-8000-00000000c00a'
      and event_type = 'customer.credit_limit_set'),
  0::bigint, '…sin acta de un cambio que no ocurrió');

select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000b1', true);
set local role ladino_api;
select lives_ok($$
  update public.customers set credit_limit_usd = 100
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  'UB (customers.credit.set) fija el límite: el camino autorizado vive');
-- Editar otra cosa, como hace la edición rutinaria, no pasa por el guardia.
select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000a1', true);
select lives_ok($$
  update public.customers set phone = '0251-5550124'
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  'UA sigue pudiendo editar el resto de la ficha');
reset role;
select is(
  (select payload->>'credit_limit_usd_anterior' || ' → ' || (payload->>'credit_limit_usd_nuevo')
          || ' ' || actor_type || ' ' || rules_version
     from public.audit_events
    where aggregate_id = 'aaaa0124-0000-4000-8000-00000000c00a'
      and event_type = 'customer.credit_limit_set'),
  '0.00000000 → 100.00000000 user test-124',
  'el acta guarda el valor anterior, el nuevo, quién y la versión de reglas');
-- Como owner de la base (soporte, migración): pasa, y queda en el acta como `system`.
select set_config('ladino.actor_id', '', true);
update public.customers set credit_limit_usd = 100
 where id = 'aaaa0124-0000-4000-8000-00000000c00a';
select is(
  (select count(*) from public.audit_events
    where aggregate_id = 'aaaa0124-0000-4000-8000-00000000c00a'
      and event_type = 'customer.credit_limit_set'),
  1::bigint, 'fijar el mismo valor no es un cambio: no hay segunda acta');

-- ── 4. Aislamiento, con el usuario de los dos tenants ────────────────────────
select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000b1', true);
set local role ladino_api;
update public.customers set credit_limit_usd = 999
 where id = 'aaaa0124-0000-4000-8000-00000000c00b';
reset role;
select is(
  (select credit_limit_usd::text from public.customers
    where id = 'aaaa0124-0000-4000-8000-00000000c00b'),
  '0.00000000', 'UB (solo del tenant A) no cambia el límite de un cliente de B: 0 filas, dato intacto');
select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000c1', true);
set local role ladino_api;
select throws_ok($$
  update public.customers set credit_limit_usd = 999
   where id = 'aaaa0124-0000-4000-8000-00000000c00b' $$,
  'LAD79', null,
  'UC es de los dos tenants y fija límites en A: en B, donde solo gestiona clientes, LAD79');
select lives_ok($$
  update public.customers set credit_limit_usd = 150
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  '…y en A, donde sí tiene el permiso, vive');
reset role;
select is(
  (select credit_limit_usd::text from public.customers
    where id = 'aaaa0124-0000-4000-8000-00000000c00b'),
  '0.00000000', 'el cliente de B sigue en 0');

-- ── 5. Límite, deuda y disponible ────────────────────────────────────────────
select set_config('ladino.actor_id', '', true);
select is(
  (select limit_usd::text || ' ' || debt_usd::text || ' ' || available_usd::text
     from platform.customer_credit('aaaa0124-0000-4000-8000-0000000000a2',
                                   'aaaa0124-0000-4000-8000-00000000c00a')),
  '150.00000000 0 150.00000000', 'sin documentos: debe 0 y dispone de todo el límite');
select is(
  (select count(*) from platform.customer_credit('aaaa0124-0000-4000-8000-0000000000a2',
                                                 'aaaa0124-0000-4000-8000-00000000c00b')),
  0::bigint, 'un cliente de otra empresa no tiene crédito aquí: cero filas');

-- La tasa de HOY, propia de esta transacción (se va con el rollback).
delete from public.exchange_rates
 where company_id is null and from_currency = 'USD' and to_currency = 'VES'
   and rate_date = platform.caracas_day(now());
insert into public.exchange_rates
  (from_currency, to_currency, rate, rate_date, rate_timestamp, source)
values ('USD', 'VES', 50, platform.caracas_day(now()), now(), 'pgtap-124');
-- Una factura en Bs (1.160,00) y otra en USD (100,00), las dos sin cobrar.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0124-0000-4000-8000-00000000f001', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0124-0000-4000-8000-00000000c00a', 1, 12401, 'issued', now(),
   'aaaa0124-0000-4000-8000-00000000e10a', 'test-124', 'VES', 'VES', 1, 'identidad',
   1160, 1160, 1000, 160, 1160);
select is(
  (select debt_usd::text || ' ' || available_usd::text
     from platform.customer_credit('aaaa0124-0000-4000-8000-0000000000a2',
                                   'aaaa0124-0000-4000-8000-00000000c00a')),
  '23.20 126.80000000',
  'debe 1.160,00 Bs: a la tasa de hoy (50) son USD 23,20, y dispone de 126,80');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0124-0000-4000-8000-00000000f002', 'aaaa0124-0000-4000-8000-00000000000a',
   'aaaa0124-0000-4000-8000-0000000000a2', 'invoice', 'A',
   'aaaa0124-0000-4000-8000-00000000c00a', 2, 12402, 'issued', now(),
   'aaaa0124-0000-4000-8000-00000000e10a', 'test-124', 'USD', 'VES', 40, 'BCV test',
   150, 6000, 6000, 0, 6000);
select is(
  (select debt_usd::text || ' ' || available_usd::text
     from platform.customer_credit('aaaa0124-0000-4000-8000-0000000000a2',
                                   'aaaa0124-0000-4000-8000-00000000c00a')),
  '173.20 0',
  'con otra de USD 150 debe 173,20: pasado el límite, el disponible es 0, nunca negativo');
select is(
  platform.customer_debt_today('aaaa0124-0000-4000-8000-0000000000a2',
                               'aaaa0124-0000-4000-8000-00000000c00a')::text,
  '8660.00',
  'y es LA función de deuda la que lo dice: 1.160 + 150 × 50 = 8.660,00 Bs, que ÷ 50 son 173,20');
-- Sin tasa de hoy la deuda no se puede decir: NULL, jamás un cero que dejaría fiar.
delete from public.exchange_rates where source = 'pgtap-124';
select ok(
  (select debt_usd is null and available_usd is null and limit_usd = 150
     from platform.customer_credit('aaaa0124-0000-4000-8000-0000000000a2',
                                   'aaaa0124-0000-4000-8000-00000000c00a')),
  'sin tasa de hoy, deuda y disponible van en NULL: quien decide un fiado lo rechaza');

-- ── 6. La variante rota: sin el trigger, entra y no deja rastro ──────────────
-- Sin ALTER TABLE (que pide un candado sobre customers y estorba a quien esté vendiendo): con
-- session_replication_role = replica los triggers ordinarios no disparan en ESTA transacción.
set local session_replication_role = replica;
select set_config('ladino.actor_id', 'aaaa0124-0000-4000-8000-0000000000a1', true);
set local role ladino_api;
select lives_ok($$
  update public.customers set credit_limit_usd = 1000
   where id = 'aaaa0124-0000-4000-8000-00000000c00a' $$,
  'ROTO: sin el trigger, UA (sin permiso) cambia el límite — LAD79 lo producía el trigger');
reset role;
select is(
  (select count(*) from public.audit_events
    where aggregate_id = 'aaaa0124-0000-4000-8000-00000000c00a'
      and event_type = 'customer.credit_limit_set'),
  2::bigint, 'ROTO: y no deja acta (siguen las dos de antes) — el acta la escribía el trigger');
-- (Con los triggers apagados tampoco corre el de procedencia: created_at se pone a mano.)
select lives_ok($$
  insert into public.customers (tenant_id, company_id, tax_id, legal_name, person_type_code,
                                taxpayer_type_code, credit_limit_usd, created_at, version)
  values ('aaaa0124-0000-4000-8000-00000000000a', 'aaaa0124-0000-4000-8000-0000000000a2',
          'J-CLI-124Y', 'Con límite de regalo', 'juridica', 'ordinario', 500, now(), 1) $$,
  'ROTO: sin su trigger, un cliente nace con límite — LAD78 lo producía el trigger');
set local session_replication_role = origin;

select * from finish();
rollback;
