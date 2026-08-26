/**
 * Promedio ponderado móvil — propiedades escritas ANTES de la implementación (ADR-0016) y
 * ejemplos calculados a mano.
 *
 *   P1  el valor tras N movimientos es EXACTAMENTE Σ entradas − Σ costo de salidas (oráculo
 *       BigInt a 10^8, no decimal.js contra decimal.js);
 *   P2  el mismo recorrido, dos veces, da el mismo resultado campo por campo (determinismo);
 *   P3  con existencia positiva, |costo de salida − q × promedio exacto| < 1 unidad de 10^-8
 *       (el redondeo está en el importe, no en el promedio), y vaciar la posición deja valor 0
 *       EXACTO;
 *   P4  sin allowNegative, ninguna salida deja la cantidad por debajo de cero;
 *   P5  el costo unitario resultante es siempre no negativo y persistible.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, parseDecimal, type CurrencyCode } from "@ladino/money";
import {
  COST_ROUNDING_POLICY,
  adjust,
  emptyPosition,
  issue,
  parseQuantity,
  positionOf,
  receive,
  replay,
  type MoveInput,
  type StockPosition,
} from "../src/index.js";

const VES = "VES" as CurrencyCode;
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

// Cantidades e importes acotados para que N movimientos sigan dentro de numeric(24,8):
// cantidad ∈ [0.01, 10 000], costo ∈ [0, 100 000] → costo unitario ≤ 10^7, y 40 movimientos
// suman como mucho ~4·10^12. (Cantidad 10^-8 con costo 10^4 daba promedios de 10^12 y
// desbordaba al cuarto movimiento — el límite es del generador, no del modelo; el
// desbordamiento tiene su ejemplo explícito abajo.)
const arbQty = fc.bigInt({ min: 10n ** 6n, max: 10n ** 12n }).map((u) => dec(fmt(u)));
const arbCost = fc.bigInt({ min: 0n, max: 10n ** 13n }).map((u) => ves(fmt(u)));
// Cantidades hostiles (hasta 10^-8) para las propiedades que no acumulan.
const arbTinyQty = fc.bigInt({ min: 1n, max: 10n ** 12n }).map((u) => dec(fmt(u)));
function fmt(u: bigint): string {
  return `${u / SCALE}.${(u % SCALE).toString().padStart(8, "0")}`;
}

const arbMove: fc.Arbitrary<MoveInput> = fc.oneof(
  fc.record({ quantity: arbQty, cost: arbCost }).map((r) => ({ kind: "receive" as const, ...r })),
  arbQty.map((quantity) => ({ kind: "issue" as const, quantity })),
  fc
    .record({ delta: arbQty, sign: fc.boolean(), withCost: fc.option(arbCost, { nil: undefined }) })
    .map(({ delta, sign, withCost }) => ({
      kind: "adjust" as const,
      delta: sign ? delta : delta.negated(),
      ...(withCost !== undefined ? { unitCost: withCost } : {}),
    })),
);

describe("P1 — el valor es exactamente Σ entradas − Σ salidas (oráculo BigInt)", () => {
  // La propiedad es CONDICIONAL a propósito, y la condición se asserta: un recorrido
  // puede morir legítimamente porque el costo unitario resultante no cabe en
  // numeric(24,8) —una posición con cantidad diminuta y valor grande—. Lo destapó el
  // verify con otra semilla, no las 300 corridas de aquí: el generador de arriba está
  // acotado justo para no cruzar esa frontera, y la frontera tiene su ejemplo abajo.
  // Exigir `ok` siempre habría sido exigir que el modelo representara lo
  // irrepresentable; lo que sí se exige es que el ÚNICO motivo de fallo sea ese, y que
  // cuando hay resultado, cuadre al céntimo de 10^-8.
  it("con negativo permitido: cuadra exacto, y si falla es solo por no caber en numeric(24,8)", () => {
    fc.assert(
      fc.property(fc.array(arbMove, { maxLength: 40 }), (moves) => {
        const r = replay(emptyPosition(VES), moves, { allowNegative: true });
        if (!r.ok) {
          expect(r.error.code).toBe("MONEY");
          expect(r.error.details?.["moneyCode"]).toMatch(
            /MONEY_AMOUNT_OUT_OF_RANGE|MONEY_RESULT_NOT_REPRESENTABLE/,
          );
          return;
        }
        let oracle = 0n;
        for (const m of r.value.moves) oracle += units(m.value.toAmountString());
        expect(units(r.value.position.value.toAmountString())).toBe(oracle);
        // Y la cantidad también es una suma exacta.
        let q = 0n;
        for (const m of r.value.moves) q += units(m.quantity.toFixed(8));
        expect(units(r.value.position.quantity.toFixed(8))).toBe(q);
      }),
      { numRuns: 300 },
    );
  });
});

describe("P2 — determinismo: el mismo recorrido da el mismo resultado", () => {
  it("dos replays independientes coinciden campo por campo", () => {
    fc.assert(
      fc.property(fc.array(arbMove, { maxLength: 30 }), fc.boolean(), (moves, allowNegative) => {
        const a = replay(emptyPosition(VES), moves, { allowNegative });
        const b = replay(emptyPosition(VES), moves, { allowNegative });
        expect(a.ok).toBe(b.ok);
        if (!a.ok || !b.ok) {
          if (!a.ok && !b.ok) expect(a.error.code).toBe(b.error.code);
          return;
        }
        expect(a.value.moves.map(serialize)).toEqual(b.value.moves.map(serialize));
        expect(a.value.position.value.toAmountString()).toBe(
          b.value.position.value.toAmountString(),
        );
        expect(a.value.position.lastUnitCost.toAmountString()).toBe(
          b.value.position.lastUnitCost.toAmountString(),
        );
      }),
      { numRuns: 200 },
    );
  });
});

function serialize(m: {
  quantity: { toFixed(n: number): string };
  value: Money;
  unitCostAfter: Money;
  quantityAfter: { toFixed(n: number): string };
  valueAfter: Money;
}) {
  return [
    m.quantity.toFixed(8),
    m.value.toAmountString(),
    m.unitCostAfter.toAmountString(),
    m.quantityAfter.toFixed(8),
    m.valueAfter.toAmountString(),
  ];
}

describe("P3 — el redondeo vive en el importe de la salida, no en el promedio", () => {
  it("|costo − q × valor/existencia| < 10^-8 y vaciar deja valor 0 exacto", () => {
    fc.assert(
      fc.property(arbTinyQty, arbCost, arbTinyQty, (have, value, take) => {
        const pos = must(receive(emptyPosition(VES), have, value)).position;
        const q = take.greaterThan(have) ? have : take; // dentro de la existencia
        const out = must(issue(pos, q, { allowNegative: false }));
        const exact = value.amount.times(q).div(have); // 50 dígitos significativos
        const diff = out.move.value.amount.negated().minus(exact).abs();
        expect(diff.lessThan("0.00000001")).toBe(true);
        if (q.equals(have)) {
          expect(out.position.value.isZero()).toBe(true);
          expect(out.position.quantity.isZero()).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe("P4 — sin política explícita no hay negativo", () => {
  it("una salida mayor que la existencia es NEGATIVE_STOCK; con la política, la posición queda valorada", () => {
    fc.assert(
      fc.property(arbQty, arbCost, arbQty, (have, value, extra) => {
        const pos = must(receive(emptyPosition(VES), have, value)).position;
        const q = have.plus(extra);
        const r = issue(pos, q, { allowNegative: false });
        expect(!r.ok && r.error.code).toBe("NEGATIVE_STOCK");
        const ok = must(issue(pos, q, { allowNegative: true }));
        expect(ok.position.quantity.isNegative()).toBe(true);
        // Todo el valor salió, y el exceso se valoró al promedio.
        expect(ok.position.value.isNegative() || ok.position.value.isZero()).toBe(true);
        expect(ok.position.lastUnitCost.toAmountString()).toBe(pos.lastUnitCost.toAmountString());
      }),
      { numRuns: 200 },
    );
  });
});

describe("P5 — el costo unitario resultante es no negativo y persistible", () => {
  it("en todo recorrido, INCLUSO con negativo permitido (el residuo va al valor, no al promedio)", () => {
    fc.assert(
      fc.property(fc.array(arbMove, { maxLength: 25 }), (moves) => {
        const r = replay(emptyPosition(VES), moves, { allowNegative: true });
        if (!r.ok) return;
        for (const m of r.value.moves) {
          expect(m.unitCostAfter.isNegative()).toBe(false);
          expect(m.unitCostAfter.toAmountString()).toMatch(/^\d{1,16}\.\d{8}$/);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("ejemplos calculados a mano (los mismos que pgTAP 019)", () => {
  it("10 @ 100 + 5 @ 130 → promedio 110; salida 3 → 330; entrada 7 @ 123.45678901 → promedio 114.95776437", () => {
    const p0 = emptyPosition(VES);
    const e1 = must(receive(p0, dec("10"), ves("1000")));
    expect(e1.move.unitCostAfter.toAmountString()).toBe("100.00000000");
    const e2 = must(receive(e1.position, dec("5"), ves("650")));
    expect(e2.position.value.toAmountString()).toBe("1650.00000000");
    expect(e2.move.unitCostAfter.toAmountString()).toBe("110.00000000");
    const s1 = must(issue(e2.position, dec("3"), { allowNegative: false }));
    expect(s1.move.value.toAmountString()).toBe("-330.00000000");
    expect(s1.position.quantity.toFixed()).toBe("12");
    expect(s1.position.value.toAmountString()).toBe("1320.00000000");
    // 7 × 123.45678901 = 864.19752307 exacto
    const e3 = must(receive(s1.position, dec("7"), ves("864.19752307")));
    expect(e3.position.value.toAmountString()).toBe("2184.19752307");
    // 2184.19752307 / 19 = 114.9577643721052… → HALF_UP a 8 → 114.95776437
    expect(e3.move.unitCostAfter.toAmountString()).toBe("114.95776437");
    const s2 = must(issue(e3.position, dec("19"), { allowNegative: false }));
    expect(s2.move.value.toAmountString()).toBe("-2184.19752307");
    expect(s2.position.value.isZero()).toBe(true);
    expect(s2.position.lastUnitCost.toAmountString()).toBe("114.95776437");
  });

  it("empate exacto: 1 unidad a 0.000000005 de valor → HALF_UP sube (la política que persiste)", () => {
    // valor 0.00000001 con existencia 2: salida de 1 → 0.000000005 → 0.00000001
    const p = must(receive(emptyPosition(VES), dec("2"), ves("0.00000001"))).position;
    const s = must(issue(p, dec("1"), { allowNegative: false }));
    expect(s.move.value.toAmountString()).toBe("-0.00000001");
    expect(COST_ROUNDING_POLICY.mode).toBe("HALF_UP");
  });

  it("negativo y luego entrada barata: el promedio NO se vuelve negativo, el residuo queda en el valor", () => {
    const p = must(receive(emptyPosition(VES), dec("1"), ves("100"))).position;
    const neg = must(issue(p, dec("3"), { allowNegative: true })).position; // -2 uds, -200
    expect(neg.value.toAmountString()).toBe("-200.00000000");
    const back = must(receive(neg, dec("3"), ves("0")));
    expect(back.position.quantity.toFixed()).toBe("1");
    expect(back.position.value.toAmountString()).toBe("-200.00000000"); // P1: la suma exacta
    expect(back.move.unitCostAfter.toAmountString()).toBe("100.00000000"); // arrastrado, no -200
    // Y una salida con valor negativo se valora al arrastrado, no al cociente sin sentido.
    const out = must(issue(back.position, dec("1"), { allowNegative: false }));
    expect(out.move.value.toAmountString()).toBe("-100.00000000");
    expect(out.position.value.toAmountString()).toBe("-300.00000000"); // el residuo sigue visible
  });

  it("un promedio que no cabe en numeric(24,8) FALLA, no se aproxima ni se arrastra", () => {
    // La clase de caso que encontró el property test bajo otra semilla: una posición
    // con una cantidad diminuta y un valor grande tiene un costo unitario que no es
    // representable. 200 000 000 / 10^-8 = 2·10^16, y el máximo de numeric(24,8) es
    // 9 999 999 999 999 999,99999999. El sistema NO lo aproxima: falla, y el esquema
    // falla igual en el mismo punto (22003, numeric field overflow).
    const r = receive(emptyPosition(VES), dec("0.00000001"), ves("200000000"));
    expect(!r.ok && r.error.code).toBe("MONEY");
    expect(!r.ok && r.error.details?.["moneyCode"]).toBe("MONEY_AMOUNT_OUT_OF_RANGE");
    // Y justo por debajo del borde sí entra: la cota es la del tipo, no un margen.
    const ok = must(receive(emptyPosition(VES), dec("0.00000001"), ves("99999999.99999999")));
    expect(ok.move.unitCostAfter.toAmountString()).toBe("9999999999999999.00000000");
  });

  it("existencia cero: la salida se valora al último promedio conocido", () => {
    const p = must(receive(emptyPosition(VES), dec("4"), ves("400"))).position;
    const vacia = must(issue(p, dec("4"), { allowNegative: false })).position;
    expect(vacia.lastUnitCost.toAmountString()).toBe("100.00000000");
    const neg = must(issue(vacia, dec("2"), { allowNegative: true }));
    expect(neg.move.value.toAmountString()).toBe("-200.00000000");
    expect(neg.position.quantity.toFixed()).toBe("-2");
    expect(neg.position.value.toAmountString()).toBe("-200.00000000");
  });

  it("límite de numeric(24,8): una entrada al máximo entra y sale entera", () => {
    const max = "9999999999999999.99999999";
    const e = must(receive(emptyPosition(VES), dec("1"), ves(max)));
    expect(e.move.unitCostAfter.toAmountString()).toBe(max);
    const s = must(issue(e.position, dec("1"), { allowNegative: false }));
    expect(s.position.value.isZero()).toBe(true);
    // Y dos entradas al máximo NO caben: el error es explícito, no un desbordamiento silencioso.
    const doble = receive(e.position, dec("1"), ves(max));
    expect(!doble.ok && doble.error.code).toBe("MONEY");
  });

  it("ajuste positivo sin costo entra al promedio vigente; negativo sale como salida", () => {
    const p = must(receive(emptyPosition(VES), dec("10"), ves("250"))).position; // 25.00
    const up = must(adjust(p, dec("2"), { allowNegative: false }));
    expect(up.move.value.toAmountString()).toBe("50.00000000");
    const down = must(adjust(up.position, dec("-12"), { allowNegative: false }));
    expect(down.position.value.isZero()).toBe(true);
    const conCosto = must(
      adjust(down.position, dec("1"), { allowNegative: false, unitCost: ves("7") }),
    );
    expect(conCosto.move.value.toAmountString()).toBe("7.00000000");
  });

  it("la moneda de la posición manda: un costo en otra moneda es CURRENCY_MISMATCH", () => {
    const r = receive(emptyPosition(VES), dec("1"), must(Money.of("1", "USD")));
    expect(!r.ok && r.error.code).toBe("CURRENCY_MISMATCH");
  });

  it("parseQuantity: cero, negativo, exponente y más de 8 decimales se rechazan", () => {
    for (const bad of ["0", "-1", "1e3", "1.123456789", "abc", ""]) {
      expect(parseQuantity(bad).ok).toBe(false);
    }
    expect(must(parseQuantity("0.00000001")).toFixed()).toBe("0.00000001");
  });

  it("positionOf reconstruye desde strings de la base", () => {
    const p: StockPosition = must(
      positionOf({
        quantity: "3",
        value: "30.00000000",
        lastUnitCost: "10.00000000",
        currency: "VES",
      }),
    );
    expect(must(issue(p, dec("1"), { allowNegative: false })).move.value.toAmountString()).toBe(
      "-10.00000000",
    );
  });
});
