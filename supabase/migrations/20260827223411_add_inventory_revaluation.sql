-- =============================================================================
-- Ladino — migración 23 · REVALORIZACIÓN: un movimiento de kardex con valor y
--                          sin cantidad
--
-- Módulo: inventory  Spec: ADR-0034 (costeo) · ADR-0040 §6 (landed cost tardío)
-- Reversible: SÍ mientras no exista ningún movimiento `revaluacion`.
-- Homologación: NO — no toca documentos fiscales ni cálculo de impuestos.
--
-- POR QUÉ EXISTE, y por qué no se resolvió de otra forma.
--
-- ADR-0040 §6 exige que el landed cost tardío suba el VALOR del inventario sin
-- añadir unidades. El primer intento fue meter una entrada con la cantidad que
-- quedaba y restarla después de `stock_balances` a mano. **Eso rompe el
-- invariante que sostiene todo el módulo de inventario**: `stock_balances` es
-- una materialización del kardex, y `platform.stock_reconciliation()` comprueba
-- que recorrer `inventory_moves` reproduce el saldo. Un UPDATE directo sobre el
-- saldo lo desincroniza en silencio, y el descuadre solo aparecería meses
-- después, en una reconciliación, sin forma de saber cuál fue el ajuste malo.
--
-- La forma correcta es que el hecho EXISTA en el kardex: un movimiento de
-- cantidad cero e importe positivo. `apply_inventory_move()` ya lo calcula bien
-- —suma `functional_amount` al valor, deja la cantidad igual y recalcula el
-- costo unitario—; lo único que lo impedía eran dos CHECK escritos cuando no se
-- contemplaba el caso.
--
-- Que un ajuste de valor sea VISIBLE en el kardex no es un efecto secundario:
-- es la propiedad que se quiere. Un costo que sube sin un movimiento que lo
-- explique es exactamente lo que hace imposible auditar un margen.
-- =============================================================================

-- Una migración aplicada no se edita: los CHECK de la 19 se sustituyen.
alter table public.inventory_moves drop constraint inventory_moves_kind_chk;
alter table public.inventory_moves add constraint inventory_moves_kind_chk
  check (kind in ('entrada', 'salida', 'ajuste', 'transferencia_in', 'transferencia_out',
                  'revaluacion'));

alter table public.inventory_moves drop constraint inventory_moves_sign_chk;
alter table public.inventory_moves add constraint inventory_moves_sign_chk check (
  case kind
    when 'entrada'           then quantity > 0 and functional_amount >= 0 and amount_transaction_currency >= 0
    when 'transferencia_in'  then quantity > 0 and functional_amount >= 0 and amount_transaction_currency >= 0
    when 'salida'            then quantity < 0 and functional_amount <= 0 and amount_transaction_currency <= 0
    when 'transferencia_out' then quantity < 0 and functional_amount <= 0 and amount_transaction_currency <= 0
    -- La revalorización es lo contrario de todo lo anterior: CERO cantidad y un
    -- importe que no es cero. Si trajera cantidad sería una entrada disfrazada,
    -- y si trajera importe cero no sería nada.
    when 'revaluacion'       then quantity = 0 and functional_amount <> 0
                                   and sign(amount_transaction_currency) = sign(functional_amount)
    else quantity <> 0
         and sign(functional_amount) in (0, sign(quantity))
         and sign(amount_transaction_currency) in (0, sign(quantity))
  end);

-- Un movimiento de revalorización SIEMPRE dice de dónde viene. Sin origen, un
-- ajuste de valor es indistinguible de un error de dedo, y el kardex dejaría de
-- explicar el costo — que es para lo que existe.
alter table public.inventory_moves add constraint inventory_moves_revaluation_reason_chk
  check (kind <> 'revaluacion'
         or source_document_id is not null
         or (reason is not null and length(btrim(reason)) >= 3));

comment on constraint inventory_moves_revaluation_reason_chk on public.inventory_moves is
  'ADR-0040 §6: una revalorización sin documento de origen ni motivo sería un '
  'costo que sube sin nada que lo explique.';

-- LAD57: lo que esta migración garantiza sobre sí misma.
do $$
begin
  if not exists (select 1 from pg_constraint
                  where conname = 'inventory_moves_kind_chk'
                    and pg_get_constraintdef(oid) like '%revaluacion%') then
    raise exception 'LAD57: inventory_moves no admite el movimiento de revalorización';
  end if;
  -- Y la comprobación que de verdad importa: que el CHECK de signo EXIJA
  -- cantidad cero para este tipo. Si admitiera cantidad, la revalorización
  -- podría meter unidades y el landed cost tardío inventaría existencias.
  --
  -- Se comprueba sobre la DEFINICIÓN del constraint y no con un INSERT de
  -- prueba: un insert en `inventory_moves` dispara `apply_inventory_move()`,
  -- que fallaría antes por company inexistente y haría pasar la sonda por la
  -- razón equivocada. Una sonda que puede pasar por el motivo que no es, no es
  -- una sonda.
  -- El `(?s)` es necesario: la definición viene en varias líneas y sin él el
  -- punto no cruza el salto. Y `quantity = (0)` con el paréntesis porque
  -- Postgres normaliza el literal a `(0)::numeric` al guardarla.
  if (select pg_get_constraintdef(oid) from pg_constraint
       where conname = 'inventory_moves_sign_chk')
     !~ '(?s)revaluacion.*quantity = \(0\)' then
    raise exception 'LAD57: el CHECK de signo no exige cantidad CERO en la revalorización';
  end if;
  if not exists (select 1 from pg_constraint
                  where conname = 'inventory_moves_revaluation_reason_chk') then
    raise exception 'LAD57: falta el CHECK que exige origen o motivo en una revalorización';
  end if;
end $$;
