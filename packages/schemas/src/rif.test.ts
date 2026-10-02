import { describe, expect, it } from "vitest";
import {
  avisoDigitoRif,
  digitoVerificadorRif,
  esMarcadorSinRif,
  formatearDocumento,
  leerDocumentoCliente,
  leerRif,
  normalizarDocumento,
} from "./rif.js";

/**
 * La regla del dueño (2026-09-28, A-08/M-05): estructura bloquea, dígito verificador avisa.
 * Los dos RIF de referencia del algoritmo (módulo 11 del portal del SENIAT) los comprobó la
 * sesión principal a mano: G-20000303-0 da 0 (suma múltiplo de 11 → 11 → 0) y J-00006372-9
 * da 9.
 */
describe("dígito verificador (módulo 11 del SENIAT)", () => {
  it("G-20000303-0 da 0 y J-00006372-9 da 9", () => {
    expect(digitoVerificadorRif("G20000303")).toBe(0);
    expect(digitoVerificadorRif("G200003030")).toBe(0);
    expect(digitoVerificadorRif("J00006372")).toBe(9);
    expect(leerRif("G-20000303-0")).toMatchObject({ valido: true, digito: "correcto" });
    expect(leerRif("J-00006372-9")).toMatchObject({ valido: true, digito: "correcto" });
  });

  it("el RIF del escenario (J-40555123-4) tiene la forma pero no el dígito: se acepta con aviso", () => {
    expect(leerRif("J-40555123-4")).toEqual({
      valido: true,
      tipo: "rif",
      normalizado: "J405551234",
      digito: "incorrecto",
      esperado: 2,
    });
    expect(avisoDigitoRif("J-40555123-4")).toBe(
      "El dígito verificador no cuadra: para J-40555123 el SENIAT calcula 2, y escribiste 4. " +
        "Revísalo en el certificado del RIF; si está bien así, se puede guardar.",
    );
    expect(avisoDigitoRif("J-40555123-2")).toBeNull();
  });

  it("la letra C no tiene valor confirmado: ni correcto ni incorrecto, sin aviso", () => {
    expect(digitoVerificadorRif("C12345678")).toBeNull();
    expect(leerRif("C-12345678-9")).toMatchObject({
      valido: true,
      digito: "sin_regla",
      esperado: null,
    });
    expect(avisoDigitoRif("C-12345678-9")).toBeNull();
  });
});

describe("estructura del RIF", () => {
  it("con o sin guiones, en cualquier caja, se normaliza a letra + 9 dígitos", () => {
    for (const grafia of ["J-40888777-6", "J408887776", "j-40888777-6", " J 40888777 6 "]) {
      expect(leerRif(grafia)).toMatchObject({ valido: true, normalizado: "J408887776" });
    }
  });

  it("las seis letras valen; cualquier otra no", () => {
    for (const l of ["V", "E", "J", "G", "P", "C"]) {
      expect(leerRif(`${l}123456789`).valido).toBe(true);
    }
    expect(leerRif("X123456789").valido).toBe(false);
  });

  it("ocho o diez dígitos no son un RIF", () => {
    expect(leerRif("J12345678").valido).toBe(false);
    expect(leerRif("J1234567890").valido).toBe(false);
    expect(leerRif("J-1").valido).toBe(false);
    expect(leerRif("").valido).toBe(false);
  });

  it("el marcador PEND- no es un RIF, ni para la empresa ni para el cliente (A-17)", () => {
    expect(esMarcadorSinRif("PEND-X")).toBe(true);
    expect(esMarcadorSinRif("pend-01ab")).toBe(true);
    expect(leerRif("PEND-X").valido).toBe(false);
    expect(leerRif("PEND-123456789").valido).toBe(false);
    expect(leerDocumentoCliente("PEND-X").valido).toBe(false);
    expect(normalizarDocumento("PEND-01A0B1C2D3")).toBe("PEND-01A0B1C2D3");
  });
});

describe("documento del cliente: RIF o cédula", () => {
  it("una cédula de 8 dígitos es cédula, sin dígito verificador", () => {
    expect(leerDocumentoCliente("V-18.222.333")).toEqual({
      valido: true,
      tipo: "cedula",
      normalizado: "V18222333",
    });
    expect(leerDocumentoCliente("E84123456")).toMatchObject({ tipo: "cedula" });
    expect(leerDocumentoCliente("V1234")).toMatchObject({ tipo: "cedula" });
  });

  it("un V o E de 9 dígitos es RIF, nunca cédula (M-05)", () => {
    expect(leerDocumentoCliente("V-12345678-9")).toMatchObject({
      tipo: "rif",
      normalizado: "V123456789",
    });
    expect(leerDocumentoCliente("E123456789")).toMatchObject({ tipo: "rif" });
  });

  it("la cédula solo es V o E: J de 8 dígitos no es nada", () => {
    expect(leerDocumentoCliente("J12345678").valido).toBe(false);
    expect(leerDocumentoCliente("V").valido).toBe(false);
  });
});

describe("formatearDocumento — una sola función para mostrar", () => {
  it("un RIF de persona natural sale con guiones, no como cédula de nueve cifras (M-05)", () => {
    expect(formatearDocumento("V123456789")).toBe("V-12345678-9");
    expect(formatearDocumento("E123456789")).toBe("E-12345678-9");
    expect(formatearDocumento("V-12345678-9")).toBe("V-12345678-9");
  });

  it("acepta las dos grafías del mismo RIF (los snapshots emitidos conservan la suya)", () => {
    expect(formatearDocumento("J-40888777-6")).toBe("J-40888777-6");
    expect(formatearDocumento("J408887776")).toBe("J-40888777-6");
    expect(formatearDocumento("C123456789")).toBe("C-12345678-9");
  });

  it("la cédula se enseña como hoy", () => {
    expect(formatearDocumento("V18222333")).toBe("V-18.222.333");
  });

  it("el marcador y lo irreconocible se enseñan tal cual", () => {
    expect(formatearDocumento("PEND-01A0B1C2D3")).toBe("PEND-01A0B1C2D3");
    expect(formatearDocumento("Juan 123")).toBe("Juan 123");
  });
});

/**
 * Revisión 2026-09-28, 0 (a): la PA 00071 art. 13.7 admite la cédula O EL PASAPORTE del
 * adquirente persona natural. Decidido por criterio: P + 9 dígitos es RIF P; cualquier otro P +
 * alfanumérico de 5 a 20 es pasaporte, guardado «P» + mayúsculas sin separadores.
 */
describe("documento del cliente: pasaporte", () => {
  it("P + alfanumérico es pasaporte, normalizado", () => {
    expect(leerDocumentoCliente("P-ab 123.4567")).toEqual({
      valido: true,
      tipo: "pasaporte",
      normalizado: "PAB1234567",
    });
    expect(leerDocumentoCliente("P1234567")).toMatchObject({ tipo: "pasaporte" });
  });

  it("P + 9 dígitos sigue siendo RIF P; menos de 5 o más de 20 no es nada", () => {
    expect(leerDocumentoCliente("P123456789")).toMatchObject({ tipo: "rif" });
    expect(leerDocumentoCliente("P1234").valido).toBe(false);
    expect(leerDocumentoCliente(`P${"A".repeat(21)}`).valido).toBe(false);
  });

  it("el pasaporte no es RIF: la empresa y el proveedor no lo aceptan", () => {
    expect(leerRif("PAB1234567").valido).toBe(false);
  });

  it("se muestra como hoy", () => {
    expect(formatearDocumento("PAB1234567")).toBe("P-AB1234567");
  });
});
