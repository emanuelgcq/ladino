-- =============================================================================
-- Ladino — pgTAP 33 · LA VENTA EMPIEZA POR LA CÉDULA (migración 33)
--
-- Lo que esto prueba, con sus variantes rotas:
--
--   1. la clave natural del cliente es el documento NORMALIZADO: dos formas
--      del mismo RIF (con guiones, sin guiones, en minúscula) CHOCAN;
--   2. el snapshot del cliente en `documents` es nullable y SIN default (los
--      documentos viejos no se backfillean) y queda CONGELADO al escribirse:
--      cambiarlo es LAD68, y «rellenar» uno viejo también — un backfill es
--      una inferencia sobre el pasado;
--   3. un update legítimo (el estado) pasa con el snapshot intacto;
--   4. `allow_unidentified_sales` nace en TRUE: apagar la venta de mostrador
--      es una decisión del dueño, no un default que bloquea.
-- =============================================================================

begin;
select plan(10);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0033-0000-4000-8000-00000000000a', 'Tenant 33');
insert into public.companies (id, tenant_id, tax_id, legal_name, taxpayer_type_code) values
  ('aaaa0033-0000-4000-8000-0000000000a2', 'aaaa0033-0000-4000-8000-00000000000a',
   'J-33-A', 'Empresa 33', 'ordinario');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code, fiscal_address) values
  ('aaaa0033-0000-4000-8000-00000000c001', 'aaaa0033-0000-4000-8000-00000000000a',
   'aaaa0033-0000-4000-8000-0000000000a2', 'J-40123456-7', 'Comercial Treinta y Tres, C.A.',
   'juridica', 'ordinario', 'Av. Bolívar, local 3, Valencia');

-- ── 1. La clave natural normalizada ──────────────────────────────────────────
select throws_ok(
  $$insert into public.customers (tenant_id, company_id, tax_id, legal_name,
                                  person_type_code, taxpayer_type_code)
    values ('aaaa0033-0000-4000-8000-00000000000a', 'aaaa0033-0000-4000-8000-0000000000a2',
            'J401234567', 'El mismo cliente sin guiones', 'juridica', 'ordinario')$$,
  '23505',
  null,
  'El mismo RIF sin guiones es el MISMO cliente: choca contra la clave natural');

select throws_ok(
  $$insert into public.customers (tenant_id, company_id, tax_id, legal_name,
                                  person_type_code, taxpayer_type_code)
    values ('aaaa0033-0000-4000-8000-00000000000a', 'aaaa0033-0000-4000-8000-0000000000a2',
            'j-40.123.456-7', 'El mismo cliente en minúscula y con puntos', 'juridica', 'ordinario')$$,
  '23505',
  null,
  'Minúsculas y puntos también normalizan: sigue chocando');

select lives_ok(
  $$insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                                  person_type_code, taxpayer_type_code)
    values ('aaaa0033-0000-4000-8000-00000000c002', 'aaaa0033-0000-4000-8000-00000000000a',
            'aaaa0033-0000-4000-8000-0000000000a2', 'V12345678', 'Otra persona', 'natural',
            'consumidor_final')$$,
  'Un documento DISTINTO convive sin problema');

-- ── 2. El snapshot: nullable, sin default, congelado ─────────────────────────
select is(
  (select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'documents'
      and column_name in ('customer_name_snapshot', 'customer_tax_id_snapshot',
                          'customer_address_snapshot')
      and is_nullable = 'YES' and column_default is null),
  3::bigint,
  'Las tres columnas del snapshot existen, nullable y SIN default (el pasado no se backfillea)');

insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
   customer_name_snapshot, customer_tax_id_snapshot, customer_address_snapshot)
values ('aaaa0033-0000-4000-8000-00000000f001', 'aaaa0033-0000-4000-8000-00000000000a',
        'aaaa0033-0000-4000-8000-0000000000a2', 'quote', 'A',
        'aaaa0033-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'identidad',
        1160, 1160, 1000, 160, 1160,
        'Comercial Treinta y Tres, C.A.', 'J401234567', 'Av. Bolívar, local 3, Valencia');

select throws_ok(
  $$update public.documents
       set customer_name_snapshot = 'Otro nombre que reescribe la historia'
     where id = 'aaaa0033-0000-4000-8000-00000000f001'$$,
  'LAD68',
  null,
  'Cambiar el nombre del snapshot es LAD68: a quién se le vendió no se reescribe');

select throws_ok(
  $$update public.documents set customer_address_snapshot = null
     where id = 'aaaa0033-0000-4000-8000-00000000f001'$$,
  'LAD68',
  null,
  'Borrar el domicilio del snapshot también es LAD68');

-- Un documento VIEJO (sin snapshot) tampoco se rellena después: eso sería un
-- backfill fila a fila, la misma inferencia sobre el pasado con otra cara.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, status,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0033-0000-4000-8000-00000000f002', 'aaaa0033-0000-4000-8000-00000000000a',
        'aaaa0033-0000-4000-8000-0000000000a2', 'quote', 'A',
        'aaaa0033-0000-4000-8000-00000000c001', 'draft', 'VES', 'VES', 1, 'identidad',
        580, 580, 500, 80, 580);

select throws_ok(
  $$update public.documents set customer_name_snapshot = 'Rellenado a posteriori'
     where id = 'aaaa0033-0000-4000-8000-00000000f002'$$,
  'LAD68',
  null,
  'Rellenar el snapshot de un documento viejo es LAD68: NULL honesto > backfill');

-- ── 3. El update legítimo pasa con el snapshot intacto ───────────────────────
select lives_ok(
  $$update public.documents set status = 'cancelled'
     where id = 'aaaa0033-0000-4000-8000-00000000f001'$$,
  'Cambiar el ESTADO no toca el snapshot y pasa');

select is(
  (select customer_name_snapshot from public.documents
    where id = 'aaaa0033-0000-4000-8000-00000000f001'),
  'Comercial Treinta y Tres, C.A.',
  'Tras el cambio de estado, el snapshot sigue diciendo lo mismo');

-- ── 4. El interruptor nace encendido ─────────────────────────────────────────
insert into public.company_settings (company_id, tenant_id) values
  ('aaaa0033-0000-4000-8000-0000000000a2', 'aaaa0033-0000-4000-8000-00000000000a');
select is(
  (select allow_unidentified_sales from public.company_settings
    where company_id = 'aaaa0033-0000-4000-8000-0000000000a2'),
  true,
  'allow_unidentified_sales nace en TRUE: apagarlo es decisión del dueño');

select * from finish();
rollback;
