-- =============================================================================
-- Ladino — C-07 del recorrido 2026-09-24 (ola 5, segunda ronda)
--   Un lote de un producto que vence nace con su fecha.
--
-- Módulo: inventory   Spec: ADR-0060 §3 (FEFO) · ADR-0084 · docs/03_MODULES/INVENTORY_SPEC.md
-- Reversible: SÍ, con y sin datos. Son dos funciones de guarda y dos triggers: no crean tablas,
--             no escriben ni tocan filas. Volver atrás es `drop trigger lots_10_expiry_date on
--             public.lots; drop trigger products_expiry_needs_dated_lots on public.products;` y
--             el `drop function` de las dos. Lo que NO vuelve: los lotes que la guarda haya
--             rechazado mientras estuvo vigente no existen (era el propósito); y revertirla deja
--             otra vez la regla solo en el dominio.
-- Homologación: NO (control interno de existencias; ningún documento fiscal cambia)
--
-- QUÉ PASABA. «El lote NUEVO de un producto con vencimiento lleva su fecha» vivía solo en
-- `resolverLote` (packages/domain/src/inventory.ts). `lots.expires_at` es nullable y nada en el
-- esquema lo exigía: un lote sin fecha que entrara por otra vía —otro caso de uso, un script, una
-- importación futura— quedaba SIEMPRE al final del reparto por vencimiento (`order by expires_at
-- nulls last`) y no vencía nunca (LAD46 compara `expires_at < día`, y NULL no es menor que nada).
-- CLAUDE.md §2: «ausencia de mecanismo no es prohibición».
--
-- QUÉ HACE.
--   1. `platform.assert_lot_has_expiry_date()` + trigger `lots_10_expiry_date` (BEFORE INSERT OR
--      UPDATE OF expires_at, product_id): un lote sin fecha de un producto con `tracks_expiry` no
--      entra ni se queda sin ella (LAD73). Lee el producto CON `FOR SHARE`: así, quien enciende
--      el vencimiento a la vez espera a que este lote se confirme y lo ve (cierra la carrera).
--   2. `platform.assert_expiry_needs_dated_lots()` + trigger `products_expiry_needs_dated_lots`
--      (BEFORE UPDATE OF tracks_expiry): encender el vencimiento con algún lote sin fecha no
--      entra (LAD73). CONFIRMADO antes de escribirlo: `products_tracking_frozen` (20261005130000)
--      ya congela `tracks_expiry` con MOVIMIENTOS, pero un lote puede existir sin movimiento
--      (`lots` no depende de `inventory_moves`), así que el congelado no bastaba.
--   No se redefine ninguna función existente: las dos son nuevas.
--
-- DATOS EXISTENTES. La guarda no mira atrás: un lote sin fecha que ya exista seguiría ahí. Por eso
-- la migración FALLA si encuentra alguno (modo de fallo ruidoso; alternativa descartada: avisar
-- con NOTICE y seguir, que en un despliegue nadie lee). Medido antes de escribirla:
--   · base local con el escenario del recorrido (E1–E3 y las empresas de los E2E): 0 lotes.
--   · producción: NO mirada desde aquí (R6). Antes de desplegar, correr:
--
--       select c.legal_name, p.name as producto, l.code as lote, l.created_at
--         from public.lots l
--         join public.products p on p.id = l.product_id
--         join public.companies c on c.id = l.company_id
--        where p.tracks_expiry and l.expires_at is null
--        order by c.legal_name, p.name, l.code;
--
--     Si devuelve filas: ponerle a cada lote su fecha (`lots` admite UPDATE; no es append-only)
--     con el dueño del dato, y volver a aplicar. No hay fecha «por omisión» que inventar.
--
-- DESPLIEGUE. JUSTO DESPUÉS del `git pull`, en la misma ventana que 20261005130000 y 130100 y
-- antes de arrancar la API nueva. No antes: la API saliente (71c73ab) crea el lote sin exigir la
-- fecha y no conoce LAD73; con la guarda puesta respondería 500 a una llegada sin fecha.
--
-- LO QUE LA MIGRACIÓN ANTERIOR (20261005130100) NO ENSEÑA, Y HAY QUE COMPROBAR EN EL ENSAYO EN
-- SECO. Esa migración parchea `platform.apply_inventory_move()` —el trigger que costea el kardex—
-- leyendo su definición VIVA del catálogo (`pg_get_functiondef`) y sustituyendo una sola
-- expresión (`l.expires_at < new.occurred_at::date` → día de Caracas). Su fichero NO contiene el
-- cuerpo que deja: `release:manifest` sella el fichero, no la función resultante. En el ensayo en
-- seco de producción, ANTES y DESPUÉS de aplicarla:
--
--       select md5(pg_get_functiondef('platform.apply_inventory_move()'::regprocedure)),
--              pg_get_functiondef('platform.apply_inventory_move()'::regprocedure);
--
--   · ANTES: el cuerpo tiene que ser el de 20261003140000 (la última migración que la escribe
--     entera) y contener EXACTAMENTE UNA vez `l.expires_at < new.occurred_at::date`;
--   · DESPUÉS: la única diferencia entre los dos textos es esa expresión; siguen iguales
--     `SECURITY DEFINER`, `SET search_path TO ''`, el propietario y los permisos
--     (`\df+ platform.apply_inventory_move`);
--   · y con las tres aplicadas, por empresa: `select * from platform.composite_sale_gaps(id)` en
--     cero filas, y la consulta de lotes sin fecha de arriba en cero filas.
--   Si la expresión no está tal cual, la 130100 falla sola (no deja la función a medias).
-- =============================================================================

-- ── 0. Ningún lote sin fecha de un producto que vence, o no se aplica ───────
do $comprobar$
declare
  v_n integer;
begin
  select count(*) into v_n
    from public.lots l
    join public.products p on p.id = l.product_id
   where p.tracks_expiry and l.expires_at is null;
  if v_n > 0 then
    raise exception
      'hay % lote(s) sin fecha de vencimiento de productos que vencen: ponles su fecha antes de aplicar esta migración (la consulta está en su cabecera)', v_n;
  end if;
end
$comprobar$;

-- ── 1. El lote ──────────────────────────────────────────────────────────────
create function platform.assert_lot_has_expiry_date()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  p record;
begin
  if new.expires_at is not null then
    return new;
  end if;
  -- El producto de ESTA empresa. Si no es de ella, no se dice nada de él: lo rechaza la FK
  -- compuesta (company_id, product_id). FOR SHARE: quien esté encendiendo el vencimiento de este
  -- producto espera a que este lote se confirme, y entonces lo ve.
  select pr.name, pr.tracks_expiry into p
    from public.products pr
   where pr.id = new.product_id and pr.company_id = new.company_id
     for share;
  if found and p.tracks_expiry then
    raise exception
      'el lote «%» de «%» no tiene fecha de vencimiento: este producto lleva vencimiento y cada lote suyo nace con su fecha',
      new.code, p.name
      using errcode = 'LAD73',
            hint = 'C-07: un lote sin fecha no vence nunca y el reparto por vencimiento lo deja para el final';
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_lot_has_expiry_date() from public;
comment on function platform.assert_lot_has_expiry_date() is
  'C-07: un lote de un producto con tracks_expiry lleva fecha de vencimiento (LAD73). La segunda '
  'capa de la regla que el dominio dice con el nombre del producto (resolverLote).';

create trigger lots_10_expiry_date
  before insert or update of expires_at, product_id on public.lots
  for each row execute function platform.assert_lot_has_expiry_date();

-- ── 2. El producto ──────────────────────────────────────────────────────────
create function platform.assert_expiry_needs_dated_lots()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_n integer;
begin
  if new.tracks_expiry and not old.tracks_expiry then
    select count(*) into v_n
      from public.lots l
     where l.product_id = new.id and l.expires_at is null;
    if v_n > 0 then
      raise exception
        'el producto «%» tiene % lote(s) sin fecha de vencimiento: ponles su fecha antes de encender el vencimiento',
        new.name, v_n
        using errcode = 'LAD73';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_expiry_needs_dated_lots() from public;
comment on function platform.assert_expiry_needs_dated_lots() is
  'C-07: encender tracks_expiry no deja lotes sin fecha (LAD73). products_tracking_frozen congela '
  'la bandera con movimientos; esto cubre el lote que existe sin movimiento.';

create trigger products_expiry_needs_dated_lots
  before update of tracks_expiry on public.products
  for each row execute function platform.assert_expiry_needs_dated_lots();
