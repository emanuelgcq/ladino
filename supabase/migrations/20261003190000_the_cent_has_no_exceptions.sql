-- =============================================================================
-- Ladino — EL CÉNTIMO NO TIENE EXCEPCIONES (ADR-0075 §7; arreglos de la revisión de la ola 3)
--
-- Módulo: libros · declaración de IVA · contabilidad · inventario. Rigor MÁXIMO (dinero, con
--   datos vivos). Corrige 20261003140000 y 20261003140100, con su propia auditoría (CLAUDE.md §3).
-- Spec:   ADR-0075 §7 y su nota de aplicación · MONEY_AND_ROUNDING_SPEC.md §6.6 · ADR-0069.
-- Reversible: SÍ para el esquema, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia el libro de compras por alícuota (signo de la NC, del ajuste
--   de período anterior y de la anulada) y la conversión a bolívares de los créditos fiscales de
--   la declaración de IVA (de 8 decimales al céntimo, la misma regla del libro).
--
-- LO QUE LAS CABECERAS ANTERIORES DECÍAN Y NO ERA CIERTO (una migración aplicada no se edita: la
-- corrección queda escrita aquí):
--   · 20261003140100 decía «El VALOR es el mismo» y «HOMOLOGATION_IMPACT: NO adicional». FALSO.
--     En `purchases_book_by_rate` escribió `round(…, 2) + 0.00000000 * k.factor`: por precedencia
--     el factor (−1 en la NC y en el ajuste de período anterior, 0 en la anulada) multiplicaba al
--     cero y no al importe. El libro por alícuota sacaba la NC y el ajuste en POSITIVO y la
--     anulada con su importe. pgTAP 081d fallaba 6 de 23. HOMOLOGATION_IMPACT era YES.
--     Las otras 13 apariciones de `+ 0.00000000` de esa migración (todas en `purchases_book`) se
--     revisaron una por una: ninguna va seguida de un operador, el `+` es lo último de su
--     expresión y el factor se aplica después sobre la columna ya calculada. Están bien.
--   · 20261003140000 decía que el libro de compras pasa al céntimo «y con él la declaración que
--     lo lee». La declaración NO lee del libro: `recompute_iva_period` suma por su cuenta las
--     facturas, y seguía convirtiendo a 8 decimales. Aquí pasa al céntimo (AF3-09).
--   · 20261003140000 nombra `platform.cent_regularization_repair(company, ensayo)` en su cabecera
--     y en el comentario del oráculo. Esa función NO existe: son `cent_regularization_prepare` y
--     `cent_regularization_finish`, con el posteo en el dominio (`repairCents`).
--   · El comentario de `purchases_book_by_rate` decía «entre los dos puede quedar 1e-8 … si es
--     menor que un céntimo» con el código en `<= 0.01`. Con todo al céntimo el residuo es un
--     número entero de céntimos y la regla es «un céntimo o menos».
--   · El enunciado de `cent_gaps` perdonaba «la reversa exacta de un asiento anterior al corte»
--     en la rama de líneas y no en la de saldos: se contradecía. Aquí deja de perdonar (§4).
--
-- Qué cambia:
--   1. `platform.purchases_book_by_rate` — create or replace sobre 20261003140100 (la última que
--      la define). Única diferencia: `(round(…, 2) + 0.00000000) * k.factor` en los 8 sitios, y
--      su comentario.
--   2. `platform.recompute_iva_period` — create or replace sobre 20261003110000 (la última que la
--      define; ni la 170000 ni la 180000 la tocan). Única diferencia: los tres
--      `sum(round(x × tasa, 8))` pasan a `sum(round(x × tasa, 2) + 0.00000000)`.
--   3. `platform.assert_entry_balanced` — create or replace sobre 20260827233538 (la única que la
--      define). Única diferencia: al postear, una línea con más de dos decimales en moneda
--      funcional es LAD71. Los asientos ya posteados no se tocan.
--   4. `platform.cent_gaps` — sin la salvedad de la reversa. Cero, sin perdones.
--   5. `platform.cent_regularization_prepare` / `_finish` — la posición VACÍA con valor real ya no
--      se va entera a redondeo; la empresa sin contabilidad regulariza su kardex y encola.
-- =============================================================================

-- ── 1. El libro de compras por alícuota: el signo multiplica al importe ─────
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
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as base_g,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_general'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as iva_g,
        max(x.rate) filter (where x.cat = 'gravado_general') as rate_g,
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as base_a,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_adicional'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as iva_a,
        max(x.rate) filter (where x.cat = 'gravado_adicional') as rate_a,
        (round(coalesce(sum(x.sub) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as base_r,
        (round(coalesce(sum(x.iva) filter (where x.cat = 'gravado_reducida'), 0) * p.fx_rate, 2) + 0.00000000)
          * k.factor as iva_r,
        max(x.rate) filter (where x.cat = 'gravado_reducida') as rate_r,
        -- Lo gravado sin categoría reconocida, y el IVA de lo que no está en las tres alícuotas.
        (round(coalesce(sum(x.sub) filter (
                where x.trat = 'gravado'
                  and (x.cat is null
                       or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida'))),
              0) * p.fx_rate, 2) + 0.00000000) * k.factor as base_x,
        (round(coalesce(sum(x.iva) filter (
                where x.cat is null
                   or x.cat not in ('gravado_general', 'gravado_adicional', 'gravado_reducida')),
              0) * p.fx_rate, 2) + 0.00000000) * k.factor as iva_x
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
$$;

-- ── 2. La declaración de IVA convierte como el libro: al céntimo ────────────
CREATE OR REPLACE FUNCTION platform.recompute_iva_period(p_company uuid, p_from date, p_to date, p_excedente_anterior numeric, p_retenciones_anteriores numeric DEFAULT 0)
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
    select coalesce((select sum(round(i.tax_amount * i.fx_rate, 2) + 0.00000000)
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
         - coalesce((select sum(round(n.tax_amount * n.fx_rate, 2) + 0.00000000)
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
    select -coalesce(sum(round(i.tax_amount * i.fx_rate, 2) + 0.00000000), 0) as total
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

-- ── 3. Al postear, ninguna línea con más de dos decimales (LAD71) ───────────
CREATE OR REPLACE FUNCTION platform.assert_entry_balanced()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_debit  numeric;
  v_credit numeric;
  v_lines  integer;
  v_period public.fiscal_periods;
  l        record;
  v_fuera  record;
begin
  if new.status <> 'posted' then return new; end if;
  if tg_op = 'UPDATE' and old.status = 'posted' then return new; end if;

  select count(*), coalesce(sum(functional_debit), 0), coalesce(sum(functional_credit), 0)
    into v_lines, v_debit, v_credit
    from public.journal_lines where entry_id = new.id;

  if v_lines < 2 then
    raise exception 'un asiento de partida doble necesita al menos dos líneas; tiene %', v_lines
      using errcode = 'LAD59';
  end if;
  if v_debit <> v_credit then
    raise exception
      'la partida doble no cuadra en moneda funcional: débitos % ≠ créditos % (diferencia %)',
      v_debit, v_credit, v_debit - v_credit
      using errcode = 'LAD59',
            hint = 'la diferencia se comprueba en moneda funcional, que es la que va al mayor';
  end if;
  if v_debit = 0 then
    raise exception 'un asiento de importe cero no es un hecho contable' using errcode = 'LAD59';
  end if;

  -- ADR-0075 §7 (C5c, 20261003190000): NINGÚN IMPORTE DEL MAYOR CON MÁS DE DOS DECIMALES. Se
  -- comprueba aquí, donde se comprueba la partida doble, y por la misma razón: es un invariante
  -- del dato, y una aplicación se puede saltar. El enunciado completo: al POSTEAR, toda línea va
  -- al céntimo en moneda funcional, salvo el asiento de la REGULARIZACIÓN DEL CÉNTIMO
  -- (inventory_move / stock.cent_regularized), cuyo oficio es precisamente llevarse la fracción
  -- y que solo escribe platform.cent_regularization_prepare (sin GRANT a nadie). Los asientos ya
  -- posteados no pasan por aquí (ver arriba) y no se tocan. La reversa de un asiento viejo con
  -- fracción se genera al céntimo (accounting.ts, reversar), así que tampoco es excepción.
  if not (new.source_kind = 'inventory_move'
          and coalesce(new.source_event, '') = 'stock.cent_regularized') then
    select jl.line_number, greatest(jl.functional_debit, jl.functional_credit) as importe
      into v_fuera
      from public.journal_lines jl
     where jl.entry_id = new.id
       and (jl.functional_debit <> round(jl.functional_debit, 2)
            or jl.functional_credit <> round(jl.functional_credit, 2))
     order by jl.line_number
     limit 1;
    if found then
      raise exception 'Los importes del asiento llevan como máximo dos decimales'
        using errcode = 'LAD71',
              detail = format('línea %s: %s', v_fuera.line_number, v_fuera.importe),
              hint = 'el mayor va al céntimo (ADR-0075 §7): redondea el importe antes de postear';
    end if;
  end if;

  -- El período tiene que estar abierto A LA FECHA DEL ASIENTO.
  select * into v_period from public.fiscal_periods
   where id = new.period_id and company_id = new.company_id;
  if v_period.status = 'closed' then
    raise exception
      'el período %-% está CERRADO: no admite asientos. Reabrirlo exige permiso y motivo escrito',
      v_period.year, v_period.month
      using errcode = 'LAD61';
  end if;

  -- Y cada línea tiene que ir a una cuenta que admita movimiento.
  for l in
    select jl.account_id, jl.analytical_dimensions, a.is_leaf, a.is_active,
           a.requires_analytical, a.code
      from public.journal_lines jl
      join public.accounts a on a.id = jl.account_id
     where jl.entry_id = new.id
  loop
    if not l.is_leaf then
      raise exception
        'la cuenta % agrupa y no recibe asientos: usa una de sus hojas', l.code
        using errcode = 'LAD62';
    end if;
    if not l.is_active then
      raise exception 'la cuenta % está desactivada', l.code using errcode = 'LAD62';
    end if;
    if l.requires_analytical
       and (l.analytical_dimensions is null or l.analytical_dimensions = '{}'::jsonb) then
      raise exception
        'la cuenta % exige dimensiones analíticas y la línea no las trae', l.code
        using errcode = 'LAD62';
    end if;
  end loop;
  return new;
end;
$function$;

-- ── 4. El invariante, sin perdones ──────────────────────────────────────────
-- Antes admitía una línea con fracción si era la reversa exacta de un asiento anterior al corte;
-- pero la rama `account_balance` no la admitía, y revertir un asiento viejo tras regularizar
-- dejaba el saldo en −fracción. Desde esta migración la reversa se genera AL CÉNTIMO (cada línea
-- espejo redondeada y el residuo a «Diferencias por redondeo»), y la base rechaza al postear
-- cualquier línea con fracción (§3): la salvedad sobra.
create or replace function platform.cent_gaps(p_company uuid)
returns table (kind text, id uuid, amount numeric)
language sql
stable
set search_path = ''
as $$
  with corte as (
    select max(a.occurred_at) as t from public.audit_events a
     where a.company_id = p_company and a.event_type = 'accounting.cent_regularized'
  )
  select 'journal_line'::text, jl.id, greatest(jl.functional_debit, jl.functional_credit)
    from public.journal_lines jl
    join public.journal_entries e on e.id = jl.entry_id and e.company_id = p_company
    cross join corte
   where jl.company_id = p_company
     and (jl.functional_debit <> round(jl.functional_debit, 2)
          or jl.functional_credit <> round(jl.functional_credit, 2))
     and (corte.t is null or e.created_at > corte.t)
  union all
  select 'inventory_move', m.id, m.functional_amount
    from public.inventory_moves m cross join corte
   where m.company_id = p_company
     and m.functional_amount <> round(m.functional_amount, 2)
     and (corte.t is null or m.created_at > corte.t)
  union all
  select 'stock_balance', b.id, b.value
    from public.stock_balances b
   where b.company_id = p_company and b.value <> round(b.value, 2)
  union all
  select 'account_balance', s.account_id, s.saldo
    from (select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as saldo
            from public.journal_lines jl
            join public.journal_entries e on e.id = jl.entry_id
           where jl.company_id = p_company and e.status in ('posted', 'reversed')
           group by jl.account_id) s
   where s.saldo <> round(s.saldo, 2)
$$;
comment on function platform.cent_gaps(uuid) is
  'INVARIANTE (ADR-0075 §7): ninguna línea de asiento ni movimiento de kardex posterior a la '
  'regularización del céntimo con más de dos decimales, ningún valor de posición y ningún saldo '
  'de cuenta con fracción de céntimo. Sin salvedades: la reversa de un asiento viejo se genera al '
  'céntimo. La respuesta correcta es CERO filas.';

-- ── 5. La regularización al corte ───────────────────────────────────────────
-- Sobre 20261003140000 §6. Tres diferencias:
--   · C4/C5a — LA POSICIÓN VACÍA. Antes, con cantidad 0, mandaba TODO su valor a «Diferencias por
--     redondeo», sin tope: una posición vacía con valor real (una entrada sobre existencia
--     negativa a otro costo, ADR-0034 §Negativo) escondía una diferencia de costo en 5.1.10.
--     Ahora es polvo de redondeo solo si |valor| ≤ 0,005 × (movimientos de esa posición) — medio
--     céntimo por movimiento es lo más que el redondeo pudo dejar—, y entonces va entero a
--     redondeo (la regla del dueño: «cuando la cantidad llega a 0 con céntimos residuales»). Por
--     encima, solo la FRACCIÓN de céntimo va a redondeo; el resto queda visible en el valor y la
--     función lo devuelve en `visible_empty_positions` (producto, depósito, importe). Nada falla
--     y nada se esconde.
--   · C5b — LA EMPRESA SIN CONTABILIDAD (sin cuenta de inventario). Antes fallaba (y el dominio
--     la saltaba): `cent_gaps` quedaba en rojo para siempre, «uno, pero es el conocido». Ahora su
--     KARDEX se regulariza igual y el asiento va a la COLA de pendientes
--     (`journal_generation_queue`), como cualquier movimiento de valor sin contabilidad:
--     `inventory_coverage_gaps` lo acepta por la cola.
--   · C1 — la empresa CON mayor y sin papel de inventario (servicios) regulariza su mayor: ya lo
--     hacía esta función; quien la saltaba era el dominio.
create or replace function platform.cent_regularization_prepare(
  p_company uuid, p_ensayo boolean default false)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_tenant uuid;
  v_moneda text;
  v_reg uuid := gen_random_uuid();
  v_fecha date := (now() at time zone 'America/Caracas')::date;
  v_inv uuid;
  v_red uuid;
  v_k record;
  v_l record;
  v_k_total numeric := 0;
  v_gap numeric;
  v_adj_inv numeric := 0;
  v_entry uuid;
  v_cola uuid;
  v_linea int := 0;
  v_suma numeric := 0;
  v_kardex jsonb;
  v_mayor jsonb;
  v_visibles jsonb;
  v_hay_k boolean;
  v_asienta boolean;
  v_encola boolean;
  v_vacio constant jsonb := jsonb_build_array();
begin
  select c.tenant_id, c.functional_currency_code into v_tenant, v_moneda
    from public.companies c where c.id = p_company;
  if v_tenant is null then
    raise exception 'la empresa % no existe', p_company using errcode = '23503';
  end if;
  select s.account_id into v_inv from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'inventory_general' and s.effective_to is null
   order by s.effective_from desc limit 1;
  select s.account_id into v_red from public.company_account_settings s
   where s.company_id = p_company and s.purpose = 'rounding_difference' and s.effective_to is null
   order by s.effective_from desc limit 1;

  drop table if exists _cent_k;
  drop table if exists _cent_l;
  create temp table _cent_k on commit drop as
    select b.id, b.warehouse_id, b.product_id, b.lot_id, b.quantity, b.value, b.moves_count,
           case when b.quantity = 0 and abs(b.value) <= 0.005 * b.moves_count
                  then -b.value                          -- polvo de redondeo: entero a redondeo
                else round(b.value, 2) - b.value         -- solo la fracción de céntimo
           end as adj
      from public.stock_balances b
     where b.company_id = p_company and b.value <> round(b.value, 2);
  select coalesce(sum(adj), 0) into v_k_total from _cent_k;
  select g.diferencia into v_gap from platform.inventory_ledger_gap(p_company) g;
  v_gap := coalesce(v_gap, 0);
  -- Sin cuenta de inventario no hay línea de inventario que escribir: va a la cola.
  if v_inv is not null then
    v_adj_inv := v_k_total + (v_gap - round(v_gap, 2));
  end if;

  create temp table _cent_l on commit drop as
    select jl.account_id, sum(jl.functional_debit - jl.functional_credit) as saldo,
           round(sum(jl.functional_debit - jl.functional_credit), 2)
             - sum(jl.functional_debit - jl.functional_credit) as adj
      from public.journal_lines jl
      join public.journal_entries e on e.id = jl.entry_id
     where jl.company_id = p_company and e.status in ('posted', 'reversed')
       and jl.account_id is distinct from v_inv and jl.account_id is distinct from v_red
     group by jl.account_id
    having sum(jl.functional_debit - jl.functional_credit)
           <> round(sum(jl.functional_debit - jl.functional_credit), 2);

  -- Las posiciones VACÍAS que quedan con valor después de regularizar: no son redondeo, son
  -- diferencia de costo (ADR-0034 §Negativo). Se listan, no se tocan.
  select coalesce(jsonb_agg(jsonb_build_object(
           'stock_balance_id', b.id, 'warehouse_id', b.warehouse_id, 'warehouse', w.code,
           'product_id', b.product_id, 'product', pr.sku, 'product_name', pr.name,
           'lot_id', b.lot_id, 'value', (b.value + coalesce(k.adj, 0))::text)
           order by b.id), v_vacio)
    into v_visibles
    from public.stock_balances b
    join public.products pr on pr.id = b.product_id
    join public.warehouses w on w.id = b.warehouse_id
    left join _cent_k k on k.id = b.id
   where b.company_id = p_company and b.quantity = 0 and b.value + coalesce(k.adj, 0) <> 0;

  v_hay_k := exists (select 1 from _cent_k);
  v_asienta := exists (select 1 from _cent_l) or v_adj_inv <> 0;
  v_encola := v_hay_k and v_inv is null;

  if not v_hay_k and not v_asienta then
    return jsonb_build_object('company_id', p_company, 'regularized', false,
                              'visible_empty_positions', v_visibles);
  end if;
  if v_asienta and v_red is null then
    raise exception 'la empresa % no tiene «Diferencias por redondeo» (rounding_difference): asígnala y vuelve a correr',
      p_company using errcode = 'LAD41';
  end if;
  if v_hay_k and not v_encola and not v_asienta then
    -- Las fracciones del kardex netean a cero exacto y el mayor no trae ninguna: habría
    -- movimientos sin asiento posible (un asiento de importe cero no es un hecho, LAD59).
    raise exception 'regularización de %: las fracciones del kardex netean a cero y no hay asiento que las cubra; revísala a mano',
      p_company using errcode = 'LAD41';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('stock_balance_id', k.id, 'warehouse_id',
           k.warehouse_id, 'product_id', k.product_id, 'lot_id', k.lot_id,
           'quantity', k.quantity::text, 'value', k.value::text, 'adjustment', k.adj::text)
           order by k.id), v_vacio) into v_kardex from _cent_k k;
  select coalesce(jsonb_agg(jsonb_build_object('account_id', l.account_id,
           'balance', l.saldo::text, 'adjustment', l.adj::text) order by l.account_id), v_vacio)
    into v_mayor from _cent_l l;
  if p_ensayo then
    return jsonb_build_object('company_id', p_company, 'regularized', false, 'dry_run', true,
                              'kardex', v_kardex, 'ledger', v_mayor,
                              'inventory_adjustment', v_adj_inv::text,
                              'inventory_ledger_gap', v_gap::text,
                              'would_queue', v_encola,
                              'visible_empty_positions', v_visibles);
  end if;

  -- El kardex: una revalorización por posición, con la regularización como documento de origen.
  for v_k in select * from _cent_k where adj <> 0 order by id loop
    insert into public.inventory_moves
      (tenant_id, company_id, warehouse_id, product_id, lot_id, kind, quantity,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id,
       occurred_at, reason, source_document_id)
    values (v_tenant, p_company, v_k.warehouse_id, v_k.product_id, v_k.lot_id, 'revaluacion', 0,
            v_k.adj, v_moneda, 1, v_k.adj, v_moneda, 'identidad', now(),
            'ledger:cents:2:HALF_UP', now(),
            'Regularización del céntimo al corte (ADR-0075 §7)', v_reg);
  end loop;

  -- C5b: sin cuenta de inventario, el asiento del kardex va a la cola de pendientes.
  if v_encola then
    insert into public.journal_generation_queue
      (tenant_id, company_id, source_kind, source_id, source_event, context, reason)
    values (v_tenant, p_company, 'inventory_move', v_reg, 'stock.cent_regularized',
            jsonb_build_object('functional_currency', v_moneda, 'posting_date', v_fecha,
                               'description', 'Regularización del céntimo al corte (ADR-0075 §7)',
                               'value', v_k_total::text),
            'Falta configurar la cuenta de: inventory_general. La regularización del céntimo ya '
            || 'está en el kardex; su asiento espera a que la empresa lleve contabilidad.')
    returning id into v_cola;
  end if;

  -- El asiento, en BORRADOR: del kardex y del mayor contra «Diferencias por redondeo».
  if v_asienta then
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
       description, memo, rules_version)
    values (v_tenant, p_company, platform.period_for_date(p_company, v_fecha), v_fecha,
            'inventory_move', v_reg, 'stock.cent_regularized',
            'Regularización del céntimo al corte (ADR-0075 §7)',
            'Asiento del sistema. Lleva a «Diferencias por redondeo» la fracción de céntimo que el '
            || 'kardex y el mayor arrastraban de antes de llevar todo al céntimo. No mueve dinero.',
            coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'))
    returning id into v_entry;

    for v_l in
      select x.account_id, x.adj, x.d from (
        select l.account_id, l.adj, 'Fracción de céntimo del saldo'::text as d from _cent_l l
        union all
        select v_inv, v_adj_inv, 'Fracción de céntimo del inventario (kardex)' where v_adj_inv <> 0
      ) x order by x.account_id
    loop
      v_linea := v_linea + 1;
      v_suma := v_suma + v_l.adj;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_tenant, p_company, v_entry, v_linea, v_l.account_id,
              greatest(v_l.adj, 0), greatest(-v_l.adj, 0), abs(v_l.adj), v_moneda, 1, abs(v_l.adj),
              v_moneda, 'identidad', now(), greatest(v_l.adj, 0), greatest(-v_l.adj, 0), v_l.d);
    end loop;
    if v_suma <> 0 then
      v_linea := v_linea + 1;
      insert into public.journal_lines
        (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
         amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
         functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
         description)
      values (v_tenant, p_company, v_entry, v_linea, v_red,
              greatest(-v_suma, 0), greatest(v_suma, 0), abs(v_suma), v_moneda, 1, abs(v_suma),
              v_moneda, 'identidad', now(), greatest(-v_suma, 0), greatest(v_suma, 0),
              'Diferencias por redondeo (ADR-0075 §7)');
    end if;
    if v_linea < 2 then
      raise exception 'regularización de %: el asiento no tiene dos líneas (ajuste %)', p_company, v_suma
        using errcode = 'LAD41';
    end if;
  end if;

  return jsonb_build_object('company_id', p_company, 'regularized', true,
                            'regularization_id', v_reg, 'entry_id', v_entry,
                            'queue_id', v_cola,
                            'posting_date', v_fecha, 'kardex', v_kardex, 'ledger', v_mayor,
                            'inventory_adjustment', v_adj_inv::text,
                            'rounding_line', (-v_suma)::text,
                            'inventory_ledger_gap_before', v_gap::text,
                            'visible_empty_positions', v_visibles);
end;
$$;
comment on function platform.cent_regularization_prepare(uuid, boolean) is
  'ADR-0075 §7: prepara la regularización del céntimo de una empresa (kardex + asiento en '
  'borrador, o la cola si no lleva contabilidad). Una posición vacía solo va entera a redondeo '
  'si es polvo (|valor| ≤ 0,005 × movimientos); lo demás queda visible y se lista. Idempotente; '
  'con ensayo solo cuenta. La postea repairCents (dominio) y la cierra cent_regularization_finish. '
  'Sin GRANT: la corre el dueño de la base, después del pull.';

create or replace function platform.cent_regularization_finish(p_prep jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_company uuid := (p_prep ->> 'company_id')::uuid;
  v_entry uuid := (p_prep ->> 'entry_id')::uuid;
  v_cola uuid := (p_prep ->> 'queue_id')::uuid;
  v_antes numeric := (p_prep ->> 'inventory_ledger_gap_before')::numeric;
  v_despues numeric;
  v_tenant uuid;
begin
  if not coalesce((p_prep ->> 'regularized')::boolean, false) then
    return p_prep;
  end if;
  if v_entry is null and v_cola is null then
    raise exception 'regularización de %: ni asiento ni cola; no hay nada que cerrar', v_company
      using errcode = 'LAD41';
  end if;
  if v_entry is not null
     and not exists (select 1 from public.journal_entries e
                      where e.id = v_entry and e.company_id = v_company and e.status = 'posted') then
    raise exception 'regularización de %: el asiento % no está posteado', v_company, v_entry
      using errcode = 'LAD41';
  end if;
  if v_cola is not null
     and not exists (select 1 from public.journal_generation_queue q
                      where q.id = v_cola and q.company_id = v_company and q.status = 'pending') then
    raise exception 'regularización de %: la fila de la cola % no está pendiente', v_company, v_cola
      using errcode = 'LAD41';
  end if;
  -- La comprobación que no se delega. Con contabilidad: kardex = mayor no se movió más que su
  -- fracción de céntimo. Sin ella (en cola) no hay mayor contra el que comparar: se comprueba lo
  -- que la regularización prometía, que ninguna posición conserva fracción.
  select g.diferencia into v_despues from platform.inventory_ledger_gap(v_company) g;
  if v_cola is null and coalesce(v_despues, 0) <> round(v_antes, 2) then
    raise exception 'regularización de %: inventory_ledger_gap pasó de % a %', v_company,
      v_antes, v_despues using errcode = 'LAD41';
  end if;
  if exists (select 1 from public.stock_balances b
              where b.company_id = v_company and b.value <> round(b.value, 2)) then
    raise exception 'regularización de %: queda una posición del kardex con fracción de céntimo',
      v_company using errcode = 'LAD41';
  end if;
  select c.tenant_id into v_tenant from public.companies c where c.id = v_company;
  -- El acta es también el CORTE de cent_gaps: nace en el mismo now() que lo regularizado.
  insert into public.audit_events
    (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
     actor_type, occurred_at, rules_version, payload)
  values (v_tenant, v_company, 'company', v_company, 'accounting.cent_regularized', 'system',
          now(), coalesce(nullif(current_setting('ladino.rules_version', true), ''), 'db-repair'),
          p_prep || jsonb_build_object('adr', 'ADR-0075 §7',
                                       'inventory_ledger_gap_after', coalesce(v_despues, 0)::text));
  return p_prep || jsonb_build_object('inventory_ledger_gap_after', coalesce(v_despues, 0)::text);
end;
$$;
comment on function platform.cent_regularization_finish(jsonb) is
  'ADR-0075 §7: cierra la regularización del céntimo — exige el asiento posteado o la fila de la '
  'cola pendiente, comprueba inventory_ledger_gap y que ninguna posición conserve fracción, y '
  'deja el acta accounting.cent_regularized (el corte de cent_gaps).';

-- Los privilegios no cambian: create or replace conserva el ACL. cent_gaps sigue con EXECUTE para
-- authenticated y ladino_api; las dos de la regularización siguen sin GRANT a nadie (140200).

-- ── Reversibilidad (con datos vivos) ────────────────────────────────────────
-- · purchases_book_by_rate: NO se revierte a 20261003140100 (esa definición es el defecto);
--   revertir es volver a 20261003140000 §4, que da los mismos valores con escala 2. Función de
--   lectura: no guarda estado. Los libros generados entre la 140100 y esta (fiscal_book_runs,
--   append-only) quedan con el hash que tenían, con los signos mal: se regeneran, no se editan.
-- · recompute_iva_period: create or replace con 20261003110000. Las declaraciones generadas
--   (iva_period_results) no se reescriben: regenerar da una corrida nueva. Una declaración ya
--   generada a 8 decimales y otra al céntimo pueden diferir en la fracción.
-- · assert_entry_balanced: create or replace con 20260827233538. Revertirla vuelve a admitir
--   líneas con fracción; los asientos posteados mientras estuvo viva quedan al céntimo y siguen
--   siendo válidos con la definición vieja. Al revés NO es gratis: una API que aún genere
--   fracciones (la desplegada antes de la ola 3) recibe LAD71 al postear — por eso esta
--   migración se aplica justo DESPUÉS del git pull, no antes (R-71).
-- · cent_gaps y las dos de la regularización: create or replace con 20261003140000 §5-§6.
--   Las regularizaciones ya corridas son asientos posteados, movimientos de kardex append-only y
--   filas de la cola: se deshacen con su reversa y una revalorización de signo contrario, nunca
--   con DELETE. Una reversa generada al céntimo (con su línea de redondeo) es un asiento
--   posteado más: no se «des-redondea».
