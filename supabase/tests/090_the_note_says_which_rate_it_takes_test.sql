-- =============================================================================
-- Ladino — pgTAP 90 · LA NOTA DICE A QUÉ TASA VA (hallazgo 13, §2.7, G-11)
-- Migraciones 20260928160500_the_note_says_which_rate_it_takes.sql (la columna y su
-- inmutabilidad) y 20260928160600_the_rate_basis_belongs_to_notes.sql (los CHECK).
--
--   · `rate_basis` de una nota EMITIDA no cambia (LAD06), con su variante rota;
--   · solo una nota lleva `rate_basis`; `own_day` solo la lleva una nota de débito.
-- =============================================================================

begin;
select plan(9);

insert into auth.users (id) values ('aaaa0090-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values ('aaaa0090-0000-4000-8000-00000000000a', 'Tenant 90');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0090-0000-4000-8000-0000000000a2', 'aaaa0090-0000-4000-8000-00000000000a',
   'J-90-A', 'Empresa 90');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0090-0000-4000-8000-00000000c001', 'aaaa0090-0000-4000-8000-00000000000a',
   'aaaa0090-0000-4000-8000-0000000000a2', 'J123456789', 'Cliente 90', 'juridica', 'ordinario');
select set_config('ladino.actor_id', 'aaaa0090-0000-4000-8000-0000000000a1', true);
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0090-0000-4000-8000-00000000e100', 'aaaa0090-0000-4000-8000-00000000000a',
        'aaaa0090-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');

-- Borradores: los CHECK miran la fila tal cual, sin la puerta de emisión.
create function pg_temp.borrador(p_kind text, p_basis text) returns void
language sql as $$
  insert into public.documents
    (tenant_id, company_id, kind, series, customer_id, rate_basis,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values ('aaaa0090-0000-4000-8000-00000000000a', 'aaaa0090-0000-4000-8000-0000000000a2',
          p_kind, 'A', 'aaaa0090-0000-4000-8000-00000000c001', p_basis,
          'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10)
$$;

-- ── B-1: solo una nota lleva rate_basis; own_day solo la ND ─────────────────
select throws_ok($$ select pg_temp.borrador('invoice', 'origin') $$, '23514', null,
  'una factura no lleva rate_basis: no es una nota que corrija otra');
select lives_ok($$ select pg_temp.borrador('invoice', null) $$,
  'una factura sin rate_basis entra');
select lives_ok($$ select pg_temp.borrador('credit_note', 'origin') $$,
  'la NC va a la tasa de la factura: origin entra');
select throws_ok($$ select pg_temp.borrador('credit_note', 'own_day') $$, '23514', null,
  'una NC no va a la tasa de su día: corrige la factura, deshace sus Bs (§2.7)');
select lives_ok($$ select pg_temp.borrador('debit_note', 'own_day') $$,
  'la ND por un concepto nuevo va a la tasa de su día: own_day entra');
select lives_ok($$ select pg_temp.borrador('credit_note', null) $$,
  'una nota anterior a la columna (NULL) sigue entrando: se lee como origin');

-- ── B-2: rate_basis de una nota EMITIDA no cambia ───────────────────────────
-- Se marca emitida sin pasar por la puerta de emisión (que exige régimen, talonario y tipo de
-- contribuyente, y no es lo que se prueba aquí): el trigger de inmutabilidad mira old.status.
set local session_replication_role = replica;
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, rate_basis, status, issued_at,
   document_number, created_at, version, regime_version_id, rules_version, transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0090-0000-4000-8000-00000000f001', 'aaaa0090-0000-4000-8000-00000000000a',
        'aaaa0090-0000-4000-8000-0000000000a2', 'debit_note', 'A',
        'aaaa0090-0000-4000-8000-00000000c001', 'origin', 'issued', now(), 1, now(), 1,
        'aaaa0090-0000-4000-8000-00000000e100', 'test-090',
        'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10);
set local session_replication_role = origin;
select throws_ok($$
  update public.documents set rate_basis = 'own_day'
   where id = 'aaaa0090-0000-4000-8000-00000000f001'
$$, 'LAD06', 'LAD06: la base de la tasa de un documento emitido es inmutable, como la tasa misma (§2.7)',
  'la base de la tasa de una ND emitida no cambia: va junto a la tasa congelada');
select is(
  (select rate_basis from public.documents where id = 'aaaa0090-0000-4000-8000-00000000f001'),
  'origin', 'y la fila sigue diciendo origin');

-- La variante rota: sin el trigger, la base de una nota emitida cambia.
drop trigger documents_04_rate_basis_frozen on public.documents;
select lives_ok($$
  update public.documents set rate_basis = 'own_day'
   where id = 'aaaa0090-0000-4000-8000-00000000f001'
$$, 'sin documents_04_rate_basis_frozen la base cambia: el LAD06 de arriba lo medía');

select * from finish();
rollback;
