-- Módulo: compras · fiscal   Spec: ADR-0083 §3 (tercera ronda, AF5-14) · RESPUESTA §3 H-03
-- Reversible: SÍ mientras ninguna nota fiscal se registre sin control y con referencia (ver abajo)
-- Homologación: NO (no cambia el libro de compras ni su formato: la marca es de control interno)
--
-- Familia H-03 (ola 5), tercera ronda. Va con 20261005110000 … 110600, justo después del
-- `git pull` y en ese orden. Corrige el CHECK de la 110100.
--
-- ANTES DE APLICARLA EN UNA BASE CON DATOS (tiene que dar 0; si no, el CHECK nuevo no entra y
-- la migración falla entera, que es lo que debe hacer: una nota asentada no se reescribe):
--   select count(*) from public.supplier_credit_notes
--    where is_fiscal and supplier_control_number is null and not document_incomplete;
-- Base local con el escenario, 2026-10-04: 0 de 229 notas. Producción: 0 notas.
--
-- QUÉ PASABA
--   «Documento incompleto» era «fiscal, sin número de control Y sin referencia»
--   (`supplier_document_ref`). La respuesta del dueño dice otra cosa: «si viene sin control, se
--   registra igual para reducir el crédito (lectura conservadora) y queda marcada «documento
--   incompleto»». Una referencia cualquiera no es un número de control (PA 00071 art. 23 →
--   art. 13) y no exime de la marca.
--
-- QUÉ HACE
--   Sustituye `supplier_credit_notes_document_incomplete_chk`: la marca es EXACTAMENTE «fiscal
--   y sin número de control». No hay excepción por tipo de documento: ni las notas ni las
--   facturas de proveedor llevan un tipo (máquina fiscal u otro) que declare que no llevan
--   control; si algún día existe, con su fuente en docs/02_COMPLIANCE/, la excepción irá en
--   este enunciado, no en una lista.
--
-- REVERSIBILIDAD, CON DATOS VIVOS
--   Se revierte reponiendo el CHECK de la 110100, que es MÁS ancho en un sentido y más estrecho
--   en otro: una nota fiscal sin control y con referencia, registrada con este CHECK, lleva
--   `document_incomplete = true` y violaría el anterior. Con una sola de esas notas, volver
--   atrás exige dejar el CHECK anterior como NOT VALID.
--
-- EXPAND/CONTRACT: la API anterior manda `document_incomplete = false` para la nota fiscal sin
-- control y con referencia: entre esta migración y el arranque de la API nueva esa nota se
-- rechaza (23514). La pantalla no envía `supplier_document_ref`: solo lo haría un cliente de la API.
--
-- No redefine ninguna función.
--
-- DESPLIEGUE: JUSTO DESPUÉS del `git pull`, inmediatamente después de 20261005110600.

alter table public.supplier_credit_notes
  drop constraint supplier_credit_notes_document_incomplete_chk;
alter table public.supplier_credit_notes
  add constraint supplier_credit_notes_document_incomplete_chk
    check (document_incomplete = (is_fiscal and supplier_control_number is null));

comment on column public.supplier_credit_notes.document_incomplete is
  'H-03 (RESPUESTA §3; PA 00071 art. 23 → art. 13): nota fiscal que llegó SIN número de control. Se registra igual (reduce el crédito fiscal) y queda marcada. Una referencia (supplier_document_ref) no exime. La escribe el caso de uso; el CHECK impide que contradiga a sus columnas; inmutable después de asentada (LAD06).';
