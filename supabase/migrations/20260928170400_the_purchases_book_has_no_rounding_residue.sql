-- =============================================================================
-- Ladino — EL LIBRO DE COMPRAS POR ALÍCUOTA SIN RESIDUOS, Y LA NC QUE DEVUELVE LO EXENTO
-- (ADR-0073; revisión de los cambios fiscales: A1, A2, A4, A8)
--
-- Módulo: libros fiscales. Rigor máximo (fiscal, con datos vivos).
-- Spec:   REPORTING_AND_FISCAL_BOOKS.md · RLIVA arts. 70, 72 y 75 (fuente secundaria, P-59).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia en qué columna del libro de compras cae una NC recibida
--   sobre una línea exenta, exonerada o no sujeta, y dónde va el residuo de redondeo por alícuota.
--
-- Qué cambia:
--   1. A2: `platform.purchases_book`, create or replace sobre la definición VIVA de la migración
--      20260928170200 (líneas 138-288). Única diferencia (F5, diff contra ella): la NC recibida se
--      reparte por el `tax_treatment` de la línea de factura que devuelve (CTE `notas` y su
--      select final). Antes iba ENTERA a gravadas, también lo exento.
--   2. A1: `platform.purchases_book_by_rate`, mismo tipo de retorno (create or replace sobre
--      150400 §1). El residuo de redondeo entre el renglón (que redondea la suma) y las alícuotas
--      (que redondean cada una) va a la alícuota MAYOR del renglón si es menor que un céntimo; ya
--      no sale como «sin alícuota». Lo que las líneas de verdad no explican (sin categoría, NC sin
--      línea de origen, o una diferencia de un céntimo o más) sigue en las columnas «sin».
--      `purchases_book_summary` lo hereda.
--   3. A4: la migración FALLA si alguna empresa tiene por omisión una categoría que no puede serlo
--      (reducida, adicional, no sujeta o exonerada), con la lista.
--   4. A8: el comentario de 150400 ya nombra la viva (20260928170200); no se edita una migración
--      aplicada.
-- =============================================================================

-- ── 1. A2 · purchases_book: la NC por el tratamiento de su línea de origen ───
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
                              filter (where il.tax_treatment = 'exento'), 0) * n.fx_rate, 8) as exenta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exonerado'), 0) * n.fx_rate, 8)
                 as exonerada_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'no_sujeto'), 0) * n.fx_rate, 8)
                 as no_sujeta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where cl.supplier_invoice_line_id is not null
                                        and il.tax_treatment is null), 0) * n.fx_rate, 8) as sin_n
          from public.supplier_credit_note_lines cl
          left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
         where cl.supplier_credit_note_id = n.id
      ) o
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


-- ── 2. A1 · purchases_book_by_rate: el residuo de redondeo a la alícuota mayor ─
create or replace function platform.purchases_book_by_rate(p_company uuid, p_from date, p_to date)
returns table (
  invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text,
  supplier_kind text, supplier_document_number text, supplier_control_number text,
  supplier_document_ref text, status text, transaction_currency text, fx_rate numeric,
  base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric,
  base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric,
  retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean,
  journal_entry_id uuid, booked_on date, received_late boolean,
  base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric,
  base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric,
  base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric,
  base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric
)
language sql
stable
set search_path = ''
as $$
  -- El renglón de `purchases_book` tal cual, más la base y el IVA por alícuota de sus líneas a la
  -- tasa del documento. Cada alícuota redondea su suma; el renglón redondea la suma entera: entre
  -- los dos puede quedar 1e-8. Ese residuo (si es menor que un céntimo) va a la alícuota MAYOR del
  -- renglón (A1). «Sin alícuota» y «sin clasificar» son lo que las líneas de verdad no explican:
  -- líneas sin categoría, una NC sin línea de origen, o una diferencia de un céntimo o más.
  select p.invoice_id, p.invoice_date, p.supplier_tax_id, p.supplier_name, p.supplier_kind,
         p.supplier_document_number, p.supplier_control_number, p.supplier_document_ref,
         p.status, p.transaction_currency, p.fx_rate, p.base_gravada, p.iva_credito,
         p.iva_al_costo, p.base_exenta, p.base_exonerada, p.base_no_sujeta,
         p.base_sin_clasificar, p.retenido_iva, p.retenido_islr, p.total_amount,
         p.tax_is_recoverable, p.journal_entry_id, p.booked_on, p.received_late,
         r.base_g + case when d.base_a_quien = 'g' then d.res_b else 0 end,
         r.iva_g + case when d.iva_a_quien = 'g' then d.res_i else 0 end, r.rate_g,
         r.base_a + case when d.base_a_quien = 'a' then d.res_b else 0 end,
         r.iva_a + case when d.iva_a_quien = 'a' then d.res_i else 0 end, r.rate_a,
         r.base_r + case when d.base_a_quien = 'r' then d.res_b else 0 end,
         r.iva_r + case when d.iva_a_quien = 'r' then d.res_i else 0 end, r.rate_r,
         r.base_x + case when d.base_a_quien = 'x' then d.res_b else 0 end,
         r.iva_x + case when d.iva_a_quien = 'x' then d.res_i else 0 end
    from platform.purchases_book(p_company, p_from, p_to) with ordinality as p
    cross join lateral (
      select exists (select 1 from public.supplier_credit_notes n where n.id = p.invoice_id)
               as es_nota
    ) t
    cross join lateral (
      select case when p.status = 'ajuste_periodo_anterior' then -1
                  when p.total_amount = 0 then 0
                  when t.es_nota then -1
                  else 1 end as factor
    ) k
    cross join lateral (
      select
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 8)
          * k.factor as base_g,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 8)
          * k.factor as iva_g,
        max(x.rate) filter (where x.cat = 'gravado_general') as rate_g,
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 8)
          * k.factor as base_a,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 8)
          * k.factor as iva_a,
        max(x.rate) filter (where x.cat = 'gravado_adicional') as rate_a,
        round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 8)
          * k.factor as base_r,
        round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 8)
          * k.factor as iva_r,
        max(x.rate) filter (where x.cat = 'gravado_reducida') as rate_r,
        -- Lo gravado sin categoría reconocida, y el IVA de lo que no está en las tres alícuotas.
        round(coalesce(sum(x.sub) filter (
                where x.trat = 'gravado'
                  and (x.cat is null
                       or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida'))),
              0) * p.fx_rate, 8) * k.factor as base_x,
        round(coalesce(sum(x.iva) filter (
                where x.cat is null
                   or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida')),
              0) * p.fx_rate, 8) * k.factor as iva_x
        from (
          select l.line_subtotal_transaction as sub, l.tax_amount as iva,
                 l.tax_category_snapshot as cat, l.tax_rate_snapshot as rate,
                 l.tax_treatment as trat
            from public.supplier_invoice_lines l
           where not t.es_nota and l.supplier_invoice_id = p.invoice_id
          union all
          -- La NC toma la categoría y el tratamiento de la línea que devuelve; sin línea de
          -- origen, el libro la lleva a gravadas, y aquí queda «sin alícuota».
          select cl.line_subtotal_transaction, cl.tax_amount, il.tax_category_snapshot,
                 il.tax_rate_snapshot,
                 coalesce(il.tax_treatment,
                          case when cl.supplier_invoice_line_id is null then 'gravado' end)
            from public.supplier_credit_note_lines cl
            left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
           where t.es_nota and cl.supplier_credit_note_id = p.invoice_id
        ) x
    ) r
    cross join lateral (
      select p.base_gravada - (r.base_g + r.base_a + r.base_r + r.base_x) as res_b,
             (p.iva_credito + p.iva_al_costo) - (r.iva_g + r.iva_a + r.iva_r + r.iva_x) as res_i,
             -- La alícuota mayor presente en el renglón, si la hay.
             case
               when greatest(coalesce(r.rate_g, -1), coalesce(r.rate_a, -1),
                             coalesce(r.rate_r, -1)) < 0 then 'x'
               when coalesce(r.rate_a, -1) >= greatest(coalesce(r.rate_g, -1),
                                                      coalesce(r.rate_r, -1)) then 'a'
               when coalesce(r.rate_g, -1) >= coalesce(r.rate_r, -1) then 'g'
               else 'r'
             end as mayor
    ) e
    cross join lateral (
      select e.res_b, e.res_i,
             case when abs(e.res_b) < 0.01 then e.mayor else 'x' end as base_a_quien,
             case when abs(e.res_i) < 0.01 then e.mayor else 'x' end as iva_a_quien
    ) d
   order by p.ordinality
$$;
comment on function platform.purchases_book_by_rate(uuid, date, date) is
  'Libro de compras con la base y el IVA POR ALÍCUOTA (general, general + adicional, reducida). El '
  'residuo de redondeo (< 1 céntimo) va a la alícuota mayor del renglón (A1); lo que las líneas no '
  'explican, a base_gravada_sin_alicuota e iva_sin_clasificar. Hallazgo 6, RLIVA arts. 72 y 75 '
  '(fuente secundaria, P-59). SECURITY INVOKER a propósito (pgTAP 081d, variante rota).';

-- ── 3. A4 · ninguna empresa con una categoría por omisión que no puede serlo ─
do $$
declare
  v_lista text;
begin
  select string_agg(company_id::text || ' (' || default_tax_category_code || ')', ', ')
    into v_lista
    from public.company_settings
   where default_tax_category_code in ('gravado_reducida', 'gravado_adicional', 'no_sujeto',
                                       'exonerado');
  if v_lista is not null then
    raise exception 'ADR-0073 (A4): empresas con una categoría por omisión que no puede serlo: %', v_lista
      using hint = 'Cámbiala a gravado_general o exento antes de aplicar esta migración';
  end if;
end $$;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ.
--   · `purchases_book` vuelve a la definición de 20260928170200 con otro create or replace (la NC
--     entera en gravadas). Un libro de compras ya exportado con NC sobre líneas exentas daría otro
--     hash.
--   · `purchases_book_by_rate` vuelve a la de 150400 §1 con create or replace (mismo tipo).
--   · La comprobación de A4 no cambia datos.
-- =============================================================================
