-- =============================================================================
-- Ladino — LOS LIBROS SON DE QUIEN TIENE RIF, TAMBIÉN EN LA BASE (AF3-13; ADR-0075 §7, ola 3)
--
-- Módulo: libros fiscales. Rigor máximo (fiscal). Spec: RESPUESTA_RECORRIDO §2 MODO, D-01.
-- La ruta y la exportación ya respondían 409 (`exigeEmpresaConRif`, packages/domain/src/
-- modo-venta.ts), pero `platform.purchases_book` llamada directamente seguía devolviendo el
-- renglón de una empresa con el marcador `PEND-`: ausencia de mecanismo no es prohibición.
--
-- Qué cambia: `platform.purchases_book`, create or replace sobre 20261003140100 (la última que la
-- define; la 190000 no la toca). Única diferencia: una empresa cuyo RIF es el marcador reservado
-- (`upper(btrim(tax_id)) like 'PEND-%'`, el MISMO predicado de `exigeEmpresaConRif` y de
-- 20260928190000:168) no devuelve renglones, ni de facturas ni de notas de crédito.
-- `purchases_book_by_rate` lee de ella, y `purchases_book_summary` y `purchases_book_with_vouchers`
-- leen de `by_rate` (comprobado en el catálogo): quedan cubiertas sin tocarlas.
-- Se mira el RIF, no el modo de venta (decisión de la familia MODO): una empresa con RIF que aún
-- no activó la facturación SÍ lleva libro de compras.
-- `book_ledger_reconciliation` no se toca y sigue en cero: la empresa sin RIF lleva su IVA AL
-- COSTO (tax_is_recoverable = false), el libro ya le sumaba iva_credito = 0 y su mayor no tiene
-- nada en «IVA crédito fiscal»; con el libro vacío compara 0 con 0 (medido en la base local sobre
-- las cinco empresas PEND- con factura con soporte: libro 0, mayor 0, cola 0, diferencia 0).
-- Reversible: SÍ, create or replace con 20261003140100 §purchases_book. Función de lectura: no
--   guarda estado. Los libros ya generados (fiscal_book_runs, append-only) no cambian.
-- HOMOLOGATION_IMPACT: NO para quien factura — el libro de una empresa con RIF es idéntico,
--   renglón por renglón. Solo deja de existir el de una empresa sin RIF, que no debía tenerlo.
-- =============================================================================

create or replace function platform.purchases_book(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text, supplier_kind text, supplier_document_number text, supplier_control_number text, supplier_document_ref text, status text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean, journal_entry_id uuid, booked_on date, received_late boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
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
  --     documento que relacionar (ADR-0066 §2);
  --   · la RECIBIDA CON RETRASO (ADR-0069 §4, K-04): su fecha cae en un período cerrado (o antes
  --     del inicio de actividades) y se REGISTRÓ en el período abierto. Entra al libro del período
  --     de registro (booked_on = accounting_date), marcada received_late, con su fecha original en
  --     invoice_date; su crédito se deduce en ese período. La ventana legal para deducirlo
  --     (LIVA art. 33, «doce períodos») NO se aplica: pendiente de fuente (P-35).
  --   · LA EMPRESA SIN RIF NO LLEVA LIBROS (AF3-13, 20261003190100; regla MODO del dueño, D-01):
  --     con el marcador reservado `PEND-` en su RIF, el libro no devuelve renglones, ni de
  --     facturas ni de notas. Se mira el RIF y no el modo de venta: una empresa con RIF que aún
  --     no activó la facturación SÍ lleva libro de compras. Mismo predicado que
  --     `exigeEmpresaConRif` (modo-venta.ts) y que platform.company_taxpayer_type_at.
  with empresa as (
    select coalesce((select upper(btrim(c.tax_id)) like 'PEND-%'
                       from public.companies c where c.id = p_company), false) as sin_rif
  ),
  base as (
    select i.*,
           coalesce(i.accounting_date, i.invoice_date) as fecha_libro,
           case when i.status = 'annulled'
                then platform.supplier_invoice_late_annulment_day(
                       i.company_id, coalesce(i.accounting_date, i.invoice_date), i.annulled_at)
           end as dia_ajuste
      from public.supplier_invoices i
     where i.company_id = p_company
       and i.status in ('posted', 'paid', 'annulled')
       and i.fiscal_support
       and not (select sin_rif from empresa)
  ),
  f as (
    select b.*,
           round(b.tax_amount * b.fx_rate, 2) + 0.00000000 as iva_lleno,
           round(b.subtotal_amount * b.fx_rate, 2) + 0.00000000 as sub_lleno
      from base b
     where b.fecha_libro between p_from and p_to
        or b.dia_ajuste between p_from and p_to
  ),
  -- Los importes de cada factura COMO SI NO se hubiera anulado; cada uso decide su factor.
  lleno as (
    -- Hallazgo 1: el proveedor COMO SE REGISTRÓ la factura (snapshot de la 170100); las
    -- anteriores, sin snapshot e inmutables, caen al maestro.
    select f.id, f.invoice_date, f.dia_ajuste,
           -- B1 (170200): discrimina por el snapshot del NOMBRE, que el registro llena siempre.
           case when f.supplier_name_snapshot is not null then f.supplier_tax_id_snapshot
                else s.tax_id end as tax_id,
           coalesce(f.supplier_name_snapshot, s.legal_name) as legal_name, s.supplier_kind,
           f.supplier_document_number, f.supplier_control_number, f.supplier_document_ref,
           f.status, f.transaction_currency, f.fx_rate,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, 2) + 0.00000000 as gravada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, 2) + 0.00000000 as exenta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, 2) + 0.00000000
             as exonerada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, 2) + 0.00000000
             as no_sujeta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment is null), 0) * f.fx_rate, 2) + 0.00000000
             as sin_clasificar,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'iva'
                        and r.status <> 'cancelled'), 0) as ret_iva,
           coalesce((select sum(r.retained_amount) from public.supplier_retentions r
                      where r.supplier_invoice_id = f.id and r.retention_code = 'islr'
                        and r.status <> 'cancelled'), 0) as ret_islr,
           f.iva_lleno, f.sub_lleno, f.tax_is_recoverable, f.journal_entry_id,
           f.fecha_libro, f.accounting_date
      from f
      join public.suppliers s on s.id = f.supplier_id
      left join public.supplier_invoice_lines l on l.supplier_invoice_id = f.id
     group by f.id, f.invoice_date, f.dia_ajuste, f.supplier_document_number,
              f.supplier_control_number, f.supplier_document_ref, f.status,
              f.transaction_currency, f.fx_rate, f.tax_is_recoverable, f.journal_entry_id,
              f.iva_lleno, f.sub_lleno, f.fecha_libro, f.accounting_date,
              f.supplier_tax_id_snapshot, f.supplier_name_snapshot,
              s.tax_id, s.legal_name, s.supplier_kind
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
           x.tax_is_recoverable, x.journal_entry_id,
           x.fecha_libro as booked_on, x.accounting_date is not null as received_late
      from lleno x
     cross join lateral (
       select case when x.status = 'annulled' and x.dia_ajuste is null then 0 else 1 end as factor
     ) k
     where x.fecha_libro between p_from and p_to
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
             where e.id = x.journal_entry_id),
           x.dia_ajuste, false
      from lleno x
     where x.dia_ajuste between p_from and p_to
  ),
  notas as (
    select n.id, n.note_date,
           case when i.supplier_name_snapshot is not null then i.supplier_tax_id_snapshot
                else s.tax_id end as tax_id,
           coalesce(i.supplier_name_snapshot, s.legal_name) as legal_name, s.supplier_kind,
           n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
           n.status, n.transaction_currency, n.fx_rate,
           case when n.status = 'annulled' then 0 else 1 end as factor,
           round(n.subtotal_amount * n.fx_rate, 2) + 0.00000000 as sub_func,
           round(n.tax_amount * n.fx_rate, 2) + 0.00000000 as iva_func,
           -- A2 (150600): la NC se reparte por el TRATAMIENTO de la línea de factura que devuelve.
           -- Lo exento, exonerado o no sujeto resta de su columna; una línea sin línea de origen
           -- sigue en gravadas, como antes; la nota sin líneas, entera en gravadas.
           o.exenta_n, o.exonerada_n, o.no_sujeta_n, o.sin_n,
           i.tax_is_recoverable, n.journal_entry_id, n.accounting_date
      from public.supplier_credit_notes n
      join public.suppliers s on s.id = n.supplier_id
      join public.supplier_invoices i on i.id = n.supplier_invoice_id
      cross join lateral (
        select round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exento'), 0) * n.fx_rate, 2) + 0.00000000 as exenta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exonerado'), 0) * n.fx_rate, 2) + 0.00000000
                 as exonerada_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'no_sujeto'), 0) * n.fx_rate, 2) + 0.00000000
                 as no_sujeta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where cl.supplier_invoice_line_id is not null
                                        and il.tax_treatment is null), 0) * n.fx_rate, 2) + 0.00000000 as sin_n
          from public.supplier_credit_note_lines cl
          left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
         where cl.supplier_credit_note_id = n.id
      ) o
     where n.company_id = p_company
       and n.status in ('posted', 'annulled')
       and i.fiscal_support
       and not (select sin_rif from empresa)
       and coalesce(n.accounting_date, n.note_date) between p_from and p_to
  )
  select * from facturas
  union all
  select * from ajustes
  union all
  select n.id, n.note_date, n.tax_id, n.legal_name, n.supplier_kind,
         n.supplier_document_number, n.supplier_control_number, n.supplier_document_ref,
         n.status, n.transaction_currency, n.fx_rate,
         -(n.sub_func - n.exenta_n - n.exonerada_n - n.no_sujeta_n - n.sin_n) * n.factor,
         case when n.tax_is_recoverable then -n.iva_func * n.factor else 0 end,
         case when n.tax_is_recoverable then 0 else -n.iva_func * n.factor end,
         -n.exenta_n * n.factor, -n.exonerada_n * n.factor, -n.no_sujeta_n * n.factor,
         -n.sin_n * n.factor, 0, 0,
         -(n.sub_func + n.iva_func) * n.factor,
         n.tax_is_recoverable, n.journal_entry_id,
         coalesce(n.accounting_date, n.note_date), n.accounting_date is not null
    from notas n
   order by 2, 6
$function$;
