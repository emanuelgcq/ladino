import { describe, expect, it } from "vitest";
import {
  motivoDePausa,
  type TalonarioDeCaja,
} from "../src/components/capa-fiscal/caja-en-pausa.js";

/**
 * A-02 (regla del dueño, 2026-09-28): la caja de una empresa CON RIF está en pausa hasta que haya
 * un talonario con papel; sin RIF se vende con recibos y no hay nada que esperar.
 */
const listo: TalonarioDeCaja = {
  status: "active",
  remaining: 50,
  is_contingency: false,
  printer_data_complete: true,
};
const libres = { current_regime: "formatos_libres" };

describe("motivoDePausa", () => {
  it("sin RIF nunca hay pausa: vende con recibos", () => {
    expect(
      motivoDePausa({ conRif: false, setup: { current_regime: null }, talonarios: [] }),
    ).toBeNull();
  });

  it("con RIF recién registrada (sin régimen): en pausa, falta decir cómo factura", () => {
    expect(motivoDePausa({ conRif: true, setup: { current_regime: null }, talonarios: [] })).toBe(
      "regime_missing",
    );
  });

  it("forma libre sin talonario, con el talonario agotado, pausado o solo de contingencia: en pausa", () => {
    for (const talonarios of [
      [],
      [{ ...listo, remaining: 0 }],
      [{ ...listo, status: "paused" }],
      [{ ...listo, is_contingency: true }],
    ]) {
      expect(motivoDePausa({ conRif: true, setup: libres, talonarios })).toBe("no_range");
    }
  });

  it("el talonario de comprobantes de retención no es papel para facturar: en pausa", () => {
    expect(
      motivoDePausa({
        conRif: true,
        setup: libres,
        talonarios: [{ ...listo, kind: "retention_receipt" }],
      }),
    ).toBe("no_range");
    // Con uno de facturas al lado (kind null o el de la factura), vende.
    for (const kind of [null, "invoice"]) {
      expect(
        motivoDePausa({
          conRif: true,
          setup: libres,
          talonarios: [
            { ...listo, kind: "retention_receipt" },
            { ...listo, kind },
          ],
        }),
      ).toBeNull();
    }
  });

  it("con papel pero sin los datos de la imprenta: en pausa por la imprenta", () => {
    expect(
      motivoDePausa({
        conRif: true,
        setup: libres,
        talonarios: [{ ...listo, printer_data_complete: false }],
      }),
    ).toBe("printer_data_incomplete");
  });

  it("con un talonario listo, la caja vende — aunque haya otro agotado", () => {
    expect(
      motivoDePausa({
        conRif: true,
        setup: libres,
        talonarios: [{ ...listo, remaining: 0 }, listo],
      }),
    ).toBeNull();
  });

  it("lo que no se sabe no pausa: sin la respuesta delante decide el cobro", () => {
    expect(motivoDePausa({ conRif: true, setup: undefined, talonarios: undefined })).toBeNull();
    expect(motivoDePausa({ conRif: true, setup: libres, talonarios: undefined })).toBeNull();
  });

  it("otro régimen (el que no numera con talonario) no se pausa por falta de talonario", () => {
    expect(
      motivoDePausa({ conRif: true, setup: { current_regime: "sin_emision" }, talonarios: [] }),
    ).toBeNull();
  });
});
