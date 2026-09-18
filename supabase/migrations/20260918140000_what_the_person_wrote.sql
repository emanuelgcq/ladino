-- =============================================================================
-- Ladino — migración 71 · LO QUE LA PERSONA ESCRIBIÓ (ADR-0066, entrega ii)
--
-- Un costo llega a Ladino de dos formas y en dos monedas: «100 por bolsa» o
-- «1.000 por las diez», en bolívares o en dólares. El sistema deriva lo que le
-- falta —el unitario si le dieron el total, la conversión si le dieron la otra
-- moneda— y hasta hoy guardaba SOLO lo derivado. Quien mirara la fila seis
-- meses después no podía saber qué escribió la persona, y la pantalla no podía
-- devolvérselo tal como lo puso.
--
-- Dos columnas, en las tres tablas donde entra un costo:
--   · `capture_currency`: la moneda en la que se ESCRIBIÓ el importe. Puede no
--     ser la del documento —se compra con una factura en bolívares y el dueño
--     piensa en dólares—, y entonces la conversión la hizo el servidor con la
--     tasa del día del hecho;
--   · `capture_mode`: «unit» si escribió el costo de cada uno, «total» si
--     escribió el de la llegada entera.
--
-- NACEN NULAS Y EL HISTÓRICO SE QUEDA ASÍ. `inventory_moves` es append-only y
-- el UPDATE está entre las prohibiciones duras de CLAUDE.md §2: no hay backfill
-- posible ni lo habrá. Todo lector las trata como opcionales — «no se sabe» es
-- una respuesta legítima para un movimiento anterior a esta migración.
--
-- Reversibilidad: total por DDL (`drop column`), y con ella se pierde lo
-- capturado desde hoy. Nada depende de estas columnas para calcular: son
-- documentación de la captura, no insumo del costo.
-- HOMOLOGATION_IMPACT = NO: no cambia ninguna cifra.
-- =============================================================================

alter table public.inventory_moves
  add column capture_currency text,
  add column capture_mode     text;
alter table public.goods_receipt_lines
  add column capture_currency text,
  add column capture_mode     text;
alter table public.supplier_invoice_lines
  add column capture_currency text,
  add column capture_mode     text;

-- El vocabulario es CERRADO, como el de `amount_source` o el de los motivos de
-- ajuste: dos valores y nada más. Un tercero inventado en una fila sería un
-- dato que nadie sabe leer.
alter table public.inventory_moves
  add constraint inventory_moves_capture_mode_chk
    check (capture_mode is null or capture_mode in ('unit', 'total'));
alter table public.goods_receipt_lines
  add constraint goods_receipt_lines_capture_mode_chk
    check (capture_mode is null or capture_mode in ('unit', 'total'));
alter table public.supplier_invoice_lines
  add constraint supplier_invoice_lines_capture_mode_chk
    check (capture_mode is null or capture_mode in ('unit', 'total'));

-- Y la moneda, si se declara, existe.
alter table public.inventory_moves
  add constraint inventory_moves_capture_currency_fk
    foreign key (capture_currency) references public.currencies (code);
alter table public.goods_receipt_lines
  add constraint goods_receipt_lines_capture_currency_fk
    foreign key (capture_currency) references public.currencies (code);
alter table public.supplier_invoice_lines
  add constraint supplier_invoice_lines_capture_currency_fk
    foreign key (capture_currency) references public.currencies (code);

comment on column public.inventory_moves.capture_currency is
  'La moneda en la que la persona ESCRIBIÓ el importe; puede no ser la del documento, y entonces '
  'la conversión la hizo el servidor con la tasa del día del hecho. NULL = no se sabe (anterior a '
  'la migración 71; la tabla es append-only y no admite backfill).';
comment on column public.inventory_moves.capture_mode is
  '«unit» = escribió el costo de cada uno; «total» = el de la llegada entera. Lo derivado se '
  'guarda a ocho decimales; esto dice cuál de los dos es el original (ADR-0066).';
comment on column public.goods_receipt_lines.capture_currency is
  'Ver public.inventory_moves.capture_currency.';
comment on column public.goods_receipt_lines.capture_mode is
  'Ver public.inventory_moves.capture_mode.';
comment on column public.supplier_invoice_lines.capture_currency is
  'Ver public.inventory_moves.capture_currency.';
comment on column public.supplier_invoice_lines.capture_mode is
  'Ver public.inventory_moves.capture_mode.';
