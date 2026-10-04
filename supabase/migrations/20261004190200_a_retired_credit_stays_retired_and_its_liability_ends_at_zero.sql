-- Módulo: ventas · cobros y saldos a favor   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (decisión 5,
-- nota «tercera ronda»)
-- Ola 4 · tercera ronda de la revisión de «cobros, saldos a favor y estado de cuenta»
-- Reversible: ver el pie (con datos vivos)   Homologación: YES (cambia el importe con que un uso
-- de saldo a favor baja el pasivo en su asiento; no cambia ningún documento fiscal ni numeración)
--
-- Qué hace:
--   1. UN SALDO A FAVOR RETIRADO SE QUEDA RETIRADO. Trigger en customer_credits: una fila
--      `expired` no cambia de estado ni de importes. El dominio ya no lo intenta; esto es la
--      prohibición escrita (CLAUDE.md §2: ausencia de mecanismo no es prohibición).
--   2. payments.credit_functional_amount: lo que la APLICACIÓN de un saldo a favor bajó del
--      pasivo en el mayor. El reembolso ya lo guardaba (customer_refunds.credit_functional_amount).
--   3. platform.customer_credit_uses / customer_credit_carried: UNA regla para «lo que el mayor
--      todavía carga por un saldo a favor» = lo que nació − lo que bajó cada uso vivo.
--   4. platform.fx_revaluation_items revalúa los saldos a favor en divisa desde lo que el mayor
--      carga de verdad (customer_credit_carried), no desde «resto × tasa con que nació»: una NC
--      con IVA nace por su total en Bs (E-05), que no es importe × tasa (2,78 USD a 854,4637 son
--      2.375,41 y la nota cargó 2.378,82).
--   5. INVARIANTE nuevo, platform.customer_credit_ledger_gap.
--
-- «Expand»: añade una columna nula, un trigger que solo rechaza lo que ningún camino de la API
-- hace, y funciones de lectura. La API anterior no escribe credit_functional_amount: para sus
-- cobros la regla toma lo que su asiento debitó (ver customer_credit_uses). Va JUSTO DESPUÉS del
-- git pull, con 20261004150000, 190000 y 190100, de las que depende.
--
-- Funciones que redefine, sobre su ÚLTIMA definición en el orden limpio:
--   · platform.fx_revaluation_items ← 20261004150000 §6 (ninguna posterior la toca)
-- No lee nada que cree una migración posterior.

-- ── 1. Un saldo a favor retirado se queda retirado ───────────────────────────
create function platform.customer_credits_retired_stays_retired()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'expired'
     and (new.status is distinct from old.status
          or new.applied_amount is distinct from old.applied_amount
          or new.amount is distinct from old.amount) then
    raise exception
      'el saldo a favor % está retirado: no vuelve a estar disponible ni se consume', old.id
      using errcode = '23514';
  end if;
  return new;
end;
$$;
comment on function platform.customer_credits_retired_stays_retired() is
  'Un saldo a favor `expired` (retirado al reversar el cobro que lo creó: el dinero salió y el '
  'contra-asiento deshizo el pasivo) no cambia de estado ni de importes. Sin este trigger, '
  'aplicarlo y reversar esa aplicación lo devolvía a `available` y se podía reembolsar en '
  'efectivo. Quitarlo reabre ese camino aunque el dominio lo compruebe.';
create trigger customer_credits_retired
  before update on public.customer_credits
  for each row execute function platform.customer_credits_retired_stays_retired();

-- ── 2. La aplicación guarda lo que bajó del pasivo ───────────────────────────
alter table public.payments
  add column credit_functional_amount numeric(24,8),
  add constraint payments_credit_functional_chk check (
    credit_functional_amount is null
    or (customer_credit_id is not null and credit_functional_amount >= 0));
comment on column public.payments.credit_functional_amount is
  'Lo que este cobro con saldo a favor bajó del pasivo con el cliente en el mayor, en moneda '
  'funcional: la parte proporcional de customer_credits.functional_amount, y el resto exacto en '
  'el uso que agota el saldo (ADR-0075 decisión 5). NULL = no aplica un saldo a favor, o es '
  'anterior a 20261004190200: lo dice platform.customer_credit_uses.';

-- ── 3. Una regla: los usos de un saldo a favor y lo que el mayor todavía carga ─
create function platform.customer_credit_uses(p_company uuid)
returns table (customer_credit_id uuid, source_kind text, source_id uuid, used_on date,
               reversed_on date, functional numeric)
language sql
stable
set search_path = ''
as $$
  -- Cada uso de un saldo a favor y lo que bajó del pasivo en el mayor. Fechas en día de Caracas.
  -- Una aplicación anterior a 20261004190200 no guarda la cifra: es lo que su asiento debitó —
  -- lo que el cobro valió, salvo el saldo en divisa aplicado a un documento de otra moneda, que
  -- bajó por importe × la tasa con que nació.
  select p.customer_credit_id, 'payment_received'::text, p.id, platform.caracas_day(p.paid_at),
         (select platform.caracas_day(pr.reversed_at) from public.payment_reversals pr
           where pr.payment_id = p.id),
         coalesce(p.credit_functional_amount,
                  case when cc.fx_rate is null or d.transaction_currency = p.currency
                       then p.functional_amount
                       else platform.round_cents(p.amount * cc.fx_rate) end)
    from public.payments p
    join public.customer_credits cc on cc.id = p.customer_credit_id
    join public.documents d on d.id = p.document_id
   where p.company_id = p_company and p.customer_credit_id is not null
  union all
  select r.customer_credit_id, 'customer_refund'::text, r.id, platform.caracas_day(r.refunded_at),
         null::date, coalesce(r.credit_functional_amount, r.functional_amount)
    from public.customer_refunds r
   where r.company_id = p_company
$$;
comment on function platform.customer_credit_uses(uuid) is
  'Los usos de los saldos a favor de una empresa (aplicaciones y reembolsos) con lo que cada uno '
  'bajó del pasivo en moneda funcional. La única definición de «uso»: la leen '
  'customer_credit_carried, fx_revaluation_items y customer_credit_ledger_gap.';

create function platform.customer_credit_carried(p_company uuid, p_credit uuid,
                                                 p_as_of date default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  -- Lo que nació (lo que el mayor acreditó al pasivo) − lo que bajó cada uso VIVO a la fecha.
  -- Sin fecha: hoy. Un uso reversado después de la fecha todavía contaba ese día.
  select coalesce(cc.functional_amount, platform.round_cents(cc.amount * coalesce(cc.fx_rate, 1)))
         - coalesce((select sum(u.functional)
                       from platform.customer_credit_uses(p_company) u
                      where u.customer_credit_id = cc.id
                        and (p_as_of is null or u.used_on <= p_as_of)
                        and (u.reversed_on is null
                             or (p_as_of is not null and u.reversed_on > p_as_of))), 0)
    from public.customer_credits cc
   where cc.id = p_credit and cc.company_id = p_company
$$;
comment on function platform.customer_credit_carried(uuid, uuid, date) is
  'Lo que el mayor todavía carga en el pasivo por un saldo a favor, en moneda funcional: su '
  'importe funcional de nacimiento − lo que bajaron sus usos vivos. El dominio lo usa para que el '
  'uso que agota el saldo se lleve el resto exacto y el pasivo termine en 0,00.';
revoke all on function platform.customer_credit_uses(uuid) from public;
revoke all on function platform.customer_credit_carried(uuid, uuid, date) from public;
grant execute on function platform.customer_credit_uses(uuid) to authenticated, ladino_api;
grant execute on function platform.customer_credit_carried(uuid, uuid, date)
  to authenticated, ladino_api;

-- ── 4. La revaluación parte de lo que el mayor carga ─────────────────────────
-- Parte de la definición VIVA (20261004150000 §6, la última), copiada entera. Única diferencia, en
-- el bloque «LOS SALDOS A FAVOR EN DIVISA»: lo que el mayor lleva es
-- platform.customer_credit_carried a la fecha, no round(resto × tasa con que nació).
create or replace function platform.fx_revaluation_items(p_company uuid, p_as_of date)
returns table (item_kind text, account_id uuid, label text, currency text,
               original_balance numeric, rate numeric, carried numeric, target numeric,
               adjustment numeric)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_func text;
  v_c record;
  v_rate numeric;
  v_cuenta uuid;
  v_orig numeric;
  v_hist numeric;
  v_target numeric;
  v_prior numeric;
  v_lado text;
  v_n integer;
  v_monedas text;
  v_tasa_unica numeric;
  v_ajuste numeric;
begin
  select c.functional_currency_code into v_func from public.companies c where c.id = p_company;
  if v_func is null then return; end if;

  -- Las cajas en divisa: una fila por subcuenta.
  for v_c in
    select ca.id, ca.name, ca.currency, ca.ledger_account_id
      from public.company_accounts ca
     where ca.company_id = p_company and ca.currency <> v_func
       and ca.ledger_account_id is not null
     order by ca.id
  loop
    v_orig := platform.treasury_ledger_original(p_company, v_c.ledger_account_id, v_c.currency,
                                                p_as_of);
    select coalesce(sum(l.functional_debit - l.functional_credit), 0) into v_hist
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
     where l.company_id = p_company and l.account_id = v_c.ledger_account_id
       and e.status in ('posted', 'reversed') and e.posting_date <= p_as_of;
    if v_orig = 0 then
      -- Sin dólares no hay nada que medir a ninguna tasa: lo que el mayor lleve vuelve a cero.
      v_rate := null;
      v_target := 0;
    else
      v_rate := platform.closing_rate(p_company, v_c.currency, v_func, p_as_of);
      if v_rate is null then
        raise exception 'no hay tasa de cierre % → % vigente al %: cárgala con su fuente',
          v_c.currency, v_func, p_as_of using errcode = 'LAD51';
      end if;
      v_target := platform.round_cents(v_orig * v_rate);
    end if;
    if v_target - v_hist <> 0 then
      return query select 'treasury'::text, v_c.ledger_account_id, v_c.name, v_c.currency,
                          v_orig, v_rate, v_hist, v_target, v_target - v_hist;
    end if;
  end loop;

  -- Cuentas por cobrar y por pagar: una fila por cuenta, con todas sus divisas.
  foreach v_lado in array array['ar', 'ap'] loop
    select s.account_id into v_cuenta
      from public.company_account_settings s
     where s.company_id = p_company
       and s.purpose = case v_lado when 'ar' then 'ar_general' else 'ap_general' end
       and (s.effective_from at time zone 'America/Caracas')::date <= p_as_of
       and (s.effective_to is null
            or (s.effective_to at time zone 'America/Caracas')::date > p_as_of)
     order by s.effective_from desc limit 1;
    continue when v_cuenta is null;

    v_n := 0;
    v_orig := 0;
    v_hist := 0;
    v_target := 0;
    v_monedas := null;
    v_tasa_unica := null;
    for v_c in
      select x.currency, sum(x.saldo) as original,
             sum(platform.round_cents(x.saldo * x.fx_rate)) as historico
        from (
          select d.transaction_currency as currency, d.fx_rate,
                 platform.document_balance_transaction_at(p_company, d.id, p_as_of) as saldo
            from public.documents d
           where v_lado = 'ar' and d.company_id = p_company
             and d.kind in ('invoice', 'receipt', 'debit_note')
             and (d.status = 'issued'
                  or (d.status = 'paid'
                      and exists (select 1 from public.payments p
                                   where p.document_id = d.id
                                     and platform.caracas_day(p.paid_at) > p_as_of
                                     and not exists (select 1 from public.payment_reversals pr
                                                      where pr.payment_id = p.id))))
             and d.transaction_currency <> v_func
             and platform.caracas_day(d.issued_at) <= p_as_of
          union all
          select i.transaction_currency, i.fx_rate,
                 i.total_amount
                 - round(coalesce(i.retention_total, 0) / nullif(i.fx_rate, 0),
                         platform.currency_minor_units(i.transaction_currency))
                 - coalesce((select sum(coalesce(p.settled_amount, p.net_amount))
                               from public.supplier_payments p
                              where p.supplier_invoice_id = i.id
                                and platform.caracas_day(p.paid_at) <= p_as_of), 0)
                 - coalesce((select sum(n.total_amount) from public.supplier_credit_notes n
                              where n.supplier_invoice_id = i.id and n.status = 'posted'
                                and coalesce(n.accounting_date, n.note_date) <= p_as_of), 0)
            from public.supplier_invoices i
           where v_lado = 'ap' and i.company_id = p_company
             and (i.status = 'posted'
                  or (i.status = 'paid'
                      and exists (select 1 from public.supplier_payments p
                                   where p.supplier_invoice_id = i.id
                                     and platform.caracas_day(p.paid_at) > p_as_of)))
             and i.transaction_currency <> v_func
             and coalesce(i.accounting_date, i.invoice_date) <= p_as_of
        ) x
       where x.saldo > 0
       group by x.currency
       order by x.currency
    loop
      v_rate := platform.closing_rate(p_company, v_c.currency, v_func, p_as_of);
      if v_rate is null then
        raise exception 'no hay tasa de cierre % → % vigente al %: cárgala con su fuente',
          v_c.currency, v_func, p_as_of using errcode = 'LAD51';
      end if;
      v_n := v_n + 1;
      v_orig := v_orig + v_c.original;
      v_hist := v_hist + v_c.historico;
      v_target := v_target + platform.round_cents(v_c.original * v_rate);
      v_monedas := case when v_n = 1 then v_c.currency else v_monedas || ', ' || v_c.currency end;
      v_tasa_unica := case when v_n = 1 then v_rate else null end;
    end loop;

    -- Lo ya revaluado en esa cuenta, en términos de débito (todas las divisas juntas).
    select coalesce(sum(l.functional_debit - l.functional_credit), 0) into v_prior
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      left join public.journal_entries o on o.id = e.is_reversal_of
     where l.company_id = p_company and l.account_id = v_cuenta
       and e.status in ('posted', 'reversed') and e.posting_date <= p_as_of
       and ((e.source_kind = 'exchange_diff' and e.source_event = 'fx.revaluation_at_close')
            or (o.source_kind = 'exchange_diff' and o.source_event = 'fx.revaluation_at_close'));

    if v_lado = 'ar' then
      -- Activo: lo que lleva = histórico + revaluado; el ajuste, lo que falta para el objetivo.
      v_ajuste := v_target - (v_hist + v_prior);
      if v_ajuste <> 0 then
        return query select 'receivable'::text, v_cuenta,
                            'Cuentas por cobrar en ' || coalesce(v_monedas, 'divisa'),
                            coalesce(v_monedas, v_func), v_orig, v_tasa_unica,
                            v_hist + v_prior, v_target, v_ajuste;
      end if;
    else
      -- Pasivo: lo que lleva (acreedor) = histórico − revaluado en débito; el ajuste en términos
      -- de débito es el contrario de lo que falta.
      v_ajuste := -(v_target - (v_hist - v_prior));
      if v_ajuste <> 0 then
        return query select 'payable'::text, v_cuenta,
                            'Cuentas por pagar en ' || coalesce(v_monedas, 'divisa'),
                            coalesce(v_monedas, v_func), v_orig, v_tasa_unica,
                            v_hist - v_prior, v_target, v_ajuste;
      end if;
    end if;
  end loop;

  -- LOS SALDOS A FAVOR EN DIVISA (G-05, 20261004150000): son un pasivo monetario con el cliente.
  -- Lo que queda de cada uno a la fecha = lo que nació − lo aplicado por cobros vivos − lo
  -- reembolsado, día de Caracas contra día. Lo que el mayor lleva = lo que nació − lo que bajó
  -- cada uso (platform.customer_credit_carried, 20261004190200), menos lo ya revaluado en la cuenta. Un saldo a favor en moneda funcional (todos los
  -- anteriores a esta migración) no entra: no tiene nada que revaluar.
  select s.account_id into v_cuenta
    from public.company_account_settings s
   where s.company_id = p_company
     and s.purpose = 'customer_credit_liability'
     and (s.effective_from at time zone 'America/Caracas')::date <= p_as_of
     and (s.effective_to is null
          or (s.effective_to at time zone 'America/Caracas')::date > p_as_of)
   order by s.effective_from desc limit 1;
  if v_cuenta is not null then
    v_n := 0;
    v_orig := 0;
    v_hist := 0;
    v_target := 0;
    v_monedas := null;
    v_tasa_unica := null;
    for v_c in
      select x.currency, sum(x.resto) as original,
             sum(x.carried) as historico
        from (
          select cc.currency,
                 platform.customer_credit_carried(p_company, cc.id, p_as_of) as carried,
                 cc.amount
                 - coalesce((select sum(p.amount) from public.payments p
                              where p.company_id = p_company and p.customer_credit_id = cc.id
                                and platform.caracas_day(p.paid_at) <= p_as_of
                                and not exists (select 1 from public.payment_reversals pr
                                                 where pr.payment_id = p.id
                                                   and platform.caracas_day(pr.reversed_at)
                                                       <= p_as_of)), 0)
                 - coalesce((select sum(coalesce(r.credit_amount, r.amount_transaction_currency))
                               from public.customer_refunds r
                              where r.company_id = p_company and r.customer_credit_id = cc.id
                                and platform.caracas_day(r.refunded_at) <= p_as_of), 0) as resto
            from public.customer_credits cc
           where cc.company_id = p_company and cc.currency <> v_func
             and cc.fx_rate is not null and cc.status <> 'expired'
             and platform.caracas_day(cc.created_at) <= p_as_of
        ) x
       where x.resto > 0
       group by x.currency
       order by x.currency
    loop
      v_rate := platform.closing_rate(p_company, v_c.currency, v_func, p_as_of);
      if v_rate is null then
        raise exception 'no hay tasa de cierre % → % vigente al %: cárgala con su fuente',
          v_c.currency, v_func, p_as_of using errcode = 'LAD51';
      end if;
      v_n := v_n + 1;
      v_orig := v_orig + v_c.original;
      v_hist := v_hist + v_c.historico;
      v_target := v_target + platform.round_cents(v_c.original * v_rate);
      v_monedas := case when v_n = 1 then v_c.currency else v_monedas || ', ' || v_c.currency end;
      v_tasa_unica := case when v_n = 1 then v_rate else null end;
    end loop;

    select coalesce(sum(l.functional_debit - l.functional_credit), 0) into v_prior
      from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id
      left join public.journal_entries o on o.id = e.is_reversal_of
     where l.company_id = p_company and l.account_id = v_cuenta
       and e.status in ('posted', 'reversed') and e.posting_date <= p_as_of
       and ((e.source_kind = 'exchange_diff' and e.source_event = 'fx.revaluation_at_close')
            or (o.source_kind = 'exchange_diff' and o.source_event = 'fx.revaluation_at_close'));

    -- Pasivo, como las cuentas por pagar: el ajuste en términos de débito.
    v_ajuste := -(v_target - (v_hist - v_prior));
    if v_ajuste <> 0 then
      return query select 'customer_credit'::text, v_cuenta,
                          'Saldos a favor de clientes en ' || coalesce(v_monedas, 'divisa'),
                          coalesce(v_monedas, v_func), v_orig, v_tasa_unica,
                          v_hist - v_prior, v_target, v_ajuste;
    end if;
  end if;
end;
$$;
comment on function platform.fx_revaluation_items(uuid, date) is
  'ADR-0075 §6: las partidas monetarias en divisa que el cierre revalúa a la tasa de cierre, una '
  'fila por cuenta y solo si hay diferencia: cajas, cuentas por cobrar, cuentas por pagar y '
  '(G-05) los saldos a favor de clientes en divisa, desde lo que el mayor carga por cada uno '
  '(customer_credit_carried). adjustment va en términos de débito.';

-- ── 5. INVARIANTE: los saldos a favor vivos son el pasivo del mayor ──────────
create function platform.customer_credit_ledger_gap(p_company uuid)
returns table (kind text, customer_credit_id uuid, expected numeric, ledger numeric,
               gap numeric, queued numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: en una empresa con cuenta de saldos a favor de clientes (papel
  -- customer_credit_liability),
  --     Σ, sobre los saldos a favor NO retirados cuyo nacimiento tiene asiento, de lo que nacieron
  --   − Σ, sobre sus usos vivos con asiento (aplicaciones y reembolsos), de lo que cada uno bajó
  --   = el saldo acreedor de esas cuentas en el mayor;
  -- y todo saldo a favor AGOTADO no carga nada: lo que nació = lo que bajaron sus usos.
  -- Con estas precisiones, que son parte del enunciado y no perdones:
  --   · un saldo a favor nace de una nota de crédito, de un recibo de devolución o del sobrante de
  --     un cobro; lo que nació es su importe funcional (el total en Bs del documento, o el
  --     sobrante a la tasa del cobro);
  --   · un saldo retirado (`expired`: se reversó el cobro que lo creó) no es un saldo a favor, y
  --     el asiento de su cobro y su contra-asiento se anulan en el mayor;
  --   · una aplicación reversada no es un uso, y su asiento y su contra-asiento se anulan;
  --   · el mayor se toma sin la revaluación al cierre (es por cuenta y moneda: ADR-0075 §6) y sin
  --     el asiento de la regularización del céntimo (ADR-0075 §7);
  --   · lo que está en la cola de pendientes no entra en ninguno de los dos lados: `queued` dice
  --     cuánto es, y de que no se pierda responde accounting_coverage_gaps.
  -- Filas: `ledger` (una, si el total no coincide con el mayor) y `exhausted` (una por saldo a
  -- favor agotado que todavía carga algo). Sin lista de exclusiones: un asiento manual sobre la
  -- cuenta, o cualquier hecho que la mueva sin ser el nacimiento o el uso de un saldo, da fila.
  with cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'customer_credit_liability'
  ),
  vivos as (
    select cc.id, cc.amount, cc.applied_amount,
           coalesce(cc.functional_amount,
                    platform.round_cents(cc.amount * coalesce(cc.fx_rate, 1))) as nacio,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and ((cc.source_payment_id is not null
                            and e.source_kind = 'payment_received'
                            and e.source_id = cc.source_payment_id)
                        or (cc.source_payment_id is null
                            and e.source_kind in ('sales_credit_note', 'sales_receipt_return')
                            and e.source_id = cc.source_document_id))) as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_id = coalesce(cc.source_payment_id, cc.source_document_id))
             as en_cola
      from public.customer_credits cc
     where cc.company_id = p_company and cc.status <> 'expired'
  ),
  usos as (
    select u.customer_credit_id, u.functional,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and e.source_kind = u.source_kind and e.source_id = u.source_id)
             as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_id = u.source_id) as en_cola
      from platform.customer_credit_uses(p_company) u
     where u.reversed_on is null
       and u.customer_credit_id in (select v.id from vivos v)
  ),
  esperado as (
    select coalesce((select sum(v.nacio) from vivos v where v.con_asiento), 0)
           - coalesce((select sum(u.functional) from usos u where u.con_asiento), 0) as v,
           coalesce((select sum(v.nacio) from vivos v where v.en_cola and not v.con_asiento), 0)
           - coalesce((select sum(u.functional) from usos u
                        where u.en_cola and not u.con_asiento), 0) as cola
  ),
  mayor as (
    select coalesce(sum(jl.functional_credit - jl.functional_debit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
      left join public.journal_entries o on o.id = e.is_reversal_of
     where jl.company_id = p_company
       and jl.account_id in (select c.account_id from cuentas c)
       and e.status in ('posted', 'reversed')
       and not ((e.source_kind = 'exchange_diff' and e.source_event = 'fx.revaluation_at_close')
                or coalesce(o.source_kind = 'exchange_diff'
                            and o.source_event = 'fx.revaluation_at_close', false))
       and e.id not in (select platform.cent_regularization_entry_ids(p_company))
  )
  select 'ledger'::text, null::uuid, esperado.v, mayor.v, esperado.v - mayor.v, esperado.cola
    from esperado, mayor
   where exists (select 1 from cuentas)
     and esperado.v - mayor.v <> 0
  union all
  select 'exhausted'::text, x.id, 0::numeric, x.queda, -x.queda, 0::numeric
    from (select v.id, v.amount, v.applied_amount,
                 v.nacio - coalesce((select sum(u.functional)
                                       from platform.customer_credit_uses(p_company) u
                                      where u.customer_credit_id = v.id
                                        and u.reversed_on is null), 0) as queda
            from vivos v) x
   where x.applied_amount >= x.amount and x.queda <> 0
$$;
comment on function platform.customer_credit_ledger_gap(uuid) is
  'INVARIANTE: Σ por saldo a favor no retirado con asiento (lo que nació − lo que bajaron sus '
  'usos vivos con asiento) = saldo acreedor de las cuentas de saldos a favor de clientes del '
  'mayor, sin la revaluación al cierre ni la regularización del céntimo; y un saldo a favor '
  'agotado no carga nada. Lo que está en la cola va en `queued`. Cero filas.';
revoke all on function platform.customer_credit_ledger_gap(uuid) from public;
grant execute on function platform.customer_credit_ledger_gap(uuid) to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · El trigger se suelta con otra migración sin tocar datos; soltarlo reabre el camino por el
--     que un saldo a favor retirado se reembolsaba (lo comprueba el pgTAP 133 con su variante rota).
--   · payments.credit_functional_amount se puede soltar SOLO mientras ningún cobro la haya
--     escrito: desde el primero, es el único sitio donde vive lo que esa aplicación bajó del
--     pasivo (payments es append-only: lo escrito no se reescribe, y la regla anterior —importe ×
--     tasa— ya no reproduce el asiento).
--   · fx_revaluation_items vuelve a la definición de 20261004150000 con otra migración; los
--     asientos de revaluación ya posteados no cambian (regla 2).
--   · customer_credit_uses, customer_credit_carried y customer_credit_ledger_gap son de lectura.
--     El dominio llama a customer_credit_carried: soltarla exige desplegar antes el dominio viejo.
-- A la fecha, ninguna migración posterior redefine fx_revaluation_items ni estas funciones.
-- =============================================================================
