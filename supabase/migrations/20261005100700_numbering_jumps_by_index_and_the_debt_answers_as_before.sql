-- =============================================================================
-- Ladino — 20261005100700 · LA NUMERACIÓN VUELVE A SALTAR POR ÍNDICE, Y LA DEUDA DE UN
--   DOCUMENTO RESPONDE POR LOS MISMOS TIPOS QUE ANTES (tercera ronda de ADR-0082)
--
-- Módulo: ventas · fiscal (RIGOR MÁXIMO: numeración de TODO documento)
-- Spec: ADR-0082 (nota de la tercera ronda) · ADR-0071 · ADR-0075 §4
-- HOMOLOGATION_IMPACT: NO — ningún número, importe ni documento cambia: cambia CÓMO se busca el
--   último correlativo (el mismo resultado, por índice) y se restituye una lectura.
--
-- DEFECTO 1 (regresión de coste, confirmada con EXPLAIN por la revisión en contexto limpio).
--   20261005100100 y 20261005100500 cambiaron el filtro de `platform.claim_document_number` de
--   `d.kind = p_kind` a `(case d.kind when … end) = v_familia`. Un CASE sobre la columna no
--   casa con ningún índice: el plan pasó de `Limit → Index Only Scan Backward using
--   documents_number_uidx` (un salto) a `Aggregate → Bitmap Heap Scan` con `Index Cond` solo por
--   empresa y serie y el CASE como `Filter`. Cada numeración —factura, recibo, cotización, nota—
--   recorría TODOS los documentos de la empresa en esa serie, de cualquier tipo, y lo hacía con
--   el candado que serializa la serie tomado. Crece lineal con la historia.
--   Ningún test lo veía: los 43 asserts de 134 y 134b miran el NÚMERO, que era correcto. Un gate
--   de corrección no detecta una regresión de coste.
-- ARREGLO. Tres consultas ESTÁTICAS, una por familia de numeración, con la lista POSITIVA de sus
--   tipos escrita igual que el predicado del índice parcial que la sirve:
--     · facturas            → documents_invoice_number_uidx      (20261005100000)
--     · notas de crédito    → documents_credit_note_number_uidx  (20261005100500)
--     · cualquier otro tipo → documents_number_uidx              (`d.kind = p_kind`, como siempre)
--   NO se reescribe como una sola consulta con CASE ni con `= any(array_variable)`: el
--   planificador solo prueba que un índice parcial sirve si el predicado es una constante
--   visible en la sentencia. El pgTAP 134 lee el cuerpo de esta función y falla si alguna de sus
--   consultas del máximo deja de resolverse con `Index Cond` puro.
--   EL CANDADO NO CAMBIA: misma clave (empresa | familia | serie), mismo orden, antes de leer.
--
-- DEFECTO 2 (regresión de conducta). 20261005100500 §14 añadió a `platform.document_debt`
--   `and d.kind in ('invoice', 'receipt', 'debit_note')`. Su definición anterior (20261003210200,
--   la única antes de esta familia) no filtraba por tipo: respondía por CUALQUIER documento
--   emitido o pagado. Con el filtro dejó de dar fila para la nota de crédito y el recibo de
--   devolución, y el detalle de un documento (`GET /v1/documents/:id`), que lee su saldo de
--   aquí, pasó a mostrar «0» donde antes mostraba el saldo.
-- ARREGLO. La lista sigue siendo POSITIVA (ningún tipo futuro debe por omisión), pero nombra los
--   siete tipos por los que la función respondía antes de la familia. Los dos del retiro siguen
--   sin fila: no cargan cartera (ADR-0082).
--
-- FUNCIONES REDEFINIDAS, y de cuál parten (la última en orden limpio):
--   platform.claim_document_number  ← 20261005100500 §2
--   platform.document_debt          ← 20261005100500 §14
-- COMPATIBILIDAD: expand. Mismas firmas y mismos resultados para la API saliente y la entrante.
--   Va JUSTO DESPUÉS del `git pull`, tras 20261005100600, en la misma ventana que la familia.
-- REVERSIBILIDAD (con datos vivos): SÍ, entera y sin pérdida: son dos `create or replace` sin
--   datos. Volver atrás es reaplicar las definiciones de 20261005100500 (y recuperar los dos
--   defectos). Ningún documento emitido depende de cuál de las dos esté viva.
-- =============================================================================

-- ── 1. El correlativo: un salto por índice, por familia ─────────────────────
create or replace function platform.claim_document_number(p_company uuid, p_kind text, p_series text)
 returns bigint
 language plpgsql
 security definer
 set search_path to ''
as $function$
declare
  v_next bigint;
  -- ADR-0082: la factura de retiro numera con las facturas, y su nota con las notas de crédito.
  v_familia text := case p_kind when 'withdrawal_invoice' then 'invoice'
                                when 'withdrawal_credit_note' then 'credit_note'
                                else p_kind end;
begin
  -- El bloqueo es sobre la company+tipo+serie, no sobre una tabla de contadores:
  -- pg_advisory_xact_lock serializa las emisiones de la misma serie sin crear
  -- una fila que mantener. Se libera solo al terminar la transacción.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|' || v_familia || '|' || p_series, 0));
  -- TRES CONSULTAS ESTÁTICAS Y NO UNA CON CASE (20261005100700): cada lista de tipos está escrita
  -- como el predicado del índice parcial que la sirve, y así el máximo es un salto por índice.
  -- Quien añada una familia añade su rama Y su índice; el pgTAP 134 falla si una rama filtra.
  if v_familia = 'invoice' then
    select coalesce(max(d.document_number), 0) + 1 into v_next
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'withdrawal_invoice')
       and d.series = p_series
       and d.document_number is not null;
  elsif v_familia = 'credit_note' then
    select coalesce(max(d.document_number), 0) + 1 into v_next
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('credit_note', 'withdrawal_credit_note')
       and d.series = p_series
       and d.document_number is not null;
  else
    select coalesce(max(d.document_number), 0) + 1 into v_next
      from public.documents d
     where d.company_id = p_company
       and d.kind = p_kind
       and d.series = p_series
       and d.document_number is not null;
  end if;
  return v_next;
end;
$function$;

-- ── 2. document_debt: los tipos por los que respondía antes de la familia ───
-- Definición VIVA: 20261005100500 §14. Solo cambia la lista de tipos.
CREATE OR REPLACE FUNCTION platform.document_debt(p_company uuid, p_document uuid)
 RETURNS TABLE(currency text, nominal numeric, functional_currency text, rate numeric, rate_date date, functional_today numeric)
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
     and d.status in ('issued', 'paid')
     -- LISTA POSITIVA (ningún tipo futuro debe por omisión), con los siete tipos por los que esta
     -- función respondía antes de ADR-0082. Una factura de retiro y su nota de crédito no
     -- cargan cartera: no hay fila. 20261005100500 había dejado solo factura, recibo y nota de
     -- débito, y el detalle de una nota de crédito o de un recibo de devolución perdió su saldo
     -- (20261005100700). Quien SUMA cartera (customer_debt_today, ar_aging,
     -- receivables_ledger_gap) filtra además por su propia lista, más corta.
     and d.kind in ('quote', 'order', 'invoice', 'credit_note', 'debit_note', 'receipt',
                    'receipt_return');
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
$function$;
