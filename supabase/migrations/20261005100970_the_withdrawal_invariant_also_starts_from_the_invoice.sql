-- =============================================================================
-- Ladino — 20261005100970 · EL INVARIANTE DEL RETIRO TAMBIÉN PARTE DE LA FACTURA
--   (cuarta ronda de ADR-0082; C1 de la segunda revisión en contexto limpio)
--
-- Módulo: inventario · ventas · fiscal (RIGOR MÁXIMO)
-- Spec: ADR-0082 (nota de la cuarta ronda)
-- HOMOLOGATION_IMPACT: NO — es una lectura: no emite, no numera y no cambia ningún importe.
--
-- EL DEFECTO (familia «invariante que nace verde»). `platform.withdrawal_note_gaps` cruzaba
--   las dos tablas en UN sentido: `retiro_sin_factura` parte del MOVIMIENTO y busca su factura.
--   Ninguna rama partía de la FACTURA para comprobar que la salida que dice documentar existe,
--   es de la empresa, es un retiro gravado y la señala a ella. Una factura de retiro con la
--   salida colgando era invisible al invariante. Mientras hubo clave foránea, al menos la
--   existencia estaba garantizada; desde 20261005100960 (que la soltó) el único guardián era el
--   constraint trigger `documents_95_withdrawal_move`. Un invariante que solo puede dar cero
--   porque otra pieza impide el caso no vigila nada: vigila la otra pieza, sin decirlo.
-- ARREGLO. Una rama nueva, `factura_de_retiro_sin_su_salida`: toda factura de retiro emitida,
--   pagada o anulada cuyo `withdrawal_move_id` no sea una salida de ESTA empresa, con motivo de
--   retiro gravado, que la señale como su documento. Es la misma condición del trigger, leída
--   desde fuera. La fila lleva en `move_id` lo que la factura dice (puede no existir).
--
-- FUNCIÓN REDEFINIDA, y de cuál parte (la última en orden limpio):
--   platform.withdrawal_note_gaps ← 20261005100900 §5, ENTERA. El único cambio es la rama
--   nueva (y su línea en el enunciado). Ninguna migración posterior (1100xx-1107xx, 1300xx,
--   140000, 150000) la redefine.
-- COMPATIBILIDAD: expand. Misma firma. Va JUSTO DESPUÉS del `git pull`, tras 20261005100960,
--   en la misma ventana que la familia.
-- REVERSIBILIDAD (con datos vivos): SÍ, entera: un `create or replace` sin datos. Volver atrás
--   es reaplicar la definición de 20261005100900 (y recuperar el punto ciego).
-- =============================================================================

create or replace function platform.withdrawal_note_gaps(p_company uuid)
 returns table(move_id uuid, problem text)
 language sql
 stable
 set search_path to ''
as $function$
  -- ENUNCIADO (ADR-0082; RLIVA art. 31). En una empresa que FACTURABA en el instante de la salida:
  --   (1) todo retiro GRAVADO (consumo propio, regalo, donación, muestra) registrado desde el corte
  --       (platform.invariant_cutoffs, `withdrawal_invoice`) tiene su FACTURA DE RETIRO, emitida o
  --       anulada. Una Nota de retiro (serie NR) ya no lo cubre;
  --   (2) todo retiro gravado ANTERIOR al corte tiene su Nota de retiro o su factura de retiro: las
  --       notas emitidas no se reescriben (append-only) y siguen en el libro;
  --   (3) la nota o la factura de retiro vigente con IVA tiene ese IVA acreditado al débito fiscal
  --       en el asiento de su salida, o el hecho espera en la cola de pendientes;
  --   (4) ni la factura de retiro ni su nota de crédito cargan cartera: ni cobro, ni saldo a favor,
  --       ni una línea en las cuentas por cobrar dentro del asiento de su salida;
  --   (5) su adquirente es la propia empresa: el RIF congelado del adquirente es el del emisor;
  --   (6) un retiro CORREGIDO —su factura tiene nota de crédito emitida— netea en cero: el kardex
  --       de la factura y de su nota suma cero en cantidad y en valor (la mercancía volvió, al
  --       costo con que salió);
  --   (7) la nota de crédito de un retiro es TOTAL: los importes de su factura;
  --   (8) y su IVA está debitado al débito fiscal en el asiento de su reingreso, o espera en cola.
  --   (9) Y AL REVÉS (20261005100970): toda factura de retiro documenta una salida que EXISTE, es
  --       de esta empresa, tiene motivo de retiro gravado y la señala como su documento. Sin
  --       esta rama el cruce iba solo del movimiento a la factura, y `withdrawal_move_id` no
  --       tiene clave foránea (20261005100960).
  --   (0) el corte EXISTE. Si faltara su fila, este invariante no calla: da una fila
  --       `falta_el_corte` y juzga todo retiro como posterior al corte (20261005100800);
  -- Los motivos no gravados (uso_en_negocio, activo_fijo, incorporado_inmueble) y las pérdidas
  -- justificadas no son retiro gravado y no entran: está en el enunciado, no en una exclusión.
  with corte as (
    -- SIEMPRE una fila. Sin corte registrado, '-infinity': todo retiro es posterior al corte y
    -- exige factura. Un `from retiros r, corte` contra cero filas daría un cero falso.
    select coalesce((select c.since from platform.invariant_cutoffs c
                      where c.invariant = 'withdrawal_invoice'),
                    '-infinity'::timestamptz) as since
  ),
  retiros as (
    select m.id, m.created_at
      from public.inventory_moves m
     where m.company_id = p_company and m.kind = 'salida'
       and m.exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')
       and platform.sales_mode_at(p_company, m.occurred_at) = 'facturas'
  ),
  facturas as (
    select d.id, d.withdrawal_move_id, d.status, d.subtotal_amount, d.tax_amount, d.total_amount,
           d.customer_tax_id_snapshot, d.issuer_tax_id_snapshot
      from public.documents d
     where d.company_id = p_company and d.kind = 'withdrawal_invoice'
       and d.status in ('issued', 'paid', 'annulled')
  ),
  notas as (
    select n.id, n.source_document_id, n.status, n.subtotal_amount, n.tax_amount, n.total_amount,
           f.withdrawal_move_id, f.subtotal_amount as f_subtotal, f.tax_amount as f_tax,
           f.total_amount as f_total
      from public.documents n
      join facturas f on f.id = n.source_document_id
     where n.company_id = p_company and n.kind = 'withdrawal_credit_note'
       and n.status in ('issued', 'paid')
  ),
  debito as (
    select s.account_id from public.company_account_settings s
     where s.company_id = p_company and s.purpose = 'iva_debit_fiscal'
  )
  select null::uuid, 'falta_el_corte'::text
   where not exists (select 1 from platform.invariant_cutoffs c
                      where c.invariant = 'withdrawal_invoice')
  union all
  select r.id, 'retiro_sin_factura'::text
    from retiros r, corte
   where r.created_at >= corte.since
     and not exists (select 1 from facturas f where f.withdrawal_move_id = r.id)
  union all
  -- (9) La MISMA condición de platform.assert_withdrawal_invoice_move, leída desde fuera.
  select f.withdrawal_move_id, 'factura_de_retiro_sin_su_salida'
    from facturas f
   where not exists (
           select 1 from public.inventory_moves m
            where m.id = f.withdrawal_move_id and m.company_id = p_company
              and m.kind = 'salida'
              and m.exit_reason in ('consumo_propio', 'regalo', 'donacion', 'muestra')
              and m.source_document_id = f.id)
  union all
  select r.id, 'retiro_sin_nota'
    from retiros r, corte
   where r.created_at < corte.since
     and not exists (select 1 from public.inventory_withdrawal_notes n where n.move_id = r.id)
     and not exists (select 1 from facturas f where f.withdrawal_move_id = r.id)
  union all
  select n.move_id, 'nota_sin_iva_en_el_asiento'
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company and n.tax_functional <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_id = n.move_id
          and q.source_event = 'stock.withdrawn')
     and coalesce((
       select sum(jl.functional_credit - jl.functional_debit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_id = n.move_id
          and e.source_event = 'stock.withdrawn'), 0) <> n.tax_functional
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_sin_iva_en_el_asiento'
    from facturas f
   where f.status = 'issued' and f.tax_amount <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_id = f.withdrawal_move_id
          and q.source_event = 'stock.withdrawn')
     and coalesce((
       select sum(jl.functional_credit - jl.functional_debit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_id = f.withdrawal_move_id
          and e.source_event = 'stock.withdrawn'), 0) <> f.tax_amount
  union all
  select x.withdrawal_move_id, 'factura_de_retiro_con_cartera'
    from (select f.id, f.withdrawal_move_id, f.status from facturas f
          union all
          select n.id, n.withdrawal_move_id, n.status from notas n) x
   where x.status = 'paid'
      or exists (select 1 from public.payments p where p.document_id = x.id)
      or exists (select 1 from public.customer_credits cc where cc.source_document_id = x.id)
      or exists (
        select 1 from public.journal_entries e
          join public.journal_lines jl on jl.entry_id = e.id
         where e.company_id = p_company
           and e.source_kind = 'inventory_move' and e.source_id = x.withdrawal_move_id
           and jl.account_id in (select s.account_id from public.company_account_settings s
                                  where s.company_id = p_company and s.purpose = 'ar_general'))
  union all
  select f.withdrawal_move_id, 'factura_de_retiro_a_un_tercero'
    from facturas f
   where upper(regexp_replace(coalesce(f.customer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
         is distinct from
         upper(regexp_replace(coalesce(f.issuer_tax_id_snapshot, ''), '[^a-zA-Z0-9]', '', 'g'))
  union all
  select n.withdrawal_move_id, 'retiro_corregido_sin_reingreso'
    from notas n
   where exists (
           select 1 from public.inventory_moves m
            where m.company_id = p_company
              and m.source_document_id in (n.id, n.source_document_id)
           having coalesce(sum(m.quantity), 0) <> 0 or coalesce(sum(m.functional_amount), 0) <> 0)
      or not exists (select 1 from public.inventory_moves m
                      where m.company_id = p_company and m.source_document_id = n.id
                        and m.kind = 'entrada')
  union all
  select n.withdrawal_move_id, 'nota_de_credito_de_retiro_no_es_total'
    from notas n
   where n.subtotal_amount <> n.f_subtotal or n.tax_amount <> n.f_tax
      or n.total_amount <> n.f_total
  union all
  select n.withdrawal_move_id, 'nota_de_credito_de_retiro_sin_iva_en_el_asiento'
    from notas n
   where n.tax_amount <> 0
     and not exists (
       select 1 from public.journal_generation_queue q
         join public.inventory_moves m on m.id = q.source_id
        where q.company_id = p_company and q.status = 'pending'
          and q.source_kind = 'inventory_move' and q.source_event in ('stock.withdrawal_returned', 'stock.received')
          and m.source_document_id = n.id)
     and coalesce((
       select sum(jl.functional_debit - jl.functional_credit)
         from public.journal_entries e
         join public.journal_lines jl on jl.entry_id = e.id
         join public.inventory_moves m on m.id = e.source_id
        where e.company_id = p_company and e.status = 'posted'
          and jl.account_id in (select d.account_id from debito d)
          and e.source_kind = 'inventory_move' and e.source_event in ('stock.withdrawal_returned', 'stock.received')
          and m.source_document_id = n.id), 0) <> n.tax_amount
$function$;
