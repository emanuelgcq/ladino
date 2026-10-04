import { describe, expect, it } from "vitest";
import {
  cantidadLimpia,
  cantidadValida,
  importeLimpio,
  leerCantidad,
  leerImporte,
  motivoDeCantidad,
  motivoDeImporte,
} from "../src/components/forms.js";
import { cantidadTexto, leerCantidad as leerCantidadDeLaCaja } from "../src/pos-cuentas.js";
import { porcentajeAFraccion } from "../src/pages/negocio/comunes.js";

/**
 * F-06 · EL LECTOR HERMANO: cantidades, tasas y porcentajes.
 *
 * No es dinero: tres decimales son legítimos («1,250 kg»). Pero un punto seguido de exactamente
 * tres cifras sigue siendo ambiguo —¿mil doscientos cincuenta o uno con veinticinco?— y se
 * rechaza diciéndolo, en vez de leer mil veces menos sin hacer ruido.
 */
const leida = (t: string): string | null => {
  const r = leerCantidad(t);
  return r.ok ? r.cantidad : null;
};
const motivo = (t: string): string | null => {
  const r = leerCantidad(t);
  return r.ok ? null : r.motivo;
};

describe("leerCantidad", () => {
  it("una sola coma es el decimal, lleve las cifras que lleve", () => {
    expect(leida("1,250")).toBe("1.250");
    expect(leida("0,5")).toBe("0.5");
    expect(leida("12,345")).toBe("12.345");
    expect(leida("36,500")).toBe("36.500");
    expect(leida("1,5")).toBe("1.5");
    expect(leida("2500,125")).toBe("2500.125");
  });

  it("un solo punto con exactamente tres cifras es ambiguo y se rechaza con su motivo", () => {
    expect(leida("1.250")).toBeNull();
    expect(leida("26.003")).toBeNull();
    expect(leida("125.000")).toBeNull();
    expect(motivo("1.250")).toContain("«1.250» se puede leer de dos maneras");
  });

  it("un punto que no es ambiguo es el decimal", () => {
    expect(leida("1.5")).toBe("1.5");
    expect(leida("0.125")).toBe("0.125");
    expect(leida("1.2345")).toBe("1.2345");
    expect(leida("1250.125")).toBe("1250.125");
    expect(leida("2")).toBe("2");
    expect(leida(" 2 ")).toBe("2");
  });

  it("con los dos separadores, el último es el decimal y los miles van de tres en tres", () => {
    expect(leida("1.250,5")).toBe("1250.5");
    expect(leida("1,250.5")).toBe("1250.5");
    expect(leida("1.234.567,125")).toBe("1234567.125");
    expect(leida("12.34,5")).toBeNull();
    expect(motivo("12.34,5")).toContain("los miles no van de tres en tres");
  });

  it("varios puntos sin coma son miles; varias comas, ambiguo", () => {
    expect(leida("1.000.000")).toBe("1000000");
    expect(leida("1,234,567")).toBeNull();
    expect(leida("1.2.3")).toBeNull();
  });

  it("rechaza lo incompleto, lo negativo, lo que no es un número y lo que la API no acepta", () => {
    expect(motivo("5,")).toContain("le faltan los decimales");
    expect(motivo("-1")).toBe("No puede ser negativo.");
    expect(motivo("-1,5")).not.toBeNull();
    expect(motivo("abc")).toContain("Eso no es un número");
    expect(motivo("")).toBe("Escribe la cantidad.");
    expect(motivo("1,123456789")).toBe("Admite hasta 16 cifras enteras y 8 decimales.");
    expect(leida("1,12345678")).toBe("1.12345678");
  });

  it("los ayudantes: limpia, valida y motivo (vacío no es un error mientras se rellena)", () => {
    expect(cantidadLimpia("1,250")).toBe("1.250");
    expect(cantidadLimpia(" 1.250 ")).toBe("1.250"); // ilegible: tal cual, y no valida
    expect(cantidadValida("1,250")).toBe(true);
    expect(cantidadValida("1.250")).toBe(false);
    expect(motivoDeCantidad("")).toBeNull();
    expect(motivoDeCantidad("  ")).toBeNull();
    expect(motivoDeCantidad("2,5")).toBeNull();
    expect(motivoDeCantidad("1.250")).not.toBeNull();
  });
});

describe("la frontera con el dinero: la misma cifra, dos lectores, dos respuestas", () => {
  it("«1,250» es una cantidad legítima y un importe ambiguo", () => {
    expect(leerCantidad("1,250").ok).toBe(true);
    expect(leerImporte("1,250").ok).toBe(false);
    expect(motivoDeImporte("1,250")).toContain("se puede leer de dos maneras");
  });

  it("«1.500» no se vuelve 1,5 en ninguno de los dos", () => {
    expect(leerCantidad("1.500").ok).toBe(false);
    expect(leerImporte("1.500").ok).toBe(false);
    // Lo ilegible viaja tal cual: quien valida lo rechaza, nadie lo «arregla».
    expect(importeLimpio("1.500")).toBe("1.500");
    expect(leerImporte(importeLimpio("1.500")).ok).toBe(false);
  });

  it("«1.234,56» se lee entero, no como «1.234.56»", () => {
    expect(importeLimpio("1.234,56")).toBe("1234.56");
    expect(importeLimpio("26.003,58")).toBe("26003.58");
    expect(motivoDeImporte("1.234,56")).toBeNull();
    expect(motivoDeImporte("")).toBeNull();
  });
});

describe("los que leen a través del lector único", () => {
  it("la cantidad de la caja: coma decimal sí, punto ambiguo no", () => {
    expect(leerCantidadDeLaCaja("1,250")).toBe(1.25);
    expect(leerCantidadDeLaCaja("0,5")).toBe(0.5);
    expect(leerCantidadDeLaCaja("1.250")).toBeNull();
  });

  it("lo que escribe la máquina (punto decimal) NO es texto tecleado: se enseña con coma", () => {
    // `cantidadTexto(1.125)` es «1.125». Pasado por el lector de lo tecleado sería ambiguo —y el
    // «+» de la caja dejaba la línea en cero—; enseñado con coma, la persona lo relee igual.
    expect(cantidadTexto(1.125)).toBe("1.125");
    expect(leerCantidadDeLaCaja(cantidadTexto(1.125))).toBeNull();
    expect(leerCantidadDeLaCaja(cantidadTexto(1.125).replace(".", ","))).toBe(1.125);
  });

  it("el porcentaje del asistente", () => {
    expect(porcentajeAFraccion("12,5")).toBe("0.125");
    expect(porcentajeAFraccion("8.25")).toBe("0.0825");
    expect(porcentajeAFraccion("1.234")).toBeNull();
  });
});
