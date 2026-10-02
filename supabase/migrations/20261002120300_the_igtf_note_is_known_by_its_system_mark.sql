-- =============================================================================
-- Ladino — LA ND POR IGTF SE RECONOCE POR SU MARCA DE SISTEMA, NO POR SU SKU
-- Módulo: declaración de IVA · libro de ventas
-- Spec: docs/02_COMPLIANCE/IVA_SPEC.md · REPORTING_AND_FISCAL_BOOKS.md
-- Arregla a: 20261002120200 (H1, auditoría fiscal 2.ª ronda), coordinación con 20261002100100.
--
-- La 120200 reconocía la línea de la ND por IGTF con `pr.sku = 'LADINO-IGTF'`. La familia IGTF
-- (20261002100100) marca el producto de sistema con `products.system_code = 'igtf'` y le pone al sku
-- un sufijo propio para no chocar con productos de la empresa: con el sku, la ND volvería a contar
-- como venta y a activar la prorrata. Esta migración redefine, partiendo de la 120200 (definición
-- viva), las mismas cuatro funciones cambiando SOLO esa condición (9 apariciones): a
-- `pr.system_code = 'igtf'` y `pr.system_code is distinct from 'igtf'`. Mismas firmas y tipos de
-- retorno: create or replace, conserva los GRANT. `sales_book_with_receipts` no la usa (lee
-- `sales_book_by_rate` por nombre) y no se toca. Los comentarios de las funciones que dicen
-- «LADINO-IGTF» se refieren al producto de sistema; la marca es `system_code`.
--
-- Depende de: 20261002100100 (products.system_code), anterior a esta.
-- Reversible: SÍ, con datos vivos: volver a la 120200 (create or replace con su texto) devuelve la
--   comparación por sku, que no reconoce los productos de sistema con sufijo. No se recomienda.
-- HOMOLOGATION_IMPACT: YES — misma razón que la 120200 (la ND por IGTF fuera de la planilla, la
--   prorrata y las bases del libro); esta solo corrige cómo se la reconoce.
-- =============================================================================

create or replace function platform.recompute_iva_period(p_company uuid, p_from date, p_to date,
                                              p_excedente_anterior numeric,
                                              p_retenciones_anteriores numeric default 0)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric, retenciones_acumuladas_por_descontar numeric)
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
       -- H1 (20261002120200; PA SNAT/2022/000013 arts. 5-6, LIVA art. 34): la línea de la ND por
       -- IGTF (producto de sistema LADINO-IGTF) NO es una venta: ni débito, ni base, ni «sin
       -- impuesto» que active la prorrata. VALIDAR-TRIBUTARIO P-70.
       and not exists (select 1 from public.products pr
                        where pr.id = l.product_id and pr.system_code = 'igtf')
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
                                       i.company_id, coalesce(i.accounting_date, i.invoice_date),
                                       i.annulled_at) is not null))
                        and i.tax_is_recoverable
                        -- ADR-0069 §4: la recibida con retraso, en su período de REGISTRO.
                        -- Sin ventana de LIVA art. 33 (P-35, pendiente de fuente).
                        and coalesce(i.accounting_date, i.invoice_date)
                              between p_from and p_to), 0)
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, 8))
                       from public.supplier_credit_notes n
                       join public.supplier_invoices i on i.id = n.supplier_invoice_id
                      where n.company_id = p_company
                        and n.status = 'posted'
                        and i.tax_is_recoverable
                        and coalesce(n.accounting_date, n.note_date)
                              between p_from and p_to), 0) as total
  ),
  ajuste as (
    -- Casilla de AJUSTES A LOS CRÉDITOS FISCALES DE PERÍODOS ANTERIORES: la reversa del crédito
    -- de las facturas anuladas tarde, en el período (día de Caracas) de la anulación.
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, 8)), 0) as total
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status = 'annulled'
       and i.tax_is_recoverable
       and platform.supplier_invoice_late_annulment_day(
             i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           between p_from and p_to
  ),
  ret as (
    -- L-04: la retención soportada, en el período (quincena o mes) de la FECHA DEL COMPROBANTE.
    -- H4 (20261002120200; PA SNAT/2025/000054 art. 7): si ese período ya estaba DECLARADO cuando
    -- se entregó el comprobante (una generación que lo cubre, creada el día de la entrega o antes),
    -- la retención va al período de la ENTREGA. Sin fecha de entrega, la de la retención: nada
    -- cambia para lo cargado antes. Granularidad: día contra día (caracas_day de la generación
    -- contra la fecha de entrega). VALIDAR-TRIBUTARIO P-68.
    select coalesce(sum(r.amount), 0) as total
      from public.supported_retention_receipts r
     where r.company_id = p_company and r.status = 'registered'
       and case when exists (
                  select 1 from public.iva_period_results p
                   where p.company_id = r.company_id
                     and r.retained_on between p.period_from and p.period_to
                     and platform.caracas_day(p.created_at)
                           <= coalesce(r.received_on, r.retained_on))
                then coalesce(r.received_on, r.retained_on)
                else r.retained_on end
           between p_from and p_to
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
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46). Y NO se suma en
    -- `deducibles`: esa columna es el crédito del PERÍODO tras la prorrata, que nunca es
    -- negativo (CHECK ipr_amounts_chk). El ajuste va en su casilla y entra en la cuota.
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
  ),
  neto as (
    -- L-05 · LOS DOS ARRASTRES DE LA FORMA 00030. Primero el impuesto: débitos − créditos
    -- (con su ajuste) − excedente de CRÉDITO anterior. Si es negativo, ESE es el excedente de
    -- crédito fiscal que pasa. Después las retenciones (las acumuladas que llegan + las del
    -- período) se descuentan SOLO de la cuota positiva; lo que no absorbe pasa aparte, como
    -- retenciones acumuladas por descontar. Una retención nunca se convierte en crédito fiscal
    -- (PA SNAT/2025/000054 arts. 7 y 8; VALIDAR-TRIBUTARIO P-37).
    select calc.*,
           calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior as impuesto,
           p_retenciones_anteriores + calc.retenciones as retenciones_disponibles
      from calc
  )
  select
    n.debitos, n.creditos, n.deducibles, n.pct, n.retenciones,
    greatest(0, greatest(0, n.impuesto) - n.retenciones_disponibles) as cuota_a_pagar,
    greatest(0, -n.impuesto) as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle,
    n.ajuste,
    greatest(0, n.retenciones_disponibles - greatest(0, n.impuesto))
      as retenciones_acumuladas_por_descontar
  from neto n
$function$;

comment on function platform.recompute_iva_period(uuid, date, date, numeric, numeric) is
  'La planilla del período en BOLÍVARES: NC recibidas restadas del crédito (LIVA arts. 37 y 56), '
  'casilla de AJUSTES DE CRÉDITOS DE PERÍODOS ANTERIORES (R-2 ampliada, P-46), DOS arrastres '
  '(L-05: excedente de crédito fiscal y retenciones acumuladas por descontar). Desde '
  '20261002120200: la ND por IGTF (LADINO-IGTF) no es venta ni activa la prorrata (H1, P-70), y '
  'la retención entregada después de declarar su período va al de la entrega (H4, P-68). '
  'Prorrata global v1 (P-25).';

-- ── 3. El libro de ventas: la ND por IGTF aparte (H1) ───────────────────────
create or replace function platform.sales_book(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text, customer_tax_id text, customer_name text,
  customer_taxpayer_type text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric,
  journal_entry_id uuid, igtf_percibido numeric
)
language sql
stable
set search_path = ''
as $$
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
         d.journal_entry_id,
         coalesce(sum(dl.line_total_functional) filter (where pr.system_code = 'igtf'), 0)
           * f.factor
    from public.documents d
    cross join lateral (
      select case when d.status = 'annulled' then 0
                  when d.kind = 'credit_note' then -1
                  else 1 end as factor
    ) f
    join public.customers c on c.id = d.customer_id
    left join public.document_lines dl on dl.document_id = d.id
    left join public.products pr on pr.id = dl.product_id
   where d.company_id = p_company
     and d.kind in ('invoice', 'credit_note', 'debit_note')
     and d.status in ('issued', 'paid', 'annulled')
     and platform.caracas_day(d.issued_at) between p_from and p_to
   group by d.id, f.factor, c.tax_id, c.legal_name, c.taxpayer_type_code
   order by d.issued_at, d.series, d.document_number
$$;
comment on function platform.sales_book(uuid, date, date) is
  'Libro de ventas en MONEDA FUNCIONAL: NC en negativo, ND en positivo (R-1), anulada con su '
  'número e importes en cero (G-10, P-34), adquirente por los snapshots del documento '
  '(20260928170100/170200). Desde 20261002120200 (H1): la ND por IGTF sale con su número y '
  'control, sin importes de venta, y su monto en igtf_percibido (VALIDAR-TRIBUTARIO P-70).';
revoke execute on function platform.sales_book(uuid, date, date) from public, anon;
grant execute on function platform.sales_book(uuid, date, date) to authenticated, ladino_api;

create or replace function platform.sales_book_by_rate(p_company uuid, p_from date, p_to date)
returns table (
  document_id uuid, issued_on date, kind text, series text, document_number bigint,
  control_number bigint, status text, customer_tax_id text, customer_name text,
  customer_taxpayer_type text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_debito numeric, base_exenta numeric, base_exonerada numeric,
  base_no_sujeta numeric, base_sin_clasificar numeric, total_amount numeric,
  journal_entry_id uuid,
  base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric,
  base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric,
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric,
  base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric,
  control_identifier text, igtf_percibido numeric
)
language sql
stable
set search_path = ''
as $$
  -- Definición viva de 20260928170300 §3, más `igtf_percibido` (H1, 20261002120200). La línea de
  -- la ND por IGTF es no sujeta: no cae en ninguna alícuota, y su impuesto es cero.
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         r.base_x, r.iva_x,
         (select d.control_identifier from public.documents d where d.id = s.document_id),
         s.igtf_percibido
    from platform.sales_book(p_company, p_from, p_to) with ordinality as s
    cross join lateral (
      select case when s.status = 'annulled' then 0
                  when s.kind = 'credit_note' then -1 else 1 end as factor
    ) f
    cross join lateral (
      select
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as base_g,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_general'), 0) * f.factor as iva_g,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_general') as rate_g,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as base_a,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_adicional'), 0) * f.factor as iva_a,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_adicional') as rate_a,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as base_r,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot = 'gravado_reducida'), 0) * f.factor as iva_r,
        max(dl.tax_rate_snapshot) filter (where dl.tax_category_snapshot = 'gravado_reducida') as rate_r,
        coalesce(sum(dl.line_subtotal_functional)
                 filter (where dl.tax_treatment = 'gravado'
                           and dl.tax_category_snapshot is distinct from 'gravado_general'
                           and dl.tax_category_snapshot is distinct from 'gravado_adicional'
                           and dl.tax_category_snapshot is distinct from 'gravado_reducida'), 0)
          * f.factor as base_x,
        coalesce(sum(dl.line_total_functional - dl.line_subtotal_functional)
                 filter (where dl.tax_category_snapshot is null
                           or dl.tax_category_snapshot not in
                              ('gravado_general', 'gravado_adicional', 'gravado_reducida')), 0)
          * f.factor as iva_x
        from public.document_lines dl
       where dl.document_id = s.document_id
    ) r
   order by s.ordinality
$$;
comment on function platform.sales_book_by_rate(uuid, date, date) is
  'Libro de ventas con la base y el IVA POR ALÍCUOTA, lo que no cae en ninguna, el identificador '
  'del control (H11, ADR-0071) y, desde 20261002120200, el IGTF percibido aparte (H1). RLIVA arts. '
  '72 y 76 (L-08). SECURITY INVOKER a propósito: su aislamiento es la RLS del que llama (pgTAP 081b).';
revoke execute on function platform.sales_book_by_rate(uuid, date, date) from public, anon;
grant execute on function platform.sales_book_by_rate(uuid, date, date) to authenticated, ladino_api;

-- ── 4. El resumen del art. 72 sin la ND por IGTF (H1) ───────────────────────
create or replace function platform.sales_book_summary(p_company uuid, p_from date, p_to date)
returns table (concept text, rate numeric, base numeric, tax numeric,
               adjustments_base numeric, adjustments_tax numeric, documents bigint)
language sql
stable
set search_path = ''
as $$
  -- Definición viva de 20260928150000 §7. H1 (20261002120200): la línea de la ND por IGTF no es
  -- una venta no sujeta y no entra en el resumen (VALIDAR-TRIBUTARIO P-70).
  select x.concept, x.rate, sum(x.base), sum(x.tax),
         coalesce(sum(x.base) filter (where x.kind <> 'invoice'), 0),
         coalesce(sum(x.tax) filter (where x.kind <> 'invoice'), 0),
         count(distinct x.doc)
    from (
      select case when dl.tax_treatment = 'gravado'
                    then coalesce(dl.tax_category_snapshot, 'gravado')
                  when dl.tax_treatment is null then 'sin_clasificar'
                  else dl.tax_treatment end as concept,
             case when dl.tax_treatment = 'gravado' then dl.tax_rate_snapshot end as rate,
             dl.line_subtotal_functional * f.factor as base,
             (dl.line_total_functional - dl.line_subtotal_functional) * f.factor as tax,
             d.kind, d.id as doc
        from public.documents d
        join public.document_lines dl on dl.document_id = d.id
        cross join lateral (
          select case when d.kind = 'credit_note' then -1 else 1 end as factor) f
       where d.company_id = p_company
         and d.kind in ('invoice', 'credit_note', 'debit_note')
         and d.status in ('issued', 'paid')
         and platform.caracas_day(d.issued_at) between p_from and p_to
         and not exists (select 1 from public.products pr
                          where pr.id = dl.product_id and pr.system_code = 'igtf')
    ) x
   group by x.concept, x.rate
   order by case x.concept when 'gravado_general' then 1 when 'gravado_adicional' then 2
                           when 'gravado_reducida' then 3 when 'exento' then 4
                           when 'exonerado' then 5 when 'no_sujeto' then 6 else 7 end,
            x.rate
$$;
comment on function platform.sales_book_summary(uuid, date, date) is
  'Resumen del libro de ventas (RLIVA art. 72, L-08): base e IVA por alícuota, exentas, '
  'exoneradas, no sujetas y ajustes por notas; sin la ND por IGTF (H1, 20261002120200). '
  'Exportaciones: Ladino no las implementa (VALIDAR-SENIAT). SECURITY INVOKER a propósito: su '
  'aislamiento entre empresas es la RLS del que llama (pgTAP 081b).';
