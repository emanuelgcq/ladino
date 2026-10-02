-- =============================================================================
-- Ladino — pgTAP 94 · EL COMPROBANTE DE RETENCIÓN ES UN DOCUMENTO (ADR-0072 §3, §4 y §6)
-- Migraciones 20261002110000 y 20261002110100. Hallazgos H-01, H-04, H-12 y L-03.
--
-- Qué se prueba (cada defensa con su variante rota):
--   1. RLS habilitada y forzada en las dos tablas nuevas y en el catálogo de exclusiones;
--   2. el número es AAAAMM de la emisión + 8 dígitos, y la clave natural (empresa, secuencial);
--   3. la forma: período = mes de emisión, versión con reemplazo y motivo, retenido <= IVA;
--   4. append-only: el comprobante no se edita ni se borra; la entrega se anota UNA vez; los
--      renglones no se tocan. SIN el trigger guardián el UPDATE entra (el throws_ok lo medía);
--   5. la quincena y el vencimiento de entrega (2 días de lunes a viernes);
--   6. el secuencial bajo candado: máximo + 1 por empresa;
--   7. aislamiento como ladino_api con un actor de VARIOS tenants: lee y emite en los suyos; no
--      ve, no emite (42501) y no marca la entrega (0 filas, dato intacto) en uno ajeno;
--   8. el catálogo de exclusiones es de solo lectura, y la exclusión marcada exige su motivo.
--   Plan: 32. La variante rota va sin savepoint para que pgTAP la cuente (H1 de la revisión).
-- =============================================================================

begin;
select plan(32);

insert into auth.users (id) values ('aaaa0094-0000-4000-8000-0000000000a1');
insert into public.tenants (id, name) values
  ('aaaa0094-0000-4000-8000-00000000000a', 'Tenant 94 A'),
  ('aaaa0094-0000-4000-8000-00000000000b', 'Tenant 94 B (ajeno)'),
  ('aaaa0094-0000-4000-8000-00000000000c', 'Tenant 94 C');
insert into public.companies (id, tenant_id, tax_id, legal_name) values
  ('aaaa0094-0000-4000-8000-0000000000a2', 'aaaa0094-0000-4000-8000-00000000000a',
   'J940000001', 'Agente 94 A'),
  ('aaaa0094-0000-4000-8000-0000000000b2', 'aaaa0094-0000-4000-8000-00000000000b',
   'J940000002', 'Agente 94 B'),
  ('aaaa0094-0000-4000-8000-0000000000c2', 'aaaa0094-0000-4000-8000-00000000000c',
   'J940000003', 'Agente 94 C');
-- El actor es miembro de A y de C, no de B: el atacante realista es el de los dos lados.
insert into public.memberships (tenant_id, user_id) values
  ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a1'),
  ('aaaa0094-0000-4000-8000-00000000000c', 'aaaa0094-0000-4000-8000-0000000000a1');
select set_config('ladino.actor_id', 'aaaa0094-0000-4000-8000-0000000000a1', true);

insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0094-0000-4000-8000-00000000e00a', 'aaaa0094-0000-4000-8000-00000000000a',
   'aaaa0094-0000-4000-8000-0000000000a2', 'J-PRO-94A', 'Proveedor 94 A', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0094-0000-4000-8000-00000000e00b', 'aaaa0094-0000-4000-8000-00000000000b',
   'aaaa0094-0000-4000-8000-0000000000b2', 'J-PRO-94B', 'Proveedor 94 B', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0094-0000-4000-8000-00000000e00c', 'aaaa0094-0000-4000-8000-00000000000c',
   'aaaa0094-0000-4000-8000-0000000000c2', 'J-PRO-94C', 'Proveedor 94 C', 'nacional',
   'juridica', 'ordinario');
insert into public.supplier_invoices
  (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
   invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
   tax_is_recoverable, transaction_currency, functional_currency, fx_rate,
   amount_transaction_currency, functional_amount) values
  ('aaaa0094-0000-4000-8000-00000000f00a', 'aaaa0094-0000-4000-8000-00000000000a',
   'aaaa0094-0000-4000-8000-0000000000a2', 'aaaa0094-0000-4000-8000-00000000e00a',
   'FP-94A', 'CTRL-94A', '2026-10-01', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160),
  ('aaaa0094-0000-4000-8000-00000000f00b', 'aaaa0094-0000-4000-8000-00000000000b',
   'aaaa0094-0000-4000-8000-0000000000b2', 'aaaa0094-0000-4000-8000-00000000e00b',
   'FP-94B', 'CTRL-94B', '2026-10-01', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160),
  ('aaaa0094-0000-4000-8000-00000000f00c', 'aaaa0094-0000-4000-8000-00000000000c',
   'aaaa0094-0000-4000-8000-0000000000c2', 'aaaa0094-0000-4000-8000-00000000e00c',
   'FP-94C', 'CTRL-94C', '2026-10-01', 'posted', now(), 1000, 160, 1160, true,
   'VES', 'VES', 1, 1160, 1160);
insert into public.retention_rules
  (id, jurisdiction, retention_code, concept_code, formula_kind, rate, effective_from,
   legal_source, status) values
  ('aaaa0094-0000-4000-8000-00000000e301', 'VE', 'iva', 'iva_compras', 'rate', 0.75,
   '2026-01-01', 'REGLA DE PRUEBA 094 — no es una norma real', 'inactive');
insert into public.supplier_retentions
  (id, tenant_id, company_id, supplier_id, supplier_invoice_id, retention_code, concept_code,
   retention_rule_id, formula_kind, rate_snapshot, legal_source_snapshot, base_amount,
   retained_amount, functional_currency, rules_version) values
  ('aaaa0094-0000-4000-8000-00000000d00a', 'aaaa0094-0000-4000-8000-00000000000a',
   'aaaa0094-0000-4000-8000-0000000000a2', 'aaaa0094-0000-4000-8000-00000000e00a',
   'aaaa0094-0000-4000-8000-00000000f00a', 'iva', 'iva_compras',
   'aaaa0094-0000-4000-8000-00000000e301', 'rate', 0.75, 'REGLA 094', 160, 120, 'VES', 't94'),
  ('aaaa0094-0000-4000-8000-00000000d00b', 'aaaa0094-0000-4000-8000-00000000000b',
   'aaaa0094-0000-4000-8000-0000000000b2', 'aaaa0094-0000-4000-8000-00000000e00b',
   'aaaa0094-0000-4000-8000-00000000f00b', 'iva', 'iva_compras',
   'aaaa0094-0000-4000-8000-00000000e301', 'rate', 0.75, 'REGLA 094', 160, 120, 'VES', 't94');

-- El comprobante de A (como dueño de la base) y el de B, el ajeno.
insert into public.retention_vouchers
  (id, tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
   fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
   supplier_name, supplier_address, functional_currency, rules_version) values
  ('aaaa0094-0000-4000-8000-00000000c00a', 'aaaa0094-0000-4000-8000-00000000000a',
   'aaaa0094-0000-4000-8000-0000000000a2', 'aaaa0094-0000-4000-8000-00000000e00a', '202610', 1,
   'per_operation', '2026-10-02', '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001',
   'Agente 94 A', 'J-PRO-94A', 'Proveedor 94 A', 'Calle 94', 'VES', 't94'),
  ('aaaa0094-0000-4000-8000-00000000c00b', 'aaaa0094-0000-4000-8000-00000000000b',
   'aaaa0094-0000-4000-8000-0000000000b2', 'aaaa0094-0000-4000-8000-00000000e00b', '202610', 1,
   'per_operation', '2026-10-02', '2026-10-01', '2026-10-15', '2026-10-19', 'J940000002',
   'Agente 94 B', 'J-PRO-94B', 'Proveedor 94 B', 'Original B', 'VES', 't94');

-- ── 1. RLS ───────────────────────────────────────────────────────────────────
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.retention_vouchers'::regclass),
  'retention_vouchers: RLS habilitada y forzada');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.retention_voucher_lines'::regclass),
  'retention_voucher_lines: RLS habilitada y forzada');
select ok((select relrowsecurity and relforcerowsecurity from pg_class
            where oid = 'public.retention_exclusions'::regclass),
  'retention_exclusions: RLS habilitada y forzada');

-- ── 2. El número ─────────────────────────────────────────────────────────────
select is((select voucher_number from public.retention_vouchers
            where id = 'aaaa0094-0000-4000-8000-00000000c00a'),
  '20261000000001', 'el número es AAAAMM de la emisión + 8 dígitos (art. 16): 14 en total');
select throws_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, functional_currency, rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000e00a', '202610', 1, 'per_operation', '2026-10-03',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001', 'A', 'J-PRO-94A', 'P', 'VES',
          't94')
$$, '23505', null, 'dos comprobantes con el mismo secuencial en la misma empresa: la clave natural');
select is(platform.claim_retention_voucher_sequence('aaaa0094-0000-4000-8000-0000000000a2'),
  2::bigint, 'el secuencial siguiente es el máximo de la empresa + 1');

-- ── 3. Forma ─────────────────────────────────────────────────────────────────
select throws_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, functional_currency, rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000e00a', '202609', 5, 'per_operation', '2026-10-03',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001', 'A', 'J-PRO-94A', 'P', 'VES',
          't94')
$$, '23514', null, 'el período del número tiene que ser el mes de la emisión');
select throws_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, version_no, functional_currency, rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000e00a', '202610', 6, 'per_operation', '2026-10-03',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001', 'A', 'J-PRO-94A', 'P', 2, 'VES',
          't94')
$$, '23514', null, 'una versión 2 sin decir a quién reemplaza ni por qué se rechaza');
select lives_ok($$
  insert into public.retention_voucher_lines
    (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
     document_type, document_number, control_number, document_date, total_amount, taxable_base,
     exempt_amount, iva_amount, tax_rate, portion, retained_amount)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000c00a', 'aaaa0094-0000-4000-8000-00000000f00a',
          'aaaa0094-0000-4000-8000-00000000d00a', '01', 'FP-94A', 'CTRL-94A', '2026-10-01',
          1160, 1000, 0, 160, 16, 0.75, 120)
$$, 'el renglón del comprobante se escribe con su documento y sus importes');
select throws_ok($$
  insert into public.retention_voucher_lines
    (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
     document_type, document_date, total_amount, taxable_base, exempt_amount, iva_amount,
     portion, retained_amount)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000c00a', 'aaaa0094-0000-4000-8000-00000000f00a',
          'aaaa0094-0000-4000-8000-00000000d00a', '01', '2026-10-01', 1160, 1000, 0, 160,
          0.75, 999)
$$, '23514', null, 'retener más que el IVA causado se rechaza');
select throws_ok($$
  insert into public.retention_voucher_lines
    (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
     document_type, document_date, total_amount, taxable_base, exempt_amount, iva_amount,
     portion, retained_amount)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000c00a', 'aaaa0094-0000-4000-8000-00000000f00a',
          'aaaa0094-0000-4000-8000-00000000d00a', '01', '2026-10-01', 1160, 1000, 0, 160,
          0.75, 120)
$$, '23505', null, 'la misma retención dos veces en la misma versión del comprobante se rechaza');
select throws_ok($$
  insert into public.retention_voucher_lines
    (tenant_id, company_id, retention_voucher_id, supplier_invoice_id, supplier_retention_id,
     document_type, document_date, total_amount, taxable_base, exempt_amount, iva_amount,
     portion, retained_amount)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000c00a', 'aaaa0094-0000-4000-8000-00000000f00a',
          'aaaa0094-0000-4000-8000-00000000d00a', '07', '2026-10-01', 1160, 1000, 0, 160,
          0.75, 120)
$$, '23514', null, 'el tipo de documento es 01, 02 o 03 (instructivo, P-7)');

-- ── 4. Append-only y la entrega ──────────────────────────────────────────────
select throws_ok($$
  update public.retention_vouchers set supplier_name = 'Otro nombre'
   where id = 'aaaa0094-0000-4000-8000-00000000c00a'
$$, 'LAD06', null, 'el comprobante emitido no se edita: se corrige con una versión nueva');
select throws_ok($$
  delete from public.retention_vouchers where id = 'aaaa0094-0000-4000-8000-00000000c00a'
$$, 'LAD06', null, 'el comprobante no se borra');
select throws_ok($$
  update public.retention_voucher_lines set retained_amount = 1
   where retention_voucher_id = 'aaaa0094-0000-4000-8000-00000000c00a'
$$, 'LAD06', null, 'el renglón del comprobante no se edita');
select lives_ok($$
  update public.retention_vouchers
     set delivered_on = '2026-10-05', delivered_by = 'aaaa0094-0000-4000-8000-0000000000a1'
   where id = 'aaaa0094-0000-4000-8000-00000000c00a'
$$, 'la entrega se anota: la única escritura después de emitir');
select throws_ok($$
  update public.retention_vouchers set delivered_on = '2026-10-06'
   where id = 'aaaa0094-0000-4000-8000-00000000c00a'
$$, 'LAD06', null, 'y se anota UNA vez: cambiarla después se rechaza');
select is((select delivered_on from public.retention_vouchers
            where id = 'aaaa0094-0000-4000-8000-00000000c00a'),
  '2026-10-05'::date, 'la entrega anotada sigue intacta');
-- Una versión nueva reemplaza; la vieja queda anulada por el reemplazo, sin UPDATE.
select lives_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, version_no, replaces_voucher_id, correction_reason, functional_currency,
     rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000e00a', '202610', 2, 'per_operation', '2026-10-06',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001', 'A', 'J-PRO-94A', 'P', 2,
          'aaaa0094-0000-4000-8000-00000000c00a', 'El domicilio del proveedor estaba mal', 'VES',
          't94')
$$, 'corregir es insertar la versión 2 que reemplaza a la 1');
select throws_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, version_no, replaces_voucher_id, correction_reason, functional_currency,
     rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000a', 'aaaa0094-0000-4000-8000-0000000000a2',
          'aaaa0094-0000-4000-8000-00000000e00a', '202610', 3, 'per_operation', '2026-10-06',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000001', 'A', 'J-PRO-94A', 'P', 2,
          'aaaa0094-0000-4000-8000-00000000c00a', 'Segunda corrección de la misma versión', 'VES',
          't94')
$$, '23505', null, 'una versión se reemplaza UNA vez: dos correcciones dejarían dos vigentes');

-- ── 5. La quincena y el vencimiento ──────────────────────────────────────────
select is(platform.retention_voucher_due_on('2026-10-15'), '2026-10-19'::date,
  'quincena que acaba en jueves 15: vence el lunes 19 (2.º día de lunes a viernes)');
select is(platform.retention_voucher_due_on('2026-09-30'), '2026-10-02'::date,
  'quincena que acaba en miércoles 30: vence el viernes 2');
select is((select fortnight_end from platform.retention_fortnight('2026-02-20')),
  '2026-02-28'::date, 'la segunda quincena de febrero acaba el último día del mes');

-- ── 7. Aislamiento como ladino_api, actor de varios tenants ──────────────────
set local role ladino_api;
select is((select count(*) from public.retention_vouchers
            where company_id = 'aaaa0094-0000-4000-8000-0000000000a2'),
  2::bigint, 'ladino_api lee los comprobantes de un tenant del actor');
select is((select count(*) from public.retention_vouchers
            where company_id = 'aaaa0094-0000-4000-8000-0000000000b2'),
  0::bigint, 'ladino_api NO ve los comprobantes de un tenant ajeno');
select lives_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, functional_currency, rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000c', 'aaaa0094-0000-4000-8000-0000000000c2',
          'aaaa0094-0000-4000-8000-00000000e00c', '202610', 1, 'per_operation', '2026-10-02',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000003', 'C', 'J-PRO-94C', 'P', 'VES',
          't94')
$$, 'ladino_api emite en el OTRO tenant del mismo actor (el camino permitido funciona)');
select throws_ok($$
  insert into public.retention_vouchers
    (tenant_id, company_id, supplier_id, voucher_period, sequence, mode, issued_on,
     fortnight_start, fortnight_end, delivery_due_on, agent_tax_id, agent_name, supplier_tax_id,
     supplier_name, functional_currency, rules_version)
  values ('aaaa0094-0000-4000-8000-00000000000b', 'aaaa0094-0000-4000-8000-0000000000b2',
          'aaaa0094-0000-4000-8000-00000000e00b', '202610', 9, 'per_operation', '2026-10-02',
          '2026-10-01', '2026-10-15', '2026-10-19', 'J940000002', 'B', 'J-PRO-94B', 'P', 'VES',
          't94')
$$, '42501', null, 'ladino_api NO emite en un tenant ajeno');
update public.retention_vouchers
   set delivered_on = '2026-10-05', delivered_by = 'aaaa0094-0000-4000-8000-0000000000a1'
 where id = 'aaaa0094-0000-4000-8000-00000000c00b';
select throws_ok($$
  insert into public.retention_exclusions
    (code, legal_norm, legal_article, gazette, numeral_verified, applies, description,
     effective_from)
  values ('inventada', 'PA X', 'art. 99', 'G.O. 0', false, 'marked', 'x', '2026-01-01')
$$, '42501', null, 'el catálogo de exclusiones no se escribe desde la API');
reset role;
select is((select delivered_on from public.retention_vouchers
            where id = 'aaaa0094-0000-4000-8000-00000000c00b'),
  null, 'el UPDATE de A sobre el comprobante de B no cambió NADA (0 filas, dato intacto)');

-- ── 8. Catálogo y exclusión marcada ──────────────────────────────────────────
select is((select count(*) from public.retention_exclusions where numeral_verified),
  13::bigint, 'los 13 numerales del art. 3 verificados (reproducción; migración 20261002110400)');
-- Un borrador: la factura posteada ya no se edita (LAD06 se adelantaría y el CHECK no se mediría).
select throws_ok($$
  insert into public.supplier_invoices
    (tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, subtotal_amount, tax_amount, total_amount, tax_is_recoverable,
     transaction_currency, functional_currency, fx_rate, amount_transaction_currency,
     functional_amount, retention_exclusion_code)
  values ('aaaa0094-0000-4000-8000-00000000000c', 'aaaa0094-0000-4000-8000-0000000000c2',
          'aaaa0094-0000-4000-8000-00000000e00c', 'FP-94C-2', 'CTRL-94C-2', '2026-10-01',
          'draft', 0, 0, 0, true, 'VES', 'VES', 1, 0, 0, 'caja_chica_20ut')
$$, '23514', null, 'una exclusión sin motivo no es auditable: se rechaza');

-- ── 4 bis. Variante rota: SIN el guardián, el UPDATE entra ───────────────────
-- Sin savepoint: un rollback to savepoint deshace también la cuenta de pgTAP (H1). El trigger se
-- quita y se vuelve a crear, y el rollback final lo deja todo como estaba.
drop trigger retention_vouchers_02_guard on public.retention_vouchers;
update public.retention_vouchers set supplier_name = 'Editado sin guardián'
 where id = 'aaaa0094-0000-4000-8000-00000000c00a';
select is((select supplier_name from public.retention_vouchers
            where id = 'aaaa0094-0000-4000-8000-00000000c00a'),
  'Editado sin guardián', 'sin el trigger el UPDATE entra: el throws_ok de arriba medía el guardián');
create trigger retention_vouchers_02_guard
  before update or delete on public.retention_vouchers
  for each row execute function platform.retention_vouchers_guard();

select * from finish();
rollback;
