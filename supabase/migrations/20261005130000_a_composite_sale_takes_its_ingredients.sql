-- =============================================================================
-- Ladino — I-04 y C-07 del recorrido 2026-09-24 (ola 5)
--   La venta de un compuesto saca sus ingredientes, y deja escrito lo que sacó.
--
-- Módulo: inventory · sales   Spec: ADR-0035 (enmienda del 2026-10-04) · ADR-0060 · ADR-0061
-- Reversible: SÍ mientras `sale_line_components` esté vacía (drop de la tabla y de
--             `composite_sale_gaps`, y `create or replace` de las dos funciones de guarda con su
--             cuerpo anterior, que está en las migraciones 19 y 20). CON DATOS, NO: la tabla es el
--             único vínculo entre la línea vendida de un compuesto y las salidas de sus
--             ingredientes; sin ella la devolución parcial no sabe qué reingresar y a qué costo.
--             Los movimientos de kardex y los asientos que la venta produjo no se deshacen.
-- Homologación: NO (costeo interno y kardex; ningún documento fiscal cambia de contenido)
--
-- QUÉ PASABA. `products.is_composed` y `product_recipes` existen desde la migración 20, pero la
-- venta trataba al compuesto como «no inventariable» y no movía nada: un compuesto vendido salía
-- sin costo y sin descontar un solo ingrediente, en silencio. Ningún invariante lo miraba.
--
-- QUÉ HACE ESTA MIGRACIÓN.
--   1. `public.sale_line_components`: por cada salida de ingrediente que produce la línea vendida
--      de un compuesto, una fila (dirección `out`) con la receta de ESE momento; y por cada
--      reingreso de una devolución, otra (dirección `back`) que dice qué salida revierte. Es
--      append-only: la receta puede cambiar mañana y lo vendido sigue diciendo lo que sacó.
--   2. `platform.composite_sale_gaps(empresa)`: el invariante que cruza ventas con inventario.
--      Su respuesta útil es cero filas, sin lista de excepciones.
--   3. `platform.assert_composed_flag_coherent()` (create or replace sobre la definición viva, la
--      de la migración 20, que ninguna posterior tocó): un compuesto que YA SE VENDIÓ no deja de
--      serlo. Lo demás queda igual.
--   4. `platform.assert_product_tracking_frozen()` (create or replace sobre la de la migración 19,
--      que ninguna posterior tocó): la bandera de vencimiento se congela con movimientos igual que
--      la de lotes. Antes solo se miraban `tracks_lots` y `tracks_serials`, y el vencimiento se
--      podía apagar con lotes vivos (dejaba de aplicarse LAD46 sin que nadie lo decidiera).
--
-- DECISIONES (por criterio, RESPUESTA §2.16: lo más estrecho y lo reversible):
--   · un ingrediente no puede ser otro compuesto ni el propio producto: ya lo forzaba LAD44 y el
--     CHECK `product_recipes_no_self_chk`; no se toca. Alternativa descartada: un nivel de
--     anidamiento (exige explosión recursiva y detección de ciclos, ADR-0035).
--   · un producto con movimientos no se vuelve compuesto (ya era así, LAD44).
--   · un compuesto vendido no deja de serlo (NUEVO). Alternativa descartada: permitirlo si se
--     borra la receta; dejaría líneas vendidas con rastro de ingredientes sobre un producto que
--     ya no es compuesto, y el invariante tendría que perdonarlas.
--   · las banderas de lote y vencimiento no se cambian con movimientos (ya era así para el lote).
--     Alternativa descartada: mover la existencia a un lote «sin lote» al encender; inventa un
--     lote sin fecha que el reparto por vencimiento dejaría siempre para el final.
-- =============================================================================

-- ── 1. Lo que la venta de un compuesto sacó ─────────────────────────────────
create table public.sale_line_components (
  id                uuid          primary key default platform.uuidv7(),
  tenant_id         uuid          not null,
  company_id        uuid          not null,
  document_id       uuid          not null,
  document_line_id  uuid          not null,
  parent_product_id uuid          not null,
  child_product_id  uuid          not null,
  -- 'out': la salida del ingrediente al vender. 'back': su reingreso por una devolución.
  direction         text          not null,
  move_id           uuid          not null,
  return_id         uuid,
  reverses_move_id  uuid,
  -- En positivo los dos, en la unidad del ingrediente y en moneda funcional: lo que dice el
  -- movimiento de kardex, copiado para que el invariante pueda compararlos.
  quantity          numeric(24,8) not null,
  functional_amount numeric(24,8) not null,
  -- La receta DE ESE MOMENTO: cantidad por unidad del compuesto en la unidad de la línea de
  -- receta, y el factor a la unidad del ingrediente. Lo que salió = round(q × factor × vendido, 8).
  recipe_quantity   numeric(24,8) not null,
  unit_factor       numeric(24,8) not null,
  created_by        uuid,
  created_at        timestamptz   not null,
  version           integer       not null,
  constraint sale_line_components_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint sale_line_components_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint sale_line_components_document_fk
    foreign key (document_id) references public.documents (id),
  constraint sale_line_components_line_fk
    foreign key (document_line_id) references public.document_lines (id),
  constraint sale_line_components_parent_fk
    foreign key (company_id, parent_product_id) references public.products (company_id, id),
  constraint sale_line_components_child_fk
    foreign key (company_id, child_product_id) references public.products (company_id, id),
  constraint sale_line_components_move_fk
    foreign key (move_id) references public.inventory_moves (id),
  constraint sale_line_components_return_fk
    foreign key (return_id) references public.returns (id),
  constraint sale_line_components_reverses_fk
    foreign key (reverses_move_id) references public.inventory_moves (id),
  -- Un movimiento de kardex pertenece a UNA línea: es lo que separa el pan del compuesto del pan
  -- suelto de la misma venta.
  constraint sale_line_components_move_key unique (move_id),
  constraint sale_line_components_direction_chk check (direction in ('out', 'back')),
  constraint sale_line_components_back_chk check (
    (direction = 'out' and return_id is null and reverses_move_id is null)
    or (direction = 'back' and return_id is not null and reverses_move_id is not null)),
  constraint sale_line_components_quantity_chk check (quantity > 0),
  constraint sale_line_components_amount_chk check (functional_amount >= 0),
  constraint sale_line_components_recipe_chk check (recipe_quantity > 0 and unit_factor > 0),
  constraint sale_line_components_no_self_chk check (parent_product_id <> child_product_id)
);
comment on table public.sale_line_components is
  'Lo que la línea vendida de un producto COMPUESTO sacó del kardex (I-04, ADR-0035): una fila '
  'por salida de ingrediente (out), con la receta de ese momento, y una por reingreso de una '
  'devolución (back). Append-only: la receta cambia, lo vendido no. La mira '
  'platform.composite_sale_gaps().';

create index sale_line_components_tenant_company_idx
  on public.sale_line_components (tenant_id, company_id);
create index sale_line_components_line_idx
  on public.sale_line_components (document_line_id, direction);
create index sale_line_components_document_idx
  on public.sale_line_components (company_id, document_id);
create index sale_line_components_parent_idx
  on public.sale_line_components (parent_product_id);
create index sale_line_components_reverses_idx
  on public.sale_line_components (reverses_move_id) where reverses_move_id is not null;

-- La fila tiene que decir la verdad sobre lo que señala: su línea, su documento, su movimiento.
-- Las FK simples no lo garantizan (una fila podría juntar la línea de una empresa con el
-- movimiento de otra), así que lo comprueba este trigger, que lee con privilegios propios.
create function platform.sale_line_component_guard()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  l record;
  d record;
  m record;
  r record;
  v_compuesto boolean;
begin
  select dl.company_id, dl.document_id, dl.product_id into l
    from public.document_lines dl where dl.id = new.document_line_id;
  if not found or l.company_id <> new.company_id or l.document_id <> new.document_id
     or l.product_id is distinct from new.parent_product_id then
    raise exception 'el componente no corresponde a esa línea de venta' using errcode = '23514';
  end if;

  select doc.company_id, doc.kind into d from public.documents doc where doc.id = new.document_id;
  if not found or d.company_id <> new.company_id or d.kind not in ('invoice', 'receipt') then
    raise exception 'solo la línea de una factura o un recibo de esta empresa lleva componentes'
      using errcode = '23514';
  end if;

  select p.is_composed into v_compuesto from public.products p where p.id = new.parent_product_id;
  if not coalesce(v_compuesto, false) then
    raise exception 'solo la línea de un producto compuesto lleva componentes'
      using errcode = '23514';
  end if;

  select mv.company_id, mv.product_id, mv.kind, mv.quantity, mv.functional_amount,
         mv.source_document_id
    into m from public.inventory_moves mv where mv.id = new.move_id;
  if not found or m.company_id <> new.company_id or m.product_id <> new.child_product_id
     or abs(m.quantity) <> new.quantity or abs(m.functional_amount) <> new.functional_amount then
    raise exception 'el componente no coincide con su movimiento de kardex'
      using errcode = '23514';
  end if;

  if new.direction = 'out' then
    if m.kind <> 'salida' or m.source_document_id is distinct from new.document_id then
      raise exception 'la salida de un componente es una salida de ESA venta'
        using errcode = '23514';
    end if;
  else
    select rt.company_id, rt.source_document_id into r
      from public.returns rt where rt.id = new.return_id;
    if not found or r.company_id <> new.company_id
       or r.source_document_id <> new.document_id
       or m.kind <> 'entrada' or m.source_document_id is distinct from new.return_id then
      raise exception 'el reingreso de un componente es una entrada de una devolución de ESA venta'
        using errcode = '23514';
    end if;
    if not exists (
      select 1 from public.sale_line_components o
       where o.move_id = new.reverses_move_id and o.direction = 'out'
         and o.document_line_id = new.document_line_id
         and o.child_product_id = new.child_product_id) then
      raise exception 'el reingreso de un componente revierte una salida de la MISMA línea'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function platform.sale_line_component_guard() from public;

create trigger sale_line_components_00_provenance
  before insert or update on public.sale_line_components
  for each row execute function platform.set_row_provenance();
create trigger sale_line_components_01_anchors
  before update on public.sale_line_components
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger sale_line_components_02_guard
  before insert on public.sale_line_components
  for each row execute function platform.sale_line_component_guard();
create trigger sale_line_components_immutable
  before update or delete on public.sale_line_components
  for each row execute function platform.reject_mutation();
create trigger sale_line_components_no_truncate
  before truncate on public.sale_line_components
  for each statement execute function platform.reject_mutation();

alter table public.sale_line_components enable row level security;
alter table public.sale_line_components force row level security;

revoke all on public.sale_line_components from anon, authenticated, service_role;
grant select on public.sale_line_components to authenticated;
grant select, insert on public.sale_line_components to ladino_api;

-- Las prohibiciones van ESCRITAS (using false), no implícitas.
create policy sale_line_components_select on public.sale_line_components
  for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy sale_line_components_no_insert on public.sale_line_components
  for insert to authenticated with check (false);
create policy sale_line_components_no_update on public.sale_line_components
  for update to authenticated using (false) with check (false);
create policy sale_line_components_no_delete on public.sale_line_components
  for delete to authenticated using (false);

create policy sale_line_components_api_select on public.sale_line_components
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy sale_line_components_api_insert on public.sale_line_components
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy sale_line_components_api_no_update on public.sale_line_components
  for update to ladino_api using (false) with check (false);
create policy sale_line_components_api_no_delete on public.sale_line_components
  for delete to ladino_api using (false);

-- ── 2. El invariante: venta de compuesto ⇒ sus ingredientes salieron ─────────
create function platform.composite_sale_gaps(p_company uuid)
returns table (document_id uuid, document_line_id uuid, gap text)
language sql
stable
set search_path = ''
as $$
  -- (1) Una línea vendida de un compuesto sin ninguna salida de ingrediente: el caso que pasaba
  --     en silencio. Vale para toda la historia: un compuesto vendido no deja de serlo.
  select d.id, dl.id, 'sin_salidas'::text
    from public.documents d
    join public.document_lines dl on dl.document_id = d.id
    join public.products p on p.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'receipt')
     and d.status <> 'draft'
     and p.is_composed
     and not exists (select 1 from public.sale_line_components c
                      where c.document_line_id = dl.id and c.direction = 'out')
  union all
  -- (2) Lo que salió de un ingrediente no es la receta de ese momento por lo vendido.
  select c.document_id, c.document_line_id, 'fuera_de_proporcion'::text
    from public.sale_line_components c
    join public.document_lines dl on dl.id = c.document_line_id
   where c.company_id = p_company and c.direction = 'out'
   group by c.document_id, c.document_line_id, c.child_product_id, dl.quantity
  having sum(c.quantity) <> round(min(c.recipe_quantity) * min(c.unit_factor) * dl.quantity, 8)
      or min(c.recipe_quantity) <> max(c.recipe_quantity)
      or min(c.unit_factor) <> max(c.unit_factor)
  union all
  -- (3) La fila no dice lo que dice su movimiento de kardex.
  select c.document_id, c.document_line_id, 'movimiento_no_coincide'::text
    from public.sale_line_components c
    left join public.inventory_moves m on m.id = c.move_id
   where c.company_id = p_company
     and (m.id is null
          or m.product_id <> c.child_product_id
          or abs(m.quantity) <> c.quantity
          or abs(m.functional_amount) <> c.functional_amount
          or (c.direction = 'out'
              and (m.kind <> 'salida' or m.source_document_id is distinct from c.document_id))
          or (c.direction = 'back'
              and (m.kind <> 'entrada' or m.source_document_id is distinct from c.return_id)))
  union all
  -- (4) De una salida volvió más de lo que salió, en cantidad o en valor.
  select o.document_id, o.document_line_id, 'devuelto_de_mas'::text
    from public.sale_line_components o
   where o.company_id = p_company and o.direction = 'out'
     and exists (select 1 from public.sale_line_components b
                  where b.reverses_move_id = o.move_id and b.direction = 'back'
                  group by b.reverses_move_id
                 having sum(b.quantity) > o.quantity
                     or sum(b.functional_amount) > o.functional_amount)
  union all
  -- (5) Un compuesto con movimientos propios: no lleva existencia (LAD43 es su primera capa).
  select null::uuid, null::uuid, 'compuesto_con_existencia'::text
    from public.products p
   where p.company_id = p_company and p.is_composed
     and exists (select 1 from public.inventory_moves m where m.product_id = p.id)
$$;
comment on function platform.composite_sale_gaps(uuid) is
  'Invariante I-04: toda línea vendida de un producto compuesto sacó sus ingredientes del kardex, '
  'en la proporción de la receta de ese momento; cada fila coincide con su movimiento; de ninguna '
  'salida volvió más de lo que salió; y ningún compuesto tiene movimientos propios. Cero filas.';
revoke all on function platform.composite_sale_gaps(uuid) from public;
grant execute on function platform.composite_sale_gaps(uuid) to authenticated, ladino_api;

-- ── 3. Un compuesto que ya se vendió no deja de serlo ───────────────────────
-- Definición viva: la de la migración 20 (20260826222915); ninguna posterior la redefine.
create or replace function platform.assert_composed_flag_coherent()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.is_composed and not old.is_composed then
    if exists (select 1 from public.product_recipes r where r.child_product_id = new.id) then
      raise exception
        'este producto es INGREDIENTE de otra receta: no puede volverse compuesto (anidamiento no soportado, ADR-0035)'
        using errcode = 'LAD44';
    end if;
    if exists (select 1 from public.inventory_moves m where m.product_id = new.id) then
      raise exception
        'este producto tiene movimientos de existencias: un compuesto no tiene stock propio y su kardex dejaría de significar nada'
        using errcode = 'LAD44';
    end if;
  end if;
  if old.is_composed and not new.is_composed then
    -- NUEVO (I-04): lo vendido guarda el rastro de sus ingredientes; si el producto dejara de
    -- ser compuesto, ese rastro quedaría colgando de un producto que dice llevar existencia.
    if exists (select 1 from public.sale_line_components c where c.parent_product_id = new.id)
       or exists (select 1
                    from public.document_lines dl
                    join public.documents d on d.id = dl.document_id
                   where dl.product_id = new.id
                     and d.kind in ('invoice', 'receipt') and d.status <> 'draft') then
      raise exception
        'este producto compuesto ya se vendió: no deja de ser compuesto. Crea otro producto.'
        using errcode = 'LAD44';
    end if;
    if exists (select 1 from public.product_recipes r where r.parent_product_id = new.id) then
      raise exception 'este producto tiene receta: borra sus líneas antes de dejar de ser compuesto'
        using errcode = 'LAD44';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_composed_flag_coherent() from public;

-- ── 4. El vencimiento se congela con movimientos, igual que el lote ─────────
-- Definición viva: la de la migración 19 (20260826204908); ninguna posterior la redefine.
create or replace function platform.assert_product_tracking_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.tracks_lots is distinct from old.tracks_lots
      or new.tracks_serials is distinct from old.tracks_serials
      or new.tracks_expiry is distinct from old.tracks_expiry)
     and exists (select 1 from public.inventory_moves m where m.product_id = old.id) then
    raise exception
      'las banderas de rastreo (lotes/seriales) no se cambian con movimientos registrados: '
      'las existencias ya están llevadas de una forma. Crea otro producto.'
      using errcode = 'LAD38', hint = 'ADR-0034: la frontera lotes/seriales es de existencia';
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_product_tracking_frozen() from public;

drop trigger products_tracking_frozen on public.products;
create trigger products_tracking_frozen
  before update of tracks_lots, tracks_serials, tracks_expiry on public.products
  for each row execute function platform.assert_product_tracking_frozen();
