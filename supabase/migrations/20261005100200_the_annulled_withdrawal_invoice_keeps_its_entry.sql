-- =============================================================================
-- Ladino — 20261005100200 · LA FACTURA DE RETIRO ANULADA SIGUE SEÑALANDO SU ASIENTO
--
-- Módulo: fiscal · contabilidad (RIGOR MÁXIMO)   Spec: ADR-0082 · ADR-0061
-- Corrige: 20261005100000 (misma entrega, sin desplegar).
-- HOMOLOGATION_IMPACT: YES — es el libro de ventas (solo cambia qué asiento enlaza un renglón;
--   ninguna base, impuesto ni total cambia).
--
-- EL DEFECTO. En `platform.sales_book`, el renglón de la factura de retiro buscaba su asiento
--   —el de su salida del kardex— solo en estado `posted`. Al ANULARLA, ese asiento pasa a
--   `reversed` y nace su contra-asiento: el renglón quedaba sin enlace, y
--   `book_ledger_discrepancies` veía en el mayor dos asientos con débito fiscal (+IVA y −IVA) que
--   no podía imputar a ningún renglón del libro. La factura de venta anulada no lo sufre porque
--   guarda su enlace (`journal_entry_id`) al asiento original aunque esté reversado. Lo cazó el
--   E2E de la anulación, mirando ese invariante después de anular.
--
-- LA CORRECCIÓN. El renglón enlaza el asiento ORIGINAL de la salida, esté `posted` o `reversed`,
--   y nunca el contra-asiento (`is_reversal_of is null`). Con eso el original y su reversa se
--   imputan al mismo renglón y netean cero, igual que en la factura de venta.
--   Definición VIVA de la que parte: 20261005100000 §8. Solo cambia esa condición.
--
-- AUDITORÍA PROPIA: `book_ledger_reconciliation` usa `journal_entry_id is null` para contar el
--   IVA «en cola» SOLO sobre renglones no anulados: un renglón vigente tiene su asiento `posted` y
--   no cambia; uno anulado no entra en esa suma. La rama de las Notas de retiro (serie NR) no se
--   toca: una nota no se anula.
--
-- COMPATIBILIDAD: solo lectura; la API saliente lee lo mismo. Va JUSTO DESPUÉS del `git pull`,
--   tras 20261005100100.
-- REVERSIBILIDAD: `create or replace` con la definición de 20261005100000. Con una factura de
--   retiro anulada, volver atrás devuelve las dos filas a `book_ledger_discrepancies`.
-- =============================================================================

CREATE OR REPLACE FUNCTION platform.sales_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.* from (
  -- Definición viva de 20260928170200 §3 (signo R-1, anulada en cero G-10, adquirente por el
  -- snapshot del nombre B1/B3), más H1 (20261002120200): la línea de la ND por IGTF (producto de
  -- sistema LADINO-IGTF) no suma en ninguna base ni en el total de venta; su monto va a
  -- `igtf_percibido`. El renglón se conserva con su número, control y estado: el correlativo se
  -- consumió y el libro lo registra. VALIDAR-TRIBUTARIO P-70.
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         case when d.customer_name_snapshot is not null then d.customer_tax_id_snapshot
              else c.tax_id end,
         coalesce(d.customer_name_snapshot, c.legal_name),
         case when d.customer_name_snapshot is not null then d.customer_taxpayer_type_snapshot
              else c.taxpayer_type_code end,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'gravado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         d.tax_amount * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exento'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment is null
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         -- La ND por IGTF tiene una sola línea, la del IGTF: su total de VENTA es cero.
         case when coalesce(bool_and(pr.system_code = 'igtf'), false) then 0
              else d.total_amount end * f.factor,
         -- 20261005100000 (ADR-0082): el asiento de la factura de retiro ES el de su salida del
         -- kardex (gasto por retiro + débito fiscal contra inventario). Se busca por el movimiento
         -- y no por un enlace guardado: así vale igual si el hecho pasó por la cola de pendientes.
         case when d.kind = 'withdrawal_invoice' then
                (select e.id from public.journal_entries e
                  where e.company_id = d.company_id and e.source_kind = 'inventory_move'
                    and e.source_id = d.withdrawal_move_id
                    and e.source_event = 'stock.withdrawn'
                    -- 20261005100200: también el asiento REVERSADO (la factura de retiro anulada
                    -- sigue señalando su asiento original, como la factura de venta anulada), y
                    -- nunca el contra-asiento.
                    and e.status in ('posted', 'reversed') and e.is_reversal_of is null
                  limit 1)
              else d.journal_entry_id end,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind = 'credit_note' then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
  union all
  -- 20261003110000 (ADR-0078 §3): la Nota de retiro, venta a la propia empresa (LIVA art. 4.3).
  -- Documento interno: sin número de control; el adquirente es la empresa misma.
  select n.id, platform.caracas_day(n.issued_at), 'withdrawal_note'::text, 'NR'::text,
         n.note_number, null::bigint, 'issued'::text,
         -- 20261003110100: el adquirente CONGELADO en la nota, no companies en vivo.
         n.company_tax_id_snapshot, n.company_name_snapshot, n.company_taxpayer_type_snapshot,
         n.functional_currency, 1::numeric,
         case when n.tax_treatment = 'gravado' then n.base_functional else 0 end,
         n.tax_functional,
         case when n.tax_treatment = 'exento' then n.base_functional else 0 end,
         case when n.tax_treatment = 'exonerado' then n.base_functional else 0 end,
         case when n.tax_treatment = 'no_sujeto' then n.base_functional else 0 end,
         case when n.tax_treatment is null then n.base_functional else 0 end,
         n.base_functional + n.tax_functional,
         (select e.id from public.journal_entries e
           where e.company_id = n.company_id and e.source_kind = 'inventory_move'
             and e.source_id = n.move_id and e.source_event = 'stock.withdrawn'
             and e.status = 'posted'
           limit 1),
         0::numeric
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company
     and platform.caracas_day(n.issued_at) between p_from and p_to
  ) x (document_id, issued_on, kind, series, document_number, control_number, status,
       customer_tax_id, customer_name, customer_taxpayer_type, transaction_currency, fx_rate,
       base_gravada, iva_debito, base_exenta, base_exonerada, base_no_sujeta, base_sin_clasificar,
       total_amount, journal_entry_id, igtf_percibido)
   order by coalesce((select d.issued_at from public.documents d where d.id = x.document_id),
                     (select n.issued_at from public.inventory_withdrawal_notes n
                       where n.id = x.document_id)),
            x.series, x.document_number
$function$;
