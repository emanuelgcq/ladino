import { describe, expect, it } from "vitest";
import { Money, parseDecimal } from "@ladino/money";
import { fiscalDeLinea } from "../src/sales.js";

/**
 * E-05 (ADR-0075 §1): el importe FISCAL en bolívares de una línea en divisa.
 *
 *   base_bs = round(base_divisa × tasa, 2) · iva_bs = round(base_bs × alícuota, 2) · total = suma
 *
 * Función pura: no toca la base. Los E2E (`e2e-moneda-diferencial`) comprueban la factura entera;
 * aquí se fija la regla en sí — el ejemplo del hallazgo, el empate half-up y varias alícuotas.
 */
const dec = (v: string) => {
  const r = parseDecimal(v);
  if (!r.ok) throw new Error(`decimal ilegible: ${v}`);
  return r.value;
};
const usd = (v: string) => {
  const m = Money.of(v, "USD");
  if (!m.ok) throw new Error(`importe ilegible: ${v}`);
  return m.value;
};
const linea = (subtotal: string, alicuota: string) => {
  const iva = dec(subtotal).times(dec(alicuota)).toDecimalPlaces(2, 4);
  return {
    subtotal: usd(subtotal),
    total: usd(dec(subtotal).plus(iva).toFixed(2)),
    taxRate: dec(alicuota),
  };
};
const fiscal = (subtotal: string, alicuota: string, tasa: string, moneda = "USD") => {
  const r = fiscalDeLinea(linea(subtotal, alicuota), dec(tasa), moneda, "VES");
  if (!r.sub.ok || !r.tot.ok) throw new Error("fiscalDeLinea falló");
  return { base: r.sub.value.amount.toFixed(2), total: r.tot.value.amount.toFixed(2) };
};

describe("fiscalDeLinea — el importe fiscal en Bs de una línea en divisa (E-05)", () => {
  it("«Brocha»: 4 × 2,40 USD + IVA 16 % a 854,4637 → base 8.202,85 · total 9.515,31 (no 9.518,73)", () => {
    // El total en divisa es 11,14 USD; 11,14 × 854,4637 = 9.518,73. El IVA fiscal sale de la
    // BASE en bolívares: 8.202,85 × 0,16 = 1.312,46 → 9.515,31. La diferencia (3,42) es E-05.
    expect(fiscal("9.60", "0.16", "854.4637")).toEqual({ base: "8202.85", total: "9515.31" });
    expect(dec("11.14").times(dec("854.4637")).toDecimalPlaces(2, 4).toFixed(2)).toBe("9518.73");
  });

  it("el empate va half-up, en la base y en el IVA", () => {
    // Base: 0,50 USD × 40,01 = 20,005 → 20,01 (no 20,00).
    expect(fiscal("0.50", "0", "40.01")).toEqual({ base: "20.01", total: "20.01" });
    // IVA: base 0,50 Bs × 31 % = 0,155 → 0,16 (no 0,15) → total 0,66.
    expect(fiscal("0.50", "0.31", "1")).toEqual({ base: "0.50", total: "0.66" });
  });

  it("varias alícuotas: exento, reducida, general y con adicional", () => {
    // 100,00 USD a 36,4733 → base 3.647,33.
    expect(fiscal("100.00", "0", "36.4733")).toEqual({ base: "3647.33", total: "3647.33" });
    expect(fiscal("100.00", "0.08", "36.4733")).toEqual({ base: "3647.33", total: "3939.12" });
    expect(fiscal("100.00", "0.16", "36.4733")).toEqual({ base: "3647.33", total: "4230.90" });
    expect(fiscal("100.00", "0.31", "36.4733")).toEqual({ base: "3647.33", total: "4778.00" });
  });

  it("un documento que ya nace en la moneda funcional no recalcula nada", () => {
    const m = (v: string) => {
      const x = Money.of(v, "VES");
      if (!x.ok) throw new Error("x");
      return x.value;
    };
    const r = fiscalDeLinea(
      { subtotal: m("100.00"), total: m("116.00"), taxRate: dec("0.16") },
      dec("1"),
      "VES",
      "VES",
    );
    expect(r.sub.ok && r.sub.value.amount.toFixed(2)).toBe("100.00");
    expect(r.tot.ok && r.tot.value.amount.toFixed(2)).toBe("116.00");
  });
});
