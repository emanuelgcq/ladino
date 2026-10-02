-- =============================================================================
-- Retenciones soportadas: el comprobante quincenal, las porciones como catálogo, y «formal» fuera
-- (auditoría fiscal de la ronda, hallazgos 4, 5 y 8; ADR-0072 §1 y §5).
-- Módulo: fiscal / ventas   Spec: docs/02_COMPLIANCE/RETENTIONS_SPEC.md
--
--   1. Hallazgo 4 (PA SNAT/2025/000054 art. 16): un comprobante puede cubrir varias operaciones
--      del período con el mismo proveedor (uno por período y proveedor). Para quien lo RECIBE, el
--      mismo número del mismo cliente aparece contra varias facturas. La unicidad pasa a
--      (company_id, customer_id, receipt_number, document_id): única por cliente y factura. La
--      porción 75/100 se sigue validando factura por factura.
--   2. Hallazgo 5 (regla 8): las porciones admisibles (75 %, 100 %) eran literales en el código. Ahora
--      son un catálogo de PLATAFORMA con norma, artículo y vigencia (patrón tax_rule_templates);
--      el dominio valida contra las filas vigentes a `retained_on`.
--   3. Hallazgo 8 (PA 00071 art. 15; M-10, P-38): «formal» no se declara ni emite hasta construir
--      M-10. El CHECK de la historia se estrecha a {ordinario, especial}. Como la historia es
--      append-only y no hay ninguna fila `formal` (el CHECK se VALIDA al crearlo: si la hubiera,
--      la migración falla), ningún tipo `formal` puede estar vigente, y la puerta de emisión
--      (`assert_document_issuance`, LAD98) queda en {ordinario, especial} sin redefinir el
--      trigger. Así no choca con la redefinición del papel (identificación del adquirente).
--
-- Reversible: SÍ, con datos vivos.
--   · Unicidad: volver a `srr_unique_receipt (company_id, customer_id, receipt_number)` FALLA si ya
--     hay comprobantes quincenales cargados contra varias facturas. Hay que decidir antes qué hacer
--     con ellos (no se borran: abonaron facturas).
--   · El catálogo se retira con drop table; el dominio vuelve a necesitar las porciones en código.
--   · El CHECK vuelve a admitir `formal` con drop/add constraint.
-- HOMOLOGATION_IMPACT: NO — no toca numeración, control ni formato.
-- =============================================================================

-- ── 1. Única por cliente y factura ───────────────────────────────────────────
alter table public.supported_retention_receipts drop constraint srr_unique_receipt;
alter table public.supported_retention_receipts
  add constraint srr_unique_receipt_per_document
  unique (company_id, customer_id, receipt_number, document_id);
comment on constraint srr_unique_receipt_per_document on public.supported_retention_receipts is
  'PA SNAT/2025/000054 art. 16: un comprobante puede ser uno por período y proveedor y cubrir varias '
  'facturas. El mismo número del mismo cliente no se carga dos veces contra la MISMA factura.';

-- ── 2. Las porciones, catálogo con fuente ────────────────────────────────────
create table public.iva_retention_portions (
  id              uuid          primary key default platform.uuidv7(),
  code            text          not null,
  -- La fracción del IVA de la factura que retiene el agente.
  portion         numeric(9,8)  not null,
  legal_norm      text          not null,
  legal_article   text          not null,
  gazette         text,
  effective_from  date          not null,
  effective_to    date,
  description     text          not null,
  created_at      timestamptz   not null default now(),
  constraint iva_retention_portions_code_chk check (code ~ '^[a-z][a-z0-9_]{0,39}$'),
  constraint iva_retention_portions_portion_chk check (portion > 0 and portion <= 1),
  constraint iva_retention_portions_period_chk
    check (effective_to is null or effective_to > effective_from),
  constraint iva_retention_portions_source_chk
    check (length(btrim(legal_norm)) > 0 and length(btrim(legal_article)) > 0),
  constraint iva_retention_portions_code_from_key unique (code, effective_from)
);
comment on table public.iva_retention_portions is
  'Catálogo de PLATAFORMA (sin tenant): porciones de retención de IVA admisibles, con norma, '
  'artículo y vigencia (regla 8). La retención soportada se valida contra las vigentes a su '
  'retained_on. Lo que no tiene fuente no se siembra.';

alter table public.iva_retention_portions enable row level security;
alter table public.iva_retention_portions force  row level security;
create policy iva_retention_portions_select on public.iva_retention_portions for select
  to authenticated, ladino_api using (true);
create policy iva_retention_portions_insert on public.iva_retention_portions for insert
  to authenticated, ladino_api with check (false);
create policy iva_retention_portions_update on public.iva_retention_portions for update
  to authenticated, ladino_api using (false);
create policy iva_retention_portions_delete on public.iva_retention_portions for delete
  to authenticated, ladino_api using (false);
revoke all on public.iva_retention_portions from anon, authenticated, service_role, ladino_api,
  ladino_worker;
grant select on public.iva_retention_portions to authenticated, ladino_api;

-- Fuente: RESPUESTA_RECORRIDO_2026-09-24.md (tabla normativa) y RETENTIONS_SPEC.md: PA
-- SNAT/2025/000054, G.O. 43.171 del 16-07-2025, vigente desde el 01-08-2025; arts. 4-5.
insert into public.iva_retention_portions
  (code, portion, legal_norm, legal_article, gazette, effective_from, description)
values
  ('general', 0.75, 'PA SNAT/2025/000054', 'art. 4', 'G.O. 43.171, 16-07-2025', '2025-08-01',
   'Retención general: 75 % del IVA de la factura.'),
  ('total', 1.00, 'PA SNAT/2025/000054', 'art. 5', 'G.O. 43.171, 16-07-2025', '2025-08-01',
   'Retención del 100 %: IVA no discriminado, factura sin requisitos, indicación del portal o '
   'proveedor no inscrito en el RIF.');

-- ── 3. «formal» fuera hasta M-10 ─────────────────────────────────────────────
alter table public.company_taxpayer_types drop constraint company_taxpayer_types_declarable_chk;
alter table public.company_taxpayer_types
  add constraint company_taxpayer_types_declarable_chk
  check (taxpayer_type_code in ('ordinario', 'especial'));
comment on constraint company_taxpayer_types_declarable_chk on public.company_taxpayer_types is
  'Solo se declaran ordinario y especial. no_contribuyente se deriva de no tener RIF; formal se '
  'reabre con M-10 (PA 00071 art. 15, P-38). Al ser append-only y validado, ningún formal puede '
  'estar vigente y la puerta LAD98 queda en {ordinario, especial}.';
