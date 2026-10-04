import { describe, expect, it } from "vitest";
import { mensajeFaltaTasa } from "../src/tasa-oficial.js";

/**
 * EL MENSAJE DE `EXCHANGE_RATE_MISSING` DICE LO QUE LA PERSONA PUEDE HACER (regla 8; R-85).
 *
 * Mi dinero solo trae la tasa publicada HOY (ADR-0064: no hay carga a mano). Mandar allí a quien
 * fecha una operación en un día pasado sin tasa es prometer lo que la pantalla no hace.
 * La función no tiene reloj: «hoy» es un parámetro.
 */
describe("mensajeFaltaTasa", () => {
  it("si el día que falta es HOY, manda a Mi dinero", () => {
    expect(mensajeFaltaTasa("2026-10-04", "2026-10-04")).toBe(
      "Falta la tasa BCV del 04/10/2026. Tráela en Mi dinero.",
    );
  });

  it("si es un día PASADO, no promete Mi dinero: dice lo que sí se puede hacer", () => {
    expect(mensajeFaltaTasa("2021-05-11", "2026-10-04")).toBe(
      "No hay tasa BCV guardada para el 11/05/2021. Fecha la operación en un día con tasa, o escribe a soporte para cargar la oficial de ese día.",
    );
  });

  it("ayer ya es pasado: el borde es el día, no las horas", () => {
    expect(mensajeFaltaTasa("2026-10-03", "2026-10-04")).toMatch(
      /^No hay tasa BCV guardada para el 03\/10\/2026\./,
    );
  });

  it("el mismo «hoy» decide: la función no lee el reloj", () => {
    expect(mensajeFaltaTasa("2021-05-11", "2021-05-11")).toBe(
      "Falta la tasa BCV del 11/05/2021. Tráela en Mi dinero.",
    );
  });

  it("hoy y con una tasa guardada pero vieja, dice de qué día es la última", () => {
    expect(mensajeFaltaTasa("2026-10-04", "2026-10-04", "2026-09-26")).toBe(
      "Falta la tasa BCV del 04/10/2026: la última guardada es del 26/09/2026. Tráela en Mi dinero.",
    );
  });

  it("hoy y sin ninguna guardada (null), el mensaje sin la coletilla", () => {
    expect(mensajeFaltaTasa("2026-10-04", "2026-10-04", null)).toBe(
      "Falta la tasa BCV del 04/10/2026. Tráela en Mi dinero.",
    );
  });

  it("un día pasado no manda a Mi dinero aunque haya una tasa vieja guardada", () => {
    expect(mensajeFaltaTasa("2021-05-11", "2026-10-04", "2021-05-03")).not.toMatch(/Mi dinero/);
  });

  // Ninguna validación rechaza una fecha FUTURA antes de pedir la tasa (un gasto, un pago o una
  // factura de proveedor fechados dentro de diez días llegan hasta aquí). Mi dinero trae la tasa
  // publicada HOY: mandar allí por la de un día que aún no llega es prometer lo que no existe.
  it("si es un día FUTURO, dice la verdad: esa tasa todavía no se ha publicado, y no manda a Mi dinero", () => {
    expect(mensajeFaltaTasa("2026-10-14", "2026-10-04")).toBe(
      "La tasa BCV del 14/10/2026 todavía no se ha publicado: ese día aún no llega. Fecha la operación hoy o en un día que ya tenga tasa.",
    );
  });

  it("mañana ya es futuro: el borde es el día, no las horas — y la última guardada no cambia el mensaje", () => {
    const m = mensajeFaltaTasa("2026-10-05", "2026-10-04", "2026-09-26");
    expect(m).toMatch(/^La tasa BCV del 05\/10\/2026 todavía no se ha publicado/);
    expect(m).not.toMatch(/Mi dinero/);
  });

  it("acepta un instante ISO y toma su día", () => {
    expect(mensajeFaltaTasa("2026-10-04T00:00:00.000Z", "2026-10-04")).toBe(
      "Falta la tasa BCV del 04/10/2026. Tráela en Mi dinero.",
    );
  });
});
