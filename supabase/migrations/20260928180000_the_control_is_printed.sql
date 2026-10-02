-- =============================================================================
-- Ladino — EL CONTROL SE IMPRIME (ADR-0071 §4; RESPUESTA 2026-09-24 §2.1, último punto)
-- Módulo: ventas · documento impreso     Hallazgos: ADR-0071 §4 (control impreso)
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — decide si el número de control va impreso en el cuerpo de la forma libre
--
-- «El control se imprime con su identificador: `00-00001234`. Se registra siempre en el
-- documento; imprimirlo en el cuerpo es un ajuste por empresa (`imprimir_numero_de_control`, por
-- defecto sí, como hacen los ERP venezolanos).»
--
-- El número de control lo PREIMPRIME la imprenta en la forma libre (PA 00071 art. 31). Ladino lo
-- registra siempre (`documents.control_number` y `control_identifier`, migración 160000) y nunca
-- lo imprime SOBRE la casilla preimpresa. Este ajuste decide solo si además lo repite en el
-- cuerpo del documento, para que quien lo lea lo encuentre junto al número de la factura.
--
-- Vive en `company_settings` (migración 28) porque es un interruptor de PRESENTACIÓN: no cambia
-- qué control consume el documento ni qué se registra. Una empresa sin fila de ajustes lo tiene
-- encendido (el `coalesce` de quien lo lee y el DEFAULTS del caso de uso dicen lo mismo que el
-- default de la columna).
--
-- La tabla ya tiene RLS forzada, sus policies `TO ladino_api` (select/insert/update) y su ancla
-- (`company_settings_01_anchors`): una columna nueva no necesita policy propia.
-- =============================================================================

alter table public.company_settings
  add column print_control_number boolean not null default true;

comment on column public.company_settings.print_control_number is
  'ADR-0071 §4: si el número de control (00-00001234) se imprime también en el CUERPO del '
  'documento. Nunca se imprime sobre la casilla que preimprime la imprenta (PA 00071 art. 31), y '
  'el control se registra en el documento siempre, con el ajuste encendido o apagado.';

-- ── Autochequeo ──────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from public.company_settings where print_control_number is distinct from true) then
    raise exception 'migración 180000: toda empresa existente debe quedar con el control impreso (default)';
  end if;
end $$;

-- ── Para revertir ────────────────────────────────────────────────────────────
-- `alter table public.company_settings drop column print_control_number;`
-- Con datos vivos se pierde la elección de las empresas que lo APAGARON (las demás vuelven a su
-- comportamiento igual: el PDF anterior a esta migración imprimía el control siempre). Antes de
-- revertir, `select company_id from public.company_settings where not print_control_number`
-- dice a quién avisar. Los documentos emitidos no cambian: el control sigue registrado en ellos.
