import { describe, expect, it } from "vitest";
import { extraerPromedio, extraerFecha } from "../src/bcv.js";

/**
 * La extracción trabaja sobre el TEXTO CRUDO: la tasa jamás pasa por un
 * float. Estos casos fijan la tabla, incluida la respuesta real de DolarAPI
 * del 2026-09-02.
 */
const REAL = `{
  "moneda": "USD",
  "fuente": "oficial",
  "nombre": "Dólar",
  "compra": null,
  "venta": null,
  "promedio": 801.1752,
  "fechaActualizacion": "2026-09-02T00:00:00-04:00"
}`;

describe("extraerPromedio", () => {
  it("saca la tasa EXACTA del cuerpo real", () => {
    expect(extraerPromedio(REAL)).toBe("801.1752");
  });

  it("acepta enteros y hasta 8 decimales (numeric(24,8)); NUNCA trunca: con 9 se planta", () => {
    expect(extraerPromedio('{"promedio":45}')).toBe("45");
    expect(extraerPromedio('{"promedio":45.12345678}')).toBe("45.12345678");
    // 9 decimales: truncar sería redondear a escondidas — mejor no reconocer.
    expect(extraerPromedio('{"promedio":45.123456789}')).toBeNull();
    expect(extraerPromedio('{"promedio":0}')).toBeNull();
    expect(extraerPromedio('{"promedio":0.0000}')).toBeNull();
    expect(extraerPromedio('{"promedio":"texto"}')).toBeNull();
    expect(extraerPromedio('{"otra_cosa":45.12}')).toBeNull();
  });
});

describe("extraerFecha", () => {
  it("saca la fecha publicada y el día son sus primeros 10 caracteres", () => {
    const fecha = extraerFecha(REAL);
    expect(fecha).toBe("2026-09-02T00:00:00-04:00");
    expect(fecha!.slice(0, 10)).toBe("2026-09-02");
  });

  it("sin fecha reconocible, null", () => {
    expect(extraerFecha('{"fechaActualizacion":"ayer"}')).toBeNull();
    expect(extraerFecha("{}")).toBeNull();
  });
});
