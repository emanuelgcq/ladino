-- =============================================================================
-- Ladino — migración 65 · LO FISCAL SE LLEVA EN BOLÍVARES
--
-- Regla (dueño, 2026-09-16): el USD es precio de REFERENCIA; la contabilidad,
-- los libros, las retenciones y las declaraciones van SIEMPRE en bolívares.
-- El QA de pantalla del 2026-09-15 encontró cuatro sitios que mezclaban la
-- moneda de la factura con la funcional:
--
--   h. 63 · `recompute_iva_period` sumaba `document_lines.tax_amount` —que está
--           en la moneda de la TRANSACCIÓN— como débito fiscal, y usaba de base
--           `functional_amount`, que es el total del renglón CON IVA. Una
--           ferretería con Bs 3.840,46 de débito declaraba «Bs 4,56» (los
--           dólares) sobre una base de Bs 27.843,36 (con el IVA dentro). Y el
--           crédito sumaba `supplier_invoices.tax_amount`, también en la moneda
--           de la factura.
--   h. 64 · `sales_book` rotulaba como bolívares la base en DÓLARES
--           (`line_subtotal_transaction`): «Base Bs 6,50 · IVA Bs 875,89».
--   h. 76 · `ap_aging` y «Lo que debo» sumaban saldos de facturas de proveedor
--           en su moneda: una factura de USD 50,112 aparecía como «Bs 50,11».
--   (y `purchases_book`, con todas sus cifras en la moneda de la factura.)
--
-- Qué cambia:
--   1. `platform.supplier_debt_today(company, invoice)`: lo que se le debe HOY
--      al proveedor, en moneda funcional y en céntimos (la deuda en divisa se
--      valora a la tasa del día, como la del cliente — ADR-0047);
--   2. `ap_aging` suma esa deuda, no saldos de monedas distintas;
--   3. `sales_book`: las bases salen de `line_subtotal_functional`;
--   4. `purchases_book`: todas las cifras en bolívares a la TASA DE LA FACTURA
--      (la misma con la que se asentó: `purchases.ts` convierte subtotal e IVA
--      por separado), y dos columnas nuevas, `transaction_currency` y
--      `fx_rate`, como ya tenía el libro de ventas;
--   5. `recompute_iva_period`: débito = IVA funcional del renglón (total −
--      subtotal funcionales, la misma derivación que el documento), base =
--      subtotal funcional, crédito = IVA de la factura × su tasa. Son las mismas
--      cifras que el mayor: la planilla ya no contradice a la contabilidad.
--
-- Lo que NO cambia: las filas guardadas. Una declaración o un libro ya
-- generados con huella conservan lo que dijeron (son hechos); regenerar el
-- período produce la cifra corregida con otra huella. El HANDOFF lista cuáles
-- existen en producción para que el dueño decida si se sustituyen.
--
-- HOMOLOGATION_IMPACT = YES en contenido (cambian las cifras de libros y
-- planilla; no su forma). La homologación de software está derogada (PA
-- SNAT/2026/00084); igual pasa por fiscal-reviewer. VALIDAR-TRIBUTARIO: la tasa
-- con la que se lleva a bolívares una factura de proveedor en divisa (hoy: la de
-- la fecha de la factura, P-19 en PENDIENTES_ASESOR).
--
-- Reversibilidad: total — son funciones; se restauran sus versiones de las
-- migraciones 27, 46 y 52. `purchases_book` cambia de forma (dos columnas
-- nuevas): deshacer exige volver a `drop` + `create`.
-- =============================================================================

-- ── 1. La deuda de hoy con el proveedor, en bolívares ───────────────────────
create function platform.supplier_debt_today(p_company uuid, p_invoice uuid)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_inv record;
  v_rate numeric;
  v_saldo numeric;
  v_escala int;
begin
  select i.transaction_currency, i.functional_currency
    into v_inv
    from public.supplier_invoices i
   where i.id = p_invoice and i.company_id = p_company and i.status in ('posted', 'paid');
  if not found then return null; end if;

  v_escala := platform.currency_minor_units(v_inv.functional_currency);
  v_saldo := platform.supplier_invoice_balance(p_company, p_invoice);

  if v_inv.transaction_currency = v_inv.functional_currency then
    return round(v_saldo, v_escala);
  end if;

  v_rate := platform.rate_at(p_company, v_inv.transaction_currency, v_inv.functional_currency,
                             platform.caracas_day(now()));
  if v_rate is null then
    raise exception
      'no hay tasa % → % vigente hoy para valorar la deuda con el proveedor: cárgala con su fuente',
      v_inv.transaction_currency, v_inv.functional_currency
      using errcode = 'LAD51';
  end if;
  return round(v_saldo * v_rate, v_escala);
end;
$$;
comment on function platform.supplier_debt_today(uuid, uuid) is
  'Lo que se le debe HOY a un proveedor por esta factura, en moneda funcional y en céntimos: '
  'el saldo en la moneda de la factura, a la tasa del día (ADR-0047, migración 65).';
revoke execute on function platform.supplier_debt_today(uuid, uuid) from public;
grant execute on function platform.supplier_debt_today(uuid, uuid) to authenticated, ladino_api;

-- ── 2. La antigüedad de lo que se debe, en una sola moneda ──────────────────
create or replace function platform.ap_aging(
  p_company uuid, p_supplier uuid default null, p_reference date default current_date
)
returns table (supplier_id uuid, bucket text, document_count bigint, amount numeric)
language sql
stable
set search_path = ''
as $$
  with saldos as (
    select i.supplier_id, i.id,
           (p_reference - coalesce(i.due_date, i.invoice_date)) as dias,
           platform.supplier_debt_today(p_company, i.id) as saldo
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid')
       and (p_supplier is null or i.supplier_id = p_supplier)
       and i.invoice_date <= p_reference
  )
  select s.supplier_id,
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

-- ── 3. El libro de ventas: las bases, en bolívares ──────────────────────────
create or replace function platform.sales_book(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text, customer_tax_id text, customer_name text,
  customer_taxpayer_type text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric,
  journal_entry_id uuid
)
language sql
stable
set search_path = ''
as $$
  -- Las bases se suman en la moneda FUNCIONAL del renglón (la misma que el
  -- documento congela y el mayor asienta). Antes eran `line_subtotal_transaction`
  -- —dólares— con rótulo de bolívares (QA 2026-09-15, h. 64).
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         c.tax_id, c.legal_name, c.taxpayer_type_code,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment = 'gravado'), 0),
         d.tax_amount,
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment = 'exento'), 0),
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'), 0),
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'), 0),
         -- Lo emitido ANTES de la migración 27 no tiene tratamiento. Va a su
         -- propia columna, VISIBLE, en vez de sumarse a una que no le toca.
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment is null), 0),
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

-- ── 4. El libro de compras: todo en bolívares, a la tasa de la factura ──────
drop function platform.purchases_book(uuid, date, date);
create function platform.purchases_book(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric,
  base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric, total_amount numeric,
  tax_is_recoverable boolean, journal_entry_id uuid
)
language sql
stable
set search_path = ''
as $$
  -- Una factura de proveedor guarda sus cifras en SU moneda; el libro las lleva
  -- a bolívares con la tasa de la factura, igual que el asiento (purchases.ts
  -- convierte subtotal e IVA por separado y suma). Las retenciones ya viven en
  -- moneda funcional (supplier_retentions.functional_currency).
  with f as (
    select i.*,
           round(i.tax_amount * i.fx_rate, 8) as iva_func,
           round(i.subtotal_amount * i.fx_rate, 8) as sub_func
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid', 'annulled')
       and i.invoice_date between p_from and p_to
  )
  select f.id, f.invoice_date, s.tax_id, s.legal_name, s.supplier_kind,
         f.supplier_document_number, f.supplier_control_number, f.supplier_document_ref,
         f.status, f.transaction_currency, f.fx_rate,
         round(coalesce(sum(l.line_subtotal_transaction)
                        filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, 8),
         case when f.tax_is_recoverable then f.iva_func else 0 end,
         case when f.tax_is_recoverable then 0 else f.iva_func end,
         round(coalesce(sum(l.line_subtotal_transaction)
                        filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, 8),
         round(coalesce(sum(l.line_subtotal_transaction)
                        filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, 8),
         round(coalesce(sum(l.line_subtotal_transaction)
                        filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, 8),
         round(coalesce(sum(l.line_subtotal_transaction)
                        filter (where l.tax_treatment is null), 0) * f.fx_rate, 8),
         coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                    where r.supplier_invoice_id = f.id and r.retention_code = 'iva'
                      and r.status <> 'cancelled'), 0),
         coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                    where r.supplier_invoice_id = f.id and r.retention_code = 'islr'
                      and r.status <> 'cancelled'), 0),
         -- El total es el del ASIENTO: subtotal e IVA convertidos por separado.
         f.sub_func + f.iva_func,
         f.tax_is_recoverable, f.journal_entry_id
    from f
    join public.suppliers s on s.id = f.supplier_id
    left join public.supplier_invoice_lines l on l.supplier_invoice_id = f.id
   group by f.id, f.invoice_date, f.supplier_document_number, f.supplier_control_number,
            f.supplier_document_ref, f.status, f.transaction_currency, f.fx_rate,
            f.tax_is_recoverable, f.journal_entry_id, f.iva_func, f.sub_func,
            s.tax_id, s.legal_name, s.supplier_kind
   order by f.invoice_date, f.supplier_document_number
$$;
comment on function platform.purchases_book(uuid, date, date) is
  'Libro de compras en MONEDA FUNCIONAL: cada factura a la tasa con la que se asentó '
  '(migración 65). VALIDAR-TRIBUTARIO P-19: la tasa de conversión de una factura en divisa.';
revoke execute on function platform.purchases_book(uuid, date, date) from public;
grant execute on function platform.purchases_book(uuid, date, date) to authenticated, ladino_api;

-- ── 5. La planilla de IVA: las mismas cifras que el mayor ───────────────────
create or replace function platform.recompute_iva_period(
  p_company uuid, p_from date, p_to date, p_excedente_anterior numeric
)
returns table (
  debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric,
  retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric,
  detalle jsonb
)
language sql
stable
set search_path = ''
as $$
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
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó.
    select coalesce(sum(round(i.tax_amount * i.fx_rate, 8)), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid')
       and i.tax_is_recoverable
       and i.invoice_date between p_from and p_to
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
$$;
