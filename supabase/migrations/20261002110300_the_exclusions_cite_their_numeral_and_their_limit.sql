-- =============================================================================
-- Ladino — LAS EXCLUSIONES CITAN SU NUMERAL Y SU TOPE, Y LA UT ES DATO
-- (ADR-0072 §3; auditoría fiscal de la segunda ronda de la parte 3: H7, H8, H10)
--
-- Módulo: compras · retenciones. Rigor máximo (fiscal).
-- Spec:   docs/02_COMPLIANCE/RETENTIONS_SPEC.md · REGULATORY_STATUS.md (PA SNAT/2025/000054 art. 3;
--         PA SNAT/2025/000048, UT) · PENDIENTES_ASESOR P-65, P-71.
-- Reversible: SÍ, con datos vivos — ver al final.
-- HOMOLOGATION_IMPACT: YES — qué exclusiones se pueden marcar y con qué tope.
--
-- Qué cambia:
--   1. H8 · `retention_exclusions` cita el numeral del art. 3 que el auditor fiscal verificó en
--      ivecofi el 2026-10-02 (num. 1, 2, 4, 6, 7, 8, 11 y 12). El num. 4 se corrige: «proveedor
--      sujeto a percepción anticipada en la importación». Los num. 11 y 12 son compras HECHAS POR
--      órganos o entes públicos SPE: `applies = 'not_markable'` (una empresa privada no los marca).
--      Las filas sin numeral confirmado conservan «numeral pendiente de fuente» (no se inventa).
--   2. H7 · las exclusiones de gastos reembolsables (num. 6) y de caja chica (num. 7) valen hasta
--      20 UT por operación: `max_tax_units` es dato de la exclusión, y la UT es un catálogo con
--      vigencia y fuente (`tax_units`, PA SNAT/2025/000048: UT = Bs 43, REGULATORY_STATUS.md
--      «verificado»). Sin UT vigente esas dos no se pueden marcar (422). VALIDAR-TRIBUTARIO P-71.
--   3. H8 · el 100 % admite el supuesto 4.º del art. 5 (operaciones del art. 2: metales y piedras
--      preciosas): el CHECK de `supplier_invoices` se AMPLÍA (ninguna fila existente cae fuera).
--   4. H10 · el comentario de `retention_voucher_root_issued_on` citaba «P-64»: la pregunta es
--      P-65 (P-64 es la del IGTF asumido). La migración 20261002110200 ya aplicada no se edita.
-- =============================================================================

-- ── 1. Quién se puede marcar ─────────────────────────────────────────────────
alter table public.retention_exclusions drop constraint retention_exclusions_applies_chk;
alter table public.retention_exclusions
  add constraint retention_exclusions_applies_chk
  check (applies in ('automatic', 'marked', 'not_markable'));
alter table public.retention_exclusions add column max_tax_units numeric(24,8);
alter table public.retention_exclusions
  add constraint retention_exclusions_max_tax_units_chk
  check (max_tax_units is null or max_tax_units > 0);
comment on column public.retention_exclusions.max_tax_units is
  'Tope por operación en unidades tributarias (art. 3 num. 6 y 7: 20 UT). Se compara contra la UT '
  'vigente (tax_units) en la fecha de la factura; sin UT, la exclusión no se marca (P-71).';

-- Numerales del art. 3 verificados por el auditor fiscal (ivecofi, 2026-10-02).
update public.retention_exclusions
   set legal_article = 'art. 3 num. 1', numeral_verified = true
 where code = 'exentas_exoneradas_no_sujetas';
update public.retention_exclusions
   set legal_article = 'art. 3 num. 4', numeral_verified = true,
       description = 'Proveedor sujeto a percepción anticipada en la importación.'
 where code = 'retencion_previa_importacion';
update public.retention_exclusions
   set legal_article = 'art. 3 num. 6', numeral_verified = true, max_tax_units = 20
 where code = 'gastos_reembolsables_20ut';
update public.retention_exclusions
   set legal_article = 'art. 3 num. 7', numeral_verified = true, max_tax_units = 20
 where code = 'caja_chica_20ut';
update public.retention_exclusions
   set legal_article = 'art. 3 num. 11 y 12', numeral_verified = true, applies = 'not_markable',
       description = 'Compras hechas por órganos o entes públicos que son sujetos pasivos especiales: no las marca una empresa privada.'
 where code = 'ente_publico';
do $$
begin
  -- Siete filas: num. 1, 2, 4, 6, 7, 8 y la de los num. 11 y 12 (una sola fila, no marcable).
  if (select count(*) from public.retention_exclusions where numeral_verified) <> 7 then
    raise exception 'H8: esperaba 7 exclusiones con numeral verificado (num. 1, 2, 4, 6, 7, 8 y 11-12)';
  end if;
end $$;

-- ── 2. La unidad tributaria, como dato con fuente ────────────────────────────
create table public.tax_units (
  id             uuid          primary key default platform.uuidv7(),
  value          numeric(24,8) not null,
  currency       text          not null default 'VES',
  effective_from date          not null,
  effective_to   date,
  legal_norm     text          not null,
  gazette        text          not null,
  source         text          not null,
  created_at     timestamptz   not null default now(),
  constraint tax_units_value_chk check (value > 0),
  constraint tax_units_period_chk check (effective_to is null or effective_to > effective_from),
  constraint tax_units_source_chk
    check (length(btrim(legal_norm)) >= 3 and length(btrim(source)) >= 3),
  constraint tax_units_from_key unique (effective_from)
);
comment on table public.tax_units is
  'Catálogo de PLATAFORMA (sin tenant): la unidad tributaria con vigencia y fuente (regla 8). Lo '
  'que no tiene fuente en docs/02_COMPLIANCE no se siembra.';
alter table public.tax_units enable row level security;
alter table public.tax_units force  row level security;
create policy tax_units_select on public.tax_units for select
  to authenticated, ladino_api using (true);
create policy tax_units_insert on public.tax_units for insert
  to authenticated, ladino_api with check (false);
create policy tax_units_update on public.tax_units for update
  to authenticated, ladino_api using (false);
create policy tax_units_delete on public.tax_units for delete
  to authenticated, ladino_api using (false);
revoke all on public.tax_units from anon, authenticated, service_role, ladino_api, ladino_worker;
grant select on public.tax_units to authenticated, ladino_api;
-- Fuente: REGULATORY_STATUS.md (fila «UT = Bs 43 (PA SNAT/2025/000048, G.O. 43.140)», verificado) e
-- IVA_SPEC.md:98. Rige desde la fecha de la Gaceta: VALIDAR-TRIBUTARIO P-71.
insert into public.tax_units (value, effective_from, legal_norm, gazette, source)
values (43, '2025-06-02', 'PA SNAT/2025/000048', 'G.O. 43.140, 02-06-2025',
        'REGULATORY_STATUS.md — Acceso a la Justicia, verificado 2026-09-24');

-- Granularidad declarada: compara dos `date` (CLAUDE.md §3).
create function platform.tax_unit_at(p_on date)
returns numeric
language sql
stable
set search_path = ''
as $$
  select u.value from public.tax_units u
   where u.effective_from <= p_on and (u.effective_to is null or u.effective_to > p_on)
   order by u.effective_from desc
   limit 1
$$;
comment on function platform.tax_unit_at(date) is
  'La UT vigente en un día (tax_units), o NULL si no hay: quien la usa falla, no supone una.';
revoke execute on function platform.tax_unit_at(date) from public;
grant execute on function platform.tax_unit_at(date) to authenticated, ladino_api;

-- ── 3. El supuesto 4.º del art. 5 ────────────────────────────────────────────
alter table public.supplier_invoices drop constraint supplier_invoices_iva_full_reason_chk;
alter table public.supplier_invoices
  add constraint supplier_invoices_iva_full_reason_chk
    check (iva_retention_full_reason is null
           or iva_retention_full_reason in ('iva_no_discriminado', 'factura_sin_requisitos',
                                            'indicado_por_portal', 'proveedor_sin_rif',
                                            'operaciones_art_2'));

-- ── 4. La cita correcta ──────────────────────────────────────────────────────
comment on function platform.retention_voucher_root_issued_on(uuid) is
  'Día de emisión de la versión 1 de la cadena de correcciones de un comprobante de retención '
  '(ADR-0072 §4). El TXT no vuelve a declarar una corrección de un comprobante de un período '
  'anterior (H4, VALIDAR-SENIAT P-65; la migración 20261002110200 citaba P-64 por error).';

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ, con una migración nueva.
--   · Los numerales, descripciones y topes del catálogo vuelven con UPDATE (catálogo de plataforma,
--     sin documentos que dependan del texto). `applies = 'not_markable'` vuelve a 'marked' antes de
--     restaurar el CHECK.
--   · `tax_units` y `tax_unit_at` se retiran con drop si nada los referencia.
--   · El CHECK del 100 % solo se estrecha si ninguna factura tiene 'operaciones_art_2'.
-- =============================================================================
