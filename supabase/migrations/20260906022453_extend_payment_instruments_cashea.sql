-- =============================================================================
-- Ladino — migración 42: «cashea» entra al vocabulario de cobro de VENTAS
--
-- Cashea es crédito de consumo (compra ahora, paga después): el comercio cobra
-- la venta por Cashea y la plataforma le liquida después. Por eso:
--   · `payments.instrument` lo gana (la persona cobra una venta con Cashea);
--   · `payment_methods.kind` lo gana (el negocio podrá configurar «Cashea →
--     su cuenta» cuando conecte la API; mientras tanto el cobro cae en la
--     cuenta «Sin asignar», como cualquier instrumento sin forma configurada);
--   · `supplier_payments.instrument` NO lo gana a propósito: a un proveedor
--     no se le paga con crédito de consumo.
--
-- Sin datos que migrar: solo se ensancha el CHECK. Reversible con otra
-- migración que lo vuelva a estrechar (ningún dato viejo usa el valor nuevo).
-- =============================================================================

alter table public.payments drop constraint payments_instrument_chk;
alter table public.payments add constraint payments_instrument_chk check (instrument in
  ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
   'pago_movil', 'tarjeta', 'cashea', 'saldo_a_favor', 'otro'));

alter table public.payment_methods drop constraint payment_methods_kind_chk;
alter table public.payment_methods add constraint payment_methods_kind_chk check (kind in
  ('efectivo_bs', 'efectivo_usd', 'zelle', 'usdt', 'transferencia', 'punto_venta',
   'pago_movil', 'tarjeta', 'cashea', 'otro'));
