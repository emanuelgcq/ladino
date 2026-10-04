-- Módulo: ventas · reembolso de saldo a favor   Spec: docs/00_GOVERNANCE/adr/ADR-0075-* (nota ola 4)
-- Ola 4 · G-15: el comprobante del reembolso imprime la tasa del día. Tercera parte de
-- 20261004150000 (una migración aplicada no se edita: esto es lo que le faltaba).
-- Reversible: SÍ mientras ningún reembolso la haya escrito (ver el pie)   Homologación: NO
--
-- Qué pasaba: `customer_refunds.fx_rate` es la tasa de la moneda DE LA CAJA a la moneda funcional.
-- Cuando un saldo a favor en divisa se reembolsa desde una cuenta en bolívares, esa tasa es la
-- identidad, y la tasa del día con que se valoró el saldo a favor —la que decide cuánto sale—
-- no quedaba en ninguna parte: habría que volver a leerla de la tabla de tasas (que puede
-- cambiar después) o dividir un importe entre otro. La regla 8 pide lo contrario: la tasa se
-- guarda con el hecho.
--
-- «Expand»: una columna nueva, nula en lo anterior. No redefine funciones ni lee nada posterior.

alter table public.customer_refunds
  add column credit_fx_rate numeric(24,8),
  add constraint customer_refunds_credit_fx_rate_chk
    check (credit_fx_rate is null or credit_fx_rate > 0);
comment on column public.customer_refunds.credit_fx_rate is
  'G-15: la tasa moneda del SALDO A FAVOR → moneda funcional del día del reembolso, la que el '
  'caso de uso usó para decidir cuánto sale de la caja. Con el saldo a favor en moneda funcional '
  'es 1. NULL = reembolso anterior a 20261004190100. (`fx_rate` es la de la moneda de la CAJA.)';

-- =============================================================================
-- REVERSIBILIDAD (con datos vivos)
--   · La columna se suelta sin pérdida SOLO mientras ningún reembolso en otra moneda la haya
--     escrito: después es el único sitio donde vive la tasa del día de ese reembolso
--     (customer_refunds es append-only: no se reconstruye).
-- =============================================================================
