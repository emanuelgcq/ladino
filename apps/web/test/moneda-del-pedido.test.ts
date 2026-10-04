import { describe, expect, it } from "vitest";
import { monedaDelPedido, monedaQueSeEnsena } from "../src/moneda-del-pedido.js";

/**
 * H-06 (ADR-0075 §1): el pedido nace en la moneda del PRECIO de la empresa. Quien lleva sus
 * precios en dólares escribe «18» pensando en dólares; el pedido que nacía en bolívares lo
 * guardaba como 18 Bs la caja.
 */
describe("la moneda en que nace un pedido", () => {
  const lista = (currency_code: string, extra: Record<string, unknown> = {}) => ({
    id: currency_code,
    name: currency_code,
    currency_code,
    status: "active",
    ...extra,
  });

  it("es la de la lista de precios con la que la empresa vende", () => {
    expect(monedaDelPedido([lista("VES"), lista("USD", { is_caja_default: true })])).toBe("USD");
    expect(monedaDelPedido([lista("USD"), lista("VES", { is_caja_default: true })])).toBe("VES");
  });

  it("sin lista marcada, la de la primera lista activa", () => {
    expect(monedaDelPedido([lista("USD", { status: "inactive" }), lista("VES")])).toBe("VES");
  });

  it("sin listas (o sin permiso para leerlas), dólares: el precio de referencia", () => {
    expect(monedaDelPedido([])).toBe("USD");
    expect(monedaDelPedido(undefined)).toBe("USD");
  });
});

/**
 * X8 (revisión de moneda, ola 3): mientras las listas CARGAN no se propone nada. Antes el
 * selector decía «Dólares» y cambiaba solo a «Bolívares» al llegar la respuesta, con la persona
 * ya escribiendo precios. Y lo que la persona eligió no lo cambia nadie.
 */
describe("la moneda que el selector del pedido enseña", () => {
  const bs = [{ currency_code: "VES", status: "active", is_caja_default: true }];

  it("mientras cargan las listas no propone ninguna", () => {
    expect(monedaQueSeEnsena(null, true, undefined)).toBeNull();
  });

  it("al llegar las listas propone la de la empresa", () => {
    expect(monedaQueSeEnsena(null, false, bs)).toBe("VES");
  });

  it("si la consulta falló o no hay listas, dólares, como antes", () => {
    expect(monedaQueSeEnsena(null, false, undefined)).toBe("USD");
  });

  it("lo que la persona eligió no cambia: ni mientras carga, ni al llegar otra propuesta", () => {
    expect(monedaQueSeEnsena("USD", true, undefined)).toBe("USD");
    expect(monedaQueSeEnsena("USD", false, bs)).toBe("USD");
  });
});
