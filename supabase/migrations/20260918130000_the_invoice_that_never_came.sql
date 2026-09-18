-- =============================================================================
-- Ladino — migración 70 · LA FACTURA QUE NO LLEGÓ (ADR-0066 §8, control 2)
--
-- «Todavía no me la dan» es un camino legítimo de la llegada: la mercancía entra
-- al depósito contra «mercancía recibida por facturar» y la factura se engancha
-- cuando aparezca. Lo que no puede pasar es que esa cuenta puente **crezca para
-- siempre sin que nadie la mire**: es el agujero clásico de GRNI, y hasta hoy
-- Ladino no tenía dónde verlo ni quién lo contara.
--
-- Esta función es a la vez la pestaña «Falta la factura» y el control: una sola
-- definición, y la pantalla y el aviso preguntan lo mismo. Devuelve lo recibido
-- que NO está facturado —del todo o en parte— con su antigüedad en días, para
-- que el aviso a los 30 días no necesite recalcular nada.
--
-- No es un invariante: una recepción sin factura de hace tres días es normal.
-- Por eso devuelve filas y no un cero, y por eso el aviso es ámbar y no un
-- bloqueo (la regla de la casa: un rojo que no distingue causas enseña a
-- ignorarlo).
--
-- Reversibilidad: total (`drop function`). No toca datos ni esquema.
-- HOMOLOGATION_IMPACT = NO: es una lectura.
-- =============================================================================

create function platform.receipts_pending_invoice(p_company uuid)
returns table (
  receipt_id uuid, received_on date, age_days integer, supplier_id uuid, supplier_name text,
  delivery_note_ref text, quantity_received numeric, quantity_invoiced numeric,
  pending_amount numeric
)
language sql
stable
set search_path = ''
as $$
  select gr.id,
         (gr.received_at at time zone 'America/Caracas')::date as received_on,
         ((now() at time zone 'America/Caracas')::date
          - (gr.received_at at time zone 'America/Caracas')::date)::int as age_days,
         gr.supplier_id, s.legal_name, gr.delivery_note_ref,
         sum(rl.quantity) as quantity_received,
         coalesce(sum(fact.q), 0) as quantity_invoiced,
         -- Lo que falta por facturar, valorado al costo con el que entró: es lo que queda
         -- vivo en la cuenta puente.
         round(sum((rl.quantity - coalesce(fact.q, 0)) * rl.unit_cost_functional), 8)
           as pending_amount
    from public.goods_receipts gr
    join public.suppliers s on s.id = gr.supplier_id
    join public.goods_receipt_lines rl on rl.goods_receipt_id = gr.id
    left join lateral (
      select sum(il.quantity) as q from public.supplier_invoice_lines il
       join public.supplier_invoices i on i.id = il.supplier_invoice_id
      where il.goods_receipt_line_id = rl.id and i.status <> 'annulled'
    ) fact on true
   where gr.company_id = p_company
     and gr.status = 'confirmed'
   group by gr.id, gr.received_at, gr.supplier_id, s.legal_name, gr.delivery_note_ref
  having sum(rl.quantity) > coalesce(sum(fact.q), 0)
   order by 2
$$;
comment on function platform.receipts_pending_invoice(uuid) is
  'Lo RECIBIDO que todavía no está facturado, con su antigüedad en días y el importe que sigue '
  'vivo en «mercancía recibida por facturar». Es la pestaña «Falta la factura» y el control de '
  'los 30 días: una sola definición para los dos (ADR-0066 §8).';
revoke execute on function platform.receipts_pending_invoice(uuid) from public;
grant execute on function platform.receipts_pending_invoice(uuid) to authenticated, ladino_api;
