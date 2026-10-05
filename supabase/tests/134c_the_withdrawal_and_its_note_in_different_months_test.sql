-- =============================================================================
-- pgTAP 134c · EL RETIRO Y SU NOTA DE CRÉDITO EN MESES DISTINTOS (ADR-0082, punto 9b)
--
-- Por la API no se fabrica una factura de retiro de otro día (AF5-08: lleva la fecha de hoy, y
-- el servidor fecha también la nota). Aquí se FABRICA por SQL de fixture, sin apagar ninguna
-- guarda: la factura de retiro, su salida y su asiento el MES ANTERIOR; su nota de crédito, el
-- reingreso y su asiento HOY. Y se comprueba, mes a mes:
--   · el libro de ventas lleva la factura en SU mes y la nota, en negativo, en el suyo (el
--     período de la nota es el de su emisión: LIVA art. 36);
--   · `book_ledger_reconciliation` cuadra en cada mes por separado y en los dos juntos;
--   · `inventory_ledger_gap`, `inventory_coverage_gaps` y `withdrawal_note_gaps` en cero;
--   · la regla de la anulación rechaza la factura del mes anterior (`not_same_day`).
-- La variante rota es el estado intermedio REAL: con la nota emitida y la mercancía de vuelta,
-- pero sin el asiento del reingreso, el mes de la nota no cuadra y el movimiento no está
-- cubierto. Con el asiento, todo vuelve a cero: las aserciones miden ese asiento.
-- Las fechas se calculan sobre el reloj: el fichero vale cualquier día del año.
-- =============================================================================
begin;
select plan(13);

insert into auth.users (id) values ('aaaa0137-0000-4000-8000-0000000000aa');
select set_config('ladino.actor_id', 'aaaa0137-0000-4000-8000-0000000000aa', true);
select set_config('ladino.rules_version', 'domain-s0.5', true);

-- «Antes»: el mediodía de Caracas de diez días antes de empezar este mes (siempre el mes pasado).
create temp table t on commit drop as
select x.antes,
       platform.caracas_day(x.antes) as dia_antes,
       platform.caracas_day(now()) as hoy,
       date_trunc('month', platform.caracas_day(x.antes))::date as antes_desde,
       (date_trunc('month', platform.caracas_day(now())) - interval '1 day')::date as antes_hasta,
       date_trunc('month', platform.caracas_day(now()))::date as hoy_desde,
       (date_trunc('month', platform.caracas_day(now())) + interval '1 month - 1 day')::date
         as hoy_hasta
  from (select (date_trunc('month', now() at time zone 'America/Caracas')
                - interval '10 days' + interval '12 hours') at time zone 'America/Caracas'
               as antes) x;

insert into public.tenants (id, name) values ('aaaa0137-0000-4000-8000-00000000000a', 'Tenant 134c');
insert into public.companies (id, tenant_id, tax_id, legal_name, functional_currency_code,
                              taxpayer_type_code, activity_start_date)
values ('aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-00000000000a',
        'J-137-A', 'Bodega 134c', 'VES', 'ordinario', '2020-01-01');
insert into public.company_fiscal_regimes (tenant_id, company_id, regime_code, effective_from)
values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
        'formatos_libres', '2020-01-01');
insert into public.company_taxpayer_types
  (tenant_id, company_id, taxpayer_type_code, effective_from, reason, rules_version)
values ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
        'ordinario', '2000-01-01', 'pgTAP 134c', 'pgtap');
insert into public.warehouses (id, tenant_id, company_id, code, name) values
  ('aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'W137', 'Principal');
insert into public.products (id, tenant_id, company_id, sku, name, kind, status, unit_code,
                             tax_category_code) values
  ('aaaa0137-0000-4000-8000-00000000d001', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'SKU-137', 'Harina 134c', 'good', 'active', 'unidad',
   'gravado_general');
insert into public.customers (id, tenant_id, company_id, tax_id, legal_name, person_type_code,
                              taxpayer_type_code) values
  ('aaaa0137-0000-4000-8000-00000000c001', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', 'J-137-A', 'Bodega 134c', 'juridica', 'ordinario');

-- El plan mínimo: inventario, gasto por retiro, débito fiscal y el capital que aportó la harina.
insert into public.accounts (id, tenant_id, company_id, code, name, kind, nature) values
  ('aaaa0137-0000-4000-8000-00000000ac01', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', '1.1', 'Inventario', 'activo', 'deudora'),
  ('aaaa0137-0000-4000-8000-00000000ac02', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', '5.1', 'Gasto por retiro', 'gasto', 'deudora'),
  ('aaaa0137-0000-4000-8000-00000000ac03', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', '2.1', 'IVA débito fiscal', 'pasivo', 'acreedora'),
  ('aaaa0137-0000-4000-8000-00000000ac04', 'aaaa0137-0000-4000-8000-00000000000a',
   'aaaa0137-0000-4000-8000-0000000000a1', '3.1', 'Capital', 'patrimonio', 'acreedora');
insert into public.company_account_settings (tenant_id, company_id, purpose, account_id) values
  ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
   'inventory_general', 'aaaa0137-0000-4000-8000-00000000ac01'),
  ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
   'inventory_withdrawal', 'aaaa0137-0000-4000-8000-00000000ac02'),
  ('aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
   'iva_debit_fiscal', 'aaaa0137-0000-4000-8000-00000000ac03');
insert into public.fiscal_periods (id, tenant_id, company_id, year, month)
select 'aaaa0137-0000-4000-8000-00000000be01', 'aaaa0137-0000-4000-8000-00000000000a',
       'aaaa0137-0000-4000-8000-0000000000a1',
       extract(year from t.dia_antes)::int, extract(month from t.dia_antes)::int from t;
insert into public.fiscal_periods (id, tenant_id, company_id, year, month)
select 'aaaa0137-0000-4000-8000-00000000be02', 'aaaa0137-0000-4000-8000-00000000000a',
       'aaaa0137-0000-4000-8000-0000000000a1',
       extract(year from t.hoy)::int, extract(month from t.hoy)::int from t;

create function pg_temp.mover(p_id uuid, p_kind text, p_q numeric, p_val numeric,
                              p_q_after numeric, p_v_after numeric, p_motivo text, p_doc uuid,
                              p_cuando timestamptz)
returns void language sql as $$
  insert into public.inventory_moves
    (id, tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
     amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
     functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
     quantity_after, value_after, occurred_at, exit_reason, source_document_id)
  values (p_id, 'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          'aaaa0137-0000-4000-8000-0000000000b1', 'aaaa0137-0000-4000-8000-00000000d001', null,
          p_kind, p_q, p_val, 'VES', 1, p_val, 'VES', 'identidad', p_cuando,
          'inventory:cost:8:HALF_UP', 10, p_q_after, p_v_after, p_cuando, p_motivo, p_doc);
$$;
create function pg_temp.borrador(p_id uuid, p_kind text, p_origen uuid) returns void
language sql as $$
  insert into public.documents
    (id, tenant_id, company_id, kind, series, customer_id, source_document_id,
     transaction_currency, functional_currency, amount_transaction_currency, functional_amount,
     subtotal_amount, tax_amount, total_amount, customer_name_snapshot,
     customer_tax_id_snapshot, customer_taxpayer_type_snapshot, issuer_name_snapshot,
     issuer_tax_id_snapshot)
  values (p_id, 'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          p_kind, 'A', 'aaaa0137-0000-4000-8000-00000000c001', p_origen, 'VES', 'VES', 116, 116,
          100, 16, 116, 'Bodega 134c', 'J137A', 'ordinario', 'Bodega 134c', 'J137A');
$$;
create function pg_temp.emitir(p_id uuid, p_numero bigint, p_control bigint, p_move uuid,
                               p_cuando timestamptz)
returns void language sql as $$
  update public.documents
     set status = 'issued', issued_at = p_cuando, document_number = p_numero,
         control_number = p_control, control_identifier = '00',
         regime_version_id = (select r.regime_version_id
                                from platform.regime_at('aaaa0137-0000-4000-8000-0000000000a1',
                                                        p_cuando) r),
         rules_version = 'domain-s0.5', withdrawal_move_id = p_move
   where id = p_id;
$$;
-- Un asiento de dos o cuatro líneas, posteado. p_lineas: (cuenta, debe, haber) por orden.
create function pg_temp.asentar(p_id uuid, p_periodo uuid, p_fecha date, p_kind text,
                                p_source uuid, p_evento text, p_numero bigint,
                                p_cuentas uuid[], p_debe numeric[], p_haber numeric[])
returns void language plpgsql as $$
begin
  insert into public.journal_entries
    (id, tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
     description)
  values (p_id, 'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1',
          p_periodo, p_fecha, p_kind, p_source, p_evento, 'pgTAP 134c');
  insert into public.journal_lines
    (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
     amount_transaction_currency, transaction_currency, functional_amount, functional_currency,
     functional_debit, functional_credit)
  select 'aaaa0137-0000-4000-8000-00000000000a', 'aaaa0137-0000-4000-8000-0000000000a1', p_id,
         i, p_cuentas[i], p_debe[i], p_haber[i], p_debe[i] + p_haber[i], 'VES',
         p_debe[i] + p_haber[i], 'VES', p_debe[i], p_haber[i]
    from generate_subscripts(p_cuentas, 1) i;
  update public.journal_entries
     set status = 'posted', posted_at = now(),
         posted_by = 'aaaa0137-0000-4000-8000-0000000000aa', entry_number = p_numero
   where id = p_id;
end $$;

-- ── EL MES ANTERIOR: la harina entra, y un retiro se factura ────────────────
select pg_temp.mover('aaaa0137-0000-4000-8000-00000000e001', 'entrada', 10, 100, 10, 100, null,
                     null, (select antes - interval '1 day' from t));
select pg_temp.asentar('aaaa0137-0000-4000-8000-00000000ae01',
  'aaaa0137-0000-4000-8000-00000000be01', (select dia_antes - 1 from t), 'stock_opening',
  'aaaa0137-0000-4000-8000-00000000e001', 'stock.received', 1,
  array['aaaa0137-0000-4000-8000-00000000ac01', 'aaaa0137-0000-4000-8000-00000000ac04']::uuid[],
  array[100, 0], array[0, 100]);

select pg_temp.borrador('aaaa0137-0000-4000-8000-00000000f001', 'withdrawal_invoice', null);
select pg_temp.mover('aaaa0137-0000-4000-8000-00000000e002', 'salida', -1, -10, 9, 90,
                     'consumo_propio', 'aaaa0137-0000-4000-8000-00000000f001',
                     (select antes from t));
select pg_temp.emitir('aaaa0137-0000-4000-8000-00000000f001', 1, 1,
                      'aaaa0137-0000-4000-8000-00000000e002', (select antes from t));
-- El asiento del retiro: gasto contra inventario al costo (10) y gasto contra débito fiscal (16).
select pg_temp.asentar('aaaa0137-0000-4000-8000-00000000ae02',
  'aaaa0137-0000-4000-8000-00000000be01', (select dia_antes from t), 'inventory_move',
  'aaaa0137-0000-4000-8000-00000000e002', 'stock.withdrawn', 2,
  array['aaaa0137-0000-4000-8000-00000000ac02', 'aaaa0137-0000-4000-8000-00000000ac01',
        'aaaa0137-0000-4000-8000-00000000ac02', 'aaaa0137-0000-4000-8000-00000000ac03']::uuid[],
  array[10, 0, 16, 0], array[0, 10, 0, 16]);
select lives_ok($$ set constraints all immediate $$,
  'la factura de retiro del mes anterior, con su salida y su asiento, se confirma sin apagar ninguna guarda');
set constraints all deferred;

-- ── HOY: la regla ya no deja anularla, y se corrige con su nota ─────────────
select ok(
  exists (select 1 from platform.invoice_annulment_blockers(
            'aaaa0137-0000-4000-8000-0000000000a1', 'aaaa0137-0000-4000-8000-00000000f001',
            now()) b where b.reason = 'not_same_day'),
  'la regla de la anulación rechaza hoy la factura de retiro del mes anterior: not_same_day');

select pg_temp.borrador('aaaa0137-0000-4000-8000-00000000f002', 'withdrawal_credit_note',
                        'aaaa0137-0000-4000-8000-00000000f001');
select pg_temp.emitir('aaaa0137-0000-4000-8000-00000000f002', 1, 2, null, now());
select pg_temp.mover('aaaa0137-0000-4000-8000-00000000e003', 'entrada', 1, 10, 10, 100, null,
                     'aaaa0137-0000-4000-8000-00000000f002', now());

-- ROTO (el estado intermedio real): la nota está emitida y la mercancía volvió, pero el
-- reingreso no tiene asiento ni está en cola.
select is(
  (select array[libro::numeric(24,2)::text, mayor::numeric(24,2)::text,
                en_cola::numeric(24,2)::text]
     from platform.book_ledger_reconciliation(
     'aaaa0137-0000-4000-8000-0000000000a1', (select hoy_desde from t), (select hoy_hasta from t))
    where concepto = 'iva_debito_fiscal'),
  array['-16.00', '0.00', '-16.00'],
  'ROTO: sin el asiento del reingreso, el libro resta 16, el mayor no, y la conciliación lo cuenta como PENDIENTE (en_cola), no como cuadrado por el mayor');
-- OJO, medido aquí: `book_ledger_reconciliation` llama «en cola» a todo renglón del libro sin
-- asiento enlazado, haya o no fila en la cola de pendientes; por eso su `cuadra` sigue en true
-- en este estado. Quien dice que el asiento FALTA es el invariante del retiro:
select is(
  (select string_agg(problem, ',' order by problem) from platform.withdrawal_note_gaps(
     'aaaa0137-0000-4000-8000-0000000000a1')),
  'nota_de_credito_de_retiro_sin_iva_en_el_asiento',
  'ROTO: withdrawal_note_gaps dice que el IVA de la nota no está en ningún asiento ni en la cola');
select is(
  (select string_agg(move_id::text, ',') from platform.inventory_coverage_gaps(
     'aaaa0137-0000-4000-8000-0000000000a1')),
  'aaaa0137-0000-4000-8000-00000000e003',
  'ROTO: y el reingreso es un movimiento de valor sin asiento ni cola');

-- El contra-asiento, en el día de la NOTA (no reversa el del retiro: no reescribe el mes pasado).
select pg_temp.asentar('aaaa0137-0000-4000-8000-00000000ae03',
  'aaaa0137-0000-4000-8000-00000000be02', (select hoy from t), 'inventory_move',
  'aaaa0137-0000-4000-8000-00000000e003', 'stock.withdrawal_returned', 3,
  array['aaaa0137-0000-4000-8000-00000000ac01', 'aaaa0137-0000-4000-8000-00000000ac02',
        'aaaa0137-0000-4000-8000-00000000ac03', 'aaaa0137-0000-4000-8000-00000000ac02']::uuid[],
  array[10, 0, 16, 0], array[0, 10, 0, 16]);

-- ── El libro de ventas: cada documento en SU mes ────────────────────────────
select is(
  (select string_agg(s.kind || ':' || s.iva_debito::numeric(24,2), ',' order by s.kind)
     from platform.sales_book('aaaa0137-0000-4000-8000-0000000000a1',
                              (select antes_desde from t), (select antes_hasta from t)) s),
  'withdrawal_invoice:16.00',
  'el mes anterior lleva SOLO la factura de retiro, con su IVA');
select is(
  (select string_agg(s.kind || ':' || s.iva_debito::numeric(24,2), ',' order by s.kind)
     from platform.sales_book('aaaa0137-0000-4000-8000-0000000000a1',
                              (select hoy_desde from t), (select hoy_hasta from t)) s),
  'withdrawal_credit_note:-16.00',
  'este mes lleva SOLO la nota de crédito, en negativo: resta en el período en que se emite');

-- ── Libro = mayor, mes a mes y en los dos juntos ────────────────────────────
select is(
  (select array[bool_and(cuadra)::text, max(libro)::numeric(24,2)::text]
     from platform.book_ledger_reconciliation('aaaa0137-0000-4000-8000-0000000000a1',
            (select antes_desde from t), (select antes_hasta from t))
    where concepto = 'iva_debito_fiscal'),
  array['true', '16.00'], 'el mes del retiro cuadra: libro 16 = mayor 16');
select is(
  (select array[bool_and(cuadra)::text, max(libro)::numeric(24,2)::text,
                max(mayor)::numeric(24,2)::text, max(en_cola)::numeric(24,2)::text]
     from platform.book_ledger_reconciliation('aaaa0137-0000-4000-8000-0000000000a1',
            (select hoy_desde from t), (select hoy_hasta from t))
    where concepto = 'iva_debito_fiscal'),
  array['true', '-16.00', '-16.00', '0.00'],
  'el mes de la nota cuadra POR EL MAYOR: libro −16 = mayor −16, nada pendiente');
select is(
  (select array[bool_and(cuadra)::text, max(libro)::numeric(24,2)::text]
     from platform.book_ledger_reconciliation('aaaa0137-0000-4000-8000-0000000000a1',
            (select antes_desde from t), (select hoy_hasta from t))
    where concepto = 'iva_debito_fiscal'),
  array['true', '0.00'], 'y los dos meses juntos netean en cero');

-- ── Los invariantes que cruzan inventario, contabilidad y el documento ──────
select is(
  (select diferencia from platform.inventory_ledger_gap('aaaa0137-0000-4000-8000-0000000000a1')),
  0::numeric, 'inventory_ledger_gap: el kardex (100) es el saldo del mayor de inventario (100)');
select is(
  (select count(*)::int from platform.inventory_coverage_gaps(
     'aaaa0137-0000-4000-8000-0000000000a1')),
  0, 'inventory_coverage_gaps: los tres movimientos tienen su asiento');
select is(
  (select coalesce(string_agg(problem, ','), '') from platform.withdrawal_note_gaps(
     'aaaa0137-0000-4000-8000-0000000000a1')),
  '', 'withdrawal_note_gaps: el retiro corregido un mes después netea en cero, con su IVA en los dos asientos');

select * from finish();
rollback;
