-- =============================================================================
-- REGULARIZACIÓN DEL HISTÓRICO · ADR-0060 §6 y ADR-0061 §6
--
-- NO ES UNA MIGRACIÓN. Es un acto sobre los datos de UNA empresa, que se ejecuta
-- a mano (Management API) SOLO con el visto bueno del dueño sobre el ensayo en
-- seco, y DESPUÉS de aplicar las migraciones 56–59 y desplegar la API.
--
-- Uso: reemplazar :company_id y :posted_by (el usuario del dueño que firma) y
-- ejecutar TODO el archivo en una sola llamada: es una transacción. Si cualquier
-- comprobación falla, RAISE → ROLLBACK y no queda nada escrito.
--
-- Qué hace, en este orden:
--   1. MIDE el invariante kardex ↔ mayor y exige que esté en ROJO (una
--      regularización sobre un invariante verde es un diagnóstico equivocado);
--   2. REPONE las ventas anuladas antes de la migración 59 (entradas nuevas,
--      fechadas hoy, citando el documento): annulled_stock_gaps → 0;
--   3. ASIENTA la diferencia total kardex − mayor contra «ajuste de inventario»
--      (5.1.04, VALIDAR-CONTADOR), en la fecha REAL de ejecución;
--   4. RECLASIFICA de cash_bs a la cuenta contable de cada caja en divisa lo que
--      sus cobros, pagos, gastos y cierres dejaron en cash_bs;
--   5. escribe el CORTE (inventory_ledger_cutovers) con el detalle semilla/real;
--   6. deja el ACTA en audit_events;
--   7. MIDE otra vez y exige: brecha 0, annulled_stock_gaps 0, cobertura de
--      movimientos 0, balance de comprobación cuadrado, stock_reconciliation 0.
--
-- Cómo se revierte: con el contra-asiento de cada asiento de esta regularización
-- (reverseJournalEntry, desde /admin) — nada se borra; el corte y el acta quedan,
-- y un corte nuevo documenta la reversión. Las entradas de reposición (paso 2) no
-- se revierten: son hechos de kardex correctos (la venta está anulada).
-- =============================================================================

begin;

do $$
declare
  v_company   uuid := ':company_id';
  v_user      uuid := ':posted_by';
  v_tenant    uuid;
  v_moneda    text;
  v_hoy       date := (now() at time zone 'America/Caracas')::date;
  v_antes     record;
  v_despues   record;
  v_m         record;
  v_inv       uuid;
  v_ajuste    uuid;
  v_cash_bs   uuid;
  v_entry     uuid;
  v_periodo   uuid;
  v_n         integer := 0;
  v_repuesto  numeric := 0;
  v_reclas    jsonb := '[]'::jsonb;
  v_semilla   numeric;
  v_asiento_inv uuid;
begin
  select tenant_id, functional_currency_code into v_tenant, v_moneda
    from public.companies where id = v_company;
  if v_tenant is null then raise exception 'empresa inexistente'; end if;
  perform set_config('ladino.actor_id', v_user::text, true);
  perform set_config('ladino.rules_version', 'regularizacion-ola2', true);

  select account_id into v_inv from public.company_account_settings
   where company_id = v_company and purpose = 'inventory_general' and effective_to is null;
  select account_id into v_ajuste from public.company_account_settings
   where company_id = v_company and purpose = 'inventory_adjustment' and effective_to is null;
  select account_id into v_cash_bs from public.company_account_settings
   where company_id = v_company and purpose = 'cash_bs' and effective_to is null;
  if v_inv is null or v_ajuste is null or v_cash_bs is null then
    raise exception 'faltan las cuentas de inventario, ajuste o caja Bs: no se regulariza a ciegas';
  end if;

  -- 1. ANTES: tiene que estar en rojo.
  select * into v_antes from platform.inventory_ledger_gap(v_company);
  if v_antes.diferencia = 0 and not exists (select 1 from platform.annulled_stock_gaps(v_company)) then
    raise exception 'el invariante ya está en verde: no hay nada que regularizar (o el chequeo está mal)';
  end if;

  -- 2. Reponer las ventas anuladas sin reposición.
  for v_m in
    select m.warehouse_id, m.product_id, m.lot_id, -m.quantity as q, -m.functional_amount as v,
           m.source_document_id as doc
      from public.inventory_moves m
      join platform.annulled_stock_gaps(v_company) g on g.document_id = m.source_document_id
     where m.company_id = v_company and m.kind = 'salida'
  loop
    insert into public.inventory_moves
      (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id, unit_cost,
       occurred_at, note, source_document_id)
    values (v_tenant, v_company, v_m.warehouse_id, v_m.product_id, v_m.lot_id, 'entrada', v_m.q,
            v_m.v, v_moneda, 1, v_m.v, v_moneda, 'identidad', now(), 'inventory:cost:8:HALF_UP',
            round(v_m.v / v_m.q, 8), now(),
            'Regularización ADR-0061: reposición de una venta anulada antes de la migración 59',
            v_m.doc);
    v_repuesto := v_repuesto + v_m.v;
  end loop;

  -- 3. El asiento de inventario por la diferencia total, hoy.
  select * into v_antes from platform.inventory_ledger_gap(v_company);
  select platform.period_for_date(v_company, v_hoy) into v_periodo;
  if v_antes.diferencia <> 0 then
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, description, rules_version)
    values (v_tenant, v_company, v_periodo, v_hoy, 'manual',
            'Regularización ADR-0060: el mayor de inventario iguala al kardex (costo de ventas y entradas nunca asentados antes de la migración 58)',
            'regularizacion-ola2')
    returning id into v_entry;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values
      (v_tenant, v_company, v_entry, 1, v_inv,
       greatest(v_antes.diferencia, 0), greatest(-v_antes.diferencia, 0),
       abs(v_antes.diferencia), v_moneda, 1, abs(v_antes.diferencia), v_moneda, 'identidad', now(),
       greatest(v_antes.diferencia, 0), greatest(-v_antes.diferencia, 0), 'Inventario al valor del kardex'),
      (v_tenant, v_company, v_entry, 2, v_ajuste,
       greatest(-v_antes.diferencia, 0), greatest(v_antes.diferencia, 0),
       abs(v_antes.diferencia), v_moneda, 1, abs(v_antes.diferencia), v_moneda, 'identidad', now(),
       greatest(-v_antes.diferencia, 0), greatest(v_antes.diferencia, 0), 'Contrapartida: ajuste de inventario (VALIDAR-CONTADOR)');
    update public.journal_entries
       set status = 'posted', posted_at = now(), posted_by = v_user,
           entry_number = platform.claim_entry_number(v_company, extract(year from v_hoy)::int)
     where id = v_entry;
    v_asiento_inv := v_entry;
    v_n := v_n + 1;
  end if;

  -- 4. Reclasificar de cash_bs a la cuenta de cada caja en divisa.
  for v_m in
    select ca.id as cuenta, ca.name, ca.ledger_account_id as destino,
           sum(jl.functional_debit - jl.functional_credit) as neto
      from public.journal_entries e
      join public.journal_lines jl on jl.entry_id = e.id and jl.account_id = v_cash_bs
      join public.company_accounts ca
        on ca.id = platform.treasury_account_of(v_company, e.source_kind, e.source_id)
     where e.company_id = v_company and e.status in ('posted', 'reversed')
       and e.source_kind in ('payment_received', 'payment_made', 'expense', 'cash_closing')
       and ca.currency <> v_moneda and ca.ledger_account_id is not null
       and ca.ledger_account_id <> v_cash_bs
     group by ca.id, ca.name, ca.ledger_account_id
    having sum(jl.functional_debit - jl.functional_credit) <> 0
  loop
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, description, rules_version)
    values (v_tenant, v_company, v_periodo, v_hoy, 'manual',
            'Regularización ADR-0060 §4: lo que «' || v_m.name || '» dejó en caja Bs pasa a su cuenta contable',
            'regularizacion-ola2')
    returning id into v_entry;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values
      (v_tenant, v_company, v_entry, 1, v_m.destino,
       greatest(v_m.neto, 0), greatest(-v_m.neto, 0), abs(v_m.neto), v_moneda, 1, abs(v_m.neto),
       v_moneda, 'identidad', now(), greatest(v_m.neto, 0), greatest(-v_m.neto, 0),
       'La cuenta contable de la caja real'),
      (v_tenant, v_company, v_entry, 2, v_cash_bs,
       greatest(-v_m.neto, 0), greatest(v_m.neto, 0), abs(v_m.neto), v_moneda, 1, abs(v_m.neto),
       v_moneda, 'identidad', now(), greatest(-v_m.neto, 0), greatest(v_m.neto, 0),
       'Sale de caja y bancos en bolívares');
    update public.journal_entries
       set status = 'posted', posted_at = now(), posted_by = v_user,
           entry_number = platform.claim_entry_number(v_company, extract(year from v_hoy)::int)
     where id = v_entry;
    v_reclas := v_reclas || jsonb_build_object('caja', v_m.name, 'importe', v_m.neto, 'asiento', v_entry);
    v_n := v_n + 1;
  end loop;

  -- 5. El corte, con el detalle semilla/real del ensayo.
  select coalesce(sum(m.functional_amount), 0) into v_semilla
    from public.inventory_moves m
   where m.company_id = v_company
     and m.created_by in (select id from auth.users where email like 'seed-%@ladinosystem.com');
  insert into public.inventory_ledger_cutovers
    (tenant_id, company_id, cutover_at, journal_entry_id, kardex_value, ledger_balance, difference,
     detail, reason)
  values (v_tenant, v_company, now(), v_asiento_inv, v_antes.kardex, v_antes.mayor, v_antes.diferencia,
          jsonb_build_object('kardex_semilla', v_semilla, 'reposicion_anuladas', v_repuesto,
                             'reclasificaciones_caja', v_reclas),
          'Regularización del histórico ADR-0060/0061 con visto bueno del dueño sobre el ensayo en seco');

  -- 6. El acta.
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type, actor_type, occurred_at,
     rules_version, payload)
  values (v_tenant, v_company, 'company', v_company, 'accounting.history_regularized', 'user', now(),
          'regularizacion-ola2',
          jsonb_build_object('diferencia_inventario', v_antes.diferencia, 'reposicion_anuladas', v_repuesto,
                             'reclasificaciones_caja', v_reclas, 'asientos', v_n));

  -- 7. DESPUÉS: todo en verde, o nada.
  select * into v_despues from platform.inventory_ledger_gap(v_company);
  if v_despues.diferencia <> 0 then
    raise exception 'tras regularizar, kardex − mayor = % (debía ser 0): rollback', v_despues.diferencia;
  end if;
  if exists (select 1 from platform.annulled_stock_gaps(v_company)) then
    raise exception 'quedan ventas anuladas sin reponer: rollback';
  end if;
  if exists (select 1 from platform.inventory_coverage_gaps(v_company)) then
    raise exception 'quedan movimientos sin asiento después del corte: rollback';
  end if;
  if exists (select 1 from platform.stock_reconciliation(v_company)) then
    raise exception 'el kardex no reproduce los saldos: rollback';
  end if;
  if (select coalesce(sum(closing_balance), 0) from platform.trial_balance(v_company, v_hoy)) <> 0 then
    raise exception 'el balance de comprobación no cuadra: rollback';
  end if;
end $$;

commit;
