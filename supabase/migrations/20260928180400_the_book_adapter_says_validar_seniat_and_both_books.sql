-- =============================================================================
-- Ladino — EL ADAPTADOR DEL LIBRO VUELVE A DECIR VALIDAR-SENIAT, Y NOMBRA LOS DOS LIBROS
-- (ADR-0073; pgTAP 027 test 8)
--
-- Módulo: libros fiscales. Rigor normal (dato de catálogo).
-- Reversible: SÍ — otro update del texto.
-- HOMOLOGATION_IMPACT: NO (texto del catálogo; no cambia ningún dato del libro).
--
-- La 20260928180200 citó el Reglamento de la LIVA (arts. 70 a 78) pero dejó la descripción de
-- `csv_columnas_legales` sin «VALIDAR-SENIAT», y la 20260928150400 (anterior en el orden de un
-- reset) decía los dos libros, también sin la marca, y queda pisada. Esta corre después de las dos
-- y deja las tres cosas: la marca, la cita y lo que trae para ventas y compras.
-- =============================================================================

update public.book_format_adapters
   set description =
     'VALIDAR-SENIAT: NO es un formato oficial de presentación; ninguna providencia fija un modelo '
     'de libro. Es un CSV con los datos que el Reglamento de la LIVA (Decreto 206, arts. 70 a 78) '
     'exige en los libros de compras y ventas, entregable a un contador para revisión y archivo. '
     'Ventas y compras traen además la base y el IVA por alícuota; su resumen (RLIVA art. 72) se '
     'entrega en la misma generación como fichero aparte (resumen-art72*.csv) y va firmado en su '
     'hash.'
 where code = 'csv_columnas_legales';

do $$
begin
  if exists (select 1 from public.book_format_adapters
              where code = 'csv_columnas_legales'
                and (description not like '%VALIDAR-SENIAT%'
                     or description not like '%arts. 70 a 78%')) then
    raise exception 'migración 180400: el adaptador csv_columnas_legales no dice VALIDAR-SENIAT o no cita el RLIVA';
  end if;
end $$;
