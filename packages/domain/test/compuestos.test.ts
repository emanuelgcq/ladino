import { describe, expect, it } from "vitest";
import { parseDecimal, type Decimal } from "@ladino/money";
import type { InventoryMoveResponse } from "@ladino/schemas";
import { debeHaberVueltoDe, movimientosPorLinea } from "../src/compuestos.js";

/**
 * I-04 (ADR-0084), las dos piezas PURAS de la venta de un compuesto:
 *
 *   · `movimientosPorLinea`: a qué línea pedida pertenece cada movimiento de la salida en lote.
 *     Si algo no cuadra devuelve `null` (la venta se aborta): nunca atribuye una salida a la
 *     línea equivocada.
 *   · `debeHaberVueltoDe`: la proporción ACUMULADA de la devolución. N devoluciones parciales
 *     suman EXACTO lo que salió, en cantidad y en valor, sea cual sea el orden y el tamaño.
 */
const d = (s: string): Decimal => {
  const r = parseDecimal(s);
  if (!r.ok) throw new Error(s);
  return r.value;
};
const mov = (id: string, product_id: string, quantity: string): InventoryMoveResponse =>
  ({ id, product_id, quantity }) as unknown as InventoryMoveResponse;

describe("movimientosPorLinea", () => {
  it("una línea, un movimiento: cada una con el suyo, en orden", () => {
    const r = movimientosPorLinea(
      [
        { product_id: "pan", quantity: "5" },
        { product_id: "harina", quantity: "1.5" },
      ],
      [mov("m1", "pan", "-5.00000000"), mov("m2", "harina", "-1.50000000")],
    );
    expect(r?.map((l) => l.map((m) => m.id))).toEqual([["m1"], ["m2"]]);
  });

  it("un producto con lotes produce VARIOS movimientos por línea, que suman lo pedido", () => {
    const r = movimientosPorLinea(
      [
        { product_id: "queso", quantity: "4" },
        { product_id: "pan", quantity: "2" },
      ],
      [
        mov("m1", "queso", "-3.00000000"),
        mov("m2", "queso", "-1.00000000"),
        mov("m3", "pan", "-2.00000000"),
      ],
    );
    expect(r?.map((l) => l.map((m) => m.id))).toEqual([["m1", "m2"], ["m3"]]);
  });

  it("el MISMO producto suelto y como ingrediente en la misma venta: no se mezclan", () => {
    // Pan suelto (5) y pan de la arepa (8): dos líneas pedidas del mismo producto.
    const r = movimientosPorLinea(
      [
        { product_id: "pan", quantity: "5" },
        { product_id: "pan", quantity: "8" },
      ],
      [mov("suelto", "pan", "-5.00000000"), mov("de-la-arepa", "pan", "-8.00000000")],
    );
    expect(r?.map((l) => l.map((m) => m.id))).toEqual([["suelto"], ["de-la-arepa"]]);
  });

  it("si no cuadra, null: falta un movimiento, sobra uno, es de otro producto o se pasa de lo pedido", () => {
    const pedidas = [{ product_id: "pan", quantity: "5" }];
    expect(movimientosPorLinea(pedidas, [])).toBeNull();
    expect(
      movimientosPorLinea(pedidas, [mov("m1", "pan", "-5"), mov("m2", "pan", "-1")]),
    ).toBeNull();
    expect(movimientosPorLinea(pedidas, [mov("m1", "harina", "-5")])).toBeNull();
    expect(movimientosPorLinea(pedidas, [mov("m1", "pan", "-6")])).toBeNull();
    expect(movimientosPorLinea(pedidas, [mov("m1", "pan", "-3")])).toBeNull();
    expect(movimientosPorLinea([{ product_id: "pan", quantity: "cinco" }], [])).toBeNull();
  });
});

describe("debeHaberVueltoDe · la proporción acumulada", () => {
  /** Devuelve de a `pasos` (acumulando) y suma lo que cada devolución reingresa. */
  function devolverPorPartes(
    salio: string,
    valor: string,
    vendida: string,
    pasos: string[],
  ): { cantidad: string; valor: string; partes: { q: string; v: string }[] } {
    let acumulada = d("0");
    let volvio = d("0");
    let valorVolvio = d("0");
    const partes: { q: string; v: string }[] = [];
    for (const p of pasos) {
      acumulada = acumulada.plus(d(p));
      const debe = debeHaberVueltoDe(d(salio), d(valor), acumulada, d(vendida));
      const q = debe.cantidad.minus(volvio);
      const v = debe.valor.minus(valorVolvio);
      partes.push({ q: q.toFixed(8), v: v.toFixed(2) });
      volvio = volvio.plus(q);
      valorVolvio = valorVolvio.plus(v);
    }
    return { cantidad: volvio.toFixed(8), valor: valorVolvio.toFixed(2), partes };
  }

  it("3 devoluciones de 1 sobre 3 vendidas: 5,00 no se parte en tres iguales, y aun así suma 5,00", () => {
    const r = devolverPorPartes("1.5", "5.00", "3", ["1", "1", "1"]);
    expect(r.partes).toEqual([
      { q: "0.50000000", v: "1.67" },
      { q: "0.50000000", v: "1.66" },
      { q: "0.50000000", v: "1.67" },
    ]);
    expect(r).toMatchObject({ cantidad: "1.50000000", valor: "5.00" });
  });

  it("una cantidad que no se divide exacto a 8 decimales: 1 entre 3, y la última recoge el resto", () => {
    const r = devolverPorPartes("1", "0.01", "3", ["1", "1", "1"]);
    expect(r.partes.map((p) => p.q)).toEqual(["0.33333333", "0.33333334", "0.33333333"]);
    // Un céntimo no se parte: vuelve entero en UNA de las tres devoluciones, nunca 0,03 ni 0,00.
    expect(r).toMatchObject({ cantidad: "1.00000000", valor: "0.01" });
  });

  it("para CUALQUIER reparto de la devolución, la suma es exactamente lo que salió", () => {
    const casos: [string, string, string, string[]][] = [
      ["375", "12.50", "3", ["1", "2"]],
      ["0.00000007", "0.07", "7", ["1", "1", "1", "1", "1", "1", "1"]],
      ["13.37", "99.99", "11", ["5", "1", "3", "2"]],
      ["2.5", "8.33", "4", ["0.5", "1.25", "0.25", "2"]],
      ["999999.12345678", "123456789.01", "13", ["6", "6", "1"]],
    ];
    for (const [salio, valor, vendida, pasos] of casos) {
      const r = devolverPorPartes(salio, valor, vendida, pasos);
      expect(r.cantidad).toBe(d(salio).toFixed(8));
      expect(r.valor).toBe(d(valor).toFixed(2));
      // Ninguna parte reingresa en negativo: el acumulado no decrece.
      for (const p of r.partes) {
        expect(d(p.q).isNegative()).toBe(false);
        expect(d(p.v).isNegative()).toBe(false);
      }
    }
  });

  it("devolver todo de una vez es lo que salió, sin pasar por la división", () => {
    const r = debeHaberVueltoDe(d("1.5"), d("5.00"), d("3"), d("3"));
    expect({ q: r.cantidad.toFixed(8), v: r.valor.toFixed(2) }).toEqual({
      q: "1.50000000",
      v: "5.00",
    });
  });
});
