-- =============================================================================
-- Ladino — migración 30 · FASE C: GASTOS — lo que se paga y no es mercancía
--
-- Módulo: gastos (RIGOR MÁXIMO: dinero + asiento)  Spec: Fase C partes 10 y 14
-- Reversible: NO una vez registrado el primer gasto.
-- Homologación: NO.
--
-- «Registrar gasto» en un paso: alquiler, luz, nómina, flete. NO pasa por el
-- flujo de compras (orden → recepción → factura): un gasto no entra al
-- inventario. Con los siete campos de ADR-0020, su cuenta de tesorería (el
-- dinero SALIÓ de algún sitio), su asiento contable —directo si los papeles
-- resuelven, a la cola de ADR-0042 si no— y su evento.
-- =============================================================================

-- ── 1. La tabla ─────────────────────────────────────────────────────────────
create table public.expenses (
  id          uuid        primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  branch_id   uuid,
  -- Categoría en vocabulario de persona. Texto con sugerencias, no un enum:
  -- «Alquiler», «Luz», «Nómina»… El contador puede mapear categorías a
  -- cuentas específicas más adelante; hoy todas van al gasto operativo.
  category    text        not null,
  description text,
  paid_at     timestamptz not null,
  account_id  uuid        not null,
  supplier_id uuid,
  is_recurring boolean    not null default false,
  attachment_path text,
  journal_entry_id uuid,

  -- Los SIETE campos de ADR-0020. La moneda de transacción es la de la
  -- CUENTA de la que salió el dinero (trigger compartido con payments).
  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'treasury:expense:8:HALF_UP',

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint expenses_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint expenses_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint expenses_branch_fk
    foreign key (company_id, branch_id) references public.branches (company_id, id),
  constraint expenses_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint expenses_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint expenses_entry_fk
    foreign key (company_id, journal_entry_id) references public.journal_entries (company_id, id),
  constraint expenses_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint expenses_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint expenses_category_chk
    check (category = btrim(category) and length(category) between 2 and 60),
  constraint expenses_amount_chk
    check (amount_transaction_currency > 0 and functional_amount > 0),
  constraint expenses_attachment_chk
    check (attachment_path is null
           or (attachment_path = btrim(attachment_path)
               and length(attachment_path) between 3 and 300)),
  constraint expenses_company_id_key unique (company_id, id)
);
create index expenses_period_idx on public.expenses (company_id, paid_at desc);

-- Un gasto es un HECHO: append-only, con la única corrección permitida del
-- backlink al asiento (la cola de ADR-0042 lo rellena al procesar) — el mismo
-- patrón que documents.journal_entry_id en la migración 26.
create function platform.assert_expense_backlink_only_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'journal_entry_id' - 'version')
     is distinct from (to_jsonb(new) - 'journal_entry_id' - 'version') then
    raise exception
      'un gasto registrado no se edita: se corrige con un contra-asiento del contador'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_expense_backlink_only_update() from public;

create trigger expenses_00_provenance
  before insert or update on public.expenses
  for each row execute function platform.set_row_provenance();
create trigger expenses_01_anchors
  before update on public.expenses
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger expenses_02_backlink_only
  before update on public.expenses
  for each row execute function platform.assert_expense_backlink_only_update();
create trigger expenses_no_delete
  before delete on public.expenses
  for each row execute function platform.reject_mutation();
create trigger expenses_no_truncate
  before truncate on public.expenses
  for each statement execute function platform.reject_mutation();
-- Moneda del gasto == moneda de la cuenta (lee transaction_currency).
create trigger expenses_account_currency
  before insert or update on public.expenses
  for each row execute function platform.assert_payment_account_currency();

-- ── 2. El saldo de la cuenta lo siente ──────────────────────────────────────
create function platform.apply_expense_to_balance()
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
revoke execute on function platform.apply_expense_to_balance() from public;
create trigger expenses_zz_balance
  after insert on public.expenses
  for each row execute function platform.apply_expense_to_balance();

-- Y el recómputo aprende la fuente nueva: UNA definición de la verdad.
create or replace function platform.recompute_account_balance(p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce((select sum(amount) from public.payments where account_id = p_account), 0)
       - coalesce((select sum(net_amount) from public.supplier_payments
                    where account_id = p_account), 0)
       - coalesce((select sum(amount_transaction_currency) from public.expenses
                    where account_id = p_account), 0)
$$;

-- ── 3. Contabilidad: papeles, plantilla y vocabulario ───────────────────────
insert into public.account_purposes (code, name, description) values
  ('operating_expense', 'Gastos operativos',
   'Alquiler, servicios, nómina y demás gastos registrados por la persona (Fase C).'),
  ('cash_over_short', 'Faltantes y sobrantes de caja',
   'La diferencia de un cierre de caja contra lo esperado (migración 31).')
on conflict (code) do nothing;

-- 5.1.04 ya es «Ajuste de inventario» (migración del generador): seguimos.
insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
values
  ('ve_basico', '5.1.05', 'Gastos operativos',              '5.1', 'gasto', 'deudora', true, 3,
   'operating_expense'),
  ('ve_basico', '5.1.06', 'Faltantes y sobrantes de caja',  '5.1', 'gasto', 'deudora', true, 3,
   'cash_over_short')
on conflict (template_code, code) do nothing;
-- Las empresas que YA importaron la plantilla no reciben estas cuentas por
-- arte de magia: su gasto cae a la cola de ADR-0042 hasta que el contador
-- cree la cuenta y asigne el papel en /admin. La cola es el diseño, no un
-- fallo.

-- El vocabulario de origen crece en sus TRES casas a la vez: asientos,
-- plantillas y preset. Si divergieran, una plantilla importada podría traer
-- una forma que journal_entries no admite.
alter table public.journal_entries drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing'));
alter table public.journal_templates drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing'));
alter table public.journal_template_preset_entries
  drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries
  add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing'));

-- Y el preset ve_basico aprende el gasto, con el MISMO caveat VALIDAR-CONTABLE
-- del preset entero. La pata de caja usa cash_bs igual que los pagos: el
-- asiento cuadra en moneda funcional; el contador que use cuentas separadas
-- por divisa ajusta su plantilla, como ya le pasa con los cobros.
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'expense', 'treasury.expense.registered',
          'Gasto operativo: gasto contra caja, a la tasa del día del pago')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'operating_expense', 'functional_amount', 'debit',  'always',
     'El gasto, convertido a la tasa del día en que se pagó'),
    (v_entry, 2, 'cash_bs',           'functional_amount', 'credit', 'always',
     'Lo que salió de la cuenta');
end $$;

-- El invariante de cobertura APRENDE los gastos: gasto registrado ⇒ asiento
-- o fila en cola. Mismo enunciado, familia más grande — nunca una lista de
-- perdones (CLAUDE.md §3).
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
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
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

-- ── 4. El bucket de recibos (guardado igual que el de fotos) ────────────────
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public)
    values ('receipts', 'receipts', false)
    on conflict (id) do nothing;
    if not exists (select 1 from pg_policies
                    where schemaname = 'storage' and tablename = 'objects'
                      and policyname = 'receipts_select') then
      execute $pol$
        create policy receipts_select on storage.objects for select to authenticated
          using (bucket_id = 'receipts'
                 and split_part(name, '/', 1) in
                     (select id::text from public.companies
                       where id in (select platform.ladino_company_ids())))
      $pol$;
    end if;
  end if;
end $$;

-- ── 5. RLS, grants y permisos ───────────────────────────────────────────────
alter table public.expenses enable row level security;
alter table public.expenses force row level security;
create policy expenses_select on public.expenses for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (false);
create policy expenses_update on public.expenses for update to authenticated
  using (false);
create policy expenses_delete on public.expenses for delete to authenticated
  using (false);
create policy expenses_api_select on public.expenses for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy expenses_api_insert on public.expenses for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy expenses_api_update on public.expenses for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy expenses_api_delete on public.expenses for delete to ladino_api
  using (false);

revoke all on public.expenses from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.expenses to authenticated;
grant select, insert, update on public.expenses to ladino_api;

insert into public.permissions (key, description, is_scoped) values
  ('expense.register', 'Registrar gastos del negocio', false),
  ('expense.read',     'Ver los gastos del negocio',   false)
on conflict (key) do nothing;

-- ── 6. Autochequeo ─────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.expenses) <> 0 then
    raise exception 'migración 30: expenses debe nacer vacía';
  end if;
  if not exists (select 1 from public.account_purposes where code = 'operating_expense') then
    raise exception 'migración 30: falta el papel operating_expense';
  end if;
  if (select count(*) from public.chart_template_accounts
       where template_code = 've_basico' and code in ('5.1.05', '5.1.06')) <> 2 then
    raise exception 'migración 30: faltan las cuentas 5.1.05/5.1.06 en ve_basico';
  end if;
  if not exists (select 1 from public.journal_template_preset_entries
                  where preset_code = 've_basico' and source_kind = 'expense') then
    raise exception 'migración 30: falta la entrada expense del preset ve_basico';
  end if;
end $$;
