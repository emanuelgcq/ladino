-- =============================================================================
-- Ladino — pgTAP 94b · LOS LIBROS LEEN EL COMPROBANTE Y UN INVARIANTE LO VIGILA (ADR-0072 §4 y §6)
-- Migraciones 20261002110000 y 20261002110200. Revisión de la parte 3: H9 (a, c, d) y H10.
--
-- Qué se prueba:
--   a. `purchases_book_with_vouchers`: el comprobante emitido en OTRO período que su factura sale en
--      el de su emisión como renglón «comprobante_retencion» con importes en cero; en el de la
--      factura, el renglón no lo identifica;
--   c. `iva_retention_book`: una versión reemplazada sale «annulled» solo si el reemplazo se emitió
--      hasta `p_to` (el libro de un período no cambia por una corrección posterior), y la versión 2
--      dice cuándo se emitió la 1 (`original_issued_on`, H4);
--   d. aislamiento de `retention_voucher_lines` como ladino_api con un actor de VARIOS tenants;
--   H10. `retention_voucher_gaps` da cero con todo documentado, cuenta la retención sin renglón
--      (variante rota) y respeta su corte.
-- =============================================================================

begin;
select plan(21);

insert into auth.users (id) values ('aaaa094b-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa094b-0000-4000-8000-00000000000a', 'Tenant 94b A'),
  ('aaaa094b-0000-4000-8000-00000000000b', 'Tenant 94b B (ajeno)'),
  ('aaaa094b-0000-4000-8000-00000000000c', 'Tenant 94b C');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000000a',
   'J941000001', 'Agente 94b A'),
  ('aaaa094b-0000-4000-8000-0000000000b2', 'aaaa094b-0000-4000-8000-00000000000b',
   'J941000002', 'Agente 94b B');
insert into public.memberships (tenant_id, user_id) values
  ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a1'),
  ('aaaa094b-0000-4000-8000-00000000000c', 'aaaa094b-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa094b-0000-4000-8000-0000000000a1', true);

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa094b-0000-4000-8000-00000000e00a', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'J-PRO-94bA', 'Proveedor 94b A', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa094b-0000-4000-8000-00000000e00b', 'aaaa094b-0000-4000-8000-00000000000b',
   'aaaa094b-0000-4000-8000-0000000000b2', 'J-PRO-94bB', 'Proveedor 94b B', 'nacional',
   'juridica', 'ordinario');
-- La factura es de SEPTIEMBRE; su comprobante, de octubre.
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa094b-0000-4000-8000-00000000f00a', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000e00a',
   'FP-94bA', 'CTRL-94bA', '2026-09-29', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160),
  ('aaaa094b-0000-4000-8000-00000000f00b', 'aaaa094b-0000-4000-8000-00000000000b',
   'aaaa094b-0000-4000-8000-0000000000b2', 'aaaa094b-0000-4000-8000-00000000e00b',
   'FP-94bB', 'CTRL-94bB', '2026-10-01', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160);
insert into public.retention_rules
  (id, jurisdiction, retention_code, concept_code, formula_kind, rate, effective_from,
   legal_source, status) values
  ('aaaa094b-0000-4000-8000-00000000e301', 'VE', 'iva', 'iva_compras', 'rate', 0.75,
   '2026-01-01', 'REGLA DE PRUEBA 094b — no es una norma real', 'inactive');
insert into public.supplier_retentions
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
   retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
   retained_amount, functional_currency, rules_version) values
  ('aaaa094b-0000-4000-8000-00000000d00a', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000e00a',
   'aaaa094b-0000-4000-8000-00000000f00a', 'iva', 'iva_compras',
   'aaaa094b-0000-4000-8000-00000000e301', 'rate', 0.75, 'REGLA 094b', 160, 120, 'VES', 't94b'),
  ('aaaa094b-0000-4000-8000-00000000d00b', 'aaaa094b-0000-4000-8000-00000000000b',
   'aaaa094b-0000-4000-8000-0000000000b2', 'aaaa094b-0000-4000-8000-00000000e00b',
   'aaaa094b-0000-4000-8000-00000000f00b', 'iva', 'iva_compras',
   'aaaa094b-0000-4000-8000-00000000e301', 'rate', 0.75, 'REGLA 094b', 160, 120, 'VES', 't94b');

-- v1 el 2 de octubre; v2 (corrección) el 20 de octubre. Y el de B.
insert into public.retention_vouchers
  (id, tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
   fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
   supplier_name, version_no, replaces_voucher_id, correction_reason, functional_currency,
   rules_version) values
  ('aaaa094b-0000-4000-8000-00000000c001', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000e00a', '202610', 1,
   'per_operation', '2026-10-02', '2026-10-01', '2026-10-15', '2026-10-19', 'J941000001', 'A',
   'J-PRO-94bA', 'Proveedor 94b A', 1, null, null, 'VES', 't94b'),
  ('aaaa094b-0000-4000-8000-00000000c002', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000e00a', '202610', 2,
   'per_operation', '2026-10-20', '2026-10-16', '2026-10-31', '2026-11-03', 'J941000001', 'A',
   'J-PRO-94bA', 'Proveedor 94b A', 2, 'aaaa094b-0000-4000-8000-00000000c001',
   'El domicilio del proveedor estaba mal', 'VES', 't94b'),
  ('aaaa094b-0000-4000-8000-00000000c00b', 'aaaa094b-0000-4000-8000-00000000000b',
   'aaaa094b-0000-4000-8000-0000000000b2', 'aaaa094b-0000-4000-8000-00000000e00b', '202610', 1,
   'per_operation', '2026-10-02', '2026-10-01', '2026-10-15', '2026-10-19', 'J941000002', 'B',
   'J-PRO-94bB', 'Proveedor 94b B', 1, null, null, 'VES', 't94b');
insert into public.retention_voucher_lines
  (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
   document_type, document_number, control_number, document_date, total_amount, taxable_base,
   exempt_amount, iva_amount, tax_rate, portion, retained_amount) values
  ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a2',
   'aaaa094b-0000-4000-8000-00000000c001', 'aaaa094b-0000-4000-8000-00000000f00a',
   'aaaa094b-0000-4000-8000-00000000d00a', '01', 'FP-94bA', 'CTRL-94bA', '2026-09-29',
   1160, 1000, 0, 160, 16, 0.75, 120),
  ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a2',
   'aaaa094b-0000-4000-8000-00000000c002', 'aaaa094b-0000-4000-8000-00000000f00a',
   'aaaa094b-0000-4000-8000-00000000d00a', '01', 'FP-94bA', 'CTRL-94bA', '2026-09-29',
   1160, 1000, 0, 160, 16, 0.75, 120),
  ('aaaa094b-0000-4000-8000-00000000000b', 'aaaa094b-0000-4000-8000-0000000000b2',
   'aaaa094b-0000-4000-8000-00000000c00b', 'aaaa094b-0000-4000-8000-00000000f00b',
   'aaaa094b-0000-4000-8000-00000000d00b', '01', 'FP-94bB', 'CTRL-94bB', '2026-10-01',
   1160, 1000, 0, 160, 16, 0.75, 120);

-- ── a. El libro de compras y el período de emisión ───────────────────────────
select is((select row(status, base_gravada, iva_credito, total_amount,
                      retention_voucher_number, retention_voucher_iva)::text
             from platform.purchases_book_with_vouchers('aaaa094b-0000-4000-8000-0000000000a2',
                                                        '2026-10-01', '2026-10-31')
            where invoice_id = 'aaaa094b-0000-4000-8000-00000000f00a'),
  row('comprobante_retencion', 0::numeric, 0::numeric, 0::numeric, '20261000000002',
      120.00000000::numeric)::text,
  'el comprobante de octubre de una factura de septiembre sale en OCTUBRE, renglón propio en cero, con la versión vigente');
select is((select retention_voucher_number
             from platform.purchases_book_with_vouchers('aaaa094b-0000-4000-8000-0000000000a2',
                                                        '2026-09-01', '2026-09-30')
            where invoice_id = 'aaaa094b-0000-4000-8000-00000000f00a'),
  null, 'en septiembre la factura está, sin comprobante: no se emitió en su período');
select is((select count(*) from platform.purchases_book_with_vouchers(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-15')
            where retention_voucher_number = '20261000000001'),
  1::bigint, 'en la primera quincena el vigente era la versión 1: la corrección del 20 aún no existía');

-- ── c. El libro de retenciones y «annulled» por p_to ─────────────────────────
select is((select receipt_status from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-15')
            where voucher_number = '20261000000001'),
  'issued', 'cerrado el 15, la versión 1 sale emitida: la corrección es posterior al período');
select is((select receipt_status from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-31')
            where voucher_number = '20261000000001'),
  'annulled', 'con el mes entero, la versión 1 sale anulada: el reemplazo es del 20');
select is((select original_issued_on from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-31')
            where voucher_number = '20261000000002'),
  '2026-10-02'::date, 'la versión 2 dice cuándo se emitió la 1 (H4: el TXT no la declara dos veces)');
select is((select supplier_name from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-31')
            where voucher_number = '20261000000002'),
  'Proveedor 94b A', 'la identidad sale del comprobante, no del maestro');

-- A-1 (migración 20261002110500): «ya declarada» por RENGLÓN.
select is((select declared_before from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-16', '2026-10-31')
            where voucher_number = '20261000000002'),
  true, 'en la 2.ª quincena, el renglón de la v2 ya se declaró en la v1 del día 2: no vuelve a salir');
select is((select declared_before from platform.iva_retention_book(
             'aaaa094b-0000-4000-8000-0000000000a2', '2026-10-01', '2026-10-31')
            where voucher_number = '20261000000002'),
  false, 'con el mes entero, la v1 es del mismo período: el renglón de la v2 sale (la v1 sale anulada)');

-- ── H10. El invariante ───────────────────────────────────────────────────────
select is((select count(*) from platform.retention_voucher_gaps(
             'aaaa094b-0000-4000-8000-0000000000a2')),
  0::bigint, 'todo documentado en un comprobante vigente por el mismo importe: CERO');
-- Variante rota: una retención practicada SIN su renglón.
insert into public.supplier_retentions
  (tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
   retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
   retained_amount, functional_currency, rules_version) values
  ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a2',
   'aaaa094b-0000-4000-8000-00000000e00a', 'aaaa094b-0000-4000-8000-00000000f00a', 'iva',
   'iva_compras_total', 'aaaa094b-0000-4000-8000-00000000e301', 'rate', 1, 'REGLA 094b', 160,
   160, 'VES', 't94b');
select is((select count(*) from platform.retention_voucher_gaps(
             'aaaa094b-0000-4000-8000-0000000000a2')),
  1::bigint, 'ROTO: la retención sin comprobante se cuenta — el cero de arriba medía algo');
-- A-1: la misma retención en DOS cadenas (un comprobante ajeno a la de v1/v2) es un hueco.
insert into public.retention_vouchers
  (id, tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
   fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
   supplier_name, functional_currency, rules_version) values
  ('aaaa094b-0000-4000-8000-00000000c009', 'aaaa094b-0000-4000-8000-00000000000a',
   'aaaa094b-0000-4000-8000-0000000000a2', 'aaaa094b-0000-4000-8000-00000000e00a', '202610', 9,
   'per_operation', '2026-10-21', '2026-10-16', '2026-10-31', '2026-11-03', 'J941000001', 'A',
   'J-PRO-94bA', 'Proveedor 94b A', 'VES', 't94b');
insert into public.retention_voucher_lines
  (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
   document_type, document_date, total_amount, taxable_base, exempt_amount, iva_amount,
   portion, retained_amount) values
  ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a2',
   'aaaa094b-0000-4000-8000-00000000c009', 'aaaa094b-0000-4000-8000-00000000f00a',
   'aaaa094b-0000-4000-8000-00000000d00a', '01', '2026-09-29', 1160, 1000, 0, 160, 0.75, 120);
select ok(exists (select 1 from platform.retention_voucher_gaps(
             'aaaa094b-0000-4000-8000-0000000000a2')
           where retention_id = 'aaaa094b-0000-4000-8000-00000000d00a'),
  'la retención copiada a una SEGUNDA cadena se cuenta: saldría dos veces o ninguna en el TXT');
-- El corte va en el enunciado: lo practicado antes del corte no es de este invariante.
update platform.invariant_cutoffs set since = now() + interval '1 day'
 where invariant = 'retention_voucher_gaps';
select is((select count(*) from platform.retention_voucher_gaps(
             'aaaa094b-0000-4000-8000-0000000000a2')),
  0::bigint, 'antes del corte no pregunta: lo anterior lo vigila P-63');

-- ── d. Aislamiento de los renglones como ladino_api ──────────────────────────
set local role ladino_api;
select is((select count(*) from public.retention_voucher_lines
            where company_id = 'aaaa094b-0000-4000-8000-0000000000a2'),
  3::bigint, 'ladino_api lee los renglones de un tenant del actor (v1, v2 y el de la segunda cadena)');
select is((select count(*) from public.retention_voucher_lines
            where company_id = 'aaaa094b-0000-4000-8000-0000000000b2'),
  0::bigint, 'ladino_api NO ve los renglones de un tenant ajeno');
select throws_ok($$
  insert into public.retention_voucher_lines
    (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
     document_type, document_date, total_amount, taxable_base, exempt_amount, iva_amount,
     portion, retained_amount)
  values ('aaaa094b-0000-4000-8000-00000000000b', 'aaaa094b-0000-4000-8000-0000000000b2',
          'aaaa094b-0000-4000-8000-00000000c00b', 'aaaa094b-0000-4000-8000-00000000f00b',
          'aaaa094b-0000-4000-8000-00000000d00b', '02', '2026-10-01', 1, 1, 0, 0, 0.75, 0)
$$, '42501', null, 'ladino_api NO escribe renglones en un tenant ajeno');
select throws_ok($$
  update public.retention_voucher_lines set retained_amount = 1
   where company_id = 'aaaa094b-0000-4000-8000-0000000000a2'
$$, '42501', null, 'ni edita los renglones de los suyos: no tiene UPDATE (append-only, primera capa)');
reset role;

-- ── H7/H8 de la auditoría fiscal (migración 20261002110300) ───────────────────
select is(platform.tax_unit_at('2026-10-02'), 43.00000000::numeric,
  'la UT vigente es dato con fuente: Bs 43 (PA SNAT/2025/000048)');
select is(platform.tax_unit_at('2025-01-01'), null,
  'antes de su Gaceta no hay UT: quien la usa falla, no supone una');
select is((select applies from public.retention_exclusions where code = 'ente_publico'),
  'not_markable', 'las compras de entes públicos (num. 11 y 12) no las marca una empresa privada');
select lives_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     transaction_currency, functional_currency, fx_rate, amount_transaction_currency,
     functional_amount, iva_retention_full_reason)
  values ('aaaa094b-0000-4000-8000-00000000000a', 'aaaa094b-0000-4000-8000-0000000000a2',
          'aaaa094b-0000-4000-8000-00000000e00a', 'FP-94b-ART2', 'CTRL-94b-ART2', '2026-10-01',
          'draft', 0, 0, 0, true, 'VES', 'VES', 1, 0, 0, 'operaciones_art_2')
$$, 'el 100 % admite el supuesto 4.º del art. 5 (operaciones del art. 2)');

select * from finish();
rollback;
