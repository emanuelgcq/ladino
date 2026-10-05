-- Módulo: inventario · contabilidad   Spec: ADR-0083 (sección «Revisión», tercera ronda) · ADR-0060
-- Reversible: SÍ (una función de lectura; ver abajo)   Homologación: NO (no cambia el libro ni el IVA)
--
-- Familia H-03 (ola 5), tercera ronda. Va con 20261005110000 … 110400, justo después del
-- `git pull` y en ese orden. Corrige una REGRESIÓN de la 110200.
--
-- ANTES DE APLICAR LA FAMILIA EN UNA BASE CON DATOS (las dos tienen que dar 0; si no, la 110200
-- se niega —LAD82— o su índice único falla):
--   -- notas cuya factura no tiene soporte fiscal y aun así figuran como fiscales (o al revés)
--   select count(*) from public.supplier_credit_notes n
--     join public.supplier_invoices i on i.id = n.supplier_invoice_id
--    where n.is_fiscal is distinct from i.fiscal_support;
--   -- notas que repiten línea de factura
--   select count(*) from (select 1 from public.supplier_credit_note_lines
--                          where supplier_invoice_line_id is not null
--                          group by supplier_credit_note_id, supplier_invoice_line_id
--                         having count(*) > 1) x;
-- Producción, 2026-10-04 (lectura de la sesión principal): 0 notas de crédito de proveedor.
--
-- QUÉ PASABA
--   `platform.inventory_ledger_gap` (110200) sumaba a `en_cola` el ajuste de kardex pendiente de
--   TODA nota de crédito (CTE `a`). Eso es correcto con el asiento de la nota ya posteado: el
--   mayor de inventario se movió por lo acreditado y le falta el ajuste. Pero con la NOTA ella
--   misma en la cola, el mayor no se ha movido y `q` ya cuenta sus movimientos enteros: `en_cola`
--   se pasaba exactamente por el ajuste (−10 de brecha contra −13 en cola). Y el estado contrario
--   —nota en cola, ajuste ya posteado— tampoco cuadraba: `q` contaba el movimiento entero cuando
--   el ajuste ya había llevado su parte al mayor (−6 de brecha contra −10 en cola).
--   Lo leen «Movimientos todavía sin contabilizar» de reportes y el contrato
--   `diferencia = en_cola` de e2e-llegada.
--
-- QUÉ HACE
--   REDEFINE `platform.inventory_ledger_gap(uuid)` partiendo de su ÚLTIMA definición en orden
--   limpio (20261005110200, entera). Solo cambia el CTE `a` y gana el CTE `notas_en_cola`:
--     · nota POSTEADA, ajuste en cola   → `a` = + el ajuste pendiente (como en la 110200);
--     · nota EN COLA, ajuste en cola    → `a` = 0 (los movimientos ya están en `q`);
--     · nota EN COLA, ajuste POSTEADO   → `a` = − lo que ese ajuste YA llevó al mayor de
--       inventario (`q` cuenta el movimiento entero; el mayor ya tiene esa parte);
--     · nota posteada, ajuste posteado  → `a` = 0.
--   «En cola» es lo mismo que en `q`: pendiente, o descartada CON acta.
--   No cambia la firma, ni los privilegios, ni las otras CTE.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Es una función STABLE de lectura: no escribe nada. Se revierte con el `create or replace`
--   de la 110200; ningún dato depende de ella.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110400.

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
  --   · nota posteada y ajuste pendiente: al mayor le falta el ajuste → se suma;
  --   · nota en cola y ajuste pendiente: nada (los movimientos enteros ya están en `q`);
  --   · nota en cola y ajuste YA posteado: `q` cuenta los movimientos enteros, pero el mayor ya
  --     recibió el ajuste → se resta lo que ese asiento movió en inventario.
  a as (
    select coalesce((select sum((jq.context ->> 'revaluation_to_inventory')::numeric)
                       from public.journal_generation_queue jq, corte
                      where jq.company_id = p_company and jq.status = 'pending'
                        and jq.source_kind = 'purchase_revaluation'
                        and jq.source_event = 'ap.credit_note_received'
                        and (corte.t is null or jq.created_at > corte.t)
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
