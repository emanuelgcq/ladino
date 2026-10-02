-- =============================================================================
-- Ladino — LA TABLA DE LA 2.ª QUINCENA ESPERA A LA GACETA; LA PROPUESTA MIRA EL CIERRE; UNA SOLA QUINCENA
-- Módulo: declaración de IVA · calendario fiscal
-- Spec: docs/02_COMPLIANCE/CALENDARIO_SPE_2026.md · docs/02_COMPLIANCE/IVA_SPEC.md
-- ADR: ADR-0072 §8 y nota de aplicación parte 4 · revisión de L-04/L-09 (H1, H3, H8)
--
--   1. H1 · FE DE ERRATAS de 20261002120000 (que no se edita). Su comentario de la siembra dice que
--      la columna de la tabla 1.2 es el mes de presentación porque «es la única lectura posible» y
--      que `tax_calendar_entries_due_chk` «la hace cumplir». Es FALSO: la otra lectura (la columna es
--      el mes del período y se presenta en el mes siguiente) también pone el vencimiento DESPUÉS del
--      cierre y pasa el mismo CHECK. El CHECK solo prohíbe vencer antes del cierre; no decide el
--      mapeo. El mapeo está marcado ⚠ en CALENDARIO_SPE_2026.md (§1.2) y la respuesta del dueño
--      (§2.6) manda no ofrecer lo pendiente de cotejo. Las 480 filas de la tabla 1.2 pasan a
--      `pending_review` con su nota; `platform.tax_due_date` las devuelve con la fecha en NULL hasta
--      el cotejo con la G.O. 43.283 (P-10, reabierta). Las fechas sembradas NO se tocan: si el cotejo
--      confirma la lectura (a), basta con volver a cambiar el estado.
--   2. H3 · `platform.iva_period_proposal` evalúa el tipo en el CIERRE de cada período candidato:
--      primero la última quincena cerrada (si al cerrarla era especial, esa); si no, el último mes
--      cerrado (si al cerrarlo era ordinaria, ese; si al cerrarlo todavía era especial —transición
--      especial→ordinaria en el mes en curso—, la última quincena de ese mes, la que tocaba).
--   3. H8 · `platform.retention_fortnight` (migración 20261002110000, retenciones que practicamos)
--      se redefine como envoltorio de `platform.fiscal_fortnight`: un solo corte de quincena en el
--      esquema. Misma firma, mismos OUT, mismos GRANT (create or replace los conserva). El envoltorio
--      va en PLPGSQL a propósito: `fiscal_fortnight` lleva SET search_path y no es inlinable, y un
--      envoltorio SQL sobre una función SQL no inlinable replanifica por invocación (skill de
--      migraciones, «un envoltorio SQL… replanifica por fila»).
--
-- Reversible: SÍ, con datos vivos.
--   · Volver a ofrecer la tabla 1.2: update del estado (las fechas siguen sembradas).
--   · La propuesta y retention_fortnight: create or replace con el texto de 20261002120000 y de
--     20261002110000. Ninguna escribe datos.
-- HOMOLOGATION_IMPACT: NO — no cambia documentos, numeración ni el resultado de la planilla; deja
--   de mostrar fechas no cotejadas y ajusta qué período se PROPONE.
-- =============================================================================

-- ── 1. La tabla 1.2, pendiente de cotejo ─────────────────────────────────────
update public.tax_calendar_entries
   set review_status = 'pending_review',
       review_note = 'Tabla 1.2 (segunda quincena): el mapeo de sus columnas está marcado ⚠ en '
                     'CALENDARIO_SPE_2026.md §1.2 — ¿la columna es el mes de presentación (sembrado así) o el '
                     'mes del período? Pendiente de cotejo con la G.O. 43.283 (P-10).'
                     || case when review_note is null then ''
                             else ' Además: ' || review_note end
 where legal_norm = 'PA SNAT/2025/000091'
   and obligation in ('iva', 'ret_iva', 'igtf', 'islr_anticipo')
   and extract(day from period_from) = 16;

do $$
declare n_pend int;
begin
  select count(*) filter (where review_status = 'pending_review') into n_pend
    from public.tax_calendar_entries where legal_norm = 'PA SNAT/2025/000091';
  -- 480 de la tabla 1.2 + 16 de las celdas ⚠ de la tabla 1.1.
  if n_pend <> 496 then
    raise exception 'calendario 2026: % filas pendientes (esperaba 496)', n_pend;
  end if;
end $$;

comment on column public.tax_calendar_entries.review_status is
  'secondary_source = transcrita de fuente secundaria, se ofrece con su fuente; pending_review = '
  'pendiente de cotejo con la Gaceta, NO se ofrece (platform.tax_due_date la devuelve en NULL). '
  'Desde 20261002120100 toda la tabla 1.2 (2.ª quincena) está pending_review: su mapeo de columnas '
  'es ⚠, y el CHECK de vencimiento NO lo decide (fe de erratas de 20261002120000).';
comment on constraint tax_calendar_entries_due_chk on public.tax_calendar_entries is
  'Nadie presenta antes de que termine su período. NO fija la lectura de la tabla 1.2: las dos '
  'lecturas (mes de presentación o mes del período) lo cumplen (fe de erratas, 20261002120100).';

-- ── 2. La propuesta mira el cierre del período candidato ─────────────────────
create or replace function platform.iva_period_proposal(p_company uuid, p_today date)
returns table (taxpayer_type text, periodicity text, period_from date, period_to date,
               due_date date, due_date_status text, legal_source text)
language sql
stable
set search_path = ''
as $$
  -- `p_today` es el día de Caracas (lo pasa quien llama). El tipo se evalúa SIEMPRE en el día de
  -- cierre del período candidato: es el tipo con el que ese período se declara.
  with hoy as (
    select f.period_from as quincena_en_curso,
           make_date(extract(year from p_today)::int, extract(month from p_today)::int, 1)
             as mes_en_curso
      from platform.fiscal_fortnight(p_today) f
  ),
  candidatos as (
    select q.period_from as q_desde, q.period_to as q_hasta,
           (h.mes_en_curso - interval '1 month')::date as m_desde,
           h.mes_en_curso - 1 as m_hasta,
           platform.taxpayer_type_at(p_company, q.period_to) as tipo_q,
           platform.taxpayer_type_at(p_company, h.mes_en_curso - 1) as tipo_m
      from hoy h, platform.fiscal_fortnight(h.quincena_en_curso - 1) q
  ),
  periodo as (
    select case when c.tipo_q = 'especial' then c.tipo_q else c.tipo_m end as tipo,
           case when c.tipo_q = 'especial' or c.tipo_m = 'especial' then 'quincenal'
                when c.tipo_m = 'ordinario' then 'mensual' end as periodicidad,
           case when c.tipo_q = 'especial' then c.q_desde
                -- transición especial→ordinaria en el mes en curso: la última quincena del mes
                -- cerrado, que al cerrarse todavía era de especial.
                when c.tipo_m = 'especial' then c.m_desde + 15
                else c.m_desde end as desde,
           case when c.tipo_q = 'especial' then c.q_hasta
                else c.m_hasta end as hasta
      from candidatos c
  )
  select p.tipo, p.periodicidad, p.desde, p.hasta, d.due_date, d.review_status, d.legal_source
    from periodo p
    left join lateral platform.tax_due_date(p_company, 'iva', p.desde, p.hasta) d on true;
$$;
comment on function platform.iva_period_proposal(uuid, date) is
  'El período de IVA que la pantalla propone (L-04): la última quincena cerrada si al cerrarla la '
  'empresa era especial; si no, el último mes cerrado si al cerrarlo era ordinaria, o su última '
  'quincena si al cerrarlo aún era especial (transición). El tipo se evalúa en el CIERRE del '
  'candidato (H3, 20261002120100). Vencimiento solo si la celda está ofrecida. Día de Caracas.';

-- ── 3. Una sola quincena en el esquema ───────────────────────────────────────
create or replace function platform.retention_fortnight(p_day date,
                                                        out fortnight_start date,
                                                        out fortnight_end date)
language plpgsql
immutable
set search_path = ''
as $$
begin
  -- Envoltorio de platform.fiscal_fortnight (H8): el corte de la quincena vive en un solo sitio.
  -- PLPGSQL a propósito: un envoltorio SQL sobre una función no inlinable replanifica por llamada.
  select f.period_from, f.period_to
    into fortnight_start, fortnight_end
    from platform.fiscal_fortnight(p_day) f;
end;
$$;
comment on function platform.retention_fortnight(date) is
  'La quincena (1-15 o 16-último) de un día de Caracas, para los comprobantes de retención '
  '(ADR-0072 §4). Desde 20261002120100 es un envoltorio de platform.fiscal_fortnight: no se '
  'redefine con lógica propia.';
