-- =============================================================================
-- Ladino — LOS PERÍODOS TIENEN HISTORIA (ADR-0069; recorrido 2026-09-24, K-01..K-06)
-- Módulo: contabilidad (períodos) · compras (factura tardía) · libros (compras)
-- Spec: docs/03_MODULES/JOURNAL_AND_CLOSING_SPEC.md
--
-- Reversible: SÍ con datos vivos, con una pérdida acotada y dicha (ver el pie).
-- Homologación: NO en esta migración: no cambia ningún libro ni la planilla (el paso
--   de K-04 que sí los cambia queda pendiente de coordinarse con 20260928120000).
--
-- Qué arregla:
--   K-01 · reabrir un período violaba `fiscal_periods_closed_chk` SIEMPRE.
--   K-02 · volver a cerrar un reabierto violaba `fiscal_periods_reopened_chk`: el
--          modelo guardaba la historia en columnas de la fila (un solo ciclo).
--          La historia pasa a `fiscal_period_events` (append-only) y los CHECK de la
--          fila exigen coherencia con el ESTADO, no con la historia.
--   K-03 · el período de cierre «13» (fechado 31-12, `kind = 'closing'`): solo
--          asientos de cierre y de ajuste del contador; diciembre puede estar cerrado.
--   K-05 · `companies.activity_start_date`; `period_for_date` no crea ni devuelve
--          períodos antes de esa fecha ni más allá del período en curso; un asiento
--          (también un borrador) no se crea en un período cerrado.
--   K-06 · `journal_entries.status = 'discarded'`: el borrador descartado.
--   K-04 · (suelo) `supplier_invoices/supplier_credit_notes.accounting_date` y
--          `platform.accounting_date_for`: la fecha en que se registraría un documento de
--          compra cuya fecha cae en un período cerrado o antes del inicio de actividades.
--
-- GRANULARIDAD (CLAUDE.md §3, «una fecha comparada contra un punto de reloj»):
-- TODA comparación de esta migración es `date` contra `date`. El día de hoy es el
-- día EN CARACAS: `(now() at time zone 'America/Caracas')::date`, nunca `now()::date`
-- (que es el día del huso de la sesión) ni `fecha::timestamptz` (medianoche).
-- =============================================================================

-- ── 1. K-05 · La fecha de inicio de actividades ─────────────────────────────
-- Primero sin default: «add column … default» rellenaría las filas vivas con HOY.
alter table public.companies add column activity_start_date date;
comment on column public.companies.activity_start_date is
  'Inicio de actividades (ADR-0069 §3). Límite inferior de las fechas contables: no hay '
  'período antes. Nullable: NULL = sin límite. Por omisión, el día del alta EN CARACAS.';
-- Backfill con datos vivos: el día del alta, en Caracas. No toca los períodos que
-- ya existen antes de esa fecha (el agosto de E2 del recorrido): esos quedan, pero
-- period_for_date ya no admite fechas nuevas ahí.
update public.companies
   set activity_start_date = (created_at at time zone 'America/Caracas')::date;
alter table public.companies
  alter column activity_start_date set default ((now() at time zone 'America/Caracas')::date);

-- ── 2. K-01 + K-02 · La historia de cada período, en su tabla ───────────────
create table public.fiscal_period_events (
  id           uuid        primary key default platform.uuidv7(),
  tenant_id    uuid        not null,
  company_id   uuid        not null,
  period_id    uuid        not null,
  event_type   text        not null,
  -- OBLIGATORIO al reabrir: «¿por qué se reabrió febrero?» tiene que tener respuesta.
  reason       text,
  actor_id     uuid        not null,
  occurred_at  timestamptz not null,

  created_by   uuid,
  created_at   timestamptz not null,
  version      integer     not null,

  constraint fiscal_period_events_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint fiscal_period_events_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint fiscal_period_events_period_fk
    foreign key (company_id, period_id) references public.fiscal_periods (company_id, id),
  constraint fiscal_period_events_type_chk check (event_type in ('closed', 'reopened')),
  constraint fiscal_period_events_reason_chk check (
    event_type <> 'reopened' or length(btrim(coalesce(reason, ''))) >= 10),
  constraint fiscal_period_events_company_id_key unique (company_id, id)
);
create index fiscal_period_events_period_idx
  on public.fiscal_period_events (company_id, period_id, occurred_at);
comment on table public.fiscal_period_events is
  'Historia de cada período contable: cada cierre y cada reapertura, con motivo, autor e '
  'instante (ADR-0069 §1). Append-only. La fila de fiscal_periods solo guarda el estado actual.';

create trigger fiscal_period_events_provenance
  before insert or update on public.fiscal_period_events
  for each row execute function platform.set_row_provenance();
-- El ancla aunque la tabla sea append-only: lo pide la propiedad del test 006, sin
-- excepciones (CLAUDE.md §3, «la primera excepción documentada…»).
create trigger fiscal_period_events_anchors
  before update on public.fiscal_period_events
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger fiscal_period_events_append_only
  before update or delete on public.fiscal_period_events
  for each row execute function platform.reject_mutation();
create trigger fiscal_period_events_no_truncate
  before truncate on public.fiscal_period_events
  for each statement execute function platform.reject_mutation();

alter table public.fiscal_period_events enable row level security;
alter table public.fiscal_period_events force  row level security;
create policy fiscal_period_events_select on public.fiscal_period_events for select
  to authenticated using (company_id in (select platform.ladino_company_ids()));
create policy fiscal_period_events_insert on public.fiscal_period_events for insert
  to authenticated with check (false);
create policy fiscal_period_events_update on public.fiscal_period_events for update
  to authenticated using (false);
create policy fiscal_period_events_delete on public.fiscal_period_events for delete
  to authenticated using (false);
create policy fiscal_period_events_api_select on public.fiscal_period_events for select
  to ladino_api using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy fiscal_period_events_api_insert on public.fiscal_period_events for insert
  to ladino_api with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy fiscal_period_events_api_update on public.fiscal_period_events for update
  to ladino_api using (false);
create policy fiscal_period_events_api_delete on public.fiscal_period_events for delete
  to ladino_api using (false);
revoke all on public.fiscal_period_events from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.fiscal_period_events to authenticated;
grant select, insert on public.fiscal_period_events to ladino_api;

-- Los datos existentes: cada período cerrado recibe su `closed`, cada reabierto su
-- `reopened` (ADR-0069 §Consecuencias). Con los CHECK viejos, un reabierto no puede
-- tener `closed_at`, así que su cierre previo no se conoce y no se inventa.
insert into public.fiscal_period_events
  (tenant_id, company_id, period_id, event_type, reason, actor_id, occurred_at)
select tenant_id, company_id, id, 'closed', null, closed_by, closed_at
  from public.fiscal_periods
 where status = 'closed' and closed_at is not null and closed_by is not null;
insert into public.fiscal_period_events
  (tenant_id, company_id, period_id, event_type, reason, actor_id, occurred_at)
select tenant_id, company_id, id, 'reopened', reopened_reason, reopened_by, reopened_at
  from public.fiscal_periods
 where status = 'reopened' and reopened_at is not null and reopened_by is not null;

-- La fila guarda el ESTADO y los últimos datos; sus CHECK exigen coherencia con el
-- estado, no con la historia. Un período reabierto conserva su último cierre, y uno
-- vuelto a cerrar conserva su última reapertura (con su motivo): n ciclos.
alter table public.fiscal_periods drop constraint fiscal_periods_closed_chk;
alter table public.fiscal_periods add constraint fiscal_periods_closed_chk
  check (status <> 'closed' or (closed_at is not null and closed_by is not null));
alter table public.fiscal_periods drop constraint fiscal_periods_reopened_chk;
alter table public.fiscal_periods add constraint fiscal_periods_reopened_chk check (
  (status <> 'reopened' or (reopened_at is not null and reopened_by is not null))
  and (reopened_at is null or length(btrim(coalesce(reopened_reason, ''))) >= 10));

-- Cada cambio de estado deja su evento, lo haga quien lo haga. Vive en el ESQUEMA
-- para que ningún camino (otro servicio, un psql) pueda cerrar sin historia.
create function platform.record_fiscal_period_event()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status is not distinct from old.status then
    return new;
  end if;
  if new.status = 'closed' then
    insert into public.fiscal_period_events
      (tenant_id, company_id, period_id, event_type, reason, actor_id, occurred_at)
    values (new.tenant_id, new.company_id, new.id, 'closed', null, new.closed_by,
            new.closed_at);
  elsif new.status = 'reopened' then
    insert into public.fiscal_period_events
      (tenant_id, company_id, period_id, event_type, reason, actor_id, occurred_at)
    values (new.tenant_id, new.company_id, new.id, 'reopened', new.reopened_reason,
            new.reopened_by, new.reopened_at);
  end if;
  return new;
end;
$$;
revoke execute on function platform.record_fiscal_period_event() from public;
create trigger fiscal_periods_10_history
  after insert or update of status on public.fiscal_periods
  for each row execute function platform.record_fiscal_period_event();

-- ── 3. K-03 · El período de cierre («13») ───────────────────────────────────
alter table public.fiscal_periods add column kind text not null default 'regular';
alter table public.fiscal_periods drop constraint fiscal_periods_month_chk;
alter table public.fiscal_periods add constraint fiscal_periods_month_chk
  check (month between 1 and 13);
alter table public.fiscal_periods add constraint fiscal_periods_kind_chk check (
  kind in ('regular', 'closing') and ((kind = 'closing') = (month = 13)));
comment on column public.fiscal_periods.kind is
  'closing = el período de cierre del ejercicio («13», mes 13, fechado 31-12): solo admite '
  'el asiento de cierre y los ajustes del contador (ADR-0069 §2).';

-- ── 4. K-05 · El período de una fecha, con límites ──────────────────────────
-- Definición VIVA: migración 25 (`create_accounting`), la única que la definió. Se
-- conserva su cuerpo y se le anteponen dos límites, los dos `date` contra `date`.
-- Se comprueban SIEMPRE, exista o no el período: el agosto de E2 existía y aun así
-- era anterior a la empresa.
create or replace function platform.period_for_date(p_company uuid, p_fecha date)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_tenant uuid;
  v_inicio date;
  v_hoy date := (now() at time zone 'America/Caracas')::date;
  v_fin_en_curso date;
begin
  select tenant_id, activity_start_date into v_tenant, v_inicio
    from public.companies where id = p_company;
  if v_inicio is not null and p_fecha < v_inicio then
    raise exception
      'La fecha % es anterior al inicio de actividades de la empresa (%): no hay período contable antes de esa fecha.',
      to_char(p_fecha, 'DD/MM/YYYY'), to_char(v_inicio, 'DD/MM/YYYY')
      using errcode = 'LAD91',
            hint = 'Usa una fecha desde el inicio de actividades.';
  end if;
  v_fin_en_curso := (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date;
  if p_fecha > v_fin_en_curso then
    raise exception
      'La fecha % está en un período futuro: el último período que se puede usar es el en curso (hasta el %).',
      to_char(p_fecha, 'DD/MM/YYYY'), to_char(v_fin_en_curso, 'DD/MM/YYYY')
      using errcode = 'LAD91';
  end if;

  select id into v_id from public.fiscal_periods
   where company_id = p_company
     and year = extract(year from p_fecha)::int
     and month = extract(month from p_fecha)::int;
  if v_id is not null then return v_id; end if;
  insert into public.fiscal_periods (tenant_id, company_id, year, month, status)
  values (v_tenant, p_company, extract(year from p_fecha)::int,
          extract(month from p_fecha)::int, 'open')
  returning id into v_id;
  return v_id;
end;
$$;

-- El período de cierre de un ejercicio. Lo crea abierto si no existe. Los mismos
-- límites: el 31-12 del año no puede ser futuro ni anterior al inicio de actividades.
create function platform.closing_period_for_year(p_company uuid, p_year integer)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_tenant uuid;
  v_inicio date;
  v_cierre date := make_date(p_year, 12, 31);
  v_hoy date := (now() at time zone 'America/Caracas')::date;
begin
  select tenant_id, activity_start_date into v_tenant, v_inicio
    from public.companies where id = p_company;
  if v_inicio is not null and v_cierre < v_inicio then
    raise exception
      'El ejercicio % terminó antes del inicio de actividades de la empresa (%): no tiene cierre.',
      p_year, to_char(v_inicio, 'DD/MM/YYYY') using errcode = 'LAD91';
  end if;
  if v_cierre > (date_trunc('month', v_hoy) + interval '1 month - 1 day')::date then
    raise exception
      'El ejercicio % todavía no termina: su cierre se hace desde diciembre.', p_year
      using errcode = 'LAD91';
  end if;
  select id into v_id from public.fiscal_periods
   where company_id = p_company and year = p_year and month = 13;
  if v_id is not null then return v_id; end if;
  insert into public.fiscal_periods (tenant_id, company_id, year, month, status, kind)
  values (v_tenant, p_company, p_year, 13, 'open', 'closing')
  returning id into v_id;
  return v_id;
end;
$$;
revoke execute on function platform.closing_period_for_year(uuid, integer) from public;
grant execute on function platform.closing_period_for_year(uuid, integer) to ladino_api;

-- ── 5. K-05 + K-03 · Qué admite un período, al CREAR el asiento ─────────────
-- `assert_entry_balanced` (LAD61) solo mira al postear; un borrador en un mes cerrado
-- se creaba (201) y quedaba zombi. Esta comprobación va en INSERT, de cualquier estado.
create function platform.assert_entry_period_admits()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_period public.fiscal_periods;
begin
  select * into v_period from public.fiscal_periods
   where id = new.period_id and company_id = new.company_id;
  if v_period.id is null then return new; end if;  -- la FK lo rechaza con su código
  if v_period.status = 'closed' then
    raise exception
      'El período %-% está cerrado: no admite asientos, tampoco en borrador. Reábrelo con motivo, o fecha el asiento en el período abierto.',
      v_period.year, lpad(v_period.month::text, 2, '0')
      using errcode = 'LAD61';
  end if;
  if v_period.kind = 'closing' then
    if new.source_kind not in ('year_end_close', 'manual') then
      raise exception
        'El período de cierre de % solo admite el asiento de cierre y los ajustes del contador.',
        v_period.year using errcode = 'LAD92';
    end if;
    -- `date` contra `date`: el 31-12 del ejercicio.
    if new.posting_date <> make_date(v_period.year, 12, 31) then
      raise exception 'Un asiento del período de cierre de % se fecha el 31/12/%.',
        v_period.year, v_period.year using errcode = 'LAD92';
    end if;
  elsif new.source_kind = 'year_end_close' then
    raise exception 'El asiento de cierre del ejercicio va en el período de cierre, no en un mes.'
      using errcode = 'LAD92';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_entry_period_admits() from public;
create trigger journal_entries_02a_period_admits
  before insert on public.journal_entries
  for each row execute function platform.assert_entry_period_admits();

-- ── 6. K-06 · El borrador descartado ────────────────────────────────────────
-- `assert_entry_immutable` ya deja cambiar un BORRADOR y congela cualquier otro
-- estado: `draft → discarded` pasa, y un descartado no vuelve a moverse (LAD06).
-- `apply_ledger_balance` ignora todo lo que no sea posted/reversed. No se tocan.
alter table public.journal_entries drop constraint journal_entries_status_chk;
alter table public.journal_entries add constraint journal_entries_status_chk
  check (status in ('draft', 'posted', 'reversed', 'discarded'));
alter table public.journal_entries drop constraint journal_entries_posted_shape_chk;
alter table public.journal_entries add constraint journal_entries_posted_shape_chk check (
  (status in ('draft', 'discarded')
   and entry_number is null and posted_at is null and posted_by is null)
  or (status in ('posted', 'reversed')
      and entry_number is not null and posted_at is not null and posted_by is not null));

-- ── 7. K-04 · La factura de proveedor que llega tarde ───────────────────────
alter table public.supplier_invoices add column accounting_date date;
alter table public.supplier_invoices add constraint supplier_invoices_accounting_date_chk
  check (accounting_date is null or accounting_date > invoice_date);
comment on column public.supplier_invoices.accounting_date is
  'Fecha en que se REGISTRÓ, cuando la de la factura cae en un período cerrado o antes del '
  'inicio de actividades (ADR-0069 §4). NULL = se registró en su fecha. El asiento, el libro '
  'de compras y la planilla usan coalesce(accounting_date, invoice_date).';
alter table public.supplier_credit_notes add column accounting_date date;
alter table public.supplier_credit_notes add constraint supplier_credit_notes_accounting_date_chk
  check (accounting_date is null or accounting_date > note_date);
comment on column public.supplier_credit_notes.accounting_date is
  'Como supplier_invoices.accounting_date, para la nota de crédito recibida con retraso.';

-- La fecha contable de un documento de compra: la suya si su período admite
-- asientos; si no, HOY en Caracas (el período en curso). `date` contra `date`.
-- La ventana legal para deducir crédito (LIVA art. 33) NO se aplica: P-35.
create function platform.accounting_date_for(p_company uuid, p_fecha date)
returns date
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hoy date := (now() at time zone 'America/Caracas')::date;
  v_inicio date;
  v_estado text;
begin
  if p_fecha >= v_hoy then return p_fecha; end if;
  select activity_start_date into v_inicio from public.companies where id = p_company;
  if v_inicio is not null and p_fecha < v_inicio then return v_hoy; end if;
  select status into v_estado from public.fiscal_periods
   where company_id = p_company and kind = 'regular'
     and year = extract(year from p_fecha)::int
     and month = extract(month from p_fecha)::int;
  if v_estado = 'closed' then return v_hoy; end if;
  return p_fecha;
end;
$$;
revoke execute on function platform.accounting_date_for(uuid, date) from public;
grant execute on function platform.accounting_date_for(uuid, date) to ladino_api;

-- LO QUE ESTA MIGRACIÓN NO HACE, a propósito: redefinir platform.purchases_book y
-- platform.recompute_iva_period para que lean coalesce(accounting_date, fecha) y marquen
-- «recibida con retraso». Las dos las redefine la migración 20260928120000 (familia L,
-- en curso en paralelo); copiarlas aquí pisaría cualquier cambio posterior de esa
-- migración sin que nadie lo viera. Hasta que eso se haga ENCIMA de su versión final,
-- el caso de uso de compras NO enruta a la fecha contable (sin el libro, el asiento iría
-- a un período y el libro a otro, y book_ledger_reconciliation dejaría de cuadrar).
-- Esta migración deja el suelo: las columnas y la regla, probadas en pgTAP 079.

-- ── 8. Lo que esta migración GARANTIZA sobre sí misma ───────────────────────
do $$
begin
  if exists (select 1 from public.fiscal_periods p
              where p.status = 'closed'
                and not exists (select 1 from public.fiscal_period_events e
                                 where e.period_id = p.id and e.event_type = 'closed')) then
    raise exception 'ADR-0069: un período cerrado quedó sin su evento de cierre';
  end if;
  if exists (select 1 from public.companies where activity_start_date is null) then
    raise exception 'ADR-0069: una empresa quedó sin fecha de inicio de actividades';
  end if;
end $$;

-- =============================================================================
-- REVERSIBILIDAD, con datos vivos:
--   · fiscal_period_events: se puede quitar; el estado actual vive en la fila. Se pierde la
--     historia de los ciclos posteriores a esta migración (queda en audit_events como
--     `accounting.period_closed/reopened`, con motivo).
--   · Los CHECK de fiscal_periods NO se pueden restaurar tal cual si ya hay un período
--     reabierto con `closed_at` (el estado que K-01 hace posible): habría que limpiar esas
--     columnas, que es perder el último cierre de la fila (sigue en la tabla de eventos).
--   · Período 13: restaurar `month between 1 and 12` exige que no haya períodos de cierre;
--     con un cierre anual hecho, NO es reversible sin reubicar su asiento (inmutable).
--   · 'discarded': restaurar el CHECK viejo exige que no haya borradores descartados; no se
--     pueden devolver a draft sin perder el acto de descarte (queda en audit_events).
--   · accounting_date: columnas nuevas sin uso todavía; se quitan sin pérdida.
--   · activity_start_date y las funciones: reversibles con create or replace de su
--     definición anterior (period_for_date: migración 25; accounting_date_for y
--     closing_period_for_year: drop).
-- =============================================================================
