/**
 * El subpath @ladino/money/format — la única entrada que web, mobile y ui pueden importar
 * (ADR-0021). Recibe y devuelve `MoneyJSON`, nunca `Money`: así el cliente no necesita jamás
 * la entrada raíz, y "solo formateo" deja de ser un comentario en una tabla.
 */
import { describe, expect, it } from "vitest";
import { formatMoney, parseUserInput, readAmountText } from "../src/format.js";
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

  // F-06: el análisis del importe tecleado vive en un solo sitio, y dice por qué no lee.
  it("lee el importe a la venezolana y con punto decimal, sin tocar los decimales", () => {
    const casos: [string, string][] = [
      ["26.003,58", "26003.58"],
      ["1.234.567,89", "1234567.89"],
      ["1,234.56", "1234.56"],
      ["26003,58", "26003.58"],
      ["3337.09", "3337.09"],
      ["1.234.567", "1234567"],
      [" 1 234,5 ", "1234.5"],
      ["0.125", "0.125"],
      ["854.46370000", "854.46370000"],
      // Revisión 3, punto 8: lo que tiene que seguir leyéndose bien.
      ["26003.58", "26003.58"],
      ["1,5", "1.5"],
      ["1.5", "1.5"],
      ["0,5", "0.5"],
      ["0,125", "0.125"],
      ["1,2345", "1.2345"],
      ["1234,567", "1234.567"],
      ["1.234,567", "1234.567"],
      ["1,234,567.89", "1234567.89"],
      ["-1.234,56", "-1234.56"],
    ];
    for (const [texto, esperado] of casos) {
      const r = readAmountText(texto);
      expect(r.ok ? r.value : `rechazado: ${texto}`).toBe(esperado);
    }
  });

  it("dice por qué no lee un importe, en vez de adivinar", () => {
    const casos: [string, string][] = [
      ["", "EMPTY"],
      ["   ", "EMPTY"],
      ["abc", "NOT_A_NUMBER"],
      ["1e5", "NOT_A_NUMBER"],
      [".,", "NOT_A_NUMBER"],
      ["1,2,3", "AMBIGUOUS"],
      ["1.23.456", "AMBIGUOUS"],
      // Veintiséis mil tres, o veintiséis con tres milésimas: no se adivina.
      ["26.003", "AMBIGUOUS"],
      // La regla es SIMÉTRICA (revisión 3, punto 8): con coma se leían 1,234 y 26,003 — mil
      // veces menos para quien teclea a la americana.
      ["1,234", "AMBIGUOUS"],
      ["26,003", "AMBIGUOUS"],
      ["-26,003", "AMBIGUOUS"],
      // Con los dos separadores, los miles van de tres en tres.
      ["12.34,56", "BAD_GROUPING"],
      ["1.2.3,4", "BAD_GROUPING"],
      ["1,23.45", "BAD_GROUPING"],
      // Antes devolvía ok con «1.234567.89», que no es un número.
      ["1.234,567.89", "BAD_GROUPING"],
      ["1.234,5,6", "BAD_GROUPING"],
      // Faltan los decimales: su motivo propio, no «hasta 16 cifras».
      ["5,", "INCOMPLETE"],
      ["5.", "INCOMPLETE"],
      ["1.234,", "INCOMPLETE"],
    ];
    for (const [texto, esperado] of casos) {
      const r = readAmountText(texto);
      expect(r.ok ? `leído: ${r.value}` : r.error).toBe(esperado);
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
