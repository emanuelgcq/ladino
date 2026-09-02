import { describe, expect, it } from "vitest";
import { porcentajeAFraccion, fraccionAPorcentaje } from "../src/pages/negocio/comunes.js";

/**
 * Los dos conversores del asistente mueven la coma sobre STRINGS: ni un
 * float toca la alícuota que la persona acepta. Estos casos fijan la tabla.
 */
describe("porcentajeAFraccion", () => {
  it("convierte los casos de la vida real", () => {
    expect(porcentajeAFraccion("16")).toBe("0.16");
    expect(porcentajeAFraccion("8")).toBe("0.08");
    expect(porcentajeAFraccion("12,5")).toBe("0.125");
    expect(porcentajeAFraccion("8.25")).toBe("0.0825");
    expect(porcentajeAFraccion("10")).toBe("0.1");
    expect(porcentajeAFraccion("0")).toBe("0");
  });

  it("rechaza lo que no es un porcentaje", () => {
    expect(porcentajeAFraccion("")).toBeNull();
    expect(porcentajeAFraccion("dieciséis")).toBeNull();
    expect(porcentajeAFraccion("100")).toBeNull();
    expect(porcentajeAFraccion("-5")).toBeNull();
    expect(porcentajeAFraccion("16%")).toBeNull();
    expect(porcentajeAFraccion("1.234")).toBeNull();
  });
});

describe("fraccionAPorcentaje", () => {
  it("deshace la conversión, con la cola de ceros del numeric", () => {
    expect(fraccionAPorcentaje("0.16000000")).toBe("16");
    expect(fraccionAPorcentaje("0.16")).toBe("16");
    expect(fraccionAPorcentaje("0.08")).toBe("8");
    expect(fraccionAPorcentaje("0.125")).toBe("12,5");
    expect(fraccionAPorcentaje("0.08250000")).toBe("8,25");
    expect(fraccionAPorcentaje("0.1")).toBe("10");
    expect(fraccionAPorcentaje("0")).toBe("0");
  });

  it("ida y vuelta: lo que la persona escribe es lo que vuelve a leer", () => {
    for (const p of ["16", "8", "10", "12,5", "8,25"]) {
      const fraccion = porcentajeAFraccion(p);
      expect(fraccion).not.toBeNull();
      expect(fraccionAPorcentaje(fraccion!)).toBe(p);
    }
  });
});
