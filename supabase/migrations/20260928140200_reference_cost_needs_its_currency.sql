-- =============================================================================
-- Ladino — el costo de referencia exige su moneda (ADR-0074, revisión H11)
--
-- Módulo: catálogo · importación. Spec: docs/03_MODULES/PRODUCTS_CATALOG_SPEC.md §Importación.
--
-- Corrige `products_reference_cost_chk` de 20260928140100, que el pgTAP 082b cazó el mismo día:
-- la rama `reference_cost is not null and ... and reference_cost_currency ~ '^[A-Z]{3}$'` da NULL
-- (no falso) cuando la moneda es NULL, y un CHECK que da NULL PASA. Un importe sin moneda
-- entraba. Ahora la moneda se exige con `is not null` explícito.
--
-- Por qué una migración aparte y no editar 20260928140100: ya estaba aplicada en local y las
-- migraciones aplicadas no se editan (hook). Las dos van juntas en la misma ventana de deploy.
--
-- Reversibilidad: SÍ, con datos vivos — la columna es nueva de esta misma ventana y la app solo
-- escribe importe y moneda juntos, así que no hay filas que el CHECK nuevo rechace. Se revierte
-- recreando el CHECK de 20260928140100.
-- Impacto de homologación: NO.
-- =============================================================================

alter table public.products drop constraint products_reference_cost_chk;
alter table public.products
  add constraint products_reference_cost_chk check (
    (reference_cost is null and reference_cost_currency is null)
    or (reference_cost is not null and reference_cost >= 0
        and reference_cost_currency is not null
        and reference_cost_currency ~ '^[A-Z]{3}$'));

comment on constraint products_reference_cost_chk on public.products is
  'Costo de referencia (ADR-0074, H11): importe y moneda juntos o ninguno. La moneda con IS NOT '
  'NULL explícito: sin él, una moneda NULL daba NULL y el CHECK pasaba (20260928140200).';
