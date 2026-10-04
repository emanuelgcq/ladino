-- =============================================================================
-- Ladino — LA REGLA DE ANULACIÓN FALLA CERRADA
-- Módulo: ventas (anulación)   Spec: ADR-0061 (notas de la ola 4) · G-10
-- Reversible: SÍ (volver a la definición de 20261004160000)   Homologación: YES (misma regla)
--
-- Corrige 20261004160000, escrita minutos antes en esta misma ola: allí, «cero filas» significaba
-- a la vez «nada impide anular» y «no veo ese documento» (otra empresa, otro tenant bajo la RLS, o
-- un id que no existe). Quien llamara sin haber cargado antes el documento leería un permiso donde
-- solo había ceguera: es el patrón de ADR-0023 (ausencia de fallo leída como éxito). Los dos casos
-- de uso que la llaman cargan el documento primero, pero una función que responde «sí» por omisión
-- no puede depender de que todos sus llamadores futuros lo recuerden.
--
-- Ahora: un documento que quien llama NO VE en esa empresa devuelve `not_found` (prioridad 0).
-- Para un documento visible que no es factura emitida (recibo, nota, borrador) la función sigue
-- devolviendo cero filas: no es papel fiscal que ella juzgue, y lo dice su comentario.
--
-- Parte de la ÚNICA definición anterior (20261004160000); ninguna migración posterior la toca.
-- El resto del cuerpo es idéntico: misma granularidad (día de Caracas contra día de Caracas;
-- cierre de caja, instante contra instante), mismas tres razones, mismo orden.
-- EXPAND: solo añade una razón posible al resultado. No lee nada creado después de su timestamp.
-- =============================================================================

create or replace function platform.invoice_annulment_blockers(
  p_company uuid,
  p_document uuid,
  p_at timestamptz
)
returns table (reason text, priority int)
language sql
stable
set search_path to ''
as $function$
  select x.reason, x.priority from (
    -- Falla cerrada: lo que no se ve no se puede anular.
    select 'not_found'::text as reason, 0 as priority
     where not exists (select 1 from public.documents d
                        where d.id = p_document and d.company_id = p_company)
    union all
    select b.reason, b.priority
      from public.documents d
     cross join lateral (
       -- Día de Caracas contra día de Caracas: nunca un date contra un instante.
       select 'not_same_day'::text as reason, 1 as priority
        where platform.caracas_day(d.issued_at) <> platform.caracas_day(p_at)
       union all
       -- El día de la emisión cae en un período de IVA ya declarado antes de p_at.
       select 'period_declared', 2
        where exists (
          select 1 from public.iva_period_results r
           where r.company_id = d.company_id
             and platform.caracas_day(d.issued_at) between r.period_from and r.period_to
             and r.created_at <= p_at)
       union all
       -- Instante contra instante: la caja se cerró DESPUÉS de emitir y antes de p_at.
       select 'cash_closed', 3
        where exists (
          select 1 from public.cash_closings cc
           where cc.company_id = d.company_id
             and cc.closed_at >= d.issued_at
             and cc.closed_at <= p_at
             and (
               cc.account_id in (select p.account_id from public.payments p
                                  where p.document_id = d.id and p.account_id is not null)
               or (not exists (select 1 from public.payments p
                                where p.document_id = d.id and p.account_id is not null)
                   and (cc.branch_id is null or d.branch_id is null
                        or cc.branch_id = d.branch_id))))
     ) b
     where d.id = p_document
       and d.company_id = p_company
       and d.kind = 'invoice'
       and d.issued_at is not null
  ) x
  order by x.priority
$function$;

comment on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) is
  'G-10 (PA 00071 arts. 22 y 36): por qué una FACTURA ya no se puede anular y se corrige con nota '
  'de crédito. not_found (quien llama no ve ese documento en esa empresa: falla cerrada, '
  '20261004160100), not_same_day (día de Caracas de la emisión <> día de Caracas de p_at), '
  'period_declared (el día de la emisión cae en un período de IVA declarado antes de p_at), '
  'cash_closed (un cierre de su caja —o, sin cobros con cuenta, de la empresa— entre la emisión y '
  'p_at). Cero filas = documento visible sin impedimento de papel (o que no es factura emitida: '
  'la función solo juzga facturas). Que el original y las copias están en mano lo confirma la '
  'persona en annulInvoice. No mira cobros reversados (P-91). SECURITY INVOKER: lee bajo la RLS '
  'de quien llama.';

revoke execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz) from public;
grant execute on function platform.invoice_annulment_blockers(uuid, uuid, timestamptz)
  to ladino_api, authenticated;
