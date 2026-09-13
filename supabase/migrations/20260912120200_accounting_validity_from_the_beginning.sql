-- =============================================================================
-- Migración 50 · LA PRIMERA VIGENCIA CONTABLE RIGE DESDE SIEMPRE (ADR-0055)
--
-- Hallazgo A-11 de la auditoría del 2026-09-11. Las plantillas de asiento
-- (`journal_templates`) y los papeles contables (`company_account_settings`)
-- nacían con `effective_from = now()`, y el generador exige una vigencia A LA
-- FECHA DEL DOCUMENTO. Todo hecho emitido ANTES de configurar la contabilidad
-- quedaba en `journal_generation_queue` con «No hay plantilla de mapeo» — y
-- «Contabilizar los pendientes» (ADR-0042) reusaba esa misma fecha, así que
-- nunca los recuperaba. En producción son 1.527 hechos; en el entorno local
-- se reprodujo con la factura A-6.
--
-- La regla que esta migración fija en el esquema: la PRIMERA vigencia de una
-- plantilla o de un papel rige desde siempre (`-infinity`). Las siguientes
-- versiones empiezan cuando se crean y cierran a la anterior (ADR-0029, sin
-- cambios). Un hecho antiguo se contabiliza con la plantilla inicial, que es
-- lo que el contador esperaba al configurarla; y un hecho posterior al cambio
-- de plantilla toma la vigente a su fecha, como hasta hoy.
--
-- Reversible: `update … set effective_from = created_at` sobre las mismas
-- filas (se guarda el instante original en la auditoría del cambio).
-- =============================================================================

-- ── 1. Plantillas de asiento: la primera de cada (empresa, hecho) ───────────
with primeras as (
  select distinct on (company_id, source_kind, source_event) id
    from public.journal_templates
   order by company_id, source_kind, source_event, effective_from asc, created_at asc
)
update public.journal_templates t
   set effective_from = '-infinity'::timestamptz
  from primeras p
 where t.id = p.id
   and t.effective_from <> '-infinity'::timestamptz;

-- ── 2. Papeles contables: el primero de cada (empresa, papel) ───────────────
with primeros as (
  select distinct on (company_id, purpose) id
    from public.company_account_settings
   order by company_id, purpose, effective_from asc, created_at asc
)
update public.company_account_settings s
   set effective_from = '-infinity'::timestamptz
  from primeros p
 where s.id = p.id
   and s.effective_from <> '-infinity'::timestamptz;

-- ── 3. La regla, escrita donde se lee ───────────────────────────────────────
comment on column public.journal_templates.effective_from is
  'Desde cuándo rige. La PRIMERA plantilla de cada (empresa, hecho) rige desde '
  'siempre (-infinity, ADR-0055): un documento anterior a la configuración se '
  'contabiliza con ella. Las siguientes empiezan al crearse y cierran a la anterior.';
comment on column public.company_account_settings.effective_from is
  'Desde cuándo rige. El PRIMER papel de cada (empresa, propósito) rige desde '
  'siempre (-infinity, ADR-0055). Las siguientes vigencias empiezan al crearse.';
