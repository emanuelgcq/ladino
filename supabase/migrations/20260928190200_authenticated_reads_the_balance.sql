-- =============================================================================
-- El saldo en divisa, legible como authenticated (revisión de ADR-0072 §5, punto 1).
-- Módulo: ventas   Spec: docs/02_COMPLIANCE/RETENTIONS_SPEC.md
--
-- 20260928190100 dio SELECT sobre `supported_retention_receipts` a authenticated, y el pgTAP 087
-- (que llama a la función como authenticated, no pregunta por el privilegio) destapó la segunda
-- capa: `platform.document_balance_transaction` usa `platform.caracas_day`, que nunca tuvo
-- EXECUTE para authenticated. La función fallaba así desde 20260912120000 (el día de Caracas en
-- los cobros) para todo documento con cobros, no solo con retenciones.
--
-- `caracas_day` es pura (un instante → su fecha en America/Caracas): concederla no expone datos.
--
-- Reversible: SÍ — `revoke execute on function platform.caracas_day(timestamptz) from authenticated`
-- (y el saldo en divisa vuelve a fallar como authenticated).
-- HOMOLOGATION_IMPACT: NO.
-- =============================================================================

grant execute on function platform.caracas_day(timestamptz) to authenticated;
