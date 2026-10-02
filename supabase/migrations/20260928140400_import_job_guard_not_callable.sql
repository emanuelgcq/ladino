-- =============================================================================
-- Ladino — la guarda de los trabajos de importación no es ejecutable por nadie (ADR-0074)
--
-- Módulo: catálogo · importación. Spec: docs/03_MODULES/PRODUCTS_CATALOG_SPEC.md §Importación.
--
-- `platform.product_import_job_guard()` (20260928140000, redefinida en 20260928140100) nació
-- con el EXECUTE por omisión a PUBLIC, y el pgTAP 005 (test 30) lo caza: anon podía ejecutarla.
-- Una función de trigger la invoca el trigger, no un rol, así que se revoca como a las demás del
-- repo. Es la única función de 140000–140300.
--
-- Reversibilidad: SÍ, con datos vivos — solo privilegios; el trigger sigue disparando igual.
-- Impacto de homologación: NO.
-- =============================================================================

revoke execute on function platform.product_import_job_guard() from public, anon, authenticated;
