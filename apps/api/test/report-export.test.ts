import { describe, expect, it } from "vitest";
import type { ReportTable } from "@ladino/schemas";
import { csvDeReporte, escaparCsv, matrizDeReporte, xlsxDeReporte } from "../src/report-export.js";

/**
 * LA DESCARGA DE UN REPORTE (P-07): lo que el servidor escribe en el CSV y en el Excel.
 *
 * Una celda que empieza por `=`, `+`, `-`, `@`, tabulador o retorno de carro la ejecuta una hoja
 * de cálculo como fórmula: el nombre de un cliente o el motivo de un cierre los escribe una
 * persona, y salen en un archivo que abre otra. Un importe negativo es una cifra, no una fórmula.
 */
const TAB = String.fromCharCode(9);
const CR = String.fromCharCode(13);
const LF = String.fromCharCode(10);

function tabla(rows: Record<string, string | null>[]): ReportTable {
  return {
    report: "cash-closings",
    title: "Cierres de caja",
    from: "2026-09-01",
    to: "2026-09-30",
    as_of: "2026-09-30",
    currency: "VES",
    group: "closing",
    columns: [
      { key: "label", label: "Caja", kind: "text" },
      { key: "difference", label: "Diferencia", kind: "money" },
      { key: "reason", label: "Motivo", kind: "text" },
    ],
    rows,
    totals: { difference: "-12.50" },
    summary: [{ key: "closings", label: "Cierres", kind: "integer", value: "1" }],
    notes: ["Una nota."],
    row_count: rows.length,
    page: 1,
    per_page: rows.length,
  };
}

describe("una celda del CSV nunca se ejecuta como fórmula", () => {
  it("lo que empieza por = + - @, tabulador o retorno de carro lleva un apóstrofo delante", () => {
    expect(escaparCsv("=1+1")).toBe("'=1+1");
    expect(escaparCsv("+1")).toBe("'+1");
    expect(escaparCsv("-Juan")).toBe("'-Juan");
    expect(escaparCsv("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(escaparCsv(`${TAB}=1+1`)).toBe(`'${TAB}=1+1`);
    // Con retorno de carro, además, va entre comillas (lleva un salto dentro).
    expect(escaparCsv(`${CR}=1+1`)).toBe(`"'${CR}=1+1"`);
  });

  it("un importe negativo se queda como cifra", () => {
    expect(escaparCsv("-12,50")).toBe("-12,50");
    expect(escaparCsv("-0,01")).toBe("-0,01");
    expect(escaparCsv("-3")).toBe("-3");
  });

  it("el separador, las comillas y el salto de línea van entre comillas, con la comilla doblada", () => {
    expect(escaparCsv(`Caja; la "chica"${LF}de abajo`)).toBe(`"Caja; la ""chica""${LF}de abajo"`);
    expect(escaparCsv("Caja principal")).toBe("Caja principal");
    expect(escaparCsv("")).toBe("");
  });

  it("el archivo entero: el motivo hostil sale neutralizado y el total negativo, como cifra", () => {
    const t = tabla([{ label: "Caja", difference: "-12.50", reason: "=HYPERLINK(1)" }]);
    const lineas = new TextDecoder().decode(csvDeReporte(t).slice(3)).split(`${CR}${LF}`);
    expect(lineas[0]).toBe("Caja;Diferencia;Motivo");
    expect(lineas[1]).toBe("Caja;-12,50;'=HYPERLINK(1)");
    expect(lineas[2]).toBe("Total;-12,50;");
  });
});

describe("el Excel lleva texto, no números", () => {
  it("toda celda de la hoja es texto y toda columna tiene formato de texto", async () => {
    const t = tabla([{ label: "Caja", difference: "-12.50", reason: null }]);
    const { Workbook } = await import("exceljs");
    const libro = new Workbook();
    await libro.xlsx.load((await xlsxDeReporte(t)).buffer as ArrayBuffer);
    const hoja = libro.worksheets[0]!;
    expect(hoja.rowCount).toBe(matrizDeReporte(t).length);
    hoja.eachRow((fila) => {
      fila.eachCell({ includeEmpty: false }, (celda) => {
        expect(typeof celda.value, `${celda.address}`).toBe("string");
      });
    });
    for (let i = 1; i <= t.columns.length; i++) expect(hoja.getColumn(i).numFmt).toBe("@");
    expect(hoja.getRow(2).getCell(2).value).toBe("-12,50");
    // El resumen también: la cifra, como texto.
    const resumen = libro.worksheets[1]!;
    expect(resumen.getColumn(2).numFmt).toBe("@");
    expect(resumen.getRow(5).getCell(2).value).toBe("1");
  });
});
