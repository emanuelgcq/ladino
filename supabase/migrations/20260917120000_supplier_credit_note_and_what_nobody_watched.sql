-- =============================================================================
-- Ladino — migración 67 · LA NOTA DEL PROVEEDOR, LA FACTURA ANULADA Y LO QUE
--                         NADIE VIGILABA (ADR-0065 §§1, 2, 4, 5, 6)
--
-- QA fiscal del 2026-09-17. Medido en la base, con una factura de proveedor de
-- 1.600 de IVA, otra ANULADA de 800 y una nota de crédito recibida de 800:
-- el libro de compras decía 2.400 de crédito fiscal, la planilla decía 1.600 y
-- lo correcto son 800. La nota de crédito no generaba asiento ninguno.
--
-- Lo que hace esta migración:
--   1. la nota de crédito recibida se asienta: columna de enlace, hecho del
--      preset y plantilla para las empresas que ya lo importaron;
--   2. el libro de compras la registra, y registra las facturas ANULADAS con
--      importes en CERO — la traza documental sin inflar el crédito fiscal;
--   3. la declaración de IVA resta las notas recibidas del período;
--   4. `accounting_coverage_gaps` vigila cuatro fuentes más: nota de crédito de
--      proveedor, cobro, pago a proveedor y percepción de IGTF;
--   5. una línea nueva en un asiento POSTEADO se rechaza (la protección cubría
--      UPDATE y DELETE, no INSERT);
--   6. los controles de inventario distinguen la causa: los movimientos de un
--      documento ANULADO que netea a cero no son un hueco, y el invariante
--      kardex ↔ mayor respeta el corte de la regularización.
--
-- NORMA (respuestas verificadas por el dueño, 2026-09-17; ADR-0065 §1 y §2):
--   · LIVA art. 56: se registran las notas que se emitan o RECIBAN.
--   · LIVA art. 37: se deduce del crédito fiscal el impuesto de las operaciones
--     posteriormente anuladas, en el período en que ocurre la anulación.
--   · Reglamento de la LIVA art. 70: los libros registran las notas
--     modificatorias, cronológicamente y sin atrasos.
--   · Reglamento art. 75 literal a: el libro de compras registra fecha y número
--     de la factura, nota de débito o de crédito.
--   · Reglamento art. 11: la devolución de mercancía no es venta nueva.
--   · PERÍODO de la nota: el de su RECEPCIÓN, no el de la factura que corrige.
--
-- Reversibilidad: funciones (se restauran sus versiones de las migraciones 27,
-- 58, 59, 61 y 65), una columna aditiva y una plantilla nueva. Los asientos ya
-- generados no se reescriben. Con notas de crédito ya asentadas, quitar la
-- plantilla no borra sus asientos: se corrigen con contra-asiento.
-- HOMOLOGATION_IMPACT = YES en contenido (crédito fiscal declarado y libro de
-- compras). Pasa por fiscal-reviewer.
-- =============================================================================

-- ── 1. La nota de crédito recibida puede enlazar su asiento ─────────────────
alter table public.supplier_credit_notes
  add column journal_entry_id uuid;
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_journal_fk
  foreign key (journal_entry_id) references public.journal_entries (id);
create index supplier_credit_notes_journal_idx
  on public.supplier_credit_notes (journal_entry_id)
  where journal_entry_id is not null;
comment on column public.supplier_credit_notes.journal_entry_id is
  'El asiento que la nota produjo. Antes la tabla NI SIQUIERA tenía dónde guardarlo: '
  'la nota bajaba la deuda con el proveedor y el mayor seguía debiendo el bruto (ADR-0065 §1).';

-- ── 2. El hecho del preset, y las empresas que ya lo importaron ─────────────
-- La nota DEVUELVE mercancía: cancela deuda con el proveedor (débito a cuentas
-- por pagar) y revierte lo que la factura cargó — inventario y crédito fiscal,
-- o inventario por el total si el IVA no es recuperable (ADR-0040 §7).
do $$
declare
  v_entry uuid;
begin
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'purchase_credit_note', 'ap.credit_note_received',
          'Nota de crédito del proveedor: baja la deuda y revierte inventario e IVA crédito fiscal')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'ap_general',        'total',      'debit',  'always',
     'Se le debe menos al proveedor: por el total de la nota'),
    (v_entry, 2, 'inventory_general', 'subtotal',   'credit', 'if_tax_recoverable',
     'Contribuyente ordinario: sale del inventario la base devuelta'),
    (v_entry, 3, 'iva_credit_fiscal', 'tax_amount', 'credit', 'if_tax_recoverable',
     'y se deduce el crédito fiscal de la operación anulada (LIVA art. 37)'),
    (v_entry, 4, 'inventory_general', 'total',      'credit', 'if_tax_not_recoverable',
     'Contribuyente formal: el IVA era costo, así que sale con él');
end $$;

do $$
declare
  v_c record;
  v_e record;
  v_tpl uuid;
begin
  for v_c in select distinct t.company_id, t.tenant_id from public.journal_templates t loop
    for v_e in
      select e.id, e.source_kind, e.source_event, e.description
        from public.journal_template_preset_entries e
       where e.preset_code = 've_basico' and e.source_kind = 'purchase_credit_note'
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
        from public.journal_template_preset_lines l where l.entry_id = v_e.id
       order by l.line_number;
    end loop;
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (v_c.tenant_id, v_c.company_id, 'company', v_c.company_id,
            'accounting.templates_imported', 'system', now(), 'db-migration',
            jsonb_build_object('origin', 'migration_20260917120000', 'preset_code', 've_basico',
                               'facts', 'purchase_credit_note'));
  end loop;
end $$;

-- Que los papeles de la plantilla nueva tengan cuenta en el plan (LAD83, la
-- lección de la migración 58: un `on conflict do nothing` deja el papel mudo).
do $$
begin
  if exists (
    select 1 from unnest(array['ap_general', 'inventory_general', 'iva_credit_fiscal']) as p(code)
     where not exists (select 1 from public.chart_template_accounts a
                        where a.template_code = 've_basico' and a.suggested_purpose = p.code)) then
    raise exception 'LAD83: un papel de la nota de crédito de proveedor no tiene cuenta en ve_basico'
      using errcode = 'LAD83';
  end if;
end $$;

-- ── 3. El libro de compras: la nota entra; la anulada, en cero ──────────────
create or replace function platform.purchases_book(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric,
  base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric, total_amount numeric,
  tax_is_recoverable boolean, journal_entry_id uuid)
language sql
stable
set search_path = ''
as $$
  -- LIBRO DE COMPRAS EN MONEDA FUNCIONAL (migración 65): cada documento a la tasa con la que se
  -- asentó. Tres reglas, con su norma:
  --   · la factura ANULADA se registra con importes en CERO: conserva la traza cronológica que
  --     pide el Reglamento art. 70 sin llevar al libro un crédito fiscal que la Ley art. 37
  --     manda deducir;
  --   · la NOTA DE CRÉDITO recibida se registra como documento propio, en NEGATIVO, en el
  --     período de su recepción (LIVA arts. 56 y 37; Reglamento arts. 70 y 75 lit. a);
  --   · una nota anulada, como la factura anulada: en cero.
  with f as (
    select i.*,
           case when i.status = 'annulled' then 0 else round(i.tax_amount * i.fx_rate, 8) end
             as iva_func,
           case when i.status = 'annulled' then 0 else round(i.subtotal_amount * i.fx_rate, 8) end
             as sub_func,
           case when i.status = 'annulled' then 0 else 1 end as factor
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid', 'annulled')
       and i.invoice_date between p_from and p_to
  ),
  facturas as (
    select f.id, f.invoice_date, s.tax_id, s.legal_name, s.supplier_kind,
           f.supplier_document_number, f.supplier_control_number, f.supplier_document_ref,
           f.status, f.transaction_currency, f.fx_rate,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, 8)
             * f.factor as base_gravada,
           case when f.tax_is_recoverable then f.iva_func else 0 end as iva_credito,
           case when f.tax_is_recoverable then 0 else f.iva_func end as iva_al_costo,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, 8)
             * f.factor as base_exenta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, 8)
             * f.factor as base_exonerada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, 8)
             * f.factor as base_no_sujeta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment is null), 0) * f.fx_rate, 8)
             * f.factor as base_sin_clasificar,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'iva'
                        and r.status <> 'cancelled'), 0) * f.factor as retenido_iva,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'islr'
                        and r.status <> 'cancelled'), 0) * f.factor as retenido_islr,
           f.sub_func + f.iva_func as total_amount,
           f.tax_is_recoverable, f.journal_entry_id
      from f
      join public.suppliers s on s.id = f.supplier_id
      left join public.supplier_invoice_lines l on l.supplier_invoice_id = f.id
     group by f.id, f.invoice_date, f.supplier_document_number, f.supplier_control_number,
              f.supplier_document_ref, f.status, f.transaction_currency, f.fx_rate,
              f.tax_is_recoverable, f.journal_entry_id, f.iva_func, f.sub_func, f.factor,
              s.tax_id, s.legal_name, s.supplier_kind
  ),
  notas as (
    select n.id, n.note_date,
           s.tax_id, s.legal_name, s.supplier_kind,
           n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
           n.status, n.transaction_currency, n.fx_rate,
           case when n.status = 'annulled' then 0 else 1 end as factor,
           round(n.subtotal_amount * n.fx_rate, 8) as sub_func,
           round(n.tax_amount * n.fx_rate, 8) as iva_func,
           i.tax_is_recoverable, n.journal_entry_id
      from public.supplier_credit_notes n
      join public.suppliers s on s.id = n.supplier_id
      join public.supplier_invoices i on i.id = n.supplier_invoice_id
     where n.company_id = p_company
       and n.status in ('posted', 'annulled')
       and n.note_date between p_from and p_to
  )
  select * from facturas
  union all
  select n.id, n.note_date, n.tax_id, n.legal_name, n.supplier_kind,
         n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
         n.status, n.transaction_currency, n.fx_rate,
         -n.sub_func * n.factor,
         case when n.tax_is_recoverable then -n.iva_func * n.factor else 0 end,
         case when n.tax_is_recoverable then 0 else -n.iva_func * n.factor end,
         0, 0, 0, 0, 0, 0,
         -(n.sub_func + n.iva_func) * n.factor,
         n.tax_is_recoverable, n.journal_entry_id
    from notas n
   order by 2, 6
$$;
comment on function platform.purchases_book(uuid, date, date) is
  'Libro de compras en MONEDA FUNCIONAL, con la tasa de cada documento. Incluye las NOTAS DE '
  'CRÉDITO recibidas, en negativo y en el período de su recepción (LIVA arts. 56 y 37; '
  'Reglamento arts. 70 y 75 lit. a), y registra las ANULADAS con importes en cero: la traza '
  'documental sin el crédito fiscal (ADR-0065 §§1-2).';

-- ── 4. La declaración resta las notas recibidas ─────────────────────────────
-- Se reemplaza la función ENTERA con la versión vigente (migración 65) y un único cambio: el
-- CTE `cred`. Copiarla completa es deliberado — reescribirla de memoria fue el primer borrador
-- de esta migración y perdía tres columnas del resultado.
create or replace function platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with ventas as (
    -- TODO en moneda funcional: la base es el subtotal funcional del renglón y el
    -- impuesto es total − subtotal funcionales, la misma derivación con la que el
    -- documento congela su IVA y el mayor lo asienta (sales.ts, insertarDocumento).
    -- `tax_amount` del renglón está en la moneda de la TRANSACCIÓN: sumarlo
    -- declaraba dólares como bolívares (QA 2026-09-15, h. 63).
    select case d.kind when 'credit_note' then -1 else 1 end as signo,
           l.tax_rate_snapshot as alicuota,
           l.line_subtotal_functional as base,
           (l.line_total_functional - l.line_subtotal_functional) as impuesto,
           l.tax_amount as impuesto_transaccion,
           d.kind
      from public.documents d
      join public.document_lines l on l.document_id = d.id
     where d.company_id = p_company
       and d.kind in ('invoice', 'credit_note', 'debit_note')
       and d.status in ('issued', 'paid')
       and (d.issued_at at time zone 'America/Caracas')::date between p_from and p_to
  ),
  por_alicuota as (
    select alicuota,
           sum(signo * base) as base,
           sum(signo * impuesto) as impuesto
      from ventas group by alicuota
  ),
  deb as (select coalesce(sum(impuesto), 0) as total from por_alicuota),
  bases_venta as (
    select coalesce(sum(signo * base) filter (where impuesto_transaccion <> 0), 0) as gravadas,
           coalesce(sum(signo * base) filter (where impuesto_transaccion = 0), 0) as sin_impuesto
      from ventas
  ),
  cred as (
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó, MENOS el de las NOTAS
    -- DE CRÉDITO recibidas en el período. LIVA art. 37: el impuesto de la operación
    -- posteriormente anulada se deduce del crédito fiscal; art. 56: se registran las notas que
    -- se emitan o RECIBAN. El período es el de la NOTA, no el de la factura que corrige.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, 8))
                       from public.supplier_invoices i
                      where i.company_id = p_company
                        and i.status in ('posted', 'paid')
                        and i.tax_is_recoverable
                        and i.invoice_date between p_from and p_to), 0)
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, 8))
                       from public.supplier_credit_notes n
                       join public.supplier_invoices i on i.id = n.supplier_invoice_id
                      where n.company_id = p_company
                        and n.status = 'posted'
                        and i.tax_is_recoverable
                        and n.note_date between p_from and p_to), 0) as total
  ),
  ret as (
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and r.retained_on between p_from and p_to
  ),
  prorrata as (
    -- GLOBAL v1 (H-11, VALIDAR-TRIBUTARIO): solo cuando hubo ventas sin
    -- impuesto en el período; pct = gravadas / (gravadas + sin impuesto).
    select case
             when b.sin_impuesto > 0 and (b.gravadas + b.sin_impuesto) > 0
               then round(b.gravadas / (b.gravadas + b.sin_impuesto), 8)
             else null
           end as pct
      from bases_venta b
  ),
  calc as (
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones
      from deb d, cred c, ret r, prorrata p
  )
  select
    calc.debitos, calc.creditos, calc.deducibles, calc.pct, calc.retenciones,
    greatest(0, calc.debitos - calc.deducibles - p_excedente_anterior - calc.retenciones)
      as cuota_a_pagar,
    greatest(0, -(calc.debitos - calc.deducibles - p_excedente_anterior - calc.retenciones))
      as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle
  from calc
$function$;

comment on function platform.recompute_iva_period(uuid, date, date, numeric) is
  'La planilla del período en BOLÍVARES (migración 65) con las NOTAS DE CRÉDITO recibidas '
  'restadas del crédito fiscal, en el período de la nota (LIVA arts. 37 y 56; ADR-0065 §1). '
  'La prorrata sigue siendo global v1 con su VALIDAR-TRIBUTARIO (P-25).';

-- ── 5. La cobertura contable mira también el dinero ─────────────────────────
create or replace function platform.accounting_coverage_gaps(p_company uuid)
returns table (source_kind text, source_id uuid, problem text)
language sql
stable
set search_path = ''
as $$
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
    union all
    select 'payment_made', sp.id
      from public.supplier_payments sp where sp.company_id = p_company
    union all
    select 'igtf_perception', ip.id
      from public.igtf_perceptions ip where ip.company_id = p_company
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null as tiene_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as tiene_pendiente
      from documentos d
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
$$;
comment on function platform.accounting_coverage_gaps(uuid) is
  'INVARIANTE: todo hecho posteado tiene asiento O fila en cola, nunca ninguno y nunca los dos. '
  'Catorce fuentes: los documentos de venta, la factura y la NOTA DE CRÉDITO de compra, el '
  'gasto, el cierre, el reembolso, la transferencia, y —por origen, que no guardan enlace— el '
  'cobro, el pago a proveedor y la percepción de IGTF (ADR-0065 §§1 y 6).';

-- ── 6. Una línea nueva en un asiento posteado se rechaza ────────────────────
-- La protección de `journal_lines` cubría UPDATE y DELETE. El trigger que cuadra el asiento
-- cuelga de `journal_entries`, así que un INSERT posterior al posteo rompía Σdébitos =
-- Σcréditos sin que nada mirara. Ningún camino del código lo hace: por eso mismo tiene que
-- fallar solo (CLAUDE.md §2, ADR-0065 §4).
create or replace function platform.assert_line_insert_only_on_draft()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_status text;
begin
  select e.status into v_status from public.journal_entries e where e.id = new.entry_id;
  if v_status is not null and v_status <> 'draft' then
    raise exception
      'no se agrega una línea a un asiento %: un asiento posteado se corrige con su reverso',
      v_status
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
create trigger journal_lines_02_insert_guard
  before insert on public.journal_lines
  for each row execute function platform.assert_line_insert_only_on_draft();
revoke execute on function platform.assert_line_insert_only_on_draft() from public;

-- ── 7. Los controles de inventario distinguen la causa ──────────────────────
-- Anular una venta cuyo costo de lo vendido seguía EN COLA descartaba la fila pendiente y no
-- posteaba reverso: los movimientos quedaban sin asiento y sin cola, y el control los contaba
-- como huecos. No lo son: el kardex de ese documento netea a cero y no hay nada que asentar.
-- Un rojo que no distingue causas enseña a ignorarlo (ADR-0065 §5).
create or replace function platform.inventory_coverage_gaps(p_company uuid)
returns table (move_id uuid, kind text, problem text)
language sql
stable
set search_path = ''
as $$
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
                                            'purchase_revaluation')
                      and e.source_id in (mv.id, mv.source_document_id)) as asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.status = 'pending'
                      and q.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                            'stock_opening', 'goods_receipt', 'sales_return',
                                            'purchase_revaluation')
                      and q.source_id in (mv.id, mv.source_document_id)) as cola
      from movs mv
  )
  select id, kind, case when not asiento and not cola then 'missing' else 'duplicated' end
    from estado
   where (not asiento and not cola) or (asiento and cola)
$$;
comment on function platform.inventory_coverage_gaps(uuid) is
  'Todo movimiento que cambia el valor del inventario posterior al corte tiene asiento O fila '
  'pendiente. Fuera: las transferencias (no cambian el valor) y los movimientos de un documento '
  'ANULADO que netea a cero — ahí no hay nada que asentar (ADR-0060 §5, ADR-0065 §5).';

-- El invariante estricto respeta el MISMO corte que su hermana. Sin esto, la primera empresa
-- regularizada lo dejaría en rojo para siempre y un invariante que nace rojo está muerto.
create or replace function platform.inventory_ledger_gap(p_company uuid)
returns table (kardex numeric, mayor numeric, diferencia numeric, en_cola numeric)
language sql
stable
set search_path = ''
as $$
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
                    where jq.company_id = p_company and jq.status = 'pending'
                      and jq.source_kind in ('inventory_move', 'landed_cost', 'sales_cost',
                                             'stock_opening', 'goods_receipt', 'sales_return',
                                             'purchase_revaluation')
                      and jq.source_id in (m.id, m.source_document_id))
  )
  select k.v, l.v, k.v - l.v, q.v from k, l, q
$$;
comment on function platform.inventory_ledger_gap(uuid) is
  'INVARIANTE (ADR-0060 §5): valor del kardex − saldo del mayor de inventario, DESDE EL CORTE '
  '(`inventory_ledger_cutovers`), igual que inventory_coverage_gaps. diferencia TIENE que ser 0. '
  'Antes sumaba el kardex entero: la primera empresa regularizada lo habría dejado en rojo para '
  'siempre (ADR-0065 §5).';
