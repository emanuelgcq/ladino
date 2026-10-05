-- Módulo: compras   Spec: ADR-0083 · ADR-0065 · ADR-0060 · ADR-0080 · docs/02_COMPLIANCE/RETENTIONS_SPEC.md
-- Reversible: NO con datos vivos (ver abajo)   Homologación: YES
--
-- Recorrido 2026-09-24, ola 5: H-03 (la nota de crédito de un proveedor), el hallazgo del kardex
-- confirmado en la ola 3 y la corrección de la factura de un gasto (AF4-02, ADR-0080 «Negativas»).
--
-- QUÉ PASABA
--   · La nota de crédito del proveedor acreditaba `inventory_general` en el mayor SIN mover el
--     kardex: `inventory_ledger_gap()` crecía por el importe de cada nota.
--   · La tabla exigía número de control o referencia (CHECK): una nota fiscal que llega sin
--     control no se podía registrar, y el crédito fiscal quedaba deducido de más.
--   · La línea de la nota exigía producto: la factura de un GASTO (líneas de servicio, ADR-0080)
--     no tenía corrección.
--
-- QUÉ HACE
--   1. `supplier_credit_notes`: `correction_kind` (devolucion | rebaja; nulo en la nota de un
--      gasto), `is_fiscal` (la nota sigue a su factura: sin soporte fiscal no va al libro),
--      `document_incomplete` (generada: fiscal y sin control ni referencia) y
--      `credit_in_favor_functional` (lo que la nota abonó por encima de lo que se debía).
--      Se QUITA `supplier_credit_notes_identification_chk`: la falta de control ya no impide
--      registrar (RESPUESTA §3, H-03: lectura conservadora), queda MARCADA.
--   2. `supplier_credit_note_lines.product_id` deja de ser obligatorio SOLO para la línea que
--      corrige una línea de servicio: CHECK + trigger (LADH3).
--   3. Plantillas: `purchase_credit_note / ap.expense_credit_note_received` (revierte gasto y
--      crédito fiscal) y `purchase_revaluation / ap.credit_note_received` (la diferencia entre lo
--      que la nota acreditó a inventario y lo que el kardex bajó, contra variación de costo).
--      Preset + las empresas que ya tienen la plantilla de la nota. Ninguna plantilla existente
--      cambia.
--   4. REDEFINE tres funciones, partiendo de su definición VIVA (pg_get_functiondef sobre la base
--      con todo hasta 20261004210100):
--        · platform.inventory_coverage_gaps(uuid) — última: 20261003190200;
--        · platform.inventory_ledger_gap(uuid)    — última: 20261003190200;
--          las dos aceptan el asiento (o la cola) de la NOTA —`purchase_credit_note`— como lo
--          que cubre los movimientos de kardex que la nota origina (source_document_id);
--        · platform.settled_ledger_gaps(uuid)     — el enunciado dice ahora el saldo a favor.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   · Columnas y plantillas: aditivas. Se quitan MIENTRAS no exista una nota registrada con la
--     API nueva; después, quitar `correction_kind` borra qué fue cada nota y quitar la plantilla
--     deja su asiento sin plantilla que lo explique.
--   · El CHECK de identificación NO se puede reponer en cuanto exista una nota «incompleta».
--   · `product_id` NOT NULL no se puede reponer en cuanto exista una línea de servicio.
--   · Las tres funciones se revierten restaurando la definición anterior; con una nota de
--     devolución o de rebaja ya registrada, la anterior de las dos de inventario daría sus
--     movimientos por «missing», y la de `settled_ledger_gaps` daría por hueco todo saldo a favor.
--   Es «expand»: la API hoy desplegada sigue registrando notas igual (no escribe las columnas
--   nuevas; `is_fiscal` nace true y `credit_in_favor_functional` 0).
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull` (depende de 20261004170000: `expense_category` y la
-- plantilla del gasto).

-- ── 1. La nota: qué es, si es fiscal, si llegó incompleta y cuánto dejó a favor ──────────────
alter table public.supplier_credit_notes
  add column correction_kind text,
  add column is_fiscal boolean not null default true,
  add column credit_in_favor_functional numeric(24,8) not null default 0;
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_correction_kind_chk
    check (correction_kind is null or correction_kind in ('devolucion', 'rebaja')),
  add constraint supplier_credit_notes_credit_in_favor_chk
    check (credit_in_favor_functional >= 0);
alter table public.supplier_credit_notes
  drop constraint supplier_credit_notes_identification_chk;
alter table public.supplier_credit_notes
  add column document_incomplete boolean
    generated always as (is_fiscal and supplier_control_number is null
                         and supplier_document_ref is null) stored;

comment on column public.supplier_credit_notes.correction_kind is
  'H-03 (ADR-0083): devolucion = la mercancía volvió al proveedor y salió del kardex a su costo; '
  'rebaja = bajó el precio y se revalorizó lo que quedaba en existencia. Nulo en la nota de la '
  'factura de un gasto y en las notas anteriores a 20261005110000.';
comment on column public.supplier_credit_notes.is_fiscal is
  'H-03: la nota sigue a su factura. false = la factura no tiene soporte fiscal (ADR-0066 §2): no '
  'es una nota de crédito fiscal y no va al libro de compras.';
comment on column public.supplier_credit_notes.document_incomplete is
  'H-03 (PA 00071 art. 23 → art. 13): nota fiscal registrada SIN número de control ni referencia. '
  'Reduce el crédito fiscal igual (lectura conservadora) y queda marcada para pedir el papel.';
comment on column public.supplier_credit_notes.credit_in_favor_functional is
  'ADR-0083 §5: lo que la nota abonó, en moneda funcional y al céntimo, POR ENCIMA de lo que el '
  'mayor le debía al proveedor por la factura al registrarla (saldo a favor). Es lo que '
  'platform.settled_ledger_gaps espera en cuentas por pagar de una factura saldada: quitar la '
  'columna o dejar de escribirla pone ese invariante en rojo por cada nota sobre factura pagada.';

-- ── 2. La línea que corrige un servicio no tiene producto ───────────────────────────────────
alter table public.supplier_credit_note_lines alter column product_id drop not null;
alter table public.supplier_credit_note_lines
  add constraint supplier_credit_note_lines_product_or_service_chk
  check (product_id is not null or supplier_invoice_line_id is not null);

create or replace function platform.assert_credit_note_service_line()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.product_id is null and not exists (
       select 1
         from public.supplier_invoice_lines il
         join public.supplier_credit_notes n on n.id = new.supplier_credit_note_id
        where il.id = new.supplier_invoice_line_id
          and il.supplier_invoice_id = n.supplier_invoice_id
          and il.product_id is null) then
    raise exception
      'una línea de nota de crédito sin producto solo corrige una línea de servicio de SU factura'
      using errcode = 'LADH3';
  end if;
  return new;
end;
$$;
revoke all on function platform.assert_credit_note_service_line() from public;

create trigger supplier_credit_note_lines_02_service_line
  before insert or update on public.supplier_credit_note_lines
  for each row execute function platform.assert_credit_note_service_line();

-- ── 3. Las dos plantillas ───────────────────────────────────────────────────────────────────
do $$
declare
  v_gasto  uuid;
  v_ajuste uuid;
  v_c      record;
  v_tpl    uuid;
  v_e      record;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'purchase_credit_note', 'ap.expense_credit_note_received',
          'Nota de crédito del proveedor sobre la factura de un gasto: revierte gasto y crédito fiscal')
  returning id into v_gasto;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_gasto, 1, 'ap_general', 'total', 'debit', 'always',
     'Baja lo que se le debe al proveedor (o queda a favor)'),
    (v_gasto, 2, 'operating_expense', 'subtotal', 'credit', 'if_tax_recoverable',
     'Reversa del gasto, sin el IVA'),
    (v_gasto, 3, 'iva_credit_fiscal', 'tax_amount', 'credit', 'if_tax_recoverable',
     'Reversa del IVA crédito fiscal (LIVA art. 37)'),
    (v_gasto, 4, 'operating_expense', 'total', 'credit', 'if_tax_not_recoverable',
     'Reversa del gasto con su IVA: había ido al costo');

  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'purchase_revaluation', 'ap.credit_note_received',
          'Nota de crédito del proveedor: diferencia entre lo abonado y lo que el kardex bajó')
  returning id into v_ajuste;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_ajuste, 1, 'inventory_general', 'revaluation_to_inventory', 'debit', 'if_positive',
     'El kardex bajó MENOS de lo que la nota acreditó a inventario'),
    (v_ajuste, 2, 'inventory_general', 'revaluation_to_inventory', 'credit', 'if_negative',
     'El kardex bajó MÁS de lo que la nota acreditó a inventario'),
    (v_ajuste, 3, 'purchase_cost_variance', 'revaluation_to_variance', 'debit', 'if_positive',
     'Variación de costo de compras'),
    (v_ajuste, 4, 'purchase_cost_variance', 'revaluation_to_variance', 'credit', 'if_negative',
     'Variación de costo de compras');

  for v_c in
    select distinct t.company_id, t.tenant_id from public.journal_templates t
     where t.source_kind = 'purchase_credit_note' and t.source_event = 'ap.credit_note_received'
  loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.id in (v_gasto, v_ajuste)
    loop
      continue when exists (select 1 from public.journal_templates t
                             where t.company_id = v_c.company_id
                               and t.source_kind = v_e.source_kind
                               and t.source_event = v_e.source_event);
      insert into public.journal_templates
        (tenant_id, company_id, source_kind, source_event, description, effective_from)
      values (v_c.tenant_id, v_c.company_id, v_e.source_kind, v_e.source_event, v_e.description,
              '-infinity')
      returning id into v_tpl;
      insert into public.journal_template_lines
        (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
         side, condition_kind, description)
      select v_c.tenant_id, v_c.company_id, v_tpl, l.line_number, l.account_purpose,
             l.amount_source, l.side, l.condition_kind, l.description
        from public.journal_template_preset_lines l
       where l.entry_id = v_e.id order by l.line_number;
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
              'accounting.templates_imported', 'system', now(), 'db-migration',
              jsonb_build_object('migration', '20261005110000',
                                 'source_kind', v_e.source_kind,
                                 'source_event', v_e.source_event));
    end loop;
  end loop;
end $$;

-- ── 4. Los invariantes ──────────────────────────────────────────────────────────────────────
-- Los movimientos de kardex que origina una nota de crédito (su salida o su revalorización, con
-- source_document_id = la nota) los cubre el asiento de la NOTA, o su fila en cola.
CREATE OR REPLACE FUNCTION platform.inventory_coverage_gaps(p_company uuid)
 RETURNS TABLE(move_id uuid, kind text, problem text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with corte as (
    select max(c.cutover_at) as t from public.inventory_ledger_cutovers c
     where c.company_id = p_company
  ),
  anulados_netos as (
    -- Documentos anulados cuyos movimientos netean a cero en cantidad Y en valor: la venta se
    -- deshizo entera, no hay hecho económico que contabilizar.
    select m.source_document_id as id
      from public.inventory_moves m
      join public.documents d on d.id = m.source_document_id and d.company_id = p_company
     where m.company_id = p_company and d.status = 'annulled'
     group by m.source_document_id
    -- Mismo neteo que annulled_stock_gaps: la cantidad ya viene con signo.
    having coalesce(sum(m.quantity), 0) = 0 and coalesce(sum(m.functional_amount), 0) = 0
  ),
  movs as (
    select m.id, m.kind, m.source_document_id
      from public.inventory_moves m, corte
     where m.company_id = p_company
       and m.kind in ('entrada', 'salida', 'ajuste', 'revaluacion')
       and m.functional_amount <> 0
       and (corte.t is null or m.created_at > corte.t)
       and (m.source_document_id is null
            or m.source_document_id not in (select id from anulados_netos))
  ),
  estado as (
    select mv.id, mv.kind,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.status = 'posted'
                      and e.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and e.source_id in (mv.id, mv.source_document_id)) as asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and q.source_id in (mv.id, mv.source_document_id)) as cola,
           -- 20261003190200 (ADR-0075 §7): DESCARTADA CON ACTA. La fila de cola que alguien
           -- descartó dejando el acta accounting.pending_discarded (con su motivo) es un hecho
           -- cerrado, no un hueco. Sin acta, una fila descartada NO cubre nada.
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'discarded'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation', 'purchase_credit_note')
                      and q.source_id in (mv.id, mv.source_document_id)
                      and exists (select 1 from public.audit_events a
                                   where a.company_id = p_company
                                     and a.event_type = 'accounting.pending_discarded'
                                     and a.payload ->> 'queue_id' = q.id::text)) as descartada
      from movs mv
  )
  select id, kind,
         case when not asiento and not cola and not descartada then 'missing'
              else 'duplicated' end
    from estado
   where (not asiento and not cola and not descartada) or (asiento and cola)
$function$;

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
                      and jq.source_id in (m.id, m.source_document_id))
  )
  select k.v, l.v, k.v - l.v, q.v from k, l, q
$function$;

CREATE OR REPLACE FUNCTION platform.settled_ledger_gaps(p_company uuid)
 RETURNS TABLE(side text, document_id uuid, residual numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- ENUNCIADO: todo documento SALDADO (venta `paid`, factura de compra `paid`) cuyo último
  -- cobro o pago es posterior al corte (platform.invariant_cutoffs), y cuyas piezas tienen todas
  -- su asiento, no deja NADA en cuentas por cobrar (o por pagar) del mayor, salvo —en compras— el
  -- saldo a favor que sus notas de crédito declararon (supplier_credit_notes.credit_in_favor_functional).
  select 'ar'::text, d.id, x.abierto
    from public.documents d
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ar', d.id)
                               as abierto) x
   where d.company_id = p_company and d.status = 'paid'
     and (select max(p.created_at) from public.payments p where p.document_id = d.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     and x.abierto is not null and x.abierto <> 0
  union all
  select 'ap'::text, i.id, x.abierto
    from public.supplier_invoices i
    cross join lateral (select platform.settlement_ledger_open(p_company, 'ap', i.id)
                               as abierto) x
   where i.company_id = p_company and i.status = 'paid'
     and (select max(p.created_at) from public.supplier_payments p
           where p.supplier_invoice_id = i.id)
         >= (select c.since from platform.invariant_cutoffs c
              where c.invariant = 'settled_ledger_gaps')
     -- 20261005110000 (H-03, ADR-0083 §5): una nota de crédito del proveedor registrada sobre
     -- una factura que ya no debía nada deja SALDO A FAVOR, y ese saldo vive en cuentas por
     -- pagar en negativo. Lo que la factura saldada puede dejar en el mayor es exactamente eso
     -- —lo que cada nota declaró al registrarse—, ni un céntimo más ni uno menos.
     and x.abierto is not null
     and x.abierto <> -coalesce((select sum(n.credit_in_favor_functional)
                                   from public.supplier_credit_notes n
                                  where n.supplier_invoice_id = i.id and n.status = 'posted'), 0)
$function$;
