/**
 * El subpath @ladino/money/format — la única entrada que web, mobile y ui pueden importar
 * (ADR-0021). Recibe y devuelve `MoneyJSON`, nunca `Money`: así el cliente no necesita jamás
 * la entrada raíz, y "solo formateo" deja de ser un comentario en una tabla.
 */
import { describe, expect, it } from "vitest";
import { formatMoney, parseUserInput } from "../src/format.js";
import { MoneyErrorCode } from "../src/index.js";

const ves = { amount: "1234.56000000", currency: "VES" } as const;

describe("formatMoney", () => {
  it("formatea con los separadores de la moneda y sus minor units", () => {
    const salida = formatMoney(ves, { locale: "es-VE" });
    expect(salida).toContain("1.234,56");
    expect(salida).not.toContain("1234.56000000");
  });

  it("no inventa decimales de más ni de menos", () => {
    expect(formatMoney({ amount: "0.10000000", currency: "USD" }, { locale: "en-US" })).toContain(
      "0.10",
    );
  });

  it("respeta el modo de presentación de la moneda", () => {
    expect(formatMoney(ves, { locale: "es-VE", display: "code" })).toContain("VES");
    expect(formatMoney(ves, { locale: "es-VE", display: "none" })).not.toContain("VES");
  });

  it("formatea negativos sin perder el signo", () => {
    expect(formatMoney({ amount: "-50.00000000", currency: "VES" }, { locale: "es-VE" })).toMatch(
      /-|\(/,
    );
  });

  it("no redondea: un importe con más precisión de la que muestra se rechaza", () => {
    // Formatear NO es redondear. Si la UI quiere 2 decimales, el dominio ya debió redondear
    // con la función nombrada que corresponda (MONEY_AND_ROUNDING_SPEC.md §5).
    //
    // El mensaje se comprueba a propósito: un `toThrow()` a secas pasaría en la fase roja solo
    // porque el stub lanza, y eso sería un verde falso.
    expect(() =>
      formatMoney({ amount: "1.23456789", currency: "VES" }, { locale: "es-VE" }),
    ).toThrow(/redonde|precisi/i);
  });
});

describe("parseUserInput", () => {
  it("acepta lo que un usuario venezolano teclea", () => {
    const r = parseUserInput("1.234,56", "VES");
    expect(r.ok).toBe(true);
    expect(r.ok ? r.value : null).toEqual({ amount: "1234.56000000", currency: "VES" });
  });

  it("acepta formato con punto decimal", () => {
    const r = parseUserInput("1234.56", "USD");
    expect(r.ok ? r.value.amount : null).toBe("1234.56000000");
  });

  it("rechaza basura en vez de adivinar", () => {
    for (const raw of ["", "abc", "1,2,3", "--5", "1e5"]) {
      expect(parseUserInput(raw, "VES").ok).toBe(false);
    }
  });

  it("rechaza una moneda fuera del registro", () => {
    const r = parseUserInput("100", "XYZ");
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });
});

describe("el subpath no expone aritmética", () => {
  it("format no reexporta Money, convert, allocate ni los redondeos", async () => {
    const mod: Record<string, unknown> = await import("../src/format.js");
    for (const prohibido of [
      "Money",
      "convert",
      "allocate",
      "roundForTax",
      "roundForDocument",
      "roundForPayment",
      "roundForCurrency",
      "makeFxRate",
    ]) {
      expect(Object.keys(mod)).not.toContain(prohibido);
    }
  });
});
