-- =============================================================================
-- Ladino — migración 45: notas de débito/crédito directas y el cierre de R-20
--
-- Módulo: ventas · contabilidad · fiscal. Spec: ADR-0051.
--
-- Cuatro cosas, todas del mismo ADR:
--   1. el vocabulario `source_kind` gana 'sales_debit_note' en sus TRES casas
--      (la trampa documentada en la migración 37: se copia la lista VIGENTE);
--   2. el preset `ve_basico` gana TRES asientos: la NC emitida, la ND emitida
--      y la APLICACIÓN de saldo a favor (que hoy asentaría contra caja sin
--      que entrara efectivo) — con su papel nuevo, «Saldos a favor de
--      clientes» (VALIDAR-CONTABLE, como todo el preset);
--   3. `accounting_coverage_gaps` APRENDE credit_note y debit_note (hoy una
--      NC sin asiento ni siquiera aparece como hueco — R-20), y las NC
--      emitidas ANTES de la plantilla se ENCOLAN aquí con razón explícita:
--      quedan a la vista en «Pendientes de contabilizar», no escondidas;
--   4. `ar_aging` deja de mirar solo 'invoice': una ND es deuda, y un RECIBO
--      fiado (posible desde el botón Fiar) también — mismo enunciado, familia
--      completa: ('invoice','receipt','debit_note').
--
-- Reversibilidad: CHECKs y función se restauran con la lista/versión previa;
-- las filas de preset y el papel se retiran con delete; las filas ENCOLADAS
-- son de la cola (no append-only). Los asientos que nazcan después NO se
-- revierten (regla nº 2: se reversa, no se borra).
-- Impacto de homologación: NO — kinds, numeración y triggers ya existían; el
-- signo de NC/ND en el libro de ventas sigue VALIDAR-SENIAT como está.
-- =============================================================================

-- ── 1. El vocabulario, en sus tres casas (lista VIGENTE + lo nuevo) ─────────

alter table public.journal_entries
  drop constraint journal_entries_source_kind_chk;
alter table public.journal_entries
  add constraint journal_entries_source_kind_chk
  check (source_kind in (
    'manual', 'sales_invoice', 'sales_credit_note', 'payment_received',
    'purchase_invoice', 'purchase_credit_note', 'payment_made', 'goods_receipt',
    'inventory_move', 'retention_receipt', 'landed_cost', 'landed_cost_variance',
    'exchange_diff', 'period_close', 'year_end_close', 'expense', 'cash_closing',
    'sales_receipt', 'sales_debit_note'));

alter table public.journal_templates
  drop constraint journal_templates_source_kind_chk;
alter table public.journal_templates
  add constraint journal_templates_source_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note'));

alter table public.journal_template_preset_entries
  drop constraint journal_template_preset_entries_kind_chk;
alter table public.journal_template_preset_entries
  add constraint journal_template_preset_entries_kind_chk
  check (source_kind in (
    'sales_invoice', 'sales_credit_note', 'payment_received', 'purchase_invoice',
    'purchase_credit_note', 'payment_made', 'goods_receipt', 'inventory_move',
    'retention_receipt', 'landed_cost', 'landed_cost_variance', 'exchange_diff',
    'expense', 'cash_closing', 'sales_receipt', 'sales_debit_note'));

-- ── 2. El papel nuevo y los tres asientos del preset ────────────────────────

insert into public.account_purposes (code, name, description) values
  ('customer_credit_liability', 'Saldos a favor de clientes',
   'Lo que la empresa le debe a sus clientes por notas de crédito: un pasivo '
   'que baja cuando el saldo se aplica a una factura. VALIDAR-CONTABLE.')
on conflict (code) do nothing;

-- Su cuenta en la plantilla `ve_basico`, para que el import la cubra. El
-- código 2.1.3 cuelga del pasivo corriente de la plantilla.
insert into public.chart_template_accounts
  (template_code, code, name, parent_code, kind, nature, is_leaf, level, suggested_purpose)
select 've_basico', '2.1.90', 'Saldos a favor de clientes', '2.1', 'pasivo',
       'acreedora', true, 3, 'customer_credit_liability'
 where not exists (select 1 from public.chart_template_accounts
                    where template_code = 've_basico' and code = '2.1.90');

do $$
declare
  v_entry uuid;
begin
  -- NC de venta (por devolución o directa): el ingreso y su IVA se degradan,
  -- y nace el pasivo con el cliente — el `customer_credit` es su subledger.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_credit_note', 'fiscal.credit_note.issued',
          'Nota de crédito emitida: menos ingreso y menos IVA débito, contra el saldo a favor del cliente')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'income_general', 'subtotal', 'debit', 'always',
     'El ingreso que se corrige, sin el impuesto'),
    (v_entry, 2, 'iva_debit_fiscal', 'tax_amount', 'debit', 'if_amount_nonzero',
     'El IVA repercutido que deja de deberse al fisco'),
    (v_entry, 3, 'customer_credit_liability', 'total', 'credit', 'always',
     'El total queda como saldo a favor del cliente hasta aplicarse');

  -- ND de venta: el espejo de la factura — más deuda del cliente.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'sales_debit_note', 'fiscal.debit_note.issued',
          'Nota de débito emitida: más cuentas por cobrar contra ingresos e IVA débito')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'ar_general', 'total', 'debit', 'always',
     'El cliente debe también la nota, impuesto incluido'),
    (v_entry, 2, 'income_general', 'subtotal', 'credit', 'always',
     'El ingreso adicional es la base, sin el impuesto'),
    (v_entry, 3, 'iva_debit_fiscal', 'tax_amount', 'credit', 'if_amount_nonzero',
     'El IVA repercutido adicional es deuda con el fisco');

  -- APLICAR saldo a favor: no entra efectivo — baja el pasivo con el cliente.
  -- El dominio distingue el evento ('ar.credit_applied' en vez de
  -- 'ar.payment_applied') exactamente para que ESTA plantilla aplique.
  insert into public.journal_template_preset_entries
    (preset_code, source_kind, source_event, description)
  values ('ve_basico', 'payment_received', 'ar.credit_applied',
          'Saldo a favor aplicado: baja el pasivo con el cliente contra sus cuentas por cobrar — no entra efectivo')
  returning id into v_entry;
  insert into public.journal_template_preset_lines
    (entry_id, line_number, account_purpose, amount_source, side, condition_kind, description)
  values
    (v_entry, 1, 'customer_credit_liability', 'functional_amount', 'debit', 'always',
     'El saldo a favor que se consume'),
    (v_entry, 2, 'ar_general', 'total', 'credit', 'always',
     'Lo que deja de deberse, a la tasa de la emisión'),
    (v_entry, 3, 'exchange_gain', 'exchange_difference', 'credit', 'if_positive',
     'Si la tasa subió, la diferencia es ganancia cambiaria'),
    (v_entry, 4, 'exchange_loss', 'exchange_difference', 'debit', 'if_negative',
     'Si bajó, es pérdida — se reconoce, no se absorbe');
end $$;

-- ── 3. La cobertura APRENDE las notas, y las huérfanas se encolan ───────────
-- Base: la versión VIGENTE (migración 37). Mismo enunciado, familia completa.

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
    select 'purchase_invoice', i.id, i.journal_entry_id
      from public.supplier_invoices i
     where i.company_id = p_company and i.status in ('posted', 'paid')
    union all
    select 'expense', e.id, e.journal_entry_id
      from public.expenses e
     where e.company_id = p_company
    union all
    select 'cash_closing', c.id, c.journal_entry_id
      from public.cash_closings c
     where c.company_id = p_company and c.amount_transaction_currency <> 0
  ),
  estado as (
    select d.k, d.id,
           d.journal_entry_id is not null as tiene_asiento,
           exists (select 1 from public.journal_generation_queue q
                    where q.company_id = p_company and q.source_id = d.id
                      and q.status = 'pending') as tiene_pendiente
      from documentos d
  )
  select k, id,
         case when not tiene_asiento and not tiene_pendiente then 'missing'
              else 'duplicated' end
    from estado
   where (not tiene_asiento and not tiene_pendiente)
      or (tiene_asiento and tiene_pendiente)
$$;

-- Las NC emitidas ANTES de esta migración quedaron sin asiento Y sin cola
-- (R-20). Se ENCOLAN con razón explícita y su contexto monetario CONGELADO
-- del documento (el contrato de la cola): la pantalla de pendientes las
-- enseña, y el reproceso las asienta cuando la empresa importe las plantillas
-- nuevas. Nada se asienta aquí: una migración no inventa efectos contables.
select set_config('ladino.actor_id', '00000000-0000-4000-8000-000000000000', true);
insert into public.journal_generation_queue
  (tenant_id, company_id, source_kind, source_id, source_event, context, reason, status)
select d.tenant_id, d.company_id, 'sales_credit_note', d.id,
       'fiscal.credit_note.issued',
       jsonb_build_object(
         'subtotal', d.subtotal_amount::text,
         'tax_amount', d.tax_amount::text,
         'total', d.total_amount::text,
         'functional_currency', d.functional_currency,
         'posting_date', d.issued_at::date::text,
         'description', 'Nota de crédito ' || d.series || '-' || coalesce(d.document_number::text, '')),
       'NC emitida antes de la plantilla de notas (migración 45, R-20): '
       'importa el preset ve_basico y reprocesa.',
       'pending'
  from public.documents d
 where d.kind = 'credit_note' and d.status in ('issued', 'paid')
   and d.journal_entry_id is null
   and not exists (select 1 from public.journal_generation_queue q
                    where q.company_id = d.company_id and q.source_id = d.id
                      and q.source_event = 'fiscal.credit_note.issued')
on conflict do nothing;

-- ── 4. El aging con la familia completa de la deuda ─────────────────────────
-- Misma semántica (saldo funcional de la emisión, solo positivos); la familia
-- pasa de 'invoice' a ('invoice','receipt','debit_note') — ADR-0051: toda
-- consulta de deuda usa el TRÍO, sin filtros a medias.

create or replace function platform.ar_aging(
  p_company uuid, p_customer uuid default null, p_reference date default current_date
)
returns table (
  customer_id uuid, bucket text, document_count bigint, amount numeric
)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select d.customer_id, d.id,
           (p_reference - d.issued_at::date) as dias,
           d.total_amount - coalesce((select sum(p.functional_amount) from public.payments p
                                       where p.document_id = d.id), 0) as saldo
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and d.issued_at::date <= p_reference
  )
  select s.customer_id,
         case when s.dias <= 30 then '0-30'
              when s.dias <= 60 then '31-60'
              when s.dias <= 90 then '61-90'
              else '90+' end,
         count(*), sum(s.saldo)
    from saldos s
   where s.saldo > 0
   group by 1, 2
   order by 1, 2
$$;
