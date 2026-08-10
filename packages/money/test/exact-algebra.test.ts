/**
 * P1e–P7e — Álgebra de `ExactMoney`.
 *
 * Ahora hay **dos** álgebras, y esta es la que recorren `multiply` y `convert` por dentro
 * (ADR-0023). Probar solo la de `Money` dejaría sin red justo el camino por el que pasa todo
 * cálculo intermedio: si la suma de `ExactMoney` no fuera asociativa, la linealidad de la
 * conversión FX (P25) sería falsa y no habría forma de saber por qué.
 *
 * El oráculo vuelve a ser BigInt, ahora escalado a 10^-20, porque los intermedios no están
 * capados a 8 decimales.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ExactMoney,
  Money,
  MoneyErrorCode,
  parseCurrency,
  parseDecimal,
  roundForCurrency,
} from "../src/index.js";
import {
  EXACT_SCALE,
  MAX_EXACT_SCALED,
  arbCurrency,
  arbExactAmountString,
  exactUnitsOf,
  must,
  stringToScaled,
} from "./arbitraries.js";

const cur = (code: string) => must(parseCurrency(code));
const exact = (value: string, currency = "VES") =>
  must(ExactMoney.fromDecimal(must(parseDecimal(value)), cur(currency)));

const SAFE = MAX_EXACT_SCALED / 4n;

const arbExact = fc.tuple(arbExactAmountString(SAFE), arbCurrency).map(([a, c]) => exact(a, c));

const arbSameCurrencyPair = fc
  .tuple(arbExactAmountString(SAFE), arbExactAmountString(SAFE), arbCurrency)
  .map(([a, b, c]) => [exact(a, c), exact(b, c)] as const);

describe("P1e — conmutatividad en ExactMoney", () => {
  it("a + b = b + a", () => {
    fc.assert(
      fc.property(arbSameCurrencyPair, ([a, b]) => {
        expect(must(a.add(b)).equals(must(b.add(a)))).toBe(true);
      }),
    );
  });
});

describe("P2e — asociatividad en ExactMoney", () => {
  it("(a + b) + c = a + (b + c)", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbExactAmountString(SAFE),
          arbExactAmountString(SAFE),
          arbExactAmountString(SAFE),
          arbCurrency,
        ),
        ([x, y, z, currency]) => {
          const a = exact(x, currency);
          const b = exact(y, currency);
          const c = exact(z, currency);
          expect(must(must(a.add(b)).add(c)).equals(must(a.add(must(b.add(c)))))).toBe(true);
        },
      ),
    );
  });
});

describe("P3e — elemento neutro en ExactMoney", () => {
  it("a + 0 = a", () => {
    fc.assert(
      fc.property(arbExact, (a) => {
        expect(must(a.add(ExactMoney.zero(a.currency))).equals(a)).toBe(true);
      }),
    );
  });
});

describe("P4e — inverso aditivo en ExactMoney", () => {
  it("a + (−a) = 0", () => {
    fc.assert(
      fc.property(arbExact, (a) => {
        expect(must(a.add(a.negate())).isZero()).toBe(true);
      }),
    );
  });

  it("−(−a) = a", () => {
    fc.assert(
      fc.property(arbExact, (a) => {
        expect(a.negate().negate().equals(a)).toBe(true);
      }),
    );
  });
});

describe("P5e — exactitud contra aritmética entera", () => {
  it("ExactMoney.add == BigInt escalado a 10^-20", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbExactAmountString(SAFE), arbExactAmountString(SAFE), arbCurrency),
        ([x, y, currency]) => {
          const sum = must(exact(x, currency).add(exact(y, currency)));
          expect(exactUnitsOf(sum)).toBe(
            stringToScaled(x, EXACT_SCALE) + stringToScaled(y, EXACT_SCALE),
          );
        },
      ),
    );
  });

  it("no hay cota de magnitud: ExactMoney desborda numeric(24,8) sin quejarse", () => {
    // Es deliberado (ADR-0023). La cota de persistencia se comprueba en roundFor*, no aquí.
    const enorme = must(Money.of("9999999999999999.99999999", "VES")).multiply(
      must(parseDecimal("1000000")),
    );
    expect(enorme.isZero()).toBe(false);
  });
});

describe("P6e — resta definida por la suma", () => {
  it("a − b = a + (−b)", () => {
    fc.assert(
      fc.property(arbSameCurrencyPair, ([a, b]) => {
        expect(must(a.subtract(b)).equals(must(a.add(b.negate())))).toBe(true);
      }),
    );
  });
});

describe("P7e — monedas distintas tampoco se coaccionan en ExactMoney", () => {
  it("add, subtract y compare devuelven CURRENCY_MISMATCH", () => {
    const ves = exact("10.5", "VES");
    const usd = exact("10.5", "USD");

    const sum = ves.add(usd);
    expect(sum.ok).toBe(false);
    expect(sum.ok ? null : sum.error.code).toBe(MoneyErrorCode.CURRENCY_MISMATCH);
    expect(ves.subtract(usd).ok).toBe(false);
    expect(ves.compare(usd).ok).toBe(false);
    expect(ves.equals(usd)).toBe(false);
  });
});

describe("distributividad del escalar — la que sostiene la linealidad de convert", () => {
  it("(a + b) · k = a · k + b · k", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbExactAmountString(SAFE / 16n), arbExactAmountString(SAFE / 16n)),
        fc.constantFrom("36.5", "0.0025", "1", "123.45678901", "7"),
        ([x, y], k) => {
          const factor = must(parseDecimal(k));
          const a = exact(x);
          const b = exact(y);
          expect(
            must(a.add(b))
              .multiply(factor)
              .equals(must(a.multiply(factor).add(b.multiply(factor)))),
          ).toBe(true);
        },
      ),
    );
  });

  it("multiply es total: no devuelve Result y no puede fallar", () => {
    // Money#multiply devuelve ExactMoney directamente; si volviera a ser Result, esto no
    // compilaría y el typecheck lo denunciaría.
    const producto: ExactMoney = must(Money.of("1234.56789", "VES")).multiply(
      must(parseDecimal("0.000000000001")),
    );
    expect(producto.currency).toBe("VES");
  });
});

describe("ADR-0023 — de ExactMoney solo se sale redondeando", () => {
  it("no expone toAmountString: no hay proyección a numeric(24,8)", () => {
    const value: object = exact("1.23456789012345");
    expect("toAmountString" in value).toBe(false);
  });

  it("JSON.stringify no puede publicar un valor sin redondear", () => {
    // Este test encontró un agujero real durante la implementación: NO tener `toJSON` no basta.
    // JSON.stringify enumera las propiedades propias, y `Decimal` trae su propio `toJSON`, así
    // que un ExactMoney "sin serializador" se publicaba igual como
    // {"amount":"1.23456789012345","currency":"VES"}.
    //
    // Ausencia de mecanismo no es prohibición. Ahora falla en voz alta.
    expect(() => JSON.stringify({ total: exact("1.23456789012345") })).toThrow(/no se serializa/i);
  });

  it("el mismo valor, redondeado, sí se publica", () => {
    const redondeado = must(roundForCurrency(exact("1.23456789012345")));
    expect(JSON.stringify(redondeado.value)).toBe('{"amount":"1.23000000","currency":"VES"}');
  });
});
