-- =============================================================================
-- Ladino — LAS FUNCIONES DEL CÉNTIMO NO SON DE PUBLIC NI DE ANON (ADR-0075 §7)
--
-- Arreglo de 20261003140000, con su propia auditoría (CLAUDE.md §3): `platform.round_cents`
-- nació con el EXECUTE por omisión de PUBLIC (y por él, de anon), y el pgTAP 005 (#30: anon no
-- ejecuta funciones de platform) lo cazó. Repasadas las cinco funciones nuevas con el mismo patrón:
--   · round_cents: nadie la llama desde la API ni desde una policy; se usa dentro de SQL del dueño.
--     Sin EXECUTE para public, anon, authenticated ni ladino_api;
--   · cent_gaps: la leen los invariantes (dueño) — se quita también a anon, por escrito; conserva
--     authenticated y ladino_api como las demás funciones de invariante;
--   · cent_regularization_prepare / _finish: ya sin GRANT; se revoca anon por escrito.
-- Reversible: SÍ (grant de vuelta). Sin datos. HOMOLOGATION_IMPACT: NO.
-- =============================================================================
revoke execute on function platform.round_cents(numeric) from public, anon, authenticated, ladino_api;
revoke execute on function platform.cent_gaps(uuid) from public, anon;
revoke execute on function platform.cent_regularization_prepare(uuid, boolean) from public, anon;
revoke execute on function platform.cent_regularization_finish(jsonb) from public, anon;
