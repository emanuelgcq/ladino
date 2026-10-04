-- =============================================================================
-- Ladino — LA REVALUACIÓN NETEA, LA TASA DE CIERRE ES FRESCA Y LAS LECTURAS NO SE CAEN
-- (ADR-0075 §5, §6 y §8; revisión de «moneda B»: H2, H5, H7, H11, H12, H14)
--
-- Módulo: contabilidad · tesorería · ventas. Rigor máximo (dinero, con datos vivos).
-- Spec:   ADR-0075 (nota de aplicación §5, §6, §8) · ADR-0020 · ADR-0069 ·
--         JOURNAL_AND_CLOSING_SPEC.md.
-- Reversible: SÍ para las funciones (otra migración con las definiciones de 20261003180000);
--   NO para los asientos que se escriban con ellas — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia cuándo y por cuánto se asienta la revaluación al cierre
--   (resultado del período) y qué tasa se admite como tasa de cierre (VALIDAR-CONTABLE P-88).
--   No cambia ningún documento fiscal, libro ni declaración.
--
-- CORRIGE EL PIE DE 20261003180000 (:1361-1362), que decía «a la fecha, ninguna migración
-- posterior a esta existe en el árbol»: existen 20261003190000, 20261003190100, 20261003200000
-- (encargo X: `settlement_ledger_open`, `settled_ledger_gaps`, `fiscal_amount_gaps`,
-- `document_balance*`) y esta. De las funciones que la 180000 redefinía, esta vuelve a definir
-- `assert_document_immutable` y `ar_aging`; de las que creaba, `document_debt`,
-- `document_debt_today`, `customer_debt_today`, `treasury_currency_gaps`,
-- `treasury_currency_regularization_prepare` y `fx_revaluation_items`. Todas parten de su
-- definición en 20261003180000, la última por timestamp (ni 190000, ni 190100 las tocan).
-- NO toca `settlement_ledger_open`, `document_balance` ni `document_balance_transaction*`.
--
-- Qué cambia:
--   1. `platform.parameters`: los parámetros de plataforma, como DATO. Nace con uno: la
--      antigüedad máxima, en días, de la tasa de cierre.
--   2. `platform.closing_rate`: la tasa de cierre es la oficial más reciente no posterior a la
--      fecha y NO más vieja que ese margen. `rate_at` devolvía cualquier tasa vieja y el cierre
--      revaluaba con una tasa rancia sin avisar (H7).
--   3. `platform.fx_revaluation_items` NETEA por cuenta: una fila por cuenta con lo que el mayor
--      lleva (histórico + lo ya revaluado) y lo que debe llevar, y SOLO si hay diferencia. Antes
--      devolvía la diferencia contra el histórico completo y, aparte, lo ya revaluado con signo
--      contrario: reabrir y cerrar a la misma tasa asentaba ganancia y pérdida por el mismo
--      importe (H2). Y un documento `paid` no se revalúa por su residuo de céntimo (H14).
--   4. `platform.treasury_currency_gaps` dice en su enunciado qué pasa con un hecho EN COLA: la
--      caja = su subcuenta + lo que espera en la cola (H5).
--   5. El asiento de la regularización de la divisa deja de ser `manual` (reversible a mano):
--      origen propio `exchange_diff` / `treasury.currency_regularized`.
--   6. `paid → issued` solo cuando el documento, AHORA, debe en su moneda (H11).
--   7. La deuda sin tasa de hoy no lanza: el nominal se sirve y el equivalente va en NULL (H12).
-- =============================================================================

-- ── 1. Los parámetros de plataforma ──────────────────────────────────────────
create table platform.parameters (
  key        text        primary key,
  value      numeric     not null,
  note       text        not null,
  updated_at timestamptz not null default now(),
  constraint parameters_key_chk check (key ~ '^[a-z][a-z0-9_]{2,62}$'),
  constraint parameters_note_chk check (length(btrim(note)) >= 10)
);
comment on table platform.parameters is
  'Parámetros de plataforma que una regla necesita y que NO se escriben en código (regla 8 de '
  'CLAUDE.md). Cada fila dice en `note` de dónde sale su valor. Sin fila, la regla que la lee '
  'falla cerrada.';
revoke all on platform.parameters from public, anon, authenticated, ladino_api, ladino_worker;
grant select on platform.parameters to authenticated, ladino_api;

insert into platform.parameters (key, value, note) values
  ('closing_rate_max_age_days', 7,
   'Antigüedad máxima, en días, de la tasa oficial que se admite como tasa de cierre de un '
   || 'período (fines de semana y feriados largos sin publicación del BCV). Decidido por criterio '
   || '(ADR-0075 §6, H7): VALIDAR-CONTABLE, PENDIENTES_ASESOR P-88.');

-- ── 2. La tasa de cierre ─────────────────────────────────────────────────────
-- Granularidad: `date` contra `date`. `rate_date` es el día de la tasa; `p_as_of`, el día de
-- cierre que decide quien llama (closeFiscalPeriod: el menor entre el fin del período y hoy, día
-- de Caracas). Sin parámetro o sin tasa dentro del margen devuelve NULL, y quien llama se detiene.
create function platform.closing_rate(p_company uuid, p_from text, p_to text, p_as_of date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select f.rate
    from platform.rate_for(p_company, p_from, p_to, p_as_of, null) f
   where f.rate_date >= p_as_of - (select p.value::int from platform.parameters p
                                    where p.key = 'closing_rate_max_age_days')
$$;
comment on function platform.closing_rate(uuid, text, text, date) is
  'La tasa de CIERRE (ADR-0075 §6, H7): la oficial más reciente con rate_date <= fecha de cierre '
  'y no más antigua que platform.parameters.closing_rate_max_age_days. Fuera de ese margen '
  'devuelve NULL: el cierre se detiene y pide la tasa, no revalúa con una tasa vieja.';
revoke execute on function platform.closing_rate(uuid, text, text, date) from public;
grant execute on function platform.closing_rate(uuid, text, text, date)
  to authenticated, ladino_api;

-- ── 3. La revaluación al cierre, neta por cuenta ─────────────────────────────
-- Parte de la definición VIVA (20261003180000 §10, la única). Diferencias:
--   (a) una fila por CUENTA, y solo si su ajuste no es cero. En cuentas por cobrar y por pagar,
--       `carried` es lo que el mayor lleva de verdad: el histórico de sus documentos en divisa
--       MÁS lo ya revaluado en cierres anteriores. Desaparecen las filas `*_prior`;
--   (b) la tasa es `platform.closing_rate`, y solo se exige a lo que tiene saldo en divisa;
--   (c) un documento saldado (`paid`) no se revalúa, salvo que lo saldara un cobro o pago
--       POSTERIOR a la fecha de cierre (a esa fecha todavía debía). `document_debt` dice que un
--       `paid` debe cero: su residuo de último céntimo no es una partida monetaria.
-- `adjustment` sigue en términos de DÉBITO de la cuenta.
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
                                     and platform.caracas_day(p.paid_at) > p_as_of)))
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
end;
$$;
comment on function platform.fx_revaluation_items(uuid, date) is
  'ADR-0075 §6 (E-11, F-04, J-04; VEN-NIF PYME secc. 30): las partidas monetarias en divisa a una '
  'fecha de cierre —cajas, cuentas por cobrar y por pagar—, UNA FILA POR CUENTA y solo si hay '
  'diferencia: lo que el mayor lleva (histórico más lo ya revaluado), lo que debe llevar a la tasa '
  'de cierre (platform.closing_rate) y el ajuste en términos de débito. Sin diferencia, cero '
  'filas: reabrir y volver a cerrar a la misma tasa no asienta nada. No guarda estado.';

-- ── 4. J-04 con la cola en el enunciado ──────────────────────────────────────
-- 4.1 Lo que un hecho EN COLA le debe todavía al mayor de una caja, en la moneda de la caja y
-- con el mismo signo con que ya movió su saldo (`recompute_account_balance`, 20261003180000 §6).
-- Un cobro reversado no aparece: su fila de cola se descartó con él.
create function platform.treasury_queue_pending(p_company uuid, p_account uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(x.amount), 0)
    from (
      select p.amount
        from public.journal_generation_queue q
        join public.payments p on p.id = q.source_id and p.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'payment_received' and p.account_id = p_account
      union all
      select ip.amount
        from public.journal_generation_queue q
        join public.igtf_perceptions ip on ip.id = q.source_id and ip.company_id = q.company_id
        join public.payments p on p.id = ip.payment_id and p.company_id = ip.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'igtf_perception' and p.account_id = p_account and not ip.absorbed
      union all
      select -sp.net_amount
        from public.journal_generation_queue q
        join public.supplier_payments sp on sp.id = q.source_id and sp.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'payment_made' and sp.account_id = p_account
      union all
      select -e.amount_transaction_currency
        from public.journal_generation_queue q
        join public.expenses e on e.id = q.source_id and e.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'expense' and e.account_id = p_account
      union all
      select c.amount_transaction_currency
        from public.journal_generation_queue q
        join public.cash_closings c on c.id = q.source_id and c.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'cash_closing' and c.account_id = p_account
      union all
      select -r.amount_transaction_currency
        from public.journal_generation_queue q
        join public.customer_refunds r on r.id = q.source_id and r.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'customer_refund' and r.account_id = p_account
      union all
      select case when t.to_account_id = p_account then t.amount_transaction_currency
                  else -t.amount_transaction_currency end
        from public.journal_generation_queue q
        join public.treasury_transfers t on t.id = q.source_id and t.company_id = q.company_id
       where q.company_id = p_company and q.status = 'pending'
         and q.source_kind = 'treasury_transfer'
         and p_account in (t.from_account_id, t.to_account_id)
    ) x
$$;
comment on function platform.treasury_queue_pending(uuid, uuid) is
  'Lo que los hechos PENDIENTES de contabilizar (journal_generation_queue) ya movieron en el saldo '
  'de una cuenta de tesorería y todavía no están en el mayor, en la moneda de la cuenta. Lo usa '
  'platform.treasury_currency_gaps (ADR-0075 §6).';
revoke execute on function platform.treasury_queue_pending(uuid, uuid) from public;
grant execute on function platform.treasury_queue_pending(uuid, uuid)
  to authenticated, ladino_api, ladino_worker;

-- 4.2 El invariante. Parte de la definición VIVA (20261003180000 §9.3). Única diferencia: lo que
-- espera en la cola cuenta del lado del mayor. `ledger_original` es ahora «lo que el mayor lleva
-- más lo que la cola le debe».
create or replace function platform.treasury_currency_gaps(p_company uuid)
returns table (account_id uuid, account_name text, currency text,
               treasury_balance numeric, ledger_original numeric)
language sql
stable
set search_path = ''
as $$
  select ca.id, ca.name, ca.currency, coalesce(b.balance, 0), x.original
    from public.company_accounts ca
    left join public.company_account_balances b on b.account_id = ca.id
    cross join lateral (
      select platform.treasury_ledger_original(p_company, ca.ledger_account_id, ca.currency, null)
             + platform.treasury_queue_pending(p_company, ca.id) as original) x
   where ca.company_id = p_company
     and ca.ledger_account_id is not null
     and coalesce(b.balance, 0) <> x.original
$$;
comment on function platform.treasury_currency_gaps(uuid) is
  'INVARIANTE tesorería ↔ mayor en la moneda de la caja (ADR-0075 §6, J-04). Debe dar 0 filas, '
  'sin corte y sin lista: el saldo de cada cuenta de tesorería con cuenta contable = Σ de los '
  'importes originales, en la moneda de la caja, de las líneas de su subcuenta (asientos posteados '
  'y reversados) MÁS lo que sus hechos pendientes de contabilizar (la cola) todavía le deben al '
  'mayor. Un hecho en cola no es un hueco: es contabilidad pendiente, y la vigila '
  'accounting_coverage_gaps. ledger_original devuelve esa suma (mayor + cola).';

-- ── 5. La regularización de la divisa no es un asiento manual ────────────────
-- Parte de la definición VIVA (20261003180000 §9.4). Diferencias:
--   (a) el asiento nace `exchange_diff` / `treasury.currency_regularized` con su `source_id`, no
--       `manual`: un asiento manual se reversa suelto con `accounting.entry.reverse`, y reversar
--       este rompe el invariante de 4.2. Uno generado solo se corrige desde su origen (como
--       `inventory_move` / `stock.cent_regularized`);
--   (b) la cola pendiente ya no salta la empresa: el invariante la cuenta, así que lo que falta
--       por regularizar es exactamente lo anterior a E-11.
create or replace function platform.treasury_currency_regularization_prepare(p_company uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_co      public.companies;
  v_fecha   date := (now() at time zone 'America/Caracas')::date;
  v_periodo uuid;
  v_entry   uuid;
  v_linea   integer := 0;
  v_g       record;
  v_func    numeric;
  v_f       numeric;
  v_rate    numeric;
  v_acta    jsonb := '[]'::jsonb;
  v_sin     jsonb := '[]'::jsonb;
begin
  select * into v_co from public.companies where id = p_company;
  if v_co.id is null then
    return jsonb_build_object('company_id', p_company, 'regularized', false, 'skipped', 'no_company');
  end if;
  if not exists (select 1 from platform.treasury_currency_gaps(p_company) g
                  where g.currency <> v_co.functional_currency_code) then
    return jsonb_build_object('company_id', p_company, 'regularized', false);
  end if;
  if exists (select 1 from public.fiscal_periods fp
              where fp.company_id = p_company and fp.status = 'closed'
                and fp.year = extract(year from v_fecha)::int
                and fp.month = extract(month from v_fecha)::int) then
    return jsonb_build_object('company_id', p_company, 'regularized', false,
                              'skipped', 'periodo_cerrado');
  end if;

  for v_g in
    select g.account_id, g.account_name, g.currency, ca.ledger_account_id,
           g.treasury_balance - g.ledger_original as gap
      from platform.treasury_currency_gaps(p_company) g
      join public.company_accounts ca on ca.id = g.account_id
     where g.currency <> v_co.functional_currency_code
     order by g.account_id
  loop
    -- El importe funcional de la línea en divisa: el que la subcuenta ya lleva, si tiene el
    -- mismo signo que lo que falta; si no, lo que falta a la tasa de hoy.
    select r.balance into v_func from platform.recompute_ledger(p_company, v_g.ledger_account_id) r;
    v_func := coalesce(v_func, 0);
    if v_func <> 0 and sign(v_func) = sign(v_g.gap) then
      v_f := platform.round_cents(abs(v_func));
    else
      v_rate := platform.rate_at(p_company, v_g.currency, v_co.functional_currency_code, v_fecha);
      v_f := platform.round_cents(abs(v_g.gap) * v_rate);
    end if;
    if v_f is null or v_f <= 0 or round(v_f / abs(v_g.gap), 8) <= 0 then
      v_sin := v_sin || jsonb_build_object('company_account_id', v_g.account_id,
                                           'account_name', v_g.account_name);
      continue;
    end if;
    if v_entry is null then
      v_periodo := platform.period_for_date(p_company, v_fecha);
      insert into public.journal_entries
        (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
         description, memo, rules_version)
      values (v_co.tenant_id, p_company, v_periodo, v_fecha, 'exchange_diff', platform.uuidv7(),
              'treasury.currency_regularized',
              'Regularización: el saldo en divisa de cada caja pasa al mayor (ADR-0075 §6)',
              'Asiento del sistema. No mueve dinero ni cambia el saldo en bolívares de ninguna '
              || 'cuenta: escribe en cada subcuenta de caja en divisa su importe original.',
              coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
      returning id into v_entry;
    end if;
    -- La línea en la divisa.
    v_linea := v_linea + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_co.tenant_id, p_company, v_entry, v_linea, v_g.ledger_account_id,
            case when v_g.gap > 0 then abs(v_g.gap) else 0 end,
            case when v_g.gap < 0 then abs(v_g.gap) else 0 end,
            abs(v_g.gap), v_g.currency, round(v_f / abs(v_g.gap), 8), v_f,
            v_co.functional_currency_code, 'regularizacion-adr-0075', now(),
            case when v_g.gap > 0 then v_f else 0 end,
            case when v_g.gap < 0 then v_f else 0 end,
            'Saldo en ' || v_g.currency || ' de «' || v_g.account_name || '»');
    -- Su contraria, en la misma subcuenta y en moneda funcional.
    v_linea := v_linea + 1;
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    values (v_co.tenant_id, p_company, v_entry, v_linea, v_g.ledger_account_id,
            case when v_g.gap < 0 then v_f else 0 end,
            case when v_g.gap > 0 then v_f else 0 end,
            v_f, v_co.functional_currency_code, 1, v_f,
            v_co.functional_currency_code, 'identidad', now(),
            case when v_g.gap < 0 then v_f else 0 end,
            case when v_g.gap > 0 then v_f else 0 end,
            'Lo que «' || v_g.account_name || '» tenía asentado solo en moneda funcional');
    v_acta := v_acta || jsonb_build_object(
      'company_account_id', v_g.account_id, 'account_name', v_g.account_name,
      'currency', v_g.currency, 'original', v_g.gap::text, 'functional', v_f::text);
  end loop;

  return jsonb_build_object(
    'company_id', p_company, 'regularized', v_entry is not null, 'entry_id', v_entry,
    'posting_date', v_fecha, 'accounts', v_acta, 'without_rate', v_sin);
end;
$$;
comment on function platform.treasury_currency_regularization_prepare(uuid) is
  'ADR-0075 §6 (J-04): prepara, en BORRADOR, el asiento que lleva al mayor el saldo en divisa de '
  'cada caja anterior a E-11. Idempotente (sin hueco no escribe). Lo postea el dominio. El asiento '
  'es exchange_diff / treasury.currency_regularized: no es manual y no se reversa suelto.';

-- ── 6. `paid → issued` solo si el documento debe AHORA ───────────────────────
-- Parte de la definición VIVA (20261003180000 §4). Única diferencia: no basta con que el
-- documento tenga CUALQUIER reversa histórica; además su saldo en la moneda del documento tiene
-- que ser mayor que cero en este momento (la reversa lo reabre ahora). Con una reversa vieja y
-- el documento otra vez saldado, `paid → issued` reabría una factura que no debe nada.
create or replace function platform.assert_document_immutable()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if old.status in ('issued', 'paid', 'annulled') then
      raise exception
        'un documento emitido no se borra: se anula, y su número se conserva (ADR-0037)'
        using errcode = 'LAD06';
    end if;
    return old;
  end if;

  if old.status in ('draft', 'confirmed', 'cancelled') then
    return new;  -- un borrador sí se edita: todavía no es un documento fiscal
  end if;

  -- A partir de aquí, old.status es issued | paid | annulled.
  if new.document_number is distinct from old.document_number
     or new.control_number is distinct from old.control_number
     or new.kind is distinct from old.kind
     or new.series is distinct from old.series
     or new.customer_id is distinct from old.customer_id
     or new.issued_at is distinct from old.issued_at
     or new.total_amount is distinct from old.total_amount
     or new.subtotal_amount is distinct from old.subtotal_amount
     or new.tax_amount is distinct from old.tax_amount
     or new.fx_rate is distinct from old.fx_rate
     or new.regime_version_id is distinct from old.regime_version_id
     or new.rules_version is distinct from old.rules_version then
    raise exception
      'la identidad fiscal de un documento emitido es inmutable: número, control, cliente, importes, tasa y anclas de versión no se tocan. Corrige con nota de crédito o débito.'
      using errcode = 'LAD06',
            hint = 'FISCAL_DOCUMENTS_SPEC: issued → adjusted vía NC/ND, nunca editando';
  end if;

  if not (
    (old.status = 'issued'   and new.status in ('issued', 'paid', 'annulled'))
    or (old.status = 'paid'    and new.status in ('paid', 'annulled'))
    -- paid → issued: solo si el documento tiene un cobro reversado Y, por eso, vuelve a deber
    -- AHORA en su moneda (ADR-0075 §8, H11). No es «editar la factura»: dejó de estar pagada.
    or (old.status = 'paid'    and new.status = 'issued'
        and exists (select 1 from public.payment_reversals r where r.document_id = old.id)
        and coalesce(platform.document_balance_transaction_at(old.company_id, old.id, null), 0) > 0)
    or (old.status = 'annulled' and new.status = 'annulled')
  ) then
    raise exception 'transición de estado no permitida: % → %', old.status, new.status
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;

-- ── 7. La deuda sin tasa de hoy no se cae (H12) ──────────────────────────────
-- 7.1 LA función de deuda. Parte de la definición VIVA (20261003180000 §5.3). Única diferencia:
-- sin tasa de hoy para un documento en divisa NO lanza LAD51: devuelve el nominal, con `rate` y
-- `functional_today` en NULL. Una lista de clientes no se cae por una tasa; la pantalla dice
-- «falta la tasa de hoy». Un documento en moneda funcional nunca necesitó tasa.
create or replace function platform.document_debt(p_company uuid, p_document uuid)
returns table (currency text, nominal numeric, functional_currency text,
               rate numeric, rate_date date, functional_today numeric)
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
  v_saldo_tx numeric;
  v_escala int;
  v_hoy date := platform.caracas_day(now());
  v_func numeric;
begin
  select d.status, d.transaction_currency, d.functional_currency, d.fx_rate,
         d.amount_transaction_currency, d.total_amount
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return; end if;

  v_escala := platform.currency_minor_units(v_doc.functional_currency);

  -- ADR-0075 §4: un documento pagado está CERRADO. No debe nada, ni un residuo, ni lo que una
  -- tasa cargada después diga. Si un cobro se reversa, el documento vuelve a `issued` y debe.
  if v_doc.status = 'paid' then
    return query select v_doc.transaction_currency,
                        round(0::numeric, platform.currency_minor_units(v_doc.transaction_currency)),
                        v_doc.functional_currency, null::numeric, v_hoy,
                        round(0::numeric, v_escala);
    return;
  end if;

  if v_doc.transaction_currency = v_doc.functional_currency then
    v_func := round(platform.document_balance(p_company, p_document), v_escala);
    return query select v_doc.transaction_currency, v_func, v_doc.functional_currency,
                        1::numeric, v_hoy, v_func;
    return;
  end if;

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null);

  v_rate := platform.rate_at(p_company, v_doc.transaction_currency, v_doc.functional_currency,
                             v_hoy);
  if v_rate is null then
    -- Sin tasa de hoy: el nominal se debe igual; su equivalente funcional no se inventa.
    return query select v_doc.transaction_currency,
                        round(v_saldo_tx, platform.currency_minor_units(v_doc.transaction_currency)),
                        v_doc.functional_currency, null::numeric, v_hoy, null::numeric;
    return;
  end if;

  if v_doc.amount_transaction_currency is null or v_doc.amount_transaction_currency = 0
     or v_doc.fx_rate is null or v_doc.fx_rate = 0 then
    v_func := round(v_saldo_tx * v_rate, v_escala);
  else
    -- La deuda es la PARTE del total que sigue debiéndose, reindexada por la tasa: a la tasa de
    -- emisión y sin cobros da exactamente `total_amount` (ADR-0063 §4).
    v_func := round(
      v_doc.total_amount
        * (v_saldo_tx / v_doc.amount_transaction_currency)
        * (v_rate / v_doc.fx_rate),
      v_escala);
  end if;
  return query select v_doc.transaction_currency,
                      round(v_saldo_tx, platform.currency_minor_units(v_doc.transaction_currency)),
                      v_doc.functional_currency, v_rate, v_hoy, v_func;
end;
$$;
comment on function platform.document_debt(uuid, uuid) is
  'LA función de deuda (ADR-0075 §5, F-04). Una fila por documento emitido: lo que se debe en la '
  'moneda del documento (nominal) y, SOLO PARA MOSTRAR, su valor en moneda funcional a la tasa de '
  'hoy, con la tasa y la fecha. Un documento pagado debe cero. Sin tasa de hoy, rate y '
  'functional_today van en NULL y el nominal se sirve igual (H12). Toda pantalla y todo aviso al '
  'cliente salen de aquí.';

comment on function platform.document_debt_today(uuid, uuid) is
  'Lo que el cliente debe HOY por este documento, en moneda funcional: la columna '
  'functional_today de platform.document_debt (la única función de deuda, ADR-0075 §5). NULL si '
  'el documento está en divisa y no hay tasa de hoy.';

-- 7.2 La antigüedad. Parte de la definición VIVA (20261003180000 §5.4). Diferencias: envejece lo
-- que debe en su NOMINAL (antes, lo que debía en funcional: sin tasa lanzaba), y el importe de un
-- tramo con algún documento sin tasa de hoy va en NULL — nunca una suma parcial que parezca el
-- total. La escala de `amount` es la de siempre, numeric(24,8) (pgTAP 045 la asevera).
create or replace function platform.ar_aging(
  p_company uuid, p_customer uuid default null,
  p_reference date default (now() at time zone 'America/Caracas')::date
)
returns table (
  customer_id uuid, bucket text, document_count bigint, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select d.customer_id, d.id,
           (p_reference - platform.caracas_day(d.issued_at)) as dias,
           dd.nominal,
           -- LA deuda (ADR-0075 §5): la misma cifra que la ficha, la lista y el aviso. El cast
           -- conserva la escala de la columna (numeric(24,8)) que esta función siempre devolvió.
           dd.functional_today::numeric(24,8) as saldo
      from public.documents d
     cross join lateral platform.document_debt(p_company, d.id) dd
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and platform.caracas_day(d.issued_at) <= p_reference
  )
  select s.customer_id,
         case when s.dias <= 30 then '0-30'
              when s.dias <= 60 then '31-60'
              when s.dias <= 90 then '61-90'
              else '90+' end,
         count(*),
         case when bool_or(s.saldo is null) then null else sum(s.saldo) end
    from saldos s
   where s.nominal > 0
   group by 1, 2
   order by 1, 2
$$;

-- 7.3 La deuda de un cliente. Parte de la definición VIVA (20261003180000 §5.5). Diferencias:
-- (a) NULL si algún documento que debe está en divisa y no hay tasa de hoy (una suma sin él
-- parecería el total); (b) cada documento aporta `greatest(deuda, 0)`, como hacía la lista de
-- clientes antes de 20261003180000 y como hace la antigüedad: un documento con saldo negativo no
-- le resta deuda a otro.
create or replace function platform.customer_debt_today(p_company uuid, p_customer uuid default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when bool_or(dd.nominal > 0 and dd.functional_today is null) then null
              else coalesce(sum(greatest(dd.functional_today, 0)), 0) end
    from public.documents d
   cross join lateral platform.document_debt(p_company, d.id) dd
   where d.company_id = p_company
     and (p_customer is null or d.customer_id = p_customer)
     and d.kind in ('invoice', 'receipt', 'debit_note')
     and d.status in ('issued', 'paid')
$$;
comment on function platform.customer_debt_today(uuid, uuid) is
  'Lo que un cliente (o todos, con NULL) debe HOY, en moneda funcional: Σ de la deuda de cada '
  'factura, recibo y nota de débito por platform.document_debt (ADR-0075 §5, F-04), sin que un '
  'saldo negativo reste. NULL si algo de lo que debe está en divisa y no hay tasa de hoy.';

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Las funciones (3, 4.2, 5, 6, 7) vuelven a su definición de 20261003180000 con otra
--     migración; `closing_rate`, `treasury_queue_pending` y `platform.parameters` se sueltan
--     después (nada más las lee). Ninguna guarda estado.
--   · Lo que NO se revierte: los asientos de revaluación posteados con la regla nueva (netos,
--     con tasa de cierre fresca y fecha = min(fin del período, hoy)) y los de regularización
--     nacidos `exchange_diff`. Son asientos posteados: se corrigen con su reversa. Volver a la
--     función vieja tras cierres con la nueva es seguro (las dos calculan «debe llevar − lleva»),
--     pero reaparece el asiento de cuatro líneas que se anula a sí mismo.
--   · Los asientos de regularización YA posteados como `manual` (los de la base local y los que
--     el dueño corriera antes de esta migración) siguen siendo `manual`: `journal_entries` no se
--     edita. Siguen siendo reversibles a mano; el invariante 4.2 lo delata si alguien lo hace.
--   · Con la API vieja y esta migración: `closeFiscalPeriod` viejo lee `fx_revaluation_items` con
--     las mismas columnas y arma sus líneas por fila — funciona, ya neto. La API vieja pasa el
--     fin del período como fecha: un cierre anticipado se detiene por falta de tasa (ruidoso).
-- Funciones que esta migración redefine: fx_revaluation_items, treasury_currency_gaps,
-- treasury_currency_regularization_prepare, assert_document_immutable, document_debt, ar_aging,
-- customer_debt_today. Crea: closing_rate, treasury_queue_pending.
-- =============================================================================
