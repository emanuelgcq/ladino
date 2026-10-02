-- =============================================================================
-- Ladino — EL LIBRO DE COMPRAS POR ALÍCUOTA, LA LISTA CERRADA DE LA REDUCIDA Y LA FUENTE DE LA
-- GENERAL (ADR-0073; auditoría fiscal de la ronda: hallazgos 6, 10, 11 y 12)
--
-- Módulo: motor tributario · libros fiscales. Rigor máximo (fiscal, con datos vivos).
-- Spec:   docs/02_COMPLIANCE/IVA_SPEC.md · REPORTING_AND_FISCAL_BOOKS.md · RLIVA arts. 72 y 75
--         (fuente secundaria; VALIDAR-SENIAT P-59) · LIVA art. 64 (fuente secundaria).
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — el libro de compras gana columnas por alícuota y su resumen; el libro
--   de ventas gana el identificador del control; clasificar como reducida exige un literal del
--   art. 64. No cambia ninguna alícuota ni lo emitido.
--
-- Qué cambia:
--   1. H6: `platform.purchases_book_by_rate` y `platform.purchases_book_summary`, sobre la
--      definición VIVA de `purchases_book` (migración 20260928170200), que no se toca. Lectura
--      conservadora de P-59: el resumen y la agrupación por alícuota también en compras.
--   2. H10: `tax_reduced_rate_literals`, la lista CERRADA de bienes de la reducida (LIVA art. 64),
--      y `products.reduced_rate_literal_code`. La lista NACE VACÍA a propósito: ningún documento de
--      docs/02_COMPLIANCE trae los literales del art. 64 con fuente (IVA_SPEC.md: «bienes
--      alcanzados pendiente de fuente»), y una lista de bienes inventada es una norma inventada
--      (CLAUDE.md §2). Se carga con su fuente cuando el asesor la dé (PENDIENTES_ASESOR P-51).
--   3. H11: `platform.sales_book_by_rate` gana `control_identifier`, el identificador del control
--      (ADR-0071), para que el libro diga el control completo. Cambia el tipo de retorno: drop +
--      create sobre la definición VIVA de 20260928150200 §4.
--   4. H12: la plantilla de la general pasa a «fuente_secundaria» hasta que P-44 se cierre con la
--      Gaceta archivada. Nada filtra por «verificada» (comprobado: solo los CHECK la nombran).
--   5. El adaptador `csv_columnas_legales` dice lo que trae para los dos libros.
-- =============================================================================

-- ── 1. H6 · el libro de compras por alícuota ─────────────────────────────────
create function platform.purchases_book_by_rate(p_company uuid, p_from date, p_to date)
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
  -- El renglón de `purchases_book` tal cual, más la base y el IVA por alícuota leídos de la
  -- CATEGORÍA CONGELADA en cada línea (ADR-0044 §1), a la tasa del documento. Una NC recibida
  -- toma la categoría de la línea de factura que devuelve. El signo es el del renglón: la NC y el
  -- «ajuste de período anterior» restan; la anulada en su período, cero.
  --   base_gravada_sin_alicuota = base_gravada − Σ base por alícuota, e
  --   iva_sin_clasificar        = IVA del renglón − Σ IVA por alícuota:
  -- lo que el libro trae y las líneas no explican (líneas sin categoría, una NC sin línea de
  -- origen). En un documento limpio valen cero (pgTAP 081d); si no, lo dicen.
  select p.invoice_id, p.invoice_date, p.supplier_tax_id, p.supplier_name, p.supplier_kind,
         p.supplier_document_number, p.supplier_control_number, p.supplier_document_ref,
         p.status, p.transaction_currency, p.fx_rate, p.base_gravada, p.iva_credito,
         p.iva_al_costo, p.base_exenta, p.base_exonerada, p.base_no_sujeta,
         p.base_sin_clasificar, p.retenido_iva, p.retenido_islr, p.total_amount,
         p.tax_is_recoverable, p.journal_entry_id, p.booked_on, p.received_late,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         p.base_gravada - (r.base_g + r.base_a + r.base_r),
         (p.iva_credito + p.iva_al_costo) - (r.iva_g + r.iva_a + r.iva_r)
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
        max(x.rate) filter (where x.cat = 'gravado_reducida') as rate_r
        from (
          select l.line_subtotal_transaction as sub, l.tax_amount as iva,
                 l.tax_category_snapshot as cat, l.tax_rate_snapshot as rate
            from public.supplier_invoice_lines l
           where not t.es_nota and l.supplier_invoice_id = p.invoice_id
          union all
          select cl.line_subtotal_transaction, cl.tax_amount, il.tax_category_snapshot,
                 il.tax_rate_snapshot
            from public.supplier_credit_note_lines cl
            left join public.supplier_invoice_lines il on il.id = cl.supplier_invoice_line_id
           where t.es_nota and cl.supplier_credit_note_id = p.invoice_id
        ) x
    ) r
   order by p.ordinality
$$;
comment on function platform.purchases_book_by_rate(uuid, date, date) is
  'Libro de compras con la base y el IVA POR ALÍCUOTA (general, general + adicional, reducida) y '
  'lo que las líneas no explican (base_gravada_sin_alicuota, iva_sin_clasificar). Hallazgo 6, '
  'RLIVA arts. 72 y 75 (fuente secundaria, VALIDAR-SENIAT P-59). Mismo renglón y signo que '
  'purchases_book. SECURITY INVOKER a propósito: su aislamiento es la RLS del que llama; como '
  'SECURITY DEFINER devolvería el libro de cualquier empresa (pgTAP 081d, variante rota).';
revoke execute on function platform.purchases_book_by_rate(uuid, date, date) from public;
grant execute on function platform.purchases_book_by_rate(uuid, date, date)
  to authenticated, ladino_api;

create function platform.purchases_book_summary(p_company uuid, p_from date, p_to date)
returns table (concept text, rate numeric, base numeric, tax numeric,
               adjustments_base numeric, adjustments_tax numeric, documents bigint)
language sql
stable
set search_path = ''
as $$
  -- El resumen del libro de compras (RLIVA art. 72, lectura conservadora de P-59): por concepto
  -- y alícuota, a partir de los MISMOS renglones del libro por alícuota, así que suma exactamente
  -- lo que el libro trae. `adjustments_*` es la parte que viene de NC recibidas y de ajustes de
  -- período anterior. Lo que las líneas no explican va a `sin_clasificar`, visible.
  select v.concept, v.rate, sum(v.base), sum(v.tax),
         coalesce(sum(v.base) filter (where b.es_ajuste), 0),
         coalesce(sum(v.tax) filter (where b.es_ajuste), 0),
         count(distinct b.invoice_id)
    from (
      select x.*,
             (x.status = 'ajuste_periodo_anterior'
              or exists (select 1 from public.supplier_credit_notes n where n.id = x.invoice_id))
               as es_ajuste
        from platform.purchases_book_by_rate(p_company, p_from, p_to) x
    ) b
    cross join lateral (values
      ('gravado_general', b.alicuota_general, b.base_alicuota_general, b.iva_alicuota_general),
      ('gravado_adicional', b.alicuota_adicional, b.base_alicuota_adicional,
       b.iva_alicuota_adicional),
      ('gravado_reducida', b.alicuota_reducida, b.base_alicuota_reducida,
       b.iva_alicuota_reducida),
      ('exento', null::numeric, b.base_exenta, 0::numeric),
      ('exonerado', null::numeric, b.base_exonerada, 0::numeric),
      ('no_sujeto', null::numeric, b.base_no_sujeta, 0::numeric),
      ('sin_clasificar', null::numeric, b.base_sin_clasificar + b.base_gravada_sin_alicuota,
       b.iva_sin_clasificar)
    ) as v(concept, rate, base, tax)
   where v.base <> 0 or v.tax <> 0
   group by v.concept, v.rate
   order by case v.concept when 'gravado_general' then 1 when 'gravado_adicional' then 2
                           when 'gravado_reducida' then 3 when 'exento' then 4
                           when 'exonerado' then 5 when 'no_sujeto' then 6 else 7 end,
            v.rate
$$;
comment on function platform.purchases_book_summary(uuid, date, date) is
  'Resumen del libro de compras (RLIVA art. 72, hallazgo 6, VALIDAR-SENIAT P-59): base e IVA por '
  'alícuota, exentas, exoneradas, no sujetas, lo que no se pudo clasificar y la parte de NC y '
  'ajustes. Suma lo mismo que el libro. SECURITY INVOKER a propósito (RLS del que llama).';
revoke execute on function platform.purchases_book_summary(uuid, date, date) from public;
grant execute on function platform.purchases_book_summary(uuid, date, date)
  to authenticated, ladino_api;

-- ── 2. H10 · la lista cerrada de la reducida ─────────────────────────────────
create table public.tax_reduced_rate_literals (
  code                 text        primary key,
  product_tax_category text        not null default 'gravado_reducida',
  description          text        not null,
  legal_source         text        not null,
  source_status        text        not null,
  created_at           timestamptz not null default now(),
  constraint tax_reduced_rate_literals_code_chk check (code ~ '^64(\.[0-9a-z]+)+$'),
  constraint tax_reduced_rate_literals_category_fk
    foreign key (product_tax_category) references public.product_tax_categories (code),
  constraint tax_reduced_rate_literals_reducida_chk
    check (product_tax_category = 'gravado_reducida'),
  constraint tax_reduced_rate_literals_source_status_chk
    check (source_status in ('verificada', 'fuente_secundaria')),
  constraint tax_reduced_rate_literals_legal_source_chk
    check (length(btrim(legal_source)) between 3 and 300)
);
comment on table public.tax_reduced_rate_literals is
  'LIVA art. 64: la LISTA CERRADA de bienes y servicios de la alícuota reducida (hallazgo 10). '
  'Clasificar un producto como reducida exige uno de estos literales. NACE VACÍA: ningún documento '
  'de docs/02_COMPLIANCE trae los literales con fuente, y no se inventan (CLAUDE.md §2). Mientras '
  'esté vacía, ningún producto nuevo se clasifica como reducida (PENDIENTES_ASESOR P-51).';
alter table public.tax_reduced_rate_literals enable row level security;
alter table public.tax_reduced_rate_literals force  row level security;
create policy tax_reduced_rate_literals_select on public.tax_reduced_rate_literals
  for select to authenticated, ladino_api using (true);
create policy tax_reduced_rate_literals_insert on public.tax_reduced_rate_literals
  for insert to authenticated, ladino_api with check (false);
create policy tax_reduced_rate_literals_update on public.tax_reduced_rate_literals
  for update to authenticated, ladino_api using (false);
create policy tax_reduced_rate_literals_delete on public.tax_reduced_rate_literals
  for delete to authenticated, ladino_api using (false);
revoke all on public.tax_reduced_rate_literals from public, anon, authenticated, ladino_api;
grant select on public.tax_reduced_rate_literals to authenticated, ladino_api;

alter table public.products
  add column reduced_rate_literal_code text,
  add constraint products_reduced_rate_literal_fk
    foreign key (reduced_rate_literal_code) references public.tax_reduced_rate_literals (code);
comment on column public.products.reduced_rate_literal_code is
  'El literal del art. 64 que hace reducido a este producto (hallazgo 10). Lo exige el caso de uso '
  'al clasificar como gravado_reducida. NULL en todo lo demás y en lo clasificado antes de esta '
  'migración.';

-- ── 3. H11 · el libro de ventas con el identificador del control ────────────
drop function platform.sales_book_by_rate(uuid, date, date);
create function platform.sales_book_by_rate(p_company uuid, p_from date, p_to date)
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
  control_identifier text
)
language sql
stable
set search_path = ''
as $$
  -- Definición viva de 20260928150200 §4, más el identificador del control (H11, ADR-0071): el
  -- control completo es identificador + número, y el libro lo dice.
  select s.document_id, s.issued_on, s.kind, s.series, s.document_number, s.control_number,
         s.status, s.customer_tax_id, s.customer_name, s.customer_taxpayer_type,
         s.transaction_currency, s.fx_rate, s.base_gravada, s.iva_debito, s.base_exenta,
         s.base_exonerada, s.base_no_sujeta, s.base_sin_clasificar, s.total_amount,
         s.journal_entry_id,
         r.base_g, r.iva_g, r.rate_g, r.base_a, r.iva_a, r.rate_a, r.base_r, r.iva_r, r.rate_r,
         r.base_x, r.iva_x,
         (select d.control_identifier from public.documents d where d.id = s.document_id)
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
  'Libro de ventas con la base y el IVA POR ALÍCUOTA, lo que no cae en ninguna, y el identificador '
  'del control (H11, ADR-0071). RLIVA arts. 72 y 76 (L-08). Mismo renglón y signo que sales_book. '
  'SECURITY INVOKER a propósito: su aislamiento es la RLS del que llama (pgTAP 081b).';
revoke execute on function platform.sales_book_by_rate(uuid, date, date) from public;
grant execute on function platform.sales_book_by_rate(uuid, date, date) to authenticated, ladino_api;

-- ── 4. H12 · la general, fuente secundaria ───────────────────────────────────
update public.tax_rule_templates
   set source_status = 'fuente_secundaria'
 where jurisdiction = 'VE' and tax_code = 'iva' and product_tax_category = 'gravado_general'
   and source_status = 'verificada';

-- ── 5. El adaptador dice lo que trae ─────────────────────────────────────────
update public.book_format_adapters
   set description =
     'NO es un formato oficial de presentación: ninguna providencia fija un modelo de libro. Es un '
     'CSV con los datos que el Reglamento de la LIVA (Decreto 206, arts. 70 a 78) exige en los '
     'libros de compras y ventas, entregable a un contador para revisión y archivo. Ventas y '
     'compras traen además la base y el IVA por alícuota; su resumen (RLIVA art. 72) se entrega en '
     'la misma generación como fichero aparte (resumen-art72*.csv) y va firmado en su hash.'
 where code = 'csv_columnas_legales';

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ.
--   · `purchases_book_by_rate` y `purchases_book_summary` se retiran con drop: `purchases_book`
--     no se tocó.
--   · `sales_book_by_rate` vuelve a la definición de 150200 §4 con drop + create (una columna
--     menos); un período exportado daría otro hash.
--   · `products.reduced_rate_literal_code` se retira con drop column y la tabla de literales con
--     drop table: los dos nacen vacíos y solo los llena el caso de uso desde hoy.
--   · La fuente de la general vuelve a «verificada» con un update cuando P-44 se cierre.
-- =============================================================================
