-- =============================================================================
-- Ladino — migración 29 · FASE C: TESORERÍA BÁSICA — cuentas, formas de pago
--                          y a qué cuenta entra o sale cada pago
--
-- Módulo: tesorería (RIGOR MÁXIMO: es dinero)  Spec: Fase C partes 11 y 14
-- Reversible: NO una vez que existan pagos atribuidos a cuentas.
-- Homologación: NO (no toca documentos fiscales; toca dónde vive el dinero).
--
-- El concepto que Ladino no tenía para la persona: LA CUENTA. «¿Dónde está mi
-- dinero?» — Caja Bs, Caja USD, Banesco, Zelle. Cada cobro ENTRA a una; cada
-- pago SALE de una. Sin APIs bancarias: el saldo es la suma de los
-- movimientos, materializado con la misma disciplina que stock_balances y
-- ledger_balances (trigger + recompute + test de igualdad).
--
-- LA DECISIÓN DIFÍCIL, dicha entera: `payments` y `supplier_payments` son
-- append-only y ganan `account_id NOT NULL`. El backfill de lo existente va a
-- cuentas «Sin asignar (<moneda>)» de sistema, y el contador las redistribuye
-- después. Eso exige que `account_id` sea LO ÚNICO editable de un pago: el
-- guard nuevo permite un UPDATE cuyo único cambio sea account_id (más el
-- `version` que bump-ea el trigger de procedencia) y rechaza todo lo demás.
-- El HECHO monetario —cuánto, cuándo, de quién, contra qué documento— sigue
-- congelado; la ATRIBUCIÓN a una cuenta es metadato corregible, igual que el
-- backlink `journal_entry_id` de la migración 26. El asiento contable del
-- pago NO se reescribe al redistribuir: si la cuenta contable difiere, eso es
-- una reclasificación que el contador hace en /admin con su contra-asiento.
-- =============================================================================

-- ── 1. Las cuentas del negocio ──────────────────────────────────────────────
create table public.company_accounts (
  id          uuid        primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  name        text        not null,
  currency    text        not null,
  kind        text        not null,
  is_active   boolean     not null default true,
  -- Las «Sin asignar» del backfill: no se borran ni se renombran; existen
  -- para que el contador vea qué falta por redistribuir.
  is_system   boolean     not null default false,
  -- El mapeo a la cuenta CONTABLE, que pone el contador en /admin. Si es
  -- NULL, el asiento del movimiento usa el papel cash_bs/cash_usd por moneda.
  ledger_account_id uuid,

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint company_accounts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint company_accounts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint company_accounts_currency_fk foreign key (currency) references public.currencies (code),
  constraint company_accounts_ledger_fk
    foreign key (company_id, ledger_account_id) references public.accounts (company_id, id),
  constraint company_accounts_kind_chk check (kind in ('cash', 'bank', 'wallet')),
  constraint company_accounts_name_chk
    check (name = btrim(name) and length(name) between 2 and 80),
  constraint company_accounts_name_key unique (company_id, name),
  constraint company_accounts_company_id_key unique (company_id, id)
);

-- ── 2. Las formas de pago, cada una apuntando a su cuenta ───────────────────
-- «Pago móvil → Banesco», «Zelle → Zelle». Al cobrar, la persona elige la
-- forma; el dinero entra a la cuenta solo. El vocabulario es el MISMO de
-- payments.instrument (que gana pago_movil y tarjeta en esta migración).
create table public.payment_methods (
  id          uuid        primary key default platform.uuidv7(),
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  name        text        not null,
  kind        text        not null,
  account_id  uuid        not null,
  is_active   boolean     not null default true,

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint payment_methods_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint payment_methods_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint payment_methods_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint payment_methods_kind_chk check (kind in
    ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
     'pago_movil', 'tarjeta', 'otro')),
  constraint payment_methods_name_chk
    check (name = btrim(name) and length(name) between 2 and 80),
  constraint payment_methods_name_key unique (company_id, name),
  constraint payment_methods_company_id_key unique (company_id, id)
);

-- ── 3. El vocabulario de instrumento gana pago_movil y tarjeta ──────────────
-- Cobrar (Fase C parte 6) los ofrece; el CHECK viejo los rechazaría.
alter table public.payments drop constraint payments_instrument_chk;
alter table public.payments add constraint payments_instrument_chk check (instrument in
  ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
   'pago_movil', 'tarjeta', 'saldo_a_favor', 'otro'));
alter table public.supplier_payments drop constraint supplier_payments_instrument_chk;
alter table public.supplier_payments add constraint supplier_payments_instrument_chk
  check (instrument in
    ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
     'pago_movil', 'tarjeta', 'otro'));

-- ── 4. account_id en los pagos, con el guard de solo-atribución ─────────────
alter table public.payments add column account_id uuid;
alter table public.supplier_payments add column account_id uuid;
alter table public.payments add constraint payments_account_fk
  foreign key (company_id, account_id) references public.company_accounts (company_id, id);
alter table public.supplier_payments add constraint supplier_payments_account_fk
  foreign key (company_id, account_id) references public.company_accounts (company_id, id);

/**
 * El guard: en un pago, LO ÚNICO editable es la atribución de cuenta.
 * Se compara el resto de la fila campo a campo (menos `version`, que lo
 * bump-ea set_row_provenance en cada UPDATE): si algo más cambió, se rechaza
 * con el mismo código del append-only. DELETE sigue prohibido siempre.
 */
create function platform.assert_payment_account_only_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (to_jsonb(old) - 'account_id' - 'version')
     is distinct from (to_jsonb(new) - 'account_id' - 'version') then
    raise exception
      'un pago es un hecho: solo su atribución de cuenta (account_id) se puede corregir'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_payment_account_only_update() from public;

drop trigger payments_append_only on public.payments;
create trigger payments_account_guard
  before update on public.payments
  for each row execute function platform.assert_payment_account_only_update();
create trigger payments_no_delete
  before delete on public.payments
  for each row execute function platform.reject_mutation();

drop trigger supplier_payments_append_only on public.supplier_payments;
create trigger supplier_payments_account_guard
  before update on public.supplier_payments
  for each row execute function platform.assert_payment_account_only_update();
create trigger supplier_payments_no_delete
  before delete on public.supplier_payments
  for each row execute function platform.reject_mutation();

-- La MONEDA del pago debe ser la de la cuenta: un Zelle no entra a Caja Bs.
-- Se valida por trigger porque una FK no compara columnas de las dos tablas.
create function platform.assert_payment_account_currency()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_currency text;
  v_pago     text;
begin
  if new.account_id is null then return new; end if;
  select currency into v_currency from public.company_accounts where id = new.account_id;
  v_pago := coalesce(to_jsonb(new) ->> 'currency', to_jsonb(new) ->> 'transaction_currency');
  if v_currency is distinct from v_pago then
    raise exception
      'LAD67: el pago es en % y la cuenta «%» vive en %: el dinero no cambia de moneda al guardarse',
      v_pago, (select name from public.company_accounts where id = new.account_id), v_currency
      using errcode = 'LAD67';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_payment_account_currency() from public;

create trigger payments_account_currency
  before insert or update on public.payments
  for each row execute function platform.assert_payment_account_currency();
create trigger supplier_payments_account_currency
  before insert or update on public.supplier_payments
  for each row execute function platform.assert_payment_account_currency();

-- ── 5. Backfill: lo existente va a «Sin asignar (<moneda>)» ─────────────────
insert into public.company_accounts (tenant_id, company_id, name, currency, kind, is_system)
select distinct t.tenant_id, t.company_id, 'Sin asignar (' || t.moneda || ')', t.moneda, 'cash', true
  from (select tenant_id, company_id, currency as moneda from public.payments
        union
        select tenant_id, company_id, transaction_currency from public.supplier_payments) t
on conflict (company_id, name) do nothing;

update public.payments p
   set account_id = ca.id
  from public.company_accounts ca
 where ca.company_id = p.company_id and ca.is_system
   and ca.name = 'Sin asignar (' || p.currency || ')'
   and p.account_id is null
   and p.instrument <> 'saldo_a_favor';
update public.supplier_payments sp
   set account_id = ca.id
  from public.company_accounts ca
 where ca.company_id = sp.company_id and ca.is_system
   and ca.name = 'Sin asignar (' || sp.transaction_currency || ')'
   and sp.account_id is null
   and sp.instrument <> 'nota_credito';

-- No es un NOT NULL a secas: aplicar un SALDO A FAVOR (o una nota de crédito
-- de proveedor) no mueve efectivo — atribuirle una cuenta inventaría dinero
-- en el saldo. La forma correcta es un espejo de payments_credit_shape_chk:
-- todo pago con plata de verdad lleva cuenta; el que no la mueve, no lleva.
alter table public.payments add constraint payments_account_shape_chk
  check ((instrument = 'saldo_a_favor') = (account_id is null));
alter table public.supplier_payments add constraint supplier_payments_account_shape_chk
  check ((instrument = 'nota_credito') = (account_id is null));

-- ── 6. El saldo materializado, con la disciplina de siempre ─────────────────
-- Saldo EN LA MONEDA DE LA CUENTA: entra `payments.amount`, sale
-- `supplier_payments.net_amount` (el proveedor cobra el neto; lo retenido no
-- sale de la cuenta — se entera al fisco por su propio camino). Las
-- migraciones 30 y 31 extienden las fuentes (gastos y cierres de caja)
-- REEMPLAZANDO la función de recómputo: una sola definición de la verdad.
create table public.company_account_balances (
  account_id uuid        primary key,
  tenant_id  uuid        not null,
  company_id uuid        not null,
  balance    numeric(24,8) not null default 0,
  updated_at timestamptz not null default now(),
  constraint company_account_balances_account_fk
    foreign key (account_id) references public.company_accounts (id),
  constraint company_account_balances_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint company_account_balances_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id)
);

create function platform.recompute_account_balance(p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  -- Los instrumentos sin efectivo (saldo_a_favor, nota_credito) no tienen
  -- account_id por CHECK, así que el filtro por cuenta ya los excluye solo.
  select coalesce((select sum(amount) from public.payments where account_id = p_account), 0)
       - coalesce((select sum(net_amount) from public.supplier_payments
                    where account_id = p_account), 0)
$$;

create function platform.bump_account_balance(p_account uuid, p_delta numeric)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.company_account_balances (account_id, tenant_id, company_id, balance)
  select ca.id, ca.tenant_id, ca.company_id, p_delta
    from public.company_accounts ca where ca.id = p_account
  on conflict (account_id)
    do update set balance = public.company_account_balances.balance + excluded.balance,
                  updated_at = now();
end;
$$;
revoke execute on function platform.bump_account_balance(uuid, numeric) from public;

create function platform.apply_payment_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Un pago sin cuenta (saldo a favor) no mueve saldo: no hay efectivo.
  if tg_op = 'INSERT' and new.account_id is not null then
    perform platform.bump_account_balance(new.account_id, new.amount);
  elsif tg_op = 'UPDATE' and new.account_id is distinct from old.account_id then
    -- Redistribución: el dinero se muda de cuenta, el saldo lo sigue.
    if old.account_id is not null then
      perform platform.bump_account_balance(old.account_id, -old.amount);
    end if;
    if new.account_id is not null then
      perform platform.bump_account_balance(new.account_id, new.amount);
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_payment_to_balance() from public;

create function platform.apply_supplier_payment_to_balance()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Un pago sin cuenta (nota de crédito) no mueve saldo: no hay efectivo.
  if tg_op = 'INSERT' and new.account_id is not null then
    perform platform.bump_account_balance(new.account_id, -new.net_amount);
  elsif tg_op = 'UPDATE' and new.account_id is distinct from old.account_id then
    if old.account_id is not null then
      perform platform.bump_account_balance(old.account_id, old.net_amount);
    end if;
    if new.account_id is not null then
      perform platform.bump_account_balance(new.account_id, -new.net_amount);
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function platform.apply_supplier_payment_to_balance() from public;

create trigger payments_zz_balance
  after insert or update on public.payments
  for each row execute function platform.apply_payment_to_balance();
create trigger supplier_payments_zz_balance
  after insert or update on public.supplier_payments
  for each row execute function platform.apply_supplier_payment_to_balance();

-- Backfill de saldos para lo redistribuido en el paso 5 (los triggers no
-- vieron esos UPDATE porque aún no existían).
insert into public.company_account_balances (account_id, tenant_id, company_id, balance)
select ca.id, ca.tenant_id, ca.company_id, platform.recompute_account_balance(ca.id)
  from public.company_accounts ca
on conflict (account_id) do update
  set balance = excluded.balance, updated_at = now();

-- El invariante cruzado, consultable: materializado == recomputado, por
-- cuenta. La misma familia que stock_reconciliation() y recompute_ledger().
create function platform.treasury_reconciliation(p_company uuid)
returns table (account_id uuid, name text, materialized numeric, recomputed numeric, ok boolean)
language sql
stable
set search_path = ''
as $$
  select ca.id, ca.name,
         coalesce(b.balance, 0),
         platform.recompute_account_balance(ca.id),
         coalesce(b.balance, 0) = platform.recompute_account_balance(ca.id)
    from public.company_accounts ca
    left join public.company_account_balances b on b.account_id = ca.id
   where ca.company_id = p_company
$$;

-- ── 7. RLS y grants ─────────────────────────────────────────────────────────
alter table public.company_accounts enable row level security;
alter table public.company_accounts force row level security;
alter table public.payment_methods enable row level security;
alter table public.payment_methods force row level security;
alter table public.company_account_balances enable row level security;
alter table public.company_account_balances force row level security;

create policy company_accounts_select on public.company_accounts for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy company_accounts_write on public.company_accounts for insert to authenticated
  with check (false);
create policy company_accounts_update on public.company_accounts for update to authenticated
  using (false);
create policy company_accounts_delete on public.company_accounts for delete to authenticated
  using (false);
create policy company_accounts_api_select on public.company_accounts for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_accounts_api_insert on public.company_accounts for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_accounts_api_update on public.company_accounts for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy company_accounts_api_delete on public.company_accounts for delete to ladino_api
  using (false);

create policy payment_methods_select on public.payment_methods for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy payment_methods_insert on public.payment_methods for insert to authenticated
  with check (false);
create policy payment_methods_update on public.payment_methods for update to authenticated
  using (false);
create policy payment_methods_delete on public.payment_methods for delete to authenticated
  using (false);
create policy payment_methods_api_select on public.payment_methods for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payment_methods_api_insert on public.payment_methods for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payment_methods_api_update on public.payment_methods for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy payment_methods_api_delete on public.payment_methods for delete to ladino_api
  using (false);

create policy account_balances_select on public.company_account_balances for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy account_balances_api_select on public.company_account_balances for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

revoke all on public.company_accounts, public.payment_methods, public.company_account_balances
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.company_accounts, public.payment_methods, public.company_account_balances
  to authenticated;
grant select, insert, update on public.company_accounts, public.payment_methods to ladino_api;
grant select on public.company_account_balances to ladino_api;
-- El saldo materializado lo escriben SOLO los triggers (security definer).

create trigger company_accounts_00_provenance
  before insert or update on public.company_accounts
  for each row execute function platform.set_row_provenance();
create trigger company_accounts_01_anchors
  before update on public.company_accounts
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger payment_methods_00_provenance
  before insert or update on public.payment_methods
  for each row execute function platform.set_row_provenance();
create trigger payment_methods_01_anchors
  before update on public.payment_methods
  for each row execute function platform.assert_isolation_anchors_immutable();
-- También el saldo materializado: sus anclas son tan inmutables como las de
-- cualquier otra tabla, y el test 006 pregunta por la FAMILIA entera. La
-- lección de fiscal_book_runs (CLAUDE.md §3): si el invariante vale para toda
-- la familia, las tablas donde parece redundante lo cumplen igual.
create trigger company_account_balances_01_anchors
  before update on public.company_account_balances
  for each row execute function platform.assert_isolation_anchors_immutable();

-- Las cuentas de sistema no se renombran ni se desactivan: son la lista de
-- lo que el contador aún no redistribuyó.
create function platform.assert_system_account_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if old.is_system and (new.name <> old.name or new.is_system <> old.is_system
                        or new.is_active <> old.is_active or new.currency <> old.currency) then
    raise exception
      'la cuenta «Sin asignar» es de sistema: se vacía redistribuyendo pagos, no editándola'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_system_account_frozen() from public;
create trigger company_accounts_02_system_frozen
  before update on public.company_accounts
  for each row execute function platform.assert_system_account_frozen();

grant execute on function platform.treasury_reconciliation(uuid) to authenticated, ladino_api;
grant execute on function platform.recompute_account_balance(uuid) to authenticated, ladino_api;
revoke execute on function platform.treasury_reconciliation(uuid) from public;
revoke execute on function platform.recompute_account_balance(uuid) from public;

insert into public.permissions (key, description, is_scoped) values
  ('treasury.read',           'Ver cuentas, saldos y movimientos de dinero',            false),
  ('treasury.account.manage', 'Crear y editar cuentas y formas de pago',                false),
  ('treasury.reassign',       'Redistribuir pagos entre cuentas (Sin asignar → real)',  false)
on conflict (key) do nothing;

-- ── 8. Autochequeo ─────────────────────────────────────────────────────────
do $$
begin
  if (select count(*) from public.payments
       where account_id is null and instrument <> 'saldo_a_favor') <> 0
     or (select count(*) from public.supplier_payments
          where account_id is null and instrument <> 'nota_credito') <> 0 then
    raise exception 'migración 29: quedó un pago CON efectivo sin cuenta tras el backfill';
  end if;
  if exists (select 1 from public.company_accounts ca
              where not exists (select 1 from platform.treasury_reconciliation(ca.company_id) r
                                 where r.account_id = ca.id and r.ok)) then
    raise exception 'migración 29: el saldo materializado no cuadra con el recomputado';
  end if;
  if (select count(*) from information_schema.role_table_grants
       where table_schema = 'public' and table_name = 'company_account_balances'
         and grantee in ('anon','authenticated','service_role','ladino_api','ladino_worker')
         and privilege_type in ('INSERT','UPDATE','DELETE','TRUNCATE')) <> 0 then
    raise exception 'migración 29: el saldo materializado solo lo escriben los triggers';
  end if;
end $$;
