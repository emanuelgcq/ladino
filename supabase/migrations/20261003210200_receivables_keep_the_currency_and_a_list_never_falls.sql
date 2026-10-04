-- =============================================================================
-- Ladino — LA CARTERA GUARDA SU DIVISA EN EL MAYOR, Y UNA LISTA NO SE CAE POR UNA TASA
-- (ADR-0075 §5 y §6; H6, resto de H12, y dos cabos de la revisión de «moneda B»)
--
-- Módulo: contabilidad · ventas · compras · tesorería. Rigor máximo (dinero, con datos vivos).
-- Spec:   ADR-0075 (nota «revisión de moneda B») · ADR-0020 (los siete campos).
-- Reversible: SÍ para las funciones (otra migración con las definiciones anteriores, citadas en
--   cada bloque). NO para las líneas de asiento que el generador escriba con la divisa del
--   documento: `journal_lines` es append-only y quedan (su importe funcional no cambia).
-- HOMOLOGATION_IMPACT: NO — ningún importe funcional, documento, libro ni declaración cambia. Lo
--   que cambia es qué guarda una línea de cuentas por cobrar o por pagar en sus campos de moneda
--   original, y que tres lecturas dejan de lanzar.
--
-- Qué cambia:
--   1. `platform.settlement_original_of`: de dónde saca el generador la moneda, la tasa y el
--      importe original de la línea de cuentas por cobrar / por pagar de un documento en divisa.
--   2. `platform.document_balance_transaction_at` gana un modo que NO lanza: un cobro viejo en
--      otra moneda sin `settled_transaction_amount` usa la tasa que su diferencial guardó
--      congelada (`exchange_gain_loss.fx_rate_payment`); si no la tiene, la tasa de su fecha; y si
--      tampoco, el modo estricto lanza LAD51 (el cobro, la revaluación) y el de lectura devuelve
--      NULL. `payments` es append-only (sin UPDATE para nadie): NO se rellena nada.
--   3. `document_debt`, `document_settlement_base`, `ar_aging` y `customer_debt_today` leen en ese
--      modo: un documento sin saldo calculable enseña NULL («falta la tasa»), no tumba la lista.
--   4. `fx_revaluation_items`: el cobro posterior a la fecha de cierre que mantiene en la cartera
--      a un documento `paid` tiene que estar VIVO.
--   5. `money_landing_gaps` (informe) no lista cobros reversados.
-- =============================================================================

-- ── 1. El original de la línea de cartera ────────────────────────────────────
-- `amount`: lo que el hecho mueve en la moneda del DOCUMENTO cuando se sabe exacto (el total del
-- documento; lo saldado por el cobro o el pago). El generador lo usa si cuadra con el importe
-- funcional de la línea a la tasa del documento; si no, divide el funcional entre esa tasa.
create function platform.settlement_original_of(
  p_company uuid, p_source_kind text, p_source_id uuid)
returns table (currency text, fx_rate numeric, rate_source text, rate_timestamp timestamptz,
               minor_units integer, amount numeric)
language sql
stable
set search_path = ''
as $$
  select d.transaction_currency, d.fx_rate, d.rate_source, d.rate_timestamp,
         platform.currency_minor_units(d.transaction_currency), d.amount_transaction_currency
    from public.documents d
   where p_source_kind in ('sales_invoice', 'sales_receipt', 'sales_debit_note',
                           'sales_credit_note', 'sales_receipt_return')
     and d.id = p_source_id and d.company_id = p_company
  union all
  select d.transaction_currency, d.fx_rate, d.rate_source, d.rate_timestamp,
         platform.currency_minor_units(d.transaction_currency), p.settled_transaction_amount
    from public.payments p
    join public.documents d on d.id = p.document_id and d.company_id = p.company_id
   where p_source_kind = 'payment_received' and p.id = p_source_id and p.company_id = p_company
  union all
  select i.transaction_currency, i.fx_rate, i.rate_source, i.rate_timestamp,
         platform.currency_minor_units(i.transaction_currency), i.total_amount
    from public.supplier_invoices i
   where p_source_kind = 'purchase_invoice' and i.id = p_source_id and i.company_id = p_company
  union all
  select i.transaction_currency, i.fx_rate, i.rate_source, i.rate_timestamp,
         platform.currency_minor_units(i.transaction_currency),
         coalesce(sp.settled_amount,
                  case when sp.transaction_currency = i.transaction_currency
                       then sp.net_amount end)
    from public.supplier_payments sp
    join public.supplier_invoices i
      on i.id = sp.supplier_invoice_id and i.company_id = sp.company_id
   where p_source_kind = 'payment_made' and sp.id = p_source_id and sp.company_id = p_company
  union all
  select n.transaction_currency, n.fx_rate, n.rate_source, n.rate_timestamp,
         platform.currency_minor_units(n.transaction_currency), n.total_amount
    from public.supplier_credit_notes n
   where p_source_kind = 'purchase_credit_note' and n.id = p_source_id
     and n.company_id = p_company
$$;
comment on function platform.settlement_original_of(uuid, text, uuid) is
  'H6 (ADR-0075 §6; los siete campos de ADR-0020): la moneda, la tasa y —si se sabe exacto— el '
  'importe original que lleva la línea de cuentas por cobrar o por pagar de un hecho: los del '
  'DOCUMENTO (la factura; en un cobro o un pago, su documento y lo que saldó en su moneda). El '
  'diferencial va en su propia línea, en moneda funcional. Lo lee el generador de asientos.';
revoke execute on function platform.settlement_original_of(uuid, text, uuid) from public;
grant execute on function platform.settlement_original_of(uuid, text, uuid)
  to ladino_api, ladino_worker;

-- ── 2. El saldo en la moneda del documento, con un modo que no lanza ─────────
-- Parte de la definición VIVA (20261003180000 §5.1, la única). Diferencias: (a) `p_strict`;
-- (b) antes de buscar la tasa del día del cobro, usa la que el diferencial de ese cobro guardó
-- congelada (F-02: una tasa cargada o borrada después no cambia lo que un cobro saldó).
create function platform.document_balance_transaction_at(
  p_company uuid, p_document uuid, p_as_of date, p_strict boolean)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_paid numeric := 0;
  v_p record;
  v_rate numeric;
begin
  select d.id, d.company_id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency, d.fx_rate
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount, p.settled_transaction_amount,
           platform.caracas_day(p.paid_at) as paid_on,
           r.ar_valuation,
           (select g.fx_rate_payment from public.exchange_gain_loss g
             where g.payment_id = p.id and g.fx_rate_payment > 0
             order by g.created_at limit 1) as tasa_congelada
      from public.payments p
      left join public.supported_retention_receipts r
        on r.company_id = p.company_id and r.id = p.supported_retention_id
     where p.document_id = v_doc.id
       and (p_as_of is null or platform.caracas_day(p.paid_at) <= p_as_of)
       and not exists (select 1 from public.payment_reversals pr
                        where pr.payment_id = p.id
                          and (p_as_of is null
                               or platform.caracas_day(pr.reversed_at) <= p_as_of))
  loop
    if v_p.settled_transaction_amount is not null then
      -- ADR-0075 §4 (F-02): lo que el cobro saldó quedó congelado al cobrar.
      v_paid := v_paid + v_p.settled_transaction_amount;
    elsif v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    elsif v_p.ar_valuation = 'invoice_rate' then
      -- ADR-0072 §5: la retención es una fracción fija del IVA DE LA FACTURA; salda
      -- la divisa a la tasa con que se emitió, sin diferencial.
      v_paid := v_paid + round(v_p.functional_amount / v_doc.fx_rate, 8);
    else
      v_rate := coalesce(v_p.tasa_congelada,
                         platform.rate_at(p_company, v_doc.transaction_currency,
                                          v_doc.functional_currency, v_p.paid_on));
      if v_rate is null then
        if not p_strict then return null; end if;
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  if v_doc.transaction_currency = v_doc.functional_currency then
    v_paid := v_paid + coalesce((select sum(ip.functional_amount)
                                   from public.igtf_perceptions ip
                                  where ip.company_id = v_doc.company_id
                                    and ip.debit_note_id = v_doc.id), 0);
  end if;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;
comment on function platform.document_balance_transaction_at(uuid, uuid, date, boolean) is
  'Saldo de un documento EN SU MONEDA, a una fecha (NULL = ahora): importe − lo saldado por cada '
  'cobro no reversado. Un cobro viejo en otra moneda sin lo saldado congelado se valora a la tasa '
  'que guardó su diferencial o, si no, a la de su fecha; sin ninguna, p_strict lanza LAD51 (el '
  'cobro, la revaluación) y el modo de lectura devuelve NULL (la pantalla dice «falta la tasa»).';
revoke execute on function platform.document_balance_transaction_at(uuid, uuid, date, boolean)
  from public;
grant execute on function platform.document_balance_transaction_at(uuid, uuid, date, boolean)
  to authenticated, ladino_api;

-- La firma de siempre es el modo ESTRICTO. Envoltorio en plpgsql (uno en SQL sobre una función no
-- inlinable replanifica por fila). Parte de 20261003180000 §5.1: mismo resultado, salvo (b).
create or replace function platform.document_balance_transaction_at(
  p_company uuid, p_document uuid, p_as_of date)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
begin
  return platform.document_balance_transaction_at(p_company, p_document, p_as_of, true);
end;
$$;

-- ── 3. Las lecturas no lanzan ────────────────────────────────────────────────
-- 3.1 La base del cierre. Parte de la definición VIVA (20261003210100, la única). Única
-- diferencia: lee el saldo en modo de lectura y devuelve NULL si no se puede calcular.
create or replace function platform.document_settlement_base(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_saldo_tx numeric;
  v_prop numeric;
  v_mayor numeric;
  v_lineas integer;
  v_cobros integer;
  v_media numeric;
  v_cota numeric;
begin
  select d.transaction_currency, d.functional_currency, d.fx_rate,
         d.amount_transaction_currency, d.total_amount
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company and d.status in ('issued', 'paid');
  if not found
     or v_doc.transaction_currency = v_doc.functional_currency
     or v_doc.amount_transaction_currency is null or v_doc.amount_transaction_currency <= 0
     or v_doc.fx_rate is null or v_doc.fx_rate <= 0 then
    return null;
  end if;

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null, false);
  if v_saldo_tx is null then return null; end if;
  if v_saldo_tx <= 0 then return 0; end if;
  -- La parte proporcional del total en Bs que sigue debiéndose.
  v_prop := v_doc.total_amount * v_saldo_tx / v_doc.amount_transaction_currency;

  -- Lo que el mayor todavía le carga; si alguna pieza espera en la cola, lo mismo desde los
  -- cobros VIVOS (total − Σ lo ya cancelado).
  v_mayor := platform.settlement_ledger_open(p_company, 'ar', p_document);
  if v_mayor is null then
    select v_doc.total_amount
           - coalesce(sum(p.functional_amount - coalesce(g.difference, 0)), 0)
      into v_mayor
      from public.payments p
      left join public.exchange_gain_loss g on g.payment_id = p.id
     where p.document_id = p_document
       and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id);
  end if;

  -- La cota del redondeo (regla 4 de «el cobro y el cierre»), a la tasa del documento: por línea,
  -- media unidad mínima de la divisa × tasa + un céntimo; más la media unidad con la que un cobro
  -- «cierra», y un céntimo por cada cobro (todos, también los reversados) más el que viene.
  select count(*)::int into v_lineas from public.document_lines l where l.document_id = p_document;
  select count(*)::int into v_cobros from public.payments p where p.document_id = p_document;
  v_media := power(10::numeric, -platform.currency_minor_units(v_doc.transaction_currency)) / 2
             * v_doc.fx_rate;
  v_cota := (v_media + power(10::numeric, -platform.currency_minor_units(v_doc.functional_currency)))
              * greatest(v_lineas, 1)
            + v_media
            + power(10::numeric, -platform.currency_minor_units(v_doc.functional_currency))
              * (v_cobros + 1);

  if v_mayor is not null and v_mayor > 0 and abs(v_mayor - v_prop) <= v_cota then
    return v_mayor;
  end if;
  -- El mayor se aparta más que el redondeo: no se le cree (y el cobro que cierre lo dirá).
  return v_prop;
end;
$$;

-- 3.2 LA función de deuda. Parte de la definición VIVA (20261003210100, la última). Única
-- diferencia: el saldo en divisa se lee en modo de lectura; si no se puede calcular (un cobro
-- viejo sin tasa con que valorarlo) devuelve la fila con `nominal`, `rate` y `functional_today`
-- en NULL en vez de lanzar LAD51 para toda la lista.
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
  select d.id, d.status, d.transaction_currency, d.functional_currency, d.fx_rate,
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

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null, false);
  if v_saldo_tx is null then
    -- Un cobro viejo sin tasa con que valorarlo: lo que se debe no se puede decir. Se dice eso.
    return query select v_doc.transaction_currency, null::numeric, v_doc.functional_currency,
                        null::numeric, v_hoy, null::numeric;
    return;
  end if;

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
  elsif v_rate = v_doc.fx_rate and v_saldo_tx > 0
        and exists (select 1 from public.payments p
                     where p.document_id = v_doc.id
                       and not exists (select 1 from public.payment_reversals pr
                                        where pr.payment_id = p.id)) then
    -- LO MOSTRADO ES LO QUE CIERRA: a la tasa del documento y con cobros previos, la deuda en Bs
    -- es la base contra la que `registerPayment` cierra. Solo aquí se lee el mayor.
    v_func := round(platform.document_settlement_base(p_company, p_document), v_escala);
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
  'hoy, con la tasa y la fecha. Un documento pagado debe cero. NUNCA lanza por una tasa: sin tasa '
  'de hoy, rate y functional_today van en NULL; si ni el nominal se puede calcular (un cobro viejo '
  'sin tasa con que valorarlo), nominal también. A la tasa del documento y con cobros previos, '
  'functional_today es platform.document_settlement_base (lo mostrado es lo que cierra).';

-- 3.3 La antigüedad. Parte de la definición VIVA (20261003210000 §7.2). Única diferencia: un
-- documento cuyo nominal no se puede calcular CUENTA (con importe NULL) en vez de desaparecer.
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
   where s.nominal > 0 or s.nominal is null
   group by 1, 2
   order by 1, 2
$$;

-- 3.4 La deuda de un cliente. Parte de la definición VIVA (20261003210000 §7.3). Única
-- diferencia: también es NULL si el nominal de algún documento no se puede calcular.
create or replace function platform.customer_debt_today(p_company uuid, p_customer uuid default null)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case when bool_or(dd.nominal is null
                           or (dd.nominal > 0 and dd.functional_today is null)) then null
              else coalesce(sum(greatest(dd.functional_today, 0)), 0) end
    from public.documents d
   cross join lateral platform.document_debt(p_company, d.id) dd
   where d.company_id = p_company
     and (p_customer is null or d.customer_id = p_customer)
     and d.kind in ('invoice', 'receipt', 'debit_note')
     and d.status in ('issued', 'paid')
$$;

-- ── 4. La revaluación: el cobro posterior tiene que estar vivo ───────────────
-- Parte de la definición VIVA (20261003210000 §3, la última). Única diferencia: un documento
-- `paid` solo sigue en la cartera a la fecha de cierre por un cobro (o pago) posterior a ella que
-- NO esté reversado. Con uno reversado entraba por su residuo de último céntimo (H14).
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
end;
$$;

-- ── 5. El informe de dónde cayó el dinero no lista cobros reversados ─────────
-- Es un INFORME, no un invariante (ADR-0067 §4: su respuesta correcta no es cero). Parte de la
-- definición VIVA (20260918231832, la única). Única diferencia: el cobro tiene que estar vivo —
-- un cobro reversado ya no es dinero que cayó en ninguna cuenta.
create or replace function platform.money_landing_gaps(p_company uuid)
returns table (kind text, movement_id uuid, occurred_on date, instrument text, amount numeric,
               currency text, account_id uuid, account_name text, problem text)
language sql
stable
set search_path = ''
as $$
  -- La familia que le toca a cada instrumento es la MISMA que aplica el servidor al deducir
  -- (`FAMILIA_DE_INSTRUMENTO` en packages/domain/src/treasury.ts). Si una de las dos cambia sin
  -- la otra, esta función empieza a señalar como error lo que el servidor considera correcto:
  -- por eso está escrita aquí entera y en el mismo orden, y por eso el pgTAP la compara caso a
  -- caso contra la lista de instrumentos que admite el esquema.
  with familia as (
    select * from (values
      ('efectivo_bs',   array['cash']),
      ('efectivo_usd',  array['cash']),
      ('pago_movil',    array['bank','wallet']),
      ('transferencia', array['bank','wallet']),
      ('punto_venta',   array['bank','wallet']),
      ('tarjeta',       array['bank','wallet']),
      ('cashea',        array['bank','wallet']),
      ('zelle',         array['wallet','bank']),
      ('usdt',          array['wallet','bank']),
      ('otro',          array['bank','wallet','cash'])
    ) as f(instrument, kinds)
  ),
  movimientos as (
    select 'cobro'::text as kind, p.id as movement_id,
           (p.paid_at at time zone 'America/Caracas')::date as occurred_on,
           p.instrument, p.amount, p.currency, p.account_id
      from public.payments p
     where p.company_id = p_company and p.account_id is not null
       and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)
    union all
    select 'pago a proveedor', sp.id,
           (sp.paid_at at time zone 'America/Caracas')::date,
           sp.instrument, sp.amount_transaction_currency, sp.transaction_currency, sp.account_id
      from public.supplier_payments sp
     where sp.company_id = p_company and sp.account_id is not null
    union all
    -- El gasto no guarda instrumento: siempre se eligió la cuenta a mano. Solo puede tener el
    -- problema de haber caído en una cuenta de sistema, nunca el de familia.
    select 'gasto', e.id,
           (e.paid_at at time zone 'America/Caracas')::date,
           null, e.amount_transaction_currency, e.transaction_currency, e.account_id
      from public.expenses e
     where e.company_id = p_company and e.account_id is not null
  )
  select m.kind, m.movement_id, m.occurred_on, m.instrument, m.amount, m.currency,
         m.account_id, a.name,
         case when a.is_system then 'sin_asignar' else 'familia_no_corresponde' end as problem
    from movimientos m
    join public.company_accounts a on a.id = m.account_id
    left join familia f on f.instrument = m.instrument
   where a.is_system
      or (m.instrument is not null and f.kinds is not null and not (a.kind = any(f.kinds)))
   order by m.occurred_on desc, m.kind
$$;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · Todas las funciones son de lectura: vuelven a su definición anterior con otra migración
--     (document_balance_transaction_at → 20261003180000; document_debt, document_settlement_base
--     → 20261003210100; ar_aging, customer_debt_today, fx_revaluation_items → 20261003210000;
--     money_landing_gaps → 20260918231832). `settlement_original_of` y la firma de cuatro
--     argumentos se sueltan después.
--   · Lo que NO se revierte: las líneas de cuentas por cobrar / por pagar que el generador ya
--     haya escrito con la divisa del documento (append-only). Su importe funcional es el de
--     siempre; quien lea `debit_amount` / `credit_amount` como bolívares se equivoca desde
--     20261003180000 (línea de caja) y ahora también en estas: se lee `functional_*`.
--   · Con la API vieja y esta migración: el generador viejo no llama a `settlement_original_of`
--     y sigue escribiendo la cartera en moneda funcional (mezcla tolerada: ningún invariante
--     suma los originales de la cartera).
-- Redefine: document_balance_transaction_at(uuid,uuid,date), document_settlement_base,
-- document_debt, ar_aging, customer_debt_today, fx_revaluation_items, money_landing_gaps.
-- Crea: settlement_original_of, document_balance_transaction_at(uuid,uuid,date,boolean).
-- =============================================================================
