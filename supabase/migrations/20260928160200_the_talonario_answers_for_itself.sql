-- =============================================================================
-- Ladino — EL TALONARIO RESPONDE DE SÍ MISMO (ADR-0071, revisión de la parte 1)
-- Módulo: ventas · numeración     Hallazgos de la revisión: H1, H3, H9, H11
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — cambia qué talonarios pueden emitir y cómo se corrigen
--
-- Parte de las definiciones VIVAS de 20260928160000 (la única migración que
-- tocó assert_range_printer_frozen y documents_control_identifier) y de
-- 20260903153017 (los CHECK de serie). Una auditoría propia, no un parche:
--
--   H1  · la serie «contingencia…» era el único rasgo que sacaba un rango de
--         la exclusión. Un talonario normal llamado «Contingencia-B» pisaba el
--         tramo del talonario B sin ser de contingencia. Ahora serie
--         «contingencia…» ⇔ fila en contingency_ranges, comprobado AL COMMIT
--         (constraint trigger diferido: registerContingencyRange inserta el
--         rango y después su fila, en la misma transacción).
--   H3  · la corrección de los datos de la imprenta tiene camino propio: solo
--         con el acta `fiscal.range.printer_corrected` de ESTA transacción,
--         cuyo id viaja en el GUC `ladino.range_printer_correction`. El
--         identificador no cambia nunca si el rango ya emitió. Un rango solo se
--         anula si no emitió nada.
--   H9  · en la transición a `issued`, un control sin identificador es un
--         error (LAD49), no un «00» silencioso. El «00» por omisión se queda
--         para lo que no es la emisión (borradores e INSERT directos de SQL),
--         donde ya lo aseveran pgTAP 021 y 080.
--   H11 · la serie es opcional («serie si el papel la trae», RESPUESTA §2.1):
--         NOT NULL con '' como «sin serie». El número del documento sigue
--         siendo único por empresa, clase y serie ('' incluida).
-- =============================================================================

-- ── H11. La serie vacía es «sin serie» ──────────────────────────────────────
alter table public.fiscal_number_ranges drop constraint fiscal_number_ranges_series_chk;
alter table public.fiscal_number_ranges
  add constraint fiscal_number_ranges_series_chk
  check (series = btrim(series) and length(series) between 0 and 30);
alter table public.documents drop constraint documents_series_chk;
alter table public.documents
  add constraint documents_series_chk
  check (series = btrim(series) and length(series) between 0 and 30);
comment on constraint documents_series_chk on public.documents is
  'Serie como la trae el papel; '''' = el papel no trae serie (ADR-0071, RESPUESTA §2.1). '
  'VALIDAR-SENIAT: qué se imprime en 13.2 sin serie.';

-- ── H1. «contingencia…» ⇔ talonario de contingencia, al commit ──────────────
create function platform.assert_contingency_membership()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_nombre   boolean;
  v_miembro  boolean;
begin
  -- La fila puede haber cambiado después del evento que encoló la comprobación.
  select lower(r.series) like 'contingencia%',
         exists (select 1 from public.contingency_ranges cr where cr.fiscal_number_range_id = r.id)
    into v_nombre, v_miembro
    from public.fiscal_number_ranges r
   where r.id = new.id;
  if v_nombre is distinct from v_miembro then
    raise exception
      'LAD69: la serie «%» y el registro de contingencia no coinciden: una serie «contingencia…» es solo del talonario de contingencia (PA 102), y ese talonario solo se registra por su camino (ADR-0071)',
      new.series
      using errcode = 'LAD69';
  end if;
  return null;
end;
$$;
revoke execute on function platform.assert_contingency_membership() from public;
create constraint trigger fiscal_number_ranges_contingency_membership
  after insert or update of series on public.fiscal_number_ranges
  deferrable initially deferred
  for each row execute function platform.assert_contingency_membership();
comment on trigger fiscal_number_ranges_contingency_membership on public.fiscal_number_ranges is
  'H1 (ADR-0071): la serie «contingencia…» es lo que saca a un rango de la exclusión de '
  'solapes; sin esta comprobación, un talonario normal con ese nombre pisaba el de la caja.';

-- ── H3. Datos de la imprenta, identificador y anulación ─────────────────────
-- Definición viva: 20260928160000 §2 (assert_range_printer_frozen).
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
  -- El identificador forma parte del control impreso: si el rango ya emitió, no cambia.
  if new.printer_identifier is distinct from old.printer_identifier
     and old.next_available > old.range_from then
    raise exception
      'LAD06: el identificador de un talonario que ya emitió no cambia: está impreso en sus documentos (ADR-0071)'
      using errcode = 'LAD06';
  end if;

  -- Los datos de la imprenta de un talonario completo solo se corrigen con acta
  -- de ESTA transacción (fiscal.range.printer_corrected sobre este rango).
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
           and a.created_at >= now()  -- now() = inicio de ESTA transacción
      ) into v_con_acta;
    end if;
    if not v_con_acta then
      raise exception
        'LAD06: los datos de la imprenta de un talonario completo solo se corrigen con acta (POST /v1/fiscal-number-ranges/{id}/printer-correction, ADR-0071)'
        using errcode = 'LAD06';
    end if;
  end if;

  -- Anular es para un talonario que no emitió nada: lo emitido lleva sus controles.
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

-- ── H9. La emisión no se inventa el identificador ───────────────────────────
-- Definición viva: 20260928160000 §3 (documents_control_identifier).
create or replace function platform.documents_control_identifier()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.status = 'issued' and old.status is distinct from 'issued'
     and new.control_number is not null and new.control_identifier is null then
    raise exception
      'LAD49: el documento se emite con número de control y sin su identificador: el control es identificador + secuencial (PA 00071 art. 44, ADR-0071)'
      using errcode = 'LAD49';
  end if;
  if new.control_number is null then
    new.control_identifier := null;
  elsif new.control_identifier is null then
    new.control_identifier := '00';
  end if;
  if tg_op = 'UPDATE' and old.status in ('issued', 'paid', 'annulled')
     and new.control_identifier is distinct from old.control_identifier then
    raise exception
      'LAD06: el identificador del número de control de un documento emitido es inmutable (ADR-0071)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.documents_control_identifier() from public;

-- ── LAD52: lo que esta migración garantiza sobre sí misma ───────────────────
do $$
begin
  if not exists (select 1 from pg_trigger
                  where tgname = 'fiscal_number_ranges_contingency_membership'
                    and tgdeferrable and tginitdeferred) then
    raise exception 'LAD52: sin la comprobación diferida, «Contingencia-B» vuelve a pisar el talonario B';
  end if;
  -- Ningún rango vivo contradice la regla nueva (la comprobación es por fila y futura).
  if exists (select 1 from public.fiscal_number_ranges r
              where (lower(r.series) like 'contingencia%')
                    is distinct from
                    exists (select 1 from public.contingency_ranges cr
                             where cr.fiscal_number_range_id = r.id)) then
    raise exception 'LAD52: hay rangos «contingencia…» sin registro de contingencia (o al revés): revísalos antes de aplicar';
  end if;
end $$;

-- ── Para revertir (con datos vivos) ─────────────────────────────────────────
-- Una migración nueva: quitar el constraint trigger de contingencia; volver a
-- las definiciones de 20260928160000 de las dos funciones; y devolver los CHECK
-- de serie a `between 1 and 30` — lo último SOLO si no hay filas con serie ''
-- (un documento emitido sin serie no se toca: en ese caso el CHECK se queda).
