-- =============================================================================
-- Ladino — el libro reproduce el documento; el documento se guarda de una manera, también en
-- el esquema (revisión de la familia «documento de identidad», 2026-09-28)
--
-- Módulo:         documento de identidad (A-08, M-05, O-04, P-02, A-17) + libros fiscales
-- Fuente:         revisión del coordinador (criterio §2.16), hallazgos 1, 4 y 10;
--                 RESPUESTA_RECORRIDO_2026-09-24 P-02 y §7.6.
-- Arregla a:      20260928170000_the_document_is_stored_one_way (familia F5: las funciones
--                 redefinidas parten de su ÚLTIMA definición viva: sales_book de 20260928120000,
--                 purchases_book de 20260928130100, la reparación de 20260928170000).
--
-- Reversibilidad, con datos vivos:
--   · §1 columnas de snapshot de supplier_invoices: `alter table … drop column …` SOLO mientras
--     ninguna factura se haya registrado con esta versión; después, dropearlas borra el
--     proveedor COMO SE REGISTRÓ y el libro vuelve a leer el maestro vivo. No se revierten.
--   · §2 y §3 libros: se revierten recreando las definiciones de 20260928120000 (sales_book) y
--     20260928130100 (purchases_book), que siguen en el repositorio. Sin pérdida de datos.
--   · §4 índices únicos normalizados: `drop index` en cualquier momento, sin pérdida.
--   · §5 la reparación: se revierte recreando la de 20260928170000. Sin pérdida.
-- HOMOLOGATION_IMPACT: YES — cambia el CONTENIDO de los libros fiscales: el de ventas deja de
--   leer el RIF y el nombre del adquirente del maestro vivo y los lee del snapshot del
--   documento emitido; el de compras, del snapshot de la factura registrada. Un libro de un
--   período ya exportado puede cambiar de hash al regenerarse si el maestro había cambiado
--   después de emitir: es justamente el defecto que se cierra (el libro reproducía un dato que
--   la factura no llevaba). La versión del generador (`fiscal-books/1.3.0`, aún sin publicar,
--   compartida con ADR-0073) no se sube: lo cubre.
--
-- CORRIGE UNA AFIRMACIÓN FALSA de la 170000 (su cabecera, «HOMOLOGATION_IMPACT: NO — los
-- documentos emitidos NO se tocan…»): los snapshots no se tocaban, cierto, pero el LIBRO DE
-- VENTAS no leía el snapshot sino `customers.tax_id` vivo, así que normalizar el maestro SÍ
-- cambiaba lo que el libro de un período ya emitido imprimía. Con §2 deja de ser así. Queda
-- dicho también en el COMMENT de la reparación (§6).
-- =============================================================================

-- ── 1. El proveedor como se registró la factura ────────────────────────────
-- Nullable y SIN BACKFILL: las facturas ya posteadas son inmutables (assert_purchase_doc_
-- immutable) y no se tocan; el libro las lee del maestro, como hasta hoy. Las llena el caso de
-- uso al registrar (packages/domain purchases.ts, registerSupplierInvoice).
alter table public.supplier_invoices
  add column supplier_tax_id_snapshot text,
  add column supplier_name_snapshot   text;

comment on column public.supplier_invoices.supplier_tax_id_snapshot is
  'RIF del proveedor tal como estaba al registrar la factura (revisión 2026-09-28, hallazgo 1). '
  'NULL en las registradas antes de 20260928170100: el libro cae al maestro.';
comment on column public.supplier_invoices.supplier_name_snapshot is
  'Razón social del proveedor al registrar la factura. NULL en las anteriores a 20260928170100.';

-- ── 2. El libro de ventas lee el adquirente del snapshot del documento ────
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
         -- Hallazgo 1 (revisión 2026-09-28): el adquirente COMO SE EMITIÓ, del snapshot del
         -- documento (migración 33). Solo lo emitido antes de ella, sin snapshot, cae al maestro.
         coalesce(d.customer_tax_id_snapshot, c.tax_id),
         coalesce(d.customer_name_snapshot, c.legal_name), c.taxpayer_type_code,
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
  'número y estado e importes en CERO (G-10, VALIDAR-TRIBUTARIO P-34). El RIF y el nombre del '
  'adquirente salen del SNAPSHOT del documento (20260928170100): el libro reproduce el documento '
  'emitido, no el maestro vivo; solo lo emitido antes de la migración 33 cae al maestro.';

-- ── 3. El libro de compras lee el proveedor del snapshot de la factura ────
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
           coalesce(f.supplier_tax_id_snapshot, s.tax_id) as tax_id,
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
           coalesce(i.supplier_tax_id_snapshot, s.tax_id) as tax_id,
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
  'Libro de compras en moneda funcional (migraciones 65, 67, 69, 20260928120000, 20260928130100 y '
  '20260928170100): NC en negativo, anulada en cero, ajuste de período anterior de la R-2 ampliada, '
  'sin las compras sin soporte fiscal, la recibida con retraso en su período de registro, y el '
  'proveedor COMO SE REGISTRÓ la factura (snapshot; las anteriores a 20260928170100, del maestro).';

-- ── 4. La defensa de esquema de «normalizar en todos los caminos» (hallazgo 4) ──
-- Clientes ya la tenía (customers_company_tax_id_uidx, migración 20260902173849). Proveedores
-- solo tenía `lower(tax_id)` —«J-1…» y «J1…» convivían— y empresas `unique (tenant_id, tax_id)`
-- literal. El caso de uso ya normaliza; esto hace que un camino que no lo haga (un INSERT a
-- mano, un script) no pueda crear el mismo documento dos veces. Si ya hay choques, FALLA con la
-- lista: se fusionan a mano (o se corre antes la reparación P-02, que también los lista).
-- Los índices viejos quedan: son redundantes, no dañinos (expand; se retiran en otra migración).
do $$
declare
  v_choques text;
begin
  select string_agg(format('%s en %s: %s', c.entidad, c.ambito, c.formas), '; '
                    order by c.entidad, c.ambito)
    into v_choques
    from (
      select 'proveedores' as entidad, 'empresa ' || company_id::text as ambito,
             string_agg(tax_id, ' | ' order by tax_id) as formas
        from public.suppliers
       where tax_id is not null
       group by company_id, upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'))
      having count(*) > 1
      union all
      select 'empresas', 'tenant ' || tenant_id::text, string_agg(tax_id, ' | ' order by tax_id)
        from public.companies
       where upper(tax_id) not like 'PEND-%'
       group by tenant_id, upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'))
      having count(*) > 1
    ) c;
  if v_choques is not null then
    raise exception
      'the_book_reproduces_the_document: hay documentos que normalizan igual — fusiónalos antes de aplicar: %',
      v_choques;
  end if;
end $$;

create unique index suppliers_company_tax_id_normalized_uidx
  on public.suppliers (company_id, upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
  where tax_id is not null;
comment on index public.suppliers_company_tax_id_normalized_uidx is
  'Clave natural del proveedor sobre el documento NORMALIZADO (misma expresión que '
  'customers_company_tax_id_uidx y que normalizarDocumento de @ladino/schemas). Revisión '
  '2026-09-28, hallazgo 4. suppliers_company_tax_id_key (lower) queda redundante.';

create unique index companies_tenant_tax_id_normalized_uidx
  on public.companies (tenant_id, upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')))
  where upper(tax_id) not like 'PEND-%';
comment on index public.companies_tenant_tax_id_normalized_uidx is
  'Un RIF por tenant sobre la forma NORMALIZADA; los marcadores PEND- (empresa sin RIF) quedan '
  'fuera. Revisión 2026-09-28, hallazgo 4. companies_tenant_tax_id_key (literal) queda redundante.';

-- ── 5. La reparación P-02 lista también lo que normaliza a vacío (hallazgo 10) ──
-- Parte de su definición viva (20260928170000). Un documento como «---» normalizaría a '' y
-- quedaría guardado como una cadena vacía que no es nada: ahora se lista y la reparación falla
-- antes de tocar una fila, igual que con los duplicados.
create or replace function platform.tax_id_normalization_repair(p_dry_run boolean default false)
returns table (entity text, changed integer)
language plpgsql
set search_path = ''
as $$
declare
  v_choques text;
  v_vacios text;
  v_n integer;
begin
  -- ── 0. Lo que normaliza a vacío: no hay documento que guardar ─────────────
  select string_agg(format('%s %s: «%s»', v.entidad, v.id, v.tax_id), '; '
                    order by v.entidad, v.id)
    into v_vacios
    from (
      select 'cliente' as entidad, id, tax_id from public.customers
       where tax_id is not null and upper(tax_id) not like 'PEND-%'
         and upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) = ''
      union all
      select 'proveedor', id, tax_id from public.suppliers
       where tax_id is not null and upper(tax_id) not like 'PEND-%'
         and upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) = ''
      union all
      select 'empresa', id, tax_id from public.companies
       where upper(tax_id) not like 'PEND-%'
         and upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) = ''
    ) v;
  if v_vacios is not null then
    raise exception
      'tax_id_normalization_repair: estos documentos normalizan a vacío — corrígelos a mano y vuelve a correrla: %',
      v_vacios;
  end if;

  -- ── 1. Los choques, todos, antes de tocar una fila ────────────────────────
  select string_agg(format('%s en %s: %s → %s', c.entidad, c.ambito, c.formas, c.normalizado),
                    '; ' order by c.entidad, c.ambito, c.normalizado)
    into v_choques
    from (
      select 'clientes' as entidad, 'empresa ' || x.company_id::text as ambito, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id) as formas
        from (select company_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.customers
               where tax_id is not null and upper(tax_id) not like 'PEND-%') x
       group by x.company_id, x.normalizado having count(*) > 1
      union all
      select 'proveedores', 'empresa ' || x.company_id::text, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id)
        from (select company_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.suppliers
               where tax_id is not null and upper(tax_id) not like 'PEND-%') x
       group by x.company_id, x.normalizado having count(*) > 1
      union all
      select 'empresas', 'tenant ' || x.tenant_id::text, x.normalizado,
             string_agg(x.tax_id, ' | ' order by x.tax_id)
        from (select tenant_id, tax_id,
                     upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as normalizado
                from public.companies
               where upper(tax_id) not like 'PEND-%') x
       group by x.tenant_id, x.normalizado having count(*) > 1
    ) c;
  if v_choques is not null then
    raise exception
      'tax_id_normalization_repair: normalizar crearía documentos duplicados — fusiónalos a mano y vuelve a correrla: %',
      v_choques;
  end if;

  -- La versión de reglas del acta que escribe el trigger M4 de companies/customers.
  perform set_config('ladino.rules_version', 'repair-p02', true);

  -- ── 2. Clientes ───────────────────────────────────────────────────────────
  if p_dry_run then
    select count(*)::int into v_n from public.customers
     where tax_id is not null and upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.customers c
         set tax_id = upper(regexp_replace(c.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.customers viejo
       where viejo.id = c.id
         and c.tax_id is not null and upper(c.tax_id) not like 'PEND-%'
         and c.tax_id <> upper(regexp_replace(c.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning c.id, c.tenant_id, c.company_id, viejo.tax_id as anterior, c.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, company_id, 'customer', id, 'customer.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'customers'; changed := v_n; return next;

  -- ── 3. Proveedores (sin trigger de acta propio: la única acta es esta) ────
  if p_dry_run then
    select count(*)::int into v_n from public.suppliers
     where tax_id is not null and upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.suppliers s
         set tax_id = upper(regexp_replace(s.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.suppliers viejo
       where viejo.id = s.id
         and s.tax_id is not null and upper(s.tax_id) not like 'PEND-%'
         and s.tax_id <> upper(regexp_replace(s.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning s.id, s.tenant_id, s.company_id, viejo.tax_id as anterior, s.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, company_id, 'supplier', id, 'supplier.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'suppliers'; changed := v_n; return next;

  -- ── 4. Empresas (el trigger M4 deja además company.tax_id_changed) ────────
  if p_dry_run then
    select count(*)::int into v_n from public.companies
     where upper(tax_id) not like 'PEND-%'
       and tax_id <> upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g'));
  else
    with cambiados as (
      update public.companies co
         set tax_id = upper(regexp_replace(co.tax_id, '[^a-zA-Z0-9]', '', 'g'))
        from public.companies viejo
       where viejo.id = co.id
         and upper(co.tax_id) not like 'PEND-%'
         and co.tax_id <> upper(regexp_replace(co.tax_id, '[^a-zA-Z0-9]', '', 'g'))
      returning co.id, co.tenant_id, viejo.tax_id as anterior, co.tax_id as nuevo
    )
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    select tenant_id, id, 'company', id, 'company.tax_id_normalized',
           'system', now(), 'repair-p02',
           jsonb_build_object('from', anterior, 'to', nuevo, 'reparacion', 'P-02')
      from cambiados;
    get diagnostics v_n = row_count;
  end if;
  entity := 'companies'; changed := v_n; return next;
end;
$$;

-- ── 6. Lo que la reparación hace, dicho sin la afirmación falsa de la 170000 ──
comment on function platform.tax_id_normalization_repair(boolean) is
  'P-02 (recorrido 2026-09-24): normaliza tax_id de customers, suppliers y companies a la forma '
  'que se guarda (mayúsculas, sin separadores; PEND- intacto), con un acta `<agregado>.'
  'tax_id_normalized` por fila cambiada. Idempotente. ANTES de tocar nada falla con la lista si '
  'normalizar crea un duplicado o deja un documento vacío (20260928170100). NO toca los snapshots '
  'de los documentos emitidos (regla 1), y desde 20260928170100 los libros leen esos snapshots: '
  'normalizar el maestro ya no cambia el libro de un período emitido (antes el de ventas leía el '
  'maestro vivo y sí cambiaba). Una sola sentencia, como dueño de la base, tras el git pull: '
  '`select * from platform.tax_id_normalization_repair(false)`; con true solo cuenta.';

revoke execute on function platform.tax_id_normalization_repair(boolean) from public;
