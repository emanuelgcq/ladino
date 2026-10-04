-- Módulo: auditoría   ADR: docs/00_GOVERNANCE/adr/ADR-0079-*.md (misma entrega que 20261004120000)
-- Hallazgo: B-14 (RESPUESTA §2.15), riesgo R-81.7.
-- Reversible: SÍ en el esquema (quitar el trigger); las actas escritas quedan (append-only).
-- Homologación: NO (no cambia ningún documento ni importe).
--
-- NINGUNA TASA GLOBAL SE QUEDA SIN ACTA.
--
-- La 20261004120000 dejó el acta de la tasa oficial en manos de `guardarTasaOficial` (dominio):
-- quien insertaba una tasa global por otra vía —la API anterior al despliegue, una reparación,
-- una consola— no dejaba rastro. «Ausencia de mecanismo no es prohibición» (CLAUDE.md §2).
--
-- EXIGIR el acta (rechazar el insert sin ella) rompería a la API desplegada y a las ~50 semillas
-- de pgTAP, E2E y recorrido que insertan su tasa de prueba. Así que la base la ESCRIBE: al cierre
-- de la transacción (trigger de restricción DIFERIDO), si la tasa global insertada no tiene ya su
-- acta de captura, se deja una que dice exactamente eso — «entró sin captura declarada», con el
-- valor, la fuente que traía la fila y el rol que la escribió. El camino del dominio no cambia:
-- su acta `fx.rate.captured` (URL, hora, hash) se escribe en la misma transacción, antes del
-- cierre, y el trigger la ve y no añade nada.
--
-- EXPAND: solo añade un trigger. Compatible con la API desplegada, que a partir de aquí deja el
-- acta mínima sin saberlo.

create or replace function platform.ensure_global_rate_record()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if exists (select 1 from public.system_audit_events a
              where a.aggregate_type = 'exchange_rate' and a.aggregate_id = new.id) then
    return null;
  end if;
  insert into public.system_audit_events
    (aggregate_type, aggregate_id, event_type, occurred_at, payload)
  values ('exchange_rate', new.id, 'fx.rate.inserted_without_capture', pg_catalog.now(),
          pg_catalog.jsonb_build_object(
            'from_currency', new.from_currency,
            'to_currency', new.to_currency,
            'rate', new.rate::text,
            'rate_date', new.rate_date::text,
            'source', new.source,
            'written_by_role', session_user::text,
            'note', 'La tasa global entró sin pasar por guardarTasaOficial: no hay URL, hora de captura ni hash de la fuente.'));
  return null;
end;
$function$;

revoke all on function platform.ensure_global_rate_record() from public;

comment on function platform.ensure_global_rate_record() is
  'B-14: al cierre de la transacción, toda tasa GLOBAL insertada tiene acta en system_audit_events: la de captura del dominio (fx.rate.captured) o, si nadie la dejó, fx.rate.inserted_without_capture. Quitar este trigger devuelve la tasa sin rastro a toda vía que no sea guardarTasaOficial.';

create constraint trigger exchange_rates_zz_record
  after insert on public.exchange_rates
  deferrable initially deferred
  for each row
  when (new.company_id is null)
  execute function platform.ensure_global_rate_record();
