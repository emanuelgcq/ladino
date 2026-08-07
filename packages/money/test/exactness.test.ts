/**
 * P8–P10 — Exactitud. Ausencia de IEEE 754.
 *
 * P9 es la propiedad que de verdad protege: compara contra aritmética entera exacta de BigInt,
 * una implementación independiente. P8 (0.1 + 0.2) es el caso golden que pide S0.2, pero por sí
 * solo lo pasaría cualquier librería que redondee a 2 decimales por casualidad.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money } from "../src/index.js";
import {
  SAFE_SCALED,
  arbAmountString,
  arbCurrency,
  must,
  scaledToString,
  stringToScaled,
  unitsOf,
} from "./arbitraries.js";

describe("P8 — el caso golden de S0.2", () => {
  it("0.1 + 0.2 es exactamente 0.3", () => {
    const a = must(Money.of("0.1", "VES"));
    const b = must(Money.of("0.2", "VES"));
    const sum = must(a.add(b));

    expect(sum.equals(must(Money.of("0.3", "VES")))).toBe(true);
    expect(sum.toAmountString()).toBe("0.30000000");
  });

  it("deja constancia de que el mismo cálculo en IEEE 754 NO da 0.3", () => {
    // Si esta aserción llegara a fallar, JavaScript habría cambiado y este paquete sobraría.
    expect(0.1 + 0.2).not.toBe(0.3);
  });

  it("1.005 y 2.675 conservan su valor exacto, sin el error de representación de IEEE", () => {
    expect(must(Money.of("1.005", "VES")).toAmountString()).toBe("1.00500000");
    expect(must(Money.of("2.675", "VES")).toAmountString()).toBe("2.67500000");
  });
});

describe("P9 — generalización: la suma coincide con aritmética entera exacta", () => {
  it("Money.add == BigInt escalado a 10^8, para todo par del dominio", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(SAFE_SCALED), arbAmountString(SAFE_SCALED), arbCurrency),
        ([x, y, currency]) => {
          const a = must(Money.of(x, currency));
          const b = must(Money.of(y, currency));
          const expected = stringToScaled(x) + stringToScaled(y);
          expect(unitsOf(must(a.add(b)))).toBe(expected);
        },
      ),
    );
  });

  it("Money.subtract == resta entera exacta", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(SAFE_SCALED), arbAmountString(SAFE_SCALED), arbCurrency),
        ([x, y, currency]) => {
          const a = must(Money.of(x, currency));
          const b = must(Money.of(y, currency));
          expect(unitsOf(must(a.subtract(b)))).toBe(stringToScaled(x) - stringToScaled(y));
        },
      ),
    );
  });

  it("sumar una lista da igual en qué orden se recorra", () => {
    fc.assert(
      fc.property(
        fc.array(arbAmountString(SAFE_SCALED / 64n), { minLength: 2, maxLength: 32 }),
        (amounts) => {
          const values = amounts.map((a) => must(Money.of(a, "VES")));
          const forward = values.reduce(
            (acc, m) => must(acc.add(m)),
            Money.zero(values[0]!.currency),
          );
          const backward = [...values]
            .reverse()
            .reduce((acc, m) => must(acc.add(m)), Money.zero(values[0]!.currency));

          expect(forward.equals(backward)).toBe(true);
          expect(unitsOf(forward)).toBe(amounts.reduce((acc, a) => acc + stringToScaled(a), 0n));
        },
      ),
    );
  });
});

describe("P10 — nada de NaN, Infinity ni entradas basura", () => {
  const rechazados = [
    "NaN",
    "Infinity",
    "-Infinity",
    "1e10", // notación exponencial: ambigua al persistir en numeric(24,8)
    "1,5", // separador decimal de es-VE: la UI lo normaliza, el dominio no lo adivina
    "1 000.00",
    "$100",
    "",
    " ",
    "1.2.3",
    "--1",
    "+1.00",
    "0x10",
  ];

  it.each(rechazados)("rechaza %j", (raw) => {
    expect(Money.of(raw, "VES").ok).toBe(false);
  });

  it("ninguna operación produce un importe no finito", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(SAFE_SCALED), arbAmountString(SAFE_SCALED), arbCurrency),
        ([x, y, currency]) => {
          const a = must(Money.of(x, currency));
          const b = must(Money.of(y, currency));
          const r = a.add(b);
          if (r.ok) {
            expect(r.value.toAmountString()).toMatch(/^-?\d+\.\d{8}$/);
          }
        },
      ),
    );
  });

  it("acepta la frontera del dominio y rechaza un dígito más", () => {
    const max = scaledToString(10n ** 24n - 1n);
    expect(Money.of(max, "VES").ok).toBe(true);
    expect(Money.of(scaledToString(10n ** 24n), "VES").ok).toBe(false);
  });
});
