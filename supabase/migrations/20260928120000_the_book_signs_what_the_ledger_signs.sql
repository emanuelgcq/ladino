-- =============================================================================
-- Ladino — EL LIBRO FIRMA LO QUE FIRMA EL MAYOR
-- (RESPUESTA_RECORRIDO_2026-09-24: L-01, L-02, L-06, L-07, G-10 y la regla
--  añadida a R-2 el 2026-09-28)
--
-- Módulo: libros fiscales y declaración de IVA.
-- Spec:   docs/02_COMPLIANCE/REPORTING_AND_FISCAL_BOOKS.md · ADR-0044 · ADR-0065.
-- Reversible: SÍ, con datos vivos — ver «Reversibilidad» al final.
-- HOMOLOGATION_IMPACT: YES — cambia las cifras del libro de ventas (signo de la
--   NC, anuladas en cero), el del libro de compras (ajuste de período anterior)
--   y la planilla de IVA (casilla de ajustes de créditos de períodos anteriores).
--   No toca la emisión ni la numeración.
--
-- Qué cambia:
--   1. `platform.sales_book`: la NOTA DE CRÉDITO de venta va en NEGATIVO (criterio
--      R-1, igual que en compras); la ND en positivo; la factura ANULADA se
--      conserva con su número y estado, e importes en CERO (G-10, R-2 para las
--      emitidas). Misma firma: `create or replace` sobre la definición VIVA de la
--      migración 20260916170000 (líneas 128-168), sin más cambios que el factor.
--   2. `supplier_invoices.annulled_at`: el MOMENTO de la anulación, sellado por
--      trigger. Sin él no hay forma de saber si se anuló antes o después de
--      presentar el libro. Lo anulado antes de esta migración queda en NULL, que
--      se lee como R-2 tal cual (el comportamiento que ya tenía).
--   3. `platform.supplier_invoice_late_annulment_day`: la regla añadida a R-2 en
--      un solo sitio — el libro de compras y la planilla la leen de aquí.
--   4. `platform.purchases_book`: la anulada tarde NO cambia su período (sale
--      como se generó) y entra en el período de la anulación como reversa del
--      crédito, en negativo, con estado «ajuste_periodo_anterior». Misma firma:
--      `create or replace` sobre la definición VIVA de la migración
--      20260918120000 (líneas 94-196).
--   5. `platform.recompute_iva_period`: la anulada tarde sigue contando en su
--      período, y el período de la anulación la lleva en una columna NUEVA,
--      `ajuste_creditos_anteriores`. Cambia el tipo de retorno: drop + create
--      sobre la definición VIVA de la migración 20260917120000 (líneas 245-337).
--   6. `iva_period_results.ajuste_creditos_anteriores`: la casilla persistida.
--   7. `platform.book_ledger_discrepancies`: para L-06, los documentos y asientos
--      concretos donde libro y mayor no dicen lo mismo.
--
-- `platform.book_ledger_reconciliation` NO se toca: con el libro bien firmado
-- cuadra tal cual (pgTAP 074) y pasa a ser un invariante del gate.
-- =============================================================================

-- ── 1. El libro de ventas: la NC resta, la anulada se conserva en cero ─────
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
  --
  -- EL SIGNO (L-01, criterio R-1 del dueño): cada importe se multiplica por el
  -- factor de su clase. La nota de crédito RESTA (−1), la factura y la nota de
  -- débito suman (+1), y la ANULADA vale CERO (G-10): sale con su número, fecha
  -- y estado porque el libro registra el correlativo consumido, pero no suma.
  -- Es el mismo signo que ya aplicaban la planilla (`recompute_iva_period`) y el
  -- mayor; hasta aquí el libro era el único que sumaba la NC, y la conciliación
  -- decía «NO cuadra» con el mayor perfecto.
  select d.id, platform.caracas_day(d.issued_at), d.kind, d.series, d.document_number,
         d.control_number, d.status,
         c.tax_id, c.legal_name, c.taxpayer_type_code,
         d.transaction_currency, d.fx_rate,
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment = 'gravado'), 0)
           * f.factor,
         d.tax_amount * f.factor,
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment = 'exento'), 0)
           * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'exonerado'), 0) * f.factor,
         coalesce(sum(dl.line_subtotal_functional)
                  filter (where dl.tax_treatment = 'no_sujeto'), 0) * f.factor,
         -- Lo emitido ANTES de la migración 27 no tiene tratamiento. Va a su
         -- propia columna, VISIBLE, en vez de sumarse a una que no le toca.
         coalesce(sum(dl.line_subtotal_functional) filter (where dl.tax_treatment is null), 0)
           * f.factor,
         d.total_amount * f.factor, d.journal_entry_id
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind = 'credit_note' then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     -- ANULADA SÍ APARECE, con su estado: el libro registra el correlativo
     -- consumido. Omitirla dejaría un hueco de numeración inexplicable.
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
   order by d.issued_at, d.series, d.document_number
$$;
comment on function platform.sales_book(uuid, date, date) is
  'Libro de ventas en MONEDA FUNCIONAL. La nota de crédito va en NEGATIVO y la de débito en '
  'positivo (criterio R-1, RESPUESTA_RECORRIDO L-01); la factura anulada se conserva con su '
  'número y estado e importes en CERO (G-10, VALIDAR-TRIBUTARIO P-34).';

-- ── 2. El momento de la anulación de una factura de proveedor ───────────────
-- El trigger de inmutabilidad (`assert_purchase_doc_immutable`, migración de
-- compras) ya neutraliza la clave `annulled_at` en su comparación de filas: la
-- columna se puede sellar en la transición a «annulled» sin abrir nada más.
alter table public.supplier_invoices add column annulled_at timestamptz;
alter table public.supplier_invoices add constraint supplier_invoices_annulled_at_chk
  check (annulled_at is null or status = 'annulled');
comment on column public.supplier_invoices.annulled_at is
  'Cuándo se anuló. Lo sella el trigger `supplier_invoices_02_annulled_at` al pasar a '
  '«annulled». Decide si la anulación cambia el libro de su período (R-2) o entra como ajuste '
  'en el período en curso (regla añadida a R-2, 2026-09-28). NULL en lo anulado antes de la '
  'migración 20260928120000: se lee como R-2 tal cual.';

create function platform.stamp_supplier_invoice_annulled_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status = 'annulled' and old.status is distinct from 'annulled' then
    -- `now()` es el inicio de la transacción: la misma hora que sella
    -- `created_at` en fiscal_book_runs e iva_period_results, así que «se anuló
    -- en la misma transacción que se generó el libro» cuenta como después.
    new.annulled_at := coalesce(new.annulled_at, now());
  end if;
  return new;
end;
$$;
create trigger supplier_invoices_02_annulled_at
  before update on public.supplier_invoices
  for each row execute function platform.stamp_supplier_invoice_annulled_at();

-- ── 3. La regla añadida a R-2, en un solo sitio ─────────────────────────────
/**
 * El día (de Caracas) en que la anulación entra como AJUSTE del período en
 * curso, o NULL si vale R-2 tal cual.
 *
 * Regla del dueño (PENDIENTES_ASESOR R-2, 2026-09-28), leída al pie de la letra:
 * cuando se anuló, el período de la factura YA estaba cerrado **y** su libro de
 * compras ya se había generado (`fiscal_book_runs`) **o** su IVA declarado
 * (`iva_period_results`). Cerrado sin nada presentado, o presentado sin cerrar,
 * es R-2 tal cual: en cero en su propio período. VALIDAR-TRIBUTARIO P-46.
 *
 * «Cerrado cuando se anuló» se lee de la fila del período: el ÚLTIMO cierre
 * (`closed_at`) es anterior a la anulación y no hubo reapertura (`reopened_at`)
 * entre ese cierre y la anulación. Vale con las dos lecturas del CHECK
 * `fiscal_periods_closed_chk`: la de la migración 25, que borra `closed_at` al
 * reabrir, y la de 20260928130000 (K-01), que lo conserva. La fila solo guarda el
 * último cierre y la última reapertura: si después de la anulación el período se
 * reabre Y se vuelve a cerrar, el cierre nuevo es posterior y la factura vuelve a
 * R-2 tal cual. Está dicho en P-46; la historia completa vive en
 * `fiscal_period_events` (migración 20260928130000, posterior a esta).
 */
create function platform.supplier_invoice_late_annulment_day(
  p_company uuid, p_invoice_date date, p_annulled_at timestamptz)
returns date
language sql
stable
set search_path = ''
as $$
  select platform.caracas_day(p_annulled_at)
   where p_annulled_at is not null
     and exists (
       select 1 from public.fiscal_periods p
        where p.company_id = p_company
          and p.year = extract(year from p_invoice_date)::int
          and p.month = extract(month from p_invoice_date)::int
          and p.closed_at is not null
          and p.closed_at <= p_annulled_at
          and (p.reopened_at is null
               or p.reopened_at < p.closed_at
               or p.reopened_at > p_annulled_at))
     and (exists (
            select 1 from public.fiscal_book_runs r
             where r.company_id = p_company
               and r.book_kind = 'compras'
               and p_invoice_date between r.period_from and r.period_to
               and r.created_at <= p_annulled_at)
          or exists (
            select 1 from public.iva_period_results d
             where d.company_id = p_company
               and p_invoice_date between d.period_from and d.period_to
               and d.created_at <= p_annulled_at))
$$;
revoke execute on function platform.supplier_invoice_late_annulment_day(uuid, date, timestamptz)
  from public;
grant execute on function platform.supplier_invoice_late_annulment_day(uuid, date, timestamptz)
  to authenticated, ladino_api;

-- ── 4. El libro de compras: la anulada tarde, como ajuste del período en curso ─
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
as $function$
  -- LIBRO DE COMPRAS EN MONEDA FUNCIONAL (migración 65): cada documento a la tasa con la que se
  -- asentó. Cinco reglas, con su norma:
  --   · la factura ANULADA se registra con importes en CERO: conserva la traza cronológica que
  --     pide el Reglamento art. 70 sin llevar al libro un crédito fiscal que la Ley art. 37
  --     manda deducir (R-2);
  --   · la anulada DESPUÉS de cerrar su período y de generar o declarar su libro no cambia ese
  --     libro —sale como se generó, «posted»— y entra en el período de la anulación como
  --     reversa del crédito, en NEGATIVO, con estado «ajuste_periodo_anterior» (regla añadida a
  --     R-2, 2026-09-28; ver platform.supplier_invoice_late_annulment_day);
  --   · la NOTA DE CRÉDITO recibida se registra como documento propio, en NEGATIVO, en el
  --     período de su recepción (LIVA arts. 56 y 37; Reglamento arts. 70 y 75 lit. a);
  --   · una nota anulada, como la factura anulada: en cero;
  --   · la compra SIN SOPORTE FISCAL no se registra: el libro relaciona documentos, y ahí no hay
  --     documento que relacionar (ADR-0066 §2).
  with base as (
    select i.*,
           case when i.status = 'annulled'
                then platform.supplier_invoice_late_annulment_day(i.company_id, i.invoice_date,
                                                                  i.annulled_at)
           end as dia_ajuste
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid', 'annulled')
       and i.fiscal_support
  ),
  f as (
    select b.*,
           round(b.tax_amount * b.fx_rate, 8) as iva_lleno,
           round(b.subtotal_amount * b.fx_rate, 8) as sub_lleno
      from base b
     where b.invoice_date between p_from and p_to
        or b.dia_ajuste between p_from and p_to
  ),
  -- Los importes de cada factura COMO SI NO se hubiera anulado; cada uso decide su factor.
  lleno as (
    select f.id, f.invoice_date, f.dia_ajuste, s.tax_id, s.legal_name, s.supplier_kind,
           f.supplier_document_number, f.supplier_control_number, f.supplier_document_ref,
           f.status, f.transaction_currency, f.fx_rate,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, 8) as gravada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, 8) as exenta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, 8)
             as exonerada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, 8)
             as no_sujeta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment is null), 0) * f.fx_rate, 8)
             as sin_clasificar,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'iva'
                        and r.status <> 'cancelled'), 0) as ret_iva,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'islr'
                        and r.status <> 'cancelled'), 0) as ret_islr,
           f.iva_lleno, f.sub_lleno, f.tax_is_recoverable, f.journal_entry_id
      from f
      join public.suppliers s on s.id = f.supplier_id
      left join public.supplier_invoice_lines l on l.supplier_invoice_id = f.id
     group by f.id, f.invoice_date, f.dia_ajuste, f.supplier_document_number,
              f.supplier_control_number, f.supplier_document_ref, f.status,
              f.transaction_currency, f.fx_rate, f.tax_is_recoverable, f.journal_entry_id,
              f.iva_lleno, f.sub_lleno, s.tax_id, s.legal_name, s.supplier_kind
  ),
  facturas as (
    select x.id, x.invoice_date, x.tax_id, x.legal_name, x.supplier_kind,
           x.supplier_document_number, x.supplier_control_number, x.supplier_document_ref,
           -- La anulada tarde sale como se generó: el libro de ese período no cambia.
           case when x.status = 'annulled' and x.dia_ajuste is not null then 'posted'
                else x.status end as status,
           x.transaction_currency, x.fx_rate,
           x.gravada * k.factor as base_gravada,
           case when x.tax_is_recoverable then x.iva_lleno * k.factor else 0 end as iva_credito,
           case when x.tax_is_recoverable then 0 else x.iva_lleno * k.factor end as iva_al_costo,
           x.exenta * k.factor as base_exenta,
           x.exonerada * k.factor as base_exonerada,
           x.no_sujeta * k.factor as base_no_sujeta,
           x.sin_clasificar * k.factor as base_sin_clasificar,
           x.ret_iva * k.factor as retenido_iva,
           x.ret_islr * k.factor as retenido_islr,
           (x.sub_lleno + x.iva_lleno) * k.factor as total_amount,
           x.tax_is_recoverable, x.journal_entry_id
      from lleno x
     cross join lateral (
       select case when x.status = 'annulled' and x.dia_ajuste is null then 0 else 1 end as factor
     ) k
     where x.invoice_date between p_from and p_to
  ),
  -- La reversa del crédito en el período de la anulación. Sus retenciones no se tocan: la
  -- línea corrige el crédito fiscal, no el comprobante. Su asiento es el contra-asiento del
  -- original, si ya existe; si no, NULL, y la conciliación la cuenta como cola.
  ajustes as (
    select x.id, x.dia_ajuste as invoice_date, x.tax_id, x.legal_name, x.supplier_kind,
           x.supplier_document_number, x.supplier_control_number, x.supplier_document_ref,
           'ajuste_periodo_anterior'::text as status,
           x.transaction_currency, x.fx_rate,
           -x.gravada,
           case when x.tax_is_recoverable then -x.iva_lleno else 0 end,
           case when x.tax_is_recoverable then 0 else -x.iva_lleno end,
           -x.exenta, -x.exonerada, -x.no_sujeta, -x.sin_clasificar,
           0::numeric, 0::numeric,
           -(x.sub_lleno + x.iva_lleno),
           x.tax_is_recoverable,
           (select e.reversed_by_entry_id from public.journal_entries e
             where e.id = x.journal_entry_id)
      from lleno x
     where x.dia_ajuste between p_from and p_to
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
       and i.fiscal_support
       and n.note_date between p_from and p_to
  )
  select * from facturas
  union all
  select * from ajustes
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
$function$;
comment on function platform.purchases_book(uuid, date, date) is
  'Libro de compras en MONEDA FUNCIONAL, con la tasa de cada documento. Notas de crédito '
  'recibidas en negativo en el período de su recepción; anuladas en cero (R-2); la anulada '
  'después de cerrar y presentar su período no lo cambia y entra en el período de la anulación '
  'como «ajuste_periodo_anterior», en negativo (regla añadida a R-2, 2026-09-28, P-46).';

-- ── 5 y 6. La planilla: la casilla de ajustes de créditos de períodos anteriores ─
alter table public.iva_period_results
  add column ajuste_creditos_anteriores numeric(24,8) not null default 0;
comment on column public.iva_period_results.ajuste_creditos_anteriores is
  'Ajustes a los créditos fiscales de períodos anteriores: hoy, la reversa del crédito de las '
  'facturas de proveedor anuladas después de cerrar y presentar su período (R-2 ampliada). '
  'Negativo o cero. Ya está sumado en creditos_deducibles.';

drop function platform.recompute_iva_period(uuid, date, date, numeric);
create function platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric)
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
    -- La anulada DESPUÉS de cerrar y presentar su período sigue contando en él: esa planilla
    -- no cambia (R-2 ampliada); su reversa va en `ajuste` del período de la anulación.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, 8))
                       from public.supplier_invoices i
                      where i.company_id = p_company
                        and (i.status in ('posted', 'paid')
                             or (i.status = 'annulled'
                                 and platform.supplier_invoice_late_annulment_day(
                                       i.company_id, i.invoice_date, i.annulled_at) is not null))
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
  ajuste as (
    -- Casilla de AJUSTES A LOS CRÉDITOS FISCALES DE PERÍODOS ANTERIORES: la reversa del crédito
    -- de las facturas anuladas tarde, en el período (día de Caracas) de la anulación.
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, 8)), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status = 'annulled'
       and i.tax_is_recoverable
       and platform.supplier_invoice_late_annulment_day(i.company_id, i.invoice_date,
                                                        i.annulled_at) between p_from and p_to
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
    -- El ajuste NO pasa por la prorrata del período en curso: corrige un crédito que ya se
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46).
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end + a.total as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
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
       from por_alicuota a) as detalle,
    calc.ajuste
  from calc
$function$;
comment on function platform.recompute_iva_period(uuid, date, date, numeric) is
  'La planilla del período en BOLÍVARES (migración 65) con las NOTAS DE CRÉDITO recibidas '
  'restadas del crédito fiscal, en el período de la nota (LIVA arts. 37 y 56; ADR-0065 §1), y '
  'la casilla de AJUSTES DE CRÉDITOS DE PERÍODOS ANTERIORES (R-2 ampliada, P-46), ya sumada en '
  'creditos_deducibles. La prorrata sigue siendo global v1 con su VALIDAR-TRIBUTARIO (P-25).';
revoke execute on function platform.recompute_iva_period(uuid, date, date, numeric) from public;
grant execute on function platform.recompute_iva_period(uuid, date, date, numeric) to ladino_api;

-- ── 7. L-06: dónde, concretamente, libro y mayor no dicen lo mismo ──────────
/**
 * Los documentos y asientos que `book_ledger_reconciliation` compara en bloque,
 * uno a uno, y solo los que NO cuadran.
 *
 * Cada asiento de la cuenta de IVA del período se imputa al renglón del libro
 * cuyo asiento es él mismo o, si no hay, al renglón cuyo asiento él revierte
 * (el contra-asiento de una anulación). Salen:
 *   · renglones cuyo IVA en el libro no es el de sus asientos (document_id y
 *     journal_entry_id presentes);
 *   · asientos que ningún renglón del libro respalda (document_id NULL).
 * Los renglones sin asiento no salen: son la cola, y la conciliación ya la
 * cuenta aparte.
 */
create function platform.book_ledger_discrepancies(p_company uuid, p_from date, p_to date)
returns table (
  concepto text, document_id uuid, document_kind text, journal_entry_id uuid,
  entry_number bigint, libro numeric, mayor numeric)
language sql
stable
set search_path = ''
as $$
  with vigente as (
    select purpose, account_id from public.company_account_settings
     where company_id = p_company and effective_to is null
       and purpose in ('iva_debit_fiscal', 'iva_credit_fiscal')
  ),
  libro as (
    select 'iva_debito_fiscal'::text as concepto, s.document_id, s.kind as document_kind,
           s.journal_entry_id, s.iva_debito as iva
      from platform.sales_book(p_company, p_from, p_to) s
     where s.journal_entry_id is not null
    union all
    select 'iva_credito_fiscal', c.invoice_id,
           case when c.status = 'ajuste_periodo_anterior' then 'ajuste_periodo_anterior'
                else 'purchase' end,
           c.journal_entry_id, c.iva_credito
      from platform.purchases_book(p_company, p_from, p_to) c
     where c.journal_entry_id is not null
  ),
  mayor as (
    select case v.purpose when 'iva_debit_fiscal' then 'iva_debito_fiscal'
                          else 'iva_credito_fiscal' end as concepto,
           e.id as entry_id, e.entry_number, e.is_reversal_of,
           sum(case v.purpose when 'iva_debit_fiscal'
                    then jl.functional_credit - jl.functional_debit
                    else jl.functional_debit - jl.functional_credit end) as monto
      from vigente v
      join public.journal_lines jl on jl.account_id = v.account_id and jl.company_id = p_company
      join public.journal_entries e on e.id = jl.entry_id
     where e.status in ('posted', 'reversed')
       and e.posting_date between p_from and p_to
     group by 1, 2, 3, 4
  ),
  imputado as (
    select m.*, (
             select l.journal_entry_id from libro l
              where l.concepto = m.concepto
                and l.journal_entry_id in (m.entry_id, m.is_reversal_of)
              order by (l.journal_entry_id = m.entry_id) desc
              limit 1) as renglon_entry
      from mayor m
  ),
  por_renglon as (
    select l.concepto, l.document_id, l.document_kind, l.journal_entry_id,
           (select e.entry_number from public.journal_entries e where e.id = l.journal_entry_id)
             as entry_number,
           l.iva as libro,
           coalesce((select sum(i.monto) from imputado i
                      where i.concepto = l.concepto and i.renglon_entry = l.journal_entry_id), 0)
             as mayor
      from libro l
  )
  select concepto, document_id, document_kind, journal_entry_id, entry_number, libro, mayor
    from por_renglon
   where libro <> mayor
  union all
  select i.concepto, null, null, i.entry_id, i.entry_number, 0, i.monto
    from imputado i
   where i.renglon_entry is null and i.monto <> 0
   order by 1, 5 nulls last
$$;
comment on function platform.book_ledger_discrepancies(uuid, date, date) is
  'L-06: el detalle de book_ledger_reconciliation — los documentos y asientos concretos en los '
  'que libro y mayor no dicen lo mismo, y los asientos de IVA que ningún renglón respalda.';
revoke execute on function platform.book_ledger_discrepancies(uuid, date, date) from public;
grant execute on function platform.book_ledger_discrepancies(uuid, date, date)
  to authenticated, ladino_api;

-- =============================================================================
-- Reversibilidad, con datos vivos
-- -----------------------------------------------------------------------------
-- Las funciones (1, 3, 4, 5, 7) no guardan datos: revertir es volver a crear las
-- definiciones de las migraciones 20260916170000 (sales_book), 20260918120000
-- (purchases_book) y 20260917120000 (recompute_iva_period, con su drop) y hacer
-- drop de las dos nuevas.
-- Las dos columnas SÍ guardan datos desde el primer uso:
--   · supplier_invoices.annulled_at — hoy ninguna vía del producto anula una
--     factura de proveedor (solo la base), así que nacerá casi vacía; quitarla
--     pierde el momento de las anulaciones hechas entre medias, y con él la
--     distinción R-2 / R-2 ampliada de esas facturas (volverían a R-2 tal cual).
--   · iva_period_results.ajuste_creditos_anteriores — la tabla es append-only;
--     quitar la columna borra la casilla de las planillas generadas entre medias,
--     y su dataset_hash, que la incluye cuando no es cero, dejaría de poder
--     reproducirse. Antes de revertir: exportar las filas con ajuste ≠ 0.
-- =============================================================================
