-- =============================================================================
-- Ladino — pgTAP 21 · VENTAS (migración 21) — RIGOR MÁXIMO
--
-- Las diez del encargo, ejercidas:
--   1. consumo ATÓMICO del número de control: dos peticiones dan números
--      distintos, ambas se registran, ninguna colisiona;
--   2. issued SIN control cuando el régimen lo exige → LAD49;
--   3. issued CON control cuando el régimen NO lo permite → LAD49;
--   4. emisión sin tax_rule vigente → LAD50;
--   5. con regla vigente, rate_snapshot == catálogo; y cambiar tax_rules
--      DESPUÉS no altera la factura emitida;
--   6. anular conserva document_number: el siguiente NO reutiliza el hueco;
--   7. devolución al costo ORIGINAL: cambiar el costo actual no la altera;
--   8. diferencial cambiario contra un valor calculado A MANO;
--   9. saldo a favor: la NC genera crédito, aplicarlo descuenta, pasarse rechaza;
--  10. aging: facturas a distintas fechas caen en los cuatro rangos correctos.
-- Más: append-only del documento en las DOS capas distinguibles, y aislamiento.
-- =============================================================================

begin;
select plan(65);

-- ── Fixtures ─────────────────────────────────────────────────────────────────
insert into auth.users (id) values ('aaaa0021-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0021-0000-4000-8000-00000000000a', 'Tenant 21'),
  ('aaaa0021-0000-4000-8000-00000000000b', 'Tenant 21-B');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0021-0000-4000-8000-0000000000a2', 'aaaa0021-0000-4000-8000-00000000000a', 'J-21-A', 'Empresa 21'),
  ('aaaa0021-0000-4000-8000-0000000000b2', 'aaaa0021-0000-4000-8000-00000000000b', 'J-21-B', 'Empresa 21-B');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0021-0000-4000-8000-00000000ff01', 'aaaa0021-0000-4000-8000-00000000000a',
   'aaaa0021-0000-4000-8000-0000000000a2', 'W1', 'Principal');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0021-0000-4000-8000-00000000c001', 'aaaa0021-0000-4000-8000-00000000000a',
   'aaaa0021-0000-4000-8000-0000000000a2', 'J-CLI-21', 'Cliente 21', 'juridica', 'ordinario');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code, tax_category_code) values
  ('aaaa0021-0000-4000-8000-00000000d001', 'aaaa0021-0000-4000-8000-00000000000a',
   'aaaa0021-0000-4000-8000-0000000000a2', 'PROD-21', 'Producto 21', 'good', 'active', 'unidad', 'gravado_general');
insert into public.price_lists (id, tenant_id, company_id, name, currency_code) values
  ('aaaa0021-0000-4000-8000-00000000e001', 'aaaa0021-0000-4000-8000-00000000000a',
   'aaaa0021-0000-4000-8000-0000000000a2', 'detal', 'USD');

-- ── 1. El catálogo NACE VACÍO (ADR-0038) ────────────────────────────────────
select is((select count(*) from public.tax_rules), 0::bigint,
  'tax_rules nace VACÍA: la migración no siembra ni una alícuota (ADR-0038)');
select is((select count(*) from public.fiscal_regimes where numbering_mode = 'per_document'),
  0::bigint,
  'ningún régimen se siembra en per_document: el flujo de dos fases sigue abierto (VALIDAR-SENIAT)');
select is((select count(*) from public.fiscal_regimes where length(btrim(legal_source)) < 3),
  0::bigint, 'ningún régimen sin norma citada: un régimen sin fuente es una obligación inventada');
select is(
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname='public' and c.relname in
      ('fiscal_regimes','company_fiscal_regimes','tax_rules','exchange_rates',
       'fiscal_number_ranges','documents','document_lines','payments','customer_credits',
       'exchange_gain_loss','returns','return_lines','stock_reservations')
      and c.relrowsecurity and c.relforcerowsecurity),
  13::bigint, 'las trece tablas de ventas con RLS habilitada y FORZADA');

-- ── 2. resolve_tax: sin regla, NO hay emisión (LAD50) ───────────────────────
select throws_ok(
  $$ select * from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'ordinario', 'gravado_general') $$,
  'LAD50', null,
  'sin regla vigente resolve_tax FALLA: no devuelve cero, porque un cero que parece '
  'correcto es un delito tributario (ADR-0038)');

-- La regla de prueba, con su fuente marcada COMO DE PRUEBA.
insert into public.tax_rules
  (jurisdiction, tax_code, taxpayer_type, transaction_type, product_tax_category,
   rate, effective_from, legal_source, priority)
values ('VE', 'iva', null, 'sale', 'gravado_general', 0.16, '2026-01-01',
        'REGLA DE PRUEBA pgTAP 021 — no es una fuente normativa real', 100);
select is(
  (select rate from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'ordinario', 'gravado_general')),
  0.16::numeric, 'con regla vigente, resolve_tax la devuelve');
select throws_ok(
  $$ select * from platform.resolve_tax('2025-06-01'::date, 'VE', 'iva', 'ordinario', 'gravado_general') $$,
  'LAD50', null,
  'antes de su vigencia FALLA con LAD50 en vez de devolver NULL: la fecha es parámetro '
  'y una regla futura no aplica al pasado');

-- Dos reglas IGUAL de específicas: ambigüedad del catálogo, no elección.
insert into public.tax_rules
  (jurisdiction, tax_code, taxpayer_type, transaction_type, product_tax_category,
   rate, effective_from, legal_source, priority)
values ('VE', 'iva', null, 'sale', 'gravado_general', 0.10, '2026-01-01',
        'REGLA DE PRUEBA duplicada', 100);
select throws_ok(
  $$ select * from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'ordinario', 'gravado_general') $$,
  'LAD50', null,
  'dos reglas con la MISMA prioridad detienen la emisión: elegir una por orden de '
  'inserción sería arbitrario y no reproducible');
delete from public.tax_rules where rate = 0.10;
-- Lo específico gana a lo general por prioridad.
insert into public.tax_rules
  (jurisdiction, tax_code, taxpayer_type, transaction_type, product_tax_category,
   rate, effective_from, legal_source, priority)
values ('VE', 'iva', 'especial', 'sale', 'gravado_general', 0.08, '2026-01-01',
        'REGLA DE PRUEBA específica', 200);
select is(
  (select rate from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'especial', 'gravado_general')),
  0.08::numeric, 'lo específico (taxpayer especial, prioridad 200) gana a lo general');
select is(
  (select rate from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'ordinario', 'gravado_general')),
  0.16::numeric, 'y el ordinario sigue con la general');

-- ── 3. Tasa de cambio con fuente ────────────────────────────────────────────
insert into public.exchange_rates (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
values ('USD', 'VES', 40.00000000, 'BCV', '2026-08-01', '2026-08-01T10:00:00Z'),
       ('USD', 'VES', 50.00000000, 'BCV', '2026-09-01', '2026-09-01T10:00:00Z');
select is(platform.rate_at('USD', 'VES', '2026-08-15'), 40.00000000::numeric,
  'rate_at el 15-ago: la tasa del 1-ago, la más reciente que no es posterior');
select is(platform.rate_at('USD', 'VES', '2026-09-15'), 50.00000000::numeric,
  'rate_at el 15-sep: ya la del 1-sep — la FECHA es parámetro, nunca now()');
select is(platform.rate_at('USD', 'VES', '2025-01-01'), null::numeric,
  'antes de toda tasa: NULL, no un invento');

-- ── 4. Régimen fiscal y numeración ──────────────────────────────────────────
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0021-0000-4000-8000-00000000e100', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'formatos_libres', '2026-01-01');
select is(
  (select numbering_mode from platform.regime_at('aaaa0021-0000-4000-8000-0000000000a2', now())),
  'range', 'el régimen vigente de la empresa exige número de control de un rango');
select throws_ok(
  $$ insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
     values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
             'sin_emision', '2026-06-01') $$,
  '23P01', null,
  'dos regímenes vigentes a la vez: imposible por EXCLUDE — «cuál regía» tiene UNA respuesta');

insert into public.fiscal_number_ranges
  (id, tenant_id, company_id, kind, series, range_from, range_to, next_available, printer_source)
values ('aaaa0021-0000-4000-8000-00000000e200', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A', 1001, 1003, 1001,
        'Imprenta de prueba, autorización ficticia pgTAP 021');

-- CONSUMO ATÓMICO: dos peticiones consecutivas dan números DISTINTOS.
select is(platform.claim_control_number('aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A'),
  1001::bigint, 'el primer número de control del rango: 1001');
select is(platform.claim_control_number('aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A'),
  1002::bigint, 'la segunda petición da 1002: NO se repite');
select is(
  (select next_available from public.fiscal_number_ranges
    where id = 'aaaa0021-0000-4000-8000-00000000e200'),
  1003::bigint, 'y el rango avanzó: el estado quedó en el DATO, no en memoria');
select is(platform.claim_control_number('aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A'),
  1003::bigint, 'el último del rango');
select is(
  (select status from public.fiscal_number_ranges where id = 'aaaa0021-0000-4000-8000-00000000e200'),
  'exhausted', 'consumido el último, el rango se marca AGOTADO solo');
select throws_ok(
  $$ select platform.claim_control_number('aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A') $$,
  'LAD49', null,
  'rango agotado DETIENE la emisión: emitir fuera del rango autorizado sería emitir '
  'un documento inválido');

-- Un rango nuevo para seguir, y la alerta de agotamiento.
insert into public.fiscal_number_ranges
  (tenant_id, company_id, kind, series, range_from, range_to, next_available,
   printer_source, alert_threshold_pct)
values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
        'invoice', 'A', 2000, 2009, 2000, 'Imprenta de prueba, segundo rango', 50);
select is(
  (select count(*) from platform.range_exhaustion('aaaa0021-0000-4000-8000-0000000000a2')),
  0::bigint, 'un rango recién cargado no está por agotarse');

-- ── 5. Emisión: las dos direcciones de la regla de control (LAD49) ──────────
-- Primero, LA PUERTA GRANDE: un INSERT directo con status='issued' no puede
-- saltarse la validación. Solo comprobar en UPDATE dejaría que quien escriba
-- SQL a mano emita sin régimen ni control — y «que el caso de uso siempre
-- inserte en draft» no es una defensa (CLAUDE.md §2).
select throws_ok(
  $$ insert into public.documents
       (tenant_id, company_id, kind, series, customer_id, document_number, status, issued_at,
        rules_version, transaction_currency, functional_currency, fx_rate, rate_source,
        amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
     values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
             'invoice', 'Z', 'aaaa0021-0000-4000-8000-00000000c001', 9001, 'issued', now(),
             'test-021', 'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10) $$,
  'LAD49', null,
  'un INSERT DIRECTO con status=issued y sin régimen declarado muere igual: el trigger '
  'dispara en INSERT y en UPDATE, no solo en UPDATE');
select set_config('ladino.actor_id', 'aaaa0021-0000-4000-8000-0000000000a1', true);
select set_config('ladino.rules_version', 'test-021', true);

-- Documento borrador (sin número, sin control): es lo único que un draft puede ser.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, price_list_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values ('aaaa0021-0000-4000-8000-00000000f001', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0021-0000-4000-8000-00000000c001', 'aaaa0021-0000-4000-8000-00000000e001',
        'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116);

-- issued SIN control_number, con régimen `range`: RECHAZADO.
select throws_ok(
  $$ update public.documents
        set status = 'issued', issued_at = now(), document_number = 1,
            regime_version_id = 'aaaa0021-0000-4000-8000-00000000e100', rules_version = 'test-021'
      where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'LAD49', null,
  'issued SIN número de control con un régimen que lo exige: LAD49 (ADR-0037)');

-- issued CON control_number: vive.
select lives_ok(
  $$ update public.documents
        set status = 'issued', issued_at = now(), document_number = 1, control_number = 2000,
            regime_version_id = 'aaaa0021-0000-4000-8000-00000000e100', rules_version = 'test-021'
      where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'con número de control del rango autorizado, la emisión vive');

-- La dirección contraria: un régimen que NO usa control, con control.
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0021-0000-4000-8000-0000000000a3', 'aaaa0021-0000-4000-8000-00000000000a', 'J-21-C', 'Empresa interna');
insert into public.company_fiscal_regimes (id, tenant_id, company_id, regime_code, effective_from)
values ('aaaa0021-0000-4000-8000-00000000e101', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a3', 'interno_no_fiscal', '2026-01-01');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0021-0000-4000-8000-00000000c002', 'aaaa0021-0000-4000-8000-00000000000a',
   'aaaa0021-0000-4000-8000-0000000000a3', 'J-CLI-C', 'Cliente C', 'juridica', 'ordinario');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0021-0000-4000-8000-00000000f002', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a3', 'quote', 'A',
        'aaaa0021-0000-4000-8000-00000000c002', 'VES', 'VES', 1, 'identidad', 50, 50, 50, 0, 50);
select throws_ok(
  $$ update public.documents
        set status = 'issued', issued_at = now(), document_number = 1, control_number = 999,
            regime_version_id = 'aaaa0021-0000-4000-8000-00000000e101', rules_version = 'test-021'
      where id = 'aaaa0021-0000-4000-8000-00000000f002' $$,
  'LAD49', null,
  'issued CON número de control en un régimen que no lo usa: LAD49 — un control sin '
  'imprenta autorizada es un dato inventado');
select lives_ok(
  $$ update public.documents
        set status = 'issued', issued_at = now(), document_number = 1,
            regime_version_id = 'aaaa0021-0000-4000-8000-00000000e101', rules_version = 'test-021'
      where id = 'aaaa0021-0000-4000-8000-00000000f002' $$,
  'sin control, en ese régimen, vive');

-- Sin régimen vigente no se emite.
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code) values
  ('aaaa0021-0000-4000-8000-00000000c003', 'aaaa0021-0000-4000-8000-00000000000b',
   'aaaa0021-0000-4000-8000-0000000000b2', 'J-CLI-B', 'Cliente B', 'juridica', 'ordinario');
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0021-0000-4000-8000-00000000f003', 'aaaa0021-0000-4000-8000-00000000000b',
        'aaaa0021-0000-4000-8000-0000000000b2', 'invoice', 'A',
        'aaaa0021-0000-4000-8000-00000000c003', 'VES', 'VES', 1, 'identidad', 10, 10, 10, 0, 10);
select throws_ok(
  $$ update public.documents set status = 'issued', issued_at = now(), document_number = 1,
            rules_version = 'test-021'
      where id = 'aaaa0021-0000-4000-8000-00000000f003' $$,
  'LAD49', null, 'una empresa SIN régimen fiscal vigente no puede emitir');

-- ── 6. La línea persiste la regla y su alícuota; cambiar el catálogo después
--       NO altera la factura emitida (ADR-0038, R-05 aplicado al impuesto) ───
insert into public.document_lines
  (id, tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, price_list_applied_id,
   tax_rule_id, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional,
   line_total_transaction, line_total_functional,
   amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
   functional_currency, rate_source, rate_timestamp, rounding_policy_id, cost_snapshot)
select 'aaaa0021-0000-4000-8000-00000000f101', 'aaaa0021-0000-4000-8000-00000000000a',
       'aaaa0021-0000-4000-8000-0000000000a2', 'aaaa0021-0000-4000-8000-00000000f001', 1,
       'aaaa0021-0000-4000-8000-00000000d001', 'Producto 21', 1,
       100, 100, 'aaaa0021-0000-4000-8000-00000000e001',
       t.tax_rule_id, t.rate, 16, 100, 100, 116, 116,
       116, 'VES', 1, 116, 'VES', 'identidad', now(), 'inventory:cost:8:HALF_UP', 60
  from platform.resolve_tax('2026-08-27'::date, 'VE', 'iva', 'ordinario', 'gravado_general') t;
select is(
  (select tax_rate_snapshot from public.document_lines
    where id = 'aaaa0021-0000-4000-8000-00000000f101'),
  0.16000000::numeric, 'la línea persiste la alícuota que resolvió el catálogo: 0,16');

-- Se cambia el catálogo DESPUÉS: la factura emitida no se mueve ni un céntimo.
update public.tax_rules set effective_to = '2026-08-28' where rate = 0.16;
insert into public.tax_rules
  (jurisdiction, tax_code, taxpayer_type, transaction_type, product_tax_category,
   rate, effective_from, legal_source, priority)
values ('VE', 'iva', null, 'sale', 'gravado_general', 0.22, '2026-08-28',
        'REGLA DE PRUEBA nueva alícuota', 100);
select is(
  (select tax_rate_snapshot from public.document_lines
    where id = 'aaaa0021-0000-4000-8000-00000000f101'),
  0.16000000::numeric,
  'CAMBIAR tax_rules después NO altera la factura emitida: el documento COPIÓ la '
  'alícuota, no la referencia (R-05 aplicado al impuesto)');
select is(
  (select rate from platform.resolve_tax('2026-08-29'::date, 'VE', 'iva', 'ordinario', 'gravado_general')),
  0.22::numeric, 'y la nueva alícuota sí aplica a lo que se emita a partir de su vigencia');

-- ── 7. Inmutabilidad del documento emitido, las dos capas distinguibles ─────
select throws_ok(
  $$ update public.documents set total_amount = 999
      where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'LAD06', null,
  'cambiar el importe de un documento emitido: LAD06 — se corrige con nota de crédito');
select throws_ok(
  $$ update public.documents set document_number = 77
      where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'LAD06', null, 'y mover su correlativo, también');
select throws_ok(
  $$ update public.document_lines set quantity = 99
      where id = 'aaaa0021-0000-4000-8000-00000000f101' $$,
  'LAD06', null, 'las líneas de un documento emitido tampoco se editan');
select throws_ok(
  $$ delete from public.documents where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'LAD06', null, 'ni se borra: se anula, y su número se conserva');
select throws_ok(
  $$ update public.documents set status = 'draft'
      where id = 'aaaa0021-0000-4000-8000-00000000f001' $$,
  'LAD06', null, 'issued → draft es imposible: no hay vuelta atrás de un documento fiscal');

-- ── 8. ANULAR conserva el correlativo: el siguiente NO reutiliza el hueco ───
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0021-0000-4000-8000-00000000f004', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0021-0000-4000-8000-00000000c001', 2, 2001,
        'issued', now(), 'aaaa0021-0000-4000-8000-00000000e100', 'test-021',
        'VES', 'VES', 1, 'identidad', 58, 58, 50, 8, 58);
select lives_ok(
  $$ update public.documents
        set status = 'annulled', annulled_at = now(), annul_reason = 'error de digitación'
      where id = 'aaaa0021-0000-4000-8000-00000000f004' $$,
  'anular una factura emitida: vive, con su motivo');
select is(
  (select document_number from public.documents where id = 'aaaa0021-0000-4000-8000-00000000f004'),
  2::bigint, 'la anulada CONSERVA su correlativo: un salto sería indistinguible de un ocultado');
select is(
  platform.claim_document_number('aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A'),
  3::bigint,
  'y el siguiente correlativo es 3, NO 2: anular no libera el número (ADR-0037)');

-- ── 9. Cobros, saldo y DIFERENCIAL CAMBIARIO calculado A MANO ──────────────
-- Factura de 100 USD emitida el 1-ago con tasa 40 → 4 000,00 Bs funcionales.
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source, rate_timestamp,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values ('aaaa0021-0000-4000-8000-00000000f005', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'A',
        'aaaa0021-0000-4000-8000-00000000c001', 3, 2002,
        'issued', '2026-08-01T12:00:00Z', 'aaaa0021-0000-4000-8000-00000000e100', 'test-021',
        'USD', 'VES', 40, 'BCV', '2026-08-01T10:00:00Z',
        100, 4000, 4000, 0, 4000);
select is(platform.document_balance('aaaa0021-0000-4000-8000-0000000000a2',
                                    'aaaa0021-0000-4000-8000-00000000f005'),
  4000.00000000::numeric, 'saldo inicial = total: 4 000,00 Bs (100 USD a 40)');

-- Se cobra el 1-SEP, cuando la tasa es 50: 100 USD valen ahora 5 000,00 Bs.
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument)
values ('aaaa0021-0000-4000-8000-00000000f105', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'aaaa0021-0000-4000-8000-00000000f005',
        '2026-09-01T12:00:00Z', 'USD', 100, 50, 'BCV', '2026-09-01T10:00:00Z', 5000, 'transferencia');
select is(platform.document_balance('aaaa0021-0000-4000-8000-0000000000a2',
                                    'aaaa0021-0000-4000-8000-00000000f005'),
  -1000.00000000::numeric,
  'A MANO: 4 000 − 5 000 = −1 000. El saldo funcional queda negativo porque los mismos '
  '100 USD valen más Bs hoy: ESA diferencia es el diferencial cambiario, no un sobrepago');

insert into public.exchange_gain_loss
  (tenant_id, company_id, document_id, payment_id, amount_transaction, transaction_currency,
   functional_at_issue, functional_at_payment, difference, fx_rate_issue, fx_rate_payment, occurred_on)
values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
        'aaaa0021-0000-4000-8000-00000000f005', 'aaaa0021-0000-4000-8000-00000000f105',
        100, 'USD', 4000, 5000, 1000, 40, 50, '2026-09-01');
select is(
  (select difference::text from public.exchange_gain_loss
    where payment_id = 'aaaa0021-0000-4000-8000-00000000f105'),
  '1000.00000000',
  'DIFERENCIAL A MANO: 100 USD × (50 − 40) = 1 000,00 Bs de GANANCIA cambiaria');
select throws_ok(
  $$ insert into public.exchange_gain_loss
       (tenant_id, company_id, document_id, payment_id, amount_transaction, transaction_currency,
        functional_at_issue, functional_at_payment, difference, fx_rate_issue, fx_rate_payment, occurred_on)
     values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
             'aaaa0021-0000-4000-8000-00000000f005', 'aaaa0021-0000-4000-8000-00000000f105',
             100, 'USD', 4000, 5000, 777, 40, 50, '2026-09-01') $$,
  '23514', null,
  'una diferencia que NO cuadra con sus dos importes: CHECK — `difference` es columna '
  'con constraint, no un cálculo de lectura');
select throws_ok(
  $$ insert into public.exchange_gain_loss
       (tenant_id, company_id, document_id, payment_id, amount_transaction, transaction_currency,
        functional_at_issue, functional_at_payment, difference, fx_rate_issue, fx_rate_payment, occurred_on)
     values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
             'aaaa0021-0000-4000-8000-00000000f005', 'aaaa0021-0000-4000-8000-00000000f105',
             100, 'USD', 4000, 5000, 1000, 40, 50, '2026-09-01') $$,
  '23505', null, 'y un pago produce COMO MUCHO un diferencial: dos serían contarlo dos veces');
select throws_ok(
  $$ update public.payments set amount = 1 where id = 'aaaa0021-0000-4000-8000-00000000f105' $$,
  'LAD06', null, 'un cobro es un hecho: append-only, no se edita');

-- ── 10. Saldo a favor del cliente (NC → crédito → pago) ─────────────────────
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount,
   source_document_id)
values ('aaaa0021-0000-4000-8000-00000000f006', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'credit_note', 'A',
        'aaaa0021-0000-4000-8000-00000000c001', 1, 2003,
        'issued', now(), 'aaaa0021-0000-4000-8000-00000000e100', 'test-021',
        'VES', 'VES', 1, 'identidad', 500, 500, 500, 0, 500,
        'aaaa0021-0000-4000-8000-00000000f001');
insert into public.customer_credits
  (id, tenant_id, company_id, customer_id, source_document_id, amount, currency)
values ('aaaa0021-0000-4000-8000-00000000f200', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'aaaa0021-0000-4000-8000-00000000c001',
        'aaaa0021-0000-4000-8000-00000000f006', 500, 'VES');
select is(
  (select amount::text || '/' || applied_amount::text || '/' || status
     from public.customer_credits where id = 'aaaa0021-0000-4000-8000-00000000f200'),
  '500.00000000/0.00000000/available', 'la NC genera saldo a favor disponible por 500,00');
select lives_ok(
  $$ update public.customer_credits set applied_amount = 200
      where id = 'aaaa0021-0000-4000-8000-00000000f200' $$,
  'aplicar 200 del saldo: vive, y queda disponible el resto');
select throws_ok(
  $$ update public.customer_credits set applied_amount = 600
      where id = 'aaaa0021-0000-4000-8000-00000000f200' $$,
  '23514', null,
  'aplicar MÁS de lo disponible es IMPOSIBLE, no improbable: el invariante está en el esquema');
select throws_ok(
  $$ update public.customer_credits set applied_amount = 500
      where id = 'aaaa0021-0000-4000-8000-00000000f200' $$,
  '23514', null,
  'y agotarlo sin marcarlo `applied` también: el estado y el importe no pueden divergir');
select lives_ok(
  $$ update public.customer_credits set applied_amount = 500, status = 'applied'
      where id = 'aaaa0021-0000-4000-8000-00000000f200' $$,
  'agotado Y marcado applied: coherente');

-- ── 11. Devolución al COSTO ORIGINAL ───────────────────────────────────────
insert into public.returns
  (id, tenant_id, company_id, source_document_id, warehouse_id, reason)
values ('aaaa0021-0000-4000-8000-00000000f300', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'aaaa0021-0000-4000-8000-00000000f001',
        'aaaa0021-0000-4000-8000-00000000ff01', 'producto defectuoso');
insert into public.return_lines
  (tenant_id, company_id, return_id, source_line_id, product_id, quantity,
   unit_cost_original, unit_price_transaction)
select 'aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
       'aaaa0021-0000-4000-8000-00000000f300', l.id, l.product_id, 1,
       l.cost_snapshot, l.unit_price_transaction
  from public.document_lines l where l.id = 'aaaa0021-0000-4000-8000-00000000f101';
select is(
  (select unit_cost_original::text from public.return_lines
    where return_id = 'aaaa0021-0000-4000-8000-00000000f300'),
  '60.00000000', 'la devolución COPIA el costo original de la línea: 60,00');

-- Se mueve el costo ACTUAL del producto y se comprueba que no altera nada.
insert into public.inventory_moves
  (tenant_id, company_id, warehouse_id, product_id, kind, quantity,
   amount_transaction_currency, transaction_currency, fx_rate,
   functional_amount, functional_currency, rate_source, rate_timestamp,
   rounding_policy_id, unit_cost, occurred_at)
values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
        'aaaa0021-0000-4000-8000-00000000ff01', 'aaaa0021-0000-4000-8000-00000000d001',
        'entrada', 10, 990, 'VES', 1, 990, 'VES', 'identidad', now(),
        'inventory:cost:8:HALF_UP', 99, now());
select is(
  (select last_unit_cost::text from public.stock_balances
    where product_id = 'aaaa0021-0000-4000-8000-00000000d001'),
  '99.00000000', 'el costo ACTUAL del producto ahora es 99,00…');
select is(
  (select unit_cost_original::text from public.return_lines
    where return_id = 'aaaa0021-0000-4000-8000-00000000f300'),
  '60.00000000',
  '…y la devolución sigue a 60,00: el reingreso va al costo ORIGINAL, no al de hoy '
  '(decisión del encargo, ejercida cambiando el costo)');

-- ── 12. AGING con facturas a distintas fechas ──────────────────────────────
-- Cliente DEDICADO: los bloques anteriores dejaron facturas del cliente c001 y
-- un aging global las sumaría. Aislar el fixture es lo que hace que los importes
-- de abajo se puedan calcular a mano sin arrastrar el resto del test.
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code)
values ('aaaa0021-0000-4000-8000-00000000c004', 'aaaa0021-0000-4000-8000-00000000000a',
        'aaaa0021-0000-4000-8000-0000000000a2', 'J-CLI-AGING', 'Cliente aging', 'juridica', 'ordinario');
insert into public.documents
  (tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version,
   transaction_currency, functional_currency, fx_rate, rate_source,
   amount_transaction_currency, functional_amount, subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'B',
   'aaaa0021-0000-4000-8000-00000000c004', 101, 3001, 'issued', current_date - 10,
   'aaaa0021-0000-4000-8000-00000000e100', 'test-021', 'VES', 'VES', 1, 'identidad', 100, 100, 100, 0, 100),
  ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'B',
   'aaaa0021-0000-4000-8000-00000000c004', 102, 3002, 'issued', current_date - 45,
   'aaaa0021-0000-4000-8000-00000000e100', 'test-021', 'VES', 'VES', 1, 'identidad', 200, 200, 200, 0, 200),
  ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'B',
   'aaaa0021-0000-4000-8000-00000000c004', 103, 3003, 'issued', current_date - 75,
   'aaaa0021-0000-4000-8000-00000000e100', 'test-021', 'VES', 'VES', 1, 'identidad', 300, 300, 300, 0, 300),
  ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2', 'invoice', 'B',
   'aaaa0021-0000-4000-8000-00000000c004', 104, 3004, 'issued', current_date - 200,
   'aaaa0021-0000-4000-8000-00000000e100', 'test-021', 'VES', 'VES', 1, 'identidad', 400, 400, 400, 0, 400);
select is(
  (select count(*) from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                          'aaaa0021-0000-4000-8000-00000000c004')
    where bucket in ('0-30','31-60','61-90','90+')),
  4::bigint, 'el aging devuelve LOS CUATRO rangos para un cliente con facturas escalonadas');
select is(
  (select amount::text from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                              'aaaa0021-0000-4000-8000-00000000c004')
    where bucket = '0-30'),
  '100.00000000', 'A MANO: la de hace 10 días cae en 0-30 con 100,00');
select is(
  (select amount::text from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                              'aaaa0021-0000-4000-8000-00000000c004')
    where bucket = '31-60'),
  '200.00000000', 'la de 45 días en 31-60 con 200,00');
select is(
  (select amount::text from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                              'aaaa0021-0000-4000-8000-00000000c004')
    where bucket = '61-90'),
  '300.00000000', 'la de 75 días en 61-90 con 300,00');
select is(
  (select amount::text from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                              'aaaa0021-0000-4000-8000-00000000c004')
    where bucket = '90+'),
  '400.00000000', 'y la de 200 días en 90+ con 400,00');

-- Una factura PAGADA no envejece.
insert into public.payments
  (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument)
select 'aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2', d.id,
       now(), 'VES', 100, 1, 'identidad', now(), 100, 'efectivo_bs'
  from public.documents d
 where d.company_id = 'aaaa0021-0000-4000-8000-0000000000a2' and d.document_number = 101
   and d.series = 'B';
select is(
  (select count(*) from platform.ar_aging('aaaa0021-0000-4000-8000-0000000000a2',
                                          'aaaa0021-0000-4000-8000-00000000c004')
    where bucket = '0-30'),
  0::bigint, 'cobrada entera, la factura DESAPARECE del aging: una pagada no envejece');

-- ── 13. Reservas: compromiso, no existencia ────────────────────────────────
select is(
  (select available::text from platform.available_stock('aaaa0021-0000-4000-8000-0000000000a2',
     'aaaa0021-0000-4000-8000-00000000ff01', 'aaaa0021-0000-4000-8000-00000000d001')),
  '10.00000000', 'sin reservas, disponible = existencia');
insert into public.stock_reservations
  (tenant_id, company_id, document_id, warehouse_id, product_id, quantity, expires_at)
values ('aaaa0021-0000-4000-8000-00000000000a', 'aaaa0021-0000-4000-8000-0000000000a2',
        'aaaa0021-0000-4000-8000-00000000f001', 'aaaa0021-0000-4000-8000-00000000ff01',
        'aaaa0021-0000-4000-8000-00000000d001', 4, now() + interval '30 days');
select is(
  (select on_hand::text || '/' || reserved::text || '/' || available::text
     from platform.available_stock('aaaa0021-0000-4000-8000-0000000000a2',
       'aaaa0021-0000-4000-8000-00000000ff01', 'aaaa0021-0000-4000-8000-00000000d001')),
  '10.00000000/4.00000000/6.00000000',
  'reservar 4: la EXISTENCIA sigue siendo 10 y el disponible baja a 6 — una reserva '
  'es compromiso, no movimiento de kardex');
select is(
  (select count(*) from public.inventory_moves
    where product_id = 'aaaa0021-0000-4000-8000-00000000d001'),
  1::bigint, 'y el kardex NO se tocó: sigue con el único movimiento de entrada');

-- ── 14. Aislamiento y capas de privilegio ──────────────────────────────────
set local role ladino_api;
select is((select count(*) from public.documents
            where company_id = 'aaaa0021-0000-4000-8000-0000000000b2'), 0::bigint,
  'como ladino_api sin actor en el tenant B, los documentos de B no existen');
select throws_ok(
  $$ update public.payments set amount = 5 where id = 'aaaa0021-0000-4000-8000-00000000f105' $$,
  '42501', null, 'la API no puede ni intentar mutar un cobro: 42501, capa de privilegio');
select throws_ok(
  $$ delete from public.exchange_gain_loss where payment_id = 'aaaa0021-0000-4000-8000-00000000f105' $$,
  '42501', null, 'ni borrar un diferencial');
reset role;

select * from finish();
rollback;
