-- =============================================================================
-- Ladino — migración 54 · EL MODO DE VENTA, UNA SOLA DEFINICIÓN
--
-- Plan «Ladino sin RIF», Ola 1.0 (2026-09-14). Hasta hoy, «¿esta empresa vende
-- con recibos?» se contestaba con fórmulas distintas en seis sitios: el dominio
-- (`allowed_kinds` incluye receipt y no invoice), la venta rápida (la misma idea,
-- con otra consulta y otro reloj), la API de puesta a punto y cuatro pantallas
-- (el NOMBRE del régimen, `= 'sin_facturacion'`). Con `sin_emision` o sin régimen
-- divergían. Esta función es la única respuesta, y la usan dominio, API y web.
--
-- SE DERIVA DEL RÉGIMEN, no se almacena: un campo propio sería una segunda
-- verdad capaz de contradecir al trigger de emisión, que es quien decide de
-- verdad. Por eso la función replica EXACTAMENTE su lógica
-- (platform.assert_document_issuance, versión de la migración
-- 20260904233235): sin régimen o con `numbering_mode = 'none'` no se emite
-- nada; si no, se emite lo que `allowed_kinds` diga.
--
--   'facturas' — el régimen vigente emite `invoice`;
--   'recibos'  — emite `receipt` y no `invoice`;
--   'ninguno'  — no emite venta alguna (sin régimen, sin_emision,
--                interno_no_fiscal).
--
-- El pgTAP 054 compara esta función contra el TRIGGER para cada régimen
-- sembrado: si algún día divergen, manda el trigger y se corrige la función.
--
-- Reversible: `drop function platform.sales_mode_at(uuid, timestamptz)`.
-- Sin datos, sin tablas, sin cambio de comportamiento del trigger.
-- HOMOLOGATION_IMPACT = NO (no cambia qué se emite ni cómo).
-- =============================================================================

create function platform.sales_mode_at(p_company uuid, p_fecha timestamptz)
returns text
language sql
stable
set search_path = ''
as $$
  select case
           when r.regime_version_id is null or r.numbering_mode = 'none' then 'ninguno'
           when 'invoice' = any (r.allowed_kinds) then 'facturas'
           when 'receipt' = any (r.allowed_kinds) then 'recibos'
           else 'ninguno'
         end
    from (select null::int as ancla) a
    left join platform.regime_at(p_company, p_fecha) r on true
$$;

comment on function platform.sales_mode_at(uuid, timestamptz) is
  'El modo de venta de una empresa A LA FECHA DADA: facturas | recibos | ninguno. '
  'Derivado del régimen vigente con la misma lógica del trigger de emisión '
  '(migración 54, plan «Ladino sin RIF»). Única definición: dominio, API y web la usan.';

revoke execute on function platform.sales_mode_at(uuid, timestamptz) from public;
grant execute on function platform.sales_mode_at(uuid, timestamptz) to authenticated, ladino_api;
