import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compartirPdf, puedeCompartirPdf } from "../src/compartir.js";

/**
 * «COMPARTIR» ES LA HOJA DEL NAVEGADOR, Y SOLO DONDE EXISTE (recorrido 2026-09-24, E-06; ADR-0081).
 * Donde el navegador no comparte archivos no hay botón: nada de botones muertos.
 */
const pdf = new Blob(["%PDF-1.4"], { type: "application/pdf" });

describe("puedeCompartirPdf", () => {
  it("sin navegador, o sin `share` o sin `canShare`: no", () => {
    expect(puedeCompartirPdf(undefined)).toBe(false);
    expect(puedeCompartirPdf({})).toBe(false);
    expect(puedeCompartirPdf({ share: () => Promise.resolve() })).toBe(false);
    expect(puedeCompartirPdf({ canShare: () => true })).toBe(false);
  });

  it("pregunta por un ARCHIVO PDF, que es lo que se va a compartir", () => {
    const preguntas: { files?: File[] }[] = [];
    const nav = {
      share: () => Promise.resolve(),
      canShare: (d: { files?: File[] }) => {
        preguntas.push(d);
        return true;
      },
    };
    expect(puedeCompartirPdf(nav)).toBe(true);
    expect(preguntas).toHaveLength(1);
    expect(preguntas[0]!.files?.[0]?.type).toBe("application/pdf");
  });

  it("el navegador que comparte texto pero no archivos: no", () => {
    expect(puedeCompartirPdf({ share: () => Promise.resolve(), canShare: () => false })).toBe(
      false,
    );
    const queLanza = {
      share: () => Promise.resolve(),
      canShare: () => {
        throw new TypeError("files no soportado");
      },
    };
    expect(puedeCompartirPdf(queLanza)).toBe(false);
  });
});

describe("compartirPdf", () => {
  it("manda el PDF como archivo con su nombre", async () => {
    const enviados: { files?: File[]; title?: string }[] = [];
    const nav = {
      share: (d: { files?: File[]; title?: string }) => {
        enviados.push(d);
        return Promise.resolve();
      },
    };
    expect(await compartirPdf(pdf, "factura-A-00000012.pdf", nav)).toBe("compartido");
    expect(enviados[0]!.files?.[0]?.name).toBe("factura-A-00000012.pdf");
    expect(enviados[0]!.files?.[0]?.type).toBe("application/pdf");
    expect(enviados[0]!.files?.[0]?.size).toBe(pdf.size);
  });

  it("cerrar la hoja sin elegir no es un error; lo demás sí", async () => {
    const cancela = {
      share: () => Promise.reject(Object.assign(new Error("cerrada"), { name: "AbortError" })),
    };
    expect(await compartirPdf(pdf, "recibo.pdf", cancela)).toBe("cancelado");
    const falla = {
      share: () => Promise.reject(Object.assign(new Error("no"), { name: "NotAllowedError" })),
    };
    expect(await compartirPdf(pdf, "recibo.pdf", falla)).toBe("no_se_pudo");
    expect(await compartirPdf(pdf, "recibo.pdf", {})).toBe("no_se_pudo");
  });
});

describe("la pantalla «Venta lista»", () => {
  const vender = readFileSync(
    fileURLToPath(new URL("../src/pages/negocio/Vender.tsx", import.meta.url)),
    "utf8",
  );

  it("ofrece «Compartir» SOLO si el navegador puede", () => {
    expect(vender).toMatch(/\{puedeCompartir && \(/);
    expect(vender).toContain("Compartir");
  });

  it("no enlaza a ninguna aplicación de mensajería", () => {
    expect(vender).not.toMatch(/wa\.me|api\.whatsapp|whatsapp:\/\//i);
  });
});
