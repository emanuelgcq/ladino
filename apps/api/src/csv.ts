/**
 * CSV de importación (orden del dueño, 2026-09-08): la persona descarga la
 * plantilla, la llena en Excel o a mano, y la sube. El parser es deliberadamente
 * tolerante con lo que Excel produce en Venezuela:
 *
 *   · separador `;` o `,` — se DETECTA con la fila de títulos (Excel en
 *     español exporta con punto y coma; en inglés, con coma);
 *   · comillas dobles para campos con el separador adentro, con `""` como
 *     comilla escapada (RFC 4180);
 *   · BOM de UTF-8 al inicio, retornos \r\n o \n;
 *   · los NÚMEROS no se interpretan aquí: cada celda sale como TEXTO y quien
 *     importa decide con el formato DECLARADO (ADR-0074: leerNumeroDeclarado, en el dominio).
 */

import { DominioError } from "./middleware/errors.js";

/** Detecta el separador con la PRIMERA línea: gana el que más celdas produce. */
function detectarSeparador(primeraLinea: string): ";" | "," {
  const cuenta = (sep: string): number => {
    let n = 0;
    let enComillas = false;
    for (const ch of primeraLinea) {
      if (ch === '"') enComillas = !enComillas;
      else if (ch === sep && !enComillas) n++;
    }
    return n;
  };
  return cuenta(";") >= cuenta(",") ? ";" : ",";
}

/** Parsea el CSV entero a una matriz de celdas-texto. Nunca lanza. */
export function parseCsv(texto: string): string[][] {
  const limpio = texto.charCodeAt(0) === 0xfeff ? texto.slice(1) : texto;
  const finPrimera = limpio.indexOf("\n");
  const primera = finPrimera === -1 ? limpio : limpio.slice(0, finPrimera);
  const sep = detectarSeparador(primera.replace(/\r$/, ""));

  const filas: string[][] = [];
  let fila: string[] = [];
  let celda = "";
  let enComillas = false;
  for (let i = 0; i < limpio.length; i++) {
    const ch = limpio[i]!;
    if (enComillas) {
      if (ch === '"') {
        if (limpio[i + 1] === '"') {
          celda += '"';
          i++;
        } else {
          enComillas = false;
        }
      } else {
        celda += ch;
      }
    } else if (ch === '"') {
      enComillas = true;
    } else if (ch === sep) {
      fila.push(celda);
      celda = "";
    } else if (ch === "\n") {
      fila.push(celda.replace(/\r$/, ""));
      filas.push(fila);
      fila = [];
      celda = "";
    } else {
      celda += ch;
    }
  }
  if (celda !== "" || fila.length > 0) {
    fila.push(celda.replace(/\r$/, ""));
    filas.push(fila);
  }
  // Las filas vacías SE CONSERVAN: quien importa las salta, pero el número de
  // fila que se le dice a la persona tiene que coincidir con SU archivo. Solo
  // la cola de filas vacías del final (el \r\n de cierre de Excel) se recorta.
  while (filas.length > 0 && filas[filas.length - 1]!.every((c) => c.trim() === "")) {
    filas.pop();
  }
  return filas;
}

/** ¿El archivo es CSV? Por nombre o porque NO es un zip (xlsx empieza «PK»). */
export function pareceCsv(nombre: string, bytes: Uint8Array): boolean {
  if (/\.csv$/i.test(nombre)) return true;
  if (/\.xlsx?$/i.test(nombre)) return false;
  return !(bytes[0] === 0x50 && bytes[1] === 0x4b);
}

/**
 * El archivo subido (.csv o .xlsx), aplanado a una matriz de celdas-TEXTO:
 * el handler de importación no sabe de dónde vino. Los importes se leen como
 * el texto de la celda, nunca como el float de Excel.
 */
export async function leerMatriz(
  archivo: File,
  formatoNumeros?: "comma_decimal" | "dot_decimal",
): Promise<string[][]> {
  const bytes = new Uint8Array(await archivo.arrayBuffer());
  if (pareceCsv(archivo.name, bytes)) {
    return parseCsv(new TextDecoder("utf-8").decode(bytes));
  }
  const { Workbook } = await import("exceljs");
  const libro = new Workbook();
  await libro.xlsx.load(bytes.buffer).catch(() => {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "Ese archivo no se pudo leer. Manda un .csv o un .xlsx y reintenta.",
    });
  });
  const hoja = libro.worksheets[0];
  if (!hoja) return [];
  const matriz: string[][] = [];
  for (let n = 1; n <= hoja.rowCount; n++) {
    const fila: string[] = [];
    const row = hoja.getRow(n);
    for (let col = 1; col <= hoja.columnCount; col++) {
      const celda = row.getCell(col);
      // Una celda NUMÉRICA de Excel es un número, no un texto con formato: con el formato de
      // números declarado (ADR-0074, C-01) se escribe en ESE formato, para que «0,125» no se lea
      // como 125. String() da la representación más corta que reproduce el número tecleado.
      // Una celda con FÓRMULA (también la compartida) guarda su último resultado en `result`:
      // si es numérico, se trata igual que un número (H7).
      const valor: unknown = celda.value;
      const numero =
        typeof valor === "number"
          ? valor
          : typeof valor === "object" &&
              valor !== null &&
              "result" in valor &&
              typeof (valor as { result?: unknown }).result === "number"
            ? (valor as { result: number }).result
            : null;
      // A3, decidido por criterio: el número que la persona VE en Excel. Excel enseña 15 cifras
      // significativas, así que el ruido binario de una fórmula (19,99 × 1,16 = 23,188399999999998)
      // o de una suma (0,1 + 0,2) se representa con esas 15: «23.1884», «0.3». Alternativa
      // descartada: rechazar la celda con ruido.
      if (formatoNumeros !== undefined && numero !== null) {
        const texto = String(Number(numero.toPrecision(15)));
        fila.push(formatoNumeros === "comma_decimal" ? texto.replace(".", ",") : texto);
      } else {
        fila.push(String(celda.text ?? ""));
      }
    }
    matriz.push(fila);
  }
  return matriz;
}
