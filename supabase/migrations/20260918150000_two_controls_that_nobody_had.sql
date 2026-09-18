-- =============================================================================
-- Ladino — migración 72 · LOS DOS CONTROLES QUE FALTABAN (ADR-0066 §8)
--
-- Con una sola puerta, el doble registro es raro. «Raro» no es «nunca»: la
-- entrada suelta sigue existiendo para el aporte, el conteo positivo entra
-- mercancía con otro nombre, y la API es la API. Así que hay control.
--
--   1. `duplicate_stock_in_gaps` — la MISMA cantidad del MISMO producto en el
--      MISMO depósito y el MISMO día, entrada dos veces por caminos distintos:
--      una con documento (una compra) y otra sin él (un aporte o un ajuste
--      positivo). Es la forma que toma el error cuando alguien registra la
--      compra y además «mete» la mercancía.
--
--   2. `backdated_stock_in` — las llegadas fechadas HACIA ATRÁS que tienen
--      ventas entre medias. **No es un invariante y no puede serlo**: el
--      promedio móvil se calcula en el orden de inserción, así que una llegada
--      fechada atrás no corrige el costo de lo ya vendido, y ninguna suma lo
--      ve. Esto es un REPORTE para el contador: dice qué movimientos salieron
--      con un costo que la llegada posterior habría cambiado. Su respuesta
--      correcta no es cero: es «estos, y ya están explicados».
--
-- La distinción importa y va escrita para que nadie la «ascienda» luego: un
-- gate que devuelve filas normales enseña a ignorar los gates.
--
-- Reversibilidad: total (`drop function`). No tocan datos.
-- HOMOLOGATION_IMPACT = NO: son lecturas.
-- =============================================================================

create function platform.duplicate_stock_in_gaps(p_company uuid)
returns table (
  product_id uuid, product_name text, warehouse_id uuid, arrived_on date,
  quantity numeric, moves bigint, with_document bigint, without_document bigint
)
language sql
stable
set search_path = ''
as $$
  select m.product_id, p.name, m.warehouse_id,
         (m.occurred_at at time zone 'America/Caracas')::date as arrived_on,
         m.quantity,
         count(*) as moves,
         count(*) filter (where m.source_document_id is not null) as with_document,
         count(*) filter (where m.source_document_id is null) as without_document
    from public.inventory_moves m
    join public.products p on p.id = m.product_id
   where m.company_id = p_company
     and m.quantity > 0
   group by m.product_id, p.name, m.warehouse_id,
            (m.occurred_at at time zone 'America/Caracas')::date, m.quantity
  having count(*) > 1
     and count(*) filter (where m.source_document_id is not null) > 0
     and count(*) filter (where m.source_document_id is null) > 0
   order by 4 desc, 2
$$;
comment on function platform.duplicate_stock_in_gaps(uuid) is
  'Posible DOBLE REGISTRO: la misma cantidad del mismo producto, en el mismo depósito y el mismo '
  'día, entrada una vez CON documento (compra) y otra SIN él (aporte o ajuste positivo). Aviso, '
  'no bloqueo: dos entradas iguales pueden ser legítimas, y por eso lo mira una persona '
  '(ADR-0066 §8).';
revoke execute on function platform.duplicate_stock_in_gaps(uuid) from public;
grant execute on function platform.duplicate_stock_in_gaps(uuid) to authenticated, ladino_api;

create function platform.backdated_stock_in(p_company uuid)
returns table (
  move_id uuid, product_id uuid, product_name text, arrived_on date, registered_on date,
  sold_between numeric
)
language sql
stable
set search_path = ''
as $$
  -- Lo vendido «entre medias» es lo que SALIÓ con fecha posterior a la llegada pero se registró
  -- ANTES que ella: su costo se calculó sin esta entrada, y ese costo ya no cambia.
  --
  -- El orden que importa es el de INSERCIÓN, y quien lo lleva dentro es el id: `uuidv7` es
  -- monótono. `created_at` no sirve para esto — es la hora de INICIO DE TRANSACCIÓN, y dos
  -- movimientos de la misma transacción la comparten exactamente (la familia de bugs de
  -- CLAUDE.md §3, otra vez).
  select m.id, m.product_id, p.name,
         (m.occurred_at at time zone 'America/Caracas')::date as arrived_on,
         (m.created_at at time zone 'America/Caracas')::date as registered_on,
         coalesce((select -sum(s.quantity) from public.inventory_moves s
                    where s.company_id = m.company_id
                      and s.product_id = m.product_id
                      and s.warehouse_id = m.warehouse_id
                      and s.quantity < 0
                      and s.occurred_at >= m.occurred_at
                      and s.id < m.id), 0) as sold_between
    from public.inventory_moves m
    join public.products p on p.id = m.product_id
   where m.company_id = p_company
     and m.quantity > 0
     and (m.occurred_at at time zone 'America/Caracas')::date
       < (m.created_at at time zone 'America/Caracas')::date
   order by 4 desc
$$;
comment on function platform.backdated_stock_in(uuid) is
  'REPORTE, no invariante (ADR-0066 §5 y §8): entradas fechadas hacia atrás y cuántas unidades '
  'salieron entre medias con un costo que esta llegada habría cambiado. El promedio móvil es de '
  'orden de inserción y no se recalcula; ninguna suma ve esto, y por eso lo lee una persona.';
revoke execute on function platform.backdated_stock_in(uuid) from public;
grant execute on function platform.backdated_stock_in(uuid) to authenticated, ladino_api;
