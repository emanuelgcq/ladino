-- =============================================================================
-- Ladino — C-07 del recorrido 2026-09-24 (ola 5)
--   «Vencido» se juzga día contra día, y el día es el de Caracas.
--
-- Módulo: inventory   Spec: ADR-0060 §3 (FEFO) · ADR-0054 (el día de negocio es el de Caracas)
-- Reversible: SÍ, con y sin datos: son tres `create or replace` y ninguno escribe filas. Volver
--             atrás es reponer la expresión anterior (`new.occurred_at::date` y `CURRENT_DATE`).
--             Lo que NO se deshace es lo que se haya vendido o rechazado mientras estuvo vigente
--             (los movimientos son append-only), que es lo correcto.
-- Homologación: NO
--
-- QUÉ PASABA. `lots.expires_at` es un `date` y se comparaba con `new.occurred_at::date`: un
-- `timestamptz` convertido a fecha en la zona de la SESIÓN (UTC). Desde las 20:00 de Caracas esa
-- fecha ya es «mañana», y un lote que vence HOY se trataba como vencido cuatro horas antes de que
-- terminara su día: la caja dejaba de venderlo a las ocho de la noche. Es la familia de CLAUDE.md
-- §3 («una fecha comparada contra un punto de reloj, sin normalizar, es un bug con horario»).
--
-- LA GRANULARIDAD QUE SE DECLARA: un lote está vencido cuando `expires_at < día de Caracas del
-- movimiento`. Dos `date`. El día en que vence todavía se vende.
--
-- QUÉ HACE.
--   1. `platform.apply_inventory_move()`: SOLO cambia la expresión de LAD46. Se parte de la
--      definición VIVA leyéndola del catálogo en el momento de aplicar (`pg_get_functiondef`) y
--      sustituyendo esa única expresión; si la expresión no está tal cual, la migración FALLA.
--      Se hace así, y no copiando las 220 líneas del trigger que costea el kardex, porque una
--      transcripción a mano de esa función es un riesgo mayor que el defecto que se corrige, y
--      porque así parte de la última definición sea cual sea la migración que la dejó (hoy,
--      20261003140000).
--   2. `platform.expiring_lots` y `platform.suggest_lot_fefo`: su fecha por omisión pasa de
--      `CURRENT_DATE` (día de la sesión, UTC) al día de Caracas. Cuerpos idénticos a los vivos
--      (migración 20; ninguna posterior los redefine).
--   `platform.allocate_lots_fefo` no cambia: recibe la fecha como parámetro y quien la pasa
--   (`repartirPorLotes`, en el dominio) decide; ese llamador pasa ahora el día de Caracas.
-- =============================================================================

do $migracion$
declare
  v_viva  text;
  v_nueva text;
begin
  v_viva := pg_get_functiondef('platform.apply_inventory_move()'::regprocedure);
  v_nueva := replace(
    v_viva,
    'l.expires_at < new.occurred_at::date',
    'l.expires_at < (new.occurred_at at time zone ''America/Caracas'')::date');
  if v_nueva = v_viva then
    raise exception
      'apply_inventory_move ya no compara el vencimiento con new.occurred_at::date: revisa su última definición antes de aplicar esta migración';
  end if;
  execute v_nueva;
end
$migracion$;

create or replace function platform.expiring_lots(
  p_company uuid, p_days integer,
  p_reference date default (now() at time zone 'America/Caracas')::date
)
returns table (lot_id uuid, lot_code text, product_id uuid, warehouse_id uuid, expires_at date,
               days_left integer, quantity numeric)
language sql
stable
set search_path = ''
as $$
  select l.id, l.code, l.product_id, b.warehouse_id, l.expires_at,
         (l.expires_at - p_reference)::integer, b.quantity
    from public.lots l
    join public.stock_balances b on b.lot_id = l.id
   where l.company_id = p_company
     and l.expires_at is not null
     and b.quantity > 0
     and l.expires_at <= p_reference + p_days
   order by l.expires_at, b.warehouse_id;
$$;

create or replace function platform.suggest_lot_fefo(
  p_company uuid, p_warehouse uuid, p_product uuid,
  p_reference date default (now() at time zone 'America/Caracas')::date
)
returns uuid
language sql
stable
set search_path = ''
as $$
  select l.id
    from public.lots l
    join public.stock_balances b on b.lot_id = l.id and b.warehouse_id = p_warehouse
   where l.company_id = p_company and l.product_id = p_product
     and l.status = 'active' and b.quantity > 0
     and (l.expires_at is null or l.expires_at >= p_reference)
   order by l.expires_at nulls last, l.created_at
   limit 1;
$$;
