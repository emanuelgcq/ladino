import { describe, expect, it } from "vitest";
import { cabecerasDe } from "../src/fiscal-books.js";

/**
 * B4 (re-revisión del documento de identidad, 2026-09-28): las cabeceras del CSV salen de la
 * proyección CRUDA —con el token `@@RIF(col)@@`— y del `split(",")` de siempre. Si alguien vuelve
 * a partir la proyección ya expandida (la del RIF normalizado lleva comas dentro de su
 * `regexp_replace`), estas listas se rompen: una cabecera de más, o «upper(regexp_replace(…».
 */
describe("cabeceras de los cuatro libros", () => {
  it("ventas", () => {
    expect(cabecerasDe("ventas")).toEqual([
      "document_id",
      "issued_on",
      "kind",
      "series",
      "document_number",
      "control_identifier",
      "control_number",
      "status",
      "customer_tax_id",
      "customer_name",
      "customer_taxpayer_type",
      "transaction_currency",
      "fx_rate",
      "base_gravada",
      "iva_debito",
      "base_exenta",
      "base_exonerada",
      "base_no_sujeta",
      "base_sin_clasificar",
      "total_amount",
      "journal_entry_id",
      "base_alicuota_general",
      "iva_alicuota_general",
      "alicuota_general",
      "base_alicuota_adicional",
      "iva_alicuota_adicional",
      "alicuota_adicional",
      "base_alicuota_reducida",
      "iva_alicuota_reducida",
      "alicuota_reducida",
      "base_gravada_sin_alicuota",
      "iva_sin_clasificar",
    ]);
  });

  it("compras", () => {
    expect(cabecerasDe("compras")).toEqual([
      "invoice_id",
      "invoice_date",
      "supplier_tax_id",
      "supplier_name",
      "supplier_kind",
      "supplier_document_number",
      "supplier_control_number",
      "supplier_document_ref",
      "status",
      "transaction_currency",
      "fx_rate",
      "base_gravada",
      "iva_credito",
      "iva_al_costo",
      "tax_is_recoverable",
      "base_exenta",
      "base_exonerada",
      "base_no_sujeta",
      "base_sin_clasificar",
      "retenido_iva",
      "retenido_islr",
      "total_amount",
      "journal_entry_id",
      "booked_on",
      "received_late",
      "base_alicuota_general",
      "iva_alicuota_general",
      "alicuota_general",
      "base_alicuota_adicional",
      "iva_alicuota_adicional",
      "alicuota_adicional",
      "base_alicuota_reducida",
      "iva_alicuota_reducida",
      "alicuota_reducida",
      "base_gravada_sin_alicuota",
      "iva_sin_clasificar",
    ]);
  });

  it("retenciones de IVA", () => {
    expect(cabecerasDe("retenciones_iva")).toEqual([
      "retention_id",
      "receipt_number",
      "receipt_series",
      "fiscal_period",
      "issued_on",
      "supplier_tax_id",
      "supplier_name",
      "supplier_document_number",
      "supplier_control_number",
      "invoice_date",
      "base_amount",
      "rate",
      "retained_amount",
      "legal_source",
      "receipt_status",
    ]);
  });

  it("retenciones de ISLR", () => {
    expect(cabecerasDe("retenciones_islr")).toEqual([
      "retention_id",
      "receipt_number",
      "receipt_series",
      "fiscal_period",
      "issued_on",
      "supplier_tax_id",
      "supplier_name",
      "concept_code",
      "concept_name",
      "formula_kind",
      "supplier_document_number",
      "invoice_date",
      "base_amount",
      "rate",
      "subtrahend",
      "retained_amount",
      "legal_source",
      "receipt_status",
    ]);
  });
});
