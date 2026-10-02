-- =============================================================================
-- Ladino — LA BASE DE LA TASA ES DE LAS NOTAS (revisión de 20260928160500, B-1)
-- Módulo: ventas · notas     Reversible: SÍ (dos CHECK; ningún dato cambia)
-- Homologación: NO — no cambia ninguna emisión; cierra filas que no deberían existir.
--
-- `documents.rate_basis` nació en 160500 sin decir a quién pertenece. Dos reglas de §2.7 (G-11):
--   · solo una NOTA (NC o ND) lleva base de tasa: la factura y el recibo van a la tasa de su día
--     por definición, no «corrigen» nada;
--   · `own_day` solo la lleva una ND: la NC siempre deshace los Bs de la factura que corrige.
-- La columna es nueva y solo la escribe la emisión de notas (createInvoiceLike), así que los datos
-- vivos ya cumplen: los CHECK se crean validados, y si no cumplieran, la migración fallaría ruidosa.
-- =============================================================================

alter table public.documents
  add constraint documents_rate_basis_only_notes_chk
    check (rate_basis is null or kind in ('credit_note', 'debit_note')),
  add constraint documents_rate_basis_own_day_debit_chk
    check (rate_basis is distinct from 'own_day' or kind = 'debit_note');
comment on constraint documents_rate_basis_only_notes_chk on public.documents is
  'B-1 (hallazgo 13, §2.7): solo una nota que corrige otra lleva base de tasa.';
comment on constraint documents_rate_basis_own_day_debit_chk on public.documents is
  'B-1 (hallazgo 13, §2.7): solo la ND por un concepto nuevo va a la tasa de su día.';

-- ── Para revertir ───────────────────────────────────────────────────────────
-- Quitar los dos CHECK. Sin pérdida de datos.
