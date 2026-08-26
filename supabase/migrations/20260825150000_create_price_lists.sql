-- =============================================================================
-- Ladino — migración 17 · Listas de precios (ADR-0032, rigor máximo: dinero)
--
-- Módulo: pricing   Spec: docs/03_MODULES/PRICING_MULTICURRENCY_SPEC.md · ADR-0032
-- Reversible: SÍ mientras esté vacía; con datos, expand/contract.
-- Homologación: NO (importes de lista; ningún impuesto, ningún redondeo fiscal)
--
-- Tres invariantes, los tres ESTRUCTURALES (ADR-0032):
--   1. SOLAPAMIENTO IMPOSIBLE: EXCLUDE por rango con btree_gist. No es una
--      consulta que casi siempre acierta: es un constraint.
--   2. APPEND-ONLY REAL: corregir un precio es una fila nueva. El único camino
--      de mutación es el que abre un INSERT (autocierre del período anterior);
--      el guardián LAD35 permite exactamente UNA transición (effective_to de
--      NULL a valor, resto intacto) y mata todo lo demás. La API ni siquiera
--      tiene UPDATE/DELETE por GRANT.
--   3. LA FECHA ES PARÁMETRO: price_at(list, product, fecha). Nunca now() —
--      un documento de ayer se recalcula con el precio de ayer. La variante
--      con now() vive solo como negativo en pgTAP 017.
-- =============================================================================

create extension if not exists btree_gist with schema extensions;

-- Anclas compuestas que la 16 no necesitó y los FKs de items sí: garantizan
-- que lista y producto referenciados son de LA MISMA company.
alter table public.products
  add constraint products_company_id_key unique (company_id, id);

create table public.price_lists (
  id            uuid        primary key default platform.uuidv7(),
  tenant_id     uuid        not null,
  company_id    uuid        not null,
  name          text        not null,
  -- La moneda es de la LISTA: los ítems no la repiten (una sola fuente).
  currency_code text        not null,
  status        text        not null default 'active',
  created_by    uuid,
  created_at    timestamptz not null,
  version       integer     not null,
  constraint price_lists_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint price_lists_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint price_lists_currency_fk
    foreign key (currency_code) references public.currencies (code),
  constraint price_lists_name_chk
    check (name = btrim(name) and length(name) between 1 and 100),
  constraint price_lists_status_chk check (status in ('active', 'inactive')),
  constraint price_lists_company_name_key unique (company_id, name),
  constraint price_lists_company_id_key   unique (company_id, id)
);
comment on table public.price_lists is
  'Listas de precios por company (PRICING_MULTICURRENCY_SPEC, ADR-0032). La '
  'moneda vive aquí, de la tabla currencies: añadir moneda es una fila, no '
  'una migración (D-5).';

create table public.price_list_items (
  id             uuid          primary key default platform.uuidv7(),
  tenant_id      uuid          not null,
  company_id     uuid          not null,
  price_list_id  uuid          not null,
  product_id     uuid          not null,
  -- El importe, como se cargó: numeric(24,8), sin redondeo de almacenamiento
  -- (regla 7). El redondeo fiscal es del documento (RoundingPolicy), no de la
  -- lista. >= 0: un precio gratis es legítimo; uno negativo es otra cosa.
  amount         numeric(24,8) not null,
  effective_from timestamptz   not null,
  effective_to   timestamptz,
  created_by     uuid,
  created_at     timestamptz   not null,
  version        integer       not null,
  constraint price_list_items_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint price_list_items_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  -- Compuestos por company: una lista no puede apuntar a un producto ajeno.
  constraint price_list_items_list_fk
    foreign key (company_id, price_list_id) references public.price_lists (company_id, id),
  constraint price_list_items_product_fk
    foreign key (company_id, product_id) references public.products (company_id, id),
  constraint price_list_items_amount_chk check (amount >= 0),
  constraint price_list_items_period_chk
    check (effective_to is null or effective_to > effective_from),
  -- Cinturón de determinismo (el EXCLUDE es la defensa principal).
  constraint price_list_items_start_key unique (price_list_id, product_id, effective_from),
  -- ADR-0032 §1: dos vigencias que se tocan NO PUEDEN coexistir. '[)': el fin
  -- de un período y el inicio del siguiente coinciden sin solaparse.
  constraint price_list_items_no_overlap
    exclude using gist (
      price_list_id with =,
      product_id with =,
      tstzrange(effective_from, coalesce(effective_to, 'infinity'), '[)') with &&
    )
);
comment on table public.price_list_items is
  'Precios por vigencia, append-only estructural (ADR-0032): corregir es fila '
  'nueva; el autocierre del período abierto lo dispara el INSERT; el guardián '
  'LAD35 permite solo la transición effective_to NULL→valor. El vigente se '
  'resuelve con platform.price_at(list, product, FECHA) — nunca now().';

create index price_list_items_tenant_company_idx on public.price_list_items (tenant_id, company_id);
create index price_list_items_lookup_idx
  on public.price_list_items (price_list_id, product_id, effective_from desc);
create index price_lists_tenant_company_idx on public.price_lists (tenant_id, company_id);

-- ── Procedencia y anclas ─────────────────────────────────────────────────────
create trigger price_lists_provenance
  before insert or update on public.price_lists
  for each row execute function platform.set_row_provenance();
create trigger price_lists_anchors_immutable
  before update on public.price_lists
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger price_list_items_provenance
  before insert or update on public.price_list_items
  for each row execute function platform.set_row_provenance();
create trigger price_list_items_anchors_immutable
  before update on public.price_list_items
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── El guardián: LAD35 (reservado en ERROR_CATALOG.md) ──────────────────────
-- Permite EXACTAMENTE una transición: cerrar un período abierto sin tocar
-- nada más. Todo lo demás —amount, effective_from, reabrir, DELETE— muere.
-- Es la segunda capa: la API no tiene UPDATE/DELETE ni por GRANT.
create function platform.assert_price_append_only()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'un precio no se borra: la vigencia se cierra (ADR-0032)'
      using errcode = 'LAD35';
  end if;
  if old.effective_to is null
     and new.effective_to is not null
     and new.amount         = old.amount
     and new.effective_from = old.effective_from
     and new.price_list_id  = old.price_list_id
     and new.product_id     = old.product_id then
    return new; -- la única mutación sancionada: completar la historia, no reescribirla
  end if;
  raise exception
    'un precio no se edita: corregir es una fila nueva con su vigencia (ADR-0032)'
    using errcode = 'LAD35', hint = 'usa un INSERT con effective_from nuevo, o platform.close_price()';
end;
$$;
revoke execute on function platform.assert_price_append_only() from public;

create trigger price_list_items_append_only
  before update or delete on public.price_list_items
  for each row execute function platform.assert_price_append_only();

-- ── Autocierre: el INSERT del precio nuevo cierra el abierto anterior ───────
create function platform.close_open_price()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.price_list_items
     set effective_to = new.effective_from
   where price_list_id = new.price_list_id
     and product_id    = new.product_id
     and effective_to is null
     and effective_from < new.effective_from;
  return new;
end;
$$;
revoke execute on function platform.close_open_price() from public;

create trigger price_list_items_autoclose
  before insert on public.price_list_items
  for each row execute function platform.close_open_price();

-- ── Retiro sin sustituto: la mutación sancionada, con permiso propio ────────
create function platform.close_price(p_item uuid, p_hasta timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.price_list_items
     set effective_to = p_hasta
   where id = p_item and effective_to is null;
  if not found then
    raise exception 'el precio no existe o su vigencia ya está cerrada'
      using errcode = 'LAD35';
  end if;
end;
$$;
comment on function platform.close_price(uuid, timestamptz) is
  'Retira un precio SIN sustituto: cierra la vigencia abierta (ADR-0032). '
  'SECURITY DEFINER porque la API no tiene UPDATE por GRANT; la autorización '
  '(price_list.manage) la exige el caso de uso, como siempre.';
revoke execute on function platform.close_price(uuid, timestamptz) from public;
grant execute on function platform.close_price(uuid, timestamptz) to ladino_api;

-- ── El vigente, contra FECHA PARÁMETRO ──────────────────────────────────────
-- STABLE e INVOKER: responde bajo la RLS de quien pregunta. El EXCLUDE
-- garantiza como mucho UNA fila cubriendo la fecha.
create function platform.price_at(p_list uuid, p_product uuid, p_fecha timestamptz)
returns numeric
language sql
stable
set search_path = ''
as $$
  select i.amount
    from public.price_list_items i
   where i.price_list_id = p_list
     and i.product_id    = p_product
     and i.effective_from <= p_fecha
     and (i.effective_to is null or i.effective_to > p_fecha)
$$;
comment on function platform.price_at(uuid, uuid, timestamptz) is
  'El precio vigente A LA FECHA DADA — la fecha es parámetro, nunca now(): '
  'now() es hora de inicio de transacción, y un documento de ayer se '
  'recalcula con el precio de ayer (ADR-0032; el negativo con now() vive en '
  'pgTAP 017). NULL si ninguna vigencia cubre la fecha.';
revoke execute on function platform.price_at(uuid, uuid, timestamptz) from public;
grant execute on function platform.price_at(uuid, uuid, timestamptz) to authenticated, ladino_api;

-- Los casos de uso COMPANY-SCOPED (productos, precios) consultan la función
-- canónica de permisos con el actor explícito — el mismo motivo por el que el
-- JOIN de create-company advierte que no puede usarla: aquel era tenant-level.
-- Aquí sí se usa, y una sola copia de la resolución RBAC (ADR-0027 §3-bis).
grant execute on function platform.ladino_user_has_permission(uuid, text, uuid) to ladino_api;
grant execute on function platform.ladino_user_company_ids(uuid) to ladino_api;

-- ── RLS y grants ────────────────────────────────────────────────────────────
alter table public.price_lists      enable row level security;
alter table public.price_lists      force row level security;
alter table public.price_list_items enable row level security;
alter table public.price_list_items force row level security;

create policy price_lists_select on public.price_lists for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy price_lists_insert on public.price_lists for insert to authenticated
  with check (false);
create policy price_lists_update on public.price_lists for update to authenticated
  using (false);
create policy price_lists_delete on public.price_lists
  for delete to authenticated, ladino_api using (false);
create policy price_lists_api_select on public.price_lists for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy price_lists_api_insert on public.price_lists for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy price_lists_api_update on public.price_lists for update to ladino_api
  using      (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

create policy price_list_items_select on public.price_list_items for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy price_list_items_insert on public.price_list_items for insert to authenticated
  with check (false);
create policy price_list_items_update on public.price_list_items
  for update to authenticated, ladino_api using (false);
create policy price_list_items_delete on public.price_list_items
  for delete to authenticated, ladino_api using (false);
create policy price_list_items_api_select on public.price_list_items for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy price_list_items_api_insert on public.price_list_items for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));

revoke all on public.price_lists, public.price_list_items
  from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.price_lists, public.price_list_items to authenticated;
grant select, insert, update on public.price_lists to ladino_api;
-- items: INSERT y SELECT. Ni UPDATE ni DELETE: el cierre va por close_price().
grant select, insert on public.price_list_items to ladino_api;
