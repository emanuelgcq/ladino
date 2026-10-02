import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  aTxtRetencionesIva,
  correccionesYaDeclaradas,
  documentosConVariasAlicuotas,
} from "../src/fiscal-books.js";

/**
 * El serializador TXT de retenciones PRACTICADAS es pura proyección de las filas del libro, y por
 * eso se prueba aquí. Desde el 2026-10-02 (L-03, ADR-0072 §6) sigue los 16 campos de P-7 en su
 * orden y LEE del comprobante-documento: no deriva nada de la porción.
 *
 * Aserciones cambiadas el 2026-10-02 con la autorización del dueño (respuesta L-03): fijaban los
 * 17 campos, la fecha DD/MM/AAAA y el RIF con guiones, y pasaban GRACIAS al defecto. Antes y
 * después de cada una, en el informe del reparador.
 */
describe("aTxtRetencionesIva", () => {
  const fila = {
    retention_id: "x",
    voucher_number: null,
    receipt_number: 7,
    receipt_series: "A",
    fiscal_period: "2026-08",
    issued_on: "2026-08-16",
    supplier_tax_id: "J-12345678-9",
    supplier_name: "Proveedor",
    document_type: "01",
    supplier_document_number: "00451",
    supplier_control_number: "00-000451",
    affected_document: null,
    invoice_date: "2026-08-15",
    total_amount: "1160.00000000",
    base_amount: "1000.00000000",
    exempt_amount: "0.00000000",
    iva_amount: "160.00000000",
    tax_rate: "16.00000000",
    // La PORCIÓN retenida (75 %), no la alícuota del IVA.
    rate: "0.75000000",
    retained_amount: "120.00000000",
    legal_source: "PA SNAT/2025/000054",
    receipt_status: "issued",
  };

  it("arma los 16 campos de P-7 en su orden, separados por tabulador", () => {
    const txt = aTxtRetencionesIva([fila], "J-00000000-0", "2026-08-01");
    const campos = txt.split("\t");
    expect(campos).toHaveLength(16);
    expect(campos[0]).toBe("J000000000"); // 1 RIF del agente, sin guiones
    expect(campos[1]).toBe("202608"); // 2 período AAAAMM
    expect(campos[2]).toBe("2026-08-15"); // 3 fecha del documento AAAA-MM-DD
    expect(campos[3]).toBe("C"); // 4 compra
    expect(campos[4]).toBe("01"); // 5 tipo: factura
    expect(campos[5]).toBe("J123456789"); // 6 RIF del proveedor, sin guiones
    expect(campos[6]).toBe("00451"); // 7 número
    expect(campos[7]).toBe("00-000451"); // 8 control
    expect(campos[8]).toBe("1160.00"); // 9 monto del documento
    expect(campos[9]).toBe("1000.00"); // 10 base imponible
    expect(campos[10]).toBe("120.00"); // 11 IVA retenido
    expect(campos[11]).toBe("0"); // 12 documento afectado
    expect(campos[12]).toBe("20260800000007"); // 13 comprobante: período + 8 dígitos
    expect(campos[13]).toBe("0.00"); // 14 exento
    expect(campos[14]).toBe("16.00"); // 15 alícuota
    expect(campos[15]).toBe("0"); // 16 expediente
    expect(txt.includes("\r\n")).toBe(false); // una fila, una línea
  });

  it("un dato que falta sale VACÍO en vez de inventarse", () => {
    const { total_amount: _t, tax_rate: _r, ...sinDatos } = fila;
    const campos = aTxtRetencionesIva([sinDatos], "J-00000000-0", "2026-08-01").split("\t");
    expect(campos[8]).toBe(""); // monto: no está en la fila
    expect(campos[9]).toBe("1000.00"); // la base sí es dato leído
    expect(campos[14]).toBe(""); // alícuota: no está en la fila
  });

  it("un comprobante aún sin número emite el campo vacío, no un correlativo falso", () => {
    const txt = aTxtRetencionesIva(
      [{ ...fila, receipt_number: null }],
      "J-00000000-0",
      "2026-08-01",
    );
    expect(txt.split("\t")[12]).toBe("");
  });

  it("un libro vacío produce un fichero vacío, sin cabecera fantasma", () => {
    expect(aTxtRetencionesIva([], "J-00000000-0", "2026-08-01")).toBe("");
  });

  it("la versión ANULADA de un comprobante no se declara", () => {
    const txt = aTxtRetencionesIva(
      [{ ...fila, voucher_number: "20260800000002", receipt_status: "annulled" }],
      "J-00000000-0",
      "2026-08-01",
    );
    expect(txt).toBe("");
  });

  it("reproduce el FIXTURE APROBADO escrito desde P-7", () => {
    const fixture = readFileSync(
      new URL("./fixtures/txt-retenciones-iva-p7.txt", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((l) => !l.startsWith("#"))
      .join("\n");
    const comun = {
      receipt_number: null,
      receipt_series: null,
      fiscal_period: "2026-10",
      supplier_name: "Proveedor",
      document_type: "01",
      affected_document: null,
      legal_source: "PA SNAT/2025/000054",
    };
    const segundo = {
      ...comun,
      supplier_tax_id: "V-12345678-0",
      supplier_document_number: "A-88",
      supplier_control_number: "00-88",
      invoice_date: "2026-10-05",
      total_amount: "1580.00000000",
      base_amount: "1000.00000000",
      exempt_amount: "420.00000000",
      tax_rate: "16.00000000",
      retained_amount: "160.00000000",
      rate: "1.00000000",
    };
    const filas = [
      {
        ...comun,
        voucher_number: "20261000000001",
        supplier_tax_id: "J298765432",
        supplier_document_number: "000451",
        supplier_control_number: "00-000451",
        invoice_date: "2026-10-01",
        total_amount: "1160.00000000",
        base_amount: "1000.00000000",
        exempt_amount: "0.00000000",
        tax_rate: "16.00000000",
        rate: "0.75000000",
        retained_amount: "120.00000000",
        receipt_status: "issued",
      },
      { ...segundo, voucher_number: "20261000000002", receipt_status: "annulled" },
      { ...segundo, voucher_number: "20261000000003", receipt_status: "issued" },
    ];
    expect(aTxtRetencionesIva(filas, "J-40123456-7", "2026-10-01")).toBe(fixture);
  });
  it("H4 · la corrección de un comprobante declarado en un período ANTERIOR no vuelve a salir, y se avisa", () => {
    const v2 = {
      ...fila,
      voucher_number: "20261000000009",
      version_no: 2,
      original_issued_on: "2026-09-29",
      declared_before: true,
    };
    // El TXT de la primera quincena de octubre: la versión 1 se emitió en septiembre (declarada).
    expect(aTxtRetencionesIva([v2], "J-00000000-0", "2026-10-01")).toBe("");
    expect(correccionesYaDeclaradas([v2], "2026-10-01")).toEqual(["20261000000009"]);
    // Corregida dentro del MISMO período en que se emitió la 1: sale, y no hay aviso.
    const mismo = { ...v2, original_issued_on: "2026-10-02", declared_before: false };
    expect(aTxtRetencionesIva([mismo], "J-00000000-0", "2026-10-01").split("	")[12]).toBe(
      "20261000000009",
    );
    expect(correccionesYaDeclaradas([mismo], "2026-10-01")).toEqual([]);
  });
  it("H9 · un documento con IVA y varias alícuotas se señala para no emitir el TXT", () => {
    const mixto = { ...fila, tax_rate: null };
    expect(documentosConVariasAlicuotas([fila, mixto], "2026-08-01")).toEqual([
      "00451 (J-12345678-9)",
    ]);
    // Sin IVA no hay campo 15 que discutir; anulado o ya declarado, no va en el TXT.
    expect(
      documentosConVariasAlicuotas([{ ...mixto, iva_amount: "0.00000000" }], "2026-08-01"),
    ).toEqual([]);
    expect(
      documentosConVariasAlicuotas([{ ...mixto, receipt_status: "annulled" }], "2026-08-01"),
    ).toEqual([]);
  });
});
