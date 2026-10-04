import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseDecimal } from "@ladino/money";
import { toleranciaDeCaja } from "../src/tolerancia-de-caja.js";

/**
 * ADR-0063 §2 / ADR-0075 (nota «el pago cruzado a tasa real»): la tolerancia de caja de un pago
 * que cruza monedas. Función pura. El E2E (`e2e-moneda-diferencial`, bloque «compras: el pago
 * cruzado a TASA REAL») comprueba el pago entero; aquí se fijan las cifras de la regla.
 */
const d = (s: string) => {
  const r = parseDecimal(s);
  if (!r.ok) throw new Error(`decimal inválido en el test: ${s}`);
  return r.value;
};

describe("toleranciaDeCaja", () => {
  it("factura en Bs, dinero en USD a 854,4637: medio céntimo de dólar son 4,2723185 Bs, sin redondear hacia arriba", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "VES",
      tasaDinero: d("854.4637"),
      tasaDocumento: d("1"),
    });
    expect(t.toFixed(8)).toBe("4.27231850");
  });

  it("factura en USD, dinero en Bs: el dinero es más fino que el documento y queda el medio céntimo de dólar de siempre", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "VES",
      monedaDocumento: "USD",
      tasaDinero: d("1"),
      tasaDocumento: d("854.4637"),
    });
    expect(t.toFixed(8)).toBe("0.00500000");
  });

  it("sin cruzar no hay conversión: medio céntimo de la moneda, a cualquier tasa", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "USD",
      tasaDinero: d("854.4637"),
      tasaDocumento: d("854.4637"),
    });
    expect(t.toFixed(8)).toBe("0.00500000");
  });

  it("a 40 Bs por dólar son 0,20 Bs: la tasa cómoda de los E2E escondía el defecto", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "VES",
      tasaDinero: d("40"),
      tasaDocumento: d("1"),
    });
    expect(t.toFixed(8)).toBe("0.20000000");
  });

  it("se convierte por las DOS tasas del día: con la tasa de la factura en 2, la mitad", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "VES",
      tasaDinero: d("854.4637"),
      tasaDocumento: d("2"),
    });
    // 0,005 USD × 854,4637 ÷ 2 = 2,13615925.
    expect(t.toFixed(8)).toBe("2.13615925");
  });

  /**
   * LA REGLA DE VENTAS, tal como `registerPayment` la calcula en línea («EL COBRO QUE CIERRA»,
   * `sales.ts`): media unidad mínima de la moneda del cobro × la tasa del cobro, en moneda
   * FUNCIONAL. Ventas no exporta una función (deuda anotada en ADR-0075: una sola para los dos
   * lados), así que aquí se copia la fórmula y se comprueba que el fuente sigue diciéndola.
   */
  const toleranciaDeVentas = (tasaCobro: string): string =>
    d("0.01").dividedBy(2).times(d(tasaCobro)).toFixed(8);

  it("ventas sigue calculando su tolerancia con la fórmula que este test copia", () => {
    const fuente = readFileSync(fileURLToPath(new URL("../src/sales.ts", import.meta.url)), "utf8");
    expect(fuente).toContain(
      "const toleranciaCaja = unidadMinima(input.currency).dividedBy(2).times(tasaCobroDec.value);",
    );
  });

  it("COINCIDE con ventas en el caso común: documento en Bs (la moneda funcional), dinero en USD a 854,4637 → 4,27231850 en los dos lados", () => {
    const compras = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "VES",
      tasaDinero: d("854.4637"),
      tasaDocumento: d("1"),
    });
    expect(compras.toFixed(8)).toBe("4.27231850");
    expect(toleranciaDeVentas("854.4637")).toBe("4.27231850");
    expect(compras.toFixed(8)).toBe(toleranciaDeVentas("854.4637"));
  });

  it("DIFIERE de ventas cuando el documento vive en divisa: documento en USD y dinero en Bs — ventas tolera 0,005 Bs funcionales; compras, 0,005 USD (4,27 Bs a esa tasa)", () => {
    const compras = toleranciaDeCaja({
      monedaDinero: "VES",
      monedaDocumento: "USD",
      tasaDinero: d("1"),
      tasaDocumento: d("854.4637"),
    });
    // Compras: en la moneda del documento, con el suelo de media unidad del documento.
    expect(compras.toFixed(8)).toBe("0.00500000");
    // Ventas: en moneda funcional, sin suelo (el cobro en Bs vale 1).
    expect(toleranciaDeVentas("1")).toBe("0.00500000");
    // La misma cifra escrita, en monedas distintas: llevada a Bs, la de compras es 854 veces mayor.
    expect(compras.times(d("854.4637")).toFixed(8)).toBe("4.27231850");
    expect(compras.times(d("854.4637")).toFixed(8)).not.toBe(toleranciaDeVentas("1"));
  });

  it("una tasa del documento en cero no divide: queda la media unidad del documento", () => {
    const t = toleranciaDeCaja({
      monedaDinero: "USD",
      monedaDocumento: "VES",
      tasaDinero: d("854.4637"),
      tasaDocumento: d("0"),
    });
    expect(t.toFixed(8)).toBe("0.00500000");
  });
});
