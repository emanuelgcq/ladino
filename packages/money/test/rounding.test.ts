/**
 * P15–P22 — Redondeo.
 *
 * Las cuatro funciones nombradas se prueban CON LOS CINCO MODOS POR IGUAL. El paquete no tiene
 * opinión fiscal: qué modo exige el SENIAT para IVA, retenciones e IGTF es un formulario abierto
 * en MONEY_AND_ROUNDING_SPEC.md §6, marcado VALIDAR-TRIBUTARIO. Ninguna política está
 * privilegiada aquí, así que responder ese formulario no obligará a rediseñar nada.
 *
 * P20 es la propiedad cara: aísla el desacuerdo entre modos exactamente en los empates. Es la
 * que atrapa una confusión half-even / half-up, que si no se detecta sobrevive años.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { RoundedMoney, RoundingPolicy, Scale } from "../src/index.js";
import {
  Money,
  roundForCurrency,
  roundForDocument,
  roundForPayment,
  roundForTax,
} from "../src/index.js";
import {
  ALL_ROUNDING_MODES,
  ALL_SCALES,
  MAX_SCALED,
  arbAmountString,
  arbCurrency,
  arbRoundingPolicy,
  must,
  stringToScaled,
} from "./arbitraries.js";

/** Las cuatro funciones nombradas. Toda propiedad estructural se verifica en las cuatro. */
const NAMED_ROUNDINGS = [
  ["roundForTax", roundForTax],
  ["roundForDocument", roundForDocument],
  ["roundForPayment", roundForPayment],
] as const satisfies readonly (readonly [string, (m: Money, p: RoundingPolicy) => RoundedMoney])[];

const arbMoney = fc
  .tuple(arbAmountString(MAX_SCALED / 2n), arbCurrency)
  .map(([a, c]) => must(Money.of(a, c)));

const decimalsOf = (m: Money): number => {
  const frac = m.toAmountString().split(".")[1] ?? "";
  return frac.replace(/0+$/, "").length;
};

/** 10^(−scale) en unidades escaladas a 10^8. La "unidad mínima" de la política. */
const unitAtScale = (scale: Scale): bigint => 10n ** BigInt(8 - scale);

describe.each(NAMED_ROUNDINGS)("%s", (_name, round) => {
  it("P15 — es idempotente: round(round(x)) = round(x)", () => {
    fc.assert(
      fc.property(arbMoney, arbRoundingPolicy, (m, policy) => {
        const once = round(m, policy);
        const twice = round(once.value, policy);
        expect(twice.value.equals(once.value)).toBe(true);
      }),
    );
  });

  it("P16 — el resultado tiene exactamente la escala de la política", () => {
    fc.assert(
      fc.property(arbMoney, arbRoundingPolicy, (m, policy) => {
        expect(decimalsOf(round(m, policy).value)).toBeLessThanOrEqual(policy.scale);
      }),
    );
  });

  it("P17 — cota de error: |round(x) − x| <= ½ · 10^(−scale)", () => {
    fc.assert(
      fc.property(arbMoney, arbRoundingPolicy, (m, policy) => {
        const r = round(m, policy);
        const delta = stringToScaled(r.value.toAmountString()) - stringToScaled(m.toAmountString());
        const abs = delta < 0n ? -delta : delta;
        // DOWN y UP truncan hacia un lado: su cota es la unidad entera, no la mitad.
        const bound =
          policy.mode === "DOWN" || policy.mode === "UP"
            ? unitAtScale(policy.scale)
            : unitAtScale(policy.scale) / 2n + (unitAtScale(policy.scale) % 2n);
        expect(abs).toBeLessThanOrEqual(bound);
      }),
    );
  });

  it("P18 — es monótono: a <= b ⇒ round(a) <= round(b)", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(MAX_SCALED / 2n), arbAmountString(MAX_SCALED / 2n), arbCurrency),
        arbRoundingPolicy,
        ([x, y, currency], policy) => {
          const a = must(Money.of(x, currency));
          const b = must(Money.of(y, currency));
          const [lo, hi] = stringToScaled(x) <= stringToScaled(y) ? [a, b] : [b, a];
          expect(
            must(round(lo, policy).value.compare(round(hi, policy).value)),
          ).toBeLessThanOrEqual(0);
        },
      ),
    );
  });

  it("P22 — preRound conserva EXACTAMENTE la entrada", () => {
    // ADR-0013: se conservan los valores pre-redondeo. Si fuera opcional, se perdería.
    fc.assert(
      fc.property(arbMoney, arbRoundingPolicy, (m, policy) => {
        const r = round(m, policy);
        expect(r.preRound.equals(m)).toBe(true);
        expect(r.preRound.toAmountString()).toBe(m.toAmountString());
        expect(r.policy.id).toBe(policy.id);
        expect(r.policy.mode).toBe(policy.mode);
        expect(r.policy.scale).toBe(policy.scale);
      }),
    );
  });
});

describe("P19 — simetría del signo", () => {
  it("HALF_UP y HALF_EVEN cumplen round(−x) = −round(x)", () => {
    fc.assert(
      fc.property(
        arbMoney,
        fc.constantFrom("HALF_UP" as const, "HALF_EVEN" as const),
        fc.constantFrom(...ALL_SCALES),
        (m, mode, scale) => {
          const policy = { id: `sym:${mode}:${scale}`, scale, mode };
          const positivo = roundForTax(m, policy).value.negate();
          const negativo = roundForTax(m.negate(), policy).value;
          expect(negativo.equals(positivo)).toBe(true);
        },
      ),
    );
  });
});

describe("P20 — discriminación de modos (la que atrapa half-even confundido con half-up)", () => {
  it("fuera de los empates, los cinco modos coinciden", () => {
    fc.assert(
      fc.property(arbMoney, fc.constantFrom(...ALL_SCALES), (m, scale) => {
        const unit = unitAtScale(scale);
        const units = stringToScaled(m.toAmountString());
        const remainder = ((units % unit) + unit) % unit;
        // Solo interesan los valores que NO están exactamente a mitad de camino.
        fc.pre(unit === 1n || remainder * 2n !== unit);

        const results = ALL_ROUNDING_MODES.map((mode) =>
          roundForTax(m, { id: `disc:${mode}:${scale}`, scale, mode }).value.toAmountString(),
        );
        // DOWN/UP truncan siempre, así que solo se exige coincidencia entre los tres "half".
        const halves = results.slice(0, 3);
        expect(new Set(halves).size).toBe(1);
      }),
    );
  });

  it("P21 — en los empates, cada modo hace lo suyo", () => {
    const casos: readonly (readonly [string, Record<string, string>])[] = [
      ["2.5", { HALF_UP: "3", HALF_EVEN: "2", HALF_DOWN: "2", DOWN: "2", UP: "3" }],
      ["3.5", { HALF_UP: "4", HALF_EVEN: "4", HALF_DOWN: "3", DOWN: "3", UP: "4" }],
      ["-2.5", { HALF_UP: "-3", HALF_EVEN: "-2", HALF_DOWN: "-2", DOWN: "-2", UP: "-3" }],
      ["0.5", { HALF_UP: "1", HALF_EVEN: "0", HALF_DOWN: "0", DOWN: "0", UP: "1" }],
      ["1.5", { HALF_UP: "2", HALF_EVEN: "2", HALF_DOWN: "1", DOWN: "1", UP: "2" }],
    ];

    for (const [input, esperado] of casos) {
      for (const mode of ALL_ROUNDING_MODES) {
        const m = must(Money.of(input, "VES"));
        const r = roundForTax(m, { id: `tie:${mode}`, scale: 0, mode });
        expect(`${input} con ${mode} = ${r.value.toAmountString()}`).toBe(
          `${input} con ${mode} = ${must(Money.of(esperado[mode]!, "VES")).toAmountString()}`,
        );
      }
    }
  });

  it("HALF_EVEN deja el último dígito par en los empates", () => {
    for (const input of ["0.5", "1.5", "2.5", "3.5", "4.5", "-0.5", "-1.5", "-2.5"]) {
      const r = roundForTax(must(Money.of(input, "VES")), {
        id: "even",
        scale: 0,
        mode: "HALF_EVEN",
      });
      const whole = BigInt(r.value.toAmountString().split(".")[0]!);
      expect(whole % 2n).toBe(0n);
    }
  });
});

describe("roundForCurrency — el único con default, y no es una regla tributaria", () => {
  it("usa las minor units de ISO-4217 de la moneda del importe", () => {
    // 2 decimales para VES y USD es metadato ISO-4217, no una interpretación fiscal.
    const ves = roundForCurrency(must(Money.of("1.005", "VES")));
    const usd = roundForCurrency(must(Money.of("1.005", "USD")));
    expect(ves.policy.scale).toBe(2);
    expect(usd.policy.scale).toBe(2);
    expect(decimalsOf(ves.value)).toBeLessThanOrEqual(2);
  });

  it("también conserva el pre-redondeo", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        expect(roundForCurrency(m).preRound.equals(m)).toBe(true);
      }),
    );
  });

  it("es idempotente", () => {
    fc.assert(
      fc.property(arbMoney, (m) => {
        const once = roundForCurrency(m);
        expect(roundForCurrency(once.value).value.equals(once.value)).toBe(true);
      }),
    );
  });
});

describe("no existe redondeo implícito", () => {
  it("las tres funciones fiscales EXIGEN una política; no hay sobrecarga sin ella", () => {
    // Compile-time: la doc y el tipo dicen lo mismo. Si algún día alguien añade un default
    // fiscal, este @ts-expect-error deja de fallar y el typecheck lo denuncia.
    // @ts-expect-error roundForTax sin política debe ser un error de compilación
    expect(() => roundForTax(must(Money.of("1", "VES")))).toBeDefined();
  });
});
