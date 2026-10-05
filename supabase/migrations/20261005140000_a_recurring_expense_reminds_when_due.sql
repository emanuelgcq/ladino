-- =============================================================================
-- Ladino — EL GASTO QUE SE REPITE AVISA CUANDO TOCA (H-07, recorrido 2026-09-24, ola 5)
--
-- Módulo: tesorería · gastos. Spec: docs/03_MODULES/TREASURY_SPEC.md (gastos).
-- Respuesta del dueño (RESPUESTA_RECORRIDO_2026-09-24.md §3, H-07): «Se construye: gasto
-- recurrente con periodicidad, aviso en Inicio y en Alertas cuando toca, y "registrar ahora"
-- con los datos precargados».
--
-- Antes: `expenses.is_recurring` y `supplier_invoices.expense_is_recurring` eran una marca que
-- nadie leía. La pantalla prometía «para recordártelo cuando toque» y no había recordatorio.
--
-- Ahora hay DOS tablas:
--
--   · `recurring_expenses` — el RECORDATORIO: qué se paga (categoría, cuenta, proveedor, importe
--     de la última vez como SUGERENCIA), cada cuánto (`periodicity`), desde cuándo (`anchor_date`)
--     y cuál es el próximo día que toca (`next_due_on`);
--   · `recurring_expense_periods` — cada PERÍODO ATENDIDO: se registró el gasto (con su gasto o
--     su factura de gasto) o se omitió esa vez. Append-only.
--
-- SIN TAREA PROGRAMADA. «Toca» se calcula AL LEER: `next_due_on <= hoy`, donde «hoy» es el día
-- calendario de Caracas. GRANULARIDAD DECLARADA (CLAUDE.md §3): todo aquí es `date` contra
-- `date`. Ni `anchor_date`, ni `next_due_on`, ni `due_on` son instantes; ninguna comparación de
-- esta migración mezcla un `date` con un `timestamptz`, y la aritmética (`date + interval`) da
-- un `timestamp` SIN zona que se vuelve a `date` sin pasar por ninguna zona horaria.
--
-- LAS PERIODICIDADES (decidido por criterio, §2.16: la respuesta dice «con periodicidad» sin
-- enumerarlas; estas cuatro son las de un negocio pequeño en Venezuela):
--   weekly       cada 7 días desde el ancla;
--   semimonthly  dos veces al mes («cada quincena»): el día del ancla y 15 días después, y los
--                mismos dos días de cada mes siguiente;
--   monthly      el mismo día de cada mes;
--   yearly       el mismo día de cada año.
-- FIN DE MES (decidido y probado en el pgTAP 136): cada ocurrencia se calcula DESDE EL ANCLA, no
-- desde la anterior. Un gasto del día 31 toca el 28 (o 29) de febrero, el 31 de marzo y el 30 de
-- abril: en un mes más corto toca su último día, y no se queda para siempre en el 28.
--
-- IDEMPOTENCIA EN LA BASE (la clave natural que cierra la ventana del Idempotency-Key):
--   · un período solo se atiende si es EL QUE TOCA (`due_on = next_due_on`), bajo `FOR UPDATE`
--     de su recordatorio; atenderlo AVANZA `next_due_on` en la misma sentencia. El segundo clic
--     llega con un `due_on` que ya no es el que toca y se rechaza (55000);
--   · debajo, `unique (recurring_expense_id, due_on)`.
--   `next_due_on` NO es escribible por `ladino_api` (GRANT por columna): solo lo mueve el trigger
--   del período. No existe «avanzar el recordatorio» sin dejar constancia de por qué.
--
-- Reversibilidad: SÍ en esquema — dos tablas y tres funciones nuevas; no altera ninguna tabla
-- existente ni redefine ninguna función. Se revierte con `drop table
-- public.recurring_expense_periods, public.recurring_expenses` y `drop function` de las tres.
-- CON DATOS VIVOS: los GASTOS registrados desde un recordatorio NO se tocan al revertir (son
-- gastos normales, con su asiento y su movimiento de cuenta); lo que se pierde es el recordatorio
-- y la constancia de qué períodos se atendieron u omitieron. Los gastos anteriores a esta
-- migración marcados como recurrentes NO nacen con recordatorio (no se inventa una periodicidad
-- que nadie eligió): el recordatorio nace al registrar el siguiente con la marca.
-- Impacto de homologación: NO (no toca documentos fiscales, numeración, impuestos ni asientos).
-- Despliegue: JUSTO DESPUÉS del `git pull` (la API nueva la necesita; la API vieja no la conoce
-- y no le estorba). No depende de ninguna migración de la ola 5 de otras familias.
-- =============================================================================

-- ── 1. Las ocurrencias: aritmética pura de fechas ───────────────────────────
create function platform.recurring_occurrence(p_anchor date, p_periodicity text, p_k integer)
returns date
language sql
immutable
set search_path = ''
as $$
  -- `date + interval` da `timestamp` SIN zona; `::date` lo devuelve a día sin tocar zona alguna.
  -- Siempre desde el ANCLA: `+ k months` recorta al último día del mes corto sin arrastrarlo.
  select case p_periodicity
    when 'weekly'  then p_anchor + 7 * p_k
    when 'monthly' then (p_anchor + make_interval(months => p_k))::date
    when 'yearly'  then (p_anchor + make_interval(years => p_k))::date
    when 'semimonthly' then
      case when p_k % 2 = 0
           then (p_anchor + make_interval(months => p_k / 2))::date
           else ((p_anchor + 15) + make_interval(months => (p_k - 1) / 2))::date
      end
  end
$$;
comment on function platform.recurring_occurrence(date, text, integer) is
  'H-07: la ocurrencia número k (desde 0) de un gasto que se repite, calculada desde su ancla. '
  'Solo fechas: ninguna zona horaria interviene. NULL si la periodicidad no existe.';

create function platform.recurring_due_after(p_anchor date, p_periodicity text, p_after date)
returns date
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_meses integer;
  v_k     integer;
  v_dia   date;
begin
  if p_anchor is null or p_after is null
     or p_periodicity not in ('weekly', 'semimonthly', 'monthly', 'yearly') then
    return null;
  end if;
  if p_after < p_anchor then
    return p_anchor;
  end if;
  -- Un k de partida que nunca se pasa (dos períodos por debajo de la estimación), para no
  -- recorrer la historia entera de un recordatorio viejo.
  v_meses := (extract(year from p_after)::integer - extract(year from p_anchor)::integer) * 12
           + (extract(month from p_after)::integer - extract(month from p_anchor)::integer);
  v_k := greatest(0, case p_periodicity
    when 'weekly'      then (p_after - p_anchor) / 7 - 2
    when 'semimonthly' then v_meses * 2 - 4
    when 'monthly'     then v_meses - 2
    when 'yearly'      then v_meses / 12 - 2
  end);
  loop
    v_dia := platform.recurring_occurrence(p_anchor, p_periodicity, v_k);
    exit when v_dia > p_after;
    v_k := v_k + 1;
  end loop;
  return v_dia;
end;
$$;
comment on function platform.recurring_due_after(date, text, date) is
  'H-07: la primera ocurrencia ESTRICTAMENTE posterior a p_after (o el ancla, si p_after es '
  'anterior a ella). `date` contra `date`. NULL si la periodicidad no existe.';

revoke all on function platform.recurring_occurrence(date, text, integer) from public;
revoke all on function platform.recurring_due_after(date, text, date) from public;
-- Las evalúa el CHECK de la tabla con los privilegios de quien inserta: sin este GRANT la tabla
-- nacería escribible por nadie (lección de S0.4, `audit_payload_hash`).
grant execute on function platform.recurring_occurrence(date, text, integer) to ladino_api;
grant execute on function platform.recurring_due_after(date, text, date) to ladino_api;

-- ── 2. El recordatorio ───────────────────────────────────────────────────────
create table public.recurring_expenses (
  id                uuid        primary key default platform.uuidv7(),
  tenant_id         uuid        not null,
  company_id        uuid        not null,
  /** El mismo vocabulario de persona del gasto: «Alquiler», «Luz». */
  category          text        not null,
  description       text,
  /** De qué cuenta salió la última vez. Sugerencia: la persona la confirma al registrar. */
  account_id        uuid,
  supplier_id       uuid,
  /** Lo que salió de la cuenta la última vez, en SU moneda. Sugerencia, nunca un cargo. */
  suggested_amount  numeric(24,8),
  currency          text,
  /** La última vez se registró con factura fiscal (ADR-0080): la pantalla abre por esa rama. */
  with_invoice      boolean     not null default false,
  periodicity       text        not null,
  /** El día (calendario, sin hora) del primer pago: de él salen todas las ocurrencias. */
  anchor_date       date        not null,
  /** El próximo día que toca. Solo lo mueve el trigger del período atendido. */
  next_due_on       date        not null,
  status            text        not null default 'active',
  stopped_at        timestamptz,
  stopped_by        uuid,

  created_by        uuid,
  created_at        timestamptz not null,
  version           integer     not null,

  constraint recurring_expenses_tenant_fk foreign key (tenant_id) references public.tenants (id),
  constraint recurring_expenses_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint recurring_expenses_company_id_key unique (company_id, id),
  constraint recurring_expenses_account_fk
    foreign key (company_id, account_id) references public.company_accounts (company_id, id),
  constraint recurring_expenses_supplier_fk
    foreign key (company_id, supplier_id) references public.suppliers (company_id, id),
  constraint recurring_expenses_category_chk check (length(btrim(category)) between 2 and 60),
  constraint recurring_expenses_description_chk
    check (description is null or length(description) between 1 and 500),
  constraint recurring_expenses_amount_chk check (
    (suggested_amount is null and currency is null)
    or (suggested_amount > 0 and currency ~ '^[A-Z]{3,5}$')),
  constraint recurring_expenses_periodicity_chk
    check (periodicity in ('weekly', 'semimonthly', 'monthly', 'yearly')),
  constraint recurring_expenses_status_chk check (status in ('active', 'stopped')),
  constraint recurring_expenses_stopped_chk
    check ((status = 'stopped') = (stopped_at is not null)),
  -- El próximo día que toca ES una ocurrencia del ancla, nunca un día cualquiera.
  constraint recurring_expenses_next_due_chk check (
    next_due_on >= anchor_date
    and next_due_on = platform.recurring_due_after(anchor_date, periodicity, next_due_on - 1))
);

comment on table public.recurring_expenses is
  'H-07: el recordatorio de un gasto que se repite. «Toca» cuando next_due_on <= el día de '
  'Caracas de hoy; se calcula al leer, sin tarea programada. No registra dinero: lo registra '
  'la persona por la puerta de siempre (POST /v1/expenses), con estos datos precargados.';

-- Un recordatorio VIVO por categoría: registrar otra vez «Luz» con la marca no crea un segundo
-- aviso de lo mismo. Sin distinguir mayúsculas ni espacios de los bordes.
create unique index recurring_expenses_active_category_key
  on public.recurring_expenses (company_id, lower(btrim(category)))
  where status = 'active';
-- Lo que pregunta el Inicio: los vivos de la empresa, por el día que tocan.
create index recurring_expenses_due_idx
  on public.recurring_expenses (company_id, next_due_on)
  where status = 'active';

create function platform.recurring_expense_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'stopped' then
    raise exception 'el recordatorio % ya no se paga: no se modifica', old.id
      using errcode = '55000';
  end if;
  if new.periodicity is distinct from old.periodicity
     or new.anchor_date is distinct from old.anchor_date
     or new.category is distinct from old.category then
    raise exception 'lo que define el recordatorio (qué, cada cuánto, desde cuándo) no cambia: '
                    'se deja de pagar y se crea otro'
      using errcode = '55000';
  end if;
  if new.next_due_on < old.next_due_on then
    raise exception 'el próximo día que toca solo avanza' using errcode = '55000';
  end if;
  return new;
end;
$$;
comment on function platform.recurring_expense_guard() is
  'Guarda de recurring_expenses (H-07): categoría, periodicidad y ancla no cambian; un '
  'recordatorio que ya no se paga no se toca; next_due_on solo avanza.';
revoke all on function platform.recurring_expense_guard() from public;

create trigger recurring_expenses_00_provenance
  before insert or update on public.recurring_expenses
  for each row execute function platform.set_row_provenance();
create trigger recurring_expenses_01_anchors
  before update on public.recurring_expenses
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger recurring_expenses_02_guard
  before update on public.recurring_expenses
  for each row execute function platform.recurring_expense_guard();

-- ── 3. Los períodos atendidos ────────────────────────────────────────────────
create table public.recurring_expense_periods (
  id                    uuid        primary key default platform.uuidv7(),
  tenant_id             uuid        not null,
  company_id            uuid        not null,
  recurring_expense_id  uuid        not null,
  /** El día que tocaba (calendario, sin hora). */
  due_on                date        not null,
  outcome               text        not null,
  /** El gasto llano que lo atendió, o… */
  expense_id            uuid,
  /** …la factura del gasto (ADR-0080). Exactamente uno de los dos cuando se registró. */
  supplier_invoice_id   uuid,

  created_by            uuid,
  created_at            timestamptz not null,
  version               integer     not null,

  constraint recurring_expense_periods_tenant_fk
    foreign key (tenant_id) references public.tenants (id),
  constraint recurring_expense_periods_company_fk
    foreign key (tenant_id, company_id) references public.companies (tenant_id, id),
  constraint recurring_expense_periods_parent_fk
    foreign key (company_id, recurring_expense_id)
    references public.recurring_expenses (company_id, id),
  constraint recurring_expense_periods_expense_fk
    foreign key (company_id, expense_id) references public.expenses (company_id, id),
  constraint recurring_expense_periods_invoice_fk
    foreign key (company_id, supplier_invoice_id)
    references public.supplier_invoices (company_id, id),
  -- LA CLAVE NATURAL: un período se atiende una vez. El trigger de abajo rechaza antes el
  -- segundo intento (ya no es «el que toca»); este único es la capa que queda si el trigger
  -- cambiara. No es higiene: quitarlo deja una sola defensa contra el gasto doble.
  constraint recurring_expense_periods_key unique (recurring_expense_id, due_on),
  constraint recurring_expense_periods_outcome_chk check (outcome in ('registered', 'skipped')),
  constraint recurring_expense_periods_source_chk check (
    (outcome = 'registered' and num_nonnulls(expense_id, supplier_invoice_id) = 1)
    or (outcome = 'skipped' and num_nonnulls(expense_id, supplier_invoice_id) = 0))
);

comment on table public.recurring_expense_periods is
  'H-07: cada período de un gasto que se repite, ya atendido: registrado (con su gasto o su '
  'factura de gasto) u omitido esa vez. Append-only. Insertar una fila avanza next_due_on de '
  'su recordatorio.';

create index recurring_expense_periods_company_idx
  on public.recurring_expense_periods (company_id, created_at desc);
create unique index recurring_expense_periods_expense_key
  on public.recurring_expense_periods (expense_id) where expense_id is not null;
create unique index recurring_expense_periods_invoice_key
  on public.recurring_expense_periods (supplier_invoice_id) where supplier_invoice_id is not null;

/**
 * ATENDER UN PERÍODO. SECURITY DEFINER a propósito: `next_due_on` no es escribible por
 * `ladino_api`, y este es el ÚNICO sitio que lo mueve. Lo que la función puede tocar está
 * cerrado por lo que valida: el recordatorio es el de la MISMA empresa y el MISMO tenant de la
 * fila que se inserta, y esa fila ya pasó la RLS de `ladino_api` y sus FK compuestas.
 */
create function platform.recurring_expense_period_attend()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tenant      uuid;
  v_status      text;
  v_anchor      date;
  v_periodicity text;
  v_due         date;
begin
  select r.tenant_id, r.status, r.anchor_date, r.periodicity, r.next_due_on
    into v_tenant, v_status, v_anchor, v_periodicity, v_due
    from public.recurring_expenses r
   where r.id = new.recurring_expense_id and r.company_id = new.company_id
     for update;
  if not found or v_tenant is distinct from new.tenant_id then
    raise exception 'el recordatorio % no existe en esta empresa', new.recurring_expense_id
      using errcode = '23503';
  end if;
  if v_status <> 'active' then
    raise exception 'el recordatorio % ya no se paga: no se le atienden períodos',
      new.recurring_expense_id using errcode = '55000';
  end if;
  -- `date` contra `date`.
  if new.due_on is distinct from v_due then
    raise exception 'el período % no es el que toca (%): ya se atendió o todavía no llega',
      new.due_on, v_due using errcode = '55000';
  end if;
  update public.recurring_expenses
     set next_due_on = platform.recurring_due_after(v_anchor, v_periodicity, new.due_on)
   where id = new.recurring_expense_id;
  return new;
end;
$$;
comment on function platform.recurring_expense_period_attend() is
  'H-07: un período solo se atiende si es el que toca, bajo FOR UPDATE de su recordatorio, y '
  'atenderlo avanza next_due_on. Es lo que hace que dos clics no registren dos gastos.';
revoke all on function platform.recurring_expense_period_attend() from public;

create trigger recurring_expense_periods_00_provenance
  before insert or update on public.recurring_expense_periods
  for each row execute function platform.set_row_provenance();
create trigger recurring_expense_periods_01_anchors
  before update on public.recurring_expense_periods
  for each row execute function platform.assert_isolation_anchors_immutable();
create trigger recurring_expense_periods_02_attend
  before insert on public.recurring_expense_periods
  for each row execute function platform.recurring_expense_period_attend();
create trigger recurring_expense_periods_immutable
  before update or delete on public.recurring_expense_periods
  for each row execute function platform.reject_mutation();

-- ── 4. RLS y privilegios ─────────────────────────────────────────────────────
alter table public.recurring_expenses enable row level security;
alter table public.recurring_expenses force row level security;
alter table public.recurring_expense_periods enable row level security;
alter table public.recurring_expense_periods force row level security;

revoke all on public.recurring_expenses from anon, authenticated, service_role;
revoke all on public.recurring_expense_periods from anon, authenticated, service_role;

grant select, insert on public.recurring_expenses to ladino_api;
-- Por COLUMNA: `next_due_on`, `periodicity`, `anchor_date` y `category` no están. El próximo día
-- que toca solo lo mueve el trigger del período.
grant update (description, account_id, supplier_id, suggested_amount, currency, with_invoice,
              status, stopped_at, stopped_by)
  on public.recurring_expenses to ladino_api;
grant select, insert on public.recurring_expense_periods to ladino_api;

create policy recurring_expenses_api_select on public.recurring_expenses
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy recurring_expenses_api_insert on public.recurring_expenses
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy recurring_expenses_api_update on public.recurring_expenses
  for update to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()))
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy recurring_expenses_api_no_delete on public.recurring_expenses
  for delete to ladino_api using (false);

create policy recurring_expense_periods_api_select on public.recurring_expense_periods
  for select to ladino_api
  using (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy recurring_expense_periods_api_insert on public.recurring_expense_periods
  for insert to ladino_api
  with check (tenant_id in (select platform.ladino_service_tenant_ids()));
create policy recurring_expense_periods_api_no_update on public.recurring_expense_periods
  for update to ladino_api using (false) with check (false);
create policy recurring_expense_periods_api_no_delete on public.recurring_expense_periods
  for delete to ladino_api using (false);

-- ── 5. Comprobaciones de la propia migración ─────────────────────────────────
do $$
begin
  -- Fin de mes: un gasto del 31 toca el último día del mes corto y vuelve al 31.
  if platform.recurring_due_after(date '2026-01-31', 'monthly', date '2026-01-31')
       <> date '2026-02-28'
     or platform.recurring_due_after(date '2026-01-31', 'monthly', date '2026-02-28')
       <> date '2026-03-31' then
    raise exception 'H-07: la ocurrencia mensual de fin de mes no es la esperada';
  end if;
  if not exists (select 1 from public.permissions where key = 'expense.read')
     or not exists (select 1 from public.permissions where key = 'expense.register') then
    raise exception 'H-07: faltan los permisos expense.read / expense.register en el catálogo';
  end if;
end $$;
