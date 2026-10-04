-- ════════════════════════════════════════════════════════════════════════════
-- Ladino — NINGÚN CIERRE EN SOBREGIRO QUEDA COMO SOBRANTE: EL INVARIANTE (J-02, revisión)
--
-- Módulo: tesorería · contabilidad (RIGOR MÁXIMO: dinero)
-- Spec: RESPUESTA_RECORRIDO_2026-09-24 §3 J-02 · ADR-0062 §4 · CLAUDE.md §3 (invariantes que
--       cruzan módulos) · migraciones 20261004180000 a 20261004180200
-- HOMOLOGATION_IMPACT: NO.
--
-- POR QUÉ. La reparación de J-02 (`scripts/reparar/j-02-sobregiro-al-cierre.mjs`) miraba solo los
-- cierres con asiento posteado. Un cierre en sobregiro que la API anterior dejó EN LA COLA se
-- asentaba, al importar pendientes, con el origen `cash_closing` y el importe entero como
-- ingreso: el defecto otra vez, después de que la reparación dijera «sin nada». Y nadie lo
-- miraba: ningún invariante preguntaba por el origen del asiento de un cierre.
--
-- QUÉ AÑADE. `platform.overdraft_closing_gaps(company)`. Enunciado, sin corte y sin lista:
--
--   un cierre de caja cuyo saldo esperado es NEGATIVO —menor que cero en las unidades mínimas de
--   la moneda de su caja— no tiene ningún asiento VIGENTE (posteado) de origen `cash_closing`
--   ni ninguna fila PENDIENTE de la cola con ese origen.
--
-- «Negativo» se mide como lo mide el dominio (`hechoContableDelCierre`): redondeado a las unidades
-- mínimas de la caja. Un saldo de −0,004 no es un sobregiro. Sin corte: lo anterior lo lleva a
-- cero la reparación, que corre en el post-pull (R-71, paso 8) y que comprueba este invariante
-- antes de dar por reparada una empresa.
--
-- No crea tablas ni toca datos. Solo lee. EXPAND: se puede aplicar antes del git pull; hasta que
-- corra la reparación, el invariante dice la verdad (en rojo donde haya cierres viejos).
-- Reversible: SÍ (`drop function`), también con datos vivos.
-- ════════════════════════════════════════════════════════════════════════════

create function platform.overdraft_closing_gaps(p_company uuid)
returns table (cash_closing_id uuid, closing_date date, problem text, reference_id uuid)
language sql
stable
set search_path = ''
as $$
  with en_sobregiro as (
    select c.id, c.closing_date
      from public.cash_closings c
     where c.company_id = p_company
       and round(c.expected_amount, platform.currency_minor_units(c.transaction_currency)) < 0
  )
  select s.id, s.closing_date, 'posted_as_surplus'::text, e.id
    from en_sobregiro s
    join public.journal_entries e
      on e.company_id = p_company and e.source_id = s.id
     and e.source_kind = 'cash_closing' and e.status = 'posted'
  union all
  select s.id, s.closing_date, 'queued_as_surplus'::text, q.id
    from en_sobregiro s
    join public.journal_generation_queue q
      on q.company_id = p_company and q.source_id = s.id
     and q.source_kind = 'cash_closing' and q.status = 'pending'
$$;

comment on function platform.overdraft_closing_gaps(uuid) is
  'INVARIANTE tesorería ↔ contabilidad (J-02, ADR-0062 §4). Debe dar 0 filas, sin corte y sin '
  'lista: un cierre de caja con el saldo esperado en negativo (menor que cero en las unidades '
  'mínimas de la moneda de la caja) no tiene asiento posteado ni fila pendiente de la cola con '
  'el origen cash_closing (sobrante contra resultado); su hecho es cash_closing_overdraft '
  '(el sobregiro se le debe al dueño). Lo anterior lo corrige scripts/reparar/'
  'j-02-sobregiro-al-cierre.mjs.';

revoke execute on function platform.overdraft_closing_gaps(uuid) from public;
grant execute on function platform.overdraft_closing_gaps(uuid) to authenticated, ladino_api;
