-- =============================================================================
-- Ladino — LA PLANILLA JUNTA LOS DOS ARREGLOS: EL AJUSTE APARTE (L) Y LA FACTURA TARDÍA (K-04)
-- Módulo: declaración de IVA   Spec: docs/02_COMPLIANCE/REPORTING_AND_FISCAL_BOOKS.md · ADR-0069 §4
--
-- Por qué existe: 20260928120300 (familia L) y 20260928130100 (K-04) redefinen
-- `platform.recompute_iva_period` cada una desde la 120000. En un db:reset limpio la 130100
-- corre después y PISA el arreglo de la 120300 (el ajuste negativo dentro de
-- `creditos_deducibles`, que viola `ipr_amounts_chk`); en una base donde la 120300 llegó
-- después, falta K-04. Esta migración deja la función con los dos, en cualquier orden de llegada.
--
-- Parte EXACTAMENTE de la definición viva de la 120300 (pg_get_functiondef de la base local, que
-- tiene la 120300 como última en aplicarse: su `calc` saca el ajuste de los deducibles y lo mete
-- en la cuota y el excedente). Sobre ella, los mismos cuatro cambios de K-04 que la 130100:
-- la factura y la NC cuentan en su fecha CONTABLE (coalesce(accounting_date, fecha)), y la R-2
-- ampliada pregunta por esa misma fecha. Nada más. La ventana legal de LIVA art. 33 NO se aplica
-- (P-35). Misma firma y forma: create or replace; conserva sus GRANT.
--
-- Reversible: SÍ, con datos vivos: volver a la 120300 (create or replace con su texto) devuelve el
--   crédito de la factura tardía a su mes original, y la planilla dejaría de coincidir con el
--   libro (130100) y el mayor. Revertir junto con el enrutado de compras.
-- HOMOLOGATION_IMPACT: YES — misma razón que la 130100 (crédito de la factura tardía en su
--   período de registro); el cambio de la 120300 ya está declarado en la suya.
--
-- FE DE ERRATAS de 20260928130000 (que el hook no deja editar): su cabecera (líneas 7-8) y su
-- nota de la sección 7 (líneas 370-377) dicen que compras NO enruta a la fecha contable y que
-- el libro y la planilla no cambian. Ya no es así: la 130100 y esta enrutan la factura, la NC y
-- el landed cost, y el caso de uso enruta también la recepción, el pago a proveedor y el gasto
-- de tesorería (packages/domain/src/fecha-contable.ts → platform.accounting_date_for).
-- =============================================================================

create or replace function platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric)
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
    -- dedujo con la prorrata de SU período (VALIDAR-TRIBUTARIO P-46). Y NO se suma en
    -- `deducibles`: esa columna es el crédito del PERÍODO tras la prorrata, que nunca es
    -- negativo (CHECK ipr_amounts_chk). El ajuste va en su casilla y entra en la cuota.
    select d.total as debitos,
           c.total as creditos,
           case when p.pct is null then c.total
                else round(c.total * p.pct, 8) end as deducibles,
           p.pct, r.total as retenciones, a.total as ajuste
      from deb d, cred c, ret r, prorrata p, ajuste a
  )
  select
    calc.debitos, calc.creditos, calc.deducibles, calc.pct, calc.retenciones,
    greatest(0, calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior
                - calc.retenciones) as cuota_a_pagar,
    greatest(0, -(calc.debitos - (calc.deducibles + calc.ajuste) - p_excedente_anterior
                  - calc.retenciones)) as excedente_siguiente,
    (select coalesce(jsonb_agg(jsonb_build_object(
              'alicuota', a.alicuota::text,
              'base', a.base::text,
              'impuesto', a.impuesto::text) order by a.alicuota), '[]'::jsonb)
       from por_alicuota a) as detalle,
    calc.ajuste
  from calc
$function$;
