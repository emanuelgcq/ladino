-- Módulo: contabilidad   Spec: ADR-0083 §5
-- Reversible: SÍ (un texto de catálogo)   Homologación: NO
--
-- Familia H-03 (ola 5). Va con 20261005110000–110300, justo después del `git pull`.
--
-- QUÉ PASABA
--   La descripción del papel `supplier_credit_receivable` (20261005110200) remite a la pregunta
--   «P-104» de PENDIENTES_ASESOR.md. Ese número lo tomó a la vez otra familia de la misma ola
--   (P-07, el reporte «IVA del período»). La pregunta sobre el código de la cuenta de saldos a
--   favor con proveedores y su presentación es la **P-105**. La cabecera de la 110200 también
--   dice P-104 y no se puede corregir (una migración aplicada no se edita): léase P-105.
--
-- QUÉ HACE
--   Corrige el texto del catálogo. No toca cuentas, plantillas ni funciones.

update public.account_purposes
   set description = replace(description, '(P-104)', '(P-105)')
 where code = 'supplier_credit_receivable' and description like '%(P-104)%';

do $$
begin
  if exists (select 1 from public.account_purposes
              where code = 'supplier_credit_receivable' and description like '%P-104%') then
    raise exception 'LAD82: la descripción de supplier_credit_receivable sigue citando P-104'
      using errcode = 'LAD82';
  end if;
end $$;
