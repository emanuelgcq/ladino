-- =============================================================================
-- Ladino — EL FIADO TIENE VENCIMIENTO (P-05, E-22; R-82 punto 7)
-- Módulo: ventas · cuentas por cobrar     ADR: ADR-0075 (nota de aplicación «el vencimiento»)
-- Reversible: SÍ en el esquema (ver «Para revertir»). Con datos vivos: quitar la columna PIERDE
--   la fecha que cada venta fiada acordó desde el despliegue; no se reconstruye de ningún otro
--   dato. Quitar solo las funciones y el trigger no pierde nada.
-- Homologación: NO en el esquema (no cambia base, IVA, numeración ni libro). El texto impreso de
--   una venta con saldo sí cambia (leyendas no fiscales): lo declara la entrega.
--
-- EXPAND: una columna nullable, un CHECK que toda fila existente cumple (todas nacen con NULL),
-- un trigger que solo actúa si alguien cambia la columna nueva, y dos funciones nuevas. La API
-- desplegada no escribe ni lee nada de esto: puede aplicarse ANTES del `git pull`.
-- No redefine ninguna función existente.
--
-- Decidido por criterio (RESPUESTA §2.16; el dueño da por hecho que una venta fiada VENCE):
--   D1  `documents.due_date` se escribe AL EMITIR y queda congelada como el resto del documento.
--   D4  Lo vencido de un documento es SU DEUDA —la de platform.document_debt, la única función
--       de deuda (ADR-0075 §5)— cuando `coalesce(due_date, día de emisión) < hoy`. Un documento
--       sin fecha (lo anterior a esta migración; la factura de administración que no la trae)
--       vence el día de su emisión: una deuda sin plazo acordado es exigible desde que nace.
--
-- LA GRANULARIDAD, DECLARADA (CLAUDE.md §3): todo aquí compara dos `date`. El día de un documento
-- es el DÍA DE CARACAS de su `issued_at`; «hoy» es un `date` que se recibe como parámetro (por
-- omisión, el día de Caracas de ahora). Ningún `timestamptz` se compara contra un `date`.
-- =============================================================================

-- ── 1. El dato ───────────────────────────────────────────────────────────────
alter table public.documents add column due_date date;
comment on column public.documents.due_date is
  'P-05/E-22: el día en que vence la deuda de esta venta, acordado al vender. Se escribe al '
  'emitir y es inmutable después (documents_06_due_date_frozen). NULL = sin plazo acordado: '
  'vence el día de su emisión (platform.document_due_day). En una venta que quedó pagada no '
  'significa nada.';

-- Dos `date`: el vencimiento contra el día de Caracas de la emisión. En borrador (sin
-- `issued_at`) no hay con qué comparar; se comprueba en el UPDATE que emite.
alter table public.documents
  add constraint documents_due_date_chk
  check (due_date is null or issued_at is null
         or due_date >= (issued_at at time zone 'America/Caracas')::date);

-- ── 2. Congelada tras emitir ─────────────────────────────────────────────────
-- platform.assert_document_immutable enumera columnas (no compara la fila entera) y no conoce
-- `due_date`. En vez de redefinirla (la comparten otras familias), el patrón de `rate_basis`
-- (20260928160500): un trigger propio de la columna.
create function platform.documents_due_date_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('issued', 'paid', 'annulled')
     and new.due_date is distinct from old.due_date then
    raise exception
      'LAD06: el vencimiento de un documento emitido es inmutable: se acordó al vender (P-05)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.documents_due_date_frozen() from public;
create trigger documents_06_due_date_frozen
  before update on public.documents
  for each row execute function platform.documents_due_date_frozen();
comment on trigger documents_06_due_date_frozen on public.documents is
  'P-05: el vencimiento se fija al emitir. Quitarlo deja mover la fecha de una deuda ya impresa '
  'en el papel del cliente (y con ella, qué cuenta como vencido).';

-- ── 3. La regla D4, en un solo sitio ─────────────────────────────────────────
create function platform.document_due_day(p_due_date date, p_issued_at timestamptz)
returns date
language sql
immutable
set search_path = ''
as $$
  select coalesce(p_due_date, (p_issued_at at time zone 'America/Caracas')::date)
$$;
revoke execute on function platform.document_due_day(date, timestamptz) from public;
grant execute on function platform.document_due_day(date, timestamptz)
  to authenticated, ladino_api;
comment on function platform.document_due_day(date, timestamptz) is
  'P-05 (D4): el día en que vence un documento: su due_date o, sin ella, el día de Caracas de su '
  'emisión. Está vencido cuando ese día es ANTERIOR a hoy (dos date). La usan '
  'platform.customer_overdue_today, el estado de cuenta y el papel: una sola regla.';

-- ── 4. Lo vencido, por cliente y moneda ──────────────────────────────────────
-- Es la deuda de platform.document_debt filtrada por D4: mismos documentos (factura, recibo y
-- nota de débito; emitidos) y mismas cifras que platform.customer_debt_today. SECURITY INVOKER,
-- como ellas: la RLS de `documents` es la que aísla.
-- `p_today` decide QUÉ está vencido. La tasa con que se valora es la de platform.document_debt
-- (la de hoy de verdad): lo vencido «a otra fecha» se valora igualmente a la tasa de hoy.
create function platform.customer_overdue_today(
  p_company uuid,
  p_customer uuid default null,
  p_today date default platform.caracas_day(now())
)
returns table (customer_id uuid, currency text, nominal numeric, functional_today numeric,
               document_count bigint)
language sql
stable
set search_path = ''
as $$
  select d.customer_id, dd.currency,
         -- NULL no es cero: si el nominal de algún documento no se puede calcular, se dice.
         case when bool_or(dd.nominal is null) then null else sum(dd.nominal) end,
         case when bool_or(dd.functional_today is null) then null
              else sum(greatest(dd.functional_today, 0))::numeric(24,8) end,
         count(*)
    from public.documents d
   cross join lateral platform.document_debt(p_company, d.id) dd
   where d.company_id = p_company
     and (p_customer is null or d.customer_id = p_customer)
     and d.kind in ('invoice', 'receipt', 'debit_note')
     and d.status in ('issued', 'paid')
     and platform.document_due_day(d.due_date, d.issued_at) < p_today
     and (dd.nominal > 0 or dd.nominal is null)
   group by d.customer_id, dd.currency
   order by d.customer_id, dd.currency
$$;
revoke execute on function platform.customer_overdue_today(uuid, uuid, date) from public;
grant execute on function platform.customer_overdue_today(uuid, uuid, date)
  to authenticated, ladino_api;
comment on function platform.customer_overdue_today(uuid, uuid, date) is
  'P-05: la deuda VENCIDA por cliente y moneda. Es platform.document_debt (la única función de '
  'deuda, ADR-0075 §5) sobre los documentos cuyo platform.document_due_day es anterior a '
  'p_today (dos date; por omisión el día de Caracas de ahora). nominal en la moneda del '
  'documento; functional_today a la tasa de hoy, NULL si falta (nunca 0). Sin filas = nada '
  'vencido.';

-- ── Para revertir ───────────────────────────────────────────────────────────
--   drop function platform.customer_overdue_today(uuid, uuid, date);
--   drop function platform.document_due_day(date, timestamptz);
--   drop trigger documents_06_due_date_frozen on public.documents;
--   drop function platform.documents_due_date_frozen();
--   alter table public.documents drop constraint documents_due_date_chk;
--   alter table public.documents drop column due_date;   -- PIERDE las fechas acordadas
-- La API que ya escribe `due_date` falla al emitir si la columna no existe: revertir la columna
-- exige revertir antes la API.
