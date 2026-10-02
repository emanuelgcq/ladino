-- =============================================================================
-- Ladino — EL ESPECIAL DECLARA POR QUINCENA, CON DOS ARRASTRES Y SU CALENDARIO SEMBRADO
-- Módulo: declaración de IVA · calendario fiscal
-- Spec: docs/02_COMPLIANCE/IVA_SPEC.md · docs/02_COMPLIANCE/CALENDARIO_SPE_2026.md
-- ADR: ADR-0072 §7 y §8 (enmienda ADR-0052) · recorrido 2026-09-24: L-04, L-05, L-09
--
--   1. L-09 · `public.tax_calendar_entries`: catálogo de PLATAFORMA (sin tenant) con la PA
--      SNAT/2025/000091 (G.O. 43.273, reimpresa por error material en la G.O. 43.283 del
--      23-12-2025), por obligación, período y TERMINAL del RIF, cada fecha con su norma, su gaceta
--      y la fuente secundaria de la que se transcribió. Las celdas ⚠ de CALENDARIO_SPE_2026.md
--      quedan `pending_review` y NINGUNA función las ofrece (`platform.tax_due_date` devuelve su
--      fecha en NULL). Lo que el documento no trae (retenciones de ISLR, tabla mensual de
--      naturaleza dudosa) NO se siembra (R2).
--   2. L-04 · `platform.fiscal_fortnight(día)`: la quincena 1–15 / 16–último de un día civil. La
--      usa la declaración del especial y la EXPONE para el IGTF (L-15). Granularidad: `date` →
--      `date`; quien llama pasa el día de Caracas (CLAUDE.md, «una fecha comparada contra un
--      punto de reloj»).
--      `platform.iva_period_proposal(empresa, hoy)`: el período que la pantalla propone según el
--      tipo vigente — la última quincena cerrada para el especial, el último mes cerrado para el
--      ordinario — con su vencimiento si la celda está ofrecida.
--   3. L-05 · Dos arrastres, como en la Forma 00030: `excedente_siguiente` es ya SOLO el excedente
--      de CRÉDITO FISCAL, y las retenciones soportadas no absorbidas por la cuota viajan aparte en
--      `retenciones_acumuladas_por_descontar`. `recompute_iva_period` recibe el arrastre de
--      retenciones del período anterior (`p_retenciones_anteriores`, por omisión 0: las llamadas
--      de cuatro argumentos siguen resolviendo) y lo devuelve en una columna nueva. Cambia el tipo
--      de retorno: drop + create, con sus GRANT.
--
-- Definición VIVA de partida para `recompute_iva_period`: 20260928130200 (la última en el orden
-- limpio), copiada entera. Lo único que cambia es la cola: `calc` → `neto`, y la cuota y los dos
-- arrastres salen de ahí. Débitos, créditos (fecha contable, K-04), ajuste (R-2 ampliada), prorrata
-- y desglose por alícuota quedan IGUAL.
--
-- Reversible: SÍ, con datos vivos, con estas condiciones:
--   · `tax_calendar_entries` se retira con drop table: nadie la referencia por FK. Las tres
--     funciones nuevas, con drop function.
--   · `recompute_iva_period`: volver a la 130200 (drop de la de cinco argumentos + create con el
--     texto de la 130200 + sus GRANT) devuelve la cifra MEZCLADA. Las filas generadas con
--     `iva-declarations/1.1.0` NO se reescriben (insert-only): su `excedente_siguiente` es solo
--     crédito y sus retenciones están en la columna nueva. Por eso las dos columnas de
--     `iva_period_results` NO se pueden quitar con historia: se quedarían sin dueño las
--     retenciones de las filas 1.1.0. Revertir = dejar las columnas y volver al generador viejo.
-- HOMOLOGATION_IMPACT: YES — cambia el resultado de la planilla demostrativa (el arrastre se
--   separa) y la periodicidad que se admite al especial y al ordinario. No toca numeración,
--   control ni formato de documento.
-- =============================================================================

-- ── 1. El terminal del RIF ───────────────────────────────────────────────────
create function platform.rif_terminal(p_tax_id text)
returns smallint
language sql
immutable
set search_path = ''
as $$
  -- El ÚLTIMO dígito del RIF (el verificador), que es el que usa la PA para repartir los días.
  -- Un RIF provisional (`PEND-…`) o que no termina en dígito no tiene terminal: NULL, nunca 0.
  select case
           when upper(btrim(p_tax_id)) like 'PEND-%' then null
           when right(btrim(p_tax_id), 1) ~ '^[0-9]$' then right(btrim(p_tax_id), 1)::smallint
         end;
$$;
comment on function platform.rif_terminal(text) is
  'Terminal del RIF (último dígito) con el que la PA SNAT/2025/000091 reparte los vencimientos. '
  'NULL si el RIF es provisional o no termina en dígito (L-09).';
revoke execute on function platform.rif_terminal(text) from public;
grant execute on function platform.rif_terminal(text) to authenticated, ladino_api;

-- ── 2. El calendario, como dato de plataforma ────────────────────────────────
create table public.tax_calendar_entries (
  id               uuid        primary key default platform.uuidv7(),
  -- iva: declaración de IVA del SPE · ret_iva: retenciones de IVA practicadas (agente)
  -- igtf: IGTF percibido · islr_anticipo: anticipos de ISLR · islr_definitiva: declaración anual
  -- islr_retenciones: retenciones de ISLR (admitida, SIN filas: no hay fuente textual).
  obligation       text        not null,
  period_from      date        not null,
  period_to        date        not null,
  rif_terminal     smallint    not null,
  due_date         date        not null,
  legal_norm       text        not null,
  gazette          text        not null,
  -- De dónde se TRANSCRIBIÓ la fecha (la Gaceta no se tuvo delante: R2).
  secondary_source text        not null,
  -- secondary_source: transcrita de una fuente secundaria y sin señal de error → se ofrece.
  -- pending_review: celda ⚠ de CALENDARIO_SPE_2026.md → NO se ofrece hasta cotejarla.
  review_status    text        not null,
  review_note      text,
  created_at       timestamptz not null default now(),
  constraint tax_calendar_entries_obligation_chk check (obligation in
    ('iva', 'ret_iva', 'igtf', 'islr_anticipo', 'islr_definitiva', 'islr_retenciones')),
  constraint tax_calendar_entries_terminal_chk check (rif_terminal between 0 and 9),
  constraint tax_calendar_entries_period_chk check (period_from <= period_to),
  -- Nadie presenta una declaración antes de que termine su período. Este CHECK es también el que
  -- fija la lectura de la tabla 1.2 (ver la siembra): leída al revés, sus días caerían DENTRO de
  -- la quincena que declaran y la migración fallaría.
  constraint tax_calendar_entries_due_chk check (due_date > period_to),
  constraint tax_calendar_entries_status_chk
    check (review_status in ('secondary_source', 'pending_review')),
  constraint tax_calendar_entries_pending_note_chk
    check (review_status <> 'pending_review' or length(btrim(coalesce(review_note, ''))) > 0),
  constraint tax_calendar_entries_source_chk check (length(btrim(legal_norm)) > 0
    and length(btrim(gazette)) > 0 and length(btrim(secondary_source)) > 0),
  constraint tax_calendar_entries_key
    unique (obligation, period_from, period_to, rif_terminal)
);
comment on table public.tax_calendar_entries is
  'Catálogo de PLATAFORMA (sin tenant): vencimientos de la providencia anual de SPE por '
  'obligación, período y terminal del RIF, cada uno con norma, gaceta y fuente (ADR-0072 §8, '
  'enmienda de ADR-0052). Las filas pending_review no las ofrece ninguna función. Se corrige '
  'con una migración nueva, nunca desde la API.';
comment on column public.tax_calendar_entries.review_status is
  'secondary_source = transcrita de fuente secundaria, se ofrece con su fuente; pending_review = '
  'celda ⚠ pendiente de cotejo con la Gaceta, NO se ofrece (platform.tax_due_date la devuelve '
  'en NULL).';

alter table public.tax_calendar_entries enable row level security;
alter table public.tax_calendar_entries force  row level security;
create policy tax_calendar_entries_select on public.tax_calendar_entries for select
  to authenticated, ladino_api using (true);
create policy tax_calendar_entries_insert on public.tax_calendar_entries for insert
  to authenticated, ladino_api with check (false);
create policy tax_calendar_entries_update on public.tax_calendar_entries for update
  to authenticated, ladino_api using (false);
create policy tax_calendar_entries_delete on public.tax_calendar_entries for delete
  to authenticated, ladino_api using (false);
revoke all on public.tax_calendar_entries from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.tax_calendar_entries to authenticated, ladino_api;

-- ── 2.1 La siembra (CALENDARIO_SPE_2026.md, transcrita de Nayma Consultores) ──
-- Tabla 1 del documento: IVA, retenciones de IVA, IGTF y anticipos de ISLR, quincenales
-- (respuesta del dueño §1: las cuatro obligaciones comparten los días). Cada arreglo es la fila
-- de un terminal, de enero a diciembre.
with q1 (terminal, dias) as (values
  (0, array[28,20,25,23,20,29,27,31,29,20,27,16]),
  (1, array[19,23,20,27,18,26,21,25,18,28,26,29]),
  (2, array[21,18,24,21,29,16,30,24,24,29,17,21]),
  (3, array[30,18,23,30,22,18,23,18,21,23,23,28]),
  (4, array[23,25,26,20,21,19,28,19,30,22,20,22]),
  (5, array[22,27,30,22,28,17,22,21,25,30,18,17]),
  (6, array[20,19,27,24,19,30,20,28,28,21,25,18]),
  (7, array[27,24,18,17,26,22,31,20,22,27,19,18]),
  (8, array[26,26,31,29,27,23,17,26,17,26,24,30]),
  (9, array[29,27,17,28,25,25,29,27,23,19,30,23])
),
-- Tabla 1.2: el día de presentación de la quincena del 16 al último. La columna es el MES DE
-- PRESENTACIÓN y declara la 2.ª quincena del mes ANTERIOR: es la única lectura posible, porque
-- todos sus días caen entre el 1 y el 16 y una quincena 16–último no puede presentarse antes de
-- terminar (lo hace cumplir tax_calendar_entries_due_chk). La columna «Ene» es, pues, la 2.ª
-- quincena de diciembre de 2025; la 2.ª de diciembre de 2026 es del calendario de 2027.
q2 (terminal, dias) as (values
  (0, array[15,09,06,01,06,12,08,14,14,05,13,03]),
  (1, array[06,10,03,14,04,11,03,13,03,14,12,15]),
  (2, array[08,05,09,08,14,03,14,12,10,15,02,04]),
  (3, array[16,12,04,16,07,10,07,05,02,07,09,11]),
  (4, array[09,02,11,07,13,02,10,06,09,06,05,07]),
  (5, array[05,13,12,09,15,08,06,03,15,08,04,10]),
  (6, array[13,04,10,13,05,15,09,04,11,02,11,08]),
  (7, array[12,11,02,06,11,04,15,10,04,13,03,02]),
  (8, array[07,03,13,10,12,05,02,07,08,09,06,09]),
  (9, array[14,06,05,15,08,09,13,11,07,01,10,14])
),
celdas as (
  select 1 as tabla, q.terminal, m, q.dias[m] as dia,
         make_date(2026, m, 1) as desde, make_date(2026, m, 15) as hasta
    from q1 q, generate_series(1, 12) m
  union all
  select 2, q.terminal, m, q.dias[m],
         (make_date(2026, m, 1) - interval '1 month')::date + 15,
         make_date(2026, m, 1) - 1
    from q2 q, generate_series(1, 12) m
),
-- Las celdas ⚠ del documento (§5, discrepancias 2 y 3).
dudosas (tabla, terminal, m, nota) as (values
  (1, 2, 2,  'Febrero, terminales 2 y 3 caen el mismo día 18 en la fuente: posible error de transcripción (CALENDARIO_SPE_2026.md §5.2).'),
  (1, 3, 2,  'Febrero, terminales 2 y 3 caen el mismo día 18 en la fuente: posible error de transcripción (CALENDARIO_SPE_2026.md §5.2).'),
  (1, 6, 12, 'Diciembre, terminales 6 y 7 caen el mismo día 18 en la fuente: posible error de transcripción (CALENDARIO_SPE_2026.md §5.2).'),
  (1, 7, 12, 'Diciembre, terminales 6 y 7 caen el mismo día 18 en la fuente: posible error de transcripción (CALENDARIO_SPE_2026.md §5.2).'),
  (2, 3, 1,  'Terminal 3 cae el día 16 en la tabla de segunda quincena (enero): fuera del patrón 1–15 (CALENDARIO_SPE_2026.md §5.3).'),
  (2, 3, 4,  'Terminal 3 cae el día 16 en la tabla de segunda quincena (abril): fuera del patrón 1–15 (CALENDARIO_SPE_2026.md §5.3).')
)
insert into public.tax_calendar_entries
  (obligation, period_from, period_to, rif_terminal, due_date, legal_norm, gazette,
   secondary_source, review_status, review_note)
select o.obligation, c.desde, c.hasta, c.terminal, make_date(2026, c.m, c.dia),
       'PA SNAT/2025/000091',
       'G.O. 43.273 (02-12-2025), reimpresa por error material en la G.O. 43.283 (23-12-2025)',
       'Nayma Consultores, «Calendario SENIAT 2026», https://naymaconsultores.com/calendario-seniat-2026/ (verificada el 2026-09-28)',
       case when d.nota is null then 'secondary_source' else 'pending_review' end,
       d.nota
  from celdas c
  cross join (values ('iva'), ('ret_iva'), ('igtf'), ('islr_anticipo')) as o (obligation)
  left join dudosas d on d.tabla = c.tabla and d.terminal = c.terminal and d.m = c.m;

-- Tabla 3: declaración definitiva de ISLR del ejercicio 2025 (ejercicio que cierra el 31-12-2025).
insert into public.tax_calendar_entries
  (obligation, period_from, period_to, rif_terminal, due_date, legal_norm, gazette,
   secondary_source, review_status, review_note)
select 'islr_definitiva', date '2025-01-01', date '2025-12-31', t.terminal, t.vence,
       'PA SNAT/2025/000091',
       'G.O. 43.273 (02-12-2025), reimpresa por error material en la G.O. 43.283 (23-12-2025)',
       'Nayma Consultores, «Calendario SENIAT 2026», https://naymaconsultores.com/calendario-seniat-2026/ (verificada el 2026-09-28)',
       'secondary_source', null
  from (values (2, date '2026-01-30'), (3, date '2026-01-30'),
               (5, date '2026-02-27'), (9, date '2026-02-27'),
               (0, date '2026-03-06'), (8, date '2026-03-06'),
               (1, date '2026-03-11'), (4, date '2026-03-11'),
               (6, date '2026-03-16'), (7, date '2026-03-16')) as t (terminal, vence);

-- La siembra se comprueba a sí misma: si el conteo no es el esperado, la migración falla.
do $$
declare n_total int; n_pend int;
begin
  select count(*), count(*) filter (where review_status = 'pending_review')
    into n_total, n_pend from public.tax_calendar_entries;
  -- 2 tablas × 10 terminales × 12 meses × 4 obligaciones + 10 de la definitiva.
  if n_total <> 970 or n_pend <> 24 then
    raise exception 'siembra del calendario 2026 inesperada: % filas (esperaba 970), % pendientes (esperaba 24)',
      n_total, n_pend;
  end if;
end $$;

-- ── 3. La quincena ───────────────────────────────────────────────────────────
create function platform.fiscal_fortnight(p_day date)
returns table (period_from date, period_to date)
language sql
immutable
set search_path = ''
as $$
  -- GRANULARIDAD: día civil (`date`) → días civiles. Nada de date_trunc: sobre un `date` resuelve
  -- a la versión timestamptz y dependería de la zona de la sesión. Quien llama pasa el día de
  -- Caracas (p. ej. platform.caracas_day(now()) o (ts at time zone 'America/Caracas')::date).
  select case when extract(day from p_day) <= 15
              then make_date(extract(year from p_day)::int, extract(month from p_day)::int, 1)
              else make_date(extract(year from p_day)::int, extract(month from p_day)::int, 16)
         end,
         case when extract(day from p_day) <= 15
              then make_date(extract(year from p_day)::int, extract(month from p_day)::int, 15)
              else (make_date(extract(year from p_day)::int, extract(month from p_day)::int, 1)
                    + interval '1 month')::date - 1
         end;
$$;
comment on function platform.fiscal_fortnight(date) is
  'La quincena de un día civil: del 1 al 15, o del 16 al último día del mes (PA SNAT/2025/000091). '
  'La usan la declaración del especial (L-04) y el IGTF (L-15). Recibe el día de Caracas.';
revoke execute on function platform.fiscal_fortnight(date) from public;
grant execute on function platform.fiscal_fortnight(date) to authenticated, ladino_api;

-- ── 4. El vencimiento de la empresa ──────────────────────────────────────────
create function platform.tax_due_date(p_company uuid, p_obligation text, p_from date, p_to date)
returns table (due_date date, review_status text, rif_terminal smallint, legal_source text)
language sql
stable
set search_path = ''
as $$
  -- Solo para el SPE vigente al cierre del período: la providencia es de los especiales. Una celda
  -- pending_review sale con la fecha en NULL — se sabe que existe, no se ofrece (ADR-0072 §8).
  select case when e.review_status = 'secondary_source' then e.due_date end,
         e.review_status, e.rif_terminal,
         e.legal_norm || ', ' || e.gazette || '. Transcrita de: ' || e.secondary_source
    from public.companies c
    join public.tax_calendar_entries e
      on e.rif_terminal = platform.rif_terminal(c.tax_id)
     and e.obligation = p_obligation
     and e.period_from = p_from and e.period_to = p_to
   where c.id = p_company
     and platform.taxpayer_type_at(p_company, p_to) = 'especial';
$$;
comment on function platform.tax_due_date(uuid, text, date, date) is
  'Vencimiento de una obligación del SPE para un período, por el terminal del RIF de la empresa. '
  'Sin fila si la empresa no es especial al cierre del período, no tiene terminal o el período no '
  'está sembrado; due_date NULL si la celda está pendiente de cotejo.';
revoke execute on function platform.tax_due_date(uuid, text, date, date) from public;
grant execute on function platform.tax_due_date(uuid, text, date, date) to ladino_api;

-- ── 5. La propuesta de período ───────────────────────────────────────────────
create function platform.iva_period_proposal(p_company uuid, p_today date)
returns table (taxpayer_type text, periodicity text, period_from date, period_to date,
               due_date date, due_date_status text, legal_source text)
language sql
stable
set search_path = ''
as $$
  -- El ÚLTIMO período cerrado antes de `p_today` (día de Caracas, lo pasa quien llama). El tipo
  -- es el vigente el día anterior a la quincena en curso: el último día que puede estar cerrado.
  with hoy as (
    select f.period_from as quincena_en_curso,
           make_date(extract(year from p_today)::int, extract(month from p_today)::int, 1)
             as mes_en_curso
      from platform.fiscal_fortnight(p_today) f
  ),
  tipo as (
    select platform.taxpayer_type_at(p_company, h.quincena_en_curso - 1) as tipo, h.*
      from hoy h
  ),
  periodo as (
    select t.tipo,
           case t.tipo when 'especial' then 'quincenal' when 'ordinario' then 'mensual' end
             as periodicidad,
           case when t.tipo = 'especial'
                then (select f.period_from from platform.fiscal_fortnight(t.quincena_en_curso - 1) f)
                else (t.mes_en_curso - interval '1 month')::date end as desde,
           case when t.tipo = 'especial' then t.quincena_en_curso - 1
                else t.mes_en_curso - 1 end as hasta
      from tipo t
  )
  select p.tipo, p.periodicidad, p.desde, p.hasta, d.due_date, d.review_status, d.legal_source
    from periodo p
    left join lateral platform.tax_due_date(p_company, 'iva', p.desde, p.hasta) d on true;
$$;
comment on function platform.iva_period_proposal(uuid, date) is
  'El período de IVA que la pantalla propone (L-04): la última quincena cerrada si la empresa es '
  'especial, el último mes cerrado si es ordinaria (periodicity NULL si no tiene tipo), con el '
  'vencimiento por terminal cuando la celda está ofrecida. Recibe el día de Caracas.';
revoke execute on function platform.iva_period_proposal(uuid, date) from public;
grant execute on function platform.iva_period_proposal(uuid, date) to ladino_api;

-- ── 6. Dos arrastres en la fila persistida ───────────────────────────────────
alter table public.iva_period_results
  add column retenciones_acumuladas_anteriores   numeric(24,8) not null default 0,
  add column retenciones_acumuladas_por_descontar numeric(24,8) not null default 0;
alter table public.iva_period_results add constraint ipr_retenciones_arrastre_chk check (
  retenciones_acumuladas_anteriores >= 0 and retenciones_acumuladas_por_descontar >= 0
  -- Si sobran retenciones es que la cuota quedó en cero: las dos cosas no conviven.
  and (cuota_a_pagar = 0 or retenciones_acumuladas_por_descontar = 0));
comment on column public.iva_period_results.excedente_siguiente is
  'Desde iva-declarations/1.1.0 (L-05): SOLO el excedente de CRÉDITO FISCAL que pasa al período '
  'siguiente. En las filas 1.0.0 es el arrastre COMBINADO de entonces (crédito + retenciones no '
  'absorbidas): esas filas no se reescriben; el dominio exige regenerarlas antes de encadenar.';
comment on column public.iva_period_results.retenciones_acumuladas_anteriores is
  'Retenciones soportadas acumuladas por descontar que llegan del período anterior (L-05, Forma '
  '00030). Encadenadas desde retenciones_acumuladas_por_descontar de la última generación del '
  'período contiguo.';
comment on column public.iva_period_results.retenciones_acumuladas_por_descontar is
  'Retenciones soportadas (anteriores + del período) que la cuota tributaria no absorbió y pasan '
  'al período siguiente APARTE del excedente de crédito fiscal (L-05; PA SNAT/2025/000054 arts. 7 '
  'y 8, VALIDAR-TRIBUTARIO P-37).';

-- ── 7. El cálculo, con los dos arrastres ─────────────────────────────────────
drop function platform.recompute_iva_period(uuid, date, date, numeric);
create function platform.recompute_iva_period(p_company uuid, p_from date, p_to date,
                                              p_excedente_anterior numeric,
                                              p_retenciones_anteriores numeric default 0)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric, retenciones_acumuladas_por_descontar numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with ventas as (
    -- TODO en moneda funcional: la base es el subtotal funcional del renglón y el
    -- impuesto es total − subtotal funcionales, la misma derivación con la que el
    -- documento congela su IVA y el mayor lo asienta (sales.ts, insertarDocumento).
    -- `tax_amount` del renglón está en la moneda de la TRANSACCIÓN: sumarlo
    -- declaraba dólares como bolívares (QA 2026-09-15, h. 63).
    select case d.kind when 'credit_note' then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.line_subtotal_functional as base,
           (l.line_total_functional - l.line_subtotal_functional) as impuesto,
           l.tax_amount as impuesto_transaccion,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid')
       and (d.issued_at at time zone 'America/Caracas')::date between p_from and p_to
  ),
  por_alicuota as (
    select alicuota,
           sum(signo * base) as base,
           sum(signo * impuesto) as impuesto
      from ventas group by alicuota
  ),
  deb as (select coalesce(sum(impuesto), 0) as total from por_alicuota),
  bases_venta as (
    select coalesce(sum(signo * base) filter (where impuesto_transaccion <> 0), 0) as gravadas,
           coalesce(sum(signo * base) filter (where impuesto_transaccion = 0), 0) as sin_impuesto
      from ventas
  ),
  cred as (
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó, MENOS el de las NOTAS
    -- DE CRÉDITO recibidas en el período. LIVA art. 37: el impuesto de la operación
    -- posteriormente anulada se deduce del crédito fiscal; art. 56: se registran las notas que
    -- se emitan o RECIBAN. El período es el de la NOTA, no el de la factura que corrige.
    -- La anulada DESPUÉS de cerrar y presentar su período sigue contando en él: esa planilla
    -- no cambia (R-2 ampliada); su reversa va en `ajuste` del período de la anulación.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, 8))
                       from public.supplier_invoices i
                      where i.company_id = p_company
                        and (i.status in ('posted', 'paid')
                             or (i.status = 'annulled'
                                 and platform.supplier_invoice_late_annulment_day(
                                       i.company_id, coalesce(i.accounting_date, i.invoice_date),
                                       i.annulled_at) is not null))
                        and i.tax_is_recoverable
                        -- ADR-0069 §4: la recibida con retraso, en su período de REGISTRO.
                        -- Sin ventana de LIVA art. 33 (P-35, pendiente de fuente).
                        and coalesce(i.accounting_date, i.invoice_date)
                              between p_from and p_to), 0)
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, 8))
                       from public.supplier_credit_notes n
                       join public.supplier_invoices i on i.id = n.supplier_invoice_id
                      where n.company_id = p_company
                        and n.status = 'posted'
                        and i.tax_is_recoverable
                        and coalesce(n.accounting_date, n.note_date)
                              between p_from and p_to), 0) as total
  ),
  ajuste as (
    -- Casilla de AJUSTES A LOS CRÉDITOS FISCALES DE PERÍODOS ANTERIORES: la reversa del crédito
    -- de las facturas anuladas tarde, en el período (día de Caracas) de la anulación.
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, 8)), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status = 'annulled'
       and i.tax_is_recoverable
       and platform.supplier_invoice_late_annulment_day(
             i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           between p_from and p_to
  ),
  ret as (
    -- L-04: la retención soportada, en el período (quincena o mes) de la FECHA DEL COMPROBANTE.
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and r.retained_on between p_from and p_to
  ),
  prorrata as (
    -- GLOBAL v1 (H-11, VALIDAR-TRIBUTARIO): solo cuando hubo ventas sin
    -- impuesto en el período; pct = gravadas / (gravadas + sin impuesto).
    select case
             when b.sin_impuesto > 0 and (b.gravadas + b.sin_impuesto) > 0
               then round(b.gravadas / (b.gravadas + b.sin_impuesto), 8)
             else null
           end as pct
      from bases_venta b
  ),
  calc as (
    -- El ajuste NO pasa por la prorrata del período en curso: corrige un crédito que ya se
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46). Y NO se suma en
    -- `deducibles`: esa columna es el crédito del PERÍODO tras la prorrata, que nunca es
    -- negativo (CHECK ipr_amounts_chk). El ajuste va en su casilla y entra en la cuota.
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
  ),
  neto as (
    -- L-05 · LOS DOS ARRASTRES DE LA FORMA 00030. Primero el impuesto: débitos − créditos
    -- (con su ajuste) − excedente de CRÉDITO anterior. Si es negativo, ESE es el excedente de
    -- crédito fiscal que pasa. Después las retenciones (las acumuladas que llegan + las del
    -- período) se descuentan SOLO de la cuota positiva; lo que no absorbe pasa aparte, como
    -- retenciones acumuladas por descontar. Una retención nunca se convierte en crédito fiscal
    -- (PA SNAT/2025/000054 arts. 7 y 8; VALIDAR-TRIBUTARIO P-37).
    select calc.*,
           calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior as impuesto,
           p_retenciones_anteriores + calc.retenciones as retenciones_disponibles
      from calc
  )
  select
    n.debitos, n.creditos, n.deducibles, n.pct, n.retenciones,
    greatest(0, greatest(0, n.impuesto) - n.retenciones_disponibles) as cuota_a_pagar,
    greatest(0, -n.impuesto) as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle,
    n.ajuste,
    greatest(0, n.retenciones_disponibles - greatest(0, n.impuesto))
      as retenciones_acumuladas_por_descontar
  from neto n
$function$;

comment on function platform.recompute_iva_period(uuid, date, date, numeric, numeric) is
  'La planilla del período en BOLÍVARES con las NOTAS DE CRÉDITO recibidas restadas del crédito '
  'fiscal (LIVA arts. 37 y 56), la casilla de AJUSTES DE CRÉDITOS DE PERÍODOS ANTERIORES (R-2 '
  'ampliada, P-46) y, desde 20261002120000 (L-05), DOS arrastres: excedente_siguiente es solo el '
  'excedente de crédito fiscal y retenciones_acumuladas_por_descontar lleva aparte las retenciones '
  'que la cuota no absorbió. El período (quincena o mes) lo valida el dominio (L-04). Prorrata '
  'global v1 (P-25).';
revoke execute on function platform.recompute_iva_period(uuid, date, date, numeric, numeric)
  from public;
grant execute on function platform.recompute_iva_period(uuid, date, date, numeric, numeric)
  to ladino_api;
