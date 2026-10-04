-- =============================================================================
-- Ladino — EL ORIGINAL DE LA CARTERA ES DETERMINISTA Y EL IGTF CONSERVA SU QUINCENA
-- (ADR-0075 §6 y §8; revisión final de «moneda», Z2, Z4 y Z6)
--
-- Módulo: contabilidad · ventas · compras · IGTF. Rigor máximo (dinero, fiscal).
-- Spec:   ADR-0075 (nota «última ronda») · IGTF_SPEC.md · PA SNAT/2022/000013 art. 4.
-- Reversible: SÍ — las tres piezas son de lectura. `settlement_original_of` vuelve a su
--   definición de 20261003210200 §1 con otra migración; `igtf_period_totals` se suelta. Las
--   líneas de cartera ya escritas con su original quedan (append-only; el funcional no cambia).
-- HOMOLOGATION_IMPACT: YES — cambia el total de IGTF que Ladino enseña para una quincena cuando
--   un cobro de esa quincena se reversa DESPUÉS de cerrarla (sigue contando; VALIDAR-TRIBUTARIO
--   P-89). No cambia ningún documento, libro de IVA ni declaración de IVA.
--
-- LO QUE LA CABECERA DE 20261003210000 DECÍA Y NO ERA CIERTO (:15-17): que la 20261003200000
-- redefine `settled_ledger_gaps`, `fiscal_amount_gaps` y `document_balance*`. La 200000 SOLO
-- redefine `platform.settlement_ledger_open`. Las cabeceras no se editan: queda dicho aquí.
--
-- Qué cambia:
--   1. `platform.settlement_original_of`: parte de la definición VIVA (20261003210200 §1, la
--      única). Diferencia: la factura de compra devuelve lo que su línea de cuentas por pagar
--      lleva de verdad —el total MENOS la retención neteada, en la moneda del documento—. Con eso
--      cada hecho que tiene línea de cartera devuelve SU original exacto, y el generador deja de
--      comparar «si se parece» (el umbral del 0,5 % de la 210200 era una heurística: una factura
--      de varias líneas baratas lo superaba y la suma de originales de un documento saldado no
--      daba cero; una compra con retención menor al umbral tomaba el total).
--   2. El COMMENT de `document_balance_transaction_at(uuid, uuid, date)`: ya no es «la base de
--      document_debt» (esa lee el modo de lectura de cuatro argumentos); es el modo ESTRICTO.
--   3. `platform.igtf_period_totals`: el total de IGTF de un período, con la regla de la
--      percepción reversada después de su quincena.
-- =============================================================================

-- ── 1. El original de la línea de cartera, por hecho ─────────────────────────
-- ENUNCIADO. `amount` es el importe ORIGINAL, en la moneda del documento, de la línea de cuentas
-- por cobrar o por pagar (`ar_general` / `ap_general`) del hecho:
--   · factura, recibo y nota de débito de venta ........ el total del documento en su moneda;
--   · cobro (efectivo, saldo a favor, retención) ....... lo que saldó (`settled_transaction_amount`);
--   · factura de compra ................................ el total menos la retención neteada;
--   · pago a proveedor ................................. lo que saldó (`settled_amount`; o el neto
--                                                        si el dinero salió en la moneda de la
--                                                        factura);
--   · nota de crédito de proveedor ..................... su total, en su moneda y a SU tasa.
-- Cualquier otro hecho —un asiento manual sobre la cartera, un cobro anterior a 20261003170000
-- sin lo saldado congelado— no tiene original conocido: `amount` es NULL (o no hay fila) y su
-- línea va en moneda funcional. No hay umbral ni «si se parece».
create or replace function platform.settlement_original_of(
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
         platform.currency_minor_units(i.transaction_currency),
         -- La línea de cuentas por pagar va NETA de lo retenido (plantilla ap.invoice_posted:
         -- `net_amount`). La misma expresión que `fx_revaluation_items` usa para el saldo.
         i.total_amount
         - round(coalesce(i.retention_total, 0) / nullif(i.fx_rate, 0),
                 platform.currency_minor_units(i.transaction_currency))
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
  'H6 (ADR-0075 §6; los siete campos de ADR-0020): la moneda, la tasa y el importe ORIGINAL de la '
  'línea de cuentas por cobrar o por pagar de un hecho, DETERMINISTA por tipo de hecho: el total '
  'del documento de venta; lo que el cobro o el pago saldó; el total menos la retención neteada de '
  'la factura de compra; el total de la nota de crédito de proveedor. Sin importe (NULL) o sin '
  'fila, el hecho no tiene original conocido y su línea va en moneda funcional. El diferencial va '
  'en su propia línea, en moneda funcional. Lo lee el generador de asientos.';

-- ── 2. El comentario que mentía ──────────────────────────────────────────────
comment on function platform.document_balance_transaction_at(uuid, uuid, date) is
  'Saldo de un documento EN SU MONEDA, a una fecha (NULL = ahora), en modo ESTRICTO: lanza LAD51 '
  'si un cobro viejo en otra moneda no tiene con qué valorarse (ni lo saldado congelado, ni la '
  'tasa de su diferencial, ni una tasa a su fecha). Lo usan el cobro, la revaluación al cierre y '
  'el trigger de paid → issued. Las LECTURAS (platform.document_debt y lo que sale de ella) usan '
  'la firma de cuatro argumentos con p_strict = false, que devuelve NULL en vez de lanzar.';

-- ── 3. El IGTF de un período, con la percepción reversada tarde ──────────────
-- PA SNAT/2022/000013 art. 4: lo percibido y ya enterado no se rebaja; se recupera por reintegro.
-- Una percepción cuyo cobro se reversó DESPUÉS del fin del período sigue contando en el total de
-- ese período (así el total reproduce lo que se declaró) y además se dice aparte, como pendiente
-- de reintegro. La que se reversó DENTRO del período no cuenta: nunca llegó a declararse.
-- Granularidad: `date` contra `date`, día de Caracas — el día de la percepción (`occurred_at`) y
-- el día de la reversa (`payment_reversals.reversed_at`) contra `p_from` / `p_to`, que decide quien
-- llama (la quincena). Sin período (NULL, NULL) no hay «después del período»: solo cuenta lo
-- percibido vigente. Una percepción `pendiente_reintegro` SIN reversa de cobro (otro origen) no
-- cuenta, como antes.
create function platform.igtf_period_totals(p_company uuid, p_from date, p_to date)
returns table (total_functional numeric, pending_refund_functional numeric,
               pending_refund_count bigint)
language sql
stable
set search_path = ''
as $$
  with percepciones as (
    select ip.functional_amount, ip.status,
           (select platform.caracas_day(r.reversed_at)
              from public.payment_reversals r
             where r.company_id = ip.company_id and r.payment_id = ip.payment_id) as reversada_el
      from public.igtf_perceptions ip
     where ip.company_id = p_company
       and (p_from is null or platform.caracas_day(ip.occurred_at) >= p_from)
       and (p_to is null or platform.caracas_day(ip.occurred_at) <= p_to)
  )
  select coalesce(sum(functional_amount) filter (
                    where status = 'percibido'
                       or (status = 'pendiente_reintegro' and p_to is not null
                           and reversada_el > p_to)), 0),
         coalesce(sum(functional_amount) filter (
                    where status = 'pendiente_reintegro' and p_to is not null
                      and reversada_el > p_to), 0),
         count(*) filter (where status = 'pendiente_reintegro' and p_to is not null
                            and reversada_el > p_to)
    from percepciones
$$;
comment on function platform.igtf_period_totals(uuid, date, date) is
  'El IGTF de un período (PA SNAT/2022/000013 art. 4; ADR-0075 §8, AF-M11): total_functional = lo '
  'percibido vigente MÁS lo percibido cuyo cobro se reversó DESPUÉS del fin del período (ya se '
  'declaró: no se rebaja, se recupera por reintegro); pending_refund_* dice cuánto de ese total '
  'está pendiente de reintegro. La percepción reversada dentro de su período no cuenta. Día de '
  'Caracas contra p_from / p_to. Toda lectura del total de IGTF de un período sale de aquí.';
revoke execute on function platform.igtf_period_totals(uuid, date, date) from public;
grant execute on function platform.igtf_period_totals(uuid, date, date)
  to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos): nada guarda estado. Otra migración devuelve
-- `settlement_original_of` a 20261003210200 §1 y suelta `igtf_period_totals` (la ruta vuelve a
-- sumar `status = 'percibido'`). Con la API vieja: el generador viejo (210200) sigue comparando
-- «si se parece» contra el importe que devuelve esta función — para la factura de compra el neto
-- se parece más que el total, así que mejora; la ruta vieja de IGTF no llama a la función nueva.
-- Redefine: settlement_original_of (parte de 20261003210200, la última). Crea: igtf_period_totals.
-- =============================================================================
