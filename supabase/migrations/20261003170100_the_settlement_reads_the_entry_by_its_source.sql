-- =============================================================================
-- Ladino — LO QUE EL MAYOR LE CARGA A UN DOCUMENTO SE BUSCA POR EL ORIGEN DEL ASIENTO
-- (ADR-0075 §4; corrige 20261003170000 §6)
--
-- Módulo: contabilidad. Rigor máximo. Solo lectura: una función, sin datos.
-- Reversible: SÍ — vuelve a la definición de 20261003170000 §6 con otra migración.
-- HOMOLOGATION_IMPACT: NO.
--
-- El defecto: `platform.settlement_ledger_open` (20261003170000 §6) buscaba el asiento de cada
-- cobro y de cada pago por su columna `journal_entry_id`, y esa columna NO se escribe en
-- `payments` ni en `supplier_payments`: el vínculo de un cobro con su asiento es
-- `journal_entries.source_kind + source_id` (el eje de la idempotencia del generador). La función
-- respondía NULL para todo documento con un cobro, y el invariante `settled_ledger_gaps` —que
-- salta lo que no tiene asiento— quedaba INERTE: verde sin mirar nada. Lo destapó el E2E
-- (e2e-moneda-diferencial), no el invariante.
--
-- Ahora cada pieza resuelve su asiento por las dos vías: su `journal_entry_id` si lo tiene, y
-- los asientos posteados cuyo origen es la pieza. NULL solo si una pieza no tiene NINGUNO.
-- create or replace sobre la VIVA (20261003170000 §6); misma firma, mismos grants.
-- =============================================================================

create or replace function platform.settlement_ledger_open(
  p_company uuid, p_side text, p_document uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  with piezas as (
    select d.id, 'documento'::text as clase, d.journal_entry_id as entry_id
      from public.documents d
     where p_side = 'ar' and d.company_id = p_company and d.id = p_document
    union all
    select p.id, 'payment_received', p.journal_entry_id
      from public.payments p
     where p_side = 'ar' and p.company_id = p_company and p.document_id = p_document
    union all
    select i.id, 'documento', i.journal_entry_id
      from public.supplier_invoices i
     where p_side = 'ap' and i.company_id = p_company and i.id = p_document
    union all
    select p.id, 'payment_made', p.journal_entry_id
      from public.supplier_payments p
     where p_side = 'ap' and p.company_id = p_company and p.supplier_invoice_id = p_document
    union all
    select n.id, 'documento', n.journal_entry_id
      from public.supplier_credit_notes n
     where p_side = 'ap' and n.company_id = p_company and n.supplier_invoice_id = p_document
       and n.status = 'posted'
  ),
  asientos as (
    select z.id as pieza, z.entry_id
      from piezas z
     where z.entry_id is not null
    union
    select z.id, e.id
      from piezas z
      join public.journal_entries e
        on e.company_id = p_company and e.source_id = z.id and e.status = 'posted'
       and e.is_reversal_of is null
       and (z.clase = 'documento' or e.source_kind = z.clase)
  )
  select case
           when p_side not in ('ar', 'ap') then null
           when not exists (select 1 from piezas) then null
           when exists (select 1 from piezas z
                         where not exists (select 1 from asientos a where a.pieza = z.id))
             then null
           else (
             select coalesce(sum(case when p_side = 'ar'
                                      then l.debit_amount - l.credit_amount
                                      else l.credit_amount - l.debit_amount end), 0)
               from public.journal_lines l
               join public.journal_entries e on e.id = l.entry_id
              where l.company_id = p_company
                and e.status = 'posted'
                and (e.id in (select entry_id from asientos)
                     or e.is_reversal_of in (select entry_id from asientos))
                and l.account_id in (
                      select s.account_id from public.company_account_settings s
                       where s.company_id = p_company
                         and s.purpose = case p_side when 'ar' then 'ar_general'
                                                     else 'ap_general' end))
         end
$$;
comment on function platform.settlement_ledger_open(uuid, text, uuid) is
  'Lo que el mayor todavía le carga a un documento en cuentas por cobrar (''ar'') o por pagar '
  '(''ap''): su asiento, los de sus cobros o pagos y notas —por journal_entry_id o por el origen '
  'del asiento (source_kind + source_id)—, y sus reversas. NULL si alguna pieza no tiene asiento '
  '(cola). La usan el cobro/pago que cierra (ADR-0075 §4: cierra en cero exacto) y el invariante '
  'settled_ledger_gaps.';
