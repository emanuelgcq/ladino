import { describe, expect, it } from "vitest";
import { serieYNumero, serieYNumeroImpreso } from "./documento-numero.js";

// ADR-0071, H11: el papel puede no traer serie; el número no lleva guion colgante.
describe("serieYNumero — el formateador único serie-número", () => {
  it("con serie: SERIE-número, rellenado si se pide", () => {
    expect(serieYNumero("A", 12, 8)).toBe("A-00000012");
    expect(serieYNumero("B", 7)).toBe("B-7");
  });
  it("sin serie: solo el número, sin guion", () => {
    expect(serieYNumero("", 12, 8)).toBe("00000012");
    expect(serieYNumero("", 7)).toBe("7");
    expect(serieYNumero("", "s/n")).toBe("s/n");
  });
});

// PA 00071 arts. 26-27 (auditoría fiscal 2026-10-02): en el PAPEL, con serie, el número va
// precedido de la palabra «Serie»; sin serie, solo el número. La pantalla sigue con serieYNumero.
describe("serieYNumeroImpreso — el número como se imprime en la forma libre", () => {
  it("con serie: «Serie A N° 00000001»", () => {
    expect(serieYNumeroImpreso("A", 1, 8)).toBe("Serie A N° 00000001");
  });
  it("sin serie: solo el número, «N° 00000001»", () => {
    expect(serieYNumeroImpreso("", 1, 8)).toBe("N° 00000001");
    expect(serieYNumeroImpreso("", "s/n")).toBe("N° s/n");
  });
});
