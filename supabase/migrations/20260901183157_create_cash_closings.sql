-- =============================================================================
-- Ladino — migración 31 · FASE C: CIERRE DE CAJA — contar y cuadrar el día
--
-- Módulo: tesorería (RIGOR MÁXIMO: dinero + asiento)  Spec: Fase C partes 9 y 14
-- Reversible: NO una vez registrado el primer cierre.
-- Homologación: NO.
--
-- «Cerrar la caja»: el sistema dice cuánto DEBERÍA haber (el saldo
-- materializado en ese momento), la persona dice cuánto HAY, y la diferencia
-- —si la hay— queda registrada con su motivo, ajusta el saldo para que mañana
-- arranque en lo contado, y va a contabilidad como faltante o sobrante.
-- Un cierre no se edita: si se contó mal, se cierra otra vez y el nuevo cierre
-- corrige al anterior por construcción (su esperado ya incluye el ajuste).
-- =============================================================================

-- ── 1. La tabla ─────────────────────────────────────────────────────────────
create table public.cash_closings (
  id           uuid        primary key default platform.uuidv7(),
  tenant_id    uuid        not null,
  company_id   uuid        not null,
  branch_id    uuid,
  account_id   uuid        not null,
  -- El DÍA que se cierra, como date: el cierre es un acto de calendario del
  -- negocio, no un instante técnico. `closed_at` es el momento real del conteo.
  closing_date date        not null,
  closed_at    timestamptz not null,
  -- Lo que el sistema esperaba (foto del saldo materializado al cerrar), lo
  -- que la persona contó, y la diferencia que separa ambos.
  expected_amount numeric(24,8) not null,
  counted_amount  numeric(24,8) not null,
  reason       text,
  journal_entry_id uuid,

  -- Los SIETE campos de ADR-0020 sobre el hecho monetario del cierre: la
  -- DIFERENCIA (con signo; puede ser cero). Positiva = sobrante.
  amount_transaction_currency numeric(24,8) not null,
  transaction_currency        text          not null,
  fx_rate                     numeric(24,8) not null default 1,
  functional_amount           numeric(24,8) not null,
  functional_currency         text          not null,
  rate_source                 text          not null default 'identidad',
  rate_timestamp              timestamptz   not null default now(),
  rounding_policy_id          text          not null default 'treasury:cash_closing:8:HALF_UP',

  created_by   uuid,
  created_at   timestamptz not null,
  version      integer     not null,

  constraint cash_closings_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint cash_closings_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint cash_closings_branch_fk
    foreign key (company_id, branch_id) references public.branches (company_id, id),
  constraint cash_closings_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint cash_closings_entry_fk
    foreign key (company_id, journal_entry_id) references public.journal_entries (company_id, id),
  constraint cash_closings_txn_currency_fk
    foreign key (transaction_currency) references public.currencies (code),
  constraint cash_closings_functional_currency_fk
    foreign key (functional_currency) references public.currencies (code),
  constraint cash_closings_counted_chk check (counted_amount >= 0),
  -- La diferencia no es un campo libre: ES contado menos esperado, siempre.
  constraint cash_closings_difference_chk
    check (amount_transaction_currency = counted_amount - expected_amount),
  -- Y la conversión no cambia el signo del hecho.
  constraint cash_closings_functional_sign_chk
    check (sign(functional_amount) = sign(amount_transaction_currency)),
  constraint cash_closings_fx_chk check (fx_rate > 0),
  -- Una diferencia sin motivo es un número que nadie sabrá explicar mañana.
  constraint cash_closings_reason_chk
    check (amount_transaction_currency = 0
           or length(btrim(coalesce(reason, ''))) between 3 and 300),
  constraint cash_closings_company_id_key unique (company_id, id)
);
create index cash_closings_period_idx on public.cash_closings (company_id, closing_date desc);
create index cash_closings_account_idx on public.cash_closings (account_id, closing_date desc);

-- Append-only con la única corrección del backlink al asiento (mismo patrón
-- que expenses en la migración 30 y documents en la 26).
create function platform.assert_cash_closing_backlink_only_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'journal_entry_id' - 'version')
     is distinct from (to_jsonb(new) - 'journal_entry_id' - 'version') then
    raise exception
      'un cierre de caja no se edita: si se contó mal, se cierra de nuevo y el nuevo cierre corrige'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_cash_closing_backlink_only_update() from public;

create trigger cash_closings_00_provenance
  before insert or update on public.cash_closings
  for each row execute function platform.set_row_provenance();
create trigger cash_closings_01_anchors
  before update on public.cash_closings
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger cash_closings_02_backlink_only
  before update on public.cash_closings
  for each row execute function platform.assert_cash_closing_backlink_only_update();
create trigger cash_closings_no_delete
  before delete on public.cash_closings
  for each row execute function platform.reject_mutation();
create trigger cash_closings_no_truncate
  before truncate on public.cash_closings
  for each statement execute function platform.reject_mutation();
-- La moneda del cierre es la de la cuenta (lee transaction_currency).
create trigger cash_closings_account_currency
  before insert or update on public.cash_closings
  for each row execute function platform.assert_payment_account_currency();

-- ── 2. El saldo queda en lo CONTADO ─────────────────────────────────────────
-- Ajustar por la diferencia deja el saldo materializado exactamente en
-- counted_amount (esperado + (contado − esperado) = contado). Con diferencia
-- cero el bump es un no-op y el cierre es puro registro.
create function platform.apply_cash_closing_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    perform platform.bump_account_balance(new.account_id, new.amount_transaction_currency);
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_cash_closing_to_balance() from public;
create trigger cash_closings_zz_balance
  after insert on public.cash_closings
  for each row execute function platform.apply_cash_closing_to_balance();

-- El recómputo aprende la cuarta y última fuente de la fase.
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
       + coalesce((select sum(amount_transaction_currency) from public.cash_closings
                    where account_id = p_account), 0)
$$;

-- ── 3. Cobertura contable: diferencia ≠ 0 ⇒ asiento o cola ──────────────────
-- Un cierre exacto no genera asiento (no hay hecho contable); uno con
-- diferencia entra a la familia del invariante con el mismo enunciado.
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
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
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

-- El preset ve_basico aprende el cierre. Sobrante (positivo): entra a caja
-- contra faltantes/sobrantes; faltante (negativo): al revés. El generador ya
-- maneja pares if_positive/if_negative (diferencial cambiario de los cobros).
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'cash_closing', 'treasury.cash_register.closed',
          'Cierre de caja con diferencia: caja contra faltantes y sobrantes')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'cash_bs',         'functional_amount', 'debit',  'if_positive',
     'Sobrante: en caja hay más de lo que decían los papeles'),
    (v_entry, 2, 'cash_over_short', 'functional_amount', 'credit', 'if_positive',
     'El sobrante abona la cuenta de faltantes y sobrantes'),
    (v_entry, 3, 'cash_over_short', 'functional_amount', 'debit',  'if_negative',
     'Faltante: el hueco es gasto del período'),
    (v_entry, 4, 'cash_bs',         'functional_amount', 'credit', 'if_negative',
     'Y la caja baja a lo que de verdad hay');
end $$;

-- ── 4. RLS, grants y permisos ───────────────────────────────────────────────
alter table public.cash_closings enable row level security;
alter table public.cash_closings force row level security;
create policy cash_closings_select on public.cash_closings for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy cash_closings_insert on public.cash_closings for insert to authenticated
  with check (false);
create policy cash_closings_update on public.cash_closings for update to authenticated
  using (false);
create policy cash_closings_delete on public.cash_closings for delete to authenticated
  using (false);
create policy cash_closings_api_select on public.cash_closings for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_closings_api_insert on public.cash_closings for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_closings_api_update on public.cash_closings for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy cash_closings_api_delete on public.cash_closings for delete to ladino_api
  using (false);

revoke all on public.cash_closings from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.cash_closings to authenticated;
grant select, insert, update on public.cash_closings to ladino_api;

insert into public.permissions (key, description, is_scoped) values
  ('cash.close', 'Cerrar la caja del día', false)
on conflict (key) do nothing;

-- ── 5. Autochequeo ─────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.cash_closings) <> 0 then
    raise exception 'migración 31: cash_closings debe nacer vacía';
  end if;
  if not exists (select 1 from public.journal_template_preset_entries
                  where preset_code = 've_basico' and source_kind = 'cash_closing') then
    raise exception 'migración 31: falta la entrada cash_closing del preset ve_basico';
  end if;
end $$;
