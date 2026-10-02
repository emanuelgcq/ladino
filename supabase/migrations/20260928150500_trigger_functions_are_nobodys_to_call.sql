-- =============================================================================
-- Ladino — LAS FUNCIONES DE TRIGGER DE LAS ALÍCUOTAS NO SON DE NADIE
-- (ADR-0073; pgTAP 005, test 30)
--
-- Módulo: motor tributario. Rigor normal (privilegios; no cambia datos ni comportamiento).
-- Reversible: SÍ — `grant execute … to public` las devolvería al estado anterior (no se recomienda).
-- HOMOLOGATION_IMPACT: NO.
--
-- `platform.assert_general_vat_in_range` (migración 20260928150000) y
-- `platform.assert_referenced_tax_rule_not_retired` (20260928150200) nacieron con el EXECUTE por
-- omisión a PUBLIC, así que anon podía llamarlas. Son funciones de TRIGGER: el trigger las invoca
-- con los privilegios del dueño de la tabla y nadie necesita EXECUTE sobre ellas. Se revoca como en
-- las demás funciones de trigger del repo. Va en una migración nueva porque 150400 ya está aplicada
-- en local (CLAUDE.md §2: una migración aplicada no se edita).
-- =============================================================================

revoke execute on function platform.assert_general_vat_in_range() from public, anon, authenticated;
revoke execute on function platform.assert_referenced_tax_rule_not_retired()
  from public, anon, authenticated;
