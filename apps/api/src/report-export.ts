import type { ReportColumn, ReportTable } from "@ladino/schemas";

/**
 * LA DESCARGA DE UN REPORTE (P-07): CSV y Excel, generados en el SERVIDOR desde la misma tabla
 * que se sirvió en pantalla.
 *
 * Formato de Venezuela, pensado para que Excel en español lo abra sin preguntar:
 *   · CSV con `;` de separador, BOM de UTF-8 y \r\n;
 *   · la coma es el decimal y no hay separador de miles («1234,56»): una hoja de cálculo lo suma;
 *   · las fechas, día/mes/año.
 *
 * Ningún importe pasa por `number` (CLAUDE.md §1.7): cada celda es el TEXTO que calculó Postgres,
 * con el punto cambiado por coma. En el .xlsx las celdas son texto por eso mismo: un `double` de
 * Excel no guarda un `numeric(24,8)`.
 *
 * `null` no es cero: una celda de dinero sin valor dice por qué («Falta la tasa de hoy»).
 */

const SIN_TASA = "Falta la tasa de hoy";

/** Lo que se escribe cuando una cifra de dinero viene en `null`, según el reporte. */
function textoDeNulo(reporte: ReportTable["report"]): string {
  return reporte === "receivables" || reporte === "payables" ? SIN_TASA : "";
}

function celda(valor: string | null | undefined, col: ReportColumn, nulo: string): string {
  if (valor === null || valor === undefined) {
    return col.kind === "money" ? nulo : "";
  }
  switch (col.kind) {
    case "money":
    case "quantity":
    case "percent":
      return valor.replace(".", ",");
    case "date": {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor);
      return m ? `${m[3]}/${m[2]}/${m[1]}` : valor;
    }
    default:
      return valor;
  }
}

/** La tabla como matriz de textos: títulos, filas y, si hay algo que sumar, el renglón «Total». */
export function matrizDeReporte(t: ReportTable): string[][] {
  const nulo = textoDeNulo(t.report);
  const titulos = t.columns.map((c) => c.label);
  const filas = t.rows.map((f) => t.columns.map((c) => celda(f[c.key], c, nulo)));
  const matriz = [titulos, ...filas];
  if (Object.keys(t.totals).length > 0) {
    matriz.push(
      t.columns.map((c, i) => {
        if (c.key in t.totals) return celda(t.totals[c.key], c, nulo);
        return i === 0 ? "Total" : "";
      }),
    );
  }
  return matriz;
}

export function escaparCsv(v: string): string {
  // Una celda que empieza por = + - @, por un tabulador o por un retorno de carro la ejecuta una
  // hoja de cálculo como fórmula: se le antepone un apóstrofo.
  // Los importes negativos («-12,50») son la excepción: son cifras, no fórmulas.
  const peligrosa = /^[=+@\t\r]/.test(v) || (/^-/.test(v) && !/^-\d[\d,]*$/.test(v));
  const texto = peligrosa ? `'${v}` : v;
  return /[";\r\n]/.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

export function csvDeReporte(t: ReportTable): Uint8Array {
  const cuerpo = matrizDeReporte(t)
    .map((fila) => fila.map(escaparCsv).join(";"))
    .join("\r\n");
  // BOM de UTF-8 (U+FEFF) por su código: escrito tal cual es un espacio invisible en el fuente.
  const FIN = "\r\n";
  return new TextEncoder().encode(String.fromCharCode(0xfeff) + cuerpo + FIN);
}

function periodo(t: ReportTable): string {
  const dia = (d: string): string => celda(d, { key: "", label: "", kind: "date" }, "");
  if (t.from !== null && t.to !== null) return `Del ${dia(t.from)} al ${dia(t.to)}`;
  return `Al ${dia(t.as_of)}`;
}

export async function xlsxDeReporte(t: ReportTable): Promise<Uint8Array> {
  const { Workbook } = await import("exceljs");
  const libro = new Workbook();
  const hoja = libro.addWorksheet(t.title.slice(0, 31));
  const matriz = matrizDeReporte(t);
  matriz.forEach((fila, i) => {
    const r = hoja.addRow(fila);
    if (i === 0 || (i === matriz.length - 1 && Object.keys(t.totals).length > 0)) {
      r.font = { bold: true };
    }
  });
  t.columns.forEach((c, i) => {
    const col = hoja.getColumn(i + 1);
    col.width = c.kind === "text" ? 32 : 18;
    // Todo es texto (ver arriba): los importes se alinean a la derecha para leerse como cifras.
    col.numFmt = "@";
    if (c.kind !== "text" && c.kind !== "date") col.alignment = { horizontal: "right" };
  });
  const resumen = libro.addWorksheet("Resumen");
  resumen.addRow([t.title]).font = { bold: true };
  resumen.addRow([periodo(t)]);
  resumen.addRow([`Moneda: ${t.currency}`]);
  resumen.addRow([]);
  const nulo = textoDeNulo(t.report);
  for (const s of t.summary) {
    const valor =
      s.value === null
        ? s.reason === "sin_permiso"
          ? "Tu rol no ve esta cifra"
          : s.reason === "sin_tasa"
            ? SIN_TASA
            : s.reason === "sin_dato"
              ? "No disponible"
              : nulo
        : celda(s.value, { key: s.key, label: s.label, kind: s.kind }, nulo);
    resumen.addRow([s.label, valor, s.kind === "money" ? (s.currency ?? t.currency) : ""]);
  }
  resumen.addRow([]);
  for (const n of t.notes) resumen.addRow([n]);
  resumen.getColumn(1).width = 60;
  resumen.getColumn(2).width = 22;
  resumen.getColumn(2).numFmt = "@";
  resumen.getColumn(2).alignment = { horizontal: "right" };
  const buffer = await libro.xlsx.writeBuffer();
  return new Uint8Array(buffer);
}

const NOMBRES: Record<ReportTable["report"], string> = {
  sales: "ventas",
  margin: "margen",
  iva: "iva-del-periodo",
  inventory: "inventario-valorizado",
  receivables: "quien-me-debe",
  payables: "que-debo",
  "cash-closings": "cierres-de-caja",
  igtf: "igtf-percibido",
};

export function nombreDeArchivo(t: ReportTable, extension: "csv" | "xlsx"): string {
  const grupo = t.group !== null ? `-${t.group.replace(/_/g, "-")}` : "";
  const rango = t.from !== null && t.to !== null ? `${t.from}_${t.to}` : t.as_of;
  return `${NOMBRES[t.report]}${grupo}-${rango}.${extension}`;
}
