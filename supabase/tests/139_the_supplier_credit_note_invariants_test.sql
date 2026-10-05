-- =============================================================================
-- 139 · Los invariantes de la nota de crédito del proveedor, por SQL (H-03, ADR-0083, cuarta
--       ronda). Migraciones 20261005110500, 110600, 110800 y 110900 (hasta aquí solo las ejercía
--       el E2E `e2e-nc-proveedor`, con el caso de uso).
-- =============================================================================
-- Lo que prueba:
--   a. `platform.settled_ledger_gaps`, TERCERA rama (factura `posted` que una nota dejó en cero):
--      sana ⇒ 0 filas; un céntimo de residuo en cuentas por pagar ⇒ 1 fila; otro tenant no ve
--      nada; lo anterior al corte no se mira; y SIN la fila de corte no calla: una fila
--      `falta_el_corte` (20261005110900);
--   b. `platform.supplier_credit_subledger_gaps`: sano ⇒ 0; un céntimo entre el auxiliar y lo
--      declarado ⇒ 1 fila; otro tenant no ve nada; lo anterior al corte no se mira; sin la fila de
--      corte lo mira TODO (el lado ruidoso);
--   c. el CHECK `0 <= credit_in_favor_transaction <= total_amount`, y su variante rota;
--   d. `platform.inventory_ledger_gap`, el término del ajuste de la nota en `en_cola`, estado por
--      estado y con cifras distintas en cada uno: ajuste pendiente con la nota posteada; los dos
--      en cola; ajuste DESCARTADO CON ACTA (20261005110800: antes no contaba); descartado sin
--      acta; descartado con acta y la nota en cola; y la nota en cola con el ajuste ya posteado.
-- Los estados con movimientos de kardex de verdad los ejerce el E2E «6b» con el caso de uso: aquí
-- no se escribe en `inventory_moves`.
-- =============================================================================
begin;
select plan(24);

insert into auth.users (id) values ('aaaa0139-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0139-0000-4000-8000-0000000000aa', true);
insert into public.tenants (id, name) values
  ('aaaa0139-0000-4000-8000-00000000000a', 'Tenant 139 A'),
  ('aaaa0139-0000-4000-8000-00000000000b', 'Tenant 139 B');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code) values
  ('aaaa0139-0000-4000-8000-0000000000a1', 'aaaa0139-0000-4000-8000-00000000000a',
   'J-139-A', 'Bodega 139 A', 'VES', 'ordinario'),
  ('aaaa0139-0000-4000-8000-0000000000b1', 'aaaa0139-0000-4000-8000-00000000000b',
   'J-139-B', 'Bodega 139 B', 'VES', 'ordinario');
insert into public.suppliers (id, tenant_id, company_id, tax_id, legal_name, supplier_kind,
                              person_type_code, taxpayer_type_code) values
  ('aaaa0139-0000-4000-8000-00000000e001', 'aaaa0139-0000-4000-8000-00000000000a',
   'aaaa0139-0000-4000-8000-0000000000a1', 'J-PRV-139', 'Proveedor 139', 'nacional',
   'juridica', 'ordinario'),
  ('aaaa0139-0000-4000-8000-00000000e002', 'aaaa0139-0000-4000-8000-00000000000b',
   'aaaa0139-0000-4000-8000-0000000000b1', 'J-PRV-139B', 'Proveedor 139 B', 'nacional',
   'juridica', 'ordinario');
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature, is_leaf, level)
values
  ('aaaa0139-0000-4000-8000-0000000ac001', 'aaaa0139-0000-4000-8000-00000000000a',
   'aaaa0139-0000-4000-8000-0000000000a1', '2.1.01.139', 'Cuentas por pagar 139', 'pasivo',
   'acreedora', true, 1),
  ('aaaa0139-0000-4000-8000-0000000ac002', 'aaaa0139-0000-4000-8000-00000000000a',
   'aaaa0139-0000-4000-8000-0000000000a1', '4.1.01.139', 'Contrapartida 139', 'ingreso',
   'acreedora', true, 1),
  ('aaaa0139-0000-4000-8000-0000000ac003', 'aaaa0139-0000-4000-8000-00000000000a',
   'aaaa0139-0000-4000-8000-0000000000a1', '1.1.05.139', 'Inventario 139', 'activo',
   'deudora', true, 1);
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1', 'ap_general',
   'aaaa0139-0000-4000-8000-0000000ac001'),
  ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1',
   'inventory_general', 'aaaa0139-0000-4000-8000-0000000ac003');

-- Una factura de proveedor ASENTADA, en bolívares, sin IVA (lo que se mira es el saldo).
create function pg_temp.factura(p_id uuid, p_ab text, p_total numeric)
returns void language sql as $$
  insert into public.supplier_invoices
    (id, tenant_id, company_id, supplier_id, supplier_document_number, supplier_control_number,
     invoice_date, status, posted_at, subtotal_amount, tax_amount, total_amount,
     tax_is_recoverable, fiscal_support, transaction_currency, functional_currency, fx_rate,
     amount_transaction_currency, functional_amount)
  values (p_id, ('aaaa0139-0000-4000-8000-00000000000' || p_ab)::uuid,
          ('aaaa0139-0000-4000-8000-0000000000' || p_ab || '1')::uuid,
          case p_ab when 'a' then 'aaaa0139-0000-4000-8000-00000000e001'::uuid
                    else 'aaaa0139-0000-4000-8000-00000000e002'::uuid end,
          'F-139-' || right(p_id::text, 4), 'C-139-' || right(p_id::text, 4),
          platform.caracas_day(now()), 'posted', now(), p_total, 0, p_total, true, true,
          'VES', 'VES', 1, p_total, p_total);
$$;
-- Su nota de crédito ASENTADA: el total y lo que DECLARA a favor en la moneda de la factura.
create function pg_temp.nota(p_id uuid, p_factura uuid, p_total numeric, p_favor numeric,
                             p_estado text default 'posted')
returns void language sql as $$
  insert into public.supplier_credit_notes
    (id, tenant_id, company_id, supplier_id, supplier_invoice_id, supplier_document_number,
     supplier_control_number, note_date, status, posted_at, reason, transaction_currency,
     functional_currency, subtotal_amount, tax_amount, total_amount, is_fiscal,
     document_incomplete, correction_kind, credit_in_favor_transaction)
  select p_id, i.tenant_id, i.company_id, i.supplier_id, i.id, 'NC-139-' || right(p_id::text, 4),
         'CN-139-' || right(p_id::text, 4), platform.caracas_day(now()), p_estado,
         case when p_estado = 'posted' then now() end, 'Prueba 139', 'VES', 'VES', p_total, 0,
         p_total, true, false, 'rebaja', p_favor
    from public.supplier_invoices i where i.id = p_factura;
$$;
-- Un asiento posteado de dos líneas en la empresa A, en bolívares.
create function pg_temp.asiento(p_kind text, p_source uuid, p_event text, p_debe uuid,
                                p_haber uuid, p_importe numeric)
returns void language plpgsql as $$
declare v_e uuid;
begin
  insert into public.journal_entries
    (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description, rules_version)
  values ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1',
          platform.period_for_date('aaaa0139-0000-4000-8000-0000000000a1',
                                   platform.caracas_day(now())),
          platform.caracas_day(now()), p_kind, p_source, p_event, 'Montaje pgTAP 139', 'pgtap-139')
  returning id into v_e;
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit)
  values
    ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1', v_e, 1,
     p_debe, p_importe, 0, p_importe, 'VES', 1, p_importe, 'VES', 'identidad', now(),
     p_importe, 0),
    ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1', v_e, 2,
     p_haber, 0, p_importe, p_importe, 'VES', 1, p_importe, 'VES', 'identidad', now(),
     0, p_importe);
  update public.journal_entries
     set status = 'posted', posted_at = now(), posted_by = 'aaaa0139-0000-4000-8000-0000000000aa',
         entry_number = platform.claim_entry_number(
           'aaaa0139-0000-4000-8000-0000000000a1',
           extract(year from platform.caracas_day(now()))::int)
   where id = v_e;
end $$;
-- La nota de una factura (una por factura en este fichero).
create function pg_temp.nota_de(p_factura uuid) returns uuid language sql as $$
  select n.id from public.supplier_credit_notes n where n.supplier_invoice_id = p_factura
$$;
create function pg_temp.saldados(p_empresa uuid) returns text language sql as $$
  select coalesce(string_agg(g.side || ':' || coalesce(right(g.document_id::text, 4), '-') || ':'
                             || coalesce(round(g.residual, 2)::text, '-'), ','
                             order by g.side, g.document_id), '')
    from platform.settled_ledger_gaps(p_empresa) g
$$;
create function pg_temp.auxiliar(p_empresa uuid) returns text language sql as $$
  select coalesce(string_agg(right(g.supplier_invoice_id::text, 4) || ':'
                             || round(g.diferencia, 2)::text, ','
                             order by g.supplier_invoice_id), '')
    from platform.supplier_credit_subledger_gaps(p_empresa) g
$$;
create function pg_temp.corte(p_invariante text, p_cuando timestamptz) returns void
language sql as $$
  update platform.invariant_cutoffs set since = p_cuando where invariant = p_invariante
$$;

-- ── a. settled_ledger_gaps, la tercera rama ─────────────────────────────────────────────────
-- f001: 116 facturados y una nota de 116 que la deja en cero; el mayor acredita 116 y la nota
-- debita 116. f002: lo mismo, pero el asiento de la nota bajó 115,99: queda UN céntimo.
select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f001', 'a', 116);
select pg_temp.nota(gen_random_uuid(), 'aaaa0139-0000-4000-8000-00000000f001', 116, 0);
select pg_temp.asiento('purchase_invoice', 'aaaa0139-0000-4000-8000-00000000f001',
  'ap.invoice_posted', 'aaaa0139-0000-4000-8000-0000000ac002',
  'aaaa0139-0000-4000-8000-0000000ac001', 116);
select pg_temp.asiento('purchase_credit_note',
  pg_temp.nota_de('aaaa0139-0000-4000-8000-00000000f001'), 'ap.credit_note_received',
  'aaaa0139-0000-4000-8000-0000000ac001', 'aaaa0139-0000-4000-8000-0000000ac002', 116);
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000a1'), '',
  'tercera rama, sana: la factura que una nota dejó en cero con su cuenta por pagar en cero no da fila');

select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f002', 'a', 116);
select pg_temp.nota(gen_random_uuid(), 'aaaa0139-0000-4000-8000-00000000f002', 116, 0);
select pg_temp.asiento('purchase_invoice', 'aaaa0139-0000-4000-8000-00000000f002',
  'ap.invoice_posted', 'aaaa0139-0000-4000-8000-0000000ac002',
  'aaaa0139-0000-4000-8000-0000000ac001', 116);
select pg_temp.asiento('purchase_credit_note',
  pg_temp.nota_de('aaaa0139-0000-4000-8000-00000000f002'), 'ap.credit_note_received',
  'aaaa0139-0000-4000-8000-0000000ac001', 'aaaa0139-0000-4000-8000-0000000ac002', 115.99);
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000a1'), 'ap:f002:0.01',
  'tercera rama, ROTA: un céntimo de residuo en cuentas por pagar da UNA fila, la de esa factura');
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000b1'), '',
  'la empresa del OTRO tenant no ve la fila de esta');
-- El corte es DATO: con el corte después de la nota, esa factura no se mira (antes del corte la
-- nota que cerraba no reconocía diferencial).
select pg_temp.corte('settled_by_supplier_credit_note', now() + interval '1 hour');
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000a1'), '',
  'la factura cerrada por una nota ANTERIOR al corte no se mira');
-- SIN la fila de corte la rama no puede decidir qué mira. Antes callaba (0 filas con el residuo
-- delante); ahora lo dice (20261005110900).
delete from platform.invariant_cutoffs where invariant = 'settled_by_supplier_credit_note';
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000a1'), 'falta_el_corte:-:-',
  'SIN la fila de corte el invariante no calla: una fila `falta_el_corte`');
insert into platform.invariant_cutoffs (invariant, since, reason)
values ('settled_by_supplier_credit_note', now() - interval '1 hour', 'pgTAP 139: corte repuesto');
select is(pg_temp.saldados('aaaa0139-0000-4000-8000-0000000000a1'), 'ap:f002:0.01',
  'y con el corte repuesto vuelve a dar la fila del céntimo, y solo esa');

-- ── b. supplier_credit_subledger_gaps: el auxiliar contra lo declarado ──────────────────────
-- f003: 100 facturados, nota de 110 que DECLARA 10 a favor: el auxiliar dice 10. Sano.
select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f003', 'a', 100);
select pg_temp.nota(gen_random_uuid(), 'aaaa0139-0000-4000-8000-00000000f003', 110, 10);
-- En el otro tenant, una factura igual de sana.
select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f0b1', 'b', 100);
select pg_temp.nota(gen_random_uuid(), 'aaaa0139-0000-4000-8000-00000000f0b1', 110, 10);
select is(pg_temp.auxiliar('aaaa0139-0000-4000-8000-0000000000a1'), '',
  'auxiliar ↔ declarado, sano: la nota declaró lo mismo que dice el auxiliar');
-- f004: la nota declara 9,99 y el auxiliar dice 10.
select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f004', 'a', 100);
select pg_temp.nota(gen_random_uuid(), 'aaaa0139-0000-4000-8000-00000000f004', 110, 9.99);
select is(pg_temp.auxiliar('aaaa0139-0000-4000-8000-0000000000a1'), 'f004:0.01',
  'auxiliar ↔ declarado, ROTO: un céntimo de diferencia da UNA fila, la de esa factura');
select is(pg_temp.auxiliar('aaaa0139-0000-4000-8000-0000000000b1'), '',
  'la empresa del OTRO tenant no ve la fila de esta');
select pg_temp.corte('supplier_credit_subledger_gaps', now() + interval '1 hour');
select is(pg_temp.auxiliar('aaaa0139-0000-4000-8000-0000000000a1'), '',
  'la factura con una nota ANTERIOR al corte no se mira (esa nota no declaraba)');
-- SIN la fila de corte este invariante NO calla: lo mira todo, también lo anterior.
delete from platform.invariant_cutoffs where invariant = 'supplier_credit_subledger_gaps';
select is(pg_temp.auxiliar('aaaa0139-0000-4000-8000-0000000000a1'), 'f004:0.01',
  'SIN la fila de corte el invariante mira TODAS las facturas: el lado ruidoso');
insert into platform.invariant_cutoffs (invariant, since, reason)
values ('supplier_credit_subledger_gaps', now() - interval '1 hour', 'pgTAP 139: corte repuesto');

-- ── c. El CHECK de lo declarado ─────────────────────────────────────────────────────────────
select pg_temp.factura('aaaa0139-0000-4000-8000-00000000f005', 'a', 100);
select throws_ok($$ select pg_temp.nota(gen_random_uuid(),
  'aaaa0139-0000-4000-8000-00000000f005', 50, -0.01, 'draft') $$,
  '23514', null, 'lo declarado a favor no es negativo');
select throws_ok($$ select pg_temp.nota(gen_random_uuid(),
  'aaaa0139-0000-4000-8000-00000000f005', 50, 50.01, 'draft') $$,
  '23514', null, 'lo declarado a favor no pasa del total de la nota');
alter table public.supplier_credit_notes
  drop constraint supplier_credit_notes_credit_in_favor_transaction_chk;
select lives_ok($$ select pg_temp.nota(gen_random_uuid(),
  'aaaa0139-0000-4000-8000-00000000f005', 50, 50.01, 'draft') $$,
  'ROTA: sin el CHECK entra — el 23514 de arriba lo da ESE CHECK');
delete from public.supplier_credit_notes
 where supplier_invoice_id = 'aaaa0139-0000-4000-8000-00000000f005';
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_credit_in_favor_transaction_chk
    check (credit_in_favor_transaction >= 0 and credit_in_favor_transaction <= total_amount);

-- ── d. inventory_ledger_gap: el ajuste del kardex de la nota en `en_cola` ───────────────────
-- Una fila de cola de la empresa A. El ajuste lleva en su contexto lo que irá a inventario.
create function pg_temp.cola(p_kind text, p_source uuid, p_importe numeric, p_estado text,
                             p_acta boolean)
returns void language plpgsql as $$
declare v_q uuid;
begin
  insert into public.journal_generation_queue
    (tenant_id, company_id, source_kind, source_id, source_event, context, reason, status,
     processed_at)
  values ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1',
          p_kind, p_source, 'ap.credit_note_received',
          case when p_importe is null then '{}'::jsonb
               else jsonb_build_object('revaluation_to_inventory', p_importe::text) end,
          'Montaje pgTAP 139', p_estado, case when p_estado = 'discarded' then now() end)
  returning id into v_q;
  if p_acta then
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
       rules_version, payload)
    values ('aaaa0139-0000-4000-8000-00000000000a', 'aaaa0139-0000-4000-8000-0000000000a1',
            'journal_generation_queue', v_q, 'accounting.pending_discarded', 'system', now(),
            'pgtap-139', jsonb_build_object('queue_id', v_q::text, 'reason', 'pgTAP 139'));
  end if;
end $$;
create function pg_temp.en_cola(p_empresa uuid) returns numeric language sql as $$
  select g.en_cola from platform.inventory_ledger_gap(p_empresa) g
$$;

-- Nota POSTEADA (no está en la cola) × ajuste PENDIENTE: al mayor le falta el ajuste.
select pg_temp.cola('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0001', -3,
                    'pending', false);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -3::numeric,
  'nota posteada × ajuste en cola: el ajuste (−3) cuenta en en_cola');
-- Nota EN COLA × ajuste EN COLA: los movimientos de la nota ya los cuenta `q`; el ajuste, no.
select pg_temp.cola('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0002', -5,
                    'pending', false);
select pg_temp.cola('purchase_credit_note', 'aaaa0139-0000-4000-8000-0000000d0002', null,
                    'pending', false);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -3::numeric,
  'nota en cola × ajuste en cola: su ajuste (−5) NO se suma otra vez');
-- Nota posteada × ajuste DESCARTADO CON ACTA: explica un valor sin asiento igual que el
-- pendiente (como en `q` y en `notas_en_cola`). Antes de la 110800 no contaba.
select pg_temp.cola('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0003', -7,
                    'discarded', true);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -10::numeric,
  'nota posteada × ajuste DESCARTADO CON ACTA: el ajuste (−7) cuenta, como en `q`');
-- Descartado SIN acta: no explica nada.
select pg_temp.cola('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0004', -11,
                    'discarded', false);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -10::numeric,
  'un ajuste descartado SIN acta (−11) no cuenta');
-- Descartado con acta, con la nota en cola: tampoco (sus movimientos están en `q`).
select pg_temp.cola('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0005', -13,
                    'discarded', true);
select pg_temp.cola('purchase_credit_note', 'aaaa0139-0000-4000-8000-0000000d0005', null,
                    'pending', false);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -10::numeric,
  'nota en cola × ajuste descartado con acta (−13): no se suma');
-- Nota EN COLA × ajuste YA POSTEADO (acreditó 4 a inventario): se resta lo que el mayor ya tiene.
select pg_temp.asiento('purchase_revaluation', 'aaaa0139-0000-4000-8000-0000000d0006',
  'ap.credit_note_received', 'aaaa0139-0000-4000-8000-0000000ac002',
  'aaaa0139-0000-4000-8000-0000000ac003', 4);
select pg_temp.cola('purchase_credit_note', 'aaaa0139-0000-4000-8000-0000000d0006', null,
                    'pending', false);
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000a1'), -6::numeric,
  'nota en cola × ajuste posteado: en_cola descuenta lo que ese asiento ya llevó al mayor (+4)');
select is((select g.diferencia from platform.inventory_ledger_gap(
             'aaaa0139-0000-4000-8000-0000000000a1') g), 4::numeric,
  'y la brecha kardex − mayor es lo que ese asiento movió (sin movimientos de kardex: 0 − (−4))');
select is(pg_temp.en_cola('aaaa0139-0000-4000-8000-0000000000b1'), 0::numeric,
  'la empresa del OTRO tenant no ve nada de la cola de esta');

-- ── e. La función nueva no es de todo el mundo ──────────────────────────────────────────────
set local role anon;
select throws_ok(
  $$ select * from platform.supplier_credit_subledger_gaps('aaaa0139-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'anon no ejecuta supplier_credit_subledger_gaps');
reset role;
set local role ladino_api;
select lives_ok(
  $$ select * from platform.supplier_credit_subledger_gaps('aaaa0139-0000-4000-8000-0000000000a1') $$,
  'ladino_api sí la ejecuta (la lee el estado de invariantes)');
reset role;

select * from finish();
rollback;
