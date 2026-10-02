/**
 * LAS FILAS IMPRESAS DE LA FORMA LIBRE (PA 00071 art. 33; revisión de la auditoría fiscal, A-2,
 * decidido por criterio): el tope de una factura, NC o ND cuenta FILAS IMPRESAS, no líneas. Una
 * sola regla parte el texto en filas, y la usan el dominio (para contar al emitir) y el PDF (para
 * imprimir), así que la estimación del dominio es exacta. Alternativa rechazada: truncar la
 * descripción a una fila — el art. 13 exige la descripción.
 *
 * Puro: sin I/O. Los anchos están medidos para el diseño del PDF (Helvetica 9 pt en una columna de
 * 270 pt para la descripción; Helvetica 10 pt a todo el ancho para el motivo), con margen para
 * texto en mayúsculas: una fila nunca la vuelve a partir pdfkit.
 */

/** Caracteres por fila de la descripción de una línea. */
export const CARACTERES_FILA_DESCRIPCION = 45;
/** Caracteres por fila del motivo de una nota de crédito o de débito. */
export const CARACTERES_FILA_MOTIVO = 75;

/** Parte un texto en filas de como mucho `caracteres`, por palabras; una palabra más larga se corta. */
export function partirEnFilas(texto: string, caracteres: number): string[] {
  const palabras = texto
    .trim()
    .split(/\s+/)
    .filter((p) => p !== "");
  const filas: string[] = [];
  let actual = "";
  for (const palabra of palabras) {
    let resto = palabra;
    while (resto.length > caracteres) {
      if (actual !== "") {
        filas.push(actual);
        actual = "";
      }
      filas.push(resto.slice(0, caracteres));
      resto = resto.slice(caracteres);
    }
    if (actual === "") actual = resto;
    else if (actual.length + 1 + resto.length <= caracteres) actual = `${actual} ${resto}`;
    else {
      filas.push(actual);
      actual = resto;
    }
  }
  if (actual !== "" || filas.length === 0) filas.push(actual);
  return filas;
}

/** Las filas de la descripción de una línea, con la «(E)» de lo exento como se imprime (13.8). */
export function filasDeDescripcion(descripcion: string, exenta: boolean): string[] {
  return partirEnFilas(exenta ? `${descripcion} (E)` : descripcion, CARACTERES_FILA_DESCRIPCION);
}

/** Las filas del motivo de una nota (art. 22), con su rótulo; sin motivo, «Motivo: —». */
export function filasDelMotivo(motivo: string | null): string[] {
  const texto = motivo === null || motivo.trim() === "" ? "—" : motivo.trim();
  return partirEnFilas(`Motivo: ${texto}`, CARACTERES_FILA_MOTIVO);
}
