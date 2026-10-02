-- =============================================================================
-- Ladino — la importación de productos es un TRABAJO (ADR-0074)
--
-- Módulo: catálogo · importación. Hallazgos C-01, C-04 y C-05 del recorrido 2026-09-24.
-- Spec: docs/03_MODULES/PRODUCT_CATALOG_SPEC.md §Importación.
--
-- Antes, la importación corría fila a fila DENTRO de la petición (~200 ms por fila con
-- existencia): por encima de ~150 filas pasaba de los 30 s de la API, la persona leía «No se pudo
-- leer el archivo» y el servidor seguía creando; al reintentar, duplicaba (C-04).
--
-- Ahora la petición SOLO crea una fila aquí, con las filas YA INTERPRETADAS (las mismas que vio
-- la vista previa, C-05), y el worker la procesa:
--
--   · llave natural: unique (company_id, file_hash, number_format). El mismo archivo con el mismo
--     formato devuelve el trabajo existente, no un segundo (C-04). El formato entra en la llave
--     porque el mismo archivo leído con otro formato es otra interpretación: si la persona se
--     equivocó de formato, puede volver a subirlo con el correcto;
--   · UNA fila del archivo por transacción, y en la MISMA transacción avanza `processed_rows` y
--     crece `report`: una fila o se hizo y consta, o no se hizo y no consta. El reintento sigue
--     desde la siguiente — ni duplica ni deja a medias;
--   · el trigger de guarda congela lo que define el trabajo (las filas, el hash, el formato) y
--     exige que el progreso solo AVANCE: `report` crece por la cola y nunca se reescribe.
--
-- EL WORKER Y LA API (decisión que enmienda ADR-0031 — ver PARÉ POR en el informe del reparador
-- y RISK_REGISTER): el trabajo lo procesa `apps/worker`, pero crear un producto toca una docena
-- de tablas de negocio (productos, precios, kardex, asientos, auditoría, outbox) que el worker no
-- puede ni nombrar. En vez de repartirle GRANT tabla por tabla, el worker puede ADOPTAR
-- `ladino_api` con `SET LOCAL ROLE` dentro de la transacción de cada fila, con el ACTOR del
-- trabajo (quien lo subió) en el GUC: la RLS y la autorización son exactamente las de la API
-- para esa persona. `WITH INHERIT FALSE`: sin el SET ROLE explícito, el worker sigue sin ver
-- nada de negocio (el test 014 lo sigue comprobando).
--
-- Reversibilidad: SÍ mientras no haya trabajos con valor de auditoría — tabla nueva sin datos
-- previos; se revierte con `drop table public.product_import_jobs` y
-- `revoke ladino_api from ladino_worker`. CON DATOS VIVOS: los productos que los trabajos ya
-- crearon NO se revierten con la tabla (son altas normales, con su kardex y su asiento); lo que
-- se pierde al borrarla es el INFORME de cada importación y los costos de referencia que solo
-- viven en él. Antes de revertir en producción, exportar `report` de los trabajos existentes.
-- Impacto de homologación: NO (no toca documentos fiscales, numeración ni impuestos).
-- =============================================================================

create table public.product_import_jobs (
  id              uuid        primary key default platform.uuidv7(),
  tenant_id       uuid        not null,
  company_id      uuid        not null,
  file_name       text        not null,
  /** sha256 del archivo subido, en hex: la llave del trabajo (C-04). */
  file_hash       text        not null,
  number_format   text        not null,
  status          text        not null default 'pending',
  /** Filas del archivo (sin las vacías), interpretadas. */
  row_count       integer     not null,
  processed_rows  integer     not null default 0,
  created_count   integer     not null default 0,
  updated_count   integer     not null default 0,
  rejected_count  integer     not null default 0,
  /** Las filas INTERPRETADAS (ProductImportRow[]): lo que la vista previa enseñó. */
  rows            jsonb       not null,
  /** El informe, una entrada por fila procesada, en orden (ProductImportJobRowResult[]). */
  report          jsonb       not null default '[]'::jsonb,
  attempts        integer     not null default 0,
  last_error      text,
  started_at      timestamptz,
  finished_at     timestamptz,

  created_by      uuid        not null,
  created_at      timestamptz not null,
  version         integer     not null,

  constraint product_import_jobs_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint product_import_jobs_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint product_import_jobs_key unique (company_id, file_hash, number_format),
  constraint product_import_jobs_company_id_key unique (company_id, id),
  constraint product_import_jobs_file_hash_chk check (file_hash ~ '^[0-9a-f]{64}$'),
  constraint product_import_jobs_file_name_chk check (length(file_name) between 1 and 255),
  constraint product_import_jobs_number_format_chk
    check (number_format in ('comma_decimal', 'dot_decimal')),
  constraint product_import_jobs_status_chk
    check (status in ('pending', 'running', 'done', 'failed')),
  constraint product_import_jobs_row_count_chk check (row_count between 1 and 500),
  constraint product_import_jobs_progress_chk check (processed_rows between 0 and row_count),
  constraint product_import_jobs_counts_chk check (
    created_count >= 0 and updated_count >= 0 and rejected_count >= 0
    and created_count + updated_count + rejected_count = processed_rows),
  constraint product_import_jobs_rows_chk
    check (jsonb_typeof(rows) = 'array' and jsonb_array_length(rows) = row_count),
  -- Detector de doble proceso: una fila procesada = una entrada del informe, ni más ni menos.
  -- Si dos procesos avanzaran la misma fila sin el FOR UPDATE, el contador y el informe se
  -- desalinearían y esto lo rechaza. No es higiene: quitarlo desarma esa defensa.
  constraint product_import_jobs_report_chk
    check (jsonb_typeof(report) = 'array' and jsonb_array_length(report) = processed_rows),
  constraint product_import_jobs_done_chk check (
    status <> 'done' or (processed_rows = row_count and finished_at is not null)),
  constraint product_import_jobs_attempts_chk check (attempts between 0 and 100),
  constraint product_import_jobs_last_error_chk
    check (last_error is null or length(last_error) between 1 and 2000)
);

comment on table public.product_import_jobs is
  'Trabajos de importación de productos (ADR-0074). La petición crea la fila con las filas '
  'interpretadas; el worker la procesa una fila por transacción. Llave: (company_id, file_hash, '
  'number_format).';

-- Lo que el worker busca: lo que queda por hacer, por antigüedad.
create index product_import_jobs_pending_idx on public.product_import_jobs (created_at)
  where status in ('pending', 'running');
create index product_import_jobs_company_created_idx
  on public.product_import_jobs (company_id, created_at desc);

-- ── La guarda: lo que define el trabajo no cambia; el progreso solo avanza ──
create or replace function platform.product_import_job_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_prev integer;
begin
  if old.status in ('done', 'failed') then
    raise exception 'el trabajo de importación % ya terminó (%): no se modifica', old.id, old.status
      using errcode = '55000';
  end if;
  if new.rows is distinct from old.rows
     or new.file_hash is distinct from old.file_hash
     or new.file_name is distinct from old.file_name
     or new.number_format is distinct from old.number_format
     or new.row_count is distinct from old.row_count then
    raise exception 'lo que define el trabajo de importación (filas, archivo, formato) no cambia'
      using errcode = '55000';
  end if;
  if new.processed_rows < old.processed_rows
     or new.created_count < old.created_count
     or new.updated_count < old.updated_count
     or new.rejected_count < old.rejected_count
     or new.attempts < old.attempts then
    raise exception 'el progreso del trabajo de importación solo avanza' using errcode = '55000';
  end if;
  -- El informe crece por la cola: sus primeras entradas son EXACTAMENTE las de antes.
  v_prev := jsonb_array_length(old.report);
  if v_prev > 0 and jsonb_path_query_array(
       new.report, ('$[0 to ' || (v_prev - 1) || ']')::jsonpath) is distinct from old.report then
    raise exception 'el informe del trabajo de importación no se reescribe, solo crece'
      using errcode = '55000';
  end if;
  return new;
end;
$$;

comment on function platform.product_import_job_guard() is
  'Guarda de product_import_jobs (ADR-0074): congela filas/archivo/formato, estados terminales '
  'inmutables, contadores monótonos e informe que solo crece por la cola.';

create trigger product_import_jobs_00_provenance
  before insert or update on public.product_import_jobs
  for each row execute function platform.set_row_provenance();
create trigger product_import_jobs_01_anchors
  before update on public.product_import_jobs
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger product_import_jobs_02_guard
  before update on public.product_import_jobs
  for each row execute function platform.product_import_job_guard();

-- ── RLS y privilegios ───────────────────────────────────────────────────────
alter table public.product_import_jobs enable row level security;
alter table public.product_import_jobs force row level security;

revoke all on public.product_import_jobs from anon, authenticated, service_role;
-- Nadie borra un trabajo: sin GRANT de DELETE para ningún rol, y la prohibición escrita abajo.
grant select, insert, update on public.product_import_jobs to ladino_api;
-- El worker LEE lo pendiente de todos los tenants (como el outbox) y solo puede tocar las
-- columnas de su contabilidad de fallos. El avance de filas lo hace como ladino_api.
grant select on public.product_import_jobs to ladino_worker;
grant update (status, attempts, last_error, finished_at)
  on public.product_import_jobs to ladino_worker;

create policy product_import_jobs_api_select on public.product_import_jobs
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_import_jobs_api_insert on public.product_import_jobs
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_import_jobs_api_update on public.product_import_jobs
  for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy product_import_jobs_api_no_delete on public.product_import_jobs
  for delete to ladino_api using (false);

create policy product_import_jobs_worker_select on public.product_import_jobs
  for select to ladino_worker using (true);
create policy product_import_jobs_worker_update on public.product_import_jobs
  for update to ladino_worker
  using (status in ('pending', 'running'))
  with check (status in ('pending', 'running', 'failed'));

-- ── El worker puede ADOPTAR ladino_api (y solo adoptarlo, sin heredar) ──────
grant ladino_api to ladino_worker with inherit false, set true;

do $$
begin
  if not exists (
    select 1 from pg_auth_members
     where roleid = 'ladino_api'::regrole and member = 'ladino_worker'::regrole
       and not inherit_option and set_option) then
    raise exception 'ladino_worker debe poder SET ROLE ladino_api sin heredar sus privilegios';
  end if;
end $$;
