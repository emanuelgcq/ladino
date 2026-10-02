-- =============================================================================
-- Ladino — LOS CONTROLES REPETIDOS TIENEN QUIEN LOS MIRE (ADR-0071, G-01)
-- Módulo: ventas · numeración     Reversible: SÍ (dos funciones de solo lectura)
-- Homologación: NO — no cambia ninguna emisión; solo pregunta.
--
-- La migración 20260928160000 falla con la lista si encuentra controles
-- repetidos o rangos solapados. Esa comprobación vivía en un bloque DO, que
-- nadie puede volver a ejecutar ni probar. Aquí se convierte en dos funciones
-- cuya respuesta correcta es CERO filas (el molde de accounting_coverage_gaps):
--
--   · platform.control_number_collisions() — documentos con el mismo control
--     en la misma empresa e identificador (PA 00071 art. 44), sin mirar la
--     clase ni la serie; el talonario de contingencia, dentro de su serie;
--   · platform.control_range_overlaps() — rangos no anulados que se pisan.
--
-- Hoy el índice único y la exclusión hacen imposible que devuelvan algo. Si
-- una migración futura los quita o los relaja, estas funciones lo dicen, y el
-- pgTAP 080 comprueba que de verdad lo dirían (variante rota).
-- =============================================================================

create function platform.control_number_collisions()
returns table (company_id uuid, control_identifier text, control_number bigint, documents text)
language sql
stable
set search_path = ''
as $$
  select d.company_id, coalesce(d.control_identifier, '00'), d.control_number,
         string_agg(format('%s %s-%s', d.kind, d.series, d.document_number), ', '
                    order by d.kind, d.series, d.document_number)
    from public.documents d
   where d.control_number is not null
   group by d.company_id, coalesce(d.control_identifier, '00'), d.control_number,
            case when lower(d.series) like 'contingencia%' then d.series end
  having count(*) > 1
$$;
comment on function platform.control_number_collisions() is
  'Invariante de ADR-0071: dos documentos con el mismo número de control en la misma empresa e '
  'identificador. Respuesta correcta: cero filas.';

create function platform.control_range_overlaps()
returns table (company_id uuid, range_a uuid, range_b uuid)
language sql
stable
set search_path = ''
as $$
  select a.company_id, a.id, b.id
    from public.fiscal_number_ranges a
    join public.fiscal_number_ranges b
      on b.company_id = a.company_id and a.id < b.id
     and b.printer_identifier = a.printer_identifier
     and int8range(a.range_from, a.range_to, '[]') && int8range(b.range_from, b.range_to, '[]')
   where a.status <> 'cancelled' and b.status <> 'cancelled'
     and a.kind is distinct from 'retention_receipt' and b.kind is distinct from 'retention_receipt'
     and lower(a.series) not like 'contingencia%' and lower(b.series) not like 'contingencia%'
$$;
comment on function platform.control_range_overlaps() is
  'Invariante de ADR-0071: rangos de control no anulados que se solapan en la misma empresa e '
  'identificador. Respuesta correcta: cero filas.';

revoke execute on function platform.control_number_collisions() from public;
revoke execute on function platform.control_range_overlaps() from public;

do $$
begin
  if exists (select 1 from platform.control_number_collisions())
     or exists (select 1 from platform.control_range_overlaps()) then
    raise exception 'LAD52: hay controles repetidos o rangos solapados (ADR-0071)'
      using errcode = 'LAD52';
  end if;
end $$;
