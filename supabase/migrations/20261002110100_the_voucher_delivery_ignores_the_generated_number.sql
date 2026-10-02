-- =============================================================================
-- Ladino — LA ENTREGA DEL COMPROBANTE NO TROPIEZA CON SU NÚMERO GENERADO
-- (ADR-0072 §4; corrige la migración 20261002110000, misma entrega)
--
-- Módulo: compras · retenciones. Rigor máximo (documento fiscal).
-- Reversible: SÍ — create or replace con la definición de 20261002110000 §6.
-- HOMOLOGATION_IMPACT: NO — no cambia qué se emite ni qué se declara; solo deja anotar la entrega.
--
-- Qué pasaba: `platform.retention_vouchers_guard` compara la fila vieja y la nueva menos las
-- columnas de la entrega. `voucher_number` es una columna GENERADA, y en un trigger BEFORE su valor
-- en NEW todavía es NULL (Postgres la calcula después de los BEFORE). La comparación nunca daba
-- igual y anotar la entrega moría con LAD06. Lo encontró el E2E «la entrega se anota una vez».
--
-- Qué cambia: `voucher_number` sale de la comparación. Sigue protegido: es función de
-- `voucher_period` y `sequence`, que sí se comparan. Todo lo demás de la función queda igual
-- (definición viva: 20261002110000 §6).
-- =============================================================================

create or replace function platform.retention_vouchers_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'un comprobante de retención no se borra: se corrige con una versión nueva (ADR-0072 §4)'
      using errcode = 'LAD06';
  end if;
  -- `voucher_number` fuera: es GENERADA y en NEW vale NULL dentro de un BEFORE. Depende solo de
  -- voucher_period y sequence, que sí se comparan.
  if old.delivered_on is null and new.delivered_on is not null
     and (to_jsonb(old) - 'delivered_on' - 'delivered_by' - 'version' - 'voucher_number')
       = (to_jsonb(new) - 'delivered_on' - 'delivered_by' - 'version' - 'voucher_number') then
    return new;
  end if;
  raise exception 'un comprobante de retención emitido no se edita: solo se anota su entrega, una vez; corregirlo emite una versión nueva (ADR-0072 §4)'
    using errcode = 'LAD06';
end;
$$;
revoke execute on function platform.retention_vouchers_guard() from public;

-- =============================================================================
-- Reversibilidad (con datos vivos): SÍ. Volver a la definición de 20261002110000 §6 deja otra vez
-- sin poder anotar entregas; no toca ninguna fila.
-- =============================================================================
