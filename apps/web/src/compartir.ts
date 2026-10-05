/**
 * «COMPARTIR» DEL NAVEGADOR (recorrido 2026-09-24, E-06; ADR-0081).
 *
 * La hoja de compartir NATIVA del teléfono o del equipo (`navigator.share` con el PDF como
 * archivo). No es un botón de ninguna aplicación de mensajería: la persona elige a dónde lo manda.
 * Donde el navegador no comparte archivos, el botón NO SE PINTA: queda el PDF, que ya se abre y
 * se descarga. Sin dependencias, para poder probarlo sin navegador.
 */
interface NavegadorQueComparte {
  share?: (datos: { files?: File[]; title?: string }) => Promise<void>;
  canShare?: (datos: { files?: File[] }) => boolean;
}

function archivoPdf(nombre: string, contenido: BlobPart[] = []): File {
  return new File(contenido, nombre, { type: "application/pdf" });
}

/** ¿Este navegador comparte un PDF como archivo? Si no, no hay botón. */
export function puedeCompartirPdf(
  nav: NavegadorQueComparte | undefined = typeof navigator === "undefined" ? undefined : navigator,
): boolean {
  if (nav === undefined || typeof nav.share !== "function" || typeof nav.canShare !== "function") {
    return false;
  }
  try {
    return nav.canShare({ files: [archivoPdf("documento.pdf")] });
  } catch {
    return false;
  }
}

export type ResultadoDeCompartir = "compartido" | "cancelado" | "no_se_pudo";

/**
 * Abre la hoja de compartir con el PDF. Que la persona la cierre sin elegir (`AbortError`) no es
 * un error: no se avisa de nada.
 */
export async function compartirPdf(
  pdf: Blob,
  nombre: string,
  nav: NavegadorQueComparte | undefined = typeof navigator === "undefined" ? undefined : navigator,
): Promise<ResultadoDeCompartir> {
  if (nav === undefined || typeof nav.share !== "function") return "no_se_pudo";
  try {
    await nav.share({ files: [archivoPdf(nombre, [pdf])], title: nombre });
    return "compartido";
  } catch (e) {
    return e instanceof Error && e.name === "AbortError" ? "cancelado" : "no_se_pudo";
  }
}
