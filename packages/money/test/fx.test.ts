/**
 * P24–P28 — Conversión FX.
 *
 * P25 (linealidad) es la que obliga a que `convert` NO redondee por dentro. Si redondeara,
 * convertir línea a línea daría un total distinto que convertir el total, y el diferencial
 * cambiario dejaría de cuadrar contra la tasa congelada (ADR-0020, invariante 9 de
 * ACCOUNTING_INVARIANTS_TESTS.md).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  Money,
  MoneyErrorCode,
  convert,
  invertFxRate,
  makeFxRate,
  toMonetaryFact,
} from "../src/index.js";
import { arbAmountString, arbCurrency, must, stringToScaled } from "./arbitraries.js";

const TIMESTAMP = "2026-08-07T13:45:00Z";
const SOURCE = "BCV:tasa-oficial";

const rate = (value: string, from = "USD", to = "VES") =>
  must(makeFxRate({ from, to, rate: value, source: SOURCE, timestamp: TIMESTAMP }));

/**
 * Tolerancia de la ida y vuelta (P26), DECLARADA, no descubierta ajustando hasta que pase.
 *
 * Razón: `convert` multiplica por la tasa sin redondear, y la inversa multiplica por 1/r, que
 * no es exacta en base 10 salvo que r sea potencia de 10. El error relativo queda acotado por
 * la precisión del clon de Decimal (50 dígitos significativos). Sobre un importe de hasta 10^16
 * eso deja el error muy por debajo de una unidad de 10^-8. Se permite 1 unidad mínima de holgura
 * para el caso peor.
 *
 * Si al implementar hiciera falta subir la precisión del clon, se sube la precisión y se
 * documenta aquí el porqué. NO se relaja esta constante.
 */
const FX_ROUNDTRIP_TOLERANCE_UNITS = 1n;

describe("P24 — identidad", () => {
  it("tasa 1 con from = to devuelve el mismo importe", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 20n), arbCurrency, (amount, currency) => {
        const m = must(Money.of(amount, currency));
        const c = must(convert(m, rate("1", currency, currency)));
        expect(c.converted.equals(m)).toBe(true);
        expect(c.original.equals(m)).toBe(true);
      }),
    );
  });
});

describe("P25 — linealidad: convert no redondea por dentro", () => {
  it("convert(a + b) = convert(a) + convert(b)", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(10n ** 18n), arbAmountString(10n ** 18n)),
        fc.constantFrom("36.5", "0.0025", "1", "123.45678901", "7"),
        ([x, y], r) => {
          const fx = rate(r);
          const a = must(Money.of(x, "USD"));
          const b = must(Money.of(y, "USD"));

          const juntos = must(convert(must(a.add(b)), fx)).converted;
          const porSeparado = must(
            must(convert(a, fx)).converted.add(must(convert(b, fx)).converted),
          );

          expect(juntos.toAmountString()).toBe(porSeparado.toAmountString());
        },
      ),
    );
  });

  it("convertir 100 líneas y sumar da lo mismo que sumar y convertir", () => {
    fc.assert(
      fc.property(
        fc.array(arbAmountString(10n ** 12n), { minLength: 2, maxLength: 100 }),
        (amounts) => {
          const fx = rate("36.51234567");
          const lines = amounts.map((a) => must(Money.of(a, "USD")));

          const total = lines.reduce((acc, m) => must(acc.add(m)), Money.zero(lines[0]!.currency));
          const convertidoDelTotal = must(convert(total, fx)).converted;

          const sumaDeConvertidos = lines
            .map((m) => must(convert(m, fx)).converted)
            .reduce((acc, m) => must(acc.add(m)), Money.zero(convertidoDelTotal.currency));

          expect(convertidoDelTotal.toAmountString()).toBe(sumaDeConvertidos.toAmountString());
        },
      ),
    );
  });
});

describe("P26 — ida y vuelta dentro de la tolerancia declarada", () => {
  it("convert(convert(m, r), r⁻¹) recupera m", () => {
    fc.assert(
      fc.property(
        arbAmountString(10n ** 16n),
        fc.constantFrom("36.5", "0.0025", "123.45678901", "7", "1"),
        (amount, r) => {
          const fx = rate(r);
          const m = must(Money.of(amount, "USD"));
          const ida = must(convert(m, fx)).converted;
          const vuelta = must(convert(ida, must(invertFxRate(fx)))).converted;

          const delta =
            stringToScaled(vuelta.toAmountString()) - stringToScaled(m.toAmountString());
          const abs = delta < 0n ? -delta : delta;
          expect(abs).toBeLessThanOrEqual(FX_ROUNDTRIP_TOLERANCE_UNITS);
        },
      ),
    );
  });

  it("la inversa conserva source y timestamp: la trazabilidad no se pierde al invertir", () => {
    const fx = rate("36.5");
    const inv = must(invertFxRate(fx));
    expect(inv.source).toBe(SOURCE);
    expect(inv.timestamp).toBe(TIMESTAMP);
    expect(inv.from).toBe("VES");
    expect(inv.to).toBe("USD");
  });
});

describe("P27 — trazabilidad estructural: los 7 campos de ADR-0020", () => {
  it("FxConversion expone original, converted y la tasa completa", () => {
    const fx = rate("36.5");
    const c = must(convert(must(Money.of("100", "USD")), fx));

    expect(c.original.toAmountString()).toBe("100.00000000");
    expect(c.original.currency).toBe("USD");
    expect(c.converted.currency).toBe("VES");
    expect(c.rate.source).toBe(SOURCE);
    expect(c.rate.timestamp).toBe(TIMESTAMP);
  });

  it("toMonetaryFact proyecta exactamente los 7 campos, todos string", () => {
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const fact = toMonetaryFact(c);

    expect(Object.keys(fact).sort()).toEqual(
      [
        "amountTransactionCurrency",
        "functionalAmount",
        "functionalCurrency",
        "fxRate",
        "rateSource",
        "rateTimestamp",
        "transactionCurrency",
      ].sort(),
    );
    Object.values(fact).forEach((v) => expect(typeof v).toBe("string"));
    expect(fact.amountTransactionCurrency).toBe("100.00000000");
    expect(fact.transactionCurrency).toBe("USD");
    expect(fact.functionalCurrency).toBe("VES");
    expect(fact.rateSource).toBe(SOURCE);
    expect(fact.rateTimestamp).toBe(TIMESTAMP);
  });

  it("makeFxRate rechaza una tasa sin fuente", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.5",
      source: "",
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_SOURCE);
  });

  it("makeFxRate rechaza una fuente que solo es espacios en blanco", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.5",
      source: "   ",
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_SOURCE);
  });

  it("makeFxRate rechaza timestamps que no son ISO-8601 UTC", () => {
    for (const ts of ["2026-08-07", "2026-08-07T13:45:00+04:00", "ayer", ""]) {
      const r = makeFxRate({ from: "USD", to: "VES", rate: "36.5", source: SOURCE, timestamp: ts });
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_TIMESTAMP);
    }
  });

  it("makeFxRate rechaza tasas no positivas y no numéricas", () => {
    for (const value of ["0", "-1", "abc", "", "NaN", "Infinity"]) {
      const r = makeFxRate({
        from: "USD",
        to: "VES",
        rate: value,
        source: SOURCE,
        timestamp: TIMESTAMP,
      });
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE);
    }
  });

  it("makeFxRate rechaza monedas fuera del registro", () => {
    const r = makeFxRate({
      from: "XYZ",
      to: "VES",
      rate: "36.5",
      source: SOURCE,
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });
});

describe("P28 — la tasa tiene que corresponder al importe", () => {
  it("convert falla si rate.from ≠ money.currency", () => {
    const r = convert(must(Money.of("100", "VES")), rate("36.5", "USD", "VES"));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.FX_CURRENCY_MISMATCH);
  });

  it("no existe ninguna vía de conversión que no exija { rate, source, timestamp }", () => {
    // Compile-time: si alguien añadiera una sobrecarga de convert con un escalar suelto,
    // este @ts-expect-error dejaría de fallar y el typecheck lo denunciaría.
    // @ts-expect-error convert no acepta una tasa suelta sin fuente ni timestamp
    expect(() => convert(must(Money.of("100", "USD")), "36.5")).toBeDefined();
  });
});
