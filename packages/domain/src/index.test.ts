import { describe, expect, it } from "vitest";
import { createCompany, RULES_VERSION } from "./index.js";
import type { UnitOfWork } from "@ladino/db";

/**
 * Unitario del caso de uso: solo lo que NO necesita base. El recorrido
 * completo de los diez pasos —con Postgres real, triggers reales y JWT real—
 * vive en apps/api/test/e2e-create-company.test.ts, que es donde la plantilla
 * se prueba de verdad.
 */
describe("@ladino/domain — createCompany", () => {
  it("el actor de sistema se rechaza ANTES de tocar la base", async () => {
    // companies.created_by tiene FK a auth.users: el centinela no es un
    // usuario. El caso de uso lo corta en el paso 1 con un error de dominio
    // legible, en vez de dejar que la FK responda con un 23503 críptico.
    const uowQueNoDebeUsarse = {
      sql: null as never, // si el caso de uso toca la base, esto revienta — y debe
      actor: { kind: "system" as const },
    } satisfies UnitOfWork;

    const r = await createCompany(uowQueNoDebeUsarse, {
      tenant_id: "11111111-1111-4111-8111-000000000001",
      legal_name: "Empresa C.A.",
      tax_id: "J-1",
    });

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("PERMISSION_REQUIRED");
  });

  it("declara su versión de reglas", () => {
    expect(RULES_VERSION).toBe("domain-s0.5");
  });
});
