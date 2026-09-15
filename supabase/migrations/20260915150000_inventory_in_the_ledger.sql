-- =============================================================================
-- Ladino — migración 58 · EL INVENTARIO EN EL MAYOR: costo de ventas, entradas
--                          que asientan e invariante kardex ↔ mayor (ADR-0060)
--
-- Módulo: contabilidad · inventario · ventas · compras (RIGOR MÁXIMO)
-- Spec: ADR-0060 §1, §2, §5 · ADR-0041 · ADR-0042 · ADR-0055
-- HOMOLOGATION_IMPACT: NO (no cambia emisión, numeración ni libros de IVA).
--
-- EL DEFECTO. Ninguna venta asentaba su costo; ninguna entrada de mercancía
-- asentaba (recepción de compra, existencia inicial, devolución); la factura de
-- proveedor debitaba el inventario sin que el kardex se moviera. El valor del
-- kardex y el saldo de «Inventario» vivían separados, y nadie los comparaba:
-- `accounting_coverage_gaps` pregunta por DOCUMENTOS, no por movimientos.
--
-- LA DECISIÓN, en el esquema:
--   1. papeles nuevos: mercancía recibida por facturar (puente de la compra),
--      aportes en inventario (existencia inicial y entradas sin compra) y
--      variación de costo de compras (lo facturado distinto de lo recibido,
--      por las unidades que ya salieron). Cuentas nuevas en ve_basico y en los
--      planes YA importados de cada empresa, con su papel;
--   2. dos fuentes de importe nuevas para la revalorización de la factura;
--   3. seis hechos nuevos en el preset, con los eventos REALES del outbox
--      (`stock.shipped`, `stock.received`, `ap.invoice_posted`: EVENT_CATALOG.md
--      reserva stock.* «para el COGS») y el ORIGEN en source_kind, que es esa
--      dimensión: sales_cost (venta y receta), inventory_move (salida directa),
--      stock_opening (entrada sin compra), goods_receipt (recepción de compra),
--      sales_return (devolución) y purchase_revaluation (factura distinta de lo
--      recibido). Cuatro source_kind nuevos en sus tres casas. La factura de
--      compra debita la cuenta PUENTE en vez del inventario. Las empresas que
--      ya importaron el preset reciben los hechos nuevos (primera vigencia desde
--      siempre, ADR-0055) y una VERSIÓN NUEVA de su plantilla de compra desde
--      ahora; lo anterior no se edita;
--   4. `platform.inventory_ledger_gap(company)`: el invariante nuevo, ESTRICTO —
--      valor del kardex − saldo del mayor en las cuentas de inventario. Tiene que
--      dar cero. Un hecho encolado lo pone en rojo, y es verdad: mientras está en
--      cola el mayor no sabe de esa mercancía (la columna en_cola lo explica);
--   5. `platform.inventory_coverage_gaps(company)`: todo movimiento que cambia el
--      valor del inventario de la empresa (entrada, salida, ajuste, revaluación)
--      tiene asiento o fila en cola — posterior al CORTE de la empresa, si lo hay;
--   6. `public.inventory_ledger_cutovers`: el acta del corte con que se regulariza
--      el histórico (ADR-0060 §6). Insert-only. Nace vacía: la regularización es
--      un acto aparte, con ensayo en seco y visto bueno del dueño.
--
-- EXPAND/CONTRACT (ADR-0057). La plantilla de compra nueva debita la cuenta
-- puente: con la API vieja, la recepción no asienta y la factura sí → el puente
-- queda con saldo hasta el deploy. Se aplica en la MISMA ventana que la API.
--
-- REVERSIBILIDAD:
--   · funciones y tabla de cortes (vacía): drop;
--   · cuentas y papeles nuevos: se desactivan; con asientos ya generados sobre
--     ellas NO se borran (tienen historia) — se reclasifica con contra-asiento;
--   · plantillas: nueva versión con el mapeo anterior. Los asientos ya generados
--     (costo de ventas, entradas) no se reescriben: se reversan uno a uno con
--     `reverseJournalEntry` si hiciera falta.
-- =============================================================================

-- ── 1. Papeles ──────────────────────────────────────────────────────────────
insert into public.account_purposes (code, name, description) values
  ('goods_received_not_invoiced', 'Mercancía recibida por facturar',
   'Puente de la compra: la recepción lo acredita por lo que entró al kardex y la factura del proveedor lo debita. VALIDAR-CONTABLE.'),
  ('opening_equity', 'Aportes en inventario',
   'Contrapartida de la existencia que entra sin compra: el inventario inicial del alta y las entradas directas. VALIDAR-CONTABLE.'),
  ('purchase_cost_variance', 'Variación de costo de compras',
   'Diferencia entre lo facturado por el proveedor y lo recibido, en la parte de unidades que ya salieron del inventario. VALIDAR-CONTABLE.')
on conflict (code) do nothing;

insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '2.1.07', 'Mercancía recibida por facturar', '2.1', 'pasivo', 'acreedora', true, 3,
   'goods_received_not_invoiced'),
  ('ve_basico', '3.1.04', 'Aportes en inventario', '3.1', 'patrimonio', 'acreedora', true, 3,
   'opening_equity'),
  ('ve_basico', '5.1.07', 'Variación de costo de compras', '5.1', 'gasto', 'deudora', true, 3,
   'purchase_cost_variance')
on conflict (template_code, code) do nothing;

-- ── 2. Fuentes de importe nuevas (vocabulario cerrado, las DOS tablas) ──────
alter table public.journal_template_lines drop constraint journal_template_lines_amount_chk;
alter table public.journal_template_lines add constraint journal_template_lines_amount_chk
  check (amount_source in (
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr',
    'retained_total', 'net_amount', 'cost_amount', 'landed_to_inventory',
    'landed_to_variance', 'exchange_difference', 'functional_amount',
    'revaluation_to_inventory', 'revaluation_to_variance'));
alter table public.journal_template_preset_lines drop constraint journal_template_preset_lines_amount_chk;
alter table public.journal_template_preset_lines add constraint journal_template_preset_lines_amount_chk
  check (amount_source in (
    'subtotal', 'tax_amount', 'total', 'retained_iva', 'retained_islr',
    'retained_total', 'net_amount', 'cost_amount', 'landed_to_inventory',
    'landed_to_variance', 'exchange_difference', 'functional_amount',
    'revaluation_to_inventory', 'revaluation_to_variance'));

-- ── 2b. Los orígenes nuevos, en las TRES casas del vocabulario ───────────────
-- Se copia la lista VIGENTE (migración 46) y se añade lo nuevo: reconstruir un
-- CHECK desde una copia incompleta borra vocabulario en silencio (migración 37).
alter table public.journal_entries drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation'));
alter table public.journal_templates drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation'));
alter table public.journal_template_preset_entries drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation'));

-- ── 3. Los hechos nuevos del preset ─────────────────────────────────────────
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_cost', 'stock.shipped',
          'Costo de lo vendido: sale del inventario al costo con que salió del kardex')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'cogs_general', 'cost_amount', 'debit', 'always',
     'El costo de la mercancía vendida, exactamente el que registró el kardex'),
    (v_entry, 2, 'inventory_general', 'cost_amount', 'credit', 'always',
     'Y sale del inventario por el mismo importe');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'stock_opening', 'stock.received',
          'Entrada sin compra (inventario inicial, entrada directa): inventario contra aportes')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'functional_amount', 'debit', 'always',
     'Entra valor al inventario, al costo declarado'),
    (v_entry, 2, 'opening_equity', 'functional_amount', 'credit', 'always',
     'Contra los aportes en inventario: no hubo compra que lo pague');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'goods_receipt', 'stock.received',
          'Recepción de compra: inventario contra mercancía recibida por facturar')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'functional_amount', 'debit', 'always',
     'Lo que entró al kardex, a la tasa de la recepción'),
    (v_entry, 2, 'goods_received_not_invoiced', 'functional_amount', 'credit', 'always',
     'Se le deberá al proveedor cuando facture: mientras, es mercancía recibida por facturar');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_return', 'stock.received',
          'Devolución de venta: la mercancía vuelve al inventario y el costo de ventas se revierte')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'functional_amount', 'debit', 'always',
     'Vuelve al inventario al costo con que había salido'),
    (v_entry, 2, 'cogs_general', 'functional_amount', 'credit', 'always',
     'Y deja de ser costo de lo vendido');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'inventory_move', 'stock.shipped',
          'Salida directa (consumo interno, merma sin ajuste): ajuste de inventario contra inventario')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_adjustment', 'functional_amount', 'debit', 'if_negative',
     'Lo que salió es gasto del período'),
    (v_entry, 2, 'inventory_general', 'functional_amount', 'credit', 'if_negative',
     'y sale del inventario');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'purchase_revaluation', 'ap.invoice_posted',
          'Factura de proveedor distinta de lo recibido: revaloriza lo que queda y lleva a variación lo ya vendido')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'revaluation_to_inventory', 'debit', 'if_positive',
     'Se facturó más de lo recibido: sube el valor de lo que queda'),
    (v_entry, 2, 'inventory_general', 'revaluation_to_inventory', 'credit', 'if_negative',
     'Se facturó menos: baja el valor de lo que queda'),
    (v_entry, 3, 'purchase_cost_variance', 'revaluation_to_variance', 'debit', 'if_positive',
     'La parte de unidades ya vendidas es variación del período'),
    (v_entry, 4, 'purchase_cost_variance', 'revaluation_to_variance', 'credit', 'if_negative',
     'La parte de unidades ya vendidas es variación del período'),
    (v_entry, 5, 'goods_received_not_invoiced', 'functional_amount', 'credit', 'if_positive',
     'Contra el puente, que ya recibió la factura por su importe completo'),
    (v_entry, 6, 'goods_received_not_invoiced', 'functional_amount', 'debit', 'if_negative',
     'Contra el puente, que ya recibió la factura por su importe completo');

  -- La factura de compra debita el PUENTE, no el inventario: el inventario solo
  -- se mueve con el kardex (recepción, revalorización).
  update public.journal_template_preset_lines l
     set account_purpose = 'goods_received_not_invoiced',
         description = l.description || ' (contra la mercancía recibida por facturar)'
    from public.journal_template_preset_entries e
   where e.id = l.entry_id and e.preset_code = 've_basico'
     and e.source_kind = 'purchase_invoice' and l.account_purpose = 'inventory_general';
end $$;

-- ── 4. Las empresas que YA tienen plan y preset ─────────────────────────────
do $$
declare
  v_c record;
  v_n record;
  v_padre uuid;
  v_cuenta uuid;
  v_ahora timestamptz := now();
  v_t record;
  v_nueva uuid;
  v_e record;
  v_tpl uuid;
begin
  -- 4a. Cuentas y papeles nuevos en los planes ya importados.
  for v_c in
    select distinct s.company_id, s.tenant_id
      from public.company_account_settings s
     where s.purpose = 'inventory_general'
  loop
    for v_n in
      select a.code, a.name, a.parent_code, a.kind, a.nature, a.suggested_purpose
        from public.chart_template_accounts a
       where a.template_code = 've_basico'
         and a.suggested_purpose in ('goods_received_not_invoiced', 'opening_equity',
                                     'purchase_cost_variance')
    loop
      continue when exists (select 1 from public.company_account_settings s
                             where s.company_id = v_c.company_id
                               and s.purpose = v_n.suggested_purpose);
      select id into v_padre from public.accounts
       where company_id = v_c.company_id and code = v_n.parent_code;
      continue when v_padre is null
                 or exists (select 1 from public.accounts
                             where company_id = v_c.company_id and code = v_n.code);
      insert into public.accounts
        (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
      values (v_c.tenant_id, v_c.company_id, v_n.code, v_n.name, v_padre, v_n.kind, v_n.nature,
              'db-migration')
      returning id into v_cuenta;
      insert into public.company_account_settings
        (tenant_id, company_id, purpose, account_id, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_n.suggested_purpose, v_cuenta, '-infinity');
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.account_added', 'system', v_ahora, 'db-migration',
              jsonb_build_object('origin', 'migration_20260915150000', 'code', v_n.code,
                                 'purpose', v_n.suggested_purpose, 'account_id', v_cuenta));
    end loop;
  end loop;

  -- 4b. Versión nueva de la plantilla de compra que debita el inventario.
  for v_t in
    select t.id, t.tenant_id, t.company_id, t.source_kind, t.source_event, t.description
      from public.journal_templates t
     where t.is_active and t.effective_to is null and t.source_kind = 'purchase_invoice'
       and exists (select 1 from public.journal_template_lines l
                    where l.template_id = t.id and l.account_purpose = 'inventory_general')
  loop
    update public.journal_templates set effective_to = v_ahora where id = v_t.id;
    insert into public.journal_templates
      (tenant_id, company_id, source_kind, source_event, description, effective_from)
    values (v_t.tenant_id, v_t.company_id, v_t.source_kind, v_t.source_event, v_t.description, v_ahora)
    returning id into v_nueva;
    insert into public.journal_template_lines
      (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
       side, condition_kind, description)
    select l.tenant_id, l.company_id, v_nueva, l.line_number,
           case when l.account_purpose = 'inventory_general' then 'goods_received_not_invoiced'
                else l.account_purpose end,
           l.amount_source, l.side, l.condition_kind, l.description
      from public.journal_template_lines l where l.template_id = v_t.id order by l.line_number;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.template_versioned', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20260915150000',
                               'source_kind', v_t.source_kind, 'source_event', v_t.source_event,
                               'previous_template_id', v_t.id, 'new_template_id', v_nueva,
                               'motivo', 'La factura de compra debita la mercancía recibida por facturar; el inventario solo se mueve con el kardex (ADR-0060 §2).'));
  end loop;

  -- 4c. Los hechos de inventario nuevos, para quien ya importó el preset.
  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico'
         and (e.source_kind, e.source_event) in (
               ('sales_cost', 'stock.shipped'), ('inventory_move', 'stock.shipped'),
               ('stock_opening', 'stock.received'), ('goods_receipt', 'stock.received'),
               ('sales_return', 'stock.received'), ('purchase_revaluation', 'ap.invoice_posted'))
    loop
      continue when exists (select 1 from public.journal_templates t
                             where t.company_id = v_c.company_id
                               and t.source_kind = v_e.source_kind
                               and t.source_event = v_e.source_event);
      insert into public.journal_templates
        (tenant_id, company_id, source_kind, source_event, description, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_e.source_kind, v_e.source_event, v_e.description,
              '-infinity')
      returning id into v_tpl;
      insert into public.journal_template_lines
        (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
         side, condition_kind, description)
      select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
             l.amount_source, l.side, l.condition_kind, l.description
        from public.journal_template_preset_lines l where l.entry_id = v_e.id order by l.line_number;
    end loop;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', v_ahora, 'db-migration',
            jsonb_build_object('origin', 'migration_20260915150000', 'preset_code', 've_basico',
                               'facts', 'sales_cost, inventory_move/stock.shipped, stock_opening, goods_receipt, sales_return, purchase_revaluation'));
  end loop;
end $$;

-- ── 5. El acta del corte (vacía hasta la regularización) ────────────────────
create table public.inventory_ledger_cutovers (
  id               uuid          primary key default platform.uuidv7(),
  tenant_id        uuid          not null,
  company_id       uuid          not null,
  -- Desde este instante, todo movimiento de valor tiene asiento o cola. Lo
  -- anterior lo cubre el asiento de regularización.
  cutover_at       timestamptz   not null,
  journal_entry_id uuid,
  kardex_value     numeric(24,8) not null,
  ledger_balance   numeric(24,8) not null,
  difference       numeric(24,8) not null,
  -- El informe del ensayo en seco, congelado: qué parte venía de la semilla.
  detail           jsonb         not null default '{}'::jsonb,
  reason           text          not null,

  created_by       uuid,
  created_at       timestamptz   not null,
  version          integer       not null,

  constraint ilc_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint ilc_company_fk foreign key (tenant_id, company_id)
    references public.companies (tenant_id, id),
  constraint ilc_entry_fk foreign key (company_id, journal_entry_id)
    references public.journal_entries (company_id, id),
  constraint ilc_difference_chk check (difference = kardex_value - ledger_balance),
  constraint ilc_reason_chk check (length(btrim(reason)) between 10 and 500)
);
create index ilc_company_idx on public.inventory_ledger_cutovers (company_id, cutover_at desc);
create trigger inventory_ledger_cutovers_00_provenance
  before insert or update on public.inventory_ledger_cutovers
  for each row execute function platform.set_row_provenance();
create trigger inventory_ledger_cutovers_01_anchors
  before update on public.inventory_ledger_cutovers
  for each row execute function platform.assert_isolation_anchors_immutable();
create function platform.assert_inventory_ledger_cutover_immutable()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'inventory_ledger_cutovers es insert-only: un corte no se edita — se revierte con el contra-asiento y un corte nuevo';
end $$;
revoke execute on function platform.assert_inventory_ledger_cutover_immutable() from public;
create trigger inventory_ledger_cutovers_02_append_only
  before update or delete on public.inventory_ledger_cutovers
  for each row execute function platform.assert_inventory_ledger_cutover_immutable();
alter table public.inventory_ledger_cutovers enable row level security;
alter table public.inventory_ledger_cutovers force row level security;
revoke all on public.inventory_ledger_cutovers from anon, authenticated, service_role;
grant select on public.inventory_ledger_cutovers to ladino_api;
create policy ilc_api_select on public.inventory_ledger_cutovers
  for select to ladino_api using (true);

-- ── 6. El invariante: kardex ↔ mayor de inventario ──────────────────────────
create or replace function platform.inventory_ledger_gap(p_company uuid)
returns table (kardex numeric, mayor numeric, diferencia numeric, en_cola numeric)
language sql
stable
set search_path = ''
as $$
  with cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'inventory_general'
  ),
  k as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m where m.company_id = p_company
  ),
  l as (
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
     where jl.company_id = p_company
       and jl.account_id in (select account_id from cuentas)
       and e.status in ('posted', 'reversed')
  ),
  q as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m
     where m.company_id = p_company
       and exists (select 1 from public.journal_generation_queue jq
                    where jq.company_id = p_company and jq.status = 'pending'
                      and jq.source_kind in ('inventory_move', 'landed_cost', 'sales_cost', 'stock_opening',
                                           'goods_receipt', 'sales_return', 'purchase_revaluation')
                      and jq.source_id in (m.id, m.source_document_id))
  )
  select k.v, l.v, k.v - l.v, q.v from k, l, q
$$;
comment on function platform.inventory_ledger_gap(uuid) is
  'INVARIANTE (ADR-0060 §5): valor del kardex − saldo del mayor en las cuentas de '
  'inventario. diferencia TIENE que ser 0. en_cola dice cuánto de la diferencia son '
  'movimientos cuyo asiento está pendiente. Existe porque accounting_coverage_gaps '
  'vigila documentos y no movimientos: ese punto ciego dejó pasar el costo de ventas.';
revoke execute on function platform.inventory_ledger_gap(uuid) from public;
grant execute on function platform.inventory_ledger_gap(uuid) to authenticated, ladino_api;

-- ── 7. Cobertura de movimientos ─────────────────────────────────────────────
create or replace function platform.inventory_coverage_gaps(p_company uuid)
returns table (move_id uuid, kind text, problem text)
language sql
stable
set search_path = ''
as $$
  with corte as (
    select max(c.cutover_at) as t from public.inventory_ledger_cutovers c
     where c.company_id = p_company
  ),
  movs as (
    select m.id, m.kind, m.source_document_id
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and m.kind in ('entrada', 'salida', 'ajuste', 'revaluacion')
       and m.functional_amount <> 0
       and (corte.t is null or m.created_at > corte.t)
  ),
  estado as (
    select mv.id, mv.kind,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and e.source_kind in ('inventory_move', 'landed_cost', 'sales_cost', 'stock_opening',
                                           'goods_receipt', 'sales_return', 'purchase_revaluation')
                      and e.source_id in (mv.id, mv.source_document_id)) as asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost', 'stock_opening',
                                           'goods_receipt', 'sales_return', 'purchase_revaluation')
                      and q.source_id in (mv.id, mv.source_document_id)) as cola
      from movs mv
  )
  select id, kind, case when not asiento and not cola then 'missing' else 'duplicated' end
    from estado
   where (not asiento and not cola) or (asiento and cola)
$$;
comment on function platform.inventory_coverage_gaps(uuid) is
  'Todo movimiento que cambia el valor del inventario de la empresa (entrada, salida, '
  'ajuste, revaluación) posterior al corte tiene asiento O fila pendiente, nunca '
  'ninguno y nunca los dos. Transferencias fuera por definición: no cambian el valor '
  'de la empresa. ADR-0060 §5.';
revoke execute on function platform.inventory_coverage_gaps(uuid) from public;
grant execute on function platform.inventory_coverage_gaps(uuid) to authenticated, ladino_api;

-- ── 8. Lo que esta migración garantiza sobre sí misma (LAD83) ───────────────
-- El `on conflict do nothing` del plan de cuentas descarta EN SILENCIO una
-- cuenta cuyo código ya existe (el primer borrador usó 5.1.05, que es «Gastos
-- operativos», y el papel quedó sin cuenta: lo cazó e2e-accounting-hooks). Que
-- falle aquí, no al primer asiento.
do $$
begin
  if exists (
    select 1 from unnest(array['goods_received_not_invoiced', 'opening_equity',
                               'purchase_cost_variance']) as p(code)
     where not exists (select 1 from public.chart_template_accounts a
                        where a.template_code = 've_basico' and a.suggested_purpose = p.code)) then
    raise exception 'LAD83: un papel nuevo de inventario no tiene cuenta en el plan ve_basico'
      using errcode = 'LAD83';
  end if;
  if exists (
    select 1 from public.journal_template_preset_lines l
      join public.journal_template_preset_entries e on e.id = l.entry_id
     where e.preset_code = 've_basico' and e.source_kind = 'purchase_invoice'
       and l.account_purpose = 'inventory_general') then
    raise exception 'LAD83: la factura de compra del preset todavía debita el inventario'
      using errcode = 'LAD83';
  end if;
  if (select count(*) from public.journal_template_preset_entries
       where preset_code = 've_basico'
         and (source_kind, source_event) in (
               ('sales_cost', 'stock.shipped'), ('inventory_move', 'stock.shipped'),
               ('stock_opening', 'stock.received'), ('goods_receipt', 'stock.received'),
               ('sales_return', 'stock.received'), ('purchase_revaluation', 'ap.invoice_posted'))) <> 6 then
    raise exception 'LAD83: faltan hechos de inventario en el preset ve_basico'
      using errcode = 'LAD83';
  end if;
end $$;
