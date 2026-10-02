-- =============================================================================
-- Ladino — la importación es un trabajo: los arreglos de la re-revisión (ADR-0074, A4 y A5)
--
-- Módulo: catálogo · importación. Spec: docs/03_MODULES/PRODUCTS_CATALOG_SPEC.md §Importación.
--
--   1. (A4) `products.reference_cost_currency` referencia `public.currencies (code)`: el CHECK de
--      20260928140200 exige tres mayúsculas, pero «XYZ» las tiene. La moneda de un costo es una
--      moneda del catálogo, como la de un precio.
--   2. (A5) `product_import_jobs.next_attempt_at`: un trabajo que falla por algo que no es su fila
--      (la base caída, un bug) no se reintenta en la vuelta siguiente, sino tras un backoff
--      exponencial con jitter (el de outbox.ts). El worker no toma un trabajo antes de esa hora.
--      NULL = se puede tomar ya. El worker solo puede escribir esa columna y las de su
--      contabilidad de fallos.
--
-- Despliegue: 140100, 140200 y esta van ANTES de levantar la API nueva — `PRODUCT_SELECT` lee
-- `reference_cost`. Son expand puro (columnas nullables, FK sobre una columna que la app saliente
-- no escribe) y se pueden aplicar antes del `git pull`.
--
-- Reversibilidad: SÍ, con datos vivos. El FK se revierte con `drop constraint` sin pérdida;
-- `next_attempt_at` con `drop column`, y lo que se pierde es solo la hora del próximo reintento
-- (el trabajo se reintentaría en la vuelta siguiente, como antes).
-- Impacto de homologación: NO.
-- =============================================================================

-- ── 1. La moneda del costo de referencia es del catálogo ────────────────────
do $$
begin
  if exists (
    select 1 from public.products p
     where p.reference_cost_currency is not null
       and not exists (select 1 from public.currencies c where c.code = p.reference_cost_currency)) then
    raise exception 'hay costos de referencia con una moneda fuera de public.currencies';
  end if;
end $$;

alter table public.products
  add constraint products_reference_cost_currency_fk
  foreign key (reference_cost_currency) references public.currencies (code);

comment on constraint products_reference_cost_currency_fk on public.products is
  'La moneda del costo de referencia (ADR-0074, A4) es una moneda del catálogo.';

-- ── 2. El backoff del trabajo ───────────────────────────────────────────────
alter table public.product_import_jobs add column next_attempt_at timestamptz;

comment on column public.product_import_jobs.next_attempt_at is
  'ADR-0074, A5: antes de esta hora el worker no toma el trabajo (backoff exponencial con jitter '
  'tras un fallo que no es de la fila). NULL: se puede tomar ya.';

grant update (next_attempt_at) on public.product_import_jobs to ladino_worker;

drop index if exists public.product_import_jobs_pending_idx;
create index product_import_jobs_pending_idx
  on public.product_import_jobs (created_at, next_attempt_at)
  where status in ('pending', 'running');
