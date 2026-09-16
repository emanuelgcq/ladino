import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { rifParaMostrar, sufijoDeArchivo, tieneRif } from "../src/app/rif.js";
import { capaFiscalVisible, NAV_ADMIN } from "../src/app/nav.js";

/**
 * LA REGLA DEL DUEÑO (2026-09-16): con RIF, facturas y todo lo fiscal; sin RIF, recibos,
 * lenguaje sencillo y nada de IVA. Aquí se prueba la regla y que las piezas que esconden lo
 * fiscal le preguntan a ELLA, no al modo que llega del servidor.
 */
describe("sin RIF, recibos", () => {
  it("el marcador del registro (PEND-…) es «sin RIF»; un RIF de verdad es «con RIF»", () => {
    expect(tieneRif({ tax_id: "PEND-01A0B1C2D3" })).toBe(false);
    expect(tieneRif({ tax_id: "" })).toBe(false);
    expect(tieneRif({ tax_id: "J-12345678-9" })).toBe(true);
    expect(tieneRif({ tax_id: "V123456789" })).toBe(true);
  });

  it("sin RIF no se enseña el marcador ni se usa en los nombres de archivo", () => {
    const sinRif = { tax_id: "PEND-01A0B1C2D3", legal_name: "Bodega Doña Carmen" };
    expect(rifParaMostrar(sinRif)).toBe("Sin RIF");
    expect(sufijoDeArchivo(sinRif)).toBe("bodega-dona-carmen");
    const conRif = { tax_id: "J-12345678-9", legal_name: "Ferretería Formal" };
    expect(rifParaMostrar(conRif)).toBe("J-12345678-9");
    expect(sufijoDeArchivo(conRif)).toBe("J-12345678-9");
  });

  it("el menú: las entradas fiscales existen solo con RIF", () => {
    const fiscales = NAV_ADMIN.flatMap((g) => g.items).filter((i) => i.fiscal === true);
    // Si alguien quita la marca de las entradas, esta prueba no puede pasar en falso.
    expect(fiscales.map((i) => i.to)).toEqual(
      expect.arrayContaining([
        "/admin/libros",
        "/admin/declaraciones",
        "/admin/igtf",
        "/admin/facturacion-fiscal",
      ]),
    );
    expect(capaFiscalVisible(false)).toBe(false);
    expect(capaFiscalVisible(true)).toBe(true);
  });

  it("VARIANTE ROTA: el alta de producto ya no decide por el modo del servidor", () => {
    // El defecto que vio el dueño: el campo de alícuota se escondía SOLO si el servidor decía
    // exactamente «recibos». La pantalla tiene que preguntar al RIF.
    const fuente = readFileSync(
      fileURLToPath(new URL("../src/pages/catalogo/Productos.tsx", import.meta.url)),
      "utf8",
    );
    expect(fuente).not.toMatch(/modo(Alta)?\s*===\s*"recibos"/);
    expect(fuente).toContain("useConFacturas");
  });
});
