-- =============================================================================
-- Ladino — EL ACTA DE CORRECCIÓN ES DE ESTA TRANSACCIÓN, Y DICE LO QUE SE ESCRIBE
-- Módulo: ventas · numeración     Re-revisión de ADR-0071: A3
-- Reversible: SÍ (una función; ningún dato)
-- Homologación: NO — no cambia qué se emite; endurece cómo se corrige la imprenta.
--
-- Definición viva: 20260928160200 (assert_range_printer_frozen), la única que la
-- redefinió después de 20260928160000. Dos debilidades de aquella:
--
--   1. «el acta es de esta transacción» se comprobaba con `created_at >= now()`.
--      Un acta de OTRA transacción que empezara después de esta y confirmara antes
--      pasaba el filtro. Ahora el acta lleva `payload->>'txid'` y se compara con
--      `pg_current_xact_id()` — el identificador de la transacción de nivel
--      superior, el mismo dentro de un savepoint.
--   2. el acta no ataba QUÉ se escribía: con un acta legítima se podía escribir
--      otra cosa. Ahora `payload->'despues'` tiene que coincidir, campo a campo, con
--      la fila nueva.
--
-- El resto de la función (identificador de un rango que emitió, anulación de uno
-- que emitió) queda igual que en 160200.
-- =============================================================================

create or replace function platform.assert_range_printer_frozen()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_acta text := nullif(current_setting('ladino.range_printer_correction', true), '');
  v_con_acta boolean := false;
begin
  if new.printer_identifier is distinct from old.printer_identifier
     and old.next_available > old.range_from then
    raise exception
      'LAD06: el identificador de un talonario que ya emitió no cambia: está impreso en sus documentos (ADR-0071)'
      using errcode = 'LAD06';
  end if;

  if old.printer_data_complete
     and (new.printer_legal_name, new.printer_tax_id, new.printer_authorization,
          new.printer_authorization_date, new.printed_on, new.printer_identifier)
         is distinct from
         (old.printer_legal_name, old.printer_tax_id, old.printer_authorization,
          old.printer_authorization_date, old.printed_on, old.printer_identifier) then
    if v_acta ~ '^[0-9a-f-]{36}$' then
      select exists (
        select 1 from public.audit_events a
         where a.id = v_acta::uuid
           and a.event_type = 'fiscal.range.printer_corrected'
           and a.aggregate_id = new.id
           -- A3: el acta es de ESTA transacción (nivel superior, también en savepoint)…
           and a.payload->>'txid' = pg_catalog.pg_current_xact_id()::text
           -- …y dice exactamente lo que se escribe.
           and a.payload->'despues'->>'printer_identifier' is not distinct from new.printer_identifier
           and a.payload->'despues'->>'printer_legal_name' is not distinct from new.printer_legal_name
           and a.payload->'despues'->>'printer_tax_id' is not distinct from new.printer_tax_id
           and a.payload->'despues'->>'printer_authorization' is not distinct from new.printer_authorization
           and a.payload->'despues'->>'printer_authorization_date'
               is not distinct from new.printer_authorization_date::text
           and a.payload->'despues'->>'printed_on' is not distinct from new.printed_on::text
      ) into v_con_acta;
    end if;
    if not v_con_acta then
      raise exception
        'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)'
        using errcode = 'LAD06';
    end if;
  end if;

  if new.status = 'cancelled' and old.status <> 'cancelled'
     and old.next_available <> old.range_from then
    raise exception
      'LAD06: un talonario que ya emitió no se anula: sus controles están en documentos (ADR-0071)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.assert_range_printer_frozen() from public;
comment on function platform.assert_range_printer_frozen() is
  'ADR-0071: la imprenta de un talonario completo solo cambia con el acta '
  'fiscal.range.printer_corrected de ESTA transacción (payload.txid = pg_current_xact_id()) '
  'cuyo payload.despues coincide con la fila nueva. CONTRATO con corregirImprenta '
  '(packages/domain/src/talonario.ts) y con EVENT_CATALOG.';

-- ── Para revertir ───────────────────────────────────────────────────────────
-- Una migración nueva con la definición de 20260928160200. Sin datos que perder.
