-- =============================================================================
-- Ladino — pgTAP 34 · EL SNAPSHOT DEL EMISOR (migración 34) — RIGOR MÁXIMO
--
-- PA 00071 art. 13.5 con el patrón R-05: el documento COPIA razón social, RIF
-- y domicilio del emisor al nacer. Esto prueba, con variantes rotas:
--   1. las columnas nuevas son nullable y SIN default (el pasado no se
--      backfillea; el domicilio no se inventa);
--   2. el snapshot del emisor queda CONGELADO al escribirse (LAD68), también
--      contra el «relleno» de un documento viejo;
--   3. un update legítimo (estado) pasa con el snapshot intacto.
-- =============================================================================

begin;
select plan(8);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0034-0000-4000-8000-00000000000a', 'Tenant 34');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code,
                              fiscal_address) values
  ('aaaa0034-0000-4000-8000-0000000000a2', 'aaaa0034-0000-4000-8000-00000000000a',
   'J-34-A', 'Empresa 34, C.A.', 'ordinario', 'Av. Treinta y Cuatro, Caracas');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0034-0000-4000-8000-00000000c001', 'aaaa0034-0000-4000-8000-00000000000a',
   'aaaa0034-0000-4000-8000-0000000000a2', 'V-34-1', 'Cliente 34', 'natural',
   'consumidor_final');

-- ── 1. Columnas nullable, sin default ────────────────────────────────────────
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name in ('issuer_name_snapshot', 'issuer_tax_id_snapshot',
                          'issuer_address_snapshot', 'issuer_branch_address_snapshot')
      and is_nullable = 'YES' and column_default is null),
  4::bigint,
  'Las cuatro columnas del snapshot del emisor: nullable y SIN default');

select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public'
      and ((table_name = 'companies' and column_name = 'fiscal_address')
        or (table_name = 'branches' and column_name = 'fiscal_address'))
      and is_nullable = 'YES' and column_default is null),
  2::bigint,
  'El domicilio fiscal existe en companies y branches, NULL honesto por defecto');

-- ── 2. El congelado ──────────────────────────────────────────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
   issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot)
values ('aaaa0034-0000-4000-8000-00000000f001', 'aaaa0034-0000-4000-8000-00000000000a',
        'aaaa0034-0000-4000-8000-0000000000a2', 'quote', 'A',
        'aaaa0034-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'identidad',
        1160, 1160, 1000, 160, 1160,
        'Empresa 34, C.A.', 'J34A', 'Av. Treinta y Cuatro, Caracas');

select throws_ok(
  $$update public.documents
       set issuer_name_snapshot = 'Otra razón social que reescribe quién emitió'
     where id = 'aaaa0034-0000-4000-8000-00000000f001'$$,
  'LAD68',
  null,
  'Cambiar la razón social del snapshot del emisor es LAD68');

select throws_ok(
  $$update public.documents set issuer_address_snapshot = null
     where id = 'aaaa0034-0000-4000-8000-00000000f001'$$,
  'LAD68',
  null,
  'Borrar el domicilio del snapshot del emisor también es LAD68');

-- Un documento VIEJO (sin snapshot) tampoco se rellena a posteriori.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0034-0000-4000-8000-00000000f002', 'aaaa0034-0000-4000-8000-00000000000a',
        'aaaa0034-0000-4000-8000-0000000000a2', 'quote', 'A',
        'aaaa0034-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'identidad',
        580, 580, 500, 80, 580);

select throws_ok(
  $$update public.documents set issuer_name_snapshot = 'Rellenado a posteriori'
     where id = 'aaaa0034-0000-4000-8000-00000000f002'$$,
  'LAD68',
  null,
  'Rellenar el snapshot del emisor en un documento viejo es LAD68: NULL honesto > backfill');

-- ── 3. El update legítimo pasa ───────────────────────────────────────────────
select lives_ok(
  $$update public.documents set status = 'cancelled'
     where id = 'aaaa0034-0000-4000-8000-00000000f001'$$,
  'Cambiar el ESTADO no toca el snapshot del emisor y pasa');

select is(
  (select issuer_name_snapshot from public.documents
    where id = 'aaaa0034-0000-4000-8000-00000000f001'),
  'Empresa 34, C.A.',
  'Tras el cambio de estado, el emisor congelado sigue diciendo lo mismo');

-- Y los DOS congelados (cliente de la 33, emisor de la 34) conviven en la misma
-- fila sin pisarse: el update de estado pasó por ambos triggers.
select is(
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where c.relname = 'documents'
      and t.tgname in ('documents_customer_snapshot_freeze', 'documents_issuer_snapshot_freeze')),
  2::bigint,
  'Los dos triggers de congelado están puestos sobre documents');

select * from finish();
rollback;
