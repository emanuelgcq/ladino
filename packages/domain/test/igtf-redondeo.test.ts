import { describe, expect, it } from "vitest";
import { parseDecimal } from "@ladino/money";
import { avisoIgtf, percibirIgtf } from "../src/index.js";

/**
 * ADR-0053 — la percepción de IGTF, redondeada a lo que la moneda sabe cobrar.
 *
 * Función pura: no toca la base. El E2E (`apps/api/test/e2e-igtf.test.ts`)
 * comprueba el cobro entero contra un oráculo en Postgres; aquí se fijan la
 * escala, el modo y el identificador de la política, que son las tres cosas
 * que el ADR decide.
 */
const d = (s: string) => {
  const r = parseDecimal(s);
  if (!r.ok) throw new Error(`decimal inválido en el test: ${s}`);
  return r.value;
};

describe("percibirIgtf", () => {
  it("un 3 % que no cae en un céntimo se redondea a la moneda: 35,45 → 1,06", () => {
    const r = percibirIgtf(d("35.45"), d("0.03"), "USD");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 1,0635 exacto — antes se persistía así.
    expect(r.value.monto.toFixed(8)).toBe("1.06000000");
    expect(r.value.policy.id).toBe("igtf:perception:2:HALF_UP");
  });

  it("lo que ya cae en céntimo queda igual: 10,00 → 0,30", () => {
    const r = percibirIgtf(d("10.00"), d("0.03"), "USD");
    expect(r.ok && r.value.monto.toFixed(8)).toBe("0.30000000");
  });

  it("en el empate exacto manda HALF_UP: 1,50 × 3 % = 0,045 → 0,05 (HALF_EVEN daría 0,04)", () => {
    const r = percibirIgtf(d("1.50"), d("0.03"), "USD");
    expect(r.ok && r.value.monto.toFixed(8)).toBe("0.05000000");
  });

  it("el funcional se redondea en SU moneda, desde el importe ya redondeado", () => {
    // 1,06 × 827,7371 = 877,401326 → Bs. 877,40 (no 865,408… del exacto).
    const r = percibirIgtf(d("1.06"), d("827.7371"), "VES");
    expect(r.ok && r.value.monto.toFixed(8)).toBe("877.40000000");
  });

  it("la escala sale de la moneda, no de una constante: la política la dice", () => {
    for (const moneda of ["USD", "VES"]) {
      const r = percibirIgtf(d("1"), d("1"), moneda);
      expect(r.ok && r.value.policy.scale).toBe(2);
    }
  });

  it("una moneda no registrada no se redondea a ciegas: falla", () => {
    const r = percibirIgtf(d("10"), d("0.03"), "XYZ");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("MONEY_ERROR");
  });
});

describe("avisoIgtf — la misma regla con los importes como viajan por la API", () => {
  it("devuelve el string canónico de 8 decimales", () => {
    const r = avisoIgtf("35.45", "0.03000000", "USD");
    expect(r.ok && r.value).toBe("1.06000000");
  });

  it("un importe que no es decimal no llega a calcularse", () => {
    const r = avisoIgtf("treinta", "0.03", "USD");
    expect(r.ok).toBe(false);
  });
});
