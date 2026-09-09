import { describe, expect, it } from "vitest";
import { aTxtRetencionesIva } from "../src/fiscal-books.js";

/**
 * El serializador TXT de retenciones PRACTICADAS (migración 46) es aritmética
 * pura sobre las filas del libro, y por eso se prueba aquí y no en E2E: lo
 * que hay que vigilar son las TRES derivaciones (IVA = retenido ÷ porción,
 * alícuota = IVA ÷ base, total = base + IVA) y que la aritmética imposible
 * produzca campos VACÍOS, nunca un número inventado.
 */
describe("aTxtRetencionesIva", () => {
  const fila = {
    retention_id: "x",
    receipt_number: 7,
    receipt_series: "A",
    fiscal_period: "2026-08",
    issued_on: "2026-08-16",
    supplier_tax_id: "J-12345678-9",
    supplier_name: "Proveedor",
    supplier_document_number: "00451",
    supplier_control_number: "00-000451",
    invoice_date: "2026-08-15",
    base_amount: "1000.00000000",
    // La PORCIÓN retenida (75 %), no la alícuota del IVA.
    rate: "0.75000000",
    retained_amount: "120.00000000",
    legal_source: "PA 0049",
    receipt_status: "issued",
  };

  it("deriva IVA, alícuota y total desde la porción, y arma la línea con tabuladores", () => {
    const txt = aTxtRetencionesIva([fila], "J-00000000-0", "2026-08-01");
    const campos = txt.split("\t");
    expect(campos[0]).toBe("J-00000000-0"); // RIF del agente
    expect(campos[1]).toBe("202608"); // período YYYYMM
    expect(campos[2]).toBe("15/08/2026"); // fecha factura dd/mm/yyyy
    expect(campos[4]).toBe("C");
    expect(campos[6]).toBe("J-12345678-9");
    // IVA de la factura = 120 ÷ 0.75 = 160; alícuota = 160 ÷ 1000 = 16 %;
    // total = 1000 + 160 = 1160 (supone exento cero — PENDIENTES_ASESOR).
    expect(campos[9]).toBe("1160.00"); // monto total
    expect(campos[10]).toBe("1000.00"); // base
    expect(campos[11]).toBe("120.00"); // retenido
    expect(campos[13]).toBe("20260800000007"); // comprobante: período + 8 dígitos
    expect(campos[15]).toBe("16.00"); // alícuota
    expect(txt.includes("\r\n")).toBe(false); // una fila, una línea
  });

  it("con la porción a cero deja los DERIVADOS vacíos en vez de inventar", () => {
    const txt = aTxtRetencionesIva([{ ...fila, rate: "0" }], "J-00000000-0", "2026-08-01");
    const campos = txt.split("\t");
    expect(campos[9]).toBe(""); // total: no derivable
    expect(campos[10]).toBe("1000.00"); // la base sí es dato leído
    expect(campos[15]).toBe(""); // alícuota: no derivable
  });

  it("un comprobante aún sin número emite el campo vacío, no un correlativo falso", () => {
    const txt = aTxtRetencionesIva(
      [{ ...fila, receipt_number: null }],
      "J-00000000-0",
      "2026-08-01",
    );
    expect(txt.split("\t")[13]).toBe("");
  });

  it("un libro vacío produce un fichero vacío, sin cabecera fantasma", () => {
    expect(aTxtRetencionesIva([], "J-00000000-0", "2026-08-01")).toBe("");
  });
});
