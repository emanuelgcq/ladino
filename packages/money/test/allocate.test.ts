/**
 * P23 — Reparto sin céntimos perdidos.
 *
 * Es la propiedad que hace verificable el invariante 10 de ACCOUNTING_INVARIANTS_TESTS.md
 * ("los redondeos no crean asientos desbalanceados"). Sin `allocate`, cada módulo que reparta
 * un total entre líneas, centros de coste o cuotas inventaría su propia forma de perder un
 * céntimo, y el descuadre aparecería en el libro, no en un test.
 *
 * Qué línea recibe el céntimo sobrante es una decisión con consecuencias fiscales:
 * VALIDAR-TRIBUTARIO en MONEY_AND_ROUNDING_SPEC.md §6.3. Aquí solo se exige que la suma cuadre
 * y que el reparto sea determinista.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, MoneyErrorCode, allocate, parseDecimal } from "../src/index.js";
import {
  arbAmountString,
  arbCurrency,
  must,
  scaledToString,
  stringToScaled,
} from "./arbitraries.js";

const d = (v: string) => must(parseDecimal(v));

const arbWeights = fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 24 });

/**
 * Total generado YA representable en la escala del reparto.
 *
 * Es la corrección de la formulación original, que combinaba totales de 8 decimales con escalas
 * 0 y 2 y por tanto pedía dos cosas incompatibles: suma exacta y partes múltiplo de la unidad
 * mínima. El contraejemplo fue `total = -0.00000001, scale = 0`. El caso no desaparece: pasa a
 * tener su propio test de precondición, más abajo.
 */
const arbTotalAtScale = fc.constantFrom(0 as const, 2 as const, 8 as const).chain((scale) =>
  fc
    .tuple(fc.bigInt({ min: -(10n ** 14n), max: 10n ** 14n }), arbCurrency)
    .map(([units, currency]) => {
      const value = scaledToString(units * 10n ** BigInt(8 - scale));
      return { total: must(Money.of(value, currency)), scale };
    }),
);

describe("P23 — la suma de las partes es EXACTAMENTE el total", () => {
  it("para todo total representable en la escala y todo vector de pesos", () => {
    fc.assert(
      fc.property(arbTotalAtScale, arbWeights, ({ total, scale }, weights) => {
        const parts = must(
          allocate(
            total,
            weights.map((w) => d(String(w))),
            scale,
          ),
        );

        const sum = parts.reduce((acc, p) => must(acc.add(p)), Money.zero(total.currency));
        expect(sum.toAmountString()).toBe(total.toAmountString());
        expect(parts).toHaveLength(weights.length);
      }),
    );
  });

  it("cada parte dista como mucho una unidad mínima de su proporción ideal", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 14n), arbWeights, (raw, weights) => {
        const scale = 2 as const;
        // A escala 2, la unidad mínima son 10^6 unidades de 10^-8.
        const total = must(
          Money.of(scaledToString((stringToScaled(raw) / 1_000_000n) * 1_000_000n), "VES"),
        );
        const parts = must(
          allocate(
            total,
            weights.map((w) => d(String(w))),
            scale,
          ),
        );

        const totalUnits = stringToScaled(total.toAmountString());
        const weightSum = weights.reduce((a, b) => a + b, 0);
        const unit = 10n ** BigInt(8 - scale);

        parts.forEach((part, i) => {
          const ideal = (totalUnits * BigInt(weights[i]!)) / BigInt(weightSum);
          const delta = stringToScaled(part.toAmountString()) - ideal;
          const abs = delta < 0n ? -delta : delta;
          expect(abs).toBeLessThanOrEqual(unit);
        });
      }),
    );
  });

  it("el caso canónico del céntimo que no divide: 0.10 entre tres", () => {
    const parts = must(allocate(must(Money.of("0.10", "VES")), [d("1"), d("1"), d("1")], 2));
    const strings = parts.map((p) => p.toAmountString());

    expect(strings).toHaveLength(3);
    const sum = parts.reduce((acc, p) => must(acc.add(p)), Money.zero(parts[0]!.currency));
    expect(sum.toAmountString()).toBe("0.10000000");
    // 0.04 / 0.03 / 0.03 en algún orden: nunca 0.03 / 0.03 / 0.03 perdiendo un céntimo.
    expect(strings.filter((s) => s === "0.04000000")).toHaveLength(1);
  });

  it("es determinista: mismos argumentos, mismo reparto", () => {
    fc.assert(
      fc.property(arbTotalAtScale, arbWeights, ({ total, scale }, weights) => {
        const ws = weights.map((w) => d(String(w)));
        const a = must(allocate(total, ws, scale));
        const b = must(allocate(total, ws, scale));
        expect(a.map((m) => m.toAmountString())).toEqual(b.map((m) => m.toAmountString()));
      }),
    );
  });

  it("conserva el signo de un total negativo (una nota de crédito también se reparte)", () => {
    const parts = must(allocate(must(Money.of("-0.10", "VES")), [d("1"), d("1"), d("1")], 2));
    const sum = parts.reduce((acc, p) => must(acc.add(p)), Money.zero(parts[0]!.currency));
    expect(sum.toAmountString()).toBe("-0.10000000");
  });
});

describe("P23b — el reparto del resto es simétrico respecto al signo", () => {
  it("allocate(−t) = allocate(t) negado, parte a parte", () => {
    // El contraejemplo que destapó el problema de formulación era negativo, y una nota de
    // crédito es exactamente eso: si el céntimo sobrante cayera en otra línea al invertir el
    // signo, la nota no revertiría la factura y el invariante 3 de
    // ACCOUNTING_INVARIANTS_TESTS.md ("reversal suma cero con original") sería falso.
    fc.assert(
      fc.property(arbTotalAtScale, arbWeights, ({ total, scale }, weights) => {
        const ws = weights.map((w) => d(String(w)));
        const positivo = must(allocate(total, ws, scale));
        const negativo = must(allocate(total.negate(), ws, scale));

        expect(negativo.map((m) => m.toAmountString())).toEqual(
          positivo.map((m) => m.negate().toAmountString()),
        );
      }),
    );
  });

  it("caso concreto: 0.10 y −0.10 entre tres reparten el céntimo en la misma línea", () => {
    const w = [d("1"), d("1"), d("1")];
    const positivo = must(allocate(must(Money.of("0.10", "VES")), w, 2));
    const negativo = must(allocate(must(Money.of("-0.10", "VES")), w, 2));

    expect(positivo.map((m) => m.toAmountString())).toEqual([
      "0.04000000",
      "0.03000000",
      "0.03000000",
    ]);
    expect(negativo.map((m) => m.toAmountString())).toEqual([
      "-0.04000000",
      "-0.03000000",
      "-0.03000000",
    ]);
  });
});

describe("P23c — precondición: el total tiene que caber en la escala", () => {
  it("un total con más precisión que la escala se rechaza en vez de redondearse", () => {
    // allocate NO redondea el total. Redondear es una decisión con nombre y con política
    // (MONEY_AND_ROUNDING_SPEC.md §5); hacerlo aquí en silencio escondería un céntimo.
    const r = allocate(must(Money.of("0.00000001", "VES")), [d("1")], 0);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.TOTAL_NOT_AT_SCALE);
  });

  it("el mismo total sí se reparte a escala 8", () => {
    const parts = must(allocate(must(Money.of("0.00000001", "VES")), [d("1")], 8));
    expect(parts.map((m) => m.toAmountString())).toEqual(["0.00000001"]);
  });

  it("rechaza también el caso negativo del contraejemplo original", () => {
    const r = allocate(must(Money.of("-0.00000001", "VES")), [d("1")], 0);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.TOTAL_NOT_AT_SCALE);
  });

  it("un total con céntimos no se puede repartir a escala 0", () => {
    const r = allocate(must(Money.of("100.50", "VES")), [d("1"), d("1")], 0);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.TOTAL_NOT_AT_SCALE);
  });
});

describe("allocate rechaza pesos que no definen un reparto", () => {
  it("lista vacía", () => {
    const r = allocate(must(Money.of("10", "VES")), [], 2);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_WEIGHTS);
  });

  it("todos los pesos a cero: no hay proporción definida", () => {
    const r = allocate(must(Money.of("10", "VES")), [d("0"), d("0")], 2);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_WEIGHTS);
  });

  it("un peso negativo", () => {
    const r = allocate(must(Money.of("10", "VES")), [d("1"), d("-1")], 2);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_WEIGHTS);
  });
});
