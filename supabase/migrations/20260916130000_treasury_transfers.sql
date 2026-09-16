-- =============================================================================
-- Ladino — migración 61 · TRANSFERENCIA ENTRE CUENTAS (ADR-0062 §3)
--
-- QA de pantalla 2026-09-15, hallazgo 24: «Sin asignar — Por repartir» decía que
-- el dinero se reparte después, y no había con qué. `TREASURY_BANKING_SPEC.md`
-- exige la transferencia intercuenta desde el principio («crea dos patas») y no
-- existía: ni tabla, ni caso de uso, ni ruta. La única forma de mover dinero era
-- reasignar la cuenta de un cobro por SQL.
--
-- Lo que esta migración añade:
--   1. `treasury_transfers`: un hecho, dos patas sobre los saldos (−origen,
--      +destino), MISMA moneda, append-only salvo el backlink al asiento;
--   2. el saldo recomputado aprende la fuente nueva (una sola definición);
--   3. el papel `treasury_account_from` y `platform.treasury_from_account_of`:
--      el asiento de la transferencia resuelve SUS DOS cuentas desde las cajas
--      reales, como el resto de los hechos de dinero (ADR-0060 §4);
--   4. el hecho del preset y su plantilla, también para las empresas que ya lo
--      importaron (ADR-0055);
--   5. la cobertura contable lo vigila: transferencia ⇒ asiento o cola.
--
-- El CAMBIO DE MONEDA no es una transferencia (tiene tasa y diferencial): esta
-- migración exige que las dos cuentas vivan en la misma moneda.
--
-- Reversibilidad: `drop table public.treasury_transfers cascade`, restaurar las
-- dos funciones a su versión de la migración 59/56 y borrar el papel y el hecho
-- del preset. Nada de lo existente cambia de forma.
-- =============================================================================

-- ── 1. La tabla ─────────────────────────────────────────────────────────────
create table public.treasury_transfers (
  id               uuid        primary key default platform.uuidv7(),
  tenant_id        uuid        not null,
  company_id       uuid        not null,
  from_account_id  uuid        not null,
  to_account_id    uuid        not null,
  transferred_at   timestamptz not null default now(),
  reason           text        not null,
  journal_entry_id uuid,

  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'treasury:transfer:8:HALF_UP',

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint treasury_transfers_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint treasury_transfers_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint treasury_transfers_from_fk
    foreign key (company_id, from_account_id) references public.company_accounts (company_id, id),
  constraint treasury_transfers_to_fk
    foreign key (company_id, to_account_id) references public.company_accounts (company_id, id),
  constraint treasury_transfers_entry_fk
    foreign key (company_id, journal_entry_id) references public.journal_entries (company_id, id),
  constraint treasury_transfers_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint treasury_transfers_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint treasury_transfers_amount_chk
    check (amount_transaction_currency > 0 and functional_amount > 0),
  constraint treasury_transfers_distinct_chk check (from_account_id <> to_account_id),
  constraint treasury_transfers_reason_chk check (length(btrim(reason)) between 3 and 300),
  constraint treasury_transfers_company_id_key unique (company_id, id)
);
create index treasury_transfers_from_idx
  on public.treasury_transfers (from_account_id, transferred_at desc);
create index treasury_transfers_to_idx
  on public.treasury_transfers (to_account_id, transferred_at desc);
comment on table public.treasury_transfers is
  'Mover dinero entre dos cuentas de la MISMA empresa y la MISMA moneda: repartir lo que '
  'entró en «Sin asignar», pasar efectivo al banco, llevar de una caja a otra. ADR-0062 §3.';

-- Las dos cuentas, de esta empresa y en la moneda declarada: lo que el trigger
-- de los cobros hace con una, aquí con las dos.
create function platform.assert_transfer_accounts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_desde record;
  v_hasta record;
begin
  select company_id, currency, is_active into v_desde
    from public.company_accounts where id = new.from_account_id;
  select company_id, currency, is_active into v_hasta
    from public.company_accounts where id = new.to_account_id;
  if v_desde is null or v_hasta is null
     or v_desde.company_id <> new.company_id or v_hasta.company_id <> new.company_id then
    raise exception 'las dos cuentas de una transferencia son de la misma empresa'
      using errcode = 'LAD67';
  end if;
  if v_desde.currency <> new.transaction_currency or v_hasta.currency <> new.transaction_currency then
    raise exception
      'una transferencia mueve la MISMA moneda: % y % no coinciden con %',
      v_desde.currency, v_hasta.currency, new.transaction_currency
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_transfer_accounts() from public;

create function platform.assert_transfer_backlink_only_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'journal_entry_id' - 'version')
     is distinct from (to_jsonb(new) - 'journal_entry_id' - 'version') then
    raise exception
      'una transferencia registrada no se edita: se corrige con otra en sentido contrario'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_transfer_backlink_only_update() from public;

create trigger treasury_transfers_00_provenance
  before insert or update on public.treasury_transfers
  for each row execute function platform.set_row_provenance();
create trigger treasury_transfers_01_anchors
  before update on public.treasury_transfers
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger treasury_transfers_02_backlink_only
  before update on public.treasury_transfers
  for each row execute function platform.assert_transfer_backlink_only_update();
create trigger treasury_transfers_03_accounts
  before insert or update on public.treasury_transfers
  for each row execute function platform.assert_transfer_accounts();
create trigger treasury_transfers_no_delete
  before delete on public.treasury_transfers
  for each row execute function platform.reject_mutation();
create trigger treasury_transfers_no_truncate
  before truncate on public.treasury_transfers
  for each statement execute function platform.reject_mutation();

create function platform.apply_transfer_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform platform.bump_account_balance(new.from_account_id, -new.amount_transaction_currency);
    perform platform.bump_account_balance(new.to_account_id, new.amount_transaction_currency);
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_transfer_to_balance() from public;
create trigger treasury_transfers_zz_balance
  after insert on public.treasury_transfers
  for each row execute function platform.apply_transfer_to_balance();

-- ── 2. El saldo recomputado aprende las dos patas ───────────────────────────
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
       - coalesce((select sum(amount_transaction_currency) from public.treasury_transfers
                    where from_account_id = p_account), 0)
       + coalesce((select sum(amount_transaction_currency) from public.treasury_transfers
                    where to_account_id = p_account), 0)
$$;
comment on function platform.recompute_account_balance(uuid) is
  'El saldo de una cuenta desde sus hechos: cobros + IGTF percibido − pagos a '
  'proveedor − gastos + cierres − reembolsos ± transferencias (migración 61).';

-- ── 3. RLS y permisos, como el resto de los hechos de dinero ────────────────
alter table public.treasury_transfers enable row level security;
alter table public.treasury_transfers force row level security;
create policy treasury_transfers_select on public.treasury_transfers for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy treasury_transfers_insert on public.treasury_transfers for insert to authenticated
  with check (false);
create policy treasury_transfers_update on public.treasury_transfers for update to authenticated
  using (false);
create policy treasury_transfers_delete on public.treasury_transfers for delete to authenticated
  using (false);
create policy treasury_transfers_api_select on public.treasury_transfers for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy treasury_transfers_api_insert on public.treasury_transfers for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy treasury_transfers_api_update on public.treasury_transfers for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy treasury_transfers_api_delete on public.treasury_transfers for delete to ladino_api
  using (false);
revoke all on public.treasury_transfers from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.treasury_transfers to authenticated;
grant select, insert, update on public.treasury_transfers to ladino_api;

-- ── 4. El vocabulario contable del hecho nuevo ──────────────────────────────
alter table public.journal_entries drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund', 'treasury_transfer'));
alter table public.journal_templates drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund', 'treasury_transfer'));
alter table public.journal_template_preset_entries drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note', 'igtf_perception',
    'sales_cost', 'stock_opening', 'sales_return', 'purchase_revaluation',
    'sales_receipt_return', 'customer_refund', 'treasury_transfer'));

-- El papel de la caja de ORIGEN: como `treasury_account`, no es una cuenta fija.
alter table public.account_purposes drop constraint account_purposes_resolved_by_chk;
alter table public.account_purposes add constraint account_purposes_resolved_by_chk
  check (resolved_by in ('company_setting', 'treasury_account', 'treasury_account_from'));
insert into public.account_purposes (code, name, description, resolved_by) values
  ('treasury_account_from', 'Cuenta de tesorería de origen',
   'No es una cuenta fija: en una transferencia, la cuenta contable mapeada a la caja de donde SALE el dinero (company_accounts.ledger_account_id). ADR-0062 §3.',
   'treasury_account_from')
on conflict (code) do nothing;

create function platform.treasury_from_account_of(
  p_company uuid, p_source_kind text, p_source_id uuid
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select case p_source_kind
    when 'treasury_transfer' then
      (select t.from_account_id from public.treasury_transfers t
        where t.id = p_source_id and t.company_id = p_company)
    else null
  end
$$;
comment on function platform.treasury_from_account_of(uuid, text, uuid) is
  'La caja de ORIGEN de un hecho que mueve dinero entre dos cuentas. Hoy solo la transferencia.';
revoke execute on function platform.treasury_from_account_of(uuid, text, uuid) from public;
grant execute on function platform.treasury_from_account_of(uuid, text, uuid)
  to ladino_api, ladino_worker;

-- La caja de DESTINO de la transferencia entra en la definición única.
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
    when 'treasury_transfer' then
      (select t.to_account_id from public.treasury_transfers t
        where t.id = p_source_id and t.company_id = p_company)
    else null
  end
$$;

-- ── 5. El hecho del preset, y las empresas que ya lo importaron ─────────────
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'treasury_transfer', 'treasury.transfer.registered',
          'Transferencia entre cuentas: entra en la caja de destino y sale de la de origen')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'treasury_account', 'functional_amount', 'debit', 'always',
     'La cuenta contable de la caja a donde llega el dinero'),
    (v_entry, 2, 'treasury_account_from', 'functional_amount', 'credit', 'always',
     'Y la de la caja de donde sale');
end $$;

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
         and e.source_kind = 'treasury_transfer'
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
            jsonb_build_object('origin', 'migration_20260916130000', 'preset_code', 've_basico',
                               'facts', 'treasury_transfer'));
  end loop;
end $$;

-- ── 6. La cobertura contable vigila también la transferencia ────────────────
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
    union all
    select 'treasury_transfer', t.id, t.journal_entry_id
      from public.treasury_transfers t
     where t.company_id = p_company
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
