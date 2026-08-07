/**
 * P1–P7 — Álgebra de la suma.
 *
 * Money debe comportarse como un grupo abeliano dentro de su dominio. Si la suma no es
 * asociativa, el total de una factura depende del orden en que se recorran las líneas.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, MoneyErrorCode, parseCurrency } from "../src/index.js";
import {
  MAX_SCALED,
  SAFE_SCALED,
  arbAmountString,
  arbCurrency,
  must,
  scaledToString,
  unitsOf,
} from "./arbitraries.js";

const money = (amount: string, currency = "VES") => must(Money.of(amount, currency));

const arbMoney = (max = SAFE_SCALED) =>
  fc.tuple(arbAmountString(max), arbCurrency).map(([a, c]) => must(Money.of(a, c)));

/** Dos importes de la MISMA moneda. La mayoría de las propiedades solo aplican ahí. */
const arbSameCurrencyPair = (max = SAFE_SCALED) =>
  fc
    .tuple(arbAmountString(max), arbAmountString(max), arbCurrency)
    .map(([a, b, c]) => [must(Money.of(a, c)), must(Money.of(b, c))] as const);

describe("P1 — conmutatividad", () => {
  it("a + b = b + a", () => {
    fc.assert(
      fc.property(arbSameCurrencyPair(), ([a, b]) => {
        expect(must(a.add(b)).equals(must(b.add(a)))).toBe(true);
      }),
    );
  });
});

describe("P2 — asociatividad", () => {
  it("(a + b) + c = a + (b + c)", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          arbAmountString(SAFE_SCALED),
          arbAmountString(SAFE_SCALED),
          arbAmountString(SAFE_SCALED),
          arbCurrency,
        ),
        ([x, y, z, currency]) => {
          const a = must(Money.of(x, currency));
          const b = must(Money.of(y, currency));
          const c = must(Money.of(z, currency));
          const left = must(must(a.add(b)).add(c));
          const right = must(a.add(must(b.add(c))));
          expect(left.equals(right)).toBe(true);
        },
      ),
    );
  });
});

describe("P3 — elemento neutro", () => {
  it("a + 0 = a", () => {
    fc.assert(
      fc.property(arbMoney(), (a) => {
        expect(must(a.add(Money.zero(a.currency))).equals(a)).toBe(true);
      }),
    );
  });
});

describe("P4 — inverso aditivo", () => {
  it("a + (−a) = 0", () => {
    fc.assert(
      fc.property(arbMoney(), (a) => {
        expect(must(a.add(a.negate())).isZero()).toBe(true);
      }),
    );
  });

  it("−(−a) = a", () => {
    fc.assert(
      fc.property(arbMoney(), (a) => {
        expect(a.negate().negate().equals(a)).toBe(true);
      }),
    );
  });
});

describe("P5 — cierre de dominio: numeric(24,8) o error explícito", () => {
  it("una suma que desborda devuelve AMOUNT_OUT_OF_RANGE, nunca un valor silencioso", () => {
    const max = must(Money.of(scaledToString(MAX_SCALED), "VES"));
    const r = max.add(money("0.00000001"));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.AMOUNT_OUT_OF_RANGE);
  });

  it("toda suma que devuelve ok cabe en el dominio", () => {
    fc.assert(
      fc.property(arbSameCurrencyPair(MAX_SCALED), ([a, b]) => {
        const r = a.add(b);
        if (r.ok) {
          const units = unitsOf(r.value);
          expect(units <= MAX_SCALED && units >= -MAX_SCALED).toBe(true);
        } else {
          expect(r.error.code).toBe(MoneyErrorCode.AMOUNT_OUT_OF_RANGE);
        }
      }),
    );
  });

  it("rechaza construir por encima del dominio", () => {
    const r = Money.of(scaledToString(MAX_SCALED + 1n), "VES");
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.AMOUNT_OUT_OF_RANGE);
  });

  it("rechaza más de 8 decimales en vez de truncar en silencio", () => {
    const r = Money.of("1.000000001", "VES");
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_AMOUNT);
  });
});

describe("P6 — resta definida por la suma", () => {
  it("a − b = a + (−b)", () => {
    fc.assert(
      fc.property(arbSameCurrencyPair(), ([a, b]) => {
        expect(must(a.subtract(b)).equals(must(a.add(b.negate())))).toBe(true);
      }),
    );
  });
});

describe("P7 — monedas distintas nunca se coaccionan", () => {
  // Perezosos a propósito: construirlos en el cuerpo del describe haría fallar la RECOLECCIÓN
  // del fichero entero y el rojo perdería el nombre de cada propiedad.
  const ves = () => money("10.00", "VES");
  const usd = () => money("10.00", "USD");

  it("add devuelve CURRENCY_MISMATCH", () => {
    const r = ves().add(usd());
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.CURRENCY_MISMATCH);
  });

  it("subtract devuelve CURRENCY_MISMATCH", () => {
    expect(ves().subtract(usd()).ok).toBe(false);
  });

  it("compare devuelve CURRENCY_MISMATCH", () => {
    expect(ves().compare(usd()).ok).toBe(false);
  });

  it("equals es false entre monedas distintas aunque el importe coincida", () => {
    expect(ves().equals(usd())).toBe(false);
  });

  it("una moneda no registrada se rechaza al construir", () => {
    const r = Money.of("1.00", "XYZ");
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });

  it("parseCurrency rechaza códigos fuera del registro", () => {
    expect(parseCurrency("XYZ").ok).toBe(false);
    expect(parseCurrency("").ok).toBe(false);
    expect(parseCurrency("VES").ok).toBe(true);
  });
});
