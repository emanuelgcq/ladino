-- =============================================================================
-- Ladino — migración 62 · EL CÉNTIMO DE LA CAJA (ADR-0063 §§4-5)
--
-- QA de pantalla 2026-09-15: la misma deuda se veía con tres cifras distintas.
-- La factura A-2 decía «Total Bs 21.493,12» y justo debajo «Saldo Bs
-- 21.493,114984» (h. 56); el comprobante de cobro decía «Saldo restante Bs
-- 13.071,053» y el detalle «Bs 13.071,047984» (h. 37).
--
-- Dos causas, las dos aquí:
--
--   1. la deuda de hoy se servía con ocho decimales. Se sirve a las unidades
--      mínimas de la moneda (`currency_minor_units`), que es lo que alguien
--      puede pagar; la base conserva su escala y el mayor no se toca;
--   2. la deuda de un documento en divisa se calculaba como saldo_divisa ×
--      tasa_de_hoy, y eso NO coincide con el total del documento ni el mismo
--      día que se emitió: el total funcional se congela sumando los renglones
--      ya redondeados (PER_LINE, ADR-0058) y la multiplicación del total no
--      pasa por esos redondeos. Ahora la deuda se expresa como PROPORCIÓN del
--      total funcional congelado, reindexada por cuánto se movió la tasa: a la
--      tasa de emisión y sin cobros, la deuda es EXACTAMENTE el total.
--
-- Lo que NO cambia: `document_balance` y `document_balance_transaction` siguen
-- devolviendo la base a ocho decimales —la contabilidad y la regla del último
-- céntimo se apoyan en ellas—, y la deuda sigue anclada en la moneda del
-- documento (ADR-0047; su revisión con el asesor sigue abierta, P-16).
--
-- Reversibilidad: restaurar `document_debt_today` a su versión de la migración
-- 52 y `drop function platform.currency_minor_units`. Ninguna tabla cambia.
-- =============================================================================

-- ── 1. Cuántos decimales sabe cobrar una moneda ─────────────────────────────
create function platform.currency_minor_units(p_code text)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce((select c.display_decimals::int from public.currencies c
                    where c.code = p_code), 2)
$$;
comment on function platform.currency_minor_units(text) is
  'Las unidades mínimas de una moneda: a cuántos decimales se puede pagar de verdad. '
  'Para SERVIR importes (ADR-0063), nunca para decidir un redondeo fiscal — eso es '
  'RoundingPolicy versionada.';
revoke execute on function platform.currency_minor_units(text) from public;
grant execute on function platform.currency_minor_units(text) to authenticated, ladino_api,
  ladino_worker;

-- ── 2. La deuda de hoy, en céntimos y coherente con el total ────────────────
create or replace function platform.document_debt_today(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
  v_saldo_tx numeric;
  v_escala int;
begin
  select d.transaction_currency, d.functional_currency, d.fx_rate,
         d.amount_transaction_currency, d.total_amount
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  v_escala := platform.currency_minor_units(v_doc.functional_currency);

  if v_doc.transaction_currency = v_doc.functional_currency then
    return round(platform.document_balance(p_company, p_document), v_escala);
  end if;

  v_rate := platform.rate_at(p_company, v_doc.transaction_currency, v_doc.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda: cárgala con su fuente',
      v_doc.transaction_currency, v_doc.functional_currency
      using errcode = 'LAD51';
  end if;

  v_saldo_tx := platform.document_balance_transaction(p_company, p_document);

  -- Un documento sin importe en divisa (o con tasa de emisión imposible) no admite la
  -- proporción: se responde la conversión directa, como antes.
  if v_doc.amount_transaction_currency is null or v_doc.amount_transaction_currency = 0
     or v_doc.fx_rate is null or v_doc.fx_rate = 0 then
    return round(v_saldo_tx * v_rate, v_escala);
  end if;

  -- La deuda es la PARTE del total que sigue debiéndose, reindexada por la tasa: a la tasa
  -- de emisión y sin cobros da exactamente `total_amount`, que es lo que la pantalla enseña
  -- arriba. Sin esto, «Total Bs 21.493,12 · Saldo Bs 21.493,114984» (ADR-0063 §4).
  return round(
    v_doc.total_amount
      * (v_saldo_tx / v_doc.amount_transaction_currency)
      * (v_rate / v_doc.fx_rate),
    v_escala);
end;
$$;
comment on function platform.document_debt_today(uuid, uuid) is
  'Lo que el cliente debe HOY por este documento, en moneda funcional y a las unidades '
  'mínimas de esa moneda: la parte del total todavía no cobrada, reindexada por la tasa '
  'del día (ADR-0047 y ADR-0063 §4).';
