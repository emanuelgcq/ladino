/**
 * Hallazgos de la auditoría de invariantes contables sobre S0.2.
 *
 * El subagente `accounting-invariants` encontró siete defectos que **pasaban toda la suite
 * anterior** y producían registros indefendibles en una inspección. Cada uno tiene aquí su test,
 * porque un defecto arreglado sin test es un defecto que vuelve.
 *
 * El patrón común con el resto del sprint: no fallaban. Simplemente nadie había empujado
 * esa puerta.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { CurrencyCode, RoundingPolicy } from "../src/index.js";
import {
  ExactMoney,
  Money,
  MoneyErrorCode,
  allocate,
  convert,
  invertFxRate,
  isRoundingOf,
  makeFxRate,
  parseDecimal,
  roundForCurrency,
  roundForTax,
  toMonetaryFact,
} from "../src/index.js";
import { arbAmountString, arbRoundingPolicy, must } from "./arbitraries.js";

const TS = "2026-08-07T13:45:00Z";
const SRC = "BCV:tasa-oficial";
const rate = (v: string, from = "USD", to = "VES") =>
  must(makeFxRate({ from, to, rate: v, source: SRC, timestamp: TS }));

describe("H1/H2 — la tasa persistida tiene que caber en numeric(24,8)", () => {
  it("makeFxRate rechaza una tasa con más de 8 decimales", () => {
    // ADR-0013 no distingue entre montos y tasas: numeric(24,8) para las dos cosas.
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.123456789",
      source: SRC,
      timestamp: TS,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.RATE_NOT_PERSISTABLE);
  });

  it("rechaza la tasa minúscula que salía como '1e-41', ilegible por el propio paquete", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: `0.${"0".repeat(40)}1`,
      source: SRC,
      timestamp: TS,
    });
    expect(r.ok).toBe(false);
  });

  it("toMonetaryFact rechaza una tasa derivada: la inversa de 3 no es persistible", () => {
    // El caso que destapó el hallazgo: fx_rate salía con 50 decimales, Postgres lo guardaba
    // truncado a 0.33333333, y recalcular daba 33 millones de VES de diferencia.
    const inv = must(invertFxRate(rate("3")));
    const c = must(convert(must(Money.of("9999999999999999", "VES")), inv));
    const r = toMonetaryFact(c, must(roundForCurrency(c.converted)));

    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.RATE_NOT_PERSISTABLE);
  });

  it("fxRate se emite en forma canónica de 8 decimales, no como toString()", () => {
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const fact = must(toMonetaryFact(c, must(roundForCurrency(c.converted))));
    expect(fact.fxRate).toBe("36.50000000");
  });

  it("el hecho monetario se puede releer con el propio paquete", () => {
    // Si el paquete no puede reparsear lo que emite, Postgres tampoco.
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const fact = must(toMonetaryFact(c, must(roundForCurrency(c.converted))));

    expect(parseDecimal(fact.fxRate).ok).toBe(true);
    expect(Money.of(fact.amountTransactionCurrency, fact.transactionCurrency).ok).toBe(true);
    expect(Money.of(fact.functionalAmount, fact.functionalCurrency).ok).toBe(true);
  });

  it("invariante 9 — el importe funcional se reproduce desde los campos persistidos", () => {
    // Es LA propiedad que faltaba: hasta ahora todo se comprobaba sobre objetos en memoria,
    // nunca sobre el hecho ya proyectado a strings.
    fc.assert(
      fc.property(
        arbAmountString(10n ** 14n),
        fc.constantFrom("36.5", "0.0025", "7", "1", "123.45678901"),
        (amount, r) => {
          const c = must(convert(must(Money.of(amount, "USD")), rate(r)));
          const functional = must(roundForCurrency(c.converted));
          const fact = must(toMonetaryFact(c, functional));

          const original = must(Money.of(fact.amountTransactionCurrency, fact.transactionCurrency));
          const tasa = must(parseDecimal(fact.fxRate));
          const recalculado = must(roundForCurrency(original.multiply(tasa)));

          expect(recalculado.value.toAmountString()).toBe(fact.functionalAmount);
        },
      ),
    );
  });
});

describe("H3 — un RoundedMoney fabricado a mano no abre una entrada lateral", () => {
  const policy: RoundingPolicy = { id: "x", scale: 2, mode: "HALF_EVEN" };

  it("rechaza un value que no es el redondeo de su propio preRound", () => {
    // `RoundedMoney` es una interfaz: cualquiera puede construir uno. Antes, esto producía
    // functionalAmount = "1.00000000" para una conversión de 100 USD × 36.5.
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const falso = { value: must(Money.of("1.00", "VES")), preRound: c.converted, policy };

    const r = toMonetaryFact(c, falso);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.FACT_ROUNDING_MISMATCH);
  });

  it("isRoundingOf acepta lo que sale de roundFor* y rechaza lo fabricado", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 14n), arbRoundingPolicy, (amount, p) => {
        const legitimo = must(roundForTax(must(Money.of(amount, "VES")), p));
        expect(isRoundingOf(legitimo)).toBe(true);
      }),
    );

    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    expect(
      isRoundingOf({ value: must(Money.of("1.00", "VES")), preRound: c.converted, policy }),
    ).toBe(false);
  });
});

describe("H5 — una política de redondeo necesita nombre", () => {
  it("rechaza policy.id vacío, igual que makeFxRate rechaza source vacío", () => {
    const r = roundForTax(must(Money.of("1.005", "VES")), { id: "", scale: 2, mode: "HALF_UP" });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_ROUNDING_POLICY);
  });

  it("rechaza un id que solo son espacios", () => {
    const r = roundForTax(must(Money.of("1.005", "VES")), { id: "   ", scale: 2, mode: "HALF_UP" });
    expect(r.ok).toBe(false);
  });
});

describe("H10 — Roundable es estructural, así que la moneda se valida", () => {
  it("no produce un Money con moneda fuera del registro", () => {
    // Antes devolvía ok y publicaba {"amount":"1.01000000","currency":"XYZ"}.
    const r = roundForTax(
      { amount: must(parseDecimal("1.005")), currency: "XYZ" as CurrencyCode },
      { id: "z", scale: 2, mode: "HALF_UP" },
    );
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });

  it("roundForCurrency devuelve Result en vez de lanzar", () => {
    // Su contrato es Result; lanzar lo rompía para el mismo caso.
    const r = roundForCurrency({
      amount: must(parseDecimal("1.005")),
      currency: "XYZ" as CurrencyCode,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });
});

describe("H6 — allocate reparte por mayor resto, no por FIRST_LINE", () => {
  it("con pesos desiguales el sobrante NO cae en la primera línea", () => {
    // El comentario del código afirmaba FIRST_LINE y era falso. Los tests solo usaban pesos
    // iguales, donde mayor-resto degenera en primera línea y el error no se veía.
    const parts = must(
      allocate(
        must(Money.of("0.10", "VES")),
        [must(parseDecimal("1")), must(parseDecimal("2"))],
        2,
      ),
    );
    expect(parts.map((p) => p.toAmountString())).toEqual(["0.03000000", "0.07000000"]);
  });

  it("con pesos no enteros —prorrateo por importe de línea— la suma sigue cuadrando", () => {
    // El caso real de una factura: prorratear por el importe de cada línea, no por enteros.
    fc.assert(
      fc.property(
        fc.array(
          arbAmountString(10n ** 12n).filter((s) => !s.startsWith("-")),
          {
            minLength: 1,
            maxLength: 12,
          },
        ),
        (pesos) => {
          const ws = pesos.map((p) => must(parseDecimal(p)));
          if (ws.every((w) => w.isZero())) return;

          const total = must(Money.of("1234.56", "VES"));
          const parts = must(allocate(total, ws, 2));
          const suma = parts.reduce((acc, p) => must(acc.add(p)), Money.zero(total.currency));

          expect(suma.toAmountString()).toBe(total.toAmountString());
        },
      ),
    );
  });

  it("una línea con peso cero recibe exactamente cero", () => {
    const parts = must(
      allocate(
        must(Money.of("1.00", "VES")),
        [must(parseDecimal("1")), must(parseDecimal("0"))],
        2,
      ),
    );
    expect(parts[1]!.toAmountString()).toBe("0.00000000");
  });

  it("cada parte tiene como mucho `scale` decimales", () => {
    const parts = must(
      allocate(
        must(Money.of("100.00", "VES")),
        [must(parseDecimal("1")), must(parseDecimal("3")), must(parseDecimal("7"))],
        2,
      ),
    );
    for (const p of parts) {
      expect(p.toAmountString().slice(-6)).toBe("000000");
    }
  });
});

describe("simetría de signo en el intermedio de cálculo", () => {
  it("convert(−m) = −convert(m)", () => {
    // La otra mitad del invariante 3: una nota de crédito convertida tiene que ser el reflejo
    // exacto de la factura convertida, y eso ocurre en ExactMoney, no en Money.
    fc.assert(
      fc.property(
        arbAmountString(10n ** 14n),
        fc.constantFrom("36.5", "0.0025", "7", "123.45678901"),
        (amount, r) => {
          const fx = rate(r);
          const m = must(Money.of(amount, "USD"));
          const directo = must(convert(m.negate(), fx)).converted;
          const reflejado = must(convert(m, fx)).converted.negate();
          expect(directo.equals(reflejado)).toBe(true);
        },
      ),
    );
  });

  it("multiply(−m, k) = −multiply(m, k)", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 14n), (amount) => {
        const k = must(parseDecimal("3.7"));
        const m = must(Money.of(amount, "VES"));
        expect(m.negate().multiply(k).equals(m.multiply(k).negate())).toBe(true);
      }),
    );
  });
});

describe("roundFor* sobre ExactMoney, que es la entrada real de producción", () => {
  it("P16/P22 se cumplen también con más de 8 decimales de entrada", () => {
    // Los tests de redondeo generaban solo `Money` (≤8 decimales). Lo que sale de `convert` y
    // `multiply` tiene muchos más, y era justo lo que no se ejercitaba.
    fc.assert(
      fc.property(arbAmountString(10n ** 14n), arbRoundingPolicy, (amount, policy) => {
        const exacto = must(Money.of(amount, "VES")).multiply(
          must(parseDecimal("0.000000123456789")),
        );
        const r = must(roundForTax(exacto, policy));

        const frac = r.value.toAmountString().split(".")[1] ?? "";
        expect(frac.replace(/0+$/, "").length).toBeLessThanOrEqual(policy.scale);
        expect(r.preRound.equals(ExactMoney.from(exacto))).toBe(true);
      }),
    );
  });
});
