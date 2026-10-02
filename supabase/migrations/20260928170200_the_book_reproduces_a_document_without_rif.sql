-- =============================================================================
-- Ladino — el libro reproduce el documento, también cuando el documento no llevaba RIF
-- (re-revisión de la familia «documento de identidad», 2026-09-28: B1 y B3)
--
-- Módulo:         libros fiscales + documento de identidad (A-08, P-02)
-- Arregla a:      20260928170100_the_book_reproduces_the_document (familia F5: sales_book y
--                 purchases_book parten de su definición en la 170100, la última viva;
--                 documents_customer_snapshot_freeze de 20260902173849).
--
-- B1: la 170100 leía `coalesce(snapshot_del_rif, maestro)`, que confunde «documento anterior a
--     los snapshots» con «emitido sin documento de identidad»: un consumidor final emitido sin RIF
--     al que después se le cargaba uno aparecía en el libro de ese período CON el RIF nuevo. Lo
--     que discrimina es el snapshot del NOMBRE, que la emisión (y el registro de la factura de
--     proveedor) llena siempre: si está, manda el snapshot, aunque el RIF sea NULL.
-- B3 (decidido por criterio, misma regla: el libro reproduce el documento; alternativa: seguir
--     leyendo el maestro): `documents.customer_taxpayer_type_snapshot`, nullable, lo llena la
--     emisión con los demás snapshots del cliente; el libro de ventas lo usa con el mismo `case`.
--     Sin backfill. Queda congelado con los otros snapshots (LAD68).
--
-- Reversibilidad, con datos vivos:
--   · la columna `customer_taxpayer_type_snapshot`: `drop column` SOLO mientras ningún documento
--     se haya emitido con esta versión; después, dropearla borra el tipo con que se emitió y el
--     libro vuelve a leer el maestro vivo. No se revierte.
--   · libros y trigger: se revierten recreando las definiciones de la 170100 y de
--     20260902173849. Sin pérdida.
-- HOMOLOGATION_IMPACT: YES — cambia el contenido del libro de ventas (RIF y tipo del adquirente
--   sin RIF al emitir, tipo de contribuyente del día de la emisión) y del de compras (RIF de la
--   factura registrada). La versión del generador (`fiscal-books/1.3.0`, sin publicar) lo cubre.
-- =============================================================================

-- ── 1. El tipo de contribuyente del adquirente, como se emitió (B3) ─────────
alter table public.documents add column customer_taxpayer_type_snapshot text;
comment on column public.documents.customer_taxpayer_type_snapshot is
  'Tipo de contribuyente del cliente al emitir (re-revisión 2026-09-28, B3). Congelado con los '
  'demás snapshots del cliente (LAD68). NULL en lo emitido antes de 20260928170200: el libro, '
  'si el documento no tiene snapshot del nombre, cae al maestro.';

-- ── 2. El congelado cubre también el tipo (se fija al emitir, en el INSERT) ──
create or replace function platform.documents_customer_snapshot_freeze()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (new.customer_name_snapshot, new.customer_tax_id_snapshot, new.customer_address_snapshot,
      new.customer_taxpayer_type_snapshot)
     is distinct from
     (old.customer_name_snapshot, old.customer_tax_id_snapshot, old.customer_address_snapshot,
      old.customer_taxpayer_type_snapshot)
  then
    raise exception
      'LAD68: el snapshot del cliente de un documento está congelado (R-05): '
      'se corrige con nota de crédito, no editando el documento'
      using errcode = 'LAD68';
  end if;
  return new;
end;
$$;

-- ── 3. El libro de ventas: el adquirente por el snapshot del NOMBRE (B1, B3) ──
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
         -- El adquirente COMO SE EMITIÓ (hallazgo 1, 170100). B1 (170200): lo que discrimina
         -- «documento anterior a los snapshots» de «emitido sin documento de identidad» es el
         -- snapshot del NOMBRE, que la emisión llena siempre. Un cliente emitido sin RIF sigue
         -- sin RIF aunque después se le cargue; coalesce lo confundía con «no hay snapshot».
         case when d.customer_name_snapshot is not null then d.customer_tax_id_snapshot
              else c.tax_id end,
         coalesce(d.customer_name_snapshot, c.legal_name),
         -- B3 (170200): el tipo de contribuyente del día de la emisión, con la misma regla.
         case when d.customer_name_snapshot is not null then d.customer_taxpayer_type_snapshot
              else c.taxpayer_type_code end,
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
  'número y estado e importes en CERO (G-10, VALIDAR-TRIBUTARIO P-34). El RIF, el nombre y el '
  'tipo de contribuyente del adquirente salen de los SNAPSHOTS del documento (20260928170100 y '
  '20260928170200): si el documento tiene snapshot del nombre, manda el snapshot aunque el RIF '
  'sea NULL; solo lo emitido antes de la migración 33 cae al maestro.';

-- ── 4. El libro de compras: el proveedor por el snapshot del NOMBRE (B1) ──
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
  with base as (
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
  ),
  f as (
    select b.*,
           round(b.tax_amount * b.fx_rate, 8) as iva_lleno,
           round(b.subtotal_amount * b.fx_rate, 8) as sub_lleno
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
           round(n.subtotal_amount * n.fx_rate, 8) as sub_func,
           round(n.tax_amount * n.fx_rate, 8) as iva_func,
           i.tax_is_recoverable, n.journal_entry_id, n.accounting_date
      from public.supplier_credit_notes n
      join public.suppliers s on s.id = n.supplier_id
      join public.supplier_invoices i on i.id = n.supplier_invoice_id
     where n.company_id = p_company
       and n.status in ('posted', 'annulled')
       and i.fiscal_support
       and coalesce(n.accounting_date, n.note_date) between p_from and p_to
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
         n.tax_is_recoverable, n.journal_entry_id,
         coalesce(n.accounting_date, n.note_date), n.accounting_date is not null
    from notas n
   order by 2, 6
$function$;

comment on function platform.purchases_book(uuid, date, date) is
  'Libro de compras en moneda funcional (migraciones 65, 67, 69, 20260928120000, 20260928130100, '
  '20260928170100 y 20260928170200): NC en negativo, anulada en cero, ajuste de período anterior '
  'de la R-2 ampliada, sin las compras sin soporte fiscal, la recibida con retraso en su período '
  'de registro, y el proveedor COMO SE REGISTRÓ la factura (si tiene snapshot del nombre, manda '
  'el snapshot; las anteriores a 20260928170100, del maestro).';
