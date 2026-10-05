-- =============================================================================
-- Ladino — 20261005100950 · LA FK DE LA SALIDA DE UN RETIRO SE DIFIERE SOLO PARA QUIEN LA
--   NECESITA (tercera ronda de ADR-0082)
--
-- Módulo: ventas · inventario (RIGOR MÁXIMO: toca `documents`)
-- Spec: ADR-0082 (nota de la tercera ronda)
-- HOMOLOGATION_IMPACT: NO — ningún documento, número ni importe cambia. Cambia CUÁNDO se
--   comprueba una clave foránea que solo usa la factura de retiro.
--
-- EL DEFECTO. 20261005100000 creó `documents_withdrawal_move_fk` como `deferrable initially
--   deferred`: la factura de retiro se emite antes de que exista su salida de kardex, y la FK
--   se comprueba al confirmar. Pero «initially deferred» vale para TODA fila de `documents`:
--   cada documento insertado —una factura, un recibo, una cotización, con la columna en NULL—
--   deja en cola un evento de comprobación hasta el final de su transacción. Mientras hay
--   eventos en cola, Postgres rechaza todo `ALTER TABLE documents` en esa transacción
--   («cannot ALTER TABLE "documents" because it has pending trigger events»).
--   Lo destapó el pgTAP 122 (reglas, de HEAD): se cae con ese error en su línea 332 y deja de
--   correr 60 de sus 104 aserciones. No lo vio ningún test de la familia.
-- ARREGLO. La FK pasa a `deferrable initially immediate`: se comprueba al final de cada
--   sentencia, como cualquier otra, y no deja nada en cola. El ÚNICO camino que necesita
--   diferirla —`emitirFacturaDeRetiro`, que escribe la factura antes que la salida— la difiere
--   para su transacción con `set constraints … deferred`. El orden de candados (talonario →
--   existencia) no cambia.
--
-- COMPATIBILIDAD: expand. La API saliente no emite facturas de retiro: no escribe
--   `withdrawal_move_id`. La entrante difiere la FK antes de escribirla. Si la API entrante
--   corriera contra una base SIN esta migración, `set constraints … deferred` sobre una FK ya
--   diferida no hace nada: no hay orden frágil entre las dos.
--   Va JUSTO DESPUÉS del `git pull`, tras 20261005100900, en la misma ventana que la familia.
-- REVERSIBILIDAD (con datos vivos): SÍ, entera: `alter constraint … initially deferred` la
--   devuelve a como estaba. No toca ni valida ninguna fila.
-- =============================================================================

alter table public.documents
  alter constraint documents_withdrawal_move_fk deferrable initially immediate;

comment on constraint documents_withdrawal_move_fk on public.documents is
  'La salida de kardex que documenta una factura de retiro (ADR-0082). DIFERIBLE pero inmediata por omisión: solo emitirFacturaDeRetiro la difiere (set constraints … deferred), porque escribe la factura antes que la salida. Si se vuelve «initially deferred», cada documento insertado deja un evento en cola y ningún ALTER TABLE documents cabe en esa transacción (lo vigila el pgTAP 122).';
