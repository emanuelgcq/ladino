import { describe, expect, it } from "vitest";
import {
  REPORTES,
  reportesVisibles,
  rutaDeReporte,
  textoDeCelda,
  textoDeResumen,
  SIN_PERMISO_DE_CIFRA,
  SIN_DATO,
} from "../src/pages/reportes/reporte.js";
import { FALTA_LA_TASA } from "../src/components/deuda.js";

/**
 * LOS REPORTES EN LA WEB (P-07, F-13, H-11): la pantalla no calcula, y `null` nunca se lee «0».
 */
const VENTAS = { report: "sales", currency: "VES" } as const;
const CARTERA = { report: "receivables", currency: "VES" } as const;

const rol = (permisos: string[]) => (p: string | readonly string[]) =>
  (typeof p === "string" ? [p] : p).some((x) => permisos.includes(x));

describe("cómo se lee una celda del servidor", () => {
  it("viste el dinero con su moneda, la de la columna si la trae", () => {
    expect(textoDeCelda("1234.50", { kind: "money" }, VENTAS)).toContain("1.234,50");
    const enDolares = textoDeCelda("10.00", { kind: "money", currency: "USD" }, VENTAS);
    expect(enDolares).toContain("10,00");
    expect(enDolares).not.toBe(textoDeCelda("10.00", { kind: "money" }, VENTAS));
  });

  it("cantidades y porcentajes con coma, fechas día/mes/año, sin tocar la cifra", () => {
    expect(textoDeCelda("2.50000000", { kind: "quantity" }, VENTAS)).toBe("2,5");
    expect(textoDeCelda("33.33", { kind: "percent" }, VENTAS)).toBe("33,33 %");
    expect(textoDeCelda("2026-09-24", { kind: "date" }, VENTAS)).toBe("24/09/2026");
    expect(textoDeCelda("12", { kind: "integer" }, VENTAS)).toBe("12");
  });

  it("null no es cero: en una cartera dice que falta la tasa; en otro reporte, una raya", () => {
    expect(textoDeCelda(null, { kind: "money" }, CARTERA)).toBe(FALTA_LA_TASA);
    expect(textoDeCelda(null, { kind: "money" }, { report: "payables", currency: "VES" })).toBe(
      FALTA_LA_TASA,
    );
    expect(textoDeCelda(null, { kind: "money" }, VENTAS)).toBe("—");
    expect(textoDeCelda(null, { kind: "text" }, VENTAS)).toBe("");
    for (const t of [VENTAS, CARTERA]) {
      expect(textoDeCelda(null, { kind: "money" }, t)).not.toMatch(/0/);
    }
  });

  it("una línea del resumen sin cifra dice POR QUÉ", () => {
    const linea = (reason: "sin_tasa" | "sin_permiso" | "sin_dato") =>
      textoDeResumen({ key: "k", label: "L", kind: "money", value: null, reason }, VENTAS);
    expect(linea("sin_tasa")).toBe(FALTA_LA_TASA);
    expect(linea("sin_permiso")).toBe(SIN_PERMISO_DE_CIFRA);
    expect(linea("sin_dato")).toBe(SIN_DATO);
  });
});

describe("qué reportes ve cada oficio (los mismos permisos que exige el servidor)", () => {
  const claves = (permisos: string[], conFacturas = true) =>
    reportesVisibles(rol(permisos), conFacturas).map((r) => r.clave);

  it("el orden del catálogo es el que fijó el dueño", () => {
    expect(REPORTES.map((r) => r.clave)).toEqual([
      "sales",
      "margin",
      "iva",
      "inventory",
      "receivables",
      "payables",
      "cash-closings",
      "igtf",
    ]);
  });

  it("el cajero solo ve quién debe; el almacén, solo el inventario", () => {
    expect(claves(["ar.read", "sales.invoice.issue"])).toEqual(["receivables"]);
    expect(claves(["inventory.move", "inventory.adjust"])).toEqual(["inventory"]);
    expect(claves([])).toEqual([]);
  });

  it("el contador ve el IVA y el IGTF; sin RIF no existen para nadie", () => {
    const contador = ["accounting.read", "ap.read", "ar.read", "fiscal_book.read"];
    expect(claves(contador)).toEqual([
      "sales",
      "margin",
      "iva",
      "inventory",
      "receivables",
      "payables",
      "igtf",
    ]);
    expect(claves(contador, false)).not.toContain("iva");
    expect(claves(contador, false)).not.toContain("igtf");
  });
});

describe("la ruta del servidor", () => {
  const ventas = REPORTES[0]!;
  const cartera = REPORTES.find((r) => r.clave === "receivables")!;

  it("un reporte con rango lleva sus dos días; la cartera, no", () => {
    expect(rutaDeReporte(ventas, { from: "2026-09-01", to: "2026-09-24", group: "product" })).toBe(
      "/v1/reports/sales?from=2026-09-01&to=2026-09-24&group=product",
    );
    expect(rutaDeReporte(cartera, { from: "2026-09-01", to: "2026-09-24" })).toBe(
      "/v1/reports/receivables",
    );
    expect(rutaDeReporte(cartera, { sort: "overdue_desc", page: 2, perPage: 100 })).toBe(
      "/v1/reports/receivables?sort=overdue_desc&page=2&per_page=100",
    );
  });

  it("la descarga pide todas las filas: sin página", () => {
    expect(
      rutaDeReporte(ventas, { from: "2026-09-01", to: "2026-09-24", page: 3, format: "csv" }),
    ).toBe("/v1/reports/sales?from=2026-09-01&to=2026-09-24&format=csv");
  });
});
