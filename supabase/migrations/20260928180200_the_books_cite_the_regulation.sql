-- =============================================================================
-- Ladino — LOS LIBROS CITAN EL REGLAMENTO, NO LA PROVIDENCIA DE LA FACTURA (L-11)
-- Módulo: libros fiscales (catálogo de adaptadores)     Hallazgo: L-11
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: NO — cambia el texto del catálogo, no el contenido ni el formato del libro
--
-- El adaptador `csv_columnas_legales` (migración 20260831173150) decía «CSV con las columnas de
-- PA 071 y PA 102». El contenido de los libros de compras y de ventas lo regula el Reglamento de
-- la LIVA (Decreto 206, G.O. 5.363 Ext., 12-07-1999), arts. 70 a 78 —cronológicos y sin atraso
-- (art. 70), resumen por alícuota (art. 72), compras (art. 75), ventas (arts. 76-77)—, y la
-- PA 00071 regula la factura. Fuente en el repo: docs/02_COMPLIANCE/REGULATORY_STATUS.md (fila
-- «RLIVA … 70-78», leída en reproducción no oficial; la fuente primaria sigue pendiente allí).
--
-- Ninguna providencia fija un MODELO de libro (RLIVA art. 74): el adaptador sigue siendo NO
-- oficial, y eso no cambia (`is_official = false`).
--
-- El `code` no cambia: lo referencian las generaciones ya hechas (`fiscal_book_runs`).
-- =============================================================================

update public.book_format_adapters
   set name = 'CSV con las columnas del Reglamento de la LIVA (arts. 70 a 78)',
       description = 'NO es un formato oficial de presentación: ninguna providencia fija un modelo '
                     'de libro. Es un CSV con los datos que el Reglamento de la LIVA (Decreto 206, '
                     'arts. 70 a 78) exige en los libros de compras y ventas, entregable a un '
                     'contador para revisión y archivo.',
       legal_source = 'Reglamento de la LIVA (Decreto 206, G.O. 5.363 Ext., 12-07-1999), arts. 70 '
                      'a 78, en cuanto a los DATOS del libro. Ninguna providencia fija su formato.'
 where code = 'csv_columnas_legales';

do $$
begin
  if not exists (select 1 from public.book_format_adapters
                  where code = 'csv_columnas_legales' and name like '%Reglamento de la LIVA%') then
    raise exception 'migración 180200: el adaptador csv_columnas_legales sigue citando la PA 071';
  end if;
end $$;

-- ── Para revertir ────────────────────────────────────────────────────────────
-- Restituir name, description y legal_source con los textos de la migración 20260831173150
-- (sección 8, «Seeds»). Ninguna fila de negocio copia esos textos: las generaciones guardan el
-- `code`, no el nombre.
