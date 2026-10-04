-- =============================================================================
-- Ladino — 20261003110200 · EL FALTANTE DE UN CONTEO LLEVA SU EVIDENCIA (ADR-0078, re-revisión B1)
--
-- Módulo: inventario · contabilidad (RIGOR MÁXIMO)
-- Spec: ADR-0078 (nota de aplicación, re-revisión) · corrige 20261003110100 §2 y §3
-- HOMOLOGATION_IMPACT: NO — no cambia documentos fiscales, numeración, libros ni importes; añade
--   un requisito de soporte a un hecho interno de inventario.
--
-- QUÉ PASABA:
--   20261003110100 §3 mandó el faltante de un CONTEO a «Pérdidas por mermas y faltantes» (5.1.08,
--   hecho `inventory_move/stock.counted`), y §2 exigió evidencia a la salida por merma, rotura,
--   vencido o faltante («faltantes justificados solo si llevan motivo y evidencia», RLIVA art. 14,
--   RESPUESTA §2.13). Pero el conteo escribe un movimiento `ajuste` sin `exit_reason`, y el CHECK
--   de la evidencia solo miraba `exit_reason`: el conteo era una puerta lateral a 5.1.08 sin soporte.
--
-- QUÉ HACE:
--   1. `inventory_moves_exit_evidence_chk` se sustituye (misma columna, mismo NOT VALID): la
--      evidencia cabe también en un `ajuste` que BAJA existencia. Y cierra un hueco del CHECK de
--      110100: con `exit_reason` nulo, `exit_reason in (…)` daba NULL y el CHECK dejaba pasar una
--      evidencia en cualquier movimiento; ahora la comparación va con `coalesce(…, false)`.
--   2. La regla de FAMILIA, en la base: ningún hecho `inventory_move/stock.counted` —asiento o fila
--      de la cola— nace para un movimiento que baja existencia sin `exit_evidence`. La marca de
--      «esto fue un conteo» es el hecho contable (es lo que lo lleva a 5.1.08), no un texto del
--      motivo. Trigger BEFORE INSERT en `journal_entries` y en `journal_generation_queue`: valida,
--      no escribe, y no toca las dos capas del append-only.
--   3. El corte va en el ENUNCIADO (`platform.invariant_cutoffs`, como `retention_voucher_gaps`):
--      la regla vale para los movimientos creados desde esta migración. Los faltantes de conteo
--      anteriores (solo en bases locales: 110100 no se ha desplegado) no tienen evidencia e
--      `inventory_moves` es append-only: no se reescriben, y su asiento se puede revertir.
--
-- Decidido por criterio (ADR-0078, re-revisión). Alternativa: no exigirla y preguntar al asesor
-- si el faltante de conteo sin soporte puede ir a 5.1.08.
--
-- No lee nada que cree una migración posterior. Funciones que redefine: ninguna (crea
-- `platform.count_shortage_needs_evidence`, nueva).
--
-- REVERSIBILIDAD (con datos vivos): SÍ, con una migración nueva.
--   · los dos triggers y su función: drop. Los movimientos escritos con evidencia la conservan;
--   · el CHECK: drop + add con la definición de 110100 §2 SOLO si ningún `ajuste` lleva evidencia;
--     con conteos ya registrados con evidencia, la definición vieja no valida las filas nuevas
--     (habría que añadirla NOT VALID otra vez y aceptar que esas filas la incumplen);
--   · la fila de `invariant_cutoffs`: se borra con los triggers.
-- =============================================================================

-- ── 1. La evidencia cabe en el ajuste que baja existencia ───────────────────
alter table public.inventory_moves drop constraint inventory_moves_exit_evidence_chk;
alter table public.inventory_moves add constraint inventory_moves_exit_evidence_chk
  check ((exit_evidence is null
          or (exit_evidence = btrim(exit_evidence) and length(exit_evidence) between 3 and 500
              and (coalesce(exit_reason in ('merma', 'rotura', 'vencido', 'faltante'), false)
                   or (kind = 'ajuste' and quantity < 0))))
         and (exit_reason is null
              or exit_reason not in ('merma', 'rotura', 'vencido', 'faltante')
              or exit_evidence is not null))
  not valid;
comment on column public.inventory_moves.exit_evidence is
  'Referencia del soporte de una pérdida (acta, foto, informe): sin ella la merma, la rotura, el '
  'vencido o el faltante —también el faltante de un CONTEO, que es un ajuste negativo— no es '
  '«faltante justificado» (RLIVA art. 14, ADR-0078). NOT VALID: las salidas anteriores a '
  '20261003110100 no la tienen.';

-- ── 2. El corte, en el enunciado ────────────────────────────────────────────
insert into platform.invariant_cutoffs (invariant, reason)
select 'count_shortage_evidence',
       'Antes de 20261003110200 el faltante de un conteo se registraba sin evidencia; esos '
       'movimientos son append-only y no se reescriben.'
 where not exists (select 1 from platform.invariant_cutoffs c
                    where c.invariant = 'count_shortage_evidence');

-- ── 3. La regla: hecho de conteo que baja existencia ⇒ evidencia ────────────
create function platform.count_shortage_needs_evidence()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_mov record;
begin
  -- Definer: el hecho lo puede escribir un rol sin lectura del kardex (el worker al vaciar la
  -- cola). Lee UNA fila, la del movimiento del propio hecho, y solo si es de la misma empresa.
  select m.quantity, m.exit_evidence, m.created_at into v_mov
    from public.inventory_moves m
   where m.id = new.source_id and m.company_id = new.company_id;
  if found
     and v_mov.quantity < 0
     and v_mov.exit_evidence is null
     and v_mov.created_at >= (select c.since from platform.invariant_cutoffs c
                               where c.invariant = 'count_shortage_evidence') then
    raise exception
      'el faltante de un conteo va a pérdidas y necesita su evidencia (RLIVA art. 14): el movimiento % no la tiene',
      new.source_id
      using errcode = '23514', constraint = 'count_shortage_needs_evidence';
  end if;
  return new;
end;
$$;
comment on function platform.count_shortage_needs_evidence() is
  'Regla de familia (ADR-0078, 20261003110200): ningún hecho inventory_move/stock.counted —asiento '
  'o fila de la cola— nace para un movimiento que baja existencia sin exit_evidence, desde el corte '
  'de platform.invariant_cutoffs. Quitarlo reabre la puerta del conteo a 5.1.08 sin soporte.';
revoke execute on function platform.count_shortage_needs_evidence()
  from public, anon, authenticated;

create trigger journal_entries_02b_count_evidence
  before insert on public.journal_entries
  for each row
  when (new.source_kind = 'inventory_move' and new.source_event = 'stock.counted')
  execute function platform.count_shortage_needs_evidence();

create trigger journal_generation_queue_02_count_evidence
  before insert on public.journal_generation_queue
  for each row
  when (new.source_kind = 'inventory_move' and new.source_event = 'stock.counted')
  execute function platform.count_shortage_needs_evidence();
