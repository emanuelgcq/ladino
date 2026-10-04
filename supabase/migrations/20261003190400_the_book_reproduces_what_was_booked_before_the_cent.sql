-- =============================================================================
-- Ladino — EL LIBRO REPRODUCE LO QUE SE ASENTÓ ANTES DEL CÉNTIMO
-- (ADR-0075 §7 · L-02 «libro fiscal = mayor + cola» · corrige 20261003140000 / 190000)
--
-- Módulo: libros fiscales · declaración de IVA · contabilidad. Rigor MÁXIMO.
-- Qué pasaba: desde la 20261003140000 el libro de compras convierte round(x × tasa, 2) por renglón
-- PARA TODOS los períodos, pero los asientos anteriores a la regularización del céntimo llevan sus
-- líneas a 8 decimales, y la regularización corrige el saldo con un asiento fechado el día que
-- corre. La conciliación de un período heredado con compras en divisa descuadraba por la fracción
-- (E2, septiembre: libro 179.779,16 contra mayor 179.779,16248), y la del período de la
-- regularización, por el asiento que la lleva. La 140000 afirmó que la conciliación seguía en
-- cero y solo lo probó con asientos nuevos; el invariante del recorrido miraba TODA la historia,
-- donde las dos diferencias se compensan.
--
-- LA REGLA (decidida por criterio, §2.16; alternativa al final):
--   · el renglón de un documento REGISTRADO antes del corte del céntimo de su empresa se reproduce
--     como se generó (a 8 decimales); el de uno posterior va al céntimo. El corte es el instante
--     del acta `accounting.cent_regularized` más antigua de la empresa, contra el `created_at` del
--     documento: instante contra instante, sin fechas de por medio;
--   · la declaración (`recompute_iva_period`) convierte con la misma regla a los dos lados;
--   · la conciliación no cuenta en el mayor el asiento de la regularización del céntimo: no es un
--     hecho fiscal. Se reconoce por el registro privado `platform.cent_regularization_entries`
--     (20261003190200), no por una etiqueta;
--   · una empresa SIN acta (nunca regularizó) convierte todo al céntimo. Si tiene fracciones
--     heredadas, `cent_gaps` ya la señala y su conciliación de períodos viejos descuadra hasta que
--     regularice: no es un caso perdonado, es una empresa pendiente del paso 4 de R-71;
--   · un documento registrado en la ventana entre el `git pull` y la regularización se asienta al
--     céntimo (API nueva) y el libro lo convierte a 8: si su conversión deja fracción, la
--     conciliación lo enseña. R-71 manda regularizar en la misma ventana, sin operar en medio.
-- Por qué así: el libro de un período ya generado o declarado no cambia de cifras (K-08: lo
-- presentado no se reescribe; el hash de `fiscal_book_runs` de un período viejo vuelve a ser el que
-- era antes de la 140000), y concilia EXACTO con su mayor, sin cotas.
-- Alternativa: comparar al céntimo con una cota declarada (|libro − (mayor + cola)| ≤ 0,005 ×
-- renglones) antes del corte. Más simple, pero el libro de un período viejo cambia respecto del
-- que se generó y la conciliación deja de ser exacta.
--
-- Qué cambia (create or replace, cada una sobre su última definición; ninguna posterior las toca):
--   1. `platform.cent_cutover_at(company)` y `platform.cent_regularization_entry_ids(company)`:
--      dos lecturas security definer, una vez por consulta (no por fila). La primera, porque el
--      acta vive en `audit_events`, cuya lectura depende de permisos: el libro no puede cambiar de
--      cifras según quién lo mire.
--   2. `platform.purchases_book` (sobre 20261003190100).
--   3. `platform.purchases_book_by_rate` (sobre 20261003190000).
--   4. `platform.recompute_iva_period` (sobre 20261003190000).
--   5. `platform.book_ledger_reconciliation` (sobre 20260831173150).
-- `purchases_book_summary` y `purchases_book_with_vouchers` leen de `by_rate`: quedan cubiertas.
-- El libro de VENTAS no cambia: sus importes vienen congelados en el documento y su conciliación
-- cuadraba en los períodos viejos (comprobado en E2 y E3, septiembre).
-- Reversible: SÍ, create or replace con las definiciones citadas; son funciones de lectura. Al
--   revertir, los libros de períodos anteriores al corte vuelven al céntimo y descuadran con su
--   mayor por la fracción. Los `fiscal_book_runs` generados entre la 140000 y esta quedan con el
--   hash que tenían (append-only).
-- HOMOLOGATION_IMPACT: YES — cambian las cifras del libro de compras y de la declaración de los
--   períodos ANTERIORES al corte del céntimo: vuelven a ser las que se generaron (8 decimales).
--   Los períodos posteriores no cambian.
-- =============================================================================

-- ── 1. El corte y los asientos de la regularización, leídos una vez ─────────
create function platform.cent_cutover_at(p_company uuid)
returns timestamptz
language sql
stable
security definer
set search_path = ''
as $$
  select min(a.occurred_at) from public.audit_events a
   where a.company_id = p_company and a.event_type = 'accounting.cent_regularized'
$$;
comment on function platform.cent_cutover_at(uuid) is
  'ADR-0075 §7: el corte del céntimo de una empresa — el instante de su primera regularización '
  '(acta accounting.cent_regularized). NULL si nunca regularizó. Lo que se registró antes se '
  'asentó a 8 decimales; lo posterior, al céntimo. Security definer: el libro no puede dar '
  'cifras distintas según los permisos de quien lo consulta. Se llama UNA vez por consulta.';
revoke execute on function platform.cent_cutover_at(uuid) from public;
grant execute on function platform.cent_cutover_at(uuid) to authenticated, ladino_api, service_role;

create function platform.cent_regularization_entry_ids(p_company uuid)
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.entry_id from platform.cent_regularization_entries e where e.company_id = p_company
$$;
comment on function platform.cent_regularization_entry_ids(uuid) is
  'ADR-0075 §7: los ids de los asientos de regularización del céntimo de una empresa, para que la '
  'conciliación libro ↔ mayor no los cuente (no son hechos fiscales). Solo ids: las filas del '
  'diario siguen bajo su RLS. Se llama UNA vez por consulta.';
revoke execute on function platform.cent_regularization_entry_ids(uuid) from public;
grant execute on function platform.cent_regularization_entry_ids(uuid)
  to authenticated, ladino_api, service_role;

-- ── 2. El libro de compras ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.purchases_book(p_company uuid, p_from date, p_to date)
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
  --   · EL CORTE DEL CÉNTIMO (20261003190400, ADR-0075 §7): el renglón de un documento REGISTRADO
  --     antes de la regularización del céntimo de la empresa se reproduce como se generó, a 8
  --     decimales; el de uno posterior va al céntimo. Instante contra instante: `created_at` del
  --     documento contra el acta `accounting.cent_regularized` más antigua. Sin acta, todo al
  --     céntimo. Así el libro de un período viejo concilia exacto con su mayor y no cambia
  --     respecto del que se generó o declaró.
  with corte as (select platform.cent_cutover_at(p_company) as t),
  empresa as (
    select coalesce((select upper(btrim(c.tax_id)) like 'PEND-%'
                       from public.companies c where c.id = p_company), false) as sin_rif
  ),
  base as (
    select i.*,
           case when (select t from corte) is not null and i.created_at <= (select t from corte) then 8 else 2 end as esc,
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
           round(b.tax_amount * b.fx_rate, b.esc) + 0.00000000 as iva_lleno,
           round(b.subtotal_amount * b.fx_rate, b.esc) + 0.00000000 as sub_lleno
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
                          filter (where l.tax_treatment = 'gravado'), 0) * f.fx_rate, f.esc) + 0.00000000 as gravada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exento'), 0) * f.fx_rate, f.esc) + 0.00000000 as exenta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'exonerado'), 0) * f.fx_rate, f.esc) + 0.00000000
             as exonerada,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment = 'no_sujeto'), 0) * f.fx_rate, f.esc) + 0.00000000
             as no_sujeta,
           round(coalesce(sum(l.line_subtotal_transaction)
                          filter (where l.tax_treatment is null), 0) * f.fx_rate, f.esc) + 0.00000000
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
     group by f.id, f.esc, f.invoice_date, f.dia_ajuste, f.supplier_document_number,
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
           round(n.subtotal_amount * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000 as sub_func,
           round(n.tax_amount * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000 as iva_func,
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
                              filter (where il.tax_treatment = 'exento'), 0) * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000 as exenta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'exonerado'), 0) * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000
                 as exonerada_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where il.tax_treatment = 'no_sujeto'), 0) * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000
                 as no_sujeta_n,
               round(coalesce(sum(cl.line_subtotal_transaction)
                              filter (where cl.supplier_invoice_line_id is not null
                                        and il.tax_treatment is null), 0) * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000 as sin_n
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

-- ── 3. El libro de compras por alícuota ─────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.purchases_book_by_rate(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(invoice_id uuid, invoice_date date, supplier_tax_id text, supplier_name text, supplier_kind text, supplier_document_number text, supplier_control_number text, supplier_document_ref text, status text, transaction_currency text, fx_rate numeric, base_gravada numeric, iva_credito numeric, iva_al_costo numeric, base_exenta numeric, base_exonerada numeric, base_no_sujeta numeric, base_sin_clasificar numeric, retenido_iva numeric, retenido_islr numeric, total_amount numeric, tax_is_recoverable boolean, journal_entry_id uuid, booked_on date, received_late boolean, base_alicuota_general numeric, iva_alicuota_general numeric, alicuota_general numeric, base_alicuota_adicional numeric, iva_alicuota_adicional numeric, alicuota_adicional numeric, base_alicuota_reducida numeric, iva_alicuota_reducida numeric, alicuota_reducida numeric, base_gravada_sin_alicuota numeric, iva_sin_clasificar numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- El renglón de `purchases_book` tal cual, más la base y el IVA por alícuota de sus líneas a la
  -- tasa del documento, AL CÉNTIMO. Cada alícuota redondea su suma; el renglón redondea la suma
  -- entera: entre los dos puede quedar un número entero de céntimos. Ese residuo, si es de un
  -- céntimo o menos (`<= 0.01`), va a la alícuota MAYOR del renglón (A1). «Sin alícuota» y «sin
  -- clasificar» son lo que las líneas de verdad no explican: líneas sin categoría, una NC sin
  -- línea de origen, o una diferencia de más de un céntimo.
  -- B1 (20261003190000): el signo del renglón multiplica al importe YA redondeado y con su
  -- escala — `(round(…, 2) + 0.00000000) * k.factor`. Sin el paréntesis, el factor multiplicaba
  -- al cero y no al importe: la NC y el ajuste salían en positivo y la anulada con su importe.
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
    cross join (select platform.cent_cutover_at(p_company) as t offset 0) c
    cross join lateral (
      select exists (select 1 from public.supplier_credit_notes n where n.id = p.invoice_id)
               as es_nota
    ) t
    -- 20261003190400: la misma escala que el renglón (8 antes del corte del céntimo, 2 después).
    cross join lateral (
      select case when c.t is not null
                   and coalesce((select n.created_at from public.supplier_credit_notes n
                                  where n.id = p.invoice_id),
                                (select i.created_at from public.supplier_invoices i
                                  where i.id = p.invoice_id)) <= c.t
                  then 8 else 2 end as esc
    ) s
    cross join lateral (
      select case when p.status = 'ajuste_periodo_anterior' then -1
                  when p.total_amount = 0 then 0
                  when t.es_nota then -1
                  else 1 end as factor
    ) k
    cross join lateral (
      select
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as base_g,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as iva_g,
        max(x.rate) filter (where x.cat = 'gravado_general') as rate_g,
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as base_a,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as iva_a,
        max(x.rate) filter (where x.cat = 'gravado_adicional') as rate_a,
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as base_r,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, s.esc) + 0.00000000)
          * k.factor as iva_r,
        max(x.rate) filter (where x.cat = 'gravado_reducida') as rate_r,
        -- Lo gravado sin categoría reconocida, y el IVA de lo que no está en las tres alícuotas.
        (round(coalesce(sum(x.sub) filter (
                where x.trat = 'gravado'
                  and (x.cat is null
                       or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida'))),
              0) * p.fx_rate, s.esc) + 0.00000000) * k.factor as base_x,
        (round(coalesce(sum(x.iva) filter (
                where x.cat is null
                   or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida')),
              0) * p.fx_rate, s.esc) + 0.00000000) * k.factor as iva_x
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
             case when abs(e.res_b) <= 0.01 then e.mayor else 'x' end as base_a_quien,
             case when abs(e.res_i) <= 0.01 then e.mayor else 'x' end as iva_a_quien
    ) d
   order by p.ordinality
$function$;

-- ── 4. La declaración de IVA ────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric, p_retenciones_anteriores numeric DEFAULT 0)
 RETURNS TABLE(debitos numeric, creditos numeric, creditos_deducibles numeric, prorrata_pct numeric, retenciones_soportadas numeric, cuota_a_pagar numeric, excedente_siguiente numeric, detalle jsonb, ajuste_creditos_anteriores numeric, retenciones_acumuladas_por_descontar numeric)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  -- 20261003190400: los créditos, las notas de crédito y el ajuste convierten con la escala del
  -- libro de compras a los dos lados del corte del céntimo (ver platform.purchases_book).
  with corte as (select platform.cent_cutover_at(p_company) as t),
  ventas as (
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
    union all
    -- 20261003110000 (ADR-0078 §3, LIVA art. 4.3): el débito fiscal del retiro, por su alícuota.
    select 1, n.tax_rate_snapshot, n.base_functional, n.tax_functional, n.tax_functional,
           'withdrawal_note'::text
      from public.inventory_withdrawal_notes n
     where n.company_id = p_company
       and (n.issued_at at time zone 'America/Caracas')::date between p_from and p_to
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
    -- AF3-09 (20261003190000, ADR-0075 §7; RLIVA art. 72): la MISMA regla que el libro de compras.
    -- Cada documento se convierte a bolívares AL CÉNTIMO —round(iva × tasa, 2), como
    -- platform.purchases_book— y la declaración suma esos céntimos. Antes convertía a 8 decimales
    -- mientras el libro iba a 2: el resumen del libro y lo declarado diferían en la fracción.
    -- Vale para los créditos, las notas de crédito y el ajuste de períodos anteriores.
    -- El IVA de la factura de proveedor, a la tasa con la que se asentó, MENOS el de las NOTAS
    -- DE CRÉDITO recibidas en el período. LIVA art. 37: el impuesto de la operación
    -- posteriormente anulada se deduce del crédito fiscal; art. 56: se registran las notas que
    -- se emitan o RECIBAN. El período es el de la NOTA, no el de la factura que corrige.
    -- La anulada DESPUÉS de cerrar y presentar su período sigue contando en él: esa planilla
    -- no cambia (R-2 ampliada); su reversa va en `ajuste` del período de la anulación.
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, case when (select t from corte) is not null and i.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000)
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
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, case when (select t from corte) is not null and n.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000)
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
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, case when (select t from corte) is not null and i.created_at <= (select t from corte) then 8 else 2 end) + 0.00000000), 0) as total
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
                     -- B-1 (20261002120400): solo una generación hecha DESPUÉS de cerrar su
                     -- período declara; una vista previa a mitad de quincena, o la de un período
                     -- futuro, no. Día contra día (caracas_day de la generación).
                     and p.period_to < platform.caracas_day(p.created_at)
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

-- ── 5. La conciliación libro ↔ mayor ────────────────────────────────────────
CREATE OR REPLACE FUNCTION platform.book_ledger_reconciliation(p_company uuid, p_from date, p_to date)
 RETURNS TABLE(concepto text, libro numeric, mayor numeric, en_cola numeric, diferencia numeric, cuadra boolean)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  with regularizacion as (
    select x as entry_id from platform.cent_regularization_entry_ids(p_company) x
  ),
  vigente as (
    select purpose, account_id from public.company_account_settings
     where company_id = p_company and effective_to is null
  ),
  -- El `exists` va en el ON del left join, no en el WHERE: en el WHERE
  -- descartaría el papel entero cuando no tiene ni una línea en el período, y
  -- lo que se quiere es que ese papel salga con saldo cero.
  mayor as (
    select v.purpose,
           coalesce(sum(jl.functional_credit - jl.functional_debit), 0) as acreedor,
           coalesce(sum(jl.functional_debit - jl.functional_credit), 0) as deudor
      from vigente v
      left join public.journal_lines jl
        on jl.account_id = v.account_id
       and jl.company_id = p_company
       and exists (select 1 from public.journal_entries e
                    where e.id = jl.entry_id
                      and e.status in ('posted', 'reversed')
                      and e.posting_date between p_from and p_to
                      -- 20261003190400: el asiento de la regularización del céntimo no es un
                      -- hecho fiscal (lleva a redondeo la fracción heredada): no cuenta.
                      and e.id not in (select r.entry_id from regularizacion r))
     group by v.purpose
  ),
  libro_ventas as (
    select coalesce(sum(iva_debito), 0) as iva,
           coalesce(sum(iva_debito) filter (where journal_entry_id is null), 0) as sin_asiento
      from platform.sales_book(p_company, p_from, p_to)
     where status <> 'annulled'
  ),
  libro_compras as (
    select coalesce(sum(iva_credito), 0) as iva,
           coalesce(sum(iva_credito) filter (where journal_entry_id is null), 0) as sin_asiento
      from platform.purchases_book(p_company, p_from, p_to)
     where status <> 'annulled'
  ),
  cifras as (
    select 'iva_debito_fiscal'::text as concepto, v.iva as libro,
           coalesce((select acreedor from mayor where purpose = 'iva_debit_fiscal'), 0) as mayor,
           v.sin_asiento as en_cola
      from libro_ventas v
    union all
    select 'iva_credito_fiscal', c.iva,
           coalesce((select deudor from mayor where purpose = 'iva_credit_fiscal'), 0),
           c.sin_asiento
      from libro_compras c
  )
  select concepto, libro, mayor, en_cola,
         libro - mayor - en_cola,
         libro - mayor - en_cola = 0
    from cifras
$function$;
comment on function platform.book_ledger_reconciliation(uuid, date, date) is
  'INVARIANTE L-02: libro fiscal = mayor + cola, por concepto y EXACTO, en cualquier rango de '
  'fechas. El mayor no cuenta el asiento de la regularización del céntimo (registro privado '
  'platform.cent_regularization_entries), que no es un hecho fiscal. El libro de compras '
  'reproduce a 8 decimales lo registrado antes del corte del céntimo y al céntimo lo posterior, '
  'así que cuadra a los dos lados (20261003190400).';
