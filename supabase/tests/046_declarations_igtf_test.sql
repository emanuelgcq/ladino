-- =============================================================================
-- Ladino — pgTAP 46 · Declaraciones de IVA e IGTF (migración 46)
--
--   1. las tablas nuevas llevan su ancla (familia 006, cero excepciones);
--   2. el instrumento `retencion_iva` entra al CHECK de payments y exige su
--      comprobante (shape), como saldo_a_favor exige su crédito;
--   3. `iva_period_results` es insert-only DE VERDAD: update y delete mueren;
--   4. `recompute_iva_period` calcula débitos por alícuota con signo (NC
--      resta), créditos recuperables, retención soportada, arrastre y cuota;
--   5. la regla IGTF del 3 % está sembrada CON su fuente; las exenciones
--      nacen vacías; una percepción por pago (unique) y el estado
--      pendiente_reintegro exige motivo;
--   6. el vocabulario contable ganó `igtf_perception` en sus tres casas y
--      los dos asientos nuevos del preset existen con sus líneas.
-- =============================================================================

begin;
select plan(19);

-- ── 1. Anclas de la familia ─────────────────────────────────────────────────
select is(
  (select count(*) from pg_trigger
    where tgname in ('supported_retention_receipts_01_anchors', 'iva_period_results_01_anchors',
                     'igtf_perceptions_01_anchors', 'igtf_company_instruments_01_anchors',
                     'company_fiscal_deadlines_01_anchors')),
  5::bigint, 'las cinco tablas nuevas con tenant llevan su ancla de aislamiento');

-- ── 2. El instrumento nuevo y su shape ──────────────────────────────────────
select ok(
  (select pg_get_constraintdef(oid) like '%retencion_iva%'
     from pg_constraint where conname = 'payments_instrument_chk'),
  'payments acepta el instrumento retencion_iva');
select ok(
  exists (select 1 from pg_constraint where conname = 'payments_retention_shape_chk'),
  'y el shape ata retencion_iva a su comprobante soportado (como saldo_a_favor al crédito)');

-- ── Fixture ─────────────────────────────────────────────────────────────────
insert into public.tenants (id, name) values
  ('aaaa0046-0000-4000-8000-00000000000a', 'Tenant 46');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code) values
  ('aaaa0046-0000-4000-8000-0000000000a1', 'aaaa0046-0000-4000-8000-00000000000a',
   'J-46-A', 'Declarante C.A.', 'VES');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0046-0000-4000-8000-00000000c001', 'aaaa0046-0000-4000-8000-00000000000a',
   'aaaa0046-0000-4000-8000-0000000000a1', 'J-46000001-0', 'Cliente especial 46',
   'juridica', 'especial');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
        'formatos_libres', date '2026-01-01');

select set_config('ladino.actor_id', 'aaaa0046-0000-4000-8000-00000000aaaa', true);
select set_config('ladino.rules_version', 'test-046', true);

insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code)
values ('aaaa0046-0000-4000-8000-00000000d001', 'aaaa0046-0000-4000-8000-00000000000a',
        'aaaa0046-0000-4000-8000-0000000000a1', 'P46', 'Producto 46', 'service', 'active',
        'unidad', 'gravado_general');

-- Ventas de FEBRERO 2026: factura 100+16 y NC 25+4 (neto débitos 12).
insert into public.documents
  (id, tenant_id, company_id, kind, series, customer_id, document_number, control_number,
   status, issued_at, regime_version_id, rules_version, transaction_currency,
   functional_currency, fx_rate, rate_source, amount_transaction_currency, functional_amount,
   subtotal_amount, tax_amount, total_amount)
values
  ('aaaa0046-0000-4000-8000-00000000f001', 'aaaa0046-0000-4000-8000-00000000000a',
   'aaaa0046-0000-4000-8000-0000000000a1', 'invoice', 'A',
   'aaaa0046-0000-4000-8000-00000000c001', 4601, 4601, 'issued',
   timestamptz '2026-02-10 15:00:00-04',
   (select regime_version_id from platform.regime_at('aaaa0046-0000-4000-8000-0000000000a1',
                                                     timestamptz '2026-02-10 15:00:00-04')),
   'test-046', 'VES', 'VES', 1, 'identidad', 116, 116, 100, 16, 116),
  ('aaaa0046-0000-4000-8000-00000000f002', 'aaaa0046-0000-4000-8000-00000000000a',
   'aaaa0046-0000-4000-8000-0000000000a1', 'credit_note', 'A',
   'aaaa0046-0000-4000-8000-00000000c001', 4602, 4602, 'issued',
   timestamptz '2026-02-15 15:00:00-04',
   (select regime_version_id from platform.regime_at('aaaa0046-0000-4000-8000-0000000000a1',
                                                     timestamptz '2026-02-15 15:00:00-04')),
   'test-046', 'VES', 'VES', 1, 'identidad', 29, 29, 25, 4, 29);
insert into public.document_lines
  (id, tenant_id, company_id, document_id, line_number, product_id, description, quantity,
   unit_price_transaction, unit_price_functional, tax_rate_snapshot, tax_amount,
   line_subtotal_transaction, line_subtotal_functional,
   line_total_transaction, line_total_functional, amount_transaction_currency,
   transaction_currency, fx_rate, functional_amount, functional_currency, rate_source,
   rate_timestamp, rounding_policy_id)
select gen_random_uuid(), 'aaaa0046-0000-4000-8000-00000000000a',
       'aaaa0046-0000-4000-8000-0000000000a1', d.id, 1,
       'aaaa0046-0000-4000-8000-00000000d001',
       'línea 46', 1, d.subtotal_amount, d.subtotal_amount, 0.16, d.tax_amount,
       d.subtotal_amount, d.subtotal_amount,
       d.total_amount, d.total_amount, d.total_amount,
       'VES', 1, d.subtotal_amount, 'VES', 'identidad',
       d.issued_at, 'sales:document:8:HALF_UP'
  from public.documents d
 where d.company_id = 'aaaa0046-0000-4000-8000-0000000000a1';

-- Retención soportada de febrero: el cliente-agente nos retuvo 9 (75 % de 12).
insert into public.supported_retention_receipts
  (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on,
   base, rate, amount, functional_currency)
values ('aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
        'aaaa0046-0000-4000-8000-00000000c001', 'aaaa0046-0000-4000-8000-00000000f001',
        '20260200012345', date '2026-02-12', 16, 0.75, 9, 'VES');

-- ── 3. Insert-only de verdad ────────────────────────────────────────────────
insert into public.iva_period_results
  (tenant_id, company_id, period_from, period_to, debitos, creditos,
   creditos_deducibles, retenciones_soportadas, excedente_anterior,
   cuota_a_pagar, excedente_siguiente, detalle, generator_version, dataset_hash)
values ('aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
        date '2026-01-01', date '2026-01-31', 0, 0, 0, 0, 0, 0, 0, '[]', 'test', 'hash-046');
select throws_ok(
  $$ update public.iva_period_results set cuota_a_pagar = 999
      where dataset_hash = 'hash-046' $$,
  null, null, 'una generación del período no se EDITA: se genera otra (sustitutiva)');
select throws_ok(
  $$ delete from public.iva_period_results where dataset_hash = 'hash-046' $$,
  null, null, 'ni se borra: insert-only de verdad');

-- ── 4. El recompute: signo, retención, arrastre y cuota ─────────────────────
-- Débitos netos: 16 − 4 = 12. Retención soportada: 9. Sin excedente anterior:
-- cuota = 12 − 0 − 0 − 9 = 3.
select is(
  (select cuota_a_pagar::text from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-02-01', date '2026-02-28', 0)),
  '3.00000000', 'débitos netos (NC resta) − retenciones soportadas = cuota');
-- Con excedente anterior 20: 12 − 20 − 9 = −17 → excedente siguiente 17.
select is(
  (select excedente_siguiente::text from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-02-01', date '2026-02-28', 20)),
  '17.00000000', 'el excedente anterior se aplica y lo no absorbido se arrastra');
select is(
  (select cuota_a_pagar = 0 from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-02-01', date '2026-02-28', 20)),
  true, 'con arrastre a favor, la cuota es cero (nunca ambas a la vez)');
-- Un período SIN operaciones calcula en cero (la declaración en cero existe).
select is(
  (select (debitos = 0 and creditos = 0 and cuota_a_pagar = 0)
     from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-03-01', date '2026-03-31', 0)),
  true, 'un período sin operaciones da la fila en cero, no un error');
-- El detalle trae la alícuota del snapshot, no una regla de hoy.
select is(
  (select detalle -> 0 ->> 'alicuota' from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-02-01', date '2026-02-28', 0)),
  '0.16000000', 'el desglose por alícuota sale del snapshot de las líneas');

/**
 * EL INVARIANTE QUE CRUZA LOS DOS MÓDULOS (CLAUDE.md §«Los tests que cruzan
 * módulos por un invariante estructural»).
 *
 * El débito fiscal que va a la DECLARACIÓN y el IVA del LIBRO DE VENTAS del
 * mismo período tienen que ser LA MISMA CIFRA. Son dos caminos distintos —
 * `recompute_iva_period` agrega las LÍNEAS por alícuota; `sales_book` agrega
 * por DOCUMENTO desde su propia proyección— y ninguno de los dos observa al
 * otro. Si divergen, la declaración presentada contradice al libro que la
 * respalda, y eso es exactamente lo que una fiscalización compara.
 *
 * Las dos mitades del signo importan: el libro trae la nota de crédito con su
 * importe, y la declaración se lo RESTA al débito. La igualdad solo se
 * sostiene si los dos caminos entienden igual el signo de la NC.
 */
select is(
  (select debitos::text from platform.recompute_iva_period(
     'aaaa0046-0000-4000-8000-0000000000a1', date '2026-02-01', date '2026-02-28', 0)),
  (select coalesce(sum(
            case when b.kind = 'credit_note' then -b.iva_debito else b.iva_debito end
          ), 0)::text
     from platform.sales_book('aaaa0046-0000-4000-8000-0000000000a1',
                              date '2026-02-01', date '2026-02-28') b
    where b.status in ('issued', 'paid')),
  'el débito de la declaración es EL MISMO IVA del libro de ventas del período');

-- ── 5. IGTF ─────────────────────────────────────────────────────────────────
select is(
  (select count(*) from public.igtf_rules where rate = 0.03
     and legal_source like '%6.687%' and legal_source like '%000013%'),
  1::bigint, 'la regla del 3 % está sembrada citando la reforma y la PA 13');
select is(
  (select count(*) from public.igtf_exemptions),
  0::bigint, 'las exenciones nacen VACÍAS: sin regla cargada se percibe (H-8)');

insert into public.company_accounts (id, tenant_id, company_id, name, currency, kind)
values ('aaaa0046-0000-4000-8000-00000000ca01', 'aaaa0046-0000-4000-8000-00000000000a',
        'aaaa0046-0000-4000-8000-0000000000a1', 'Caja 46', 'VES', 'cash');
insert into public.payments
  (id, tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
   rate_timestamp, functional_amount, instrument, account_id)
values ('aaaa0046-0000-4000-8000-00000000e001', 'aaaa0046-0000-4000-8000-00000000000a',
        'aaaa0046-0000-4000-8000-0000000000a1', 'aaaa0046-0000-4000-8000-00000000f001',
        now(), 'VES', 50, 1, 'identidad', now(), 50, 'efectivo_bs',
        'aaaa0046-0000-4000-8000-00000000ca01');

-- Y el shape nuevo del instrumento retencion_iva: sin cuenta y CON comprobante.
select lives_ok(
  $$ insert into public.payments
       (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
        rate_timestamp, functional_amount, instrument, supported_retention_id)
     select 'aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
            'aaaa0046-0000-4000-8000-00000000f001', now(), 'VES', 9, 1, 'identidad',
            now(), 9, 'retencion_iva', r.id
       from public.supported_retention_receipts r
      where r.company_id = 'aaaa0046-0000-4000-8000-0000000000a1' limit 1 $$,
  'un abono retencion_iva vive SIN cuenta de dinero y CON su comprobante');
insert into public.igtf_perceptions
  (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
   functional_amount, fx_rate, rate_source, occurred_at)
values ('aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
        'aaaa0046-0000-4000-8000-00000000e001', 'aaaa0046-0000-4000-8000-00000000f001',
        50, 'USD', 0.03, 1.5, 75, 50, 'BCV test', now());
select throws_ok(
  $$ insert into public.igtf_perceptions
       (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate, amount,
        functional_amount, fx_rate, rate_source, occurred_at)
     values ('aaaa0046-0000-4000-8000-00000000000a', 'aaaa0046-0000-4000-8000-0000000000a1',
             'aaaa0046-0000-4000-8000-00000000e001', 'aaaa0046-0000-4000-8000-00000000f001',
             50, 'USD', 0.03, 1.5, 75, 50, 'BCV test', now()) $$,
  '23505', null, 'UNA percepción por pago: reintentar el cobro no percibe dos veces');
select throws_ok(
  $$ update public.igtf_perceptions set status = 'pendiente_reintegro'
      where payment_id = 'aaaa0046-0000-4000-8000-00000000e001' $$,
  '23514', null, 'pendiente_reintegro exige su motivo: nada se marca en silencio');
select lives_ok(
  $$ update public.igtf_perceptions
       set status = 'pendiente_reintegro',
           status_reason = 'factura anulada tras percibir — reintegro por gestionar'
      where payment_id = 'aaaa0046-0000-4000-8000-00000000e001' $$,
  'y con motivo, el estado cambia: la percepción nunca se resta sola');

-- ── 6. Vocabulario y preset ─────────────────────────────────────────────────
select ok(
  (select pg_get_constraintdef(oid) like '%igtf_perception%'
     from pg_constraint where conname = 'journal_entries_source_kind_chk')
  and (select pg_get_constraintdef(oid) like '%igtf_perception%'
     from pg_constraint where conname = 'journal_templates_source_kind_chk')
  and (select pg_get_constraintdef(oid) like '%igtf_perception%'
     from pg_constraint where conname = 'journal_template_preset_entries_kind_chk'),
  'igtf_perception vive en las TRES casas del vocabulario');
select is(
  (select count(*) from public.journal_template_preset_lines l
     join public.journal_template_preset_entries e on e.id = l.entry_id
    where e.preset_code = 've_basico'
      and ((e.source_event = 'ar.retention_applied'
              and l.account_purpose in ('retention_iva_receivable', 'ar_general'))
        or (e.source_event = 'igtf.perception_recorded'
              and l.account_purpose in ('cash_usd', 'igtf_percibido_por_enterar')))),
  4::bigint, 'los dos asientos nuevos del preset existen con sus líneas correctas');

select * from finish();
rollback;
