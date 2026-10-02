-- =============================================================================
-- Ladino — LA NOTA DICE A QUÉ TASA VA (ADR-0071 · respuesta del dueño §2.7, G-11)
-- Módulo: ventas · notas     Auditoría fiscal de la ronda: hallazgo 13
-- Reversible: SÍ (una columna nullable y un trigger; ver «Para revertir»)
-- Homologación: YES — cambia la tasa de la nota de débito por un concepto nuevo
--
-- Respuesta del dueño §2.7: la NC y la ND que CORRIGEN una factura van a la tasa de la
-- factura, porque deshacen sus Bs en el libro; una ND por un concepto NUEVO (interés, flete)
-- va a la tasa BCV de SU día. Hasta ahora toda nota tomaba la de la factura, y el PDF
-- imprimía «Tasa BCV de la factura» también sobre la ND de un flete.
--
-- `documents.rate_basis` registra cuál fue:
--   · 'origin'  — la tasa de la factura que la nota corrige;
--   · 'own_day' — la tasa BCV del día de la nota (ND por un concepto nuevo);
--   · NULL      — un documento que no es nota, o una nota anterior a esta migración (todas
--                 fueron a la tasa de la factura: el PDF lee NULL como 'origin').
-- Se fija al emitir y es inmutable después: la tasa congelada y su base van juntas.
-- =============================================================================

alter table public.documents
  add column rate_basis text,
  add constraint documents_rate_basis_chk check (rate_basis in ('origin', 'own_day'));
comment on column public.documents.rate_basis is
  'Hallazgo 13 (§2.7, G-11): ''origin'' = la tasa de la factura que la nota corrige; ''own_day'' '
  '= la tasa BCV del día de la nota (ND por un concepto nuevo). NULL = no es nota, o nota anterior '
  '(fue a la tasa de la factura). Inmutable una vez emitido.';

create function platform.documents_rate_basis_frozen()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status in ('issued', 'paid', 'annulled')
     and new.rate_basis is distinct from old.rate_basis then
    raise exception
      'LAD06: la base de la tasa de un documento emitido es inmutable, como la tasa misma (§2.7)'
      using errcode = 'LAD06';
  end if;
  return new;
end;
$$;
revoke execute on function platform.documents_rate_basis_frozen() from public;
create trigger documents_04_rate_basis_frozen
  before update on public.documents
  for each row execute function platform.documents_rate_basis_frozen();

-- ── Para revertir ───────────────────────────────────────────────────────────
-- Quitar el trigger y la función. La columna puede quedarse (nullable); borrarla pierde qué
-- notas fueron a la tasa de su día, que el PDF necesita para decirlo.
