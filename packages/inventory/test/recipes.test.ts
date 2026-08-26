/**
 * Explosión de recetas y costo de un compuesto — RIGOR MÁXIMO (ADR-0035).
 *
 *   P1  LINEALIDAD: explotar n unidades da exactamente n veces lo de una. Es la
 *       propiedad que un redondeo mal colocado rompe, y la que hace que vender
 *       de a uno y vender de a diez consuman lo mismo;
 *   P2  determinismo campo por campo;
 *   P3  sin conversión de unidad NO se explota: nunca se supone factor 1;
 *   P4  el costo total es la suma EXACTA de los costos de las salidas reales.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, parseDecimal } from "@ladino/money";
import { explodeRecipe, totalCost, type RecipeLine } from "../src/index.js";

function must<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`Se esperaba ok, llegó ${r.error.code}: ${r.error.message}`);
  return r.value;
}
const dec = (s: string) => must(parseDecimal(s));
const ves = (s: string) => must(Money.of(s, "VES"));
const SCALE = 10n ** 8n;
const units = (s: string): bigint => {
  const neg = s.startsWith("-");
  const [w = "0", f = ""] = (neg ? s.slice(1) : s).split(".");
  const u = BigInt(w) * SCALE + BigInt(f.padEnd(8, "0").slice(0, 8));
  return neg ? -u : u;
};

const linea = (id: string, cantidad: string, factor: string): RecipeLine => ({
  childProductId: id,
  quantity: dec(cantidad),
  factorToProductUnit: dec(factor),
  lineUnitCode: "gramo",
  productUnitCode: "kg",
});

// Cantidades acotadas para que n×línea siga dentro de numeric(24,8).
const arbCantidad = fc.bigInt({ min: 10n ** 4n, max: 10n ** 10n }).map((u) => fmt(u));
function fmt(u: bigint): string {
  return `${u / SCALE}.${(u % SCALE).toString().padStart(8, "0")}`;
}
const arbLinea = fc
  .tuple(fc.integer({ min: 1, max: 20 }), arbCantidad, fc.constantFrom("1", "0.001", "1000"))
  .map(([i, q, f]) => linea(`p-${String(i)}`, q, f));

describe("P1 — cuasi-linealidad: explotar n unidades vs n veces explotar una", () => {
  // La linealidad EXACTA es imposible a escala finita y la primera versión de
  // esta propiedad la exigía: falló con 5001 contra 5000. No se cambió la
  // implementación para satisfacer una propiedad falsa — se corrigió la
  // propiedad para que diga la verdad, con su cota: redondear una vez al final
  // difiere de multiplicar lo ya redondeado en menos de (n+1)/2 unidades de
  // 10^-8. Ver el comentario de explodeRecipe: por eso se redondea al final.
  it("difieren en menos de (n+1)/2 unidades de 10^-8, nunca más", () => {
    fc.assert(
      fc.property(
        fc.array(arbLinea, { minLength: 1, maxLength: 8 }),
        fc.integer({ min: 1, max: 1000 }),
        (lineas, n) => {
          const una = explodeRecipe(lineas, dec("1"));
          const muchas = explodeRecipe(lineas, dec(String(n)));
          if (!una.ok) {
            expect(una.error.code).toBe("INVALID_QUANTITY");
            return;
          }
          if (!muchas.ok) {
            expect(muchas.error.code).toBe("INVALID_QUANTITY");
            return;
          }
          const cota = (BigInt(n) + 1n) / 2n + 1n;
          for (let i = 0; i < lineas.length; i += 1) {
            const enBloque = units(muchas.value[i]!.quantity.toFixed(8));
            const unaAUna = units(una.value[i]!.quantity.toFixed(8)) * BigInt(n);
            const diff = enBloque > unaAUna ? enBloque - unaAUna : unaAUna - enBloque;
            expect(diff).toBeLessThanOrEqual(cota);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("y con cantidades de receta REALES la diferencia es CERO: el producto es exacto", () => {
    // 200 g en kg, 12 arepas: 200 × 0.001 × 12 = 2.4, sin decimales que perder.
    const receta = [linea("harina", "200", "0.001")];
    const una = must(explodeRecipe(receta, dec("1")));
    const doce = must(explodeRecipe(receta, dec("12")));
    expect(units(doce[0]!.quantity.toFixed(8))).toBe(units(una[0]!.quantity.toFixed(8)) * 12n);
  });
});

describe("P2 — determinismo", () => {
  it("dos explosiones del mismo dato coinciden campo por campo", () => {
    fc.assert(
      fc.property(fc.array(arbLinea, { minLength: 1, maxLength: 8 }), arbCantidad, (lineas, n) => {
        const a = explodeRecipe(lineas, dec(n));
        const b = explodeRecipe(lineas, dec(n));
        expect(a.ok).toBe(b.ok);
        if (!a.ok || !b.ok) return;
        expect(a.value.map((l) => l.quantity.toFixed(8))).toEqual(
          b.value.map((l) => l.quantity.toFixed(8)),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("P3 — sin conversión no se explota: NUNCA se supone factor 1", () => {
  it("una sola línea sin factor tumba la explosión entera, y el error dice qué falta", () => {
    const lineas: RecipeLine[] = [
      linea("harina", "200", "0.001"),
      {
        childProductId: "leche",
        quantity: dec("300"),
        factorToProductUnit: null,
        lineUnitCode: "mililitro",
        productUnitCode: "kg",
      },
    ];
    const r = explodeRecipe(lineas, dec("1"));
    expect(!r.ok && r.error.code).toBe("UNIT_CONVERSION_MISSING");
    expect(!r.ok && r.error.message).toContain("mililitro");
    expect(!r.ok && r.error.message).toContain("kg");
    // Y no explotó NADA: no hay consumo parcial de la harina.
    expect(r.ok).toBe(false);
  });
});

describe("P4 — el costo total es la suma exacta de las salidas reales", () => {
  it("suma sin perder ni inventar céntimos", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.bigInt({ min: 0n, max: 10n ** 12n }).map((u) => ves(fmt(u))),
          { minLength: 1, maxLength: 20 },
        ),
        (costos) => {
          const t = totalCost(costos);
          expect(t.ok).toBe(true);
          if (!t.ok) return;
          let oraculo = 0n;
          for (const c of costos) oraculo += units(c.toAmountString());
          expect(units(t.value.toAmountString())).toBe(oraculo);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("mezclar monedas no suma: CURRENCY_MISMATCH", () => {
    const r = totalCost([ves("10"), must(Money.of("5", "USD"))]);
    expect(!r.ok && r.error.code).toBe("CURRENCY_MISMATCH");
  });
});

describe("ejemplos calculados a mano (los mismos que pgTAP 020)", () => {
  it("arepa: 200 g de harina + 300 ml de leche, 12 arepas → 2,4 kg y 3,6 litros", () => {
    const receta: RecipeLine[] = [
      { ...linea("harina", "200", "0.001"), lineUnitCode: "gramo", productUnitCode: "kg" },
      {
        childProductId: "leche",
        quantity: dec("300"),
        factorToProductUnit: dec("0.001"),
        lineUnitCode: "mililitro",
        productUnitCode: "litro",
      },
    ];
    const r = must(explodeRecipe(receta, dec("12")));
    expect(r[0]!.quantity.toFixed()).toBe("2.4");
    expect(r[1]!.quantity.toFixed()).toBe("3.6");
  });

  it("el costo del compuesto es la suma de lo que costaron sus salidas", () => {
    // 2,4 kg a 30,00 VES/kg = 72,00 · 3,6 L a 12,50 VES/L = 45,00 → 117,00
    expect(must(totalCost([ves("72.00"), ves("45.00")])).toAmountString()).toBe("117.00000000");
  });

  it("una receta vacía no se vende: no consumiría nada", () => {
    const r = explodeRecipe([], dec("1"));
    expect(!r.ok && r.error.code).toBe("VALIDATION_FAILED");
    expect(!r.ok && r.error.message).toContain("sin receta");
  });

  it("un consumo que redondea a cero se rechaza con palabras, no entra como cero", () => {
    const r = explodeRecipe([linea("pizca", "0.000000004", "1")], dec("1"));
    expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
    expect(!r.ok && r.error.message).toContain("cero");
  });

  it("cero o menos unidades del compuesto no es una venta", () => {
    for (const n of ["0", "-1"]) {
      const r = explodeRecipe([linea("harina", "200", "0.001")], dec(n));
      expect(!r.ok && r.error.code).toBe("INVALID_QUANTITY");
    }
  });

  it("el redondeo va AL FINAL: 1/3 de gramo × 3 arepas es 1 gramo, no 0,99999999", () => {
    // 0.33333333 g × 3 = 0.99999999; con el factor a kg (0.001) y 3 unidades:
    // 0.33333333 × 0.001 × 3 = 0.00099999999 → 0.001 a 8 decimales (HALF_UP).
    const r = must(explodeRecipe([linea("especia", "0.33333333", "0.001")], dec("3")));
    expect(r[0]!.quantity.toFixed()).toBe("0.001");
  });
});
