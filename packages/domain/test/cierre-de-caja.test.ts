import { describe, expect, it } from "vitest";
import { parseDecimal, type Decimal } from "@ladino/money";
import { hechoContableDelCierre } from "../src/treasury.js";

/**
 * QUÉ HECHO CONTABLE ES UN CIERRE DE CAJA CON DIFERENCIA (J-02). `hechoContableDelCierre` es pura
 * y decide dos cosas que no pueden separarse: el ORIGEN del asiento (`cash_closing` o
 * `cash_closing_overdraft`) y sus importes. El borde que la revisión reprodujo: un saldo negativo
 * por debajo del céntimo redondea a −0, y `Decimal(-0).isNegative()` es `true`: un sobrante
 * normal se asentaba con el origen del sobregiro. «En negativo» es «menor que cero en las
 * unidades mínimas de la moneda de la caja», y lo decide la función, no quien la llama.
 */
const d = (v: string): Decimal => {
  const r = parseDecimal(v);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};

/** (esperado, diferencia funcional, tasa) con caja y empresa al céntimo. */
const hecho = (esperado: string, dif: string, tasa = "1") =>
  hechoContableDelCierre(d(esperado), d(dif), d(tasa), 2, 2);

describe("hechoContableDelCierre", () => {
  it("−0 no es negativo: sobrante de siempre", () => {
    const menosCero = d("-0.004").toDecimalPlaces(2, 4);
    expect(menosCero.isNegative()).toBe(true); // el borde: por eso no se decide con isNegative()
    expect(hechoContableDelCierre(menosCero, d("15"), d("1"), 2, 2)).toEqual({
      sourceKind: "cash_closing",
      palabra: "sobrante",
      amounts: { functional_amount: "15.00000000" },
    });
  });

  it("−0,004 (por debajo del céntimo) tampoco es un sobregiro, llegue redondeado o no", () => {
    expect(hecho("-0.004", "15")).toEqual({
      sourceKind: "cash_closing",
      palabra: "sobrante",
      amounts: { functional_amount: "15.00000000" },
    });
  });

  it("en cero con faltante: el de siempre, con su signo", () => {
    expect(hecho("0", "-5")).toEqual({
      sourceKind: "cash_closing",
      palabra: "faltante",
      amounts: { functional_amount: "-5.00000000" },
    });
  });

  it("positivo con sobrante: el de siempre", () => {
    expect(hecho("30", "15")).toEqual({
      sourceKind: "cash_closing",
      palabra: "sobrante",
      amounts: { functional_amount: "15.00000000" },
    });
  });

  it("negativo contado en cero: todo es del dueño, sin sobrante", () => {
    expect(hecho("-120", "120")).toEqual({
      sourceKind: "cash_closing_overdraft",
      palabra: "sobregiro cubierto por el dueño",
      amounts: {
        total: "120.00000000",
        owner_contribution: "120.00000000",
        functional_amount: "0.00000000",
      },
    });
  });

  it("negativo contado por encima de cero: se parte, y las partes suman el total", () => {
    expect(hecho("-80", "110")).toEqual({
      sourceKind: "cash_closing_overdraft",
      palabra: "sobregiro cubierto por el dueño",
      amounts: {
        total: "110.00000000",
        owner_contribution: "80.00000000",
        functional_amount: "30.00000000",
      },
    });
  });

  it("caja en divisa: USD −10 a 40,123456 contado 0 → 401,23 = 401,23 + 0", () => {
    expect(hecho("-10", "401.23", "40.123456").amounts).toEqual({
      total: "401.23000000",
      owner_contribution: "401.23000000",
      functional_amount: "0.00000000",
    });
  });

  it("el céntimo en −0,01 sí es un sobregiro", () => {
    expect(hecho("-0.01", "0.01").sourceKind).toBe("cash_closing_overdraft");
  });
});
