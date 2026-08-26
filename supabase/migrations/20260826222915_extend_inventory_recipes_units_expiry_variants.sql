-- =============================================================================
-- Ladino — migración 20 · Inventario, segunda vuelta: recetas, unidades
--                          fraccionadas, vencimientos/FEFO, variantes y umbrales
--
-- Módulo: inventory   Spec: ADR-0034 (base) · ADR-0035 (recetas y unidades) ·
--                           ADR-0036 (variantes como productos derivados)
-- Reversible: SÍ mientras las tablas nuevas estén vacías y no haya movimientos
--             con source_document_id. Con datos, expand/contract.
-- Homologación: NO (costeo interno y clasificación; ningún documento fiscal)
--
-- EXTIENDE la 19; no la edita (una migración aplicada no se toca). Las funciones
-- que cambian de comportamiento se reemplazan con CREATE OR REPLACE, que es como
-- la 11 corrigió las de S0.3.
--
-- LAS CINCO, y la decisión que lleva cada una:
--
-- 1. RECETAS. `products.is_composed` + `product_recipes`. Un compuesto NO TIENE
--    EXISTENCIAS PROPIAS: vender un plato descuenta sus ingredientes, no el plato.
--    Eso no se puede expresar con un CHECK —necesita mirar `products`— así que
--    vive en el trigger de aplicación, junto a las demás reglas del movimiento
--    (LAD43). ANIDAMIENTO NO SOPORTADO EN ESTA ITERACIÓN, decidido y forzado: un
--    ingrediente no puede ser a su vez compuesto (LAD44). La razón no es pereza:
--    explotar recetas anidadas exige recursión CON detección de ciclos y tope de
--    profundidad, y el costeo pasa de «suma de hijos» a una explosión recursiva —
--    otra bestia, con rigor máximo, que no se cuela de contrabando en una
--    extensión. El coste hoy: una salsa base usada en tres platos se repite como
--    líneas en las tres recetas. Levantarlo después NO migra datos: se quita el
--    CHECK del trigger y la explosión pasa a ser un CTE recursivo; las recetas ya
--    escritas siguen siendo válidas.
--
-- 2. UNIDADES FRACCIONADAS. `unit_conversions` DIRIGIDA (from → to), sin derivar
--    la inversa. Derivarla parece gratis y no lo es: 1/3 no cabe en numeric(24,8),
--    y una conversión que se altera al persistirse deja de ser reproducible
--    (mismo argumento que ADR-0020 da para las tasas derivadas). Quien necesite
--    los dos sentidos carga las dos filas y asume que el viaje de ida y vuelta
--    puede no ser exacto salvo en potencias de 10. SIN conversión, el consumo se
--    RECHAZA (LAD45): el sistema no adivina cuántos gramos tiene un litro.
--    El movimiento se persiste SIEMPRE en la unidad del producto.
--
-- 3. VENCIMIENTOS Y FEFO. `products.tracks_expiry` (`lots.expires_at` ya existe
--    desde la 19). `expiring_lots()` para reportes y `suggest_lot_fefo()` para la
--    UI: FEFO es SUGERENCIA, no obligación — cuál lote sale es política del
--    cliente (un almacén puede despachar por ubicación física). Lo que SÍ es
--    obligación de servidor es que un lote YA VENCIDO no salga sin el permiso
--    `inventory.expired` (LAD46): eso no es preferencia operativa, es control.
--
-- 4. VARIANTES. `product_templates` + `products.template_id` + `attributes`.
--    Cada variante es un PRODUCTO con su SKU, su precio, su código de barras y su
--    costeo; el template solo agrupa. `stock_balances` no gana una dimensión.
--    Razones completas en ADR-0036.
--
-- 5. UMBRALES. `product_stock_thresholds` + `low_stock_products()`. Solo la
--    consulta; la notificación (correo, in-app) se difiere al worker.
-- =============================================================================

-- ── 1. Banderas nuevas de products ──────────────────────────────────────────
alter table public.products
  add column is_composed   boolean not null default false,
  add column tracks_expiry boolean not null default false,
  add column template_id   uuid,
  add column attributes    jsonb;

-- Un compuesto es un BIEN que no existe en el almacén: no lleva lotes, ni
-- seriales, ni se fabrica con BOM (su «BOM» es la receta).
alter table public.products
  add constraint products_composed_chk check (
    not is_composed
    or (kind = 'good' and not tracks_lots and not tracks_serials
        and not is_manufactured and not tracks_expiry));
alter table public.products
  add constraint products_expiry_goods_only_chk
    check (kind = 'good' or not tracks_expiry);
-- Vencimiento exige lotes: la fecha vive en el lote, no en el producto.
alter table public.products
  add constraint products_expiry_needs_lots_chk
    check (not tracks_expiry or tracks_lots);
-- `attributes` solo tiene sentido bajo un template, y es un objeto plano de
-- texto→texto: {talla: 'M', color: 'azul'}. Un jsonb libre aquí acabaría siendo
-- un cajón de sastre con estructuras distintas por empresa.
--
-- La forma se comprueba con una FUNCIÓN y no con la expresión directa porque un
-- CHECK no admite subconsulta (0A000) y recorrer un jsonb es una: `jsonb_each`
-- devuelve filas. Es el mismo recurso que la 7 usó para el hash de auditoría, y
-- es IMMUTABLE de verdad — depende solo de su argumento.
create or replace function platform.is_flat_string_object(p jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select jsonb_typeof(p) = 'object'
     and not exists (
       select 1 from pg_catalog.jsonb_each(p) a
        where jsonb_typeof(a.value) <> 'string'
           or pg_catalog.length(a.key) not between 1 and 40
           or pg_catalog.length(a.value #>> '{}') not between 1 and 60);
$$;
comment on function platform.is_flat_string_object(jsonb) is
  '¿Es un objeto jsonb PLANO de texto→texto, con claves y valores acotados? '
  'Existe porque un CHECK no puede llevar subconsulta y recorrer un jsonb lo es.';
revoke execute on function platform.is_flat_string_object(jsonb) from public;
-- Un CHECK evalúa su expresión con los privilegios de QUIEN INSERTA (la lección
-- de audit_payload_hash en S0.4): sin este GRANT la tabla quedaría escribible
-- por nadie, con todos los bits de privilegio de tabla en verde.
grant execute on function platform.is_flat_string_object(jsonb)
  to authenticated, ladino_api, service_role;

alter table public.products
  add constraint products_attributes_chk check (
    (template_id is null and attributes is null)
    or (template_id is not null
        and attributes is not null
        and platform.is_flat_string_object(attributes)));

comment on column public.products.is_composed is
  'Producto COMPUESTO (plato, combo): se vende pero no se almacena. Vender uno '
  'descuenta los ingredientes de su receta, nunca su propio stock (LAD43, '
  'ADR-0035). No admite lotes, seriales ni vencimiento: no tiene existencias.';
comment on column public.products.tracks_expiry is
  'Las existencias de este producto vencen: los lotes llevan expires_at y un '
  'lote vencido no sale sin inventory.expired (LAD46). Exige tracks_lots — la '
  'fecha es del lote, no del producto.';
comment on column public.products.template_id is
  'Plantilla de variantes (ADR-0036). NULL = producto autónomo, que es el caso '
  'de la bodega normal. Con template, este producto ES una variante concreta y '
  'attributes dice cuál.';
comment on column public.products.attributes is
  'Atributos de la variante: objeto PLANO texto→texto. Único por template '
  '(products_template_attributes_uidx): dos variantes no pueden ser la misma '
  'talla y color.';

-- ── 2. Plantillas de variantes (ADR-0036) ───────────────────────────────────
create table public.product_templates (
  id           uuid        primary key default platform.uuidv7(),
  tenant_id    uuid        not null,
  company_id   uuid        not null,
  name         text        not null,
  -- Los ejes de variación declarados: ['talla','color']. Es documentación
  -- ejecutable — la UI construye el formulario con esto y el trigger comprueba
  -- que ninguna variante invente un eje que el template no declara.
  attribute_keys text[]    not null default '{}',
  status       text        not null default 'active',
  created_by   uuid,
  created_at   timestamptz not null,
  version      integer     not null,
  constraint product_templates_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint product_templates_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint product_templates_name_chk
    check (name = btrim(name) and length(name) between 1 and 200),
  constraint product_templates_status_chk check (status in ('active', 'inactive')),
  constraint product_templates_keys_chk check (
    array_length(attribute_keys, 1) is null
    or (array_length(attribute_keys, 1) between 1 and 8
        and array_position(attribute_keys, null) is null)),
  constraint product_templates_company_name_key unique (company_id, name),
  constraint product_templates_company_id_key   unique (company_id, id)
);
comment on table public.product_templates is
  'Agrupa las variantes de un producto (ADR-0036). NO tiene existencias ni '
  'precio: cada variante es un producto con su SKU, su costo y su precio. El '
  'template es para buscar, agrupar el kardex y construir el formulario.';

-- FK compuesto por company: una variante no puede colgar de un template ajeno.
alter table public.products
  add constraint products_template_fk
    foreign key (company_id, template_id)
    references public.product_templates (company_id, id);

-- Dos variantes del mismo template no pueden tener los MISMOS atributos: sería
-- la misma talla y color dos veces, con dos SKU y dos existencias que nadie
-- sabría cuál usar.
create unique index products_template_attributes_uidx
  on public.products (template_id, attributes) where template_id is not null;
create index products_company_template_idx on public.products (company_id, template_id);

create function platform.assert_variant_attributes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_keys text[];
  v_falta text;
begin
  if new.template_id is null then return new; end if;
  select t.attribute_keys into v_keys
    from public.product_templates t where t.id = new.template_id;
  if v_keys is null or array_length(v_keys, 1) is null then return new; end if;

  -- Todo eje declarado tiene que estar, y ninguno de más: si el template dice
  -- talla y color, una variante «solo azul» es un dato incompleto que después
  -- nadie puede interpretar.
  select a.key into v_falta from jsonb_each(new.attributes) a
   where not (a.key = any (v_keys)) limit 1;
  if v_falta is not null then
    raise exception
      'la variante declara el atributo "%" que su plantilla no tiene entre %',
      v_falta, v_keys
      using errcode = 'LAD47';
  end if;
  select k into v_falta from unnest(v_keys) k
   where not (new.attributes ? k) limit 1;
  if v_falta is not null then
    raise exception 'la variante no declara el atributo "%", que su plantilla exige', v_falta
      using errcode = 'LAD47';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_variant_attributes() from public;
create trigger products_variant_attributes
  before insert or update of template_id, attributes on public.products
  for each row execute function platform.assert_variant_attributes();

create trigger product_templates_provenance
  before insert or update on public.product_templates
  for each row execute function platform.set_row_provenance();
create trigger product_templates_anchors_immutable
  before update on public.product_templates
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── 3. Conversión de unidades (ADR-0035) ────────────────────────────────────
create table public.unit_conversions (
  from_unit_code text          not null,
  to_unit_code   text          not null,
  -- Cuántas unidades de `to` hay en UNA de `from`. 1 kg = 1000 g → factor 1000.
  factor         numeric(24,8) not null,
  created_at     timestamptz   not null default now(),
  primary key (from_unit_code, to_unit_code),
  constraint unit_conversions_from_fk foreign key (from_unit_code) references public.units (code),
  constraint unit_conversions_to_fk   foreign key (to_unit_code)   references public.units (code),
  constraint unit_conversions_factor_chk check (factor > 0),
  constraint unit_conversions_distinct_chk check (from_unit_code <> to_unit_code)
);
comment on table public.unit_conversions is
  'Conversiones DIRIGIDAS entre unidades (ADR-0035). La inversa NO se deriva: '
  '1/3 no cabe en numeric(24,8) y una conversión que se altera al persistirse '
  'deja de ser reproducible — el mismo argumento que ADR-0020 da para las tasas '
  'derivadas. Quien quiera los dos sentidos carga las dos filas. Sin fila, el '
  'consumo se RECHAZA (LAD45): el sistema no adivina.';

create function platform.convert_quantity(
  p_quantity numeric, p_from text, p_to text
)
returns numeric
language sql
stable
set search_path = ''
as $$
  select case
           when p_from = p_to then p_quantity
           else (select round(p_quantity * c.factor, 8)
                   from public.unit_conversions c
                  where c.from_unit_code = p_from and c.to_unit_code = p_to)
         end;
$$;
comment on function platform.convert_quantity(numeric, text, text) is
  'Convierte una cantidad entre unidades. NULL si no hay conversión cargada — y '
  'quien llame DEBE tratar el NULL como rechazo, no como cero (ADR-0035). '
  'Redondea a 8 decimales, la escala de numeric(24,8).';
revoke execute on function platform.convert_quantity(numeric, text, text) from public;
grant execute on function platform.convert_quantity(numeric, text, text)
  to authenticated, ladino_api;

-- ── 4. Recetas (ADR-0035, rigor máximo: define el costo de lo que se vende) ──
create table public.product_recipes (
  id                uuid          primary key default platform.uuidv7(),
  tenant_id         uuid          not null,
  company_id        uuid          not null,
  parent_product_id uuid          not null,
  child_product_id  uuid          not null,
  -- Cantidad del ingrediente por UNA unidad del compuesto, en `unit_code`.
  quantity          numeric(24,8) not null,
  unit_code         text          not null,
  created_by        uuid,
  created_at        timestamptz   not null,
  version           integer       not null,
  constraint product_recipes_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint product_recipes_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint product_recipes_parent_fk
    foreign key (company_id, parent_product_id) references public.products (company_id, id),
  constraint product_recipes_child_fk
    foreign key (company_id, child_product_id) references public.products (company_id, id),
  constraint product_recipes_unit_fk foreign key (unit_code) references public.units (code),
  constraint product_recipes_quantity_chk check (quantity > 0),
  -- Un producto no se contiene a sí mismo. Es el ciclo de longitud 1; los más
  -- largos son imposibles porque el anidamiento no existe (LAD44).
  constraint product_recipes_no_self_chk check (parent_product_id <> child_product_id),
  constraint product_recipes_line_key unique (parent_product_id, child_product_id)
);
comment on table public.product_recipes is
  'Líneas de receta: cuánto de cada ingrediente lleva UNA unidad del compuesto. '
  'La cantidad se expresa en cualquier unidad y se convierte a la del producto '
  'hijo al consumir (unit_conversions). ANIDAMIENTO NO SOPORTADO: el hijo no '
  'puede ser compuesto (LAD44, ADR-0035 §Anidamiento).';

create index product_recipes_tenant_company_idx on public.product_recipes (tenant_id, company_id);
create index product_recipes_parent_idx on public.product_recipes (parent_product_id);
create index product_recipes_child_idx on public.product_recipes (child_product_id);

create trigger product_recipes_provenance
  before insert or update on public.product_recipes
  for each row execute function platform.set_row_provenance();
create trigger product_recipes_anchors_immutable
  before update on public.product_recipes
  for each row execute function platform.assert_isolation_anchors_immutable();

-- El invariante de la receta: padre compuesto, hijo NO compuesto y almacenable.
create function platform.assert_recipe_shape()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  padre record;
  hijo  record;
begin
  select p.is_composed, p.kind into padre
    from public.products p where p.id = new.parent_product_id;
  if not coalesce(padre.is_composed, false) then
    raise exception
      'solo un producto compuesto (is_composed) tiene receta: marca el producto como compuesto primero'
      using errcode = 'LAD44';
  end if;

  select p.is_composed, p.kind, p.status into hijo
    from public.products p where p.id = new.child_product_id;
  if coalesce(hijo.is_composed, false) then
    raise exception
      'un ingrediente no puede ser a su vez un producto compuesto: las recetas anidadas no están soportadas todavía (ADR-0035). Escribe sus ingredientes directamente en esta receta.'
      using errcode = 'LAD44',
            hint = 'levantar esto exige explosión recursiva con detección de ciclos y tope de profundidad';
  end if;
  if hijo.kind <> 'good' then
    raise exception 'un servicio no se consume como ingrediente: no tiene existencias'
      using errcode = 'LAD44';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_recipe_shape() from public;
create trigger product_recipes_shape
  before insert or update on public.product_recipes
  for each row execute function platform.assert_recipe_shape();

-- Y el flanco que se escapa si no se piensa: marcar compuesto un producto que YA
-- es ingrediente de otro, o desmarcar uno que ya tiene receta. Los dos rompen el
-- invariante sin tocar product_recipes.
create function platform.assert_composed_flag_coherent()
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
  if old.is_composed and not new.is_composed
     and exists (select 1 from public.product_recipes r where r.parent_product_id = new.id) then
    raise exception 'este producto tiene receta: borra sus líneas antes de dejar de ser compuesto'
      using errcode = 'LAD44';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_composed_flag_coherent() from public;
create trigger products_composed_coherent
  before update of is_composed on public.products
  for each row execute function platform.assert_composed_flag_coherent();

-- El costo de un compuesto A LA FECHA: suma de (cantidad convertida × costo
-- unitario vigente del ingrediente en ese almacén). Es una ESTIMACIÓN para
-- mostrar en pantalla; el costo REAL de una venta es la suma de lo que costaron
-- las salidas de verdad, que es lo que persiste el kardex.
create function platform.recipe_cost(
  p_company uuid, p_warehouse uuid, p_product uuid
)
returns numeric
language sql
stable
set search_path = ''
as $$
  with lineas as (
    select platform.convert_quantity(r.quantity, r.unit_code, hijo.unit_code) as cantidad,
           coalesce(b.last_unit_cost, 0) as costo
      from public.product_recipes r
      join public.products hijo on hijo.id = r.child_product_id
      left join public.stock_balances b
        on b.company_id = r.company_id and b.warehouse_id = p_warehouse
       and b.product_id = r.child_product_id and b.lot_id is null
     where r.company_id = p_company and r.parent_product_id = p_product
  )
  -- El CASE no es defensivo, es la corrección de un defecto real: `sum()` IGNORA
  -- los NULL, así que una línea sin conversión desaparecía de la suma y la
  -- función devolvía un costo A MEDIAS —exactamente lo que su comentario decía
  -- impedir— con toda la pinta de ser el costo bueno. Lo encontró el pgTAP 020.
  select case
           when count(*) = 0 then null
           when count(*) filter (where cantidad is null) > 0 then null
           else sum(round(cantidad * costo, 8))
         end
    from lineas;
$$;
comment on function platform.recipe_cost(uuid, uuid, uuid) is
  'Costo ESTIMADO de una unidad del compuesto con los costos vigentes. NULL si '
  'alguna línea no tiene conversión de unidad (convert_quantity devuelve NULL y '
  'la suma se propaga): un costo a medias sería peor que ninguno. El costo REAL '
  'de una venta es la suma de las salidas que persistió el kardex.';
revoke execute on function platform.recipe_cost(uuid, uuid, uuid) from public;
grant execute on function platform.recipe_cost(uuid, uuid, uuid) to authenticated, ladino_api;

-- ── 5. El documento de origen: liga los movimientos de un mismo hecho ────────
alter table public.inventory_moves add column source_document_id uuid;
comment on column public.inventory_moves.source_document_id is
  'Liga los movimientos generados por UN hecho de negocio: las N salidas de '
  'ingredientes de la venta de un compuesto, y mañana las líneas de una factura. '
  'Sin FK: el documento vive en un módulo que todavía no existe, y una FK a una '
  'tabla futura no se puede declarar hoy. Lo que sí se puede es indexarlo.';
create index inventory_moves_source_document_idx
  on public.inventory_moves (company_id, source_document_id)
  where source_document_id is not null;

-- Y LA CLAVE NATURAL SE ENSANCHA. La 19 la hizo (company, kind, reference), que
-- daba por supuesto UN movimiento por referencia y tipo. Vender un compuesto
-- rompe ese supuesto: la venta de doce arepas es UNA referencia con N salidas,
-- una por ingrediente. Lo destapó el pgTAP 020 al intentarlo.
--
-- La clave pasa a incluir el producto y el lote, que es lo que de verdad
-- identifica una LÍNEA dentro de un documento. La garantía de idempotencia no se
-- pierde: reprocesar la misma recepción del mismo producto sigue siendo un
-- duplicado (23505); lo que ahora se permite es que un documento tenga varias
-- líneas, que es lo que un documento es.
drop index public.inventory_moves_company_kind_reference_uidx;
create unique index inventory_moves_company_kind_reference_uidx
  on public.inventory_moves (
    company_id, kind, reference, product_id,
    coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where reference is not null;

-- ── 6. Umbrales de reposición ───────────────────────────────────────────────
create table public.product_stock_thresholds (
  id           uuid          primary key default platform.uuidv7(),
  tenant_id    uuid          not null,
  company_id   uuid          not null,
  warehouse_id uuid          not null,
  product_id   uuid          not null,
  stock_min    numeric(24,8) not null,
  stock_max    numeric(24,8),
  created_by   uuid,
  created_at   timestamptz   not null,
  version      integer       not null,
  constraint product_stock_thresholds_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint product_stock_thresholds_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint product_stock_thresholds_warehouse_fk
    foreign key (company_id, warehouse_id) references public.warehouses (company_id, id),
  constraint product_stock_thresholds_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint product_stock_thresholds_min_chk check (stock_min >= 0),
  constraint product_stock_thresholds_max_chk check (stock_max is null or stock_max > stock_min),
  constraint product_stock_thresholds_key unique (warehouse_id, product_id)
);
comment on table public.product_stock_thresholds is
  'Mínimo y máximo por (almacén, producto). Solo alimenta la CONSULTA '
  'low_stock_products(); la notificación (correo, in-app) es del worker y se '
  'difiere — un umbral sin a quién avisar sigue siendo útil en un reporte.';

create index product_stock_thresholds_tenant_company_idx
  on public.product_stock_thresholds (tenant_id, company_id);
create trigger product_stock_thresholds_provenance
  before insert or update on public.product_stock_thresholds
  for each row execute function platform.set_row_provenance();
create trigger product_stock_thresholds_anchors_immutable
  before update on public.product_stock_thresholds
  for each row execute function platform.assert_isolation_anchors_immutable();

create function platform.low_stock_products(
  p_company uuid, p_warehouse uuid default null
)
returns table (
  warehouse_id uuid, product_id uuid, quantity numeric,
  stock_min numeric, stock_max numeric, missing numeric
)
language sql
stable
set search_path = ''
as $$
  select t.warehouse_id, t.product_id, coalesce(b.quantity, 0),
         t.stock_min, t.stock_max,
         t.stock_min - coalesce(b.quantity, 0)
    from public.product_stock_thresholds t
    left join public.stock_balances b
      on b.warehouse_id = t.warehouse_id and b.product_id = t.product_id and b.lot_id is null
   where t.company_id = p_company
     and (p_warehouse is null or t.warehouse_id = p_warehouse)
     and coalesce(b.quantity, 0) < t.stock_min
   order by (t.stock_min - coalesce(b.quantity, 0)) desc;
$$;
comment on function platform.low_stock_products(uuid, uuid) is
  'Posiciones por debajo del mínimo, con cuánto falta. Un producto CON umbral y '
  'SIN existencias sale con cantidad 0: es justo el que hay que reponer, y un '
  'INNER JOIN lo habría escondido.';
revoke execute on function platform.low_stock_products(uuid, uuid) from public;
grant execute on function platform.low_stock_products(uuid, uuid) to authenticated, ladino_api;

-- ── 7. Vencimientos: consulta, sugerencia FEFO y el control real ────────────
-- La FECHA es parámetro con default, no `now()` empotrado: un reporte de hoy no
-- necesita pensarlo, y una pregunta histórica («qué vencía el 1 de julio») se
-- responde sin reescribir la función (la regla de price_at y stock_at).
create function platform.expiring_lots(
  p_company uuid, p_days integer, p_reference date default current_date
)
returns table (
  lot_id uuid, lot_code text, product_id uuid, warehouse_id uuid,
  expires_at date, days_left integer, quantity numeric
)
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
comment on function platform.expiring_lots(uuid, integer, date) is
  'Lotes CON EXISTENCIA que vencen dentro de p_days desde p_reference. Incluye '
  'los ya vencidos (days_left negativo): son los que más urgen. Sin existencia '
  'no aparecen — un lote agotado que vence mañana no es un problema.';
revoke execute on function platform.expiring_lots(uuid, integer, date) from public;
grant execute on function platform.expiring_lots(uuid, integer, date) to authenticated, ladino_api;

-- FEFO como SUGERENCIA: devuelve el lote con existencia que vence primero.
create function platform.suggest_lot_fefo(
  p_company uuid, p_warehouse uuid, p_product uuid, p_reference date default current_date
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
comment on function platform.suggest_lot_fefo(uuid, uuid, uuid, date) is
  'FEFO: el lote NO VENCIDO con existencia que caduca primero. Es SUGERENCIA '
  'para la UI, no obligación — cuál lote sale puede depender de la ubicación '
  'física, y forzarlo en el servidor sería imponer una política de cliente '
  '(ADR-0035). Lo que el servidor SÍ impone es que un lote vencido no salga sin '
  'inventory.expired (LAD46).';
revoke execute on function platform.suggest_lot_fefo(uuid, uuid, uuid, date) from public;
grant execute on function platform.suggest_lot_fefo(uuid, uuid, uuid, date)
  to authenticated, ladino_api;

-- ── 8. El kardex agrupado por template, desglosado por variante (ADR-0036) ───
create function platform.stock_by_template(p_company uuid, p_warehouse uuid default null)
returns table (
  template_id uuid, template_name text, product_id uuid, sku text,
  attributes jsonb, warehouse_id uuid, quantity numeric, value numeric,
  template_quantity numeric
)
language sql
stable
set search_path = ''
as $$
  select t.id, t.name, p.id, p.sku, p.attributes, b.warehouse_id,
         coalesce(b.quantity, 0), coalesce(b.value, 0),
         sum(coalesce(b.quantity, 0)) over (partition by t.id)
    from public.product_templates t
    join public.products p on p.template_id = t.id
    left join public.stock_balances b
      on b.product_id = p.id and (p_warehouse is null or b.warehouse_id = p_warehouse)
   where t.company_id = p_company
   order by t.name, p.sku;
$$;
comment on function platform.stock_by_template(uuid, uuid) is
  'Existencias por variante CON el total del template al lado (ventana), que es '
  'lo que pide una pantalla de ropa: «camisa azul: 12» y debajo M=5, L=7. Ni el '
  'agrupado ni el desglose se calculan en el cliente.';
revoke execute on function platform.stock_by_template(uuid, uuid) from public;
grant execute on function platform.stock_by_template(uuid, uuid) to authenticated, ladino_api;

-- ── 9. El trigger de aplicación, extendido (CREATE OR REPLACE) ──────────────
-- Tres reglas nuevas sobre la versión de la 19, en el mismo sitio que las demás
-- porque son la misma clase de comprobación (miran `products` y `lots`, cosa que
-- un CHECK no puede hacer):
--   · LAD43 — un COMPUESTO no tiene existencias propias: ningún movimiento
--     directo, en ninguna dirección. Es la regla que hace que vender un plato
--     descuente ingredientes y no el plato;
--   · LAD46 — un lote VENCIDO no sale sin `inventory.expired` sobre ese almacén.
--     Entrar sí puede (una devolución, una regularización): el control es sobre
--     la salida, que es lo que llega al cliente;
--   · el vencimiento se compara contra `occurred_at`, no contra `now()`: un
--     movimiento fechado en junio se juzga con lo que estaba vencido en junio.
create or replace function platform.apply_inventory_move()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_functional text;
  v_tenant     uuid;
  p            record;
  w_status     text;
  l            record;
  b            public.stock_balances;
  v_q          numeric;
  v_cost       numeric;
  v_qty_after  numeric;
  v_val_after  numeric;
  v_unit       numeric;
  v_meaningful boolean;
  v_allow      boolean;
  v_actor      uuid;
  v_tol        constant numeric := 0.000000005;
begin
  select c.tenant_id, c.functional_currency_code into v_tenant, v_functional
    from public.companies c where c.id = new.company_id;
  if v_tenant is null then
    raise exception 'la company del movimiento no existe' using errcode = '23503';
  end if;
  if new.functional_currency <> v_functional then
    raise exception
      'la moneda funcional del movimiento (%) no es la de la empresa (%): el costeo se lleva en moneda funcional (ADR-0020)',
      new.functional_currency, v_functional
      using errcode = 'LAD38';
  end if;

  select pr.kind, pr.status, pr.tracks_lots, pr.tracks_serials, pr.is_composed, pr.tracks_expiry
    into p
    from public.products pr where pr.id = new.product_id and pr.company_id = new.company_id;
  if p.kind is null then
    raise exception 'el producto no pertenece a esta empresa' using errcode = '23503';
  end if;
  if p.kind <> 'good' then
    raise exception 'un servicio no tiene existencias' using errcode = 'LAD38';
  end if;
  -- NUEVO (LAD43): el compuesto no se mueve. Se venden sus ingredientes.
  if p.is_composed then
    raise exception
      'un producto compuesto no tiene existencias propias: vender uno descuenta los ingredientes de su receta, no el plato (ADR-0035)'
      using errcode = 'LAD43',
            hint = 'usa el caso de uso de consumo de receta, que genera una salida por ingrediente';
  end if;
  if p.status <> 'active' then
    raise exception 'el producto no está activo (%): actívalo antes de mover existencias', p.status
      using errcode = 'LAD38';
  end if;
  if p.tracks_serials then
    raise exception
      'el producto declara seriales y el rastreo de seriales no existe todavía: no puede moverse (ADR-0034, diferido con razón)'
      using errcode = 'LAD38';
  end if;
  if p.tracks_lots and new.lot_id is null then
    raise exception 'el producto se lleva por lotes: el movimiento exige lote' using errcode = 'LAD38';
  end if;
  if not p.tracks_lots and new.lot_id is not null then
    raise exception 'el producto no se lleva por lotes: el movimiento no admite lote' using errcode = 'LAD38';
  end if;
  if new.lot_id is not null then
    select lo.product_id, lo.status, lo.expires_at into l from public.lots lo
     where lo.id = new.lot_id and lo.company_id = new.company_id;
    if l.product_id is null then
      raise exception 'el lote no pertenece a esta empresa' using errcode = '23503';
    end if;
    if l.product_id <> new.product_id then
      raise exception 'el lote es de otro producto' using errcode = 'LAD38';
    end if;
    if l.status <> 'active' then
      raise exception 'el lote está inactivo' using errcode = 'LAD38';
    end if;
    -- NUEVO (LAD46): vencido + SALIDA + sin permiso = no sale. Contra
    -- occurred_at, no contra now(): el pasado se juzga con lo de entonces.
    if p.tracks_expiry and new.quantity < 0
       and l.expires_at is not null and l.expires_at < new.occurred_at::date then
      v_actor := coalesce(auth.uid(), platform.ladino_service_actor_id());
      if v_actor is null
         or not platform.ladino_user_has_scope(v_actor, 'inventory.expired', 'warehouse', new.warehouse_id) then
        raise exception
          'el lote % venció el % y despachar existencia vencida exige el permiso inventory.expired sobre este almacén',
          new.lot_id, l.expires_at
          using errcode = 'LAD46';
      end if;
    end if;
  end if;

  select wh.status into w_status from public.warehouses wh
   where wh.id = new.warehouse_id and wh.company_id = new.company_id;
  if w_status is null then
    raise exception 'el almacén no pertenece a esta empresa' using errcode = '23503';
  end if;
  if w_status <> 'active' then
    raise exception 'el almacén está inactivo' using errcode = 'LAD38';
  end if;

  b := platform.stock_position_lock(v_tenant, new.company_id, new.warehouse_id, new.product_id, new.lot_id, v_functional);
  if b.currency_code <> v_functional then
    raise exception
      'la posición está valorada en % y la empresa lleva %: regulariza antes de mover', b.currency_code, v_functional
      using errcode = 'LAD38';
  end if;

  v_q         := abs(new.quantity);
  v_qty_after := b.quantity + new.quantity;
  v_val_after := b.value + new.functional_amount;

  if v_qty_after < 0 then
    v_allow := coalesce((select s.allow_negative_stock from public.inventory_settings s
                          where s.company_id = new.company_id), false);
    if not v_allow then
      raise exception
        'la existencia quedaría en % y la empresa no permite existencia negativa (inventory_settings.allow_negative_stock)',
        v_qty_after
        using errcode = 'LAD39';
    end if;
    v_actor := coalesce(auth.uid(), platform.ladino_service_actor_id());
    if v_actor is null
       or not platform.ladino_user_has_scope(v_actor, 'inventory.negative', 'warehouse', new.warehouse_id) then
      raise exception
        'la empresa permite existencia negativa pero el actor no tiene inventory.negative sobre este almacén'
        using errcode = 'LAD39';
    end if;
  end if;

  if new.quantity < 0 then
    v_cost       := -new.functional_amount;
    v_meaningful := b.quantity > 0 and b.value >= 0;
    if not v_meaningful then
      if abs(v_cost - v_q * b.last_unit_cost) > v_tol then
        raise exception
          'costeo: sin promedio significativo la salida vale q × último costo (% × % = %), llegó %',
          v_q, b.last_unit_cost, v_q * b.last_unit_cost, v_cost
          using errcode = 'LAD41';
      end if;
    elsif v_q = b.quantity then
      if v_cost <> b.value then
        raise exception 'costeo: vaciar la posición saca TODO el valor (%), llegó %', b.value, v_cost
          using errcode = 'LAD41';
      end if;
    elsif v_q < b.quantity then
      if abs(v_cost * b.quantity - b.value * v_q) > v_tol * b.quantity then
        raise exception
          'costeo: la salida no es el redondeo a 8 decimales de valor × q / existencia (% × % / %), llegó %',
          b.value, v_q, b.quantity, v_cost
          using errcode = 'LAD41';
      end if;
    else
      if abs((v_cost - b.value) * b.quantity - b.value * (v_q - b.quantity)) > v_tol * b.quantity then
        raise exception
          'costeo: al pasar a negativo la salida vale todo el valor (%) más el exceso al promedio, llegó %',
          b.value, v_cost
          using errcode = 'LAD41';
      end if;
    end if;
  end if;

  if v_qty_after > 0 and v_val_after >= 0 then
    v_unit := round(v_val_after / v_qty_after, 8);
    if new.unit_cost is not null
       and abs(new.unit_cost * v_qty_after - v_val_after) > v_tol * v_qty_after then
      raise exception
        'costeo: el costo unitario resultante no es valor/cantidad a 8 decimales (% / %), llegó %',
        v_val_after, v_qty_after, new.unit_cost
        using errcode = 'LAD41';
    end if;
  else
    v_unit := b.last_unit_cost;
    if new.unit_cost is not null and new.unit_cost <> v_unit then
      raise exception
        'costeo: sin promedio significativo se arrastra el último costo unitario (%), llegó %',
        v_unit, new.unit_cost
        using errcode = 'LAD41';
    end if;
  end if;
  if new.quantity_after is not null and new.quantity_after <> v_qty_after then
    raise exception 'kardex: quantity_after declarado % ≠ calculado %', new.quantity_after, v_qty_after
      using errcode = 'LAD41';
  end if;
  if new.value_after is not null and new.value_after <> v_val_after then
    raise exception 'kardex: value_after declarado % ≠ calculado %', new.value_after, v_val_after
      using errcode = 'LAD41';
  end if;
  new.quantity_after := v_qty_after;
  new.value_after    := v_val_after;
  new.unit_cost      := coalesce(new.unit_cost, v_unit);

  update public.stock_balances
     set quantity       = v_qty_after,
         value          = v_val_after,
         last_unit_cost = new.unit_cost,
         last_move_id   = new.id,
         moves_count    = moves_count + 1,
         updated_at     = now()
   where id = b.id;
  return new;
end;
$$;

-- ── 10. RLS y grants de lo nuevo ────────────────────────────────────────────
alter table public.product_templates        enable row level security;
alter table public.product_templates        force  row level security;
alter table public.unit_conversions         enable row level security;
alter table public.unit_conversions         force  row level security;
alter table public.product_recipes          enable row level security;
alter table public.product_recipes          force  row level security;
alter table public.product_stock_thresholds enable row level security;
alter table public.product_stock_thresholds force  row level security;

-- unit_conversions es catálogo GLOBAL, como units: lectura para todos, escritura
-- denegada POR ESCRITO (se puebla por migración).
create policy unit_conversions_select on public.unit_conversions
  for select to authenticated, ladino_api using (true);
create policy unit_conversions_insert on public.unit_conversions
  for insert to authenticated, ladino_api with check (false);
create policy unit_conversions_update on public.unit_conversions
  for update to authenticated, ladino_api using (false);
create policy unit_conversions_delete on public.unit_conversions
  for delete to authenticated, ladino_api using (false);

create policy product_templates_select on public.product_templates for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy product_templates_insert on public.product_templates for insert to authenticated
  with check (false);
create policy product_templates_update on public.product_templates for update to authenticated
  using (false);
create policy product_templates_delete on public.product_templates
  for delete to authenticated, ladino_api using (false);
create policy product_templates_api_select on public.product_templates for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_templates_api_insert on public.product_templates for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_templates_api_update on public.product_templates for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy product_recipes_select on public.product_recipes for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy product_recipes_insert on public.product_recipes for insert to authenticated
  with check (false);
create policy product_recipes_update on public.product_recipes for update to authenticated
  using (false);
-- Una línea de receta SÍ se borra (una receta se corrige quitando ingredientes);
-- no es un hecho contable, es una definición.
create policy product_recipes_delete on public.product_recipes for delete to authenticated
  using (false);
create policy product_recipes_api_select on public.product_recipes for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_recipes_api_insert on public.product_recipes for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_recipes_api_update on public.product_recipes for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_recipes_api_delete on public.product_recipes for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy product_stock_thresholds_select on public.product_stock_thresholds
  for select to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy product_stock_thresholds_insert on public.product_stock_thresholds
  for insert to authenticated with check (false);
create policy product_stock_thresholds_update on public.product_stock_thresholds
  for update to authenticated using (false);
create policy product_stock_thresholds_delete on public.product_stock_thresholds
  for delete to authenticated using (false);
create policy product_stock_thresholds_api_select on public.product_stock_thresholds
  for select to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_stock_thresholds_api_insert on public.product_stock_thresholds
  for insert to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_stock_thresholds_api_update on public.product_stock_thresholds
  for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_stock_thresholds_api_delete on public.product_stock_thresholds
  for delete to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));

revoke all on public.product_templates, public.unit_conversions,
              public.product_recipes, public.product_stock_thresholds
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.unit_conversions to authenticated, ladino_api;
grant select on public.product_templates, public.product_recipes,
                public.product_stock_thresholds to authenticated;
grant select, insert, update on public.product_templates to ladino_api;
grant select, insert, update, delete on public.product_recipes to ladino_api;
grant select, insert, update, delete on public.product_stock_thresholds to ladino_api;

-- ── 11. Seeds ───────────────────────────────────────────────────────────────
-- Unidades que la 16 no tenía y una receta necesita. `unidad` y `servicio` ya
-- existen; `kg` y `litro` también.
insert into public.units (code, name, symbol) values
  ('gramo',      'Gramo',      'g'),
  ('mililitro',  'Mililitro',  'ml'),
  ('minuto',     'Minuto',     'min')
on conflict (code) do nothing;

-- Conversiones en LOS DOS SENTIDOS, explícitas. Son potencias de diez, así que
-- el viaje de ida y vuelta es exacto; para un factor como 1 docena = 12 unidades
-- no lo sería, y por eso la tabla no deriva inversas (ADR-0035).
insert into public.unit_conversions (from_unit_code, to_unit_code, factor) values
  ('kg',        'gramo',     1000),
  ('gramo',     'kg',        0.001),
  ('litro',     'mililitro', 1000),
  ('mililitro', 'litro',     0.001),
  ('hora',      'minuto',    60),
  ('minuto',    'hora',      0.01666667)
on conflict do nothing;

insert into public.permissions (key, description, is_scoped) values
  ('inventory.expired',    'Despachar existencia de un lote ya vencido',                     true),
  ('product.recipe.manage','Definir la receta de un producto compuesto (ingredientes)',      false),
  ('product.variant.manage','Crear plantillas de variantes y sus productos derivados',       false),
  ('inventory.threshold.manage','Definir mínimos y máximos de reposición por almacén',       false)
on conflict (key) do nothing;

-- ── 12. Lo que esta migración GARANTIZA sobre sí misma (LAD48) ───────────────
do $$
declare v_ida numeric; v_vuelta numeric;
begin
  if (select count(*) from public.permissions
       where key in ('inventory.expired', 'product.recipe.manage',
                     'product.variant.manage', 'inventory.threshold.manage')) <> 4 then
    raise exception 'LAD48: faltan permisos de la segunda vuelta de inventario';
  end if;
  -- Las conversiones sembradas van en pares y las de potencia de diez son
  -- EXACTAS en ida y vuelta. Se comprueba, no se supone: una inversa mal escrita
  -- convierte gramos en toneladas sin que nada chille.
  for v_ida, v_vuelta in
    select a.factor, b.factor from public.unit_conversions a
      join public.unit_conversions b
        on b.from_unit_code = a.to_unit_code and b.to_unit_code = a.from_unit_code
     where a.from_unit_code in ('kg', 'litro')
  loop
    if round(v_ida * v_vuelta, 8) <> 1 then
      raise exception 'LAD48: una conversión de potencia de diez no es exacta en ida y vuelta (% × % ≠ 1)',
        v_ida, v_vuelta;
    end if;
  end loop;
  if (select platform.convert_quantity(2.5, 'kg', 'gramo')) <> 2500 then
    raise exception 'LAD48: convert_quantity no convierte 2,5 kg en 2500 g';
  end if;
  if (select platform.convert_quantity(1, 'kg', 'litro')) is not null then
    raise exception 'LAD48: convert_quantity inventó una conversión que no existe';
  end if;
  if (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('product_templates', 'unit_conversions', 'product_recipes',
                           'product_stock_thresholds')
         and c.relrowsecurity and c.relforcerowsecurity) <> 4 then
    raise exception 'LAD48: alguna tabla nueva no tiene RLS habilitada y forzada';
  end if;
end $$;
