/**
 * P11–P14 — Serialización.
 *
 * El contrato de la API es `{ amount, currency }`, nunca un string escalar ni un número
 * (API_SPEC.md §Dinero en el contrato). `toAmountString()` existe solo para persistencia y
 * para la paridad con numeric(24,8).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../src/index.js";
import { MAX_SCALED, arbAmountString, arbCurrency, must, scaledToString } from "./arbitraries.js";

const arbMoney = fc
  .tuple(arbAmountString(MAX_SCALED), arbCurrency)
  .map(([a, c]) => must(Money.of(a, c)));

describe("P11 — ida y vuelta sin pérdida", () => {
  it("Money.of(m.toAmountString(), m.currency) = m", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const again = must(Money.of(m.toAmountString(), m.currency));
        expect(again.equals(m)).toBe(true);
      }),
    );
  });

  it("toJSON → Money.of recupera el mismo valor", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const json = m.toJSON();
        expect(must(Money.of(json.amount, json.currency)).equals(m)).toBe(true);
      }),
    );
  });
});

describe("P12 — canonicidad de la cadena", () => {
  it("siempre exactamente 8 decimales, sin exponente ni separador de miles", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        expect(m.toAmountString()).toMatch(/^-?\d{1,16}\.\d{8}$/);
      }),
    );
  });

  it("normaliza el cero negativo", () => {
    // −0 en un libro contable no significa nada y rompe comparaciones por cadena.
    expect(must(Money.of("-0", "VES")).toAmountString()).toBe("0.00000000");
    expect(must(Money.of("-0.00000000", "VES")).toAmountString()).toBe("0.00000000");
    expect(
      Money.zero(must(Money.of("0", "VES")).currency)
        .negate()
        .toAmountString(),
    ).toBe("0.00000000");
  });

  it("normaliza ceros a la izquierda y decimales cortos", () => {
    expect(must(Money.of("007.5", "VES")).toAmountString()).toBe("7.50000000");
    expect(must(Money.of("0.1", "VES")).toAmountString()).toBe("0.10000000");
    expect(must(Money.of("-3", "VES")).toAmountString()).toBe("-3.00000000");
  });

  it("dos importes iguales tienen la misma cadena canónica", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -MAX_SCALED, max: MAX_SCALED }), (units) => {
        const a = must(Money.of(scaledToString(units), "VES"));
        const b = must(Money.of(scaledToString(units), "VES"));
        expect(a.toAmountString()).toBe(b.toAmountString());
      }),
    );
  });
});

describe("P13 — el JSON nunca contiene un número", () => {
  it("toJSON devuelve { amount: string, currency: string }", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const json = m.toJSON();
        expect(typeof json.amount).toBe("string");
        expect(typeof json.currency).toBe("string");
        expect(Object.keys(json).sort()).toEqual(["amount", "currency"]);
      }),
    );
  });

  it("JSON.stringify no emite ningún literal numérico", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const text = JSON.stringify(m);
        // Recorre el JSON ya parseado: cualquier `number` sería un error de contrato.
        const walk = (node: unknown): void => {
          expect(typeof node).not.toBe("number");
          if (node && typeof node === "object") Object.values(node).forEach(walk);
        };
        walk(JSON.parse(text));
      }),
    );
  });

  it("un importe anidado en un documento sigue serializando como objeto", () => {
    const doc = { total: must(Money.of("1234.56", "VES")), lines: [must(Money.of("1000", "USD"))] };
    expect(JSON.parse(JSON.stringify(doc))).toEqual({
      total: { amount: "1234.56000000", currency: "VES" },
      lines: [{ amount: "1000.00000000", currency: "USD" }],
    });
  });
});

describe("P14 — paridad con numeric(24,8) de Postgres", () => {
  it("la cadena es un literal numeric(24,8) válido: <= 24 dígitos, 8 decimales", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const s = m.toAmountString();
        const digits = s.replace(/[-.]/g, "");
        expect(digits.length).toBeLessThanOrEqual(24);
        expect(s.split(".")[1]).toHaveLength(8);
      }),
    );
  });

  it("toString es diagnóstico y NO es el contrato", () => {
    // Lleva la moneda pegada a propósito: quien lo use en un payload lo notará al parsear.
    expect(must(Money.of("1234.56", "VES")).toString()).toBe("1234.56000000 VES");
  });
});
