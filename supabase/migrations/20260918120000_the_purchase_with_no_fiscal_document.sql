-- =============================================================================
-- Ladino — migración 69 · LA COMPRA SIN SOPORTE FISCAL (ADR-0066 §2)
--
-- El caso que hoy no cabe: el dueño compra veinte sacos en efectivo y no le dan
-- factura. La pantalla exige el número y el número de control, así que lo que
-- ocurre es una de dos: se escribe «S/N» —y a la segunda compra del mismo
-- proveedor el índice único responde «ya existe una factura con ese número»,
-- un 409 que ahí no protege de nada— o se registra como aporte del dueño, y
-- entonces el dinero que salió de la caja no sale en ningún sitio.
--
-- Desde aquí existe un tercer documento: la compra CON proveedor y SIN soporte
-- fiscal. Entra al depósito al costo pagado, el dinero sale o queda deuda,
-- **no entra al libro de compras** y **no genera crédito fiscal**, y queda
-- marcada y filtrable para el contador.
--
-- LO QUE NO HACE FALTA, y es la parte buena: ninguna plantilla nueva. Un
-- documento sin IVA discriminado nace con `tax_amount = 0` y
-- `tax_is_recoverable = false`, y la rama que ya existe en el preset
-- —`if_tax_not_recoverable`: todo al costo contra cuentas por pagar— lo asienta
-- correctamente. Lo que hace falta es marcarlo y sacarlo del libro.
--
-- Y lo que NO se toca: `recompute_iva_period`. Suma el IVA de las facturas con
-- `tax_is_recoverable`, y el CHECK de esta migración garantiza que una compra
-- sin soporte lleva impuesto cero y no recuperable: la declaración la ignora
-- por construcción, sin tocar una función viva (la lección de la migración 67).
--
-- VALIDAR-TRIBUTARIO (PENDIENTES_ASESOR P-27 y P-28): qué documento respalda en
-- Venezuela una compra a quien no factura, qué efecto tiene en el costo
-- deducible para ISLR, y si se retiene sobre ella. Registrar que salió dinero
-- no es una afirmación tributaria; declarar el costo, sí.
--
-- Reversibilidad: el DDL se revierte, pero **los documentos ya marcados no se
-- pueden representar sin la columna**: revertir con datos vivos los convertiría
-- en facturas normales que entrarían al libro. Es de ida.
-- HOMOLOGATION_IMPACT = YES: aparece un documento de compra que no entra al
-- libro, y el correlativo del proveedor deja de ser obligatorio.
-- =============================================================================

-- ── 1. La marca y lo que deja de ser obligatorio ───────────────────────────
alter table public.supplier_invoices
  add column fiscal_support boolean not null default true;

comment on column public.supplier_invoices.fiscal_support is
  'TRUE (por omisión) = el proveedor entregó factura y el documento va al libro de compras. '
  'FALSE = compra real sin soporte fiscal (ADR-0066 §2): entra al inventario y al dinero, NO al '
  'libro ni al crédito fiscal. VALIDAR-TRIBUTARIO: P-27 y P-28 de PENDIENTES_ASESOR.';

-- El correlativo del proveedor pasa a REFERENCIA: sin factura no hay número que
-- copiar, y exigirlo era lo que empujaba a inventarlo.
alter table public.supplier_invoices
  alter column supplier_document_number drop not null;

alter table public.supplier_invoices
  drop constraint supplier_invoices_doc_number_chk;
alter table public.supplier_invoices
  add constraint supplier_invoices_doc_number_chk
    check (supplier_document_number is null
           or (supplier_document_number = btrim(supplier_document_number)
               and length(supplier_document_number) between 1 and 60));

-- La identificación del emisor NO se deja de exigir: se exige a lo que VA AL
-- LIBRO, que es exactamente el motivo con el que se escribió este CHECK («una
-- factura de compra sin ninguna identificación del emisor no es asentable en el
-- libro», migración 22). Lo que no va al libro no la necesita.
alter table public.supplier_invoices
  drop constraint supplier_invoices_identification_chk;
alter table public.supplier_invoices
  add constraint supplier_invoices_identification_chk
    check (fiscal_support = false
           or supplier_control_number is not null
           or supplier_document_ref is not null);

-- Y la regla que cierra el hueco por el que se colaría un crédito fiscal sin
-- documento: sin soporte no hay impuesto que declarar ni que recuperar. Falla
-- al insertar, no al declarar.
alter table public.supplier_invoices
  add constraint supplier_invoices_no_support_chk
    check (fiscal_support or (tax_amount = 0 and tax_is_recoverable = false));

-- ── 2. La llave del doble pago, ahora condicional ──────────────────────────
-- Sigue siendo la defensa real contra cargar dos veces la misma factura, pero
-- solo puede afirmar algo cuando hay número. Dos compras sin número del mismo
-- proveedor son dos compras, no un duplicado.
drop index public.supplier_invoices_supplier_doc_key;
create unique index supplier_invoices_supplier_doc_key
  on public.supplier_invoices (company_id, supplier_id, lower(supplier_document_number))
  where supplier_document_number is not null;

-- ── 3. El libro de compras no registra lo que no tiene documento ───────────
-- Definición VIVA de la migración 67 con dos filtros añadidos y nada más: el de
-- las facturas y el de las notas por su factura. Se copia el texto en vez de
-- reescribirlo porque reescribir una función de libro desde la memoria ya costó
-- tres columnas de resultado una vez (migración 67).
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
  -- asentó. Cuatro reglas, con su norma:
  --   · la factura ANULADA se registra con importes en CERO: conserva la traza cronológica que
  --     pide el Reglamento art. 70 sin llevar al libro un crédito fiscal que la Ley art. 37
  --     manda deducir;
  --   · la NOTA DE CRÉDITO recibida se registra como documento propio, en NEGATIVO, en el
  --     período de su recepción (LIVA arts. 56 y 37; Reglamento arts. 70 y 75 lit. a);
  --   · una nota anulada, como la factura anulada: en cero;
  --   · la compra SIN SOPORTE FISCAL no se registra: el libro relaciona documentos, y ahí no hay
  --     documento que relacionar (ADR-0066 §2). Su costo y su dinero sí existen; su IVA es cero
  --     por CHECK.
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
       and i.fiscal_support
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
       and i.fiscal_support
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
$function$;

comment on function platform.purchases_book(uuid, date, date) is
  'Libro de compras en moneda funcional: facturas (la anulada en cero), notas de crédito '
  'recibidas en negativo en el período de la nota, y SIN las compras sin soporte fiscal, que no '
  'tienen documento que relacionar (ADR-0066 §2; migraciones 65, 67 y 69).';
