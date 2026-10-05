-- =============================================================================
-- Ladino — 20261005100960 · LA SALIDA DE UN RETIRO LA GUARDA SU TRIGGER, NO UNA FK DIFERIBLE
--   (tercera ronda de ADR-0082; corrige 20261005100950, que se quedó corta)
--
-- Módulo: ventas · inventario (RIGOR MÁXIMO: toca `documents`)
-- Spec: ADR-0082 (nota de la tercera ronda)
-- HOMOLOGATION_IMPACT: NO — ningún documento, número ni importe cambia.
--
-- POR QUÉ OTRA MIGRACIÓN. 20261005100950 pasó `documents_withdrawal_move_fk` de «initially
--   deferred» a «initially immediate» y el pgTAP 122 avanzó de 44 a 101 aserciones de 104, pero
--   siguió cayéndose: ese test (de HEAD) hace `set constraints all deferred`, que difiere TODA
--   restricción DIFERIBLE, y entonces cada documento que inserta vuelve a dejar un evento en
--   cola y su siguiente `ALTER TABLE documents` muere igual. El defecto no era el «initially»:
--   era que `documents` tuviera una FK diferible. Una migración aplicada no se edita: se corrige
--   con esta. (Ninguna de las dos está aplicada en remoto: pueden fundirse en una antes de
--   commitear, si la sesión principal reinicia la base local.)
--
-- LA DECISIÓN (por criterio; alternativa abajo). Se SUELTA la FK. Lo que afirmaba —«la salida
--   que documenta una factura de retiro existe»— ya lo afirma, y con más fuerza, el constraint
--   trigger `documents_95_withdrawal_move` (20261005100000 §3, redefinido en 20261005100800):
--   diferido al confirmar, exige que la salida exista, sea de la MISMA empresa, sea una salida
--   con motivo de retiro gravado y señale a esta factura como su documento. Lleva
--   `when (new.kind = 'withdrawal_invoice')`: no encola nada por los demás documentos.
--   La otra mitad de una FK —que la fila referida no se borre— la da R4: `inventory_moves` es
--   append-only (trigger + ausencia de policy); una salida no se borra ni cambia de id.
--   Y `withdrawal_note_gaps` cruza las dos tablas desde fuera.
--   No es «ausencia de mecanismo»: el mecanismo que falla activamente es el trigger, y lo
--   ejerce el pgTAP 134 (aserción «una factura de retiro cuya salida NO la señala…», LAD72).
--   ALTERNATIVA DESCARTADA: conservar la FK no diferible y escribir la salida antes que la
--   factura. Invierte el orden de candados talonario → existencia que comparte con la venta
--   (ADR-0071), y dos retiros simultáneos podrían bloquearse en cruz con una venta.
--
-- COMPATIBILIDAD: expand. La API saliente no escribe `withdrawal_move_id`. La entrante no
--   nombra la FK (el `set constraints` que añadía 20261005100950 se retiró del dominio).
--   Va JUSTO DESPUÉS del `git pull`, tras 20261005100950, en la misma ventana que la familia.
-- REVERSIBILIDAD (con datos vivos): SÍ: `alter table … add constraint … foreign key …
--   deferrable` la repone y valida las filas existentes (todas cumplen: el trigger las juzgó).
--   Reponerla devuelve el defecto del pgTAP 122.
-- =============================================================================

alter table public.documents drop constraint documents_withdrawal_move_fk;

comment on column public.documents.withdrawal_move_id is
  'La salida de kardex que documenta una factura de retiro (ADR-0082). SIN clave foránea a propósito (20261005100960): una FK diferible sobre documents deja un evento en cola por cada documento insertado bajo «set constraints all deferred» e impide todo ALTER TABLE en esa transacción. La integridad la da el constraint trigger documents_95_withdrawal_move (existe, misma empresa, salida de retiro gravado, señala a esta factura) e inventory_moves es append-only.';
