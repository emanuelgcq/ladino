-- Módulo: compras y gastos   Spec: ADR-0066 · docs/02_COMPLIANCE/IVA_SPEC.md
-- Reversible: SÍ mientras no haya facturas de gasto con comprobante (ver abajo)   Homologación: NO
--
-- Corrige y completa la migración 20261004170000 (H-09), que no se edita:
--
--   1. EL CÓDIGO DEL TRIGGER. `platform.assert_service_line_on_expense_invoice()` lanzaba LAD98, y
--      LAD98 ya es de la migración 20260928190100 («falta el tipo de contribuyente»): la API lo
--      traduce a TAXPAYER_TYPE_REQUIRED/409, con un mensaje que no tiene nada que ver con una
--      línea sin producto. Dos caminos, el mismo código (CLAUDE.md §3: «asevera el mensaje»). El
--      trigger pasa a LADH9, propio, que la API traduce a VALIDATION_FAILED/422.
--   2. EL COMPROBANTE Y LA RECURRENCIA. Un gasto llano guarda la foto del recibo y si se paga
--      todos los meses (`expenses.attachment_path`, `is_recurring`). El gasto CON factura es una
--      fila de `supplier_invoices` y perdía las dos cosas al cambiar de camino: se le añaden,
--      solo para la factura de un gasto.
--
-- REVERSIBILIDAD, CON DATOS VIVOS: las dos columnas son aditivas y nulas / false en toda factura
-- existente. Quitarlas pierde la ruta del comprobante de las facturas de gasto que lo tengan (el
-- objeto sigue en el bucket, pero nadie lo enlaza). El cambio de código se revierte recreando la
-- función con LAD98, que es volver al defecto.
--
-- Función que redefine: platform.assert_service_line_on_expense_invoice() (creada en la
-- 20261004170000; ninguna migración posterior la pisa).

create or replace function platform.assert_service_line_on_expense_invoice()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is null and not exists (
       select 1 from public.supplier_invoices i
        where i.id = new.supplier_invoice_id and i.expense_category is not null) then
    raise exception
      'una línea sin producto solo va en la factura de un gasto (expense_category): la mercancía lleva su producto'
      using errcode = 'LADH9';
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_service_line_on_expense_invoice() from public;

alter table public.supplier_invoices
  add column expense_attachment_path text,
  add column expense_is_recurring boolean not null default false;
alter table public.supplier_invoices
  add constraint supplier_invoices_expense_extras_chk
  check ((expense_category is not null
          or (expense_attachment_path is null and not expense_is_recurring))
         and (expense_attachment_path is null
              or (expense_attachment_path = btrim(expense_attachment_path)
                  and length(expense_attachment_path) between 3 and 300)));
comment on column public.supplier_invoices.expense_attachment_path is
  'H-09: la ruta del comprobante en el bucket `receipts`, como `expenses.attachment_path`. Solo '
  'en la factura de un gasto (expense_category no nula).';
comment on column public.supplier_invoices.expense_is_recurring is
  'H-09: el gasto se paga todos los meses, como `expenses.is_recurring`. Solo en la factura de un gasto.';
