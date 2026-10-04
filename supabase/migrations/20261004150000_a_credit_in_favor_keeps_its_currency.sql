-- Módulo: ventas · cobros, saldos a favor y estado de cuenta   Spec: docs/00_GOVERNANCE/adr/ADR-0075-*
-- Ola 4 · F-10, F-12, G-05, G-15 (RESPUESTA_RECORRIDO_2026-09-24 §2.7; ADR-0075 §4)
-- Reversible: ver el pie (con datos vivos)   Homologación: YES (cambia asientos de cobros y
-- reembolsos; no cambia ningún documento fiscal ni su numeración)
--
-- Qué hace:
--   1. customer_credits guarda la tasa con que nació, su fuente, su importe funcional y, si nació
--      de un pago de más, el cobro que lo creó (G-05, F-10). El saldo a favor conserva la MONEDA
--      DEL DOCUMENTO que lo originó. Los que ya existen están en moneda funcional y se quedan así:
--      para ellos «sin tasa» ES la identidad (no hay clientes reales ni transición).
--   2. customer_refunds guarda lo que el reembolso consumió del saldo a favor (en su moneda y en
--      funcional, a la tasa con que nació) y el diferencial contra lo que salió de la caja (G-15).
--   3. payments guarda cuánto de lo que entró nació como saldo a favor (F-10) y cuánto canceló de
--      cuentas por cobrar en el mayor (F-12). Columnas nuevas, nulas en lo anterior.
--   4. platform.document_balance no cuenta como abono lo que nació como saldo a favor.
--   5. La plantilla del reembolso (ar.credit_refunded) baja el pasivo a la tasa con que nació y
--      lleva la diferencia con lo que salió de caja al diferencial cambiario.
--   6. platform.fx_revaluation_items revalúa también los saldos a favor en divisa (pasivo).
--   7. INVARIANTE nuevo, platform.receivables_ledger_gap (F-12).
--
-- «Expand»: solo añade columnas y redefine funciones de lectura. DOS salvedades, que obligan a
-- aplicar esta migración JUSTO DESPUÉS del git pull:
--   · la plantilla del reembolso pasa a pedir «total»: la API anterior solo aportaba
--     «functional_amount» y su reembolso de saldo a favor respondería 422 hasta desplegar (el
--     generador nuevo toma «functional_amount» cuando una fila vieja de la cola no trae «total»);
--   · el único de customer_credits por documento de origen pasa a ser parcial (la API anterior no
--     escribe source_payment_id: para ella vale igual).
--
-- Funciones que redefine, cada una sobre su ÚLTIMA definición en el orden limpio:
--   · platform.document_balance      ← 20261003180000 §5.2 (ninguna posterior la toca)
--   · platform.fx_revaluation_items  ← 20261003210200 §4   (ninguna posterior la toca)
-- No lee nada que cree una migración posterior. La línea de plantilla del pago de más (un importe
-- nuevo, «credit_surplus») NO va aquí: 20261004180000 reconstruye el CHECK de amount_source con
-- su lista y rechaza (LAD82) lo que no conoce; va en 20261004190000, que corre después.

-- ── 1. El saldo a favor guarda su moneda, su tasa y de dónde nació ───────────
alter table public.customer_credits
  add column fx_rate numeric(24,8),
  add column rate_source text,
  add column functional_amount numeric(24,8),
  add column source_payment_id uuid,
  add constraint customer_credits_fx_rate_chk check (fx_rate is null or fx_rate > 0),
  add constraint customer_credits_functional_chk
    check (functional_amount is null or functional_amount > 0),
  -- La tasa, su fuente y el importe funcional van juntos o no van (lo anterior a esta migración).
  add constraint customer_credits_rate_whole_chk check (
    (fx_rate is null and rate_source is null and functional_amount is null)
    or (fx_rate is not null and rate_source is not null and functional_amount is not null)),
  add constraint customer_credits_payment_fk
    foreign key (company_id, source_payment_id) references public.payments (company_id, id);
comment on column public.customer_credits.fx_rate is
  'G-05 (ADR-0075 §4): la tasa moneda del saldo → moneda funcional con que NACIÓ (la del documento '
  'o del cobro que lo creó). NULL = saldo a favor anterior a 20261004150000, en moneda funcional: '
  'la identidad.';
comment on column public.customer_credits.functional_amount is
  'Lo que el mayor cargó al pasivo con el cliente cuando el saldo a favor nació.';
comment on column public.customer_credits.source_payment_id is
  'F-10: el cobro cuyo sobrante nació como este saldo a favor. NULL = nació de una nota de '
  'crédito o de una devolución (source_document_id es esa nota).';

-- Un saldo a favor por nota (como siempre) y uno por cobro con sobrante. La clave natural de las
-- dos operaciones (skill caso-de-uso): la reejecución directa muere aquí.
alter table public.customer_credits drop constraint customer_credits_source_key;
create unique index customer_credits_source_key
  on public.customer_credits (source_document_id) where source_payment_id is null;
create unique index customer_credits_source_payment_key
  on public.customer_credits (source_payment_id) where source_payment_id is not null;

-- ── 2. El reembolso guarda lo que consumió y su diferencial ──────────────────
alter table public.customer_refunds
  add column credit_amount numeric(24,8),
  add column credit_currency text,
  add column credit_functional_amount numeric(24,8),
  add column exchange_difference numeric(24,8) not null default 0,
  add constraint customer_refunds_credit_amount_chk
    check (credit_amount is null or credit_amount > 0),
  add constraint customer_refunds_credit_currency_fk
    foreign key (credit_currency) references public.currencies (code),
  add constraint customer_refunds_credit_whole_chk check (
    (credit_amount is null and credit_currency is null and credit_functional_amount is null)
    or (credit_amount is not null and credit_currency is not null
        and credit_functional_amount is not null));
comment on column public.customer_refunds.credit_amount is
  'G-15: lo que el reembolso consumió del saldo a favor, EN LA MONEDA DEL SALDO. Los importes de '
  'siempre (amount_transaction_currency, fx_rate, functional_amount) son el dinero que salió de la '
  'caja, en la moneda de la caja y a la tasa del día. NULL = reembolso anterior a 20261004150000: '
  'saldo y caja en la misma moneda, mismo importe.';
comment on column public.customer_refunds.exchange_difference is
  'Lo que bajó del pasivo (a la tasa con que nació el saldo) − lo que salió de la caja (a la tasa '
  'del día), en moneda funcional. Positivo = ganancia en diferencial cambiario.';

-- ── 3. El cobro guarda lo que nació como saldo a favor y lo que canceló ──────
alter table public.payments
  add column credited_functional_amount numeric(24,8),
  add column cancelled_functional_amount numeric(24,8),
  add constraint payments_credited_chk
    check (credited_functional_amount is null
           or (credited_functional_amount > 0
               and credited_functional_amount < functional_amount));
comment on column public.payments.credited_functional_amount is
  'F-10: la parte de functional_amount que NO abonó el documento porque el cliente pagó de más: '
  'nació como saldo a favor (customer_credits.source_payment_id). NULL = nada.';
comment on column public.payments.cancelled_functional_amount is
  'F-12: lo que este cobro canceló de cuentas por cobrar en el mayor, en moneda funcional (lo que '
  'entró − el diferencial − lo que nació como saldo a favor). NULL = cobro anterior a '
  '20261004150000: lo dice su asiento.';

-- ── 4. El saldo funcional no cuenta el sobrante como abono ───────────────────
-- Parte de la definición VIVA (20261003180000 §5.2). Única diferencia: resta de cada cobro lo que
-- nació como saldo a favor.
create or replace function platform.document_balance(p_company uuid, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select d.total_amount
         - coalesce((select sum(p.functional_amount - coalesce(p.credited_functional_amount, 0))
                       from public.payments p
                      where p.document_id = d.id
                        and not exists (select 1 from public.payment_reversals pr
                                         where pr.payment_id = p.id)), 0)
         - coalesce((select sum(ip.functional_amount) from public.igtf_perceptions ip
                      where ip.company_id = d.company_id and ip.debit_note_id = d.id), 0)
    from public.documents d
   where d.id = p_document and d.company_id = p_company and d.status in ('issued', 'paid')
$$;
comment on function platform.document_balance(uuid, uuid) is
  'Saldo pendiente = total − Σ cobros NO reversados (sin la parte que nació como saldo a favor, '
  'F-10) − la percepción que paga una ND por IGTF, en moneda funcional. Calculado, nunca '
  'persistido. Para ENSEÑAR una deuda se usa platform.document_debt (ADR-0075 §5), no esta cifra.';

-- ── 5. La plantilla del reembolso: el pasivo a su tasa, y el diferencial ─────
do $$
declare
  v_ref uuid;
begin
  select id into v_ref from public.journal_template_preset_entries
   where preset_code = 've_basico' and source_kind = 'customer_refund'
     and source_event = 'ar.credit_refunded';
  if v_ref is null then
    raise exception 'LAD83: falta en el preset ve_basico el reembolso de saldo a favor'
      using errcode = 'LAD83';
  end if;
  update public.journal_template_preset_lines
     set amount_source = 'total',
         description = 'Se le deja de deber al cliente, a la tasa con que nació el saldo a favor'
   where entry_id = v_ref and account_purpose = 'customer_credit_liability'
     and amount_source = 'functional_amount';
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  select v_ref, (select max(line_number) from public.journal_template_preset_lines
                  where entry_id = v_ref) + n.orden,
         n.purpose, 'exchange_difference', n.side, n.cond, n.descr
    from (values
      (1, 'exchange_gain', 'credit', 'if_positive',
       'Salió de la caja menos de lo que pesaba el saldo a favor: ganancia en diferencial cambiario'),
      (2, 'exchange_loss', 'debit',  'if_negative',
       'Salió de la caja más de lo que pesaba el saldo a favor: pérdida en diferencial cambiario')
    ) as n(orden, purpose, side, cond, descr)
   where not exists (select 1 from public.journal_template_preset_lines l
                      where l.entry_id = v_ref and l.amount_source = 'exchange_difference');
end $$;

-- Las empresas que ya importaron la plantilla. No se reescribe entera (una empresa pudo ajustar
-- la suya): se corrige la línea del pasivo si sigue como nació y se añaden las del diferencial si
-- no las tiene. Con acta.
do $$
declare
  v_t record;
  v_cambio boolean;
  v_n integer;
begin
  for v_t in
    select t.id, t.tenant_id, t.company_id
      from public.journal_templates t
     where t.effective_to is null
       and t.source_kind = 'customer_refund' and t.source_event = 'ar.credit_refunded'
  loop
    update public.journal_template_lines
       set amount_source = 'total',
           description = 'Se le deja de deber al cliente, a la tasa con que nació el saldo a favor'
     where template_id = v_t.id and account_purpose = 'customer_credit_liability'
       and amount_source = 'functional_amount';
    get diagnostics v_n = row_count;
    v_cambio := v_n > 0;
    if not exists (select 1 from public.journal_template_lines l
                    where l.template_id = v_t.id and l.amount_source = 'exchange_difference') then
      select coalesce(max(line_number), 0) into v_n
        from public.journal_template_lines where template_id = v_t.id;
      insert into public.journal_template_lines
        (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
         side, condition_kind, description)
      values
        (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 1, 'exchange_gain',
         'exchange_difference', 'credit', 'if_positive',
         'Salió de la caja menos de lo que pesaba el saldo a favor: ganancia en diferencial cambiario'),
        (v_t.tenant_id, v_t.company_id, v_t.id, v_n + 2, 'exchange_loss',
         'exchange_difference', 'debit', 'if_negative',
         'Salió de la caja más de lo que pesaba el saldo a favor: pérdida en diferencial cambiario');
      v_cambio := true;
    end if;
    if v_cambio then
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
              'accounting.templates_imported', 'system', now(), 'db-migration',
              jsonb_build_object('origin', 'migration_20261004150000', 'preset_code', 've_basico',
                                 'facts', 'ar.credit_refunded',
                                 'motivo', 'el reembolso de un saldo a favor reconoce su diferencial (G-05, G-15)'));
    end if;
  end loop;
end $$;

-- ── 6. La revaluación al cierre incluye los saldos a favor en divisa ─────────
-- Parte de la definición VIVA (20261003210200 §4, la última), copiada entera. Única diferencia: el
-- bloque final, «LOS SALDOS A FAVOR EN DIVISA». Las cajas y las cuentas por cobrar y por pagar no
-- cambian.
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
  -- reembolsado, día de Caracas contra día. Lo que el mayor lleva = lo que queda × la tasa con que
  -- nació, menos lo ya revaluado en la cuenta. Un saldo a favor en moneda funcional (todos los
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
             sum(platform.round_cents(x.resto * x.fx_rate)) as historico
        from (
          select cc.currency, cc.fx_rate,
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
  '(G-05) los saldos a favor de clientes en divisa. adjustment va en términos de débito.';

-- ── 7. F-12 · INVARIANTE: la cartera por documento es la cuenta por cobrar del mayor ─────────
create function platform.receivables_ledger_gap(p_company uuid)
returns table (documents numeric, ledger numeric, gap numeric, queued numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: en una empresa con cuenta de cuentas por cobrar (papel ar_general),
  --     Σ, sobre los documentos de venta vigentes que cargan cartera y tienen asiento, de su total
  --   − Σ, sobre sus cobros vivos con asiento, de lo que cada uno canceló
  --   = el saldo de las cuentas ar_general en el mayor.
  -- Con estas precisiones, que son parte del enunciado y no perdones:
  --   · cargan cartera la factura, el recibo y la nota de débito (emitidos o pagados). La nota de
  --     débito por IGTF no: su asiento es el de su percepción, caja contra el pasivo con el fisco;
  --   · lo que canceló un cobro es payments.cancelled_functional_amount; en los cobros anteriores a
  --     20261004150000, que no lo guardan, lo que su asiento acreditó a esas cuentas;
  --   · un cobro reversado no es un cobro, y su asiento y su contra-asiento se anulan en el mayor;
  --   · el mayor se toma sin la revaluación al cierre (es por cuenta y moneda, no por documento:
  --     ADR-0075 §6) y sin el asiento de la regularización del céntimo (ADR-0075 §7);
  --   · lo que está en la cola de pendientes no entra en ninguno de los dos lados: `queued` dice
  --     cuánto es, y de que no se pierda responde accounting_coverage_gaps.
  -- Una fila solo si hay diferencia. Sin lista de exclusiones: un asiento manual sobre la cuenta
  -- por cobrar, o cualquier hecho que la mueva sin ser un documento o un cobro, da fila.
  with cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'ar_general'
  ),
  docs as (
    select d.id, d.total_amount,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.id = d.journal_entry_id
                      and e.status = 'posted') as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as en_cola
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and not exists (select 1 from public.igtf_perceptions ip
                        where ip.company_id = p_company and ip.debit_note_id = d.id)
  ),
  cobros as (
    select p.id,
           coalesce(
             p.cancelled_functional_amount,
             (select sum(jl.functional_credit - jl.functional_debit)
                from public.journal_entries e
                join public.journal_lines jl on jl.entry_id = e.id
               where e.company_id = p_company and e.source_kind = 'payment_received'
                 and e.source_id = p.id and e.status = 'posted'
                 and jl.account_id in (select c.account_id from cuentas c)),
             p.functional_amount
               - coalesce((select sum(g.difference) from public.exchange_gain_loss g
                            where g.payment_id = p.id), 0)) as cancelado,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.source_kind = 'payment_received'
                      and e.source_id = p.id and e.status = 'posted') as con_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = p.id
                      and q.status = 'pending') as en_cola
      from public.payments p
     where p.company_id = p_company
       and p.document_id in (select d.id from docs d)
       and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)
  ),
  esperado as (
    select coalesce((select sum(d.total_amount) from docs d where d.con_asiento), 0)
           - coalesce((select sum(c.cancelado) from cobros c where c.con_asiento), 0) as v,
           coalesce((select sum(d.total_amount) from docs d
                      where d.en_cola and not d.con_asiento), 0)
           - coalesce((select sum(c.cancelado) from cobros c
                        where c.en_cola and not c.con_asiento), 0) as cola
  ),
  mayor as (
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as v
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
  select esperado.v, mayor.v, esperado.v - mayor.v, esperado.cola
    from esperado, mayor
   where exists (select 1 from cuentas)
     and esperado.v - mayor.v <> 0
$$;
comment on function platform.receivables_ledger_gap(uuid) is
  'INVARIANTE (F-12): Σ por documento de venta con asiento (total − lo que cancelaron sus cobros '
  'vivos con asiento) = saldo de las cuentas por cobrar del mayor, sin la revaluación al cierre ni '
  'la regularización del céntimo. La ND por IGTF no carga cartera. Lo que está en la cola va en '
  '`queued` y no entra en la comparación. Cero filas.';
revoke all on function platform.receivables_ledger_gap(uuid) from public;
grant execute on function platform.receivables_ledger_gap(uuid) to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Las columnas nuevas de customer_credits, customer_refunds y payments se pueden soltar SOLO
--     mientras no exista un saldo a favor en divisa, un reembolso en otra moneda o un cobro con
--     sobrante: desde entonces son el único sitio donde vive la tasa con que nació el pasivo, lo
--     que el reembolso consumió y lo que un cobro NO abonó. payments y customer_refunds son
--     append-only: lo escrito no se reescribe.
--   · El único de customer_credits vuelve a ser total con otra migración solo si ningún documento
--     tiene a la vez un saldo a favor por nota y otro por sobrante.
--   · document_balance y fx_revaluation_items vuelven a las definiciones citadas con otra
--     migración; los asientos de revaluación ya posteados no cambian (regla 2).
--   · Las líneas de plantilla se devuelven con otra migración; los asientos ya posteados con
--     ellas se revierten con su reversa.
--   · receivables_ledger_gap es solo lectura: se suelta sin efecto.
-- A la fecha, ninguna migración posterior redefine document_balance, fx_revaluation_items ni
-- receivables_ledger_gap.
-- =============================================================================
