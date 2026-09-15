-- =============================================================================
-- Ladino — migración 57 · LA VENTA CON LOTES REPARTE POR FEFO (ADR-0060 §3)
--
-- Módulo: inventario · ventas (RIGOR MÁXIMO: stock y costo)
-- Spec: ADR-0060 §3 · ADR-0034 (kardex) · migración 20 (lotes, LAD38/LAD46)
-- HOMOLOGATION_IMPACT: NO.
--
-- EL DEFECTO (V1, e2e-ola0-verificaciones). La venta no manda lote: descontaba
-- del lote NULO, que en un producto con lotes está vacío, y respondía 409
-- NEGATIVE_STOCK con existencia en el depósito. Un producto con lotes no se
-- podía vender. `suggest_lot_fefo` devuelve UN lote y era sugerencia para la UI.
--
-- LA DECISIÓN. `platform.allocate_lots_fefo` reparte una cantidad entre VARIOS
-- lotes: primero vence, primero sale; nunca un lote vencido ni inactivo. La
-- usa `issueStockBatch` (el lote de salidas del kardex, que usa la venta) para
-- toda línea sin lote de un producto que se lleva por lotes. Cada lote sale a
-- SU costo. Si lo no vencido no alcanza, la salida se rechaza con mensaje de
-- persona; lo vencido solo sale por ajuste con `inventory.expired` (LAD46).
--
-- LA FECHA DE REFERENCIA la pasa quien llama, y es la MISMA expresión que usa el
-- trigger LAD46 para juzgar el vencimiento (`occurred_at::date`). Si divergieran,
-- el reparto elegiría un lote que el trigger rechaza. Que esa fecha sea el día
-- de la sesión (UTC) y no el de Caracas es un defecto de la familia de CLAUDE.md
-- §3 que vive en el trigger; queda registrado (RISK_REGISTER) y no se arregla a
-- medias aquí.
--
-- REVERSIBILIDAD: total. La función no escribe; `drop function` la retira y el
-- dominio vuelve a pedir lote nulo (y al 409).
-- =============================================================================

create or replace function platform.allocate_lots_fefo(
  p_company uuid, p_warehouse uuid, p_product uuid, p_quantity numeric, p_reference date
)
returns table (lot_id uuid, quantity numeric, expires_at date)
language sql
stable
set search_path = ''
as $$
  with candidatos as (
    select l.id, b.quantity as disponible, l.expires_at,
           sum(b.quantity) over (order by l.expires_at nulls last, l.created_at, l.id
                                 rows between unbounded preceding and current row) as acumulado
      from public.lots l
      join public.stock_balances b
        on b.lot_id = l.id and b.company_id = p_company and b.warehouse_id = p_warehouse
     where l.company_id = p_company
       and l.product_id = p_product
       and l.status = 'active'
       and b.quantity > 0
       and (l.expires_at is null or l.expires_at >= p_reference)
  )
  select c.id,
         least(c.disponible, p_quantity - (c.acumulado - c.disponible)),
         c.expires_at
    from candidatos c
   where p_quantity > 0
     and c.acumulado - c.disponible < p_quantity
   order by c.expires_at nulls last, c.acumulado
$$;
comment on function platform.allocate_lots_fefo(uuid, uuid, uuid, numeric, date) is
  'FEFO obligatorio de la salida sin lote: reparte la cantidad entre los lotes '
  'activos, NO vencidos a p_reference y con existencia, primero el que vence '
  'antes. Si la suma devuelta es menor que la pedida, no alcanza. ADR-0060 §3.';
revoke execute on function platform.allocate_lots_fefo(uuid, uuid, uuid, numeric, date) from public;
grant execute on function platform.allocate_lots_fefo(uuid, uuid, uuid, numeric, date)
  to authenticated, ladino_api;
