-- =============================================================================
-- Ladino — migración 66 · LA TASA DEL BCV ES LA ÚNICA TASA (ADR-0064 §1)
--
-- El dueño, 2026-09-16: «no existen tasas propias, solo la del BCV» y «ya no
-- permitas escribir ninguna tasa a mano. solo la del BCV».
-- Convenio Cambiario N° 1 (G.O. Ext. 6.405, 07/09/2018), art. 9, Parágrafo
-- Primero: el tipo de cambio que publica el BCV «será el de referencia de
-- mercado a todos los efectos». LIVA art. 25 (G.O. Ext. 6.507): el tipo de
-- cambio corriente del día del hecho imponible.
--
-- Hasta hoy (ADR-0057) cada empresa podía teclear su tasa, y a igual día la suya
-- le ganaba a la oficial: una factura salió a 900 el mismo día en que el BCV
-- publicaba 842,2067 (QA de pantalla 2026-09-15, h. 70).
--
-- Ahora:
--   1. `rate_for` lee SOLO la tasa oficial (la de la plataforma, `company_id is
--      null`): la del día más reciente que no sea posterior a la fecha. Un día
--      sin publicación usa la última publicada, como hace el BCV en fin de
--      semana. `p_company` se conserva en la firma: todos los llamantes la usan.
--   2. Nadie escribe una tasa de empresa: la política de inserción de la API
--      solo admite la fila oficial, y solo al actor de sistema. La de usuario ya
--      lo negaba todo (migración 21). La API rechaza además la carga manual y
--      «sigue igual» con su propio mensaje (RATE_ONLY_FROM_BCV).
--   3. Nada se borra (R8): las tasas tecleadas que ya existen quedan como
--      historia y ninguna conversión las vuelve a leer. Los documentos que las
--      usaron conservan su tasa y su fuente congeladas.
--
-- Reversibilidad: total. Restaurar `rate_for` y la política de la migración 52.
-- HOMOLOGATION_IMPACT = YES en contenido (qué tasa convierte un documento
-- fiscal); la forma no cambia.
-- =============================================================================

-- ── 1. La tasa vigente: solo la oficial ─────────────────────────────────────
create or replace function platform.rate_for(
  p_company uuid, p_from text, p_to text, p_fecha date, p_source text default null)
returns table (rate numeric, source text, rate_date date, rate_timestamp timestamptz)
language sql
stable
set search_path = ''
as $$
  select r.rate, r.source, r.rate_date, r.rate_timestamp
    from public.exchange_rates r
   where r.from_currency = p_from and r.to_currency = p_to
     and r.rate_date <= p_fecha
     -- Solo existe la tasa del BCV (ADR-0064 §1). Las tecleadas antes de la migración 66
     -- son historia: ninguna conversión las lee.
     and r.company_id is null
     and (p_source is null or r.source = p_source)
   order by r.rate_date desc, r.created_at desc
   limit 1
$$;
comment on function platform.rate_for(uuid, text, text, date, text) is
  'LA tasa vigente a la fecha: la OFICIAL del BCV (company_id nulo) del día más reciente que no '
  'sea posterior; a igual día, la más recientemente guardada. Solo existe la tasa del BCV '
  '(ADR-0064 §1, que enmienda ADR-0057): las tecleadas antes de la migración 66 no se leen. '
  'p_company se conserva por contrato con los llamantes.';

-- ── 2. Nadie escribe una tasa de empresa ────────────────────────────────────
drop policy exchange_rates_api_insert on public.exchange_rates;
create policy exchange_rates_api_insert on public.exchange_rates for insert to ladino_api
  with check (company_id is null and platform.ladino_actor_is_system());

comment on table public.exchange_rates is
  'Tasas con FUENTE y FECHA (ADR-0020). Solo existe la tasa OFICIAL del BCV (company_id nulo), '
  'y solo la escribe el actor de sistema (ADR-0064 §1). Las filas con company_id son tasas '
  'tecleadas antes de la migración 66: historia, que ninguna conversión lee.';
