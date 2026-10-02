import { describe, expect, it } from "vitest";
import { motivoDeNumeracion, salidaDeNumeracion } from "../src/pages/ventas/salida-numeracion.js";

/**
 * H10 (ADR-0071): el 409 de numeración trae `details.reason`, y cada motivo tiene su salida;
 * sin el permiso, a quién pedírselo (E-17).
 */
const todo = () => true;
const nada = () => false;

describe("salidaDeNumeracion", () => {
  it("sin régimen: a la puesta a punto, en /empezar", () => {
    expect(salidaDeNumeracion("regime_missing", todo)).toEqual({
      enlace: { to: "/empezar", texto: "Completa la puesta a punto fiscal" },
      pedirlo: false,
    });
  });
  it("sin talonario: cargarlo", () => {
    expect(salidaDeNumeracion("no_range", todo).enlace?.texto).toBe("Carga el talonario");
  });
  it("talonario sin imprenta: completar los datos", () => {
    expect(salidaDeNumeracion("printer_data_incomplete", todo).enlace?.texto).toBe(
      "Completa los datos de la imprenta",
    );
  });
  it("sin el permiso que toca, ningún enlace: «pídeselo a quien administra»", () => {
    for (const m of ["regime_missing", "no_range", "printer_data_incomplete", null]) {
      expect(salidaDeNumeracion(m, nada)).toEqual({ enlace: null, pedirlo: true });
    }
  });
  it("el permiso es el de cada salida: el régimen no se abre con el de talonarios", () => {
    const soloTalonarios = (p: string) => p === "fiscal.range.manage";
    expect(salidaDeNumeracion("regime_missing", soloTalonarios).pedirlo).toBe(true);
    expect(salidaDeNumeracion("no_range", soloTalonarios).pedirlo).toBe(false);
  });
  it("lee el motivo del cuerpo, y sin motivo da la salida genérica", () => {
    expect(motivoDeNumeracion({ reason: "no_range" })).toBe("no_range");
    expect(motivoDeNumeracion(undefined)).toBeNull();
    expect(salidaDeNumeracion(null, todo).enlace?.texto).toBe("Ir a la puesta a punto fiscal");
  });
});
