-- =============================================================================
-- Ladino — pgTAP 43 · Perfil del negocio, users_profile y el helper de RIF
--
--   1. companies gana sus seis columnas de perfil y el CHECK muerde;
--   2. users_profile: cada quien lee SOLO su ficha; authenticated no escribe;
--   3. company_has_fiscal_documents, LAS DOS CARAS: un negocio lleno de
--      RECIBOS emitidos da false (los recibos no llevan RIF y jamás bloquean
--      la transición PEND-* → RIF real); UNA factura emitida da true;
--   4. el bucket company-logos existe con su policy y el tenant B NO lee el
--      logo del tenant A.
-- =============================================================================

begin;
select plan(13);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values
  ('aaaa0043-0000-4000-8000-00000000aaa1'),
  ('aaaa0043-0000-4000-8000-00000000bbb1');
insert into public.tenants (id, name) values
  ('aaaa0043-0000-4000-8000-00000000000a', 'Tenant 43-A'),
  ('aaaa0043-0000-4000-8000-00000000000b', 'Tenant 43-B');
insert into public.memberships (id, tenant_id, user_id) values
  ('aaaa0043-0000-4000-8000-00000000ee01', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-00000000aaa1'),
  ('aaaa0043-0000-4000-8000-00000000ee02', 'aaaa0043-0000-4000-8000-00000000000b',
   'aaaa0043-0000-4000-8000-00000000bbb1');
-- Membresía SOLA no da visibilidad (regla del catálogo, ADR-0049): la
-- asignación de rol es la que abre ladino_company_ids().
insert into public.roles (id, tenant_id, key, name, requires_scope) values
  ('aaaa0043-0000-4000-8000-00000000dd01', null, 'rol_test_43', 'Rol 43', false);
insert into public.user_role_assignments (id, tenant_id, membership_id, role_id, company_id) values
  ('aaaa0043-0000-4000-8000-00000000da01', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-00000000ee01', 'aaaa0043-0000-4000-8000-00000000dd01', null),
  ('aaaa0043-0000-4000-8000-00000000da02', 'aaaa0043-0000-4000-8000-00000000000b',
   'aaaa0043-0000-4000-8000-00000000ee02', 'aaaa0043-0000-4000-8000-00000000dd01', null);
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0043-0000-4000-8000-0000000000a1', 'aaaa0043-0000-4000-8000-00000000000a',
   'PEND-43A', 'Bodega de recibos 43', null),
  ('aaaa0043-0000-4000-8000-0000000000a2', 'aaaa0043-0000-4000-8000-00000000000a',
   'J-43-F', 'Facturadora 43, C.A.', 'ordinario'),
  ('aaaa0043-0000-4000-8000-0000000000b1', 'aaaa0043-0000-4000-8000-00000000000b',
   'J-43-B', 'Vecina 43, C.A.', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from) values
  ('aaaa0043-0000-4000-8000-00000000e101', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-0000000000a1', 'sin_facturacion', '2026-01-01'),
  ('aaaa0043-0000-4000-8000-00000000e102', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
insert into public.customers (id, tenant_id, company_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0043-0000-4000-8000-00000000c001', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-0000000000a1', 'Vecino 43', 'natural', 'consumidor_final'),
  ('aaaa0043-0000-4000-8000-00000000c002', 'aaaa0043-0000-4000-8000-00000000000a',
   'aaaa0043-0000-4000-8000-0000000000a2', 'Cliente 43', 'natural', 'consumidor_final');

-- ── 1. Las columnas de perfil existen y el CHECK muerde ──────────────────────
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'companies'
      and column_name in ('business_type', 'phone', 'whatsapp', 'city', 'state', 'logo_path')),
  6::bigint, 'companies tiene las seis columnas de perfil');

select throws_ok(
  $$update public.companies set business_type = 'x'
     where id = 'aaaa0043-0000-4000-8000-0000000000a1'$$,
  '23514', null,
  'un rubro de un carácter se rechaza: el CHECK de perfil muerde');

-- ── 2. users_profile: la ficha es de cada quien ──────────────────────────────
select lives_ok(
  $$insert into public.users_profile (user_id, full_name, national_id) values
    ('aaaa0043-0000-4000-8000-00000000aaa1', 'Ana de la Bodega', 'V-12345678'),
    ('aaaa0043-0000-4000-8000-00000000bbb1', 'Beto el Vecino', null)$$,
  'las fichas se crean (la procedencia la pone el trigger)');

select set_config('request.jwt.claims',
  '{"sub":"aaaa0043-0000-4000-8000-00000000aaa1","role":"authenticated"}', true);
set local role authenticated;
select is((select count(*) from public.users_profile), 1::bigint,
  'A ve exactamente UNA ficha');
select is((select full_name from public.users_profile), 'Ana de la Bodega',
  'y es la suya');
select throws_ok(
  $$insert into public.users_profile (user_id, full_name)
    values ('aaaa0043-0000-4000-8000-00000000aaa1', 'Impostora')$$,
  '42501', null,
  'authenticated no escribe fichas: escribe la API');
reset role;

-- ── 3. company_has_fiscal_documents: las dos caras ───────────────────────────
select is(platform.company_has_fiscal_documents('aaaa0043-0000-4000-8000-0000000000a2'),
  false, 'sin documentos, false: el RIF se puede tocar');

-- El negocio de recibos EMITE un recibo…
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0043-0000-4000-8000-00000000f001',
        'aaaa0043-0000-4000-8000-00000000000a', 'aaaa0043-0000-4000-8000-0000000000a1',
        'receipt', 'R', 'aaaa0043-0000-4000-8000-00000000c001', 'issued', now(), 1,
        'aaaa0043-0000-4000-8000-00000000e101', 'test-043',
        'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100);
select is(platform.company_has_fiscal_documents('aaaa0043-0000-4000-8000-0000000000a1'),
  false, 'un RECIBO emitido NO cuenta: nunca bloquea la transición PEND-* → RIF real');

-- …y la facturadora emite UNA factura.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status, issued_at, document_number,
   control_number, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0043-0000-4000-8000-00000000f002',
        'aaaa0043-0000-4000-8000-00000000000a', 'aaaa0043-0000-4000-8000-0000000000a2',
        'invoice', 'A', 'aaaa0043-0000-4000-8000-00000000c002', 'issued', now(), 1,
        1, 'aaaa0043-0000-4000-8000-00000000e102', 'test-043',
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);
select is(platform.company_has_fiscal_documents('aaaa0043-0000-4000-8000-0000000000a2'),
  true, 'UNA factura emitida basta: el RIF queda bloqueado (nivel 2 de la política)');

-- ── 4. El bucket y su aislamiento ────────────────────────────────────────────
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'company_logos_select'),
  1::bigint, 'la policy company_logos_select existe');

insert into storage.objects (bucket_id, name) values
  ('company-logos', 'aaaa0043-0000-4000-8000-0000000000a1/logo/x/original.webp'),
  ('company-logos', 'aaaa0043-0000-4000-8000-0000000000b1/logo/x/original.webp');

select set_config('request.jwt.claims',
  '{"sub":"aaaa0043-0000-4000-8000-00000000aaa1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*) from storage.objects where bucket_id = 'company-logos'),
  1::bigint, 'A ve exactamente UN logo en el bucket');
select is(
  (select split_part(name, '/', 1) from storage.objects where bucket_id = 'company-logos'),
  'aaaa0043-0000-4000-8000-0000000000a1', 'y es el de SU empresa');
reset role;

select set_config('request.jwt.claims',
  '{"sub":"aaaa0043-0000-4000-8000-00000000bbb1","role":"authenticated"}', true);
set local role authenticated;
select is(
  (select count(*) from storage.objects
    where bucket_id = 'company-logos'
      and split_part(name, '/', 1) = 'aaaa0043-0000-4000-8000-0000000000a1'),
  0::bigint, 'la variante rota: B no lee el logo de A');
reset role;

select * from finish();
rollback;
