import { describe, expect, it } from "vitest";
import { cantidadTexto, leerCantidad } from "../src/pos-cuentas.js";

/**
 * LA CANTIDAD DECIMAL DE LA CAJA (plan «Ladino sin RIF», A13). La API acepta hasta
 * 8 decimales como texto; la caja no puede mandarle «1e-7» ni colas de coma
 * flotante, y la persona escribe con coma.
 */
describe("cantidad de la caja", () => {
  it("se serializa como decimal limpio, sin notación científica ni ceros de más", () => {
    expect(cantidadTexto(2)).toBe("2");
    expect(cantidadTexto(0.5)).toBe("0.5");
    expect(cantidadTexto(0.0000001)).toBe("0.0000001");
    expect(cantidadTexto(0.1 + 0.2)).toBe("0.3");
    expect(cantidadTexto(1.45 + 1)).toBe("2.45");
  });

  it("se lee con coma o punto y rechaza lo que la API rechazaría", () => {
    expect(leerCantidad("0,5")).toBe(0.5);
    expect(leerCantidad(" 2 ")).toBe(2);
    expect(leerCantidad("1.123456789")).toBeNull();
    expect(leerCantidad("-1")).toBeNull();
    expect(leerCantidad("abc")).toBeNull();
    expect(leerCantidad("")).toBeNull();
  });
});
