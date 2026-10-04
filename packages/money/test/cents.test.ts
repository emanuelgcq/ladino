/**
 * EL CÉNTIMO DEL MAYOR (ADR-0075 §7): `toCents`, `isAtCents` y `CENTS_POLICY`.
 *
 * `toCents` y `platform.round_cents` (SQL) son GEMELAS: las dos tienen que decir lo mismo en los
 * bordes. Aquí se fija lo esperado A MANO; el test de integración del dominio
 * (`packages/domain/test/centimo-gemelas.test.ts`) pasa los mismos bordes por Postgres y compara
 * `toCents` con `round_cents` caso por caso.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CENTS_POLICY,
  ExactMoney,
  isAtCents,
  parseDecimal,
  roundForCost,
  toCents,
} from "../src/index.js";
import type { CurrencyCode } from "../src/index.js";
import { must } from "./arbitraries.js";

const VES = "VES" as CurrencyCode;

/** [entrada, esperado al céntimo]. Half-up = la mitad se ALEJA del cero, también en negativos. */
const BORDES: readonly (readonly [string, string])[] = [
  ["0.005", "0.01"],
  ["-0.005", "-0.01"],
  ["0.00499999", "0.00"],
  ["-0.00499999", "0.00"],
  ["1.005", "1.01"],
  ["-1.005", "-1.01"],
  ["2.675", "2.68"],
  ["-2.675", "-2.68"],
  ["2.665", "2.67"],
  ["2.674999995", "2.67"],
  ["10.004999995", "10.00"],
  ["0", "0.00"],
  ["0.00000001", "0.00"],
  ["-0.00000001", "0.00"],
  ["4211.0335", "4211.03"],
  ["9999999999999999.985", "9999999999999999.99"],
  ["123456789.994999999999", "123456789.99"],
];

/** El cero no lleva signo: decimal.js imprime «-0.00» para un −0. */
const texto = (d: { toFixed(n: number): string }): string =>
  d.toFixed(2).replace(/^-(0\.00)$/, "$1");

describe("toCents: half-up al céntimo", () => {
  it.each(BORDES)("toCents(%s) = %s", (entrada, esperado) => {
    expect(texto(toCents(must(parseDecimal(entrada))))).toBe(esperado);
  });

  it("2,675 NO es 2,67: el caso que delata un float (2.675 en binario es 2.67499999…)", () => {
    expect(toCents(must(parseDecimal("2.675"))).toFixed(2)).toBe("2.68");
    expect(toCents(must(parseDecimal("1.005"))).toFixed(2)).toBe("1.01");
  });

  it("es idempotente, simétrico en el signo y nunca se aleja más de medio céntimo", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: -(10n ** 20n), max: 10n ** 20n }), (u) => {
        // u en unidades de 10^-10: dos cifras por debajo de los 8 decimales persistibles.
        const neg = u < 0n;
        const abs = neg ? -u : u;
        const entrada = `${neg ? "-" : ""}${String(abs / 10n ** 10n)}.${(abs % 10n ** 10n)
          .toString()
          .padStart(10, "0")}`;
        const x = must(parseDecimal(entrada));
        const c = toCents(x);
        expect(toCents(c).equals(c)).toBe(true);
        expect(toCents(x.negated()).equals(c.negated())).toBe(true);
        expect(c.minus(x).abs().lessThanOrEqualTo("0.005")).toBe(true);
        expect(isAtCents(c)).toBe(true);
        // Oráculo en enteros, no decimal.js contra decimal.js: (|u| + 5·10^7) div 10^8 céntimos.
        const centimos = (abs + 5n * 10n ** 7n) / 10n ** 8n;
        expect(c.abs().times(100).toFixed(0)).toBe(centimos.toString());
      }),
      { numRuns: 500 },
    );
  });
});

describe("isAtCents", () => {
  it("dice sí a dos decimales (con ceros de relleno) y no a la tercera cifra", () => {
    for (const si of ["0", "1", "1.5", "1.50", "1.50000000", "-4211.03", "0.01"]) {
      expect(isAtCents(must(parseDecimal(si)))).toBe(true);
    }
    for (const no of ["0.001", "1.005", "-0.00000001", "10.12345678", "4211.0335"]) {
      expect(isAtCents(must(parseDecimal(no)))).toBe(false);
    }
  });
});

describe("CENTS_POLICY", () => {
  it("es escala 2, HALF_UP, con el id que se persiste junto al importe, y está congelada", () => {
    expect(CENTS_POLICY).toEqual({ id: "ledger:cents:2:HALF_UP", scale: 2, mode: "HALF_UP" });
    expect(Object.isFrozen(CENTS_POLICY)).toBe(true);
  });

  it("un roundFor* con CENTS_POLICY dice lo mismo que toCents, en todos los bordes", () => {
    for (const [entrada] of BORDES) {
      const x = must(parseDecimal(entrada));
      const r = must(roundForCost(ExactMoney.from({ amount: x, currency: VES }), CENTS_POLICY));
      expect(r.value.amount.equals(toCents(x))).toBe(true);
      expect(r.policy.id).toBe("ledger:cents:2:HALF_UP");
    }
  });
});
