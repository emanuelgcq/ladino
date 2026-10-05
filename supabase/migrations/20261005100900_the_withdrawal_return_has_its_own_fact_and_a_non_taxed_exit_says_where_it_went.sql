-- =============================================================================
-- Ladino — 20261005100900 · EL REINGRESO DE UN RETIRO TIENE SU PROPIO HECHO CONTABLE, Y LA
--   SALIDA NO GRAVADA DICE ADÓNDE FUE (tercera ronda de ADR-0082)
--
-- Módulo: inventario · contabilidad · fiscal (RIGOR MÁXIMO)
-- Spec: ADR-0082 (nota de la tercera ronda) · ADR-0055 · docs/04_PLATFORM/EVENT_CATALOG.md
-- HOMOLOGATION_IMPACT: YES — una salida no gravada (sin débito fiscal) deja de poder
--   registrarse sin su nota de destino. Ningún importe ni documento ya emitido cambia.
--
-- DEFECTO 1 (latente). 20261005100500 §5 dio al reingreso de un retiro corregido el hecho
--   contable `inventory_move / stock.received`, y a ese par una plantilla que ACREDITA «gasto
--   por retiro» y debita el débito fiscal. `stock.received` es el nombre genérico de toda
--   entrada: la primera entrada futura que asentara con `inventory_move / stock.received`
--   iría contra gasto por retiro, sin ruido. Un hecho con plantilla propia lleva nombre propio.
-- ARREGLO. El hecho pasa a llamarse `inventory_move / stock.withdrawal_returned`:
--     · el renglón del preset `ve_basico` cambia de nombre (mismas cuatro líneas);
--     · la plantilla de cada empresa que ya la recibió cambia de nombre, CON ACTA
--       (`accounting.templates_renamed`): en producción se creó en esta misma ventana y no
--       asentó nada; no hay asiento que quede huérfano de su plantilla;
--     · el dominio asienta y publica con el nombre nuevo;
--     · las TRES lecturas que buscan ese asiento aceptan los dos nombres. Un asiento posteado
--       no se reescribe (regla 2): los que una base de pruebas asentó entre 20261005100500 y
--       esta migración conservan `stock.received` y siguen siendo el asiento del reingreso de
--       SU nota —se llega a ellos por el movimiento de la nota, no por el nombre—.
--
-- DEFECTO 2 (AF5-07). Los tres motivos no gravados (uso en el negocio, activo fijo,
--   incorporado a un inmueble) salen del kardex sin débito y sin ningún soporte: es la puerta
--   por la que un consumo propio saldría sin IVA.
-- ARREGLO. Una nota de DESTINO obligatoria, con la regla de la evidencia de las pérdidas y en
--   su misma columna (`exit_evidence`). El dominio la exige con mensaje; este CHECK es la
--   segunda capa. `NOT VALID`, como el que sustituye: las salidas no gravadas ya registradas
--   (append-only, no se reescriben) quedan como están y la regla rige desde aquí.
--
-- FUNCIONES REDEFINIDAS, y de cuál parten (la última en orden limpio):
--   platform.sales_book               ← 20261005100500 §7
--   platform.accounting_coverage_gaps ← 20261005100500 §13
--   platform.withdrawal_note_gaps     ← 20261005100800 §4
--   En las tres, el ÚNICO cambio es `source_event = 'stock.received'` (del reingreso) por
--   `source_event in ('stock.withdrawal_returned', 'stock.received')`.
--   Ninguna migración posterior (1100xx-1107xx, 1300xx, 140000, 150000) las redefine.
-- COMPATIBILIDAD: expand. La API saliente no conoce la nota de crédito de un retiro (no asienta
--   con ninguno de los dos nombres) ni manda nota de destino: sus salidas no gravadas no existen
--   (los tres motivos nacen en esta ola). Va JUSTO DESPUÉS del `git pull`, tras 20261005100800.
-- REVERSIBILIDAD (con datos vivos): el nombre del hecho, SÍ mientras ningún reingreso se haya
--   asentado con el nombre nuevo (renombrar de vuelta preset y plantillas); con uno asentado, NO:
--   el asiento es append-only y lleva su nombre. El CHECK, SÍ: se repone el anterior; las notas
--   de destino ya escritas tendrían que quedar fuera de él (es `NOT VALID`: quedan).
-- =============================================================================

-- ── 1. La salida no gravada dice adónde fue ─────────────────────────────────
-- Definición VIVA del CHECK: 20261003110200. Se AÑADEN los tres motivos no gravados a los que
-- pueden —y deben— llevar `exit_evidence`. Lo demás, igual.
alter table public.inventory_moves drop constraint inventory_moves_exit_evidence_chk;
alter table public.inventory_moves add constraint inventory_moves_exit_evidence_chk check (
  (exit_evidence is null
   or (exit_evidence = btrim(exit_evidence)
       and length(exit_evidence) >= 3 and length(exit_evidence) <= 500
       and (coalesce(exit_reason = any (array['merma', 'rotura', 'vencido', 'faltante',
                                              'uso_en_negocio', 'activo_fijo',
                                              'incorporado_inmueble']), false)
            or (kind = 'ajuste' and quantity < 0))))
  and (exit_reason is null
       or exit_reason <> all (array['merma', 'rotura', 'vencido', 'faltante',
                                    'uso_en_negocio', 'activo_fijo', 'incorporado_inmueble'])
       or exit_evidence is not null)
) not valid;

-- ── 2. El hecho del reingreso, con nombre propio ────────────────────────────
do $$
declare
  v_t record;
begin
  update public.journal_template_preset_entries
     set source_event = 'stock.withdrawal_returned'
   where preset_code = 've_basico' and source_kind = 'inventory_move'
     and source_event = 'stock.received';
  if not found then
    raise exception 'falta el renglón inventory_move / stock.received del preset ve_basico (20261005100500): esta migración va después de aquella';
  end if;

  for v_t in
    select t.id, t.tenant_id, t.company_id from public.journal_templates t
     where t.source_kind = 'inventory_move' and t.source_event = 'stock.received'
  loop
    update public.journal_templates set source_event = 'stock.withdrawal_returned'
     where id = v_t.id;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_t.tenant_id, v_t.company_id, 'company', v_t.company_id,
            'accounting.templates_renamed', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20261005100900', 'template_id', v_t.id,
                               'source_kind', 'inventory_move',
                               'source_event_before', 'stock.received',
                               'source_event_after', 'stock.withdrawal_returned'));
  end loop;
end $$;

-- ── 3. El libro de ventas enlaza el asiento del reingreso por cualquiera de sus dos nombres ──
CREATE OR REPLACE FUNCTION platform.sales_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(document_id uuid, issued_on date, kind text, series text, document_number bigint, control_number bigint, status text, customer_tax_id text, customer_name text, customer_taxpayer_type text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric, journal_entry_id uuid, igtf_percibido numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  select x.* from (
  -- Definición viva de 20260928170200 §3 (signo R-1, anulada en cero G-10, adquirente por el
  -- snapshot del nombre B1/B3), más H1 (20261002120200): la línea de la ND por IGTF (producto de
  -- sistema LADINO-IGTF) no suma en ninguna base ni en el total de venta; su monto va a
  -- `igtf_percibido`. El renglón se conserva con su número, control y estado: el correlativo se
  -- consumió y el libro lo registra. VALIDAR-TRIBUTARIO P-70.
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         case when d.customer_name_snapshot is not null then d.customer_tax_id_snapshot
              else c.tax_id end,
         coalesce(d.customer_name_snapshot, c.legal_name),
         case when d.customer_name_snapshot is not null then d.customer_taxpayer_type_snapshot
              else c.taxpayer_type_code end,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'gravado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         d.tax_amount * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exento'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment is null
                            and pr.system_code is distinct from 'igtf'), 0) * f.factor,
         -- La ND por IGTF tiene una sola línea, la del IGTF: su total de VENTA es cero.
         case when coalesce(bool_and(pr.system_code = 'igtf'), false) then 0
              else d.total_amount end * f.factor,
         -- 20261005100000 (ADR-0082): el asiento de la factura de retiro ES el de su salida del
         -- kardex (gasto por retiro + débito fiscal contra inventario). Se busca por el movimiento
         -- y no por un enlace guardado: así vale igual si el hecho pasó por la cola de pendientes.
         case when d.kind = 'withdrawal_invoice' then
                (select e.id from public.journal_entries e
                  where e.company_id = d.company_id and e.source_kind = 'inventory_move'
                    and e.source_id = d.withdrawal_move_id
                    and e.source_event = 'stock.withdrawn'
                    -- 20261005100200: también el asiento REVERSADO (la factura de retiro anulada
                    -- sigue señalando su asiento original, como la factura de venta anulada), y
                    -- nunca el contra-asiento.
                    and e.status in ('posted', 'reversed') and e.is_reversal_of is null
                  limit 1)
              -- 20261005100500: la nota de crédito de un retiro enlaza el asiento de su
              -- REINGRESO al kardex (el contra-asiento del retiro).
              when d.kind = 'withdrawal_credit_note' then
                (select e.id from public.journal_entries e
                   join public.inventory_moves m on m.id = e.source_id
                  where e.company_id = d.company_id and m.source_document_id = d.id
                    and m.kind = 'entrada' and e.source_kind = 'inventory_move'
                    and e.source_event in ('stock.withdrawal_returned', 'stock.received')
                    and e.status in ('posted', 'reversed') and e.is_reversal_of is null
                  limit 1)
              else d.journal_entry_id end,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind in ('credit_note', 'withdrawal_credit_note') then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'withdrawal_invoice', 'credit_note', 'withdrawal_credit_note',
                    'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
  union all
  -- 20261003110000 (ADR-0078 §3): la Nota de retiro, venta a la propia empresa (LIVA art. 4.3).
  -- Documento interno: sin número de control; el adquirente es la empresa misma.
  select n.id, platform.caracas_day(n.issued_at), 'withdrawal_note'::text, 'NR'::text,
         n.note_number, null::bigint, 'issued'::text,
         -- 20261003110100: el adquirente CONGELADO en la nota, no companies en vivo.
         n.company_tax_id_snapshot, n.company_name_snapshot, n.company_taxpayer_type_snapshot,
         n.functional_currency, 1::numeric,
         case when n.tax_treatment = 'gravado' then n.base_functional else 0 end,
         n.tax_functional,
         case when n.tax_treatment = 'exento' then n.base_functional else 0 end,
         case when n.tax_treatment = 'exonerado' then n.base_functional else 0 end,
         case when n.tax_treatment = 'no_sujeto' then n.base_functional else 0 end,
         case when n.tax_treatment is null then n.base_functional else 0 end,
         n.base_functional + n.tax_functional,
         (select e.id from public.journal_entries e
           where e.company_id = n.company_id and e.source_kind = 'inventory_move'
             and e.source_id = n.move_id and e.source_event = 'stock.withdrawn'
             and e.status = 'posted'
           limit 1),
         0::numeric
    from public.inventory_withdrawal_notes n
   where n.company_id = p_company
     and platform.caracas_day(n.issued_at) between p_from and p_to
  ) x (document_id, issued_on, kind, series, document_number, control_number, status,
       customer_tax_id, customer_name, customer_taxpayer_type, transaction_currency, fx_rate,
       base_gravada, iva_debito, base_exenta, base_exonerada, base_no_sujeta, base_sin_clasificar,
       total_amount, journal_entry_id, igtf_percibido)
   order by coalesce((select d.issued_at from public.documents d where d.id = x.document_id),
                     (select n.issued_at from public.inventory_withdrawal_notes n
                       where n.id = x.document_id)),
            x.series, x.document_number
$function$;

-- ── 4. accounting_coverage_gaps: la nota, cubierta por el asiento de su reingreso ──
CREATE OR REPLACE FUNCTION platform.accounting_coverage_gaps(p_company uuid)
 RETURNS TABLE(source_kind text, source_id uuid, problem text)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with documentos as (
    select 'sales_invoice'::text as k, d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'invoice' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt' and d.status in ('issued', 'paid')
    union all
    select 'sales_credit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'credit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_debit_note', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'debit_note' and d.status in ('issued', 'paid')
    union all
    select 'sales_receipt_return', d.id, d.journal_entry_id
      from public.documents d
     where d.company_id = p_company and d.kind = 'receipt_return' and d.status in ('issued', 'paid')
    union all
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    -- ADR-0065 §1: la nota de crédito recibida es un hecho contable como la factura.
    select 'purchase_credit_note', n.id, n.journal_entry_id
      from public.supplier_credit_notes n
     where n.company_id = p_company and n.status = 'posted'
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
    union all
    select 'customer_refund', r.id, r.journal_entry_id
      from public.customer_refunds r
     where r.company_id = p_company
    union all
    select 'treasury_transfer', t.id, t.journal_entry_id
      from public.treasury_transfers t
     where t.company_id = p_company
  ),
  -- El COBRO, el PAGO a proveedor y la PERCEPCIÓN de IGTF generan asiento pero no guardan el
  -- enlace (el generador los trata como «sin backlink»): su cobertura se comprueba buscando el
  -- asiento por origen. Ninguno queda huérfano hoy —el caso de uso propaga el error y la
  -- transacción se revierte—, pero el invariante que no existe no caza nada (R-20, ADR-0065 §6).
  sin_enlace as (
    select 'payment_received'::text as k, p.id
      from public.payments p where p.company_id = p_company
       and not exists (select 1 from public.payment_reversals r where r.payment_id = p.id)
    union all
    select 'payment_made', sp.id
      from public.supplier_payments sp where sp.company_id = p_company
    union all
    select 'igtf_perception', ip.id
      from public.igtf_perceptions ip where ip.company_id = p_company
       and not exists (select 1 from public.payment_reversals r
                        where r.payment_id = ip.payment_id)
  ),
  -- La ND por IGTF (20261002100000) no tiene asiento propio: su asiento ES el de su percepción
  -- (backlink). El enunciado lo dice: queda cubierta si su percepción tiene asiento O está en cola
  -- (re-revisión 3, CLAUDE.md §3: se cambia el enunciado, no se perdona).
  nd_igtf as (
    select ip.debit_note_id as id,
           bool_or(exists (select 1 from public.journal_entries e
                            where e.company_id = p_company and e.source_kind = 'igtf_perception'
                              and e.source_id = ip.id and e.status in ('posted', 'reversed')))
             as con_asiento,
           bool_or(exists (select 1 from public.journal_generation_queue q
                            where q.company_id = p_company and q.source_id = ip.id
                              and q.status = 'pending')) as en_cola
      from public.igtf_perceptions ip
     where ip.company_id = p_company and ip.debit_note_id is not null
     group by ip.debit_note_id
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null or coalesce(n.con_asiento, false) as tiene_asiento,
           (exists (select 1 from public.journal_generation_queue q
                     where q.company_id = p_company and q.source_id = d.id
                       and q.status = 'pending')
            or (d.journal_entry_id is null and coalesce(n.en_cola, false))) as tiene_pendiente
      from documentos d
      left join nd_igtf n on n.id = d.id
    union all
    select s.k, s.id,
           exists (select 1 from public.journal_entries e
                    where e.company_id = p_company and e.source_id = s.id
                      and e.source_kind = s.k and e.status in ('posted', 'reversed')),
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = s.id
                      and q.status = 'pending')
      from sin_enlace s
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
  union all
  -- EL COBRO REVERSADO y su percepción (ADR-0075 §8): su asiento quedó `reversed` (o se
  -- descartó de la cola). Un asiento vivo o una fila pendiente es una reversa a medias.
  select x.k, x.id, 'reversal_not_posted'
    from (select 'payment_received'::text as k, r.payment_id as id
            from public.payment_reversals r where r.company_id = p_company
          union all
          select 'igtf_perception', ip.id
            from public.payment_reversals r
            join public.igtf_perceptions ip
              on ip.company_id = r.company_id and ip.payment_id = r.payment_id
           where r.company_id = p_company) x
   where exists (select 1 from public.journal_entries e
                  where e.company_id = p_company and e.source_id = x.id
                    and e.source_kind = x.k and e.status = 'posted')
      or exists (select 1 from public.journal_generation_queue q
                  where q.company_id = p_company and q.source_id = x.id
                    and q.status = 'pending')
  union all
  -- 20261005100000 (ADR-0082) · LA FACTURA DE RETIRO no tiene asiento propio: su asiento ES el de
  -- su salida del kardex (hecho inventory_move / stock.withdrawn). El enunciado lo dice: queda
  -- cubierta si ese hecho tiene asiento O espera en la cola. Sin valor (costo cero e IVA cero) no
  -- hay nada que asentar.
  select 'withdrawal_invoice', d.id, 'missing'
    from public.documents d
    join public.inventory_moves m on m.id = d.withdrawal_move_id
   where d.company_id = p_company and d.kind = 'withdrawal_invoice' and d.status = 'issued'
     and (m.functional_amount <> 0 or d.tax_amount <> 0)
     and not exists (select 1 from public.journal_entries e
                      where e.company_id = p_company and e.source_kind = 'inventory_move'
                        and e.source_id = m.id and e.source_event = 'stock.withdrawn'
                        and e.status in ('posted', 'reversed'))
     and not exists (select 1 from public.journal_generation_queue q
                      where q.company_id = p_company and q.source_kind = 'inventory_move'
                        and q.source_id = m.id and q.source_event = 'stock.withdrawn'
                        and q.status = 'pending')
  union all
  -- 20261005100500 (ADR-0082) · LA NOTA DE CRÉDITO DE UN RETIRO tampoco tiene asiento propio: su
  -- asiento ES el del reingreso de la mercancía (hecho inventory_move / stock.received, el
  -- contra-asiento del retiro). Cubierta si ese hecho tiene asiento O espera en la cola; y sin
  -- reingreso no hay hecho que la cubra: es un hueco.
  select 'withdrawal_credit_note', d.id, 'missing'
    from public.documents d
   where d.company_id = p_company and d.kind = 'withdrawal_credit_note' and d.status = 'issued'
     and not exists (select 1 from public.inventory_moves m
                      where m.company_id = p_company and m.source_document_id = d.id
                        and m.kind = 'entrada'
                        and ((m.functional_amount = 0 and d.tax_amount = 0)
                             or exists (select 1 from public.journal_entries e
                                         where e.company_id = p_company
                                           and e.source_kind = 'inventory_move'
                                           and e.source_id = m.id
                                           and e.source_event in ('stock.withdrawal_returned', 'stock.received')
                                           and e.status in ('posted', 'reversed'))
                             or exists (select 1 from public.journal_generation_queue q
                                         where q.company_id = p_company
                                           and q.source_kind = 'inventory_move'
                                           and q.source_id = m.id
                                           and q.source_event in ('stock.withdrawal_returned', 'stock.received')
                                           and q.status = 'pending')))
$function$;

-- ── 5. withdrawal_note_gaps ─────────────────────────────────────────────────
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
