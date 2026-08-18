import { describe, expect, it } from "vitest";
import { CreateCompanyRequest, CompanyResponse } from "./index.js";

describe("@ladino/schemas — contratos de companies", () => {
  it("acepta la petición mínima válida", () => {
    const r = CreateCompanyRequest.safeParse({
      tenant_id: "11111111-1111-4111-8111-000000000001",
      legal_name: "Empresa C.A.",
      tax_id: "J-12345678-9",
    });
    expect(r.success).toBe(true);
  });

  it("es .strict(): una clave desconocida se rechaza, no se ignora", () => {
    // Ignorarla sería el modo de fallo silencioso: el cliente cree haber
    // enviado un campo que el servidor descartó sin decir nada.
    const r = CreateCompanyRequest.safeParse({
      tenant_id: "11111111-1111-4111-8111-000000000001",
      legal_name: "Empresa C.A.",
      tax_id: "J-1",
      regimen: "especial",
    });
    expect(r.success).toBe(false);
  });

  it("NO valida el formato del RIF — VALIDAR-SENIAT, y es prohibición", () => {
    // Si alguien añade el regex, esta aserción se pone roja y su mensaje
    // explica por qué no debe: el formato no tiene fuente normativa citada, y
    // en Zod compartido sería un cliente decidiendo una regla fiscal.
    const r = CreateCompanyRequest.safeParse({
      tenant_id: "11111111-1111-4111-8111-000000000001",
      legal_name: "Empresa C.A.",
      tax_id: "CUALQUIER-COSA-NO-VACIA",
    });
    expect(r.success).toBe(true);
  });

  it("la respuesta exige created_at ISO 8601 con zona", () => {
    const base = {
      id: "11111111-1111-4111-8111-000000000002",
      tenant_id: "11111111-1111-4111-8111-000000000001",
      legal_name: "Empresa C.A.",
      trade_name: null,
      tax_id: "J-1",
      status: "onboarding" as const,
    };
    expect(
      CompanyResponse.safeParse({ ...base, created_at: "2026-08-18T12:00:00.000000Z" }).success,
    ).toBe(true);
    // El texto por defecto de timestamptz (espacio, offset corto) NO pasa: es
    // el formato del que el caso de uso se aparta a propósito con to_char.
    expect(
      CompanyResponse.safeParse({ ...base, created_at: "2026-08-18 12:00:00+00" }).success,
    ).toBe(false);
  });
});
