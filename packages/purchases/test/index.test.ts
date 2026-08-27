import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money, parseDecimal, type Decimal, type RoundingPolicy } from "@ladino/money";
import {
  allocateLandedCost,
  computeRetention,
  matchThreeWay,
  type AllocatableLine,
} from "../src/index.js";

const POLICY: RoundingPolicy = { id: "purchases:document:8:HALF_UP", scale: 8, mode: "HALF_UP" };

const d = (s: string): Decimal => {
  const r = parseDecimal(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const m = (s: string): Money => {
  const r = Money.of(s, "VES");
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

const linea = (
  id: string,
  recibida: string,
  queda: string,
  valor: string,
  peso: string | null,
): AllocatableLine => ({
  lineId: id,
  quantityReceived: d(recibida),
  quantityRemaining: d(queda),
  valueFunctional: m(valor),
  unitWeight: peso === null ? null : d(peso),
});

describe("landed cost — los tres métodos, con los números del pgTAP", () => {
  it("por VALOR reparte proporcional a la base de cada línea", () => {
    const r = allocateLandedCost({
      amount: m("2200"),
      method: "by_value",
      lines: [linea("A", "4", "4", "16000", "2"), linea("B", "6", "6", "6000", "3")],
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines[0]!.allocated.toAmountString()).toBe("1600.00000000");
    expect(r.value.lines[1]!.allocated.toAmountString()).toBe("600.00000000");
  });

  it("por PESO usa cantidad × peso unitario, no la cantidad sola", () => {
    const r = allocateLandedCost({
      amount: m("1300"),
      method: "by_weight",
      lines: [linea("A", "4", "4", "16000", "2"), linea("B", "6", "6", "6000", "3")],
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Pesos 8 y 18 sobre 26: 400 y 900. Si usara solo la cantidad daría 520/780.
    expect(r.value.lines[0]!.allocated.toAmountString()).toBe("400.00000000");
    expect(r.value.lines[1]!.allocated.toAmountString()).toBe("900.00000000");
  });

  it("por UNIDADES ignora valor y peso", () => {
    const r = allocateLandedCost({
      amount: m("500"),
      method: "by_units",
      lines: [linea("A", "4", "4", "16000", "2"), linea("B", "6", "6", "6000", "3")],
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines[0]!.allocated.toAmountString()).toBe("200.00000000");
    expect(r.value.lines[1]!.allocated.toAmountString()).toBe("300.00000000");
  });

  it("por PESO falla si a una línea le falta el peso, en vez de repartir mal", () => {
    const r = allocateLandedCost({
      amount: m("1300"),
      method: "by_weight",
      lines: [linea("A", "4", "4", "16000", "2"), linea("B", "6", "6", "6000", null)],
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MISSING_WEIGHT");
  });
});

describe("landed cost tardío — variación, no prorrateo sobre lo que queda", () => {
  it("con 3 de 4 unidades ya vendidas, 1 200 van a variación y 400 a inventario", () => {
    const r = allocateLandedCost({
      amount: m("2200"),
      method: "by_value",
      lines: [linea("A", "4", "1", "16000", "2"), linea("B", "6", "6", "6000", "3")],
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const a = r.value.lines[0]!;
    expect(a.allocated.toAmountString()).toBe("1600.00000000");
    expect(a.toInventory.toAmountString()).toBe("400.00000000");
    expect(a.toVariance.toAmountString()).toBe("1200.00000000");
    // Y la línea intacta no genera variación: nada salió de ella.
    expect(r.value.lines[1]!.toVariance.toAmountString()).toBe("0.00000000");
  });

  it("si TODO se vendió, el gasto entero es variación y el inventario no se toca", () => {
    const r = allocateLandedCost({
      amount: m("1000"),
      method: "by_units",
      lines: [linea("A", "10", "0", "5000", null)],
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lines[0]!.toInventory.toAmountString()).toBe("0.00000000");
    expect(r.value.lines[0]!.toVariance.toAmountString()).toBe("1000.00000000");
  });
});

describe("landed cost — propiedades", () => {
  /**
   * P1. Lo repartido SIEMPRE suma el gasto. Es la propiedad que protege el
   * CHECK de la base: si el residuo se perdiera, habría costo desaparecido y el
   * INSERT fallaría en producción con un importe que nadie sabría reconstruir.
   */
  it("P1 · Σ asignado == gasto, exactamente, para cualquier reparto", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(fc.integer({ min: 1, max: 10_000 }), { minLength: 1, maxLength: 8 }),
        (gasto, valores) => {
          const r = allocateLandedCost({
            amount: m(String(gasto)),
            method: "by_value",
            lines: valores.map((v, i) => linea(`L${i}`, "1", "1", String(v), null)),
            policy: POLICY,
          });
          if (!r.ok) {
            // El único fallo admisible es el desbordamiento de numeric(24,8).
            expect(r.error.code).toBe("MONEY");
            return;
          }
          let suma = d("0");
          for (const l of r.value.lines) suma = suma.plus(l.allocated.amount);
          expect(suma.toFixed(8)).toBe(d(String(gasto)).toFixed(8));
        },
      ),
      { numRuns: 300 },
    );
  });

  /** P2. Inventario + variación == asignado, línea a línea. Es lo que el CHECK
   *  `allocated = to_inventory + to_variance` exige, y por eso la variación se
   *  calcula RESTANDO en vez de por su cuenta. */
  it("P2 · inventario + variación == asignado en cada línea", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 100 }), fc.integer({ min: 0, max: 100 })), {
          minLength: 1,
          maxLength: 6,
        }),
        (gasto, pares) => {
          const lineas = pares.map(([recibida, queda], i) =>
            linea(
              `L${i}`,
              String(recibida),
              String(Math.min(queda, recibida)),
              String(recibida * 10),
              null,
            ),
          );
          const r = allocateLandedCost({
            amount: m(String(gasto)),
            method: "by_units",
            lines: lineas,
            policy: POLICY,
          });
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          for (const l of r.value.lines) {
            expect(l.toInventory.amount.plus(l.toVariance.amount).toFixed(8)).toBe(
              l.allocated.amount.toFixed(8),
            );
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  /** P3. Nada negativo. Un importe negativo aquí sería un abono disfrazado de
   *  costo, y el CHECK de la base lo rechazaría en el peor momento. */
  it("P3 · ninguna parte del reparto es negativa", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000 }),
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 5 }),
        (gasto, cantidades) => {
          const r = allocateLandedCost({
            amount: m(String(gasto)),
            method: "by_units",
            lines: cantidades.map((c, i) => linea(`L${i}`, String(c), "0", "100", null)),
            policy: POLICY,
          });
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          for (const l of r.value.lines) {
            expect(l.allocated.amount.isNegative()).toBe(false);
            expect(l.toInventory.amount.isNegative()).toBe(false);
            expect(l.toVariance.amount.isNegative()).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe("retenciones — la mecánica, nunca el porcentaje", () => {
  it("`rate`: base × tasa", () => {
    const r = computeRetention({
      base: m("1600"),
      rule: { formulaKind: "rate", rate: d("0.75"), subtrahend: null, minimumExempt: null },
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toAmountString()).toBe("1200.00000000");
  });

  it("`rate_minus_subtrahend`: base × tasa − sustraendo", () => {
    const r = computeRetention({
      base: m("20000"),
      rule: {
        formulaKind: "rate_minus_subtrahend",
        rate: d("0.03"),
        subtrahend: d("500"),
        minimumExempt: d("10000"),
      },
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toAmountString()).toBe("100.00000000");
  });

  it("por debajo del mínimo exento no se retiene NADA", () => {
    const r = computeRetention({
      base: m("9000"),
      rule: {
        formulaKind: "rate_minus_subtrahend",
        rate: d("0.03"),
        subtrahend: d("500"),
        minimumExempt: d("10000"),
      },
      policy: POLICY,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toAmountString()).toBe("0.00000000");
  });

  it("nunca devuelve una retención negativa", () => {
    const r = computeRetention({
      base: m("10000"),
      rule: {
        formulaKind: "rate_minus_subtrahend",
        rate: d("0.03"),
        subtrahend: d("500"),
        minimumExempt: d("10000"),
      },
      policy: POLICY,
    });
    // 10 000 × 0,03 = 300; 300 − 500 = −200 → 0, no −200.
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.toAmountString()).toBe("0.00000000");
  });

  it("una regla `rate` con sustraendo se rechaza: está mal entendida", () => {
    const r = computeRetention({
      base: m("1000"),
      rule: { formulaKind: "rate", rate: d("0.03"), subtrahend: d("500"), minimumExempt: null },
      policy: POLICY,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("UNKNOWN_FORMULA");
  });

  /** P4. La retención nunca supera la base ni baja de cero. Si lo hiciera, o se
   *  le quitaría al proveedor más de lo que se le debe, o se le devolvería
   *  dinero llamándolo retención. */
  it("P4 · 0 ≤ retención ≤ base, siempre", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100 }),
        (base, pct) => {
          const r = computeRetention({
            base: m(String(base)),
            rule: {
              formulaKind: "rate",
              rate: d(String(pct / 100)),
              subtrahend: null,
              minimumExempt: null,
            },
            policy: POLICY,
          });
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          expect(r.value.amount.isNegative()).toBe(false);
          expect(r.value.amount.greaterThan(d(String(base)))).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("matching de tres vías — el precio tolera, la cantidad no", () => {
  const l = (
    id: string,
    qo: string | null,
    qr: string | null,
    qi: string,
    po: string | null,
    pi: string,
  ) => ({
    lineId: id,
    quantityOrdered: qo === null ? null : d(qo),
    quantityReceived: qr === null ? null : d(qr),
    quantityInvoiced: d(qi),
    priceOrdered: po === null ? null : d(po),
    priceInvoiced: d(pi),
  });

  it("una diferencia de precio DENTRO del umbral no exige aprobación", () => {
    const r = matchThreeWay({
      lines: [l("L1", "10", "4", "4", "100", "102")],
      priceTolerancePct: d("5"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.priceDiffPct!.toFixed(2)).toBe("2.00");
    expect(r.value[0]!.requiresApproval).toBe(false);
  });

  it("y FUERA del umbral sí", () => {
    const r = matchThreeWay({
      lines: [l("L1", "10", "4", "4", "100", "120")],
      priceTolerancePct: d("5"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.requiresApproval).toBe(true);
    expect(r.value[0]!.issues).toContain("PRICE_ABOVE_TOLERANCE");
  });

  it("una diferencia de CANTIDAD se marca siempre, aunque el precio cuadre", () => {
    const r = matchThreeWay({
      lines: [l("L1", "10", "4", "6", "100", "100")],
      priceTolerancePct: d("5"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.issues).toContain("QUANTITY_MISMATCH");
    // Pero NO exige la aprobación de precio: son dos problemas distintos y se
    // resuelven distinto — la cantidad se recibe o se corrige, no se aprueba.
    expect(r.value[0]!.requiresApproval).toBe(false);
  });

  it("una factura sin orden ni recepción lo dice, no lo tolera en silencio", () => {
    const r = matchThreeWay({
      lines: [l("L1", null, null, "3", null, "100")],
      priceTolerancePct: d("5"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.issues).toContain("NO_ORDER");
    expect(r.value[0]!.issues).toContain("NO_RECEIPT");
    expect(r.value[0]!.priceDiffPct).toBeNull();
  });

  it("un precio pactado de cero no revienta el matching: da 100 %", () => {
    const r = matchThreeWay({
      lines: [l("L1", "1", "1", "1", "0", "50")],
      priceTolerancePct: d("5"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.priceDiffPct!.toFixed(0)).toBe("100");
    expect(r.value[0]!.requiresApproval).toBe(true);
  });
});
