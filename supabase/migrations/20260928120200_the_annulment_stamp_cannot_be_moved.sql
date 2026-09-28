-- =============================================================================
-- Ladino — EL SELLO DE LA ANULACIÓN NO SE MUEVE
-- Módulo: compras / libros fiscales. Spec: docs/02_COMPLIANCE/REPORTING_AND_FISCAL_BOOKS.md
-- Reversible: SÍ (el cuerpo de una función de trigger; sin datos). HOMOLOGATION_IMPACT: YES —
--   el sello decide si una anulación cambia el libro de su período o entra como ajuste
--   del período en curso (R-2 ampliada, P-46).
--
-- Hallazgo del revisor sobre la migración 20260928120000: `annulled_at` se podía
-- elegir y cambiar. El trigger hacía `coalesce(new.annulled_at, now())`, así que:
--   · se podía anular con `annulled_at = '2001-01-01'` y colocar la anulación antes
--     de cerrar y presentar el período (o después) a voluntad;
--   · en una factura ya anulada, `annulled_at` se podía mover o borrar: el trigger de
--     inmutabilidad (`assert_purchase_doc_immutable`) neutraliza esa clave a propósito
--     para permitir la transición, y nada más la miraba.
-- Mover el sello es mover una línea de un libro presentado a otro período.
--
-- Ahora:
--   · en la transición a «annulled», el sello es `now()` SIEMPRE: lo que venga se ignora;
--   · en una factura ya anulada, cambiar o borrar el sello es LAD06 — el mismo código
--     que cualquier edición de un documento de compra confirmado (ERROR_CATALOG).
-- Límite que se conserva y se dice: el trigger es BEFORE UPDATE. Un INSERT que ya
-- nazca «annulled» (ninguna vía del producto lo hace; solo una carga por SQL) trae su
-- propio sello. Ver R-54.
-- =============================================================================

create or replace function platform.stamp_supplier_invoice_annulled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'annulled' then
    if new.annulled_at is distinct from old.annulled_at then
      raise exception
        'el momento de la anulación de una factura de proveedor no se cambia ni se borra: decide en qué libro cae (R-2)'
        using errcode = 'LAD06';
    end if;
  elsif new.status = 'annulled' then
    -- `now()` es el inicio de la transacción: la misma hora que sella `created_at`
    -- en fiscal_book_runs e iva_period_results, así que «se anuló en la misma
    -- transacción que se generó el libro» cuenta como después.
    new.annulled_at := now();
  end if;
  return new;
end;
$$;
revoke execute on function platform.stamp_supplier_invoice_annulled_at() from public;
