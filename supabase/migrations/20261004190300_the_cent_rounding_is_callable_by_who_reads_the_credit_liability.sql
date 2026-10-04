-- Módulo: ventas · cobros y saldos a favor   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (decisión 5)
-- Ola 4 · tercera ronda — corrige a 20261004190200 (una migración creada no se edita)
-- Reversible: SÍ (revoke; ver el pie)   Homologación: NO (un permiso de ejecución sobre una
-- función pura; no cambia ningún cálculo)
--
-- Qué pasaba: platform.customer_credit_uses, customer_credit_carried y customer_credit_ledger_gap
-- (20261004190200) son `security invoker` y redondean al céntimo con platform.round_cents. Esa
-- función no tenía EXECUTE para `ladino_api` ni `authenticated`: hasta ahora solo la llamaban
-- funciones `security definer`. Con un saldo a favor delante, la API recibía 42501 al aplicar o
-- reembolsar —que su tabla de errores convierte en 404—: el cobro con saldo a favor no funcionaba.
-- La migración se aplicó limpia y el catálogo decía que las tres funciones eran ejecutables: lo
-- destapó el E2E, que corre como ladino_api (skill migracion-supabase: «ejerce la operación, no
-- preguntes por el privilegio»). El pgTAP 133 ejerce ahora el camino como ladino_api.
--
-- Qué hace: da EXECUTE sobre platform.round_cents(numeric) a los dos roles que leen el pasivo de
-- un saldo a favor. Es una función pura (redondeo half-up al céntimo): no lee ninguna tabla.
-- «Expand»: solo añade un permiso. Va con 20261004190200, justo después del git pull.

do $$
begin
  if to_regprocedure('platform.round_cents(numeric)') is null then
    raise exception 'falta platform.round_cents(numeric): esta migración va después de la que la crea';
  end if;
end $$;

grant execute on function platform.round_cents(numeric) to authenticated, ladino_api;

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · `revoke execute on function platform.round_cents(numeric) from authenticated, ladino_api`
--     la devuelve a como estaba, sin tocar datos. Hacerlo con 20261004190200 aplicada vuelve a
--     romper aplicar y reembolsar un saldo a favor (42501): solo junto con la reversa de aquella.
-- =============================================================================
