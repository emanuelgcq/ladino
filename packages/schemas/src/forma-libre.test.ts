import { describe, expect, it } from "vitest";
import {
  CARACTERES_FILA_DESCRIPCION,
  filasDeDescripcion,
  filasDelMotivo,
  partirEnFilas,
} from "./forma-libre.js";

// A-2 (revisión de la auditoría fiscal, decidido por criterio): el tope de la forma libre cuenta
// FILAS IMPRESAS, y el dominio y el PDF parten el texto con ESTA función, así que coinciden.
describe("partirEnFilas — una sola regla para el dominio y el PDF", () => {
  it("parte por palabras sin pasar de N caracteres por fila", () => {
    expect(partirEnFilas("uno dos tres cuatro", 8)).toEqual(["uno dos", "tres", "cuatro"]);
  });
  it("una palabra más larga que la fila se corta en trozos de N", () => {
    expect(partirEnFilas("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
  });
  it("el texto vacío ocupa una fila (la línea existe)", () => {
    expect(partirEnFilas("", 10)).toEqual([""]);
    expect(partirEnFilas("   ", 10)).toEqual([""]);
  });
  it("ninguna fila pasa del ancho", () => {
    const texto =
      "Servicio de mantenimiento preventivo y correctivo de equipos de refrigeración industrial " +
      "con reposición de piezas, calibración de termostatos, limpieza de condensadores y garantía";
    const filas = partirEnFilas(texto, CARACTERES_FILA_DESCRIPCION);
    expect(filas.every((f) => f.length <= CARACTERES_FILA_DESCRIPCION)).toBe(true);
    expect(filas.join(" ")).toBe(texto);
  });
});

describe("filasDeDescripcion y filasDelMotivo", () => {
  it("la «(E)» de lo exento cuenta en la fila, como se imprime", () => {
    const justa = "x".repeat(CARACTERES_FILA_DESCRIPCION);
    expect(filasDeDescripcion(justa, false)).toHaveLength(1);
    expect(filasDeDescripcion(justa, true)).toHaveLength(2);
  });
  it("el motivo lleva su rótulo, y sin motivo es «Motivo: —»", () => {
    expect(filasDelMotivo(null)).toEqual(["Motivo: —"]);
    expect(filasDelMotivo("Devolución")[0]).toBe("Motivo: Devolución");
  });
});
