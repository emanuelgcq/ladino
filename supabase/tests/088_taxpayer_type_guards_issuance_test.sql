-- =============================================================================
-- Ladino — pgTAP 88 · EL TIPO DE CONTRIBUYENTE, DEFENDIDO EN LA BASE (ADR-0072 §1)
-- Migración 20260928190100_the_taxpayer_type_guards_issuance.sql (revisión de A-03, B-07, F-11).
--
--   1. el trigger de emisión rechaza con LAD98 una factura de una empresa con RIF sin tipo vigente
--      a su fecha, y la deja pasar con el tipo declarado; SIN la comprobación nueva entra (variante
--      rota: se restituye la definición anterior dentro de un savepoint);
--   2. no_contribuyente no se declara (CHECK);
--   3. document_balance_transaction y document_debt_today funcionan como authenticated sobre un
--      documento visible (antes: permission denied for table supported_retention_receipts).
-- =============================================================================

begin;
select plan(8);

insert into auth.users (id) values ('aaaa0087-0000-4000-8000-0000000000e1');
insert into public.tenants (id, name) values ('aaaa0087-0000-4000-8000-00000000000a', 'Tenant 87');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0087-0000-4000-8000-0000000000a1', 'aaaa0087-0000-4000-8000-00000000000a',
   'J408700001', 'Empresa 87', 'VES');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0087-0000-4000-8000-0000000000b1', 'aaaa0087-0000-4000-8000-00000000000a',
   'aaaa0087-0000-4000-8000-0000000000e1');
insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
select 'aaaa0087-0000-4000-8000-00000000000a', 'aaaa0087-0000-4000-8000-0000000000b1', r.id, null
  from public.roles r where r.key = 'owner' and r.tenant_id is null;
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0087-0000-4000-8000-0000000000c1', 'aaaa0087-0000-4000-8000-00000000000a',
   'aaaa0087-0000-4000-8000-0000000000a1', 'J408700002', 'Cliente 87', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0087-0000-4000-8000-0000000000f1', 'aaaa0087-0000-4000-8000-00000000000a',
        'aaaa0087-0000-4000-8000-0000000000a1', 'formatos_libres', '2026-01-01');
select set_config('ladino.actor_id', 'aaaa0087-0000-4000-8000-0000000000e1', true);

create function pg_temp.emitir(p_id uuid, p_n int, p_cuando timestamptz) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
     control_number, regime_version_id, rules_version,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values (p_id, 'aaaa0087-0000-4000-8000-00000000000a', 'aaaa0087-0000-4000-8000-0000000000a1',
          'invoice', 'A', 'aaaa0087-0000-4000-8000-0000000000c1', 'issued', p_cuando, p_n, p_n,
          'aaaa0087-0000-4000-8000-0000000000f1', 'test-087',
          'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
$$;

-- ── 1. La puerta en la base, con su variante rota ────────────────────────────
select throws_ok($$ select pg_temp.emitir('aaaa0087-0000-4000-8000-0000000000d1', 1,
                                           '2026-09-10 15:00-04') $$,
  'LAD98', null, 'con RIF y sin tipo vigente, la base no deja emitir la factura');

savepoint roto;
-- La definición ANTERIOR (sin la comprobación del tipo) deja entrar lo mismo: el throws_ok de
-- arriba medía la comprobación nueva, no otra defensa.
do $$
declare v_def text;
begin
  v_def := pg_get_functiondef('platform.assert_document_issuance()'::regprocedure);
  -- Desde ADR-0082 la lista de tipos de ese `if` lleva además la factura de retiro y su nota: el
  -- recorte casa con la lista que haya (de 'invoice' a 'debit_note'). Lo esperado no cambia.
  v_def := regexp_replace(v_def, 'if new\.kind in \(''invoice'',[^)]*''debit_note''\) then.*?end if;\s*end if;', '', '');
  execute v_def;
end $$;
select lives_ok($$ select pg_temp.emitir('aaaa0087-0000-4000-8000-0000000000d9', 9,
                                          '2026-09-10 15:00-04') $$,
  'SIN la comprobación del tipo, la factura entra: el throws_ok medía LAD98');
rollback to savepoint roto;

insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                           effective_from, reason, rules_version)
values ('aaaa0087-0000-4000-8000-00000000000a', 'aaaa0087-0000-4000-8000-0000000000a1',
        'ordinario', '2026-09-11', 'Declaración del dueño', 'v1');
select throws_ok($$ select pg_temp.emitir('aaaa0087-0000-4000-8000-0000000000d2', 2,
                                           '2026-09-10 15:00-04') $$,
  'LAD98', null, 'una factura fechada el día ANTES de la vigencia sigue sin tipo');
select lives_ok($$ select pg_temp.emitir('aaaa0087-0000-4000-8000-0000000000d3', 3,
                                          '2026-09-11 09:00-04') $$,
  'desde el día de la vigencia, la factura se emite');

-- ── 2. no_contribuyente no se declara ────────────────────────────────────────
select throws_ok($$
  insert into public.company_taxpayer_types (tenant_id, company_id, taxpayer_type_code,
                                             effective_from, reason, rules_version)
  values ('aaaa0087-0000-4000-8000-00000000000a', 'aaaa0087-0000-4000-8000-0000000000a1',
          'no_contribuyente', '2026-09-20', 'Intento', 'v1')
$$, '23514', null, 'no_contribuyente se deriva de no tener RIF: nunca se declara');

-- ── 3. El saldo, como authenticated ──────────────────────────────────────────
select set_config('request.jwt.claims',
  '{"sub":"aaaa0087-0000-4000-8000-0000000000e1","role":"authenticated"}', true);
set local role authenticated;
select is(platform.document_balance_transaction('aaaa0087-0000-4000-8000-0000000000a1',
                                                'aaaa0087-0000-4000-8000-0000000000d3'),
  116::numeric, 'document_balance_transaction funciona como authenticated');
select is(platform.document_debt_today('aaaa0087-0000-4000-8000-0000000000a1',
                                       'aaaa0087-0000-4000-8000-0000000000d3'),
  116::numeric, 'document_debt_today también');
select is((select count(*) from public.supported_retention_receipts), 0::bigint,
  'authenticated lee la tabla de retenciones soportadas (sus empresas), sin 42501');
reset role;

select * from finish();
rollback;
