-- =============================================================================
-- Ladino — la cuenta vendida muere en el servidor, y cada cuenta tiene dueño
--
-- Módulo: POS · ADR-0076 · RESPUESTA_RECORRIDO §2.9 · hallazgos M-01, M-02, M-03, E-08, O-02.
-- Reversible: SÍ, con datos vivos (ver el final). Homologación: NO (no toca documentos ni
-- impuestos: la cuenta es intención, no documento).
--
-- Qué pasaba (M-01): la venta BORRABA la fila de `pos_carts`, y una subida diferida que ya
-- estaba en vuelo la volvía a INSERTAR 403 ms después con lo ya vendido. El servidor no sabía
-- qué ids se habían vendido: el upsert aceptaba cualquiera. La cuenta resucitada, cobrada con
-- otra llave, era otra venta; con la misma llave (la llave era el id de la cuenta), el replay
-- de la venta vieja (M-02).
--
-- Qué cambia:
--   1. `sold_at` + `sale_id`: la venta MARCA la cuenta en vez de borrarla. Una cuenta vendida es
--      una lápida: no se edita ni se borra (trigger), el upsert no la toca (domino: 409
--      POS_CART_SOLD) y la purga del worker ya no la alcanza (solo purga las no vendidas).
--      `sale_id` es FK al documento: la cuenta vendida dice qué venta la cerró, y con su
--      `created_by` dice QUIÉN LA ARMÓ (O-02) — el vendedor de la venta es quien cobra.
--   2. `station_id`: la CAJA donde se armó (un uuid por equipo, que la web guarda en el disco).
--      Decidido por criterio: Ladino no tiene todavía cajas registradas en el POS
--      (`cash_registers` está vacía y sin API); un uuid por equipo es lo único que hoy distingue
--      «esta caja» de «otra caja» sin inventar un módulo. Alternativa: FK a `cash_registers`
--      cuando el POS las use.
--   3. El permiso `pos.carts.manage`: cobrar, cambiar o borrar una cuenta que armó OTRA persona.
--      Sembrado para dueño, administrativo y encargado (la respuesta del dueño). Decidido por
--      criterio: ni el cajero (es justo el caso que la regla separa) ni el contador ni el
--      almacén (no venden).
--   4. Las policies de `ladino_api` dejan de ser `using (true)`: el tenant del actor, como toda
--      tabla con `tenant_id` desde ADR-0031. Hasta hoy el aislamiento de esta tabla lo hacía
--      solo el `where company_id` del dominio.
--
-- La tabla tiene datos en producción (cuentas abiertas de días recientes). Nada se reescribe:
-- las tres columnas nacen NULL, el CHECK se cumple en todas las filas existentes (las dos NULL)
-- y la FK no tiene nada que validar.
-- =============================================================================

-- ── 1. La lápida: vendida, por qué venta, desde qué caja ─────────────────────
alter table public.pos_carts
  add column sold_at    timestamptz,
  add column sale_id    uuid,
  add column station_id uuid;

alter table public.pos_carts
  add constraint pos_carts_sold_pair_chk check ((sold_at is null) = (sale_id is null)),
  add constraint pos_carts_sale_fk
    foreign key (company_id, sale_id) references public.documents (company_id, id);

comment on column public.pos_carts.sold_at is
  'Cuándo se cobró (ADR-0076). Con valor, la fila es una LÁPIDA: no se edita ni se borra, el '
  'upsert responde POS_CART_SOLD y la purga no la toca. Es lo que impide que una subida en '
  'vuelo resucite una cuenta ya vendida (M-01).';
comment on column public.pos_carts.sale_id is
  'La venta que cerró la cuenta. Con created_by, dice quién la armó; el vendedor es quien cobró.';
comment on column public.pos_carts.station_id is
  'La caja (equipo) donde se armó: un uuid que la web guarda en el disco de ese equipo. '
  'Decidido por criterio mientras el POS no use cash_registers (ADR-0076, nota de aplicación).';

-- La purga del worker filtra por `sold_at is null`; la lista de la caja también.
create index pos_carts_open_idx on public.pos_carts (company_id, updated_at desc)
  where sold_at is null;

-- ── 2. Una cuenta vendida no se toca ─────────────────────────────────────────
-- plpgsql, un IF: se evalúa por fila solo en UPDATE/DELETE de esta tabla pequeña.
create or replace function platform.pos_cart_sold_is_final()
returns trigger
language plpgsql
set search_path to ''
as $$
begin
  if old.sold_at is not null then
    raise exception 'La cuenta % ya se cobró (venta %): no se modifica ni se borra.',
      old.id, old.sale_id
      using errcode = 'LAD06',
            hint = 'Una cuenta vendida es la constancia de quién la armó. Abre otra cuenta.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

create trigger pos_carts_02_sold_is_final
  before update or delete on public.pos_carts
  for each row execute function platform.pos_cart_sold_is_final();

-- ── 3. El permiso de las cuentas ajenas ──────────────────────────────────────
insert into public.permissions (key, description, is_scoped) values
  ('pos.carts.manage',
   'Cobrar, cambiar o borrar una cuenta abierta de la caja que armó otra persona', false)
on conflict (key) do nothing;

insert into public.role_permissions (role_id, permission_key, tenant_id)
select r.id, 'pos.carts.manage', null
  from public.roles r
 where r.tenant_id is null and r.key in ('owner', 'back_office', 'store_manager')
on conflict (role_id, permission_key) do nothing;

do $$
begin
  if (select count(*) from public.role_permissions rp
        join public.roles r on r.id = rp.role_id and r.tenant_id is null
       where rp.permission_key = 'pos.carts.manage'
         and r.key in ('owner', 'back_office', 'store_manager')) <> 3 then
    raise exception 'LAD37: pos.carts.manage no quedó en dueño, administrativo y encargado';
  end if;
end $$;

-- ── 4. Aislamiento de verdad para la API (ADR-0031) ──────────────────────────
drop policy if exists pos_carts_api_select on public.pos_carts;
drop policy if exists pos_carts_api_insert on public.pos_carts;
drop policy if exists pos_carts_api_update on public.pos_carts;
drop policy if exists pos_carts_api_delete on public.pos_carts;

create policy pos_carts_api_select on public.pos_carts
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy pos_carts_api_insert on public.pos_carts
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy pos_carts_api_update on public.pos_carts
  for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy pos_carts_api_delete on public.pos_carts
  for delete to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- =============================================================================
-- REVERSIÓN, con datos vivos (otra migración, nunca editando esta):
--   · las policies de §4 se vuelven a `using (true)` sin pérdida;
--   · el permiso: delete de role_permissions y permissions con esa clave (no hay datos que
--     dependan de él);
--   · el trigger y la función se quitan sin pérdida;
--   · las columnas: ANTES de quitarlas, las lápidas (sold_at not null) se BORRAN — son cuentas
--     ya cobradas, y sin la columna volverían a la caja como abiertas. Lo que se pierde es la
--     constancia de quién armó esas cuentas; la auditoría de la venta (`pos.cart.sold`) la
--     conserva. Revertir sin borrar las lápidas resucitaría todas las cuentas vendidas.
-- =============================================================================
