-- =============================================================================
-- Ladino — UN DOCUMENTO, UNA FORMA LIBRE (PA 00071 art. 33; auditoría fiscal 2026-10-02)
-- Módulo: ventas · documento impreso     Hallazgo: auditoría fiscal de la ola 2 (P-55 se cierra)
-- Reversible: SÍ, con datos vivos (ver «Para revertir» al final)
-- Homologación: YES — limita cuántas líneas puede llevar una factura, NC o ND sobre forma libre
--
-- PA SNAT/2011/00071, art. 33 (texto en https://tributos.ivecofi.net, reproducción no oficial,
-- verificado el 2026-10-02): cada factura, nota de crédito o nota de débito emitida sobre forma
-- libre ocupa UNA forma; si la operación no cabe, se emiten varios documentos, cada uno con su
-- número. Lo que ADR-0071 decía («continúa en la hoja siguiente», P-55) queda corregido.
--
-- Decidido por criterio (RESPUESTA §2.16), opción (a): un TOPE DE LÍNEAS por documento, ajuste por
-- empresa. El dominio lo valida al emitir (422 legible) y `?destino=papel` rechaza, como defensa,
-- un documento que pase de una página (una descripción muy larga puede ocupar varias filas).
-- Alternativa (b): partir la operación sola en varios documentos.
--
-- MEDIDO sobre el diseño actual del PDF (apps/api/test/e2e-checklist-factura.test.ts, factura en
-- USD con gravadas y exentas, el caso más alto): 22 líneas de una fila caben en una página de la
-- vista previa y 24 ya no. Por omisión 15 (holgura para la NC y la ND, que suman la referencia a la
-- factura, el ajuste y el motivo); como máximo 18. Una imprenta cuya forma tenga menos espacio se
-- configura más abajo.
-- =============================================================================

alter table public.company_settings
  add column lines_per_free_form integer not null default 15,
  add constraint company_settings_lines_per_free_form_chk
    check (lines_per_free_form between 1 and 18);

comment on column public.company_settings.lines_per_free_form is
  'PA 00071 art. 33: una factura, NC o ND sobre forma libre ocupa UNA forma. Tope de líneas por '
  'documento que el dominio exige al emitir (decidido por criterio, opción (a)). Medido: caben 22 '
  'líneas de una fila en el diseño actual; por omisión 15, como máximo 18.';
comment on constraint company_settings_lines_per_free_form_chk on public.company_settings is
  'El máximo (18) es lo que cabe con holgura en una página del PDF de papel (medido); subirlo '
  'exige medir de nuevo, porque `?destino=papel` rechaza lo que pase de una página.';

-- ── Para revertir ────────────────────────────────────────────────────────────
-- `alter table public.company_settings drop column lines_per_free_form;` — con datos vivos se pierde
-- el tope que cada empresa configuró, y el dominio vuelve a dejar emitir documentos de cualquier
-- largo (quedaría solo la defensa del papel). Los documentos emitidos no cambian.
