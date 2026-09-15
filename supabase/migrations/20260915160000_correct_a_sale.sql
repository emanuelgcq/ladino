-- =============================================================================
-- Ladino — migración 59 · CORREGIR UNA VENTA: anular repone, el recibo se
--                          devuelve y el dinero vuelve (ADR-0061)
--
-- Módulo: ventas · inventario · tesorería · contabilidad (RIGOR MÁXIMO)
-- Spec: ADR-0061 · ADR-0051 (notas y saldo a favor) · ADR-0060 (inventario en
-- el mayor, cuenta de caja real) · migración 37 (modo recibos)
-- HOMOLOGATION_IMPACT: NO. El documento nuevo no es fiscal y no entra a ningún
-- libro; la anulación de facturas se RESTRINGE (sin cobros), no se amplía.
--
-- EL DEFECTO. Anular no reponía existencia (la pantalla decía que sí); anulaba
-- recibos, notas y documentos con cobros; un recibo no tenía corrección posible
-- (sin devolución, sin notas); no existía reembolso de caja; y ningún invariante
-- decía «documento anulado ⇒ su kardex neto es cero».
--
-- LA DECISIÓN, en el esquema:
--   1. `documents.kind` gana 'receipt_return' (recibo de devolución, no fiscal):
--      solo puede corregir un RECIBO de la misma empresa (trigger LAD84), y
--      `sin_facturacion` lo admite. No es una nota de crédito porque el libro de
--      ventas selecciona credit_note: una nota contra un recibo entraría al libro
--      fiscal de una empresa que no factura;
--   2. `customer_refunds`: el dinero que sale de una caja para devolver un saldo a
--      favor. Append-only con backlink al asiento; baja el saldo de la cuenta;
--      el recómputo de saldos lo cuenta;
--   3. vocabulario contable: source_kind 'sales_receipt_return' y
--      'customer_refund' en sus tres casas; tres hechos nuevos del preset —el
--      recibo de devolución, el reembolso (contra la caja REAL, treasury_account)
--      y la reposición de la venta anulada (sales_cost / stock.received)—, con
--      eventos reales del outbox;
--   4. `treasury_account_of` resuelve la caja del reembolso;
--   5. `accounting_coverage_gaps` aprende el recibo de devolución y el reembolso;
--   6. `platform.annulled_stock_gaps(company)`: documentos anulados cuyos
--      movimientos de inventario no netean a cero, en cantidad ni en valor.
--
-- EXPAND/CONTRACT: aditiva. La API vieja no emite receipt_return ni reembolsos, y
-- sus anulaciones (sin reposición) aparecen en annulled_stock_gaps — que es la
-- verdad. Se aplica en la ventana del deploy con las 56–58.
--
-- REVERSIBILIDAD: el kind y los hechos nuevos se retiran con una migración
-- nueva mientras no haya documentos receipt_return ni reembolsos; con filas, NO
-- se revierte (son hechos de dinero append-only): se corrige con contra-asiento.
-- =============================================================================

-- ── 1. El recibo de devolución ──────────────────────────────────────────────
alter table public.documents drop constraint documents_kind_chk;
alter table public.documents add constraint documents_kind_chk
  check (kind in ('quote', 'order', 'invoice', 'credit_note', 'debit_note', 'receipt',
                  'receipt_return'));

update public.fiscal_regimes
   set allowed_kinds = array['receipt', 'receipt_return']
 where code = 'sin_facturacion';

create or replace function platform.assert_receipt_return_source()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.kind = 'receipt_return' and not exists (
       select 1 from public.documents o
        where o.id = new.source_document_id and o.company_id = new.company_id
          and o.kind = 'receipt') then
    raise exception
      'un recibo de devolución solo corrige un RECIBO de la misma empresa: una factura se corrige con nota de crédito'
      using errcode = 'LAD84';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_receipt_return_source() from public;
create trigger documents_05_receipt_return_source
  before insert or update of kind, source_document_id on public.documents
  for each row execute function platform.assert_receipt_return_source();

-- ── 2. El reembolso ─────────────────────────────────────────────────────────
create table public.customer_refunds (
  id                 uuid          primary key default platform.uuidv7(),
  tenant_id          uuid          not null,
  company_id         uuid          not null,
  customer_credit_id uuid          not null,
  account_id         uuid          not null,
  refunded_at        timestamptz   not null default now(),
  reason             text          not null,
  journal_entry_id   uuid,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'treasury:refund:8:HALF_UP',

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint customer_refunds_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint customer_refunds_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint customer_refunds_credit_fk
    foreign key (company_id, customer_credit_id) references public.customer_credits (company_id, id),
  constraint customer_refunds_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint customer_refunds_entry_fk
    foreign key (company_id, journal_entry_id) references public.journal_entries (company_id, id),
  constraint customer_refunds_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint customer_refunds_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint customer_refunds_amount_chk
    check (amount_transaction_currency > 0 and functional_amount > 0),
  constraint customer_refunds_reason_chk check (length(btrim(reason)) between 3 and 300),
  constraint customer_refunds_company_id_key unique (company_id, id)
);
create index customer_refunds_credit_idx on public.customer_refunds (customer_credit_id);
create index customer_refunds_account_idx on public.customer_refunds (account_id, refunded_at desc);

create function platform.assert_refund_backlink_only_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'journal_entry_id' - 'version')
     is distinct from (to_jsonb(new) - 'journal_entry_id' - 'version') then
    raise exception
      'un reembolso registrado no se edita: se corrige con un contra-asiento del contador'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_refund_backlink_only_update() from public;

create trigger customer_refunds_00_provenance
  before insert or update on public.customer_refunds
  for each row execute function platform.set_row_provenance();
create trigger customer_refunds_01_anchors
  before update on public.customer_refunds
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger customer_refunds_02_backlink_only
  before update on public.customer_refunds
  for each row execute function platform.assert_refund_backlink_only_update();
create trigger customer_refunds_no_delete
  before delete on public.customer_refunds
  for each row execute function platform.reject_mutation();
create trigger customer_refunds_no_truncate
  before truncate on public.customer_refunds
  for each statement execute function platform.reject_mutation();
create trigger customer_refunds_account_currency
  before insert or update on public.customer_refunds
  for each row execute function platform.assert_payment_account_currency();

create function platform.apply_refund_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform platform.bump_account_balance(new.account_id, -new.amount_transaction_currency);
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_refund_to_balance() from public;
create trigger customer_refunds_zz_balance
  after insert on public.customer_refunds
  for each row execute function platform.apply_refund_to_balance();

-- El recómputo del saldo aprende la fuente nueva: UNA definición de la verdad.
create or replace function platform.recompute_account_balance(p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(amount) from public.payments where account_id = p_account), 0)
       + coalesce((select sum(ip.amount)
                     from public.igtf_perceptions ip
                     join public.payments p on p.id = ip.payment_id
                    where p.account_id = p_account), 0)
       - coalesce((select sum(net_amount) from public.supplier_payments
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.expenses
                    where account_id = p_account), 0)
       + coalesce((select sum(amount_transaction_currency) from public.cash_closings
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.customer_refunds
                    where account_id = p_account), 0)
$$;
comment on function platform.recompute_account_balance(uuid) is
  'El saldo de una cuenta desde sus hechos: cobros + IGTF percibido − pagos a '
  'proveedor − gastos + cierres − reembolsos a clientes (migración 59).';

alter table public.customer_refunds enable row level security;
alter table public.customer_refunds force row level security;
create policy customer_refunds_select on public.customer_refunds for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy customer_refunds_insert on public.customer_refunds for insert to authenticated
  with check (false);
create policy customer_refunds_update on public.customer_refunds for update to authenticated
  using (false);
create policy customer_refunds_delete on public.customer_refunds for delete to authenticated
  using (false);
create policy customer_refunds_api_select on public.customer_refunds for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy customer_refunds_api_insert on public.customer_refunds for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy customer_refunds_api_update on public.customer_refunds for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy customer_refunds_api_delete on public.customer_refunds for delete to ladino_api
  using (false);
revoke all on public.customer_refunds from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.customer_refunds to authenticated;
grant select, insert, update on public.customer_refunds to ladino_api;

-- ── 3. Vocabulario contable y hechos del preset ─────────────────────────────
alter table public.journal_entries drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund'));
alter table public.journal_templates drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund'));
alter table public.journal_template_preset_entries drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund'));

do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_receipt_return', 'sales.receipt_return.issued',
          'Recibo de devolución: menos ingreso contra el saldo a favor del cliente — sin IVA, no es fiscal')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'income_general', 'total', 'debit', 'always',
     'El ingreso del recibo que se devuelve (el recibo no lleva impuesto)'),
    (v_entry, 2, 'customer_credit_liability', 'total', 'credit', 'always',
     'Queda como saldo a favor del cliente hasta que se aplique o se reembolse');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'customer_refund', 'ar.credit_refunded',
          'Reembolso de un saldo a favor: baja el pasivo con el cliente contra la caja de donde salió')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'customer_credit_liability', 'functional_amount', 'debit', 'always',
     'Se le deja de deber al cliente'),
    (v_entry, 2, 'treasury_account', 'functional_amount', 'credit', 'always',
     'Y el dinero sale de la caja donde se le devolvió');

  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_cost', 'stock.received',
          'Venta anulada: la mercancía vuelve al inventario al costo con que salió y el costo de ventas se revierte')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'inventory_general', 'functional_amount', 'debit', 'always',
     'Vuelve exactamente lo que salió'),
    (v_entry, 2, 'cogs_general', 'functional_amount', 'credit', 'always',
     'Y deja de ser costo de lo vendido');
end $$;

-- Las empresas que ya importaron el preset reciben los tres hechos (primera
-- vigencia desde siempre, ADR-0055). Ninguno toca plantillas existentes.
do $$
declare
  v_c record;
  v_e record;
  v_tpl uuid;
begin
  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico'
         and (e.source_kind, e.source_event) in (
               ('sales_receipt_return', 'sales.receipt_return.issued'),
               ('customer_refund', 'ar.credit_refunded'),
               ('sales_cost', 'stock.received'))
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
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20260915160000', 'preset_code', 've_basico',
                               'facts', 'sales_receipt_return, customer_refund, sales_cost/stock.received'));
  end loop;
end $$;

-- ── 4. La caja del reembolso ────────────────────────────────────────────────
create or replace function platform.treasury_account_of(
  p_company uuid, p_source_kind text, p_source_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case p_source_kind
    when 'payment_received' then
      (select p.account_id from public.payments p
        where p.id = p_source_id and p.company_id = p_company)
    when 'payment_made' then
      (select sp.account_id from public.supplier_payments sp
        where sp.id = p_source_id and sp.company_id = p_company)
    when 'expense' then
      (select e.account_id from public.expenses e
        where e.id = p_source_id and e.company_id = p_company)
    when 'cash_closing' then
      (select c.account_id from public.cash_closings c
        where c.id = p_source_id and c.company_id = p_company)
    when 'igtf_perception' then
      (select p.account_id from public.igtf_perceptions ip
         join public.payments p on p.id = ip.payment_id and p.company_id = ip.company_id
        where ip.id = p_source_id and ip.company_id = p_company)
    when 'customer_refund' then
      (select r.account_id from public.customer_refunds r
        where r.id = p_source_id and r.company_id = p_company)
    else null
  end
$$;

-- ── 5. La cobertura de documentos aprende los dos hechos nuevos ─────────────
create or replace function platform.accounting_coverage_gaps(p_company uuid)
returns table (source_kind text, source_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt' and d.status in ('issued', 'paid')
    union all
    select 'sales_credit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'credit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_debit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'debit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt_return', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt_return' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
    union all
    select 'customer_refund', r.id, r.journal_entry_id
      from public.customer_refunds r
     where r.company_id = p_company
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null as tiene_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as tiene_pendiente
      from documentos d
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
$$;

-- ── 6. El invariante de las ventas anuladas ─────────────────────────────────
create or replace function platform.annulled_stock_gaps(p_company uuid)
returns table (document_id uuid, kind text, quantity numeric, value numeric)
language sql
stable
set search_path = ''
as $$
  select d.id, d.kind, sum(m.quantity), sum(m.functional_amount)
    from public.documents d
    join public.inventory_moves m
      on m.company_id = d.company_id and m.source_document_id = d.id
   where d.company_id = p_company
     and d.status = 'annulled'
     and d.kind in ('invoice', 'receipt')
   group by d.id, d.kind
  having sum(m.quantity) <> 0 or sum(m.functional_amount) <> 0
$$;
comment on function platform.annulled_stock_gaps(uuid) is
  'INVARIANTE (ADR-0061 §6): documentos de venta ANULADOS cuyos movimientos de '
  'inventario no netean a cero —en cantidad o en valor—. Tiene que devolver cero '
  'filas: anular repone exactamente lo que salió, al costo con que salió.';
revoke execute on function platform.annulled_stock_gaps(uuid) from public;
grant execute on function platform.annulled_stock_gaps(uuid) to authenticated, ladino_api;

-- ── 7. Lo que esta migración garantiza sobre sí misma (LAD84) ───────────────
do $$
begin
  if not exists (select 1 from public.fiscal_regimes
                  where code = 'sin_facturacion'
                    and allowed_kinds = array['receipt', 'receipt_return']) then
    raise exception 'LAD84: sin_facturacion no admite el recibo de devolución' using errcode = 'LAD84';
  end if;
  if (select count(*) from public.journal_template_preset_entries
       where preset_code = 've_basico'
         and (source_kind, source_event) in (
               ('sales_receipt_return', 'sales.receipt_return.issued'),
               ('customer_refund', 'ar.credit_refunded'),
               ('sales_cost', 'stock.received'))) <> 3 then
    raise exception 'LAD84: faltan hechos de corrección de venta en el preset' using errcode = 'LAD84';
  end if;
end $$;
