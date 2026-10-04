-- Módulo: compras (ola 3 del recorrido 2026-09-24, familia «sin RIF y la llegada")
-- Spec: RESPUESTA_RECORRIDO_2026-09-24.md §3 D-01 y D-04 · ADR-0066 (nota de aplicación, ola 3)
-- Hallazgos: D-04 (y el camino de D-01: la empresa sin RIF le compra al proveedor informal)
-- Reversible: SÍ, con datos vivos y una condición (ver REVERSIÓN al final). Homologación: NO.
--
-- Qué cambia:
--
--   1. `suppliers_tax_id_required_chk` exigía RIF a TODO proveedor nacional. El motivo que daba
--      su comentario —«sin RIF no se puede llevar al libro de compras ni practicarle retención»—
--      es verdad de la COMPRA CON FACTURA, no del proveedor: al señor de las verduras que no da
--      factura se le compra igual, y esa compra no va al libro ni retiene (ADR-0066, cuarta
--      salida). La regla se cae del proveedor…
--
--   2. …y se pone donde vive su motivo: una factura de proveedor CON soporte fiscal
--      (`fiscal_support`) a un proveedor NACIONAL sin RIF no se inserta. Es la segunda capa: el
--      caso de uso lo dice antes en palabras de persona (`registerSupplierInvoice`); el trigger
--      cierra cualquier otro camino. El extranjero sigue sin RIF y con su referencia, como antes.
--      La retención solo se practica sobre facturas con soporte (purchases.ts), así que el mismo
--      trigger la cubre.
--
--   `suppliers_national_shape_chk` (tipo de persona y de contribuyente obligatorios en el
--   nacional) NO cambia: el proveedor sin RIF los recibe del caso de uso (`natural`,
--   `no_contribuyente`: sin RIF no hay inscripción), decidido por criterio en ADR-0066.
-- =============================================================================

-- ── 1. El proveedor nacional ya no exige RIF ─────────────────────────────────
alter table public.suppliers drop constraint if exists suppliers_tax_id_required_chk;

comment on table public.suppliers is
  'Proveedores. `supplier_kind` gobierna la forma fiscal: extranjero sin RIF y sin clasificación '
  'venezolana, nacional con su clasificación. El RIF del nacional es opcional desde 20261003160000 '
  '(D-04): sin él se le compra sin factura; la compra CON factura lo exige '
  '(`supplier_invoices_fiscal_needs_tax_id`). El formato del RIF sigue VALIDAR-SENIAT.';

-- ── 2. La compra con factura exige el RIF del proveedor nacional ─────────────
create or replace function platform.supplier_invoice_fiscal_needs_tax_id()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.fiscal_support
     and exists (select 1 from public.suppliers s
                  where s.id = new.supplier_id and s.company_id = new.company_id
                    and s.supplier_kind = 'nacional' and s.tax_id is null) then
    raise exception using
      errcode = 'LAD96',
      message = 'LAD96: una factura de proveedor con soporte fiscal exige el RIF del proveedor '
                'nacional (libro de compras y retención). Sin RIF, la compra es sin soporte fiscal.';
  end if;
  return new;
end;
$$;
comment on function platform.supplier_invoice_fiscal_needs_tax_id() is
  'D-04 (2026-10-03): la regla que antes vivía en suppliers_tax_id_required_chk, puesta donde vive '
  'su motivo — el libro de compras y la retención son de la factura con soporte fiscal. Quitarla '
  'deja entrar al libro una factura de un proveedor nacional sin RIF.';
revoke all on function platform.supplier_invoice_fiscal_needs_tax_id() from public;

drop trigger if exists supplier_invoices_fiscal_needs_tax_id on public.supplier_invoices;
create trigger supplier_invoices_fiscal_needs_tax_id
  before insert or update of fiscal_support, supplier_id on public.supplier_invoices
  for each row execute function platform.supplier_invoice_fiscal_needs_tax_id();

-- La condición de la reversión, comprobada al aplicar: hoy no hay ninguna factura con soporte de
-- un proveedor nacional sin RIF (la CHECK de arriba lo impedía). Si la hubiera, algo ya se coló.
do $$
begin
  if exists (select 1 from public.supplier_invoices i
               join public.suppliers s on s.id = i.supplier_id
              where i.fiscal_support and s.supplier_kind = 'nacional' and s.tax_id is null) then
    raise exception 'LAD96: hay facturas con soporte fiscal de proveedores nacionales sin RIF';
  end if;
end $$;

-- =============================================================================
-- REVERSIÓN (con datos vivos):
--   drop trigger supplier_invoices_fiscal_needs_tax_id on public.supplier_invoices;
--   drop function platform.supplier_invoice_fiscal_needs_tax_id();
--   alter table public.suppliers add constraint suppliers_tax_id_required_chk
--     check (supplier_kind = 'extranjero' or tax_id is not null);
-- La última sentencia FALLA si ya se guardó algún proveedor nacional sin RIF, que es lo que esta
-- migración permite. Revertir exige antes decidir qué hacer con ellos (pedirles el RIF o marcarlos
-- `inactive` y crear el proveedor con RIF): sus compras sin factura no dependen de la CHECK y se
-- quedan como están. No se inventa un RIF para que la CHECK pase.
-- =============================================================================
