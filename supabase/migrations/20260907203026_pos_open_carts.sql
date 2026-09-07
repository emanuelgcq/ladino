-- =============================================================================
-- Ladino — migración 44: las CUENTAS ABIERTAS del punto de venta
--
-- Módulo: POS (orden del dueño, 2026-09-08). La cajera atiende a varios a la
-- vez y la luz se va: cada cuenta en armado se guarda en la nube (aquí) y en
-- el disco de la caja (navegador), y SOLO muere al cobrarse — quickSale la
-- borra en la MISMA transacción de la venta.
--
-- Qué es y qué NO es esta tabla:
--   · guarda la INTENCIÓN (productos y cantidades, cliente, nota) — nunca
--     precios: al retomar se recotiza a la tasa de HOY (ADR-0047);
--   · NO es un documento fiscal: sin numeración, sin stock, sin asientos —
--     mutable y borrable a propósito (por eso no lleva la familia
--     append-only); la reserva real de mercancía es el PEDIDO, no esto;
--   · el worker purga las abandonadas (>30 días sin tocar) — por eso su
--     grant de DELETE.
--
-- Reversibilidad: tabla nueva, sin datos previos; se revierte quitándola.
-- Impacto de homologación: NO (no toca documentos ni impuestos).
-- =============================================================================

create table public.pos_carts (
  -- El id lo pone la CAJA (uuid del cliente): así el upsert es idempotente
  -- por naturaleza y el eco local y la nube hablan del mismo carrito.
  id          uuid        primary key,
  tenant_id   uuid        not null,
  company_id  uuid        not null,
  /** La etiqueta de la ficha («Cuenta 2», o el nombre del cliente). */
  label       text        not null,
  customer_id uuid,
  /** La intención: [{product_id, qty}] — la valida el dominio; los precios
      NO viven aquí. */
  lines       jsonb       not null,
  note        text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid,

  created_by  uuid,
  created_at  timestamptz not null,
  version     integer     not null,

  constraint pos_carts_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint pos_carts_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint pos_carts_customer_fk
    foreign key (company_id, customer_id) references public.customers (company_id, id),
  constraint pos_carts_label_chk check (label = btrim(label) and length(label) between 1 and 80),
  constraint pos_carts_lines_chk check (jsonb_typeof(lines) = 'array'),
  constraint pos_carts_note_chk check (note is null or length(note) between 1 and 500),
  constraint pos_carts_company_id_key unique (company_id, id)
);

create index pos_carts_company_updated_idx on public.pos_carts (company_id, updated_at desc);

create trigger pos_carts_00_provenance
  before insert or update on public.pos_carts
  for each row execute function platform.set_row_provenance();
create trigger pos_carts_01_anchors
  before update on public.pos_carts
  for each row execute function platform.assert_isolation_anchors_immutable();

alter table public.pos_carts enable row level security;
alter table public.pos_carts force row level security;

revoke all on public.pos_carts from anon, authenticated, service_role;
grant select, insert, update, delete on public.pos_carts to ladino_api;
-- El worker SOLO borra (la purga de abandonadas): ni lee de más ni escribe.
grant select, delete on public.pos_carts to ladino_worker;

create policy pos_carts_api_select on public.pos_carts
  for select to ladino_api using (true);
create policy pos_carts_api_insert on public.pos_carts
  for insert to ladino_api with check (true);
create policy pos_carts_api_update on public.pos_carts
  for update to ladino_api using (true) with check (true);
create policy pos_carts_api_delete on public.pos_carts
  for delete to ladino_api using (true);
create policy pos_carts_worker_select on public.pos_carts
  for select to ladino_worker using (true);
create policy pos_carts_worker_delete on public.pos_carts
  for delete to ladino_worker using (true);
