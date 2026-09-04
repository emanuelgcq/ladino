import { describe, expect, it } from "vitest";
import { NullDigitalPrintShop, CONTROL_NUMBER_RE } from "./print-shop.js";

const DOC = {
  documentId: "d1",
  companyId: "c1",
  issuerTaxId: "J401234567",
  kind: "invoice" as const,
  series: "A",
  documentNumber: "42",
  issuedAt: "2026-09-02T10:00:00-04:00",
  totalAmount: "116.00000000",
  transactionCurrency: "USD",
};

describe("NullDigitalPrintShop", () => {
  it("RECHAZA con el motivo — jamás finge un número de control", async () => {
    await expect(new NullDigitalPrintShop().assignControlNumber(DOC)).rejects.toThrow(
      /no hay imprenta digital configurada/,
    );
    await expect(new NullDigitalPrintShop().assignControlNumber(DOC)).rejects.toThrow(/ADR-0045/);
  });
});

describe("CONTROL_NUMBER_RE (PA 102 art. 30)", () => {
  it("dos dígitos, guion, secuencial de hasta ocho — arrancando en 00-1", () => {
    expect(CONTROL_NUMBER_RE.test("00-1")).toBe(true);
    expect(CONTROL_NUMBER_RE.test("00-00000001")).toBe(true);
    expect(CONTROL_NUMBER_RE.test("99-12345678")).toBe(true);
  });

  it("lo que no tiene esa forma no es un número de control", () => {
    expect(CONTROL_NUMBER_RE.test("001")).toBe(false);
    expect(CONTROL_NUMBER_RE.test("00-123456789")).toBe(false); // nueve dígitos
    expect(CONTROL_NUMBER_RE.test("A0-1")).toBe(false);
    expect(CONTROL_NUMBER_RE.test("0-1")).toBe(false);
    expect(CONTROL_NUMBER_RE.test("00-")).toBe(false);
  });
});
