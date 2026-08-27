-- =============================================================================
-- Ladino — migración 24 · El landed cost acumulado de una línea NO es una
--                          columna: se deriva de sus asignaciones
--
-- Módulo: purchases  Spec: ADR-0040 §5-6
-- Reversible: SÍ. La columna que se quita nació en la 22 y nunca llegó a tener
--             un valor distinto de cero.
-- Homologación: NO.
--
-- POR QUÉ. `goods_receipt_lines.landed_cost_functional` era un acumulado que
-- había que ACTUALIZAR cada vez que se aplicaba un gasto. Y una línea de
-- recepción confirmada es INMUTABLE —`assert_purchase_lines_immutable()`, que
-- es lo correcto—, así que el propio caso de uso de landed cost se estrellaba
-- contra su propia defensa: para costear tenía que editar un documento cerrado.
--
-- Se podía haber exceptuado esa columna en el trigger. Se decidió que no: un
-- trigger compartido con casos especiales se aplica mal, que es el argumento
-- que sostiene el ADR-0040 §1 entero. Abrirle un agujero al de compras dos
-- migraciones después de escribirlo habría sido gracioso.
--
-- La columna era además REDUNDANTE. `landed_cost_allocations` es append-only y
-- guarda el reparto congelado por línea; `sum(allocated_functional)` es el
-- acumulado, exacto y sin posibilidad de desincronizarse. Se sustituye por una
-- función, que es lo mismo que se hizo con el saldo de un documento y con la
-- antigüedad: **si se puede derivar de un hecho append-only, no se guarda.**
-- =============================================================================

alter table public.goods_receipt_lines drop column landed_cost_functional;

create function platform.line_landed_cost(p_company uuid, p_line uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(a.allocated_functional), 0)
    from public.landed_cost_allocations a
   where a.company_id = p_company and a.goods_receipt_line_id = p_line
$$;
comment on function platform.line_landed_cost(uuid, uuid) is
  'Landed cost acumulado de una línea de recepción. DERIVADO de las '
  'asignaciones, que son append-only: un acumulado guardado exigiría editar un '
  'documento confirmado y podría desincronizarse.';
revoke execute on function platform.line_landed_cost(uuid, uuid) from public;
grant execute on function platform.line_landed_cost(uuid, uuid) to authenticated, ladino_api;

-- ── Dos defectos que encontró el E2E de compras, no una revisión ───────────

-- 1. La migración 23 se contradijo con la 19 y nadie lo vio hasta ejecutar el
--    flujo entero. `inventory_moves_reason_chk` (migración 19) dice que SOLO un
--    'ajuste' lleva `reason`; la 23 exige que una 'revaluacion' lleve origen o
--    motivo. Juntas prohibían el motivo en el único tipo que más lo necesita, y
--    la revalorización del landed cost moría con un 23514 genérico.
--
--    Se resuelve haciendo el motivo OBLIGATORIO en la revalorización, no
--    opcional: un valor de inventario que sube sin una frase que lo explique es
--    exactamente lo que hace imposible auditar un margen después.
alter table public.inventory_moves drop constraint inventory_moves_reason_chk;
alter table public.inventory_moves add constraint inventory_moves_reason_chk check (
  (kind in ('ajuste', 'revaluacion')) = (reason is not null)
  and (reason is null or (reason = btrim(reason) and length(reason) between 3 and 500)));

-- 2. `retention_concepts` se concedió a `authenticated` y NO a `ladino_api`, que
--    es quien de verdad lo lee: el caso de uso necesita saber si un concepto es
--    de IVA o de ISLR para elegir la base. El síntoma fue un 42501 que la regla
--    404/403 convierte en «Recurso no encontrado» — correcto por diseño y
--    desconcertante de depurar, que es el precio de esa regla.
grant select on public.retention_concepts to ladino_api;

-- LAD58: lo que esta migración garantiza sobre sí misma.
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'goods_receipt_lines'
                and column_name = 'landed_cost_functional') then
    raise exception 'LAD58: la columna redundante sigue ahí y el landed cost volvería a chocar con la inmutabilidad';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                  where n.nspname = 'platform' and p.proname = 'line_landed_cost') then
    raise exception 'LAD58: falta la función que sustituye a la columna';
  end if;
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'inventory_moves_reason_chk') not like '%revaluacion%' then
    raise exception 'LAD58: la revalorización sigue sin poder llevar motivo y no podría explicarse';
  end if;
  if not exists (select 1 from information_schema.role_table_grants
                  where table_schema = 'public' and table_name = 'retention_concepts'
                    and grantee = 'ladino_api' and privilege_type = 'SELECT') then
    raise exception 'LAD58: ladino_api no puede leer retention_concepts y no sabría qué base retener';
  end if;
end $$;
