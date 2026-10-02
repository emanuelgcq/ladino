-- =============================================================================
-- Ladino — «FORMAS LIBRES», no «formatos libres» (B-08; RESPUESTA 2026-09-24 §2.3)
-- Módulo: régimen fiscal (catálogo)     Hallazgo: B-08
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: NO — cambia el NOMBRE que la pantalla enseña, no cómo se emite ni se numera
--
-- La PA SNAT/2011/00071 separa tres medios de emisión (art. 6): FORMATOS, FORMAS LIBRES y
-- máquinas fiscales. En los formatos (art. 30) la imprenta preimprime también el número y la
-- serie; en las formas libres (art. 31) solo el control, el RIF del emisor, sus propios datos y
-- providencia, el rango y la fecha de elaboración — nunca la denominación ni el número del
-- documento. Ladino funciona como forma libre (ADR-0037, ADR-0071), pero el catálogo decía
-- «Formatos libres», y leyendo «formatos» alguien puede registrar como talonario los números de
-- factura preimpresos.
--
-- Solo cambian `name` y `description` de la fila de catálogo. El `code` (`formatos_libres`) NO
-- cambia: lo referencian `company_fiscal_regimes`, las versiones de régimen de los documentos
-- emitidos y la API; renombrarlo sería reescribir historia para arreglar una etiqueta.
-- =============================================================================

update public.fiscal_regimes
   set name = 'Formas libres',
       description = 'Emisión sobre formas libres de imprenta autorizada (PA 00071 arts. 6 num. 2 '
                     'y 31), con rango de números de control.'
 where code = 'formatos_libres';

do $$
begin
  if not exists (select 1 from public.fiscal_regimes
                  where code = 'formatos_libres' and name = 'Formas libres') then
    raise exception 'migración 180100: el régimen formatos_libres no quedó nombrado «Formas libres»';
  end if;
end $$;

-- ── Para revertir ────────────────────────────────────────────────────────────
-- update public.fiscal_regimes
--    set name = 'Formatos libres',
--        description = 'Emisión con formatos libres por imprenta autorizada, con rango de números de control.'
--  where code = 'formatos_libres';
-- Nada más depende del texto: ninguna fila de negocio copia el nombre del régimen.
