-- =============================================================================
-- La ND por IGTF queda cubierta por su percepción (re-revisión 3 de la ola 2 C2).
-- Módulo: contabilidad · IGTF   Spec: docs/02_COMPLIANCE/IGTF_SPEC.md
--
-- `platform.accounting_coverage_gaps` parte de su ÚLTIMA definición viva en el orden limpio
-- (20260917120000; grep de las ocho definiciones, F5). Cambia el ENUNCIADO, no añade un perdón:
-- la Nota de Débito por IGTF (20261002100000) no tiene asiento propio —su asiento es el de su
-- percepción—, así que está cubierta si esa percepción tiene asiento O está en la cola. Antes, una
-- percepción encolada dejaba la ND como «missing» hasta importar el pendiente (R-66).
-- Solo lee lo de 20261002100000; corre antes de 20261002110000 y 120000 y no depende de ellas.
--
-- Reversible: SÍ, con datos vivos — se restaura la definición de 20260917120000 (la ND encolada
-- vuelve a contarse como hueco hasta importar su pendiente). HOMOLOGATION_IMPACT: NO (invariante
-- contable, no cambia ningún documento).
-- =============================================================================

create or replace function platform.accounting_coverage_gaps(p_company uuid)
returns table (source_kind text, source_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt' and d.status in ('issued', 'paid')
    union all
    select 'sales_credit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'credit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_debit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'debit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt_return', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt_return' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    -- ADR-0065 §1: la nota de crédito recibida es un hecho contable como la factura.
    select 'purchase_credit_note', n.id, n.journal_entry_id
      from public.supplier_credit_notes n
     where n.company_id = p_company and n.status = 'posted'
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
    union all
    select 'customer_refund', r.id, r.journal_entry_id
      from public.customer_refunds r
     where r.company_id = p_company
    union all
    select 'treasury_transfer', t.id, t.journal_entry_id
      from public.treasury_transfers t
     where t.company_id = p_company
  ),
  -- El COBRO, el PAGO a proveedor y la PERCEPCIÓN de IGTF generan asiento pero no guardan el
  -- enlace (el generador los trata como «sin backlink»): su cobertura se comprueba buscando el
  -- asiento por origen. Ninguno queda huérfano hoy —el caso de uso propaga el error y la
  -- transacción se revierte—, pero el invariante que no existe no caza nada (R-20, ADR-0065 §6).
  sin_enlace as (
    select 'payment_received'::text as k, p.id
      from public.payments p where p.company_id = p_company
    union all
    select 'payment_made', sp.id
      from public.supplier_payments sp where sp.company_id = p_company
    union all
    select 'igtf_perception', ip.id
      from public.igtf_perceptions ip where ip.company_id = p_company
  ),
  -- La ND por IGTF (20261002100000) no tiene asiento propio: su asiento ES el de su percepción
  -- (backlink). El enunciado lo dice: queda cubierta si su percepción tiene asiento O está en cola
  -- (re-revisión 3, CLAUDE.md §3: se cambia el enunciado, no se perdona).
  nd_igtf as (
    select ip.debit_note_id as id,
           bool_or(exists (select 1 from public.journal_entries e
                            where e.company_id = p_company and e.source_kind = 'igtf_perception'
                              and e.source_id = ip.id and e.status in ('posted', 'reversed')))
             as con_asiento,
           bool_or(exists (select 1 from public.journal_generation_queue q
                            where q.company_id = p_company and q.source_id = ip.id
                              and q.status = 'pending')) as en_cola
      from public.igtf_perceptions ip
     where ip.company_id = p_company and ip.debit_note_id is not null
     group by ip.debit_note_id
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null or coalesce(n.con_asiento, false) as tiene_asiento,
           (exists (select 1 from public.journal_generation_queue q
                     where q.company_id = p_company and q.source_id = d.id
                       and q.status = 'pending')
            or (d.journal_entry_id is null and coalesce(n.en_cola, false))) as tiene_pendiente
      from documentos d
      left join nd_igtf n on n.id = d.id
    union all
    select s.k, s.id,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.source_id = s.id
                      and e.source_kind = s.k and e.status in ('posted', 'reversed')),
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = s.id
                      and q.status = 'pending')
      from sin_enlace s
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
$$;
comment on function platform.accounting_coverage_gaps(uuid) is
  'INVARIANTE: todo hecho posteado tiene asiento O fila en cola, nunca ninguno y nunca los dos. '
  'Catorce fuentes: los documentos de venta, la factura y la NOTA DE CRÉDITO de compra, el '
  'gasto, el cierre, el reembolso, la transferencia, y —por origen, que no guardan enlace— el '
  'cobro, el pago a proveedor y la percepción de IGTF (ADR-0065 §§1 y 6). La ND por IGTF queda '
  'cubierta por el asiento o la fila en cola de su percepción (20261002100200).';
