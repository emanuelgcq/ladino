import { describe, expect, it } from "vitest";
import { ayudaDelCatalogo } from "../src/components/capa-fiscal/IvaQueCobras.js";

/**
 * B-11 (ADR-0073): la ayuda del porcentaje sale del catálogo que manda el servidor, con su cita y
 * el rango de la ley. Si el catálogo dijera otra cifra, la pantalla diría esa: ninguna está escrita
 * en la web.
 */
describe("ayudaDelCatalogo", () => {
  it("enseña la referencia, la cita y el rango que vienen del servidor", () => {
    const texto = ayudaDelCatalogo({
      rate: "0.12000000",
      rate_min: "0.08000000",
      rate_max: "0.16500000",
      legal_source: "Cita de prueba",
    });
    expect(texto).toBe("Hoy 12 % (Cita de prueba). La ley admite entre 8 % y 16,5 %.");
  });

  it("sin catálogo vigente no inventa una cifra", () => {
    const texto = ayudaDelCatalogo(null);
    expect(texto).not.toMatch(/\d/);
    expect(texto).toMatch(/contador/);
  });
});
