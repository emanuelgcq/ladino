-- =============================================================================
-- Ladino — pgTAP 86 · EL TALONARIO RESPONDE DE SÍ MISMO (ADR-0071, revisión)
-- Migración 20260928160200_the_talonario_answers_for_itself.sql, y los dos casos
-- que la revisión pidió sobre 160000 (H5).
--
--   H1  · el ataque del revisor: un talonario normal llamado «Contingencia-B»
--         con el mismo tramo e identificador que B se rechaza al commit; y su
--         variante rota (sin el constraint trigger, entra).
--   H3  · los datos de la imprenta solo se corrigen con acta de la misma
--         transacción; el identificador no cambia si el rango emitió; un rango
--         que emitió no se anula.
--   H5  · un documento emitido al que se le cambia el identificador → LAD06
--         (con variante rota); un rango AGOTADO pisado → 23P01.
--   H9  · emitir con control y sin identificador → LAD49.
--   H11 · la serie '' es «sin serie»: el talonario y el documento la admiten y
--         el correlativo del documento es propio de esa serie vacía.
-- =============================================================================

begin;
select plan(24);

insert into auth.users (id) values ('aaaa0081-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0081-0000-4000-8000-00000000000a', 'Tenant 81');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0081-0000-4000-8000-0000000000a2', 'aaaa0081-0000-4000-8000-00000000000a',
   'J-81-A', 'Empresa 81');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0081-0000-4000-8000-00000000c001', 'aaaa0081-0000-4000-8000-00000000000a',
   'aaaa0081-0000-4000-8000-0000000000a2', 'J-CLI-81', 'Cliente 81', 'juridica', 'ordinario');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0081-0000-4000-8000-00000000e100', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
select set_config('ladino.actor_id', 'aaaa0081-0000-4000-8000-0000000000a1', true);
-- La puerta de emisión exige el tipo de contribuyente declarado (ADR-0072, migración 20260928190100).
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, notified_on, reason, rules_version)
values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2', 'ordinario',
        '2026-01-01', null, 'pgTAP 086', 'test-086');

-- El talonario B completo, 1-100.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source,
   printer_legal_name, printer_tax_id, printer_authorization, printer_authorization_date, printed_on)
values ('aaaa0081-0000-4000-8000-00000000e001', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', null, 'B', 1, 100, 1, 'Gráficas 81, C.A.',
        'Gráficas 81, C.A.', 'J123456789', 'SNAT/2020/1', '2020-01-15', '2026-09-01');

-- ── H1. El ataque: «Contingencia-B» sin registro de contingencia ─────────────
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0081-0000-4000-8000-00000000e002', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', null, 'Contingencia-B', 1, 100, 1,
        'Un talonario normal disfrazado');
select throws_ok(
  $$ set constraints fiscal_number_ranges_contingency_membership immediate $$,
  'LAD69', null,
  'H1: «Contingencia-B» con el tramo de B y sin registro de contingencia se rechaza al commit');
set constraints fiscal_number_ranges_contingency_membership deferred;
delete from public.fiscal_number_ranges where id = 'aaaa0081-0000-4000-8000-00000000e002';

-- El camino legítimo: el rango y su registro de contingencia en la misma transacción.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0081-0000-4000-8000-00000000e003', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', 'invoice', 'contingencia-1', 200, 250, 200,
        'Talonario físico de contingencia');
insert into public.contingency_ranges
  (tenant_id, company_id, fiscal_number_range_id, reason, failure_started_at)
values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
        'aaaa0081-0000-4000-8000-00000000e003', 'Falla del proveedor de internet', now());
select lives_ok(
  $$ set constraints fiscal_number_ranges_contingency_membership immediate $$,
  'el talonario de contingencia registrado por su camino pasa la comprobación');
set constraints fiscal_number_ranges_contingency_membership deferred;
select throws_ok($$
  update public.fiscal_number_ranges set series = 'B2'
   where id = 'aaaa0081-0000-4000-8000-00000000e003';
  set constraints all immediate
$$, 'LAD69', null, 'y un talonario de contingencia no se renombra a serie normal');
set constraints fiscal_number_ranges_contingency_membership deferred;

-- ── H3. Imprenta, identificador, anulación ───────────────────────────────────
select throws_ok($$
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)',
  'H3: corregir la imprenta de un talonario completo SIN acta se rechaza');
select throws_ok($$
  select set_config('ladino.range_printer_correction', gen_random_uuid()::text, true);
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)',
  'un GUC que no apunta a un acta de esta transacción no abre la puerta');

-- A2/A3: actas que NO abren la puerta. Cada una apunta a un acta existente pero equivocada.
insert into public.audit_events
  (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
   rules_version, payload)
values
  -- de OTRO rango (el de contingencia), con el txid y el «después» correctos
  ('aaaa0081-0000-4000-8000-0000000ace01', 'aaaa0081-0000-4000-8000-00000000000a',
   'aaaa0081-0000-4000-8000-0000000000a2', 'fiscal_number_range',
   'aaaa0081-0000-4000-8000-00000000e003', 'fiscal.range.printer_corrected', 'user', now(),
   'test-086', jsonb_build_object('txid', pg_current_xact_id()::text, 'despues', jsonb_build_object(
     'printer_identifier', '00', 'printer_legal_name', 'Otra imprenta',
     'printer_tax_id', 'J123456789', 'printer_authorization', 'SNAT/2020/1',
     'printer_authorization_date', '2020-01-15', 'printed_on', '2026-09-01'))),
  -- del MISMO rango con OTRO event_type
  ('aaaa0081-0000-4000-8000-0000000ace02', 'aaaa0081-0000-4000-8000-00000000000a',
   'aaaa0081-0000-4000-8000-0000000000a2', 'fiscal_number_range',
   'aaaa0081-0000-4000-8000-00000000e001', 'fiscal.range.printer_completed', 'user', now(),
   'test-086', jsonb_build_object('txid', pg_current_xact_id()::text, 'despues', jsonb_build_object(
     'printer_identifier', '00', 'printer_legal_name', 'Otra imprenta',
     'printer_tax_id', 'J123456789', 'printer_authorization', 'SNAT/2020/1',
     'printer_authorization_date', '2020-01-15', 'printed_on', '2026-09-01'))),
  -- del MISMO rango y tipo, pero de OTRA transacción (txid ajeno)
  ('aaaa0081-0000-4000-8000-0000000ace03', 'aaaa0081-0000-4000-8000-00000000000a',
   'aaaa0081-0000-4000-8000-0000000000a2', 'fiscal_number_range',
   'aaaa0081-0000-4000-8000-00000000e001', 'fiscal.range.printer_corrected', 'user', now(),
   'test-086', jsonb_build_object('txid', '1', 'despues', jsonb_build_object(
     'printer_identifier', '00', 'printer_legal_name', 'Otra imprenta',
     'printer_tax_id', 'J123456789', 'printer_authorization', 'SNAT/2020/1',
     'printer_authorization_date', '2020-01-15', 'printed_on', '2026-09-01'))),
  -- del MISMO rango, tipo y transacción, pero cuyo «después» dice OTRA cosa
  ('aaaa0081-0000-4000-8000-0000000ace04', 'aaaa0081-0000-4000-8000-00000000000a',
   'aaaa0081-0000-4000-8000-0000000000a2', 'fiscal_number_range',
   'aaaa0081-0000-4000-8000-00000000e001', 'fiscal.range.printer_corrected', 'user', now(),
   'test-086', jsonb_build_object('txid', pg_current_xact_id()::text, 'despues', jsonb_build_object(
     'printer_identifier', '00', 'printer_legal_name', 'Lo que el acta dijo',
     'printer_tax_id', 'J123456789', 'printer_authorization', 'SNAT/2020/1',
     'printer_authorization_date', '2020-01-15', 'printed_on', '2026-09-01')));
select throws_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000ace01', true);
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)', 'A2: el acta de OTRO rango no abre la puerta');
select throws_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000ace02', true);
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)', 'A2: un acta del mismo rango con OTRO event_type no abre la puerta');
select throws_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000ace03', true);
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)', 'A3: un acta de OTRA transacción (txid ajeno) no abre la puerta');
select throws_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000ace04', true);
  update public.fiscal_number_ranges set printer_legal_name = 'Otra imprenta'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)', 'A3: un acta cuyo «después» no es lo que se escribe no abre la puerta');
select set_config('ladino.range_printer_correction', '', true);
insert into public.audit_events
  (id, tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
   rules_version, payload)
values ('aaaa0081-0000-4000-8000-0000000aced1', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', 'fiscal_number_range',
        'aaaa0081-0000-4000-8000-00000000e001', 'fiscal.range.printer_corrected', 'user', now(),
        'test-081', jsonb_build_object(
          'motivo', 'la imprenta cambió de razón social',
          'txid', pg_current_xact_id()::text,
          'despues', jsonb_build_object(
            'printer_identifier', '00', 'printer_legal_name', 'Gráficas 81 Nueva, C.A.',
            'printer_tax_id', 'J123456789', 'printer_authorization', 'SNAT/2020/1',
            'printer_authorization_date', '2020-01-15', 'printed_on', '2026-09-01')));
select lives_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000aced1', true);
  update public.fiscal_number_ranges set printer_legal_name = 'Gráficas 81 Nueva, C.A.'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'con el acta de esta transacción, la corrección entra');
select set_config('ladino.range_printer_correction', '', true);

-- El rango emite un control: desde aquí ni identificador nuevo ni anulación.
select is(
  (select control_number from platform.claim_fiscal_control(
     'aaaa0081-0000-4000-8000-0000000000a2', 'invoice', 'B')),
  1::bigint, 'el talonario B emite su control 1');
select throws_ok($$
  select set_config('ladino.range_printer_correction', 'aaaa0081-0000-4000-8000-0000000aced1', true);
  update public.fiscal_number_ranges set printer_identifier = '05'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: el identificador de un talonario que ya emitió no cambia: está impreso en sus documentos (ADR-0071)',
  'el identificador de un talonario que ya emitió no cambia, ni con acta');
select set_config('ladino.range_printer_correction', '', true);
select throws_ok($$
  update public.fiscal_number_ranges set status = 'cancelled'
   where id = 'aaaa0081-0000-4000-8000-00000000e001'
$$, 'LAD06', 'LAD06: un talonario que ya emitió no se anula: sus controles están en documentos (ADR-0071)', 'un talonario que ya emitió no se anula');

-- ── H5 (b). Un rango AGOTADO pisado → 23P01 ─────────────────────────────────
update public.fiscal_number_ranges set next_available = 101, status = 'exhausted'
 where id = 'aaaa0081-0000-4000-8000-00000000e001';
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          null, 'C', 90, 110, 90, 'Pisa un agotado')
$$, '23P01', null, 'H5: un talonario que pisa uno AGOTADO se rechaza: sus controles ya se imprimieron');

-- Un talonario que no emitió nada sí se anula.
insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0081-0000-4000-8000-00000000e004', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', null, 'D', 500, 600, 500, 'Sin usar');
select lives_ok($$
  update public.fiscal_number_ranges set status = 'cancelled'
   where id = 'aaaa0081-0000-4000-8000-00000000e004'
$$, 'un talonario que no emitió nada se puede anular');

-- ── H9. Emitir con control y sin identificador → LAD49 ──────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0081-0000-4000-8000-00000000f001', 'aaaa0081-0000-4000-8000-00000000000a',
        'aaaa0081-0000-4000-8000-0000000000a2', 'invoice', 'B',
        'aaaa0081-0000-4000-8000-00000000c001', 'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10);
select throws_ok($$
  update public.documents
     set status = 'issued', issued_at = now(), document_number = 1, control_number = 1,
         regime_version_id = 'aaaa0081-0000-4000-8000-00000000e100', rules_version = 'test-081'
   where id = 'aaaa0081-0000-4000-8000-00000000f001'
$$, 'LAD49', null, 'H9: emitir con número de control y SIN identificador se rechaza (no hay «00» silencioso)');
select lives_ok($$
  update public.documents
     set status = 'issued', issued_at = now(), document_number = 1, control_number = 1,
         control_identifier = '00',
         regime_version_id = 'aaaa0081-0000-4000-8000-00000000e100', rules_version = 'test-081'
   where id = 'aaaa0081-0000-4000-8000-00000000f001'
$$, 'con su identificador, emite');

-- ── H5 (a). El identificador de un documento emitido no cambia ──────────────
select throws_ok($$
  update public.documents set control_identifier = '07'
   where id = 'aaaa0081-0000-4000-8000-00000000f001'
$$, 'LAD06', 'LAD06: el identificador del número de control de un documento emitido es inmutable (ADR-0071)',
  'H5: cambiar el identificador de un documento emitido → LAD06');

-- ── H11. Sin serie ───────────────────────────────────────────────────────────
select lives_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source,
     printer_legal_name, printer_tax_id, printer_authorization, printer_authorization_date, printed_on)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          null, '', 1000, 1100, 1000, 'Papel sin serie', 'Gráficas 81, C.A.', 'J123456789',
          'SNAT/2020/1', '2020-01-15', '2026-09-01')
$$, 'H11: un talonario SIN serie se registra con serie vacía');
select is(
  (select control_number from platform.claim_fiscal_control(
     'aaaa0081-0000-4000-8000-0000000000a2', 'invoice', '')),
  1000::bigint, 'y emite su control');
select is(
  platform.claim_document_number('aaaa0081-0000-4000-8000-0000000000a2', 'invoice', ''),
  1::bigint, 'el número de factura sin serie es su propio correlativo: empieza en 1');
select throws_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          null, ' A', 2000, 2100, 2000, 'Serie con espacio')
$$, '23514', null, 'la serie sigue sin admitir espacios alrededor');

-- ── Variantes rotas ─────────────────────────────────────────────────────────
-- H5 (a): sin el trigger del identificador, el cambio sobre un emitido entra.
drop trigger documents_03_control_identifier on public.documents;
select lives_ok($$
  update public.documents set control_identifier = '07'
   where id = 'aaaa0081-0000-4000-8000-00000000f001'
$$, 'sin documents_03_control_identifier el identificador de un emitido cambia: el LAD06 de arriba lo medía');

-- H1: sin el constraint trigger, «Contingencia-B» entra y pasa el commit simulado.
drop trigger fiscal_number_ranges_contingency_membership on public.fiscal_number_ranges;
drop trigger fiscal_number_ranges_contingency_membership_upd on public.fiscal_number_ranges;
select lives_ok($$
  insert into public.fiscal_number_ranges
    (tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
  values ('aaaa0081-0000-4000-8000-00000000000a', 'aaaa0081-0000-4000-8000-0000000000a2',
          null, 'Contingencia-B', 1, 100, 1, 'El ataque, sin la defensa');
  set constraints all immediate
$$, 'sin el constraint trigger el ataque de H1 entra: el LAD69 de arriba lo medía');

select * from finish();
rollback;
