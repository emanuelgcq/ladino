-- =============================================================================
-- Ladino — pgTAP 80 · UN CORRELATIVO DE CONTROL POR EMISOR (ADR-0071)
-- Migraciones 20260928160000_one_control_sequence_per_issuer.sql y
-- 20260928160100_control_collisions_are_watched.sql. Hallazgos G-01, E-01, B-03.
--
-- Qué se prueba (cada defensa con su variante rota):
--   1. la exclusión: ningún rango pisa otro del mismo identificador, sea de la
--      clase que sea; otro identificador o un rango anulado no chocan; y SIN
--      la exclusión el solape entra (el throws_ok medía la exclusión);
--   2. el único de control de documents no mira la clase: factura y NC con el
--      mismo control chocan (23505); SIN el índice entran, y entonces
--      control_number_collisions() los lista — es lo que hace fallar la
--      migración cuando el emisor ya trae repetidos;
--   3. claim_fiscal_control: un talonario sirve a las tres clases, exige los
--      datos de la imprenta y habla en español (E-17, G-16);
--   4. los datos de la imprenta se escriben una vez; el identificador del
--      control acompaña al documento y es inmutable una vez emitido.
-- =============================================================================

begin;
select plan(25);

insert into auth.users (id) values ('aaaa0080-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0080-0000-4000-8000-00000000000a', 'Tenant 80');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0080-0000-4000-8000-0000000000a2', 'aaaa0080-0000-4000-8000-00000000000a',
   'J-80-A', 'Empresa 80');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0080-0000-4000-8000-00000000c001', 'aaaa0080-0000-4000-8000-00000000000a',
   'aaaa0080-0000-4000-8000-0000000000a2', 'J-CLI-80', 'Cliente 80', 'juridica', 'ordinario');
select set_config('ladino.actor_id', 'aaaa0080-0000-4000-8000-0000000000a1', true);

-- El talonario completo, sin clase, serie B, 1-100.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source,
   printer_legal_name, printer_tax_id, printer_authorization, printer_authorization_date, printed_on)
values ('aaaa0080-0000-4000-8000-00000000e001', 'aaaa0080-0000-4000-8000-00000000000a',
        'aaaa0080-0000-4000-8000-0000000000a2', null, 'B', 1, 100, 1, 'Gráficas 80, C.A.',
        'Gráficas 80, C.A.', 'J123456789', 'SNAT/INTI/GRTI/RCO/2020/000123', '2020-01-15',
        '2026-09-01');

-- ── 1. La exclusión ──────────────────────────────────────────────────────────
select is(
  (select printer_identifier from public.fiscal_number_ranges
    where id = 'aaaa0080-0000-4000-8000-00000000e001'),
  '00', 'el identificador por omisión es «00» (PA 00071 art. 44)');
select ok(
  (select printer_data_complete from public.fiscal_number_ranges
    where id = 'aaaa0080-0000-4000-8000-00000000e001'),
  'con los cinco datos de la imprenta, el talonario está completo');

select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'C', 100, 150, 100, 'Otra serie, mismo identificador')
$$, '23P01', null,
  'un talonario de OTRA serie que pisa un solo número (el 100) se rechaza: el control es único '
  'por emisor, no por serie');
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          'debit_note', 'B', 50, 60, 50, 'Una clase distinta no escapa')
$$, '23P01', null, 'un rango de notas de débito dentro del talonario se rechaza');
select lives_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
     next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'B', '01', 1, 100, 1, 'Identificador 01')
$$, 'el mismo tramo con OTRO identificador no choca: el control lleva los dos campos');
select lives_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source,
     status)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'Z', 10, 20, 10, 'Anulado', 'cancelled')
$$, 'un rango ANULADO no bloquea ni es bloqueado');
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'D', 1, 100000000, 1, 'Nueve dígitos')
$$, '23514', null, 'el secuencial tiene hasta 8 dígitos (art. 44)');
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
     next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'D', '7', 500, 600, 500, 'Un dígito')
$$, '23514', null, 'el identificador son exactamente 2 dígitos');
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source,
     printer_tax_id)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          null, 'D', 500, 600, 500, 'RIF con guiones', 'J-12345678-9')
$$, '23514', null, 'el RIF de la imprenta se guarda normalizado (letra + 9 dígitos)');

-- ── 2. El único de control, sin la clase ─────────────────────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, control_number,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0080-0000-4000-8000-00000000f001', 'aaaa0080-0000-4000-8000-00000000000a',
        'aaaa0080-0000-4000-8000-0000000000a2', 'invoice', 'B',
        'aaaa0080-0000-4000-8000-00000000c001', 7, 'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10);
select is(
  (select control_identifier from public.documents where id = 'aaaa0080-0000-4000-8000-00000000f001'),
  '00', 'un control escrito sin identificador lleva el «00» del talonario por omisión');
select throws_ok($$
  insert into public.documents
    (tenant_id, company_id, kind, series, customer_id, control_number,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          'credit_note', 'A', 'aaaa0080-0000-4000-8000-00000000c001', 7,
          'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10)
$$, '23505', null,
  'G-01: una NC de otra serie con el control de una factura se rechaza — el único ya no mira la clase');
select lives_ok($$
  insert into public.documents
    (tenant_id, company_id, kind, series, customer_id, control_number, control_identifier,
     transaction_currency, functional_currency, fx_rate, rate_source,
     amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          'credit_note', 'B', 'aaaa0080-0000-4000-8000-00000000c001', 7, '01',
          'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10)
$$, 'el mismo control con OTRO identificador es otro número de control');
select is(
  (select count(*) from platform.control_number_collisions()
    where company_id = 'aaaa0080-0000-4000-8000-0000000000a2'),
  0::bigint, 'con el índice vivo, el invariante responde cero');

-- ── 3. claim_fiscal_control ──────────────────────────────────────────────────
select is(
  (select control_number from platform.claim_fiscal_control(
     'aaaa0080-0000-4000-8000-0000000000a2', 'invoice', 'B')),
  1::bigint, 'la factura consume el control 1 del talonario B');
select is(
  (select control_number from platform.claim_fiscal_control(
     'aaaa0080-0000-4000-8000-0000000000a2', 'credit_note', 'B')),
  2::bigint, 'la NC consume el SIGUIENTE del mismo talonario: un solo correlativo');
select is(
  (select format('%s-%s', control_identifier, lpad(control_number::text, 8, '0'))
     from platform.claim_fiscal_control('aaaa0080-0000-4000-8000-0000000000a2', 'debit_note', 'B')),
  '00-00000003', 'la ND sigue con el 3, y el control viaja con su identificador');
select throws_matching(
  $$ select * from platform.claim_fiscal_control('aaaa0080-0000-4000-8000-0000000000a2', 'debit_note', 'Q') $$,
  '^No quedan números de control para notas de débito \(identificador 00\)\. Carga el talonario nuevo\.$',
  'E-17/G-16: sin talonario, el mensaje es de persona y la clase va en español');
select throws_matching(
  $$ select * from platform.claim_fiscal_control('aaaa0080-0000-4000-8000-0000000000a2', 'invoice', 'Z') $$,
  'No quedan números de control para facturas',
  'un talonario ANULADO no da números');
-- El talonario de identificador 01 (serie B) nació sin datos de imprenta; el de
-- 00 se agota para que el claim llegue a él.
update public.fiscal_number_ranges set next_available = 101, status = 'exhausted'
 where id = 'aaaa0080-0000-4000-8000-00000000e001';
select throws_matching(
  $$ select * from platform.claim_fiscal_control('aaaa0080-0000-4000-8000-0000000000a2', 'invoice', 'B') $$,
  'le faltan los datos de la imprenta',
  'B-03: sin los datos de la imprenta no se emite con ese talonario');
select ok(
  not has_function_privilege('ladino_api', 'platform.claim_control_number(uuid, text, text)', 'execute')
  and has_function_privilege('ladino_api', 'platform.claim_fiscal_control(uuid, text, text)', 'execute'),
  'la API solo emite con la función que exige la imprenta');

-- ── 4. Inmutabilidades ───────────────────────────────────────────────────────
select throws_ok($$
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0080-0000-4000-8000-00000000e001'
$$, 'LAD06', null, 'los datos de la imprenta de un talonario completo no se reescriben');
select lives_ok($$
  update public.fiscal_number_ranges
     set printer_legal_name = 'Imprenta 01', printer_tax_id = 'J987654321',
         printer_authorization = 'SNAT/2021/1', printer_authorization_date = '2021-02-02',
         printed_on = '2026-09-02'
   where company_id = 'aaaa0080-0000-4000-8000-0000000000a2' and printer_identifier = '01'
$$, 'completar los datos de un talonario incompleto sí se puede');

-- ── 2 bis. La variante rota: sin el índice, los repetidos entran y el
--    invariante los ve. Es lo que la migración comprueba antes de crearlo.
drop index public.documents_control_uidx;
insert into public.documents
  (tenant_id, company_id, kind, series, customer_id, control_number,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
        'credit_note', 'A', 'aaaa0080-0000-4000-8000-00000000c001', 7,
        'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10);
select is(
  (select documents from platform.control_number_collisions()
    where company_id = 'aaaa0080-0000-4000-8000-0000000000a2' and control_number = 7
      and control_identifier = '00'),
  'credit_note A-, invoice B-',
  'sin el índice el repetido entra, y control_number_collisions() lo lista: el throws_ok de '
  'arriba medía el índice, y la migración falla con esta lista');
select throws_ok($$
  do $g$ begin
    if exists (select 1 from platform.control_number_collisions()) then
      raise exception 'LAD52: controles repetidos' using errcode = 'LAD52';
    end if;
  end $g$
$$, 'LAD52', null, 'el gate de la migración (160100) falla ante los repetidos');

-- ── 1 bis. La variante rota de la exclusión: sin ella, el solape de G-01 entra.
alter table public.fiscal_number_ranges drop constraint fiscal_number_ranges_no_overlap;
select lives_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0080-0000-4000-8000-00000000000a', 'aaaa0080-0000-4000-8000-0000000000a2',
          'credit_note', 'B', 1, 50, 1, 'El solape de G-01')
$$, 'sin la exclusión el solape entra: los 23P01 de arriba medían la exclusión');

select * from finish();
rollback;
