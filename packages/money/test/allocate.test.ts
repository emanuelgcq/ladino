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
import { arbAmountString, arbCurrency, must, stringToScaled } from "./arbitraries.js";

const d = (v: string) => must(parseDecimal(v));

const arbWeights = fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 24 });

describe("P23 — la suma de las partes es EXACTAMENTE el total", () => {
  it("para todo total y todo vector de pesos", () => {
    fc.assert(
      fc.property(
        arbAmountString(10n ** 18n),
        arbCurrency,
        arbWeights,
        fc.constantFrom(0 as const, 2 as const, 8 as const),
        (amount, currency, weights, scale) => {
          const total = must(Money.of(amount, currency));
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
        },
      ),
    );
  });

  it("cada parte dista como mucho una unidad mínima de su proporción ideal", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 16n), arbWeights, (amount, weights) => {
        const total = must(Money.of(amount, "VES"));
        const scale = 2 as const;
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
      fc.property(arbAmountString(10n ** 16n), arbWeights, (amount, weights) => {
        const total = must(Money.of(amount, "VES"));
        const ws = weights.map((w) => d(String(w)));
        const a = must(allocate(total, ws, 2));
        const b = must(allocate(total, ws, 2));
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
