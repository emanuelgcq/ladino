-- =============================================================================
-- Migración 51 · NUMERACIÓN DE ÓRDENES Y RECEPCIONES BAJO CANDADO
--
-- Hallazgo M-16 de la auditoría del 2026-09-11. El correlativo de las órdenes
-- de compra y de las recepciones se calculaba en el dominio con
-- `max(n) + 1` sin serializar: dos confirmaciones simultáneas de la misma
-- empresa leían el mismo máximo, y el índice único parcial de la migración 23
-- convertía a UNA de las dos en un 409 DUPLICATE sin explicación posible para
-- quien la vio fallar — no era un duplicado suyo, era una carrera.
--
-- Módulo: compras. Spec: PURCHASES_SPEC §numeración, ADR-0039 (el correlativo
-- se reclama en la base, con candado consultivo por serie, como ya hacen
-- claim_document_number, claim_entry_number y claim_retention_receipt_number).
-- Reversible: `drop function`; el dominio anterior calculaba el número por
-- su cuenta (con la carrera que esta migración cierra).
-- HOMOLOGATION_IMPACT: NO. Órdenes y recepciones no son documentos fiscales.
-- =============================================================================

create function platform.claim_purchase_order_number(p_company uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|purchase_order', 0));
  select coalesce(max(o.order_number), 0) + 1 into v_next
    from public.purchase_orders o
   where o.company_id = p_company and o.order_number is not null;
  return v_next;
end;
$$;
comment on function platform.claim_purchase_order_number(uuid) is
  'Siguiente correlativo de orden de compra de la empresa, bajo candado consultivo '
  'de transacción: dos confirmaciones simultáneas se serializan en vez de chocar '
  'contra el índice único (auditoría 2026-09-11, M-16).';
revoke execute on function platform.claim_purchase_order_number(uuid) from public;
grant  execute on function platform.claim_purchase_order_number(uuid) to ladino_api;

create function platform.claim_goods_receipt_number(p_company uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_next bigint;
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_company::text || '|goods_receipt', 0));
  select coalesce(max(r.receipt_number), 0) + 1 into v_next
    from public.goods_receipts r
   where r.company_id = p_company and r.receipt_number is not null;
  return v_next;
end;
$$;
comment on function platform.claim_goods_receipt_number(uuid) is
  'Siguiente correlativo de recepción de mercancía de la empresa, bajo candado '
  'consultivo de transacción (auditoría 2026-09-11, M-16).';
revoke execute on function platform.claim_goods_receipt_number(uuid) from public;
grant  execute on function platform.claim_goods_receipt_number(uuid) to ladino_api;
