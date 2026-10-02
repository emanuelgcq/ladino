-- =============================================================================
-- Ladino — LO YA DECLARADO SE MIRA POR RENGLÓN, Y EL INVARIANTE LO DICE
-- (ADR-0072 §4 y §6; re-revisión de la parte 3 — A-1)
--
-- Módulo: compras · retenciones · libros fiscales. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/RETENTIONS_SPEC.md · PENDIENTES_ASESOR P-65.
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — qué renglones lleva el TXT de retenciones de un período.
--
-- Qué pasaba (A-1): en modo por quincena, una retención NUEVA podía añadirse a una CORRECCIÓN
-- (versión >= 2) de un comprobante de un período anterior, y el TXT excluía la versión entera por
-- «ya declarada»: la retención nueva no salía en ningún TXT. Dos defensas:
--   (a) en el código: el comprobante «abierto» de la quincena nunca es una corrección
--       (`replaces_voucher_id is null`). Se eligió esta y no conservar la quincena del original en la
--       corrección, porque el CHECK `issued_on between fortnight_start and fortnight_end` lo prohíbe
--       y una corrección con fecha de hoy y quincena pasada sería un comprobante incoherente;
--   (b) aquí: `iva_retention_book` dice por RENGLÓN si su retención ya figuraba en otra versión de
--       la cadena emitida antes del período (`declared_before`), y el TXT lee ese campo. drop + create
--       sobre la definición VIVA (20261002110200 §2, F5): única diferencia, la columna nueva.
--   El invariante `retention_voucher_gaps` amplía su ENUNCIADO: además del renglón vigente por el
--   mismo importe, todos los renglones de una retención están en UNA sola cadena de versiones. Con
--   la regla por renglón, eso basta para que la retención salga en el TXT del período de su primer
--   renglón y en ningún otro (ver el comentario de la función).
-- =============================================================================

-- ── 1. La raíz de una cadena ─────────────────────────────────────────────────
create function platform.retention_voucher_root(p_voucher uuid)
returns uuid
language sql
stable
set search_path = ''
as $$
  with recursive cadena as (
    select v.id, v.replaces_voucher_id, 1 as paso
      from public.retention_vouchers v where v.id = p_voucher
    union all
    select p.id, p.replaces_voucher_id, c.paso + 1
      from cadena c
      join public.retention_vouchers p on p.id = c.replaces_voucher_id
     where c.paso < 1000
  )
  select id from cadena where replaces_voucher_id is null
$$;
comment on function platform.retention_voucher_root(uuid) is
  'La versión 1 de la cadena de correcciones de un comprobante de retención (ADR-0072 §4).';
revoke execute on function platform.retention_voucher_root(uuid) from public;
grant execute on function platform.retention_voucher_root(uuid) to authenticated, ladino_api;

-- ── 2. El libro, con lo ya declarado por renglón ─────────────────────────────
drop function platform.iva_retention_book(uuid, date, date);
create function platform.iva_retention_book(p_company uuid, p_from date, p_to date)
returns table (
  retention_id uuid, voucher_id uuid, voucher_number text, version_no integer,
  receipt_number bigint, receipt_series text, fiscal_period text,
  issued_on date, delivered_on date, delivery_due_on date,
  supplier_tax_id text, supplier_name text, supplier_address text,
  document_type text, supplier_document_number text, supplier_control_number text,
  affected_document text, invoice_date date,
  total_amount numeric, base_amount numeric, exempt_amount numeric, iva_amount numeric,
  tax_rate numeric, rate numeric, retained_amount numeric,
  legal_source text, receipt_status text, original_issued_on date, declared_before boolean
)
language sql
stable
set search_path = ''
as $$
  -- Desde ADR-0072 §4: el COMPROBANTE, en el período de su EMISIÓN, con la identidad y los
  -- importes congelados en él. Una versión reemplazada por otra emitida hasta el cierre del
  -- período sale como «annulled»: el rastro se ve, y el TXT la excluye. Así el libro de un
  -- período no cambia por una corrección posterior a su cierre.
  select vl.supplier_retention_id, v.id, v.voucher_number, v.version_no,
         v.sequence, null::text, to_char(v.issued_on, 'YYYY-MM'),
         v.issued_on, v.delivered_on, v.delivery_due_on,
         v.supplier_tax_id, v.supplier_name, v.supplier_address,
         vl.document_type, vl.document_number, vl.control_number, vl.affected_document,
         vl.document_date,
         vl.total_amount, vl.taxable_base, vl.exempt_amount, vl.iva_amount, vl.tax_rate,
         vl.portion, vl.retained_amount,
         r.legal_source_snapshot,
         case when exists (select 1 from public.retention_vouchers n
                            where n.replaces_voucher_id = v.id and n.issued_on <= p_to)
              then 'annulled' else 'issued' end,
         -- H4: el día de emisión de la VERSIÓN 1 de la cadena. El TXT excluye una versión >= 2
         -- cuya versión 1 se emitió antes del período: ya se declaró (VALIDAR-SENIAT P-64).
         platform.retention_voucher_root_issued_on(v.id),
         -- A-1 (re-revisión): «ya declarada» va por RENGLÓN. La misma retención ya figuraba en otra
         -- versión de su cadena emitida antes de p_from: se declaró en ese período (P-65). Una
         -- retención NUEVA en el mismo comprobante no la tiene, y sale.
         exists (select 1 from public.retention_voucher_lines ol
                   join public.retention_vouchers ov on ov.id = ol.retention_voucher_id
                  where ol.supplier_retention_id = vl.supplier_retention_id
                    and ov.id <> v.id and ov.issued_on < p_from)
    from public.retention_vouchers v
    join public.retention_voucher_lines vl on vl.retention_voucher_id = v.id
    join public.supplier_retentions r on r.id = vl.supplier_retention_id
   where v.company_id = p_company and v.issued_on between p_from and p_to
  union all
  -- Lo ANTERIOR a esta migración: retenciones sin comprobante-documento. Como antes (definición
  -- 20260912120000), con el comprobante viejo si lo hay; la identidad, la de la factura
  -- (snapshot o maestro, igual que el libro de compras) y los importes del documento.
  select r.id, null::uuid, null::text, null::integer,
         rc.receipt_number, rc.series, rc.fiscal_period,
         platform.caracas_day(rc.issued_at), null::date, null::date,
         case when i.supplier_name_snapshot is not null then i.supplier_tax_id_snapshot
              else s.tax_id end,
         coalesce(i.supplier_name_snapshot, s.legal_name), s.fiscal_address,
         '01'::text, i.supplier_document_number, i.supplier_control_number, null::text,
         i.invoice_date,
         m.total_amount, m.taxable_base, m.exempt_amount, m.iva_amount, m.tax_rate,
         r.rate_snapshot, r.retained_amount,
         r.legal_source_snapshot, rc.status, null::date, false
    from public.supplier_retentions r
    join public.supplier_invoices i on i.id = r.supplier_invoice_id
    join public.suppliers s on s.id = r.supplier_id
    left join public.retention_receipts rc
      on rc.supplier_invoice_id = r.supplier_invoice_id and rc.status <> 'annulled'
    cross join lateral platform.retention_invoice_amounts(i.id) m
   where r.company_id = p_company and r.retention_code = 'iva' and r.status <> 'cancelled'
     and not exists (select 1 from public.retention_voucher_lines x
                      where x.supplier_retention_id = r.id)
     and coalesce(platform.caracas_day(rc.issued_at), i.invoice_date) between p_from and p_to
   order by 8 nulls last, 3 nulls last, 18
$$;
comment on function platform.iva_retention_book(uuid, date, date) is
  'Libro de retenciones de IVA PRACTICADAS (ADR-0072 §4 y §6): una fila por renglón de '
  'comprobante emitido en el período, con la identidad y los importes congelados al emitir; '
  'aparte, las retenciones anteriores a la migración 20261002110000 sin comprobante-documento.';
revoke execute on function platform.iva_retention_book(uuid, date, date) from public, anon;
grant execute on function platform.iva_retention_book(uuid, date, date) to authenticated, ladino_api;


-- ── 3. El invariante, con su enunciado completo ──────────────────────────────
create or replace function platform.retention_voucher_gaps(p_company uuid)
returns table (retention_id uuid, supplier_invoice_id uuid, retained_amount numeric,
               in_current_vouchers numeric)
language sql
stable
set search_path = ''
as $$
  -- ENUNCIADO: toda retención de IVA practicada (> 0, no cancelada) desde el corte
  --   (1) tiene su renglón en un comprobante VIGENTE por el mismo importe, y
  --   (2) todos sus renglones están en UNA sola cadena de versiones.
  -- Por qué (2) basta para «sale en el TXT de algún período» con la regla por renglón
  -- (`declared_before`): en el período P de su primer renglón, ninguna otra versión con esa retención
  -- es anterior a P, así que el renglón sale (si la versión se reemplaza dentro de P, sale el
  -- reemplazo, emitido también en P); en cualquier período posterior, la versión de P es anterior y
  -- el renglón se omite. Lo que (2) descarta es una retención copiada a dos cadenas, que saldría dos
  -- veces o ninguna según el orden.
  select r.id, r.supplier_invoice_id, r.retained_amount, coalesce(v.total, 0)
    from public.supplier_retentions r
    left join lateral (
      select sum(l.retained_amount) as total
        from public.retention_voucher_lines l
        join public.retention_vouchers rv on rv.id = l.retention_voucher_id
       where l.supplier_retention_id = r.id
         and not exists (select 1 from public.retention_vouchers n
                          where n.replaces_voucher_id = rv.id)
    ) v on true
    left join lateral (
      select count(distinct platform.retention_voucher_root(l.retention_voucher_id)) as cadenas
        from public.retention_voucher_lines l
       where l.supplier_retention_id = r.id
    ) k on true
   where r.company_id = p_company
     and r.retention_code = 'iva' and r.status <> 'cancelled' and r.retained_amount > 0
     and r.created_at >= (select c.since from platform.invariant_cutoffs c
                           where c.invariant = 'retention_voucher_gaps')
     and (coalesce(v.total, 0) <> r.retained_amount or coalesce(k.cadenas, 0) <> 1)
$$;
comment on function platform.retention_voucher_gaps(uuid) is
  'INVARIANTE (respuesta correcta: cero). Toda retención de IVA practicada desde el corte tiene su '
  'renglón en un comprobante VIGENTE por el mismo importe y todos sus renglones en UNA sola cadena '
  'de versiones; con la regla por renglón del TXT (declared_before), sale en el TXT del período de '
  'su primer renglón y en ningún otro (ADR-0072 §4, A-1).';

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ, con una migración nueva.
--   · `iva_retention_book` vuelve a la de 20261002110200 §2 con drop + create (pierde
--     `declared_before`; el TXT volvería a decidir por versión).
--   · `retention_voucher_gaps` vuelve a la de 20261002110200 §4 con create or replace.
--   · `retention_voucher_root` se retira con drop.
-- =============================================================================
