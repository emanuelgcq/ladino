import { describe, expect, it } from "vitest";
import { formatearDocumento } from "../src/pages/negocio/comunes.js";

/**
 * El vestido del documento de identidad es SOLO presentación: estos casos
 * fijan la tabla y, sobre todo, que lo irreconocible se enseña tal cual —
 * vestir no es corregir, y mucho menos validar (VALIDAR-SENIAT).
 */
describe("formatearDocumento", () => {
  it("cédulas con puntos de miles", () => {
    expect(formatearDocumento("V12345678")).toBe("V-12.345.678");
    expect(formatearDocumento("E84123456")).toBe("E-84.123.456");
    expect(formatearDocumento("V1234")).toBe("V-1.234");
  });

  it("RIF de empresa y gobierno con el último dígito separado", () => {
    expect(formatearDocumento("J401234567")).toBe("J-40123456-7");
    expect(formatearDocumento("G200001234")).toBe("G-20000123-4");
  });

  it("pasaporte plano y minúsculas normalizadas", () => {
    expect(formatearDocumento("PAB123456")).toBe("P-AB123456");
    expect(formatearDocumento("v12345678")).toBe("V-12.345.678");
  });

  it("lo que no tiene la forma se enseña tal cual", () => {
    expect(formatearDocumento("J-40123456-7")).toBe("J-40123456-7");
    expect(formatearDocumento("RIF viejo 123")).toBe("RIF viejo 123");
    expect(formatearDocumento("")).toBe("");
  });
});
