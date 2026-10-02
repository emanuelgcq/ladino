/**
 * H10 (ADR-0071, decidido por criterio): el 409 FISCAL_NUMBERING_INVALID trae `details.reason`, y
 * la salida que se ofrece depende de él y del permiso de quien lo lee. Sin el permiso, a quién
 * pedírselo: un enlace a una pantalla que no puede usar no es una salida (E-17).
 * Puro: sin React, para poder probarlo.
 */
export interface SalidaNumeracion {
  /** El texto del enlace, o null si la persona no puede hacerlo ella misma. */
  readonly enlace: { readonly to: string; readonly texto: string } | null;
  /** «Pídeselo a quien administra» cuando no tiene el permiso. */
  readonly pedirlo: boolean;
}

const SALIDAS: Readonly<Record<string, { to: string; texto: string; permiso: string }>> = {
  regime_missing: {
    to: "/empezar",
    texto: "Completa la puesta a punto fiscal",
    permiso: "fiscal.regime.manage",
  },
  no_range: {
    to: "/admin/facturacion-fiscal",
    texto: "Carga el talonario",
    permiso: "fiscal.range.manage",
  },
  printer_data_incomplete: {
    to: "/admin/facturacion-fiscal",
    texto: "Completa los datos de la imprenta",
    permiso: "fiscal.range.manage",
  },
};
const POR_OMISION = {
  to: "/admin/facturacion-fiscal",
  texto: "Ir a la puesta a punto fiscal",
  permiso: "fiscal.range.manage",
};

/** Lee `details.reason` del cuerpo del error (si no viene, la salida genérica). */
export function motivoDeNumeracion(details: unknown): string | null {
  if (typeof details !== "object" || details === null) return null;
  const r = (details as { reason?: unknown }).reason;
  return typeof r === "string" ? r : null;
}

export function salidaDeNumeracion(
  motivo: string | null,
  puede: (permiso: string) => boolean,
): SalidaNumeracion {
  const s = (motivo === null ? undefined : SALIDAS[motivo]) ?? POR_OMISION;
  return puede(s.permiso)
    ? { enlace: { to: s.to, texto: s.texto }, pedirlo: false }
    : { enlace: null, pedirlo: true };
}
