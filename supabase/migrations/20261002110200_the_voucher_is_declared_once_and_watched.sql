-- =============================================================================
-- Ladino — EL COMPROBANTE SE DECLARA UNA VEZ Y ALGUIEN LO VIGILA
-- (ADR-0072 §4 y §6; revisión de la parte 3 — H4 y H10/F6)
--
-- Módulo: compras · retenciones · libros fiscales. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/RETENTIONS_SPEC.md · PENDIENTES_ASESOR P-64.
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — cambia qué renglones lleva el TXT de retenciones de un período.
--
-- Qué cambia:
--   1. H4 (decidido por criterio: evitar el doble enteramiento). `platform.iva_retention_book`
--      gana `original_issued_on`: el día de emisión de la VERSIÓN 1 de la cadena de correcciones.
--      El TXT de un período excluye las versiones >= 2 cuya versión 1 se emitió antes del período
--      (ya se declararon), y la exportación lo avisa. drop + create sobre la definición VIVA
--      (20261002110000 §9, F5): única diferencia, la columna nueva al final.
--      VALIDAR-SENIAT P-64. Alternativa: declararla otra vez en el período de la corrección.
--   2. H10 (F6) · invariante nuevo `platform.retention_voucher_gaps(empresa)`: toda retención de IVA
--      practicada (> 0, no cancelada) desde el corte tiene su renglón en un comprobante VIGENTE por
--      el mismo importe. La respuesta correcta es CERO. El corte es el instante en que esta
--      migración corre en cada base (`platform.invariant_cutoffs`): lo anterior se practicó sin
--      comprobante-documento y lo vigila P-63, no este invariante — el corte va en el ENUNCIADO
--      del invariante, no en una lista de perdones (CLAUDE.md §3).
--   `platform.retention_fortnight` NO se toca: desde 20261002120100 es un envoltorio de
--   `platform.fiscal_fortnight` (familia de la declaración).
-- =============================================================================

-- ── 1. La raíz de una cadena de versiones ───────────────────────────────────
create function platform.retention_voucher_root_issued_on(p_voucher uuid)
returns date
language sql
stable
set search_path = ''
as $$
  with recursive cadena as (
    select v.id, v.replaces_voucher_id, v.issued_on, 1 as paso
      from public.retention_vouchers v where v.id = p_voucher
    union all
    select p.id, p.replaces_voucher_id, p.issued_on, c.paso + 1
      from cadena c
      join public.retention_vouchers p on p.id = c.replaces_voucher_id
     where c.paso < 1000
  )
  select issued_on from cadena where replaces_voucher_id is null
$$;
comment on function platform.retention_voucher_root_issued_on(uuid) is
  'Día de emisión de la versión 1 de la cadena de correcciones de un comprobante de retención '
  '(ADR-0072 §4). El TXT no vuelve a declarar una corrección de un comprobante de un período '
  'anterior (H4, VALIDAR-SENIAT P-64).';
revoke execute on function platform.retention_voucher_root_issued_on(uuid) from public;
grant execute on function platform.retention_voucher_root_issued_on(uuid)
  to authenticated, ladino_api;

-- ── 2. El libro, con la raíz ─────────────────────────────────────────────────
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
  legal_source text, receipt_status text, original_issued_on date
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
         platform.retention_voucher_root_issued_on(v.id)
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
         r.legal_source_snapshot, rc.status, null::date
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


-- ── 3. El corte de los invariantes con fecha de nacimiento ───────────────────
-- Esquema `platform`, sin tenant: una fila por invariante cuya pregunta empieza en un instante.
-- Solo lectura para los roles de la aplicación; la escribe una migración.
create table platform.invariant_cutoffs (
  invariant  text        primary key,
  since      timestamptz not null default now(),
  reason     text        not null,
  constraint invariant_cutoffs_reason_chk check (length(btrim(reason)) >= 10)
);
comment on table platform.invariant_cutoffs is
  'Desde qué instante pregunta un invariante cruzado (CLAUDE.md §3). Lo anterior no se perdona: '
  'se vigila por otro camino, que el campo reason nombra.';
revoke all on platform.invariant_cutoffs from public, anon, authenticated, ladino_api,
  ladino_worker;
grant select on platform.invariant_cutoffs to authenticated, ladino_api;
insert into platform.invariant_cutoffs (invariant, reason) values
  ('retention_voucher_gaps',
   'Antes de esta migración la retención de IVA no emitía comprobante-documento; esas retenciones las vigila PENDIENTES_ASESOR P-63.');

-- ── 4. Invariante: retención practicada ⇒ renglón en un comprobante vigente ──
create function platform.retention_voucher_gaps(p_company uuid)
returns table (retention_id uuid, supplier_invoice_id uuid, retained_amount numeric,
               in_current_vouchers numeric)
language sql
stable
set search_path = ''
as $$
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
   where r.company_id = p_company
     and r.retention_code = 'iva' and r.status <> 'cancelled' and r.retained_amount > 0
     and r.created_at >= (select c.since from platform.invariant_cutoffs c
                           where c.invariant = 'retention_voucher_gaps')
     and coalesce(v.total, 0) <> r.retained_amount
$$;
comment on function platform.retention_voucher_gaps(uuid) is
  'INVARIANTE (respuesta correcta: cero). Toda retención de IVA practicada desde el corte '
  '(platform.invariant_cutoffs) tiene su renglón en un comprobante VIGENTE por el mismo importe. '
  'Cruza compras ↔ comprobantes de retención (ADR-0072 §4, H10).';
revoke execute on function platform.retention_voucher_gaps(uuid) from public;
grant execute on function platform.retention_voucher_gaps(uuid) to authenticated, ladino_api;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ, con una migración nueva.
--   · `iva_retention_book` vuelve a la definición de 20261002110000 §9 con drop + create; el TXT
--     volvería a declarar las correcciones de comprobantes de períodos anteriores.
--   · `retention_voucher_gaps`, `retention_voucher_root_issued_on` y `platform.invariant_cutoffs`
--     se retiran con drop: no guardan datos de negocio.
-- =============================================================================
