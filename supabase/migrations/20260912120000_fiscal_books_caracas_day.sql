-- =============================================================================
-- Migración 48 · LOS LIBROS FISCALES Y LA ANTIGÜEDAD MIRAN EL DÍA DE CARACAS
--
-- Hallazgo A-23 de la auditoría del 2026-09-11 (ADR-0054). `sales_book`, los
-- dos libros de retenciones y `ar_aging` cortaban el período con
-- `issued_at::date`: el cast de un `timestamptz` a `date` usa la zona de la
-- SESIÓN, que en la API es UTC. Mientras, `recompute_iva_period` (migración 46)
-- corta con `at time zone 'America/Caracas'`. Una factura emitida el 31 a las
-- 20:00-23:59 de Venezuela iba a SEPTIEMBRE en la declaración y a OCTUBRE en el
-- libro de ventas — y eso es lo que una fiscalización compara.
--
-- Es la familia de bugs de CLAUDE.md §3 (sexta aparición), cerrada en el
-- esquema con una sola función de corte, `platform.caracas_day()`, que es la
-- que TODA proyección fiscal usa desde hoy. Reversible: `create or replace`
-- con la versión anterior de cada función.
-- =============================================================================

-- ── 1. El corte único ────────────────────────────────────────────────────────
create or replace function platform.caracas_day(p_instante timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select (p_instante at time zone 'America/Caracas')::date
$$;
comment on function platform.caracas_day(timestamptz) is
  'El día calendario de Venezuela al que pertenece un instante. Es el ÚNICO corte '
  'admitido para libros, períodos y antigüedad: `::date` a secas usa la zona de la '
  'sesión (UTC en la API) y manda las ventas nocturnas de fin de mes al mes siguiente.';
revoke execute on function platform.caracas_day(timestamptz) from public;
grant execute on function platform.caracas_day(timestamptz) to ladino_api, ladino_worker;

-- ── 2. Libro de ventas ───────────────────────────────────────────────────────
create or replace function platform.sales_book(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text,
  customer_tax_id text, customer_name text, customer_taxpayer_type text,
  transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric,
  total_amount numeric, journal_entry_id uuid
)
language sql
stable
set search_path = ''
as $$
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         c.tax_id, c.legal_name, c.taxpayer_type_code,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'gravado'), 0),
         d.tax_amount,
         coalesce(sum(dl.line_subtotal_transaction) filter (where dl.tax_treatment = 'exento'), 0),
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'exonerado'), 0),
         coalesce(sum(dl.line_subtotal_transaction)
                  filter (where dl.tax_treatment = 'no_sujeto'), 0),
         -- Lo emitido ANTES de la migración 27 no tiene tratamiento. Va a su
         -- propia columna, VISIBLE, en vez de sumarse a una que no le toca.
         coalesce(sum(dl.line_subtotal_transaction) filter (where dl.tax_treatment is null), 0),
         d.total_amount, d.journal_entry_id
    from public.documents d
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     -- ANULADA SÍ APARECE, con su estado: el libro registra el correlativo
     -- consumido. Omitirla dejaría un hueco de numeración inexplicable.
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, c.tax_id, c.legal_name, c.taxpayer_type_code
   order by d.issued_at, d.series, d.document_number
$$;

-- ── 3. Libros de retenciones ─────────────────────────────────────────────────
create or replace function platform.iva_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, supplier_tax_id text, supplier_name text,
  supplier_document_number text, supplier_control_number text, invoice_date date,
  base_amount numeric, rate numeric, retained_amount numeric,
  legal_source text, receipt_status text
)
language sql
stable
set search_path = ''
as $$
  select r.id, rc.receipt_number, rc.series, rc.fiscal_period, platform.caracas_day(rc.issued_at),
         s.tax_id, s.legal_name, i.supplier_document_number, i.supplier_control_number,
         i.invoice_date, r.base_amount, r.rate_snapshot, r.retained_amount,
         -- La norma con la que se retuvo, COPIADA en la retención (ADR-0039).
         -- Sin ella el libro no es auditable: dice cuánto, no con qué derecho.
         r.legal_source_snapshot, rc.status
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
   where r.company_id = p_company and r.retention_code = 'iva' and r.status <> 'cancelled'
     and coalesce(platform.caracas_day(rc.issued_at), i.invoice_date) between p_from and p_to
   order by rc.receipt_number nulls last, i.invoice_date
$$;

create or replace function platform.islr_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, supplier_tax_id text, supplier_name text, concept_code text,
  concept_name text, formula_kind text,
  supplier_document_number text, invoice_date date,
  base_amount numeric, rate numeric, subtrahend numeric, retained_amount numeric,
  legal_source text, receipt_status text
)
language sql
stable
set search_path = ''
as $$
  select r.id, rc.receipt_number, rc.series, rc.fiscal_period, platform.caracas_day(rc.issued_at),
         s.tax_id, s.legal_name, r.concept_code, cn.name, r.formula_kind,
         i.supplier_document_number, i.invoice_date,
         r.base_amount, r.rate_snapshot, r.subtrahend_snapshot, r.retained_amount,
         r.legal_source_snapshot, rc.status
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    join public.retention_concepts cn on cn.code = r.concept_code
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
   where r.company_id = p_company and r.retention_code = 'islr' and r.status <> 'cancelled'
     and coalesce(platform.caracas_day(rc.issued_at), i.invoice_date) between p_from and p_to
   order by rc.receipt_number nulls last, i.invoice_date
$$;

-- ── 4. Saldo en la moneda del documento ─────────────────────────────────────
-- Un cobro en otra moneda se valora con la tasa doc→funcional DEL DÍA DEL
-- PAGO; ese día era `paid_at::date` (UTC). Un cobro de las 21:00 de Caracas se
-- valoraba con la tasa de mañana — o no encontraba tasa y rechazaba el saldo.
create or replace function platform.document_balance_transaction(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_paid numeric := 0;
  v_p record;
  v_rate numeric;
begin
  select d.id, d.transaction_currency, d.functional_currency,
         d.amount_transaction_currency
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  for v_p in
    select p.currency, p.amount, p.functional_amount,
           platform.caracas_day(p.paid_at) as paid_on
      from public.payments p where p.document_id = v_doc.id
  loop
    if v_p.currency = v_doc.transaction_currency then
      v_paid := v_paid + v_p.amount;
    else
      -- El cobro vino en otra moneda: se valora en la del documento con la
      -- tasa doc→funcional DEL DÍA DEL PAGO. Sin tasa no se inventa.
      v_rate := platform.rate_at(v_doc.transaction_currency, v_doc.functional_currency,
                                 v_p.paid_on);
      if v_rate is null then
        raise exception
          'no hay tasa % → % vigente al % para valorar un cobro: cárgala con su fuente',
          v_doc.transaction_currency, v_doc.functional_currency, v_p.paid_on
          using errcode = 'LAD51';
      end if;
      v_paid := v_paid + round(v_p.functional_amount / v_rate, 8);
    end if;
  end loop;

  return v_doc.amount_transaction_currency - v_paid;
end;
$$;

-- `document_debt_today` valoraba la deuda con `current_date` (UTC): a las
-- 21:00 de Caracas ya pedía la tasa de mañana.
create or replace function platform.document_debt_today(p_company uuid, p_document uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_doc record;
  v_rate numeric;
begin
  select d.transaction_currency, d.functional_currency
    into v_doc
    from public.documents d
   where d.id = p_document and d.company_id = p_company
     and d.status in ('issued', 'paid');
  if not found then return null; end if;

  if v_doc.transaction_currency = v_doc.functional_currency then
    return platform.document_balance(p_company, p_document);
  end if;

  v_rate := platform.rate_at(v_doc.transaction_currency, v_doc.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda: cárgala con su fuente',
      v_doc.transaction_currency, v_doc.functional_currency
      using errcode = 'LAD51';
  end if;
  return round(platform.document_balance_transaction(p_company, p_document) * v_rate, 8);
end;
$$;

-- ── 5. Antigüedad de la cartera ──────────────────────────────────────────────
-- `p_reference` por omisión era `current_date` (UTC): a las 21:00 de Caracas la
-- cartera envejecía un día antes de tiempo. Ahora el día de referencia también
-- es el de Venezuela.
create or replace function platform.ar_aging(
  p_company uuid, p_customer uuid default null,
  p_reference date default (now() at time zone 'America/Caracas')::date
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
           (p_reference - platform.caracas_day(d.issued_at)) as dias,
           d.total_amount - coalesce((select sum(p.functional_amount) from public.payments p
                                       where p.document_id = d.id), 0) as saldo
      from public.documents d
     where d.company_id = p_company
       and d.kind in ('invoice', 'receipt', 'debit_note')
       and d.status in ('issued', 'paid')
       and (p_customer is null or d.customer_id = p_customer)
       and platform.caracas_day(d.issued_at) <= p_reference
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
