/**
 * Cálculo de venta — RIGOR MÁXIMO. Property tests contra un oráculo BigInt
 * (no decimal.js contra decimal.js) y ejemplos calculados a mano.
 *
 *   P1  el total del documento es EXACTAMENTE Σ subtotales + Σ impuestos;
 *   P2  determinismo campo por campo;
 *   P3  con la MISMA tasa, el diferencial cambiario es CERO exacto — no «casi»;
 *   P4  el diferencial tiene el signo correcto y es simétrico al invertir tasas;
 *   P5  el saldo tras cobrar el total exacto es cero.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, parseDecimal, type RoundingPolicy } from "@ladino/money";
import {
  agingBucket,
  calculateLine,
  calculateTotals,
  exchangeDifference,
  outstandingBalance,
  type CalculatedLine,
} from "../src/index.js";

const POL: RoundingPolicy = { id: "test:8:HALF_UP", scale: 8, mode: "HALF_UP" };
const POL2: RoundingPolicy = { id: "test:2:HALF_UP", scale: 2, mode: "HALF_UP" };
const SCALE = 10n ** 8n;

function must<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`Se esperaba ok, llegó ${r.error.code}: ${r.error.message}`);
  return r.value;
}
const dec = (s: string) => must(parseDecimal(s));
const ves = (s: string) => must(Money.of(s, "VES"));
const units = (s: string): bigint => {
  const neg = s.startsWith("-");
  const [w = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const u = BigInt(w) * SCALE + BigInt(f.padEnd(8, "0").slice(0, 8));
  return neg ? -u : u;
};
const fmt = (u: bigint): string => `${u / SCALE}.${(u % SCALE).toString().padStart(8, "0")}`;

const arbCantidad = fc.bigInt({ min: 10n ** 6n, max: 10n ** 11n }).map((u) => dec(fmt(u)));
const arbPrecio = fc.bigInt({ min: 1n, max: 10n ** 12n }).map((u) => ves(fmt(u)));
const arbTasa = fc.bigInt({ min: 0n, max: 10n ** 8n }).map((u) => dec(fmt(u)));
const arbLinea = fc
  .record({ quantity: arbCantidad, unitPrice: arbPrecio, taxRate: arbTasa })
  .map((r) => calculateLine({ ...r, basePolicy: POL, taxPolicy: POL }));

describe("P1 — el total del documento es la suma exacta de sus líneas", () => {
  it("Σ subtotales y Σ impuestos, contra el oráculo BigInt", () => {
    fc.assert(
      fc.property(fc.array(arbLinea, { minLength: 1, maxLength: 25 }), (resultados) => {
        const lineas: CalculatedLine[] = [];
        for (const r of resultados) {
          if (!r.ok) return; // desbordar numeric(24,8) es un fallo legítimo
          lineas.push(r.value);
        }
        if (lineas.length === 0) return;
        const t = calculateTotals(lineas);
        if (!t.ok) {
          expect(t.error.code).toBe("MONEY");
          return;
        }
        let sub = 0n;
        let imp = 0n;
        for (const l of lineas) {
          sub += units(l.subtotal.toAmountString());
          imp += units(l.taxAmount.toAmountString());
        }
        expect(units(t.value.subtotal.toAmountString())).toBe(sub);
        expect(units(t.value.taxAmount.toAmountString())).toBe(imp);
        expect(units(t.value.total.toAmountString())).toBe(sub + imp);
      }),
      { numRuns: 300 },
    );
  });

  it("y cada línea cumple total = subtotal + impuesto, exacto", () => {
    fc.assert(
      fc.property(arbLinea, (r) => {
        if (!r.ok) return;
        const l = r.value;
        expect(units(l.total.toAmountString())).toBe(
          units(l.subtotal.toAmountString()) + units(l.taxAmount.toAmountString()),
        );
      }),
      { numRuns: 300 },
    );
  });
});

describe("P2 — determinismo", () => {
  it("dos cálculos del mismo dato coinciden campo por campo", () => {
    fc.assert(
      fc.property(arbCantidad, arbPrecio, arbTasa, (q, p, t) => {
        const entrada = { quantity: q, unitPrice: p, taxRate: t, basePolicy: POL, taxPolicy: POL };
        const a = calculateLine(entrada);
        const b = calculateLine(entrada);
        expect(a.ok).toBe(b.ok);
        if (!a.ok || !b.ok) return;
        expect([
          a.value.subtotal.toAmountString(),
          a.value.taxAmount.toAmountString(),
          a.value.total.toAmountString(),
        ]).toEqual([
          b.value.subtotal.toAmountString(),
          b.value.taxAmount.toAmountString(),
          b.value.total.toAmountString(),
        ]);
      }),
      { numRuns: 200 },
    );
  });
});

describe("P3 — misma tasa, diferencial CERO exacto", () => {
  it("no «casi cero»: las dos valoraciones salen del mismo producto", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }).map((u) => must(Money.of(fmt(u), "USD"))),
        fc.bigInt({ min: 1n, max: 10n ** 10n }).map((u) => dec(fmt(u))),
        (importe, tasa) => {
          const d = exchangeDifference({
            amountTransaction: importe,
            functionalCurrency: "VES",
            rateAtIssue: tasa,
            rateAtPayment: tasa,
            policy: POL,
          });
          if (!d.ok) return;
          expect(d.value.difference.isZero()).toBe(true);
          expect(d.value.isGain).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("P4 — el diferencial tiene el signo correcto y es simétrico", () => {
  it("tasa de cobro mayor = ganancia; invertir las tasas invierte el signo exactamente", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 10n ** 6n, max: 10n ** 11n }).map((u) => must(Money.of(fmt(u), "USD"))),
        fc.bigInt({ min: 10n ** 6n, max: 10n ** 10n }).map((u) => dec(fmt(u))),
        fc.bigInt({ min: 10n ** 6n, max: 10n ** 10n }).map((u) => dec(fmt(u))),
        (importe, r1, r2) => {
          const a = exchangeDifference({
            amountTransaction: importe,
            functionalCurrency: "VES",
            rateAtIssue: r1,
            rateAtPayment: r2,
            policy: POL,
          });
          const b = exchangeDifference({
            amountTransaction: importe,
            functionalCurrency: "VES",
            rateAtIssue: r2,
            rateAtPayment: r1,
            policy: POL,
          });
          if (!a.ok || !b.ok) return;
          expect(units(a.value.difference.toAmountString())).toBe(
            -units(b.value.difference.toAmountString()),
          );
          // Las dos propiedades correctas son NO ESTRICTAS, y las dos versiones
          // estrictas fallaron —una por dirección— con el mismo contraejemplo de
          // fondo: 0,01 USD a tasas 0,01 y 0,01000001 redondean a la MISMA
          // valoración, y la diferencia es cero. Exigir «ganancia» o «pérdida»
          // estricta era exigir que el redondeo no existiera. No se cambió la
          // implementación para satisfacer una propiedad falsa.
          if (r2.greaterThan(r1)) expect(a.value.difference.isNegative()).toBe(false);
          if (r2.lessThan(r1)) expect(a.value.isGain).toBe(false);
          // Y `isGain` significa exactamente «estrictamente positiva».
          expect(a.value.isGain).toBe(
            !a.value.difference.isNegative() && !a.value.difference.isZero(),
          );
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("P5 — el saldo tras cobrar el total exacto es cero", () => {
  it("y cobrar en partes da lo mismo que cobrar de una vez", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.bigInt({ min: 1n, max: 10n ** 10n }).map((u) => ves(fmt(u))),
          { minLength: 1, maxLength: 10 },
        ),
        (cobros) => {
          let suma = 0n;
          for (const c of cobros) suma += units(c.toAmountString());
          const total = ves(fmt(suma));
          const saldo = outstandingBalance(total, cobros);
          expect(saldo.ok).toBe(true);
          if (!saldo.ok) return;
          expect(saldo.value.isZero()).toBe(true);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("ejemplos calculados a mano (los mismos que pgTAP 021)", () => {
  it("1 × 100,00 al 16% → base 100,00, IVA 16,00, total 116,00", () => {
    const l = must(
      calculateLine({
        quantity: dec("1"),
        unitPrice: ves("100"),
        taxRate: dec("0.16"),
        basePolicy: POL2,
        taxPolicy: POL2,
      }),
    );
    expect(l.subtotal.toAmountString()).toBe("100.00000000");
    expect(l.taxAmount.toAmountString()).toBe("16.00000000");
    expect(l.total.toAmountString()).toBe("116.00000000");
  });

  it("3 × 33,33 al 16% → base 99,99, IVA 16,00 (no 15,9984), total 115,99", () => {
    // 99,99 × 0,16 = 15,9984 → HALF_UP a 2 → 16,00. El impuesto se calcula sobre
    // la base REDONDEADA, que es la que va impresa: si se calculara sobre la
    // exacta, el documento mostraría una base y un IVA que no cuadran entre sí.
    const l = must(
      calculateLine({
        quantity: dec("3"),
        unitPrice: ves("33.33"),
        taxRate: dec("0.16"),
        basePolicy: POL2,
        taxPolicy: POL2,
      }),
    );
    expect(l.subtotal.toAmountString()).toBe("99.99000000");
    expect(l.taxAmount.toAmountString()).toBe("16.00000000");
    expect(l.total.toAmountString()).toBe("115.99000000");
  });

  it("DIFERENCIAL A MANO: 100 USD emitidos a 40 y cobrados a 50 → +1 000,00 Bs", () => {
    const d = must(
      exchangeDifference({
        amountTransaction: must(Money.of("100", "USD")),
        functionalCurrency: "VES",
        rateAtIssue: dec("40"),
        rateAtPayment: dec("50"),
        policy: POL,
      }),
    );
    expect(d.functionalAtIssue.toAmountString()).toBe("4000.00000000");
    expect(d.functionalAtPayment.toAmountString()).toBe("5000.00000000");
    expect(d.difference.toAmountString()).toBe("1000.00000000");
    expect(d.isGain).toBe(true);
  });

  it("y a la inversa es PÉRDIDA, del mismo importe", () => {
    const d = must(
      exchangeDifference({
        amountTransaction: must(Money.of("100", "USD")),
        functionalCurrency: "VES",
        rateAtIssue: dec("50"),
        rateAtPayment: dec("40"),
        policy: POL,
      }),
    );
    expect(d.difference.toAmountString()).toBe("-1000.00000000");
    expect(d.isGain).toBe(false);
  });

  it("una alícuota fuera de [0,1] se rechaza: viene de tax_rules, no se inventa", () => {
    for (const t of ["-0.1", "1.5"]) {
      const r = calculateLine({
        quantity: dec("1"),
        unitPrice: ves("100"),
        taxRate: dec(t),
        basePolicy: POL,
        taxPolicy: POL,
      });
      expect(!r.ok && r.error.code).toBe("INVALID_RATE");
    }
  });

  it("un documento SIN líneas no se emite", () => {
    const r = calculateTotals([]);
    expect(!r.ok && r.error.code).toBe("EMPTY_DOCUMENT");
  });

  it("los cuatro rangos de antigüedad, en sus bordes EXACTOS", () => {
    // El borde es donde se cuela el desfase de uno, así que se prueban los ocho
    // días que lo definen, no una muestra cómoda del medio de cada rango.
    const ref = "2026-12-31T00:00:00.000Z";
    const haceDias = (d: number) => new Date(Date.parse(ref) - d * 86_400_000).toISOString();
    expect(
      [0, 30, 31, 60, 61, 90, 91, 400].map((d) => must(agingBucket(haceDias(d), ref))),
    ).toEqual(["0-30", "0-30", "31-60", "31-60", "61-90", "61-90", "90+", "90+"]);
  });

  it("una fecha que no es ISO-8601 se rechaza en vez de caer en un rango cualquiera", () => {
    expect(agingBucket("ayer", "2026-12-31T00:00:00.000Z").ok).toBe(false);
  });

  it("mezclar monedas entre líneas no suma", () => {
    const a = must(
      calculateLine({
        quantity: dec("1"),
        unitPrice: ves("10"),
        taxRate: dec("0"),
        basePolicy: POL,
        taxPolicy: POL,
      }),
    );
    const b = must(
      calculateLine({
        quantity: dec("1"),
        unitPrice: must(Money.of("10", "USD")),
        taxRate: dec("0"),
        basePolicy: POL,
        taxPolicy: POL,
      }),
    );
    const r = calculateTotals([a, b]);
    expect(!r.ok && r.error.code).toBe("CURRENCY_MISMATCH");
  });
});
