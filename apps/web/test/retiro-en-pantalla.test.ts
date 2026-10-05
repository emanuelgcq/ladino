import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  DESTINO_DE_LA_SALIDA,
  RETIRO_EMITIDO,
  SALIDA_QUE_EMITE,
  TIPOS_FISCALES,
} from "../src/components/capa-fiscal/textos.js";

/**
 * ADR-0082, tercera ronda. Tests de FUENTE (como glosario y lector-unico): fijan lo que la
 * pantalla promete sin montar el componente. Ninguna pantalla se da por probada con esto: dicen
 * que el código está cableado, no que se abrió en un navegador.
 */
const fuente = (ruta: string): string =>
  readFileSync(new URL(`../src/${ruta}`, import.meta.url), "utf8");

describe("la factura de retiro y su nota son papel fiscal en el detalle (F9)", () => {
  it("la lista de tipos fiscales las incluye, junto a factura, NC y ND", () => {
    expect([...TIPOS_FISCALES].sort()).toEqual(
      [
        "credit_note",
        "debit_note",
        "invoice",
        "withdrawal_credit_note",
        "withdrawal_invoice",
      ].sort(),
    );
  });
  it("el detalle decide «es fiscal» con ESA lista, no con una comparación propia", () => {
    const detalle = fuente("pages/ventas/DetalleFactura.tsx");
    expect(detalle).toContain("const esFiscal = TIPOS_FISCALES.includes(doc.kind);");
    // La forma vieja: tres tipos a mano, sin los del retiro.
    expect(detalle).not.toMatch(/const esFiscal =\s*doc\.kind === "invoice"/);
  });
});

describe("el retiro en Inventario", () => {
  const inventario = fuente("pages/inventario/Inventario.tsx");

  it("tras emitir la factura de retiro ofrece ABRIRLA, no solo un aviso que se va", () => {
    expect(RETIRO_EMITIDO.ver).toBe("Ver la factura de retiro");
    expect(inventario).toContain("void navigate(`/admin/ventas/${retiroEmitido.id}`);");
    expect(inventario).toContain("{RETIRO_EMITIDO.ver}");
  });

  it("AF5-07: la salida sin IVA pide su destino y lo manda donde va la evidencia", () => {
    expect(DESTINO_DE_LA_SALIDA.etiqueta).toBe("Destino");
    expect(inventario).toContain("motivoNoGravado ? DESTINO_DE_LA_SALIDA.etiqueta");
    // En la vista previa y al confirmar: las dos llamadas mandan `evidence`.
    expect(
      inventario.split("motivoPerdida || motivoNoGravado ? { evidence: form.evidence.trim() }")
        .length - 1,
    ).toBe(2);
  });

  it("AF5-07: el rótulo del inmueble dice lo que dice la norma; el identificador no cambia", () => {
    expect(inventario).toContain('value: "incorporado_inmueble"');
    expect(inventario).toContain('label: "Construcción o reparación de un inmueble del negocio"');
    expect(inventario).not.toContain("Incorporado a un inmueble del negocio");
  });

  it("AF5-02: a quien no factura se le explica quién registra el retiro (decide el servidor)", () => {
    expect(SALIDA_QUE_EMITE.retiroSinPermiso).toContain("lo registra quien puede facturar");
    expect(inventario).toContain('puede("sales.invoice.issue")');
  });

  it("la pantalla no hace cuentas con el IVA del retiro: solo da formato a lo del servidor", () => {
    expect(inventario).not.toMatch(/tax_amount\s*[*+/-]|[*+/-]\s*emitida\.tax_amount/);
  });
});
