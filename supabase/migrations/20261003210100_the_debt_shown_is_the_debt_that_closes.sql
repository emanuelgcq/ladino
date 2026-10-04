-- =============================================================================
-- Ladino — LO MOSTRADO ES LO QUE CIERRA (ADR-0075 §4 y §5)
--
-- Módulo: ventas · contabilidad. Rigor máximo (dinero).
-- Spec:   ADR-0075 (notas «el cobro y el cierre» y «revisión de moneda B»).
-- Reversible: SÍ — `document_debt` vuelve a su definición de 20261003210000 §7.1 con otra
--   migración y `document_settlement_base` se suelta. No guardan estado ni escriben nada.
-- HOMOLOGATION_IMPACT: NO — es una cifra de lectura (lo que se enseña como deuda en Bs); ningún
--   documento, libro, declaración ni asiento cambia.
--
-- Qué pasaba: a la tasa del documento, `registerPayment` (20261003200000, encargo X) cierra un
-- cobro en Bs contra «lo que el mayor todavía le carga al documento» si eso cuadra con la parte
-- proporcional del total dentro de la cota del redondeo, y si no, contra la parte proporcional.
-- `document_debt` enseñaba SIEMPRE la parte proporcional. Tras un abono en divisa el mismo día
-- las dos cifras se apartan en céntimos: pagar lo mostrado dejaba céntimos o respondía «supera lo
-- pendiente».
--
-- Qué cambia:
--   1. `platform.document_settlement_base(empresa, documento)`: la base en Bs, a la tasa del
--      DOCUMENTO, contra la que cierra un cobro. UNA definición, para que la usen la lectura
--      (aquí) y el cobro (`registerPayment` la calcula hoy en TypeScript, packages/domain/src/
--      sales.ts: la misma regla, escrita dos veces hasta que el cobro llame a esta).
--   2. `platform.document_debt`: parte de la definición VIVA (20261003210000 §7.1, la última).
--      Única diferencia: cuando la tasa de hoy ES la del documento y el documento tiene cobros
--      vivos, el equivalente en Bs es esa base. En los demás casos la fórmula de siempre, que no
--      lee el mayor (sin cobros da el total; a otra tasa, la parte proporcional reindexada): la
--      lista de clientes y la antigüedad no leen el mayor por cada documento.
-- No redefine nada más. `settlement_ledger_open` (20261003200000) se LLAMA, no se toca.
-- =============================================================================

create function platform.document_settlement_base(p_company uuid, p_document uuid)
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

  v_saldo_tx := platform.document_balance_transaction_at(p_company, p_document, null);
  if v_saldo_tx is null or v_saldo_tx <= 0 then return 0; end if;
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
comment on function platform.document_settlement_base(uuid, uuid) is
  'ADR-0075 §4-5: la base EN MONEDA FUNCIONAL, a la tasa del documento, contra la que cierra un '
  'cobro de un documento en divisa: lo que el mayor todavía le carga (settlement_ledger_open; o '
  'total − cobros vivos si hay piezas en cola) cuando cuadra con la parte proporcional del total '
  'dentro de la cota del redondeo, y si no, esa parte proporcional. Es la cifra que enseña '
  'document_debt a la tasa del documento. NULL si el documento no está en divisa.';
revoke execute on function platform.document_settlement_base(uuid, uuid) from public;
grant execute on function platform.document_settlement_base(uuid, uuid)
  to authenticated, ladino_api;

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

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos): las dos son de lectura. Otra migración devuelve
-- `document_debt` a 20261003210000 §7.1 y suelta `document_settlement_base`; ningún dato cambia.
-- Con la API vieja: `document_debt` conserva firma y columnas. Redefine: document_debt (parte de
-- 20261003210000, la última). Crea: document_settlement_base.
-- =============================================================================
