-- Módulo: inventario · contabilidad   Spec: ADR-0083 (sección «Revisión», cuarta ronda) · ADR-0060
-- Reversible: SÍ (una función de lectura; ver abajo)   Homologación: NO (no cambia el libro ni el IVA)
--
-- Familia H-03 (ola 5), cuarta ronda. Va con 20261005110000 … 110700, justo después del
-- `git pull` y en ese orden. Corrige un término de la 110500.
--
-- QUÉ PASABA
--   En `platform.inventory_ledger_gap` (110500) «en cola» significa dos cosas distintas dentro de
--   la misma función. `q` y `notas_en_cola` cuentan la fila pendiente O la descartada CON ACTA
--   (20261003190200: las dos explican un valor que no tiene asiento). El primer término del CTE
--   `a` —el ajuste del kardex de una nota de crédito de proveedor que espera con la nota ya
--   posteada— solo contaba la fila `pending`. Un ajuste descartado con su acta, con la nota
--   posteada, dejaba `diferencia <> en_cola` para siempre: el mayor de inventario se movió por lo
--   que la nota acreditó, el kardex por lo que bajó, y lo que explica la distancia (el ajuste
--   descartado, con acta) no figuraba en ninguna parte.
--
-- QUÉ HACE
--   REDEFINE `platform.inventory_ledger_gap(uuid)` partiendo de su ÚLTIMA definición en orden
--   limpio (20261005110500, entera; comprobado el 2026-10-04 con grep sobre supabase/migrations:
--   ninguna posterior —130000, 130100, 130200, 140000, 150000— la redefine). Cambia UNA cosa: el
--   primer término de `a` cuenta el ajuste con la misma definición de «en cola» que `q`
--   (pendiente, o descartado con acta). El `not in (select source_id from notas_en_cola)` se
--   conserva: `journal_generation_queue.source_id` es NOT NULL, así que no puede anularse.
--   No cambia la firma, ni los privilegios, ni las otras CTE.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Es una función STABLE de lectura: no escribe nada. Se revierte con el `create or replace`
--   de la 110500; ningún dato depende de ella. En una base con ajustes ya descartados con acta,
--   revertirla vuelve a enseñar la brecha que esta migración explica.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110700.
-- pgTAP: supabase/tests/139 (sección d), con el estado que antes no cuadraba.

CREATE OR REPLACE FUNCTION platform.inventory_ledger_gap(p_company uuid)
 RETURNS TABLE(kardex numeric, mayor numeric, diferencia numeric, en_cola numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with corte as (
    select max(c.cutover_at) as t from public.inventory_ledger_cutovers c
     where c.company_id = p_company
  ),
  cuentas as (
    select distinct s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'inventory_general'
  ),
  k as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and (corte.t is null or m.created_at > corte.t)
  ),
  l as (
    select coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as v
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company, corte
     where jl.company_id = p_company
       and jl.account_id in (select account_id from cuentas)
       and e.status in ('posted', 'reversed')
       and (corte.t is null or e.created_at > corte.t)
  ),
  q as (
    select coalesce(sum(m.functional_amount), 0) as v
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and (corte.t is null or m.created_at > corte.t)
       and exists (select 1 from public.journal_generation_queue jq
                    where jq.company_id = p_company
                      -- 20261003190200: pendiente, o descartada CON ACTA (ver
                      -- inventory_coverage_gaps): las dos explican un valor sin asiento.
                      and (jq.status = 'pending'
                           or (jq.status = 'discarded'
                               and exists (select 1 from public.audit_events a
                                            where a.company_id = p_company
                                              and a.event_type = 'accounting.pending_discarded'
                                              and a.payload ->> 'queue_id' = jq.id::text)))
                      and jq.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                             'stock_opening', 'goods_receipt', 'sales_return',
                                             'purchase_revaluation', 'purchase_credit_note')
                      and jq.source_id in (m.id, m.source_document_id)
                      -- 20261005110200: el ajuste de la nota (purchase_revaluation /
                      -- ap.credit_note_received) comparte source_id con ella, pero lo que cubre
                      -- sus movimientos es el asiento de la NOTA. Contarlo daba «duplicated».
                      and not (jq.source_kind = 'purchase_revaluation'
                               and jq.source_event = 'ap.credit_note_received'))
  ),
  -- 20261005110500: las notas de crédito de proveedor cuyo asiento está ELLO MISMO en la cola
  -- (con la misma definición de «en cola» que `q`). Sus movimientos ya están contados en `q`.
  notas_en_cola as (
    select distinct nq.source_id
      from public.journal_generation_queue nq
     where nq.company_id = p_company
       and nq.source_kind = 'purchase_credit_note'
       and (nq.status = 'pending'
            or (nq.status = 'discarded'
                and exists (select 1 from public.audit_events a
                             where a.company_id = p_company
                               and a.event_type = 'accounting.pending_discarded'
                               and a.payload ->> 'queue_id' = nq.id::text)))
  ),
  -- El ajuste del kardex de una nota de crédito (purchase_revaluation / ap.credit_note_received).
  -- No es el valor de un movimiento: es la diferencia entre lo que la nota acredita a inventario
  -- y lo que el kardex bajó. Cuenta en `en_cola` según dónde esté la NOTA (20261005110500):
  --   · nota posteada y ajuste en cola: al mayor le falta el ajuste → se suma;
  --   · nota en cola y ajuste en cola: nada (los movimientos enteros ya están en `q`);
  --   · nota en cola y ajuste YA posteado: `q` cuenta los movimientos enteros, pero el mayor ya
  --     recibió el ajuste → se resta lo que ese asiento movió en inventario.
  -- 20261005110800: «ajuste en cola» es lo mismo que en `q` y en `notas_en_cola` —pendiente, o
  -- descartado CON ACTA—. Antes este término solo contaba el pendiente, y un ajuste descartado
  -- con acta dejaba `diferencia <> en_cola` para siempre.
  a as (
    select coalesce((select sum((jq.context ->> 'revaluation_to_inventory')::numeric)
                       from public.journal_generation_queue jq, corte
                      where jq.company_id = p_company
                        and (jq.status = 'pending'
                             or (jq.status = 'discarded'
                                 and exists (select 1 from public.audit_events ae
                                              where ae.company_id = p_company
                                                and ae.event_type = 'accounting.pending_discarded'
                                                and ae.payload ->> 'queue_id' = jq.id::text)))
                        and jq.source_kind = 'purchase_revaluation'
                        and jq.source_event = 'ap.credit_note_received'
                        and (corte.t is null or jq.created_at > corte.t)
                        -- source_id es NOT NULL en la cola: este NOT IN no puede anularse.
                        and jq.source_id not in (select source_id from notas_en_cola)), 0)
         - coalesce((select sum(jl.functional_debit - jl.functional_credit)
                       from public.journal_entries aj
                       join public.journal_entries e
                         on e.company_id = p_company and e.status in ('posted', 'reversed')
                        and (e.id = aj.id or e.is_reversal_of = aj.id)
                       join public.journal_lines jl
                         on jl.entry_id = e.id and jl.company_id = p_company, corte
                      where aj.company_id = p_company
                        and aj.source_kind = 'purchase_revaluation'
                        and aj.source_event = 'ap.credit_note_received'
                        and aj.status in ('posted', 'reversed') and aj.is_reversal_of is null
                        and (corte.t is null or aj.created_at > corte.t)
                        and aj.source_id in (select source_id from notas_en_cola)
                        and jl.account_id in (select account_id from cuentas)), 0) as v
  )
  select k.v, l.v, k.v - l.v, q.v + a.v from k, l, q, a
$function$;
