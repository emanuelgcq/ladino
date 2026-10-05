-- Módulo: compras   Spec: ADR-0083 · PA 00071 arts. 13 y 23
-- Reversible: SÍ mientras no haya notas registradas (ver abajo)   Homologación: NO (no cambia cifras)
--
-- Corrige 20261005110000 (H-03). Va SIEMPRE junto a ella, justo después.
--
-- QUÉ PASABA
--   `supplier_credit_notes.document_incomplete` nació como columna GENERADA. La guarda de los
--   documentos de compra (`platform.assert_purchase_doc_immutable`, trigger BEFORE UPDATE) compara
--   la fila vieja con la nueva, y en un trigger BEFORE una columna generada todavía NO está
--   calculada en NEW: vale NULL. Toda actualización de una nota ya asentada —la única permitida,
--   el enlace con su asiento (`journal_entry_id`)— parecía cambiar `document_incomplete` y se
--   rechazaba con LAD06: ninguna nota de crédito se podía registrar. Lo vio el E2E
--   (`e2e-inventario-en-el-mayor`), no la aplicación de la migración, que fue limpia.
--
-- QUÉ HACE
--   La columna pasa a ser una columna NORMAL que escribe el caso de uso, y un CHECK la ata a su
--   definición: no puede decir «completa» una nota fiscal sin control ni referencia, ni
--   «incompleta» una que los trae. Lo que se pierde frente a la generada es nada: el CHECK falla
--   activamente donde la generada calculaba en silencio. La guarda NO se toca: sigue enumerando
--   lo que una nota asentada puede cambiar, y esta columna no está en esa lista.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Volver a la columna generada devuelve el defecto (ninguna nota se registra). No tiene sentido
--   revertirla sola. Ninguna fila existente cambia de valor (todas valían false; ver abajo).
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110000.
-- No redefine ninguna función.

-- NO HAY RELLENO, y no se aparta la guarda para hacerlo. Toda nota anterior a esta migración
-- trae control o referencia: lo exigía el CHECK que 20261005110000 quitó, lo sigue exigiendo la
-- API anterior, y con 20261005110000 sola la API nueva no logra registrar ninguna. Para todas,
-- la generada valía false, que es el valor por omisión. Si aun así existiera una nota fiscal sin
-- control ni referencia, el CHECK de abajo NO se puede crear y la migración falla entera: del
-- lado ruidoso, sin tocar un documento asentado.
do $$
begin
  if exists (select 1 from public.supplier_credit_notes where document_incomplete) then
    raise exception
      'hay notas de crédito de proveedor marcadas incompletas antes de 20261005110100: revisar a mano, no se rellenan en silencio';
  end if;
end $$;

alter table public.supplier_credit_notes drop column document_incomplete;
alter table public.supplier_credit_notes
  add column document_incomplete boolean not null default false;

alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_document_incomplete_chk
  check (document_incomplete = (is_fiscal and supplier_control_number is null
                                and supplier_document_ref is null));

comment on column public.supplier_credit_notes.document_incomplete is
  'H-03 (PA 00071 art. 23 → art. 13): nota fiscal registrada SIN número de control ni referencia. '
  'Reduce el crédito fiscal igual (lectura conservadora) y queda marcada para pedir el papel. La '
  'escribe el caso de uso y el CHECK supplier_credit_notes_document_incomplete_chk la ata a su '
  'definición. NO es una columna generada a propósito: la guarda BEFORE UPDATE de los documentos '
  'de compra ve NULL en una generada y rechazaría el enlace con el asiento (20261005110100).';
comment on constraint supplier_credit_notes_document_incomplete_chk
  on public.supplier_credit_notes is
  'H-03: «incompleta» es exactamente «fiscal, sin control y sin referencia». Quitarlo deja que una '
  'nota sin control figure como completa, y la pantalla dejaría de pedir el papel.';
