import { describe, expect, it } from "vitest";
import { leerNumeroDeclarado, interpretarFilasProductos } from "../src/index.js";

/**
 * El lector de números con formato DECLARADO (ADR-0074, C-01). Puro: la tabla entera de casos
 * que el lector viejo resolvía «por su cuenta» y que ahora tienen una respuesta escrita.
 */
describe("leerNumeroDeclarado (C-01)", () => {
  const casos: [string, "comma_decimal" | "dot_decimal", string | "AMBIGUO" | "ILEGIBLE"][] = [
    ["0,500", "comma_decimal", "0.5"],
    ["0.500", "comma_decimal", "AMBIGUO"], // el hallazgo: el lector viejo daba 500
    ["0.125", "comma_decimal", "AMBIGUO"],
    ["1.234,56", "comma_decimal", "1234.56"],
    ["2.500", "comma_decimal", "2500"], // el formato declarado decide: punto = miles
    ["2,50", "comma_decimal", "2.5"],
    ["40", "comma_decimal", "40"],
    ["0.90", "comma_decimal", "0.9"], // una sola lectura posible: entra, con aviso
    ["1 234,50", "comma_decimal", "1234.5"],
    ["tres", "comma_decimal", "ILEGIBLE"],
    ["0.500", "dot_decimal", "0.5"],
    ["0,500", "dot_decimal", "AMBIGUO"],
    ["1,234.56", "dot_decimal", "1234.56"],
    ["1,500", "dot_decimal", "1500"],
    ["12345678901234567", "dot_decimal", "ILEGIBLE"], // 17 enteros: más que numeric(24,8)
  ];
  for (const [crudo, formato, esperado] of casos) {
    it(`«${crudo}» con ${formato} → ${esperado}`, () => {
      const r = leerNumeroDeclarado(crudo, formato);
      if (esperado === "AMBIGUO") {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.motivo).toContain("ambiguo");
      } else if (esperado === "ILEGIBLE") {
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.motivo).not.toContain("ambiguo");
      } else {
        expect(r).toMatchObject({ ok: true, value: esperado });
      }
    });
  }

  it("la lectura con el formato contrario entra con AVISO, nunca en silencio", () => {
    const r = leerNumeroDeclarado("0.90", "comma_decimal");
    expect(r.ok && r.aviso).toContain("punto decimal");
    const limpio = leerNumeroDeclarado("0,90", "comma_decimal");
    expect(limpio.ok && limpio.aviso).toBeFalsy();
  });
});

describe("interpretarFilasProductos (C-05: nada en silencio)", () => {
  it("servicio con existencia: aviso y sin inventario; costo sin existencia: costo de referencia", () => {
    const r = interpretarFilasProductos(
      [
        ["Nombre", "Precio", "Existencia", "Costo", "Es servicio"],
        ["Transporte", "50,00", "10", "", "sí"],
        ["Tornillo", "1,00", "", "0,40", "no"],
        ["", "", "", "", ""],
        ["Arandela", "0.500", "1", "0.125", "no"],
      ],
      "comma_decimal",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [servicio, tornillo, arandela] = r.value.filas;
    expect(servicio).toMatchObject({ row: 2, status: "ready", initial_stock: null });
    expect(servicio!.warnings.join(" ")).toContain("se ignora");
    expect(tornillo).toMatchObject({
      row: 3,
      status: "ready",
      reference_cost: { amount: "0.4", currency: "USD" },
    });
    // La fila vacía se salta, pero la numeración sigue la del archivo.
    expect(arandela).toMatchObject({ row: 5, status: "rejected" });
    expect(arandela!.message).toContain("ambiguo");
  });
});

describe("interpretarFilasProductos — la revisión (H1-a, H6)", () => {
  it("H1-a: los largos de la base se dicen antes de intentarlo, con fila y motivo", () => {
    const r = interpretarFilasProductos(
      [
        ["Nombre", "Precio", "Código", "Código de barras", "Categoría"],
        ["N".repeat(201), "1", "", "", ""],
        ["Código largo", "1", "C".repeat(61), "", ""],
        ["Barras largas", "1", "", "7".repeat(65), ""],
        ["Categoría larga", "1", "", "", "K".repeat(101)],
        ["Justo", "1", "C".repeat(60), "7".repeat(64), "K".repeat(100)],
      ],
      "comma_decimal",
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const [n, c, b, k, justo] = r.value.filas;
    expect(n).toMatchObject({ row: 2, status: "rejected" });
    expect(n!.message).toContain("máximo es 200");
    expect(c!.message).toContain("máximo es 60");
    expect(b!.message).toContain("máximo es 64");
    expect(k!.message).toContain("máximo es 100");
    expect(justo).toMatchObject({ row: 6, status: "ready" });
  });

  it("H6: una celda de punto decimal vuelve ambigua «1.250» con coma decimal; sin ella, «1.250» es 1250", () => {
    const incoherente = interpretarFilasProductos(
      [
        ["Nombre", "Precio"],
        ["Punto", "12.5"],
        ["Miles", "1.250"],
        ["Sin miles", "1.234,56"],
      ],
      "comma_decimal",
    );
    expect(incoherente.ok).toBe(true);
    if (!incoherente.ok) return;
    expect(incoherente.value.formatoSospechoso).toBe("dot_decimal");
    const [punto, miles, sinMiles] = incoherente.value.filas;
    expect(punto).toMatchObject({ status: "ready", price: { amount: "12.5" } });
    expect(miles).toMatchObject({ status: "rejected" });
    expect(miles!.message).toContain("ambiguo");
    // «1.234,56» no tiene otra lectura: no es ambiguo aunque el archivo sea sospechoso.
    expect(sinMiles).toMatchObject({ status: "ready", price: { amount: "1234.56" } });

    const coherente = interpretarFilasProductos(
      [
        ["Nombre", "Precio"],
        ["Miles", "1.250"],
      ],
      "comma_decimal",
    );
    expect(coherente.ok && coherente.value.formatoSospechoso).toBe(null);
    expect(coherente.ok && coherente.value.filas[0]).toMatchObject({ price: { amount: "1250" } });
  });
});
