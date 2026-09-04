-- =============================================================================
-- CONTINGENCIA: EL TALONARIO FÍSICO, MODELADO (PA 102; buena práctica en todas
-- las vías)
--
-- Cuando el sistema o la imprenta digital fallan, el negocio emite en un
-- talonario físico de contingencia — PA 102: serie con la palabra
-- «contingencia» impresa — y al volver el servicio REGISTRA a posteriori cada
-- factura emitida en papel, con su número, entrando a libros y contabilidad
-- como cualquier documento.
--
-- El modelo NO duplica la numeración: el talonario ES un rango
-- (`fiscal_number_ranges`, que ya sabe reservar números atómicamente y sin
-- huecos); esta tabla añade lo que el rango no sabe — que es DE CONTINGENCIA:
-- el motivo de la falla y su período. El caso de uso registra las facturas EN
-- EL ORDEN del papel y el claim reproduce los números impresos; si no
-- coinciden, la transacción entera se revierte con el mensaje que dice cuál
-- se esperaba.
--
-- Append-only en lo esencial: de un registro de contingencia solo se puede
-- CERRAR el período (failure_ended_at, una vez). Reescribir el motivo o el
-- período de una falla ya registrada sería reescribir por qué existieron esas
-- facturas.
-- =============================================================================

-- ── 0. La serie tiene que poder decir «contingencia» ────────────────────────
-- El CHECK de la migración 21 limitaba la serie a 10 caracteres — un límite
-- de prudencia, no de norma. La PA 102 exige que el talonario de contingencia
-- lleve LA PALABRA «contingencia» (12 letras) en la serie: la norma gana al
-- límite arbitrario. Se amplía a 30, conservando el resto del CHECK.
alter table public.fiscal_number_ranges
  drop constraint fiscal_number_ranges_series_chk;
alter table public.fiscal_number_ranges
  add constraint fiscal_number_ranges_series_chk
  check (series = btrim(series) and length(series) between 1 and 30);
-- Y el documento que se emite con esa serie tiene que poder llevarla igual.
alter table public.documents
  drop constraint documents_series_chk;
alter table public.documents
  add constraint documents_series_chk
  check (series = btrim(series) and length(series) between 1 and 30);

create table public.contingency_ranges (
  id                     uuid        primary key default platform.uuidv7(),
  tenant_id              uuid        not null,
  company_id             uuid        not null,
  -- El talonario: un rango normal, cuya serie DEBE empezar por «contingencia»
  -- (trigger abajo — un CHECK no puede mirar otra tabla).
  fiscal_number_range_id uuid        not null,
  -- Por qué se emitió en papel: la falla, contada para el fiscalizador.
  reason                 text        not null,
  failure_started_at     timestamptz not null,
  -- NULL mientras la falla siga abierta; se cierra UNA vez.
  failure_ended_at       timestamptz,
  created_by             uuid,
  created_at             timestamptz not null,
  version                integer     not null,
  constraint contingency_ranges_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint contingency_ranges_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint contingency_ranges_range_fk
    foreign key (fiscal_number_range_id) references public.fiscal_number_ranges (id),
  constraint contingency_ranges_range_key unique (fiscal_number_range_id),
  constraint contingency_ranges_reason_chk check (length(btrim(reason)) between 5 and 500),
  constraint contingency_ranges_period_chk
    check (failure_ended_at is null or failure_ended_at >= failure_started_at)
);
comment on table public.contingency_ranges is
  'Talonarios físicos de contingencia (PA 102): el rango que asigna los números '
  'vive en fiscal_number_ranges; aquí vive el POR QUÉ — motivo y período de la '
  'falla. registerContingencyInvoice registra a posteriori lo emitido en papel.';

create index contingency_ranges_company_idx
  on public.contingency_ranges (company_id, failure_started_at desc);

-- ── La serie del talonario dice «contingencia», por esquema ─────────────────
create function platform.assert_contingency_series()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_series text;
begin
  select series into v_series from public.fiscal_number_ranges
   where id = new.fiscal_number_range_id;
  if v_series is null or lower(v_series) not like 'contingencia%' then
    raise exception
      'LAD69: la serie de un talonario de contingencia debe empezar por «contingencia» (PA 102); la del rango es «%»',
      coalesce(v_series, '∅')
      using errcode = 'LAD69';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_contingency_series() from public;

create trigger contingency_ranges_00_series
  before insert or update on public.contingency_ranges
  for each row execute function platform.assert_contingency_series();

-- ── De un registro solo se cierra el período, una vez ───────────────────────
create function platform.assert_contingency_close_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.tenant_id, new.company_id, new.fiscal_number_range_id, new.reason,
      new.failure_started_at)
     is distinct from
     (old.tenant_id, old.company_id, old.fiscal_number_range_id, old.reason,
      old.failure_started_at)
  then
    raise exception
      'LAD06: de un registro de contingencia solo se cierra el período: el motivo y el rango de una falla registrada no se reescriben'
      using errcode = 'LAD06';
  end if;
  if old.failure_ended_at is not null
     and new.failure_ended_at is distinct from old.failure_ended_at then
    raise exception
      'LAD06: el período de la contingencia ya se cerró y no se reabre'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_contingency_close_only() from public;

create trigger contingency_ranges_01_close_only
  before update on public.contingency_ranges
  for each row execute function platform.assert_contingency_close_only();

create trigger contingency_ranges_02_no_delete
  before delete on public.contingency_ranges
  for each statement execute function platform.reject_mutation();

-- Procedencia y anclas: las mismas redes de toda tabla con tenant.
create trigger contingency_ranges_provenance
  before insert or update on public.contingency_ranges
  for each row execute function platform.set_row_provenance();
create trigger contingency_ranges_anchors
  before update on public.contingency_ranges
  for each row execute function platform.assert_isolation_anchors_immutable();

-- ── RLS: el molde de toda tabla company-scoped (la forma de la migración 29):
--    authenticated solo LEE lo suyo; escribe únicamente ladino_api, dentro de
--    sus tenants de servicio, y siempre a través del caso de uso ─────────────
alter table public.contingency_ranges enable row level security;
alter table public.contingency_ranges force row level security;

create policy contingency_ranges_select on public.contingency_ranges
  for select to authenticated
  using (company_id in (select platform.ladino_company_ids()));
create policy contingency_ranges_write on public.contingency_ranges
  for insert to authenticated with check (false);
create policy contingency_ranges_update on public.contingency_ranges
  for update to authenticated using (false);
create policy contingency_ranges_delete on public.contingency_ranges
  for delete to authenticated using (false);
create policy contingency_ranges_api_select on public.contingency_ranges
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy contingency_ranges_api_insert on public.contingency_ranges
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy contingency_ranges_api_update on public.contingency_ranges
  for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));

-- Sin GRANT no hay política que valga: la RLS filtra filas, pero el privilegio
-- de tabla es previo (la misma pareja grant+policy de expenses, migración 30).
grant select, insert, update on public.contingency_ranges to ladino_api;

-- ── Permiso propio: registrar contingencia es un acto fiscal ────────────────
insert into public.permissions (key, description, is_scoped) values
  ('fiscal.contingency.manage',
   'Registrar talonarios de contingencia y las facturas emitidas en ellos', false)
on conflict (key) do nothing;

-- ── LAD52: lo que esta migración garantiza sobre sí misma ───────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where c.relname = 'contingency_ranges' and t.tgname = 'contingency_ranges_00_series'
  ) then
    raise exception 'LAD52: sin el trigger de serie, un rango cualquiera se disfraza de contingencia';
  end if;
end $$;
