import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compararImportes, esCero } from "../src/components/decimal-compare.js";
import {
  FALTA_LA_TASA,
  SIN_TASA_NO_SE_COBRA,
  decisionDeCobro,
  estadoDeDeuda,
  nominalPorMoneda,
  textoDeDeuda,
} from "../src/components/deuda.js";

/**
 * H12 (ADR-0075 §5): el servidor manda `null` en la deuda cuando no puede valorarla hoy (falta la
 * tasa USD→VES, o un cobro viejo en otra moneda no tiene con qué valorarse). La web lanzaba:
 * `null.trim()` en `esCero`, `null.startsWith` en la lista del negocio, y el `catch` del formato
 * de dinero. Estas pruebas fijan lo que cada pantalla hace con ese `null`.
 *
 * La web no tiene pruebas de componente (no hay DOM en este paquete): cada pantalla delega la
 * decisión en las funciones puras de `components/deuda.ts`, que es lo que se prueba, y la última
 * prueba comprueba que las pantallas las usan de verdad.
 */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const leer = (rel: string): string => fs.readFileSync(path.join(RAIZ, rel), "utf8");

describe("esCero no lanza con lo que no es un importe", () => {
  it("null y undefined devuelven false: «no se sabe» no es cero", () => {
    expect(() => esCero(null)).not.toThrow();
    expect(esCero(null)).toBe(false);
    expect(esCero(undefined)).toBe(false);
  });
  it("y los importes de siempre dicen lo de siempre", () => {
    expect(esCero("0.00")).toBe(true);
    expect(esCero("-0")).toBe(true);
    expect(esCero("0.01")).toBe(false);
    expect(compararImportes("10.00", "9.99")).toBe(1);
  });
});

describe("la lista de clientes (clientes/Clientes.tsx y negocio/Clientes.tsx): la fila con deuda nula", () => {
  it("no es «Al día» ni «Debe Bs. 0,00»: es «sin valorar», con el texto único", () => {
    expect(estadoDeDeuda(null)).toBe("sin_valorar");
    expect(textoDeDeuda(null, "VES")).toBe("Falta la tasa de hoy");
    expect(textoDeDeuda(null, "VES")).toBe(FALTA_LA_TASA);
  });
  it("sin deuda pedida, en cero o con saldo a favor: «sin_deuda»; con deuda: «debe» y su importe", () => {
    expect(estadoDeDeuda(undefined)).toBe("sin_deuda");
    expect(estadoDeDeuda("0.00")).toBe("sin_deuda");
    expect(estadoDeDeuda("-15.00")).toBe("sin_deuda");
    expect(estadoDeDeuda("4200.00")).toBe("debe");
    expect(textoDeDeuda("4200.00", "VES")).toContain("4.200,00");
  });
});

describe("la ficha y el estado de cuenta (clientes/Clientes.tsx, ventas/Cuentas.tsx)", () => {
  it("un saldo, un total o un tramo de antigüedad nulos se escriben con el texto, nunca «0», «null» ni «NaN»", () => {
    for (const moneda of ["VES", "USD"]) {
      const texto = textoDeDeuda(null, moneda);
      expect(texto).toBe(FALTA_LA_TASA);
      expect(texto).not.toMatch(/null|NaN|undefined|\b0\b/);
    }
  });
  it("y al lado va lo que SÍ se conoce: el nominal por moneda", () => {
    expect(
      nominalPorMoneda([
        { currency: "USD", nominal: "100.00" },
        { currency: "VES", nominal: "0.00" },
        { currency: "EUR", nominal: null },
      ]),
    ).toMatch(/^USD\s?100,00$/);
    expect(nominalPorMoneda(undefined)).toBe("");
    expect(nominalPorMoneda([])).toBe("");
  });
  it("un documento con saldo nulo sigue ABIERTO (debe): no desaparece de «Pendientes de cobro»", () => {
    const documentos = [
      { id: "a", status: "issued", balance: null },
      { id: "b", status: "issued", balance: "0.00" },
      { id: "c", status: "issued", balance: "12.50" },
    ];
    const abiertas = documentos.filter(
      (d) => d.status === "issued" && estadoDeDeuda(d.balance) !== "sin_deuda",
    );
    expect(abiertas.map((d) => d.id)).toEqual(["a", "c"]);
  });
});

describe("las pantallas usan esas funciones y ya no tienen los patrones que lanzaban", () => {
  const pantallas = [
    "pages/clientes/Clientes.tsx",
    "pages/negocio/Clientes.tsx",
    "pages/ventas/Cuentas.tsx",
    "components/CobrarDocumento.tsx",
  ];
  it.each(pantallas)("%s importa de components/deuda.js", (rel) => {
    expect(leer(rel)).toMatch(/from "(\.\.\/\.\.\/components|\.)\/deuda\.js"/);
  });
  it("el texto vive en UN sitio: ninguna pantalla lo escribe a mano", () => {
    for (const rel of pantallas) expect(leer(rel)).not.toContain("Falta la tasa de hoy");
    expect(leer("components/deuda.ts")).toContain('"Falta la tasa de hoy"');
  });
  it("ya no hay `debt.startsWith`, ni `esCero(debt)` sobre un valor que puede ser null", () => {
    expect(leer("pages/negocio/Clientes.tsx")).not.toContain("c.debt.startsWith");
    expect(leer("pages/clientes/Clientes.tsx")).not.toContain("esCero(debt)");
    expect(leer("pages/clientes/Clientes.tsx")).not.toContain('compararImportes(d.balance, "0")');
  });
});

describe("revisión final · un documento «sin valorar» no se cobra a ciegas (decisionDeCobro)", () => {
  it("con deuda conocida: el botón, encendido y sin motivo", () => {
    expect(decisionDeCobro("12.50")).toEqual({ visible: true, apagado: false, motivo: null });
  });
  it("con saldo nulo: el botón se enseña APAGADO, con su motivo — nunca se abre el cobro en «0»", () => {
    const d = decisionDeCobro(null);
    expect(d).toEqual({ visible: true, apagado: true, motivo: SIN_TASA_NO_SE_COBRA });
    expect(d.motivo).toContain(FALTA_LA_TASA);
    expect(d.motivo).not.toMatch(/null|NaN|undefined|\b0\b/);
  });
  it("sin deuda (cero, saldo a favor o no pedida): sin botón", () => {
    for (const saldo of ["0.00", "-3.00", undefined]) {
      expect(decisionDeCobro(saldo)).toEqual({ visible: false, apagado: false, motivo: null });
    }
  });
  it("las dos pantallas que cobran un documento deciden con ella, y ninguna precarga un «0»", () => {
    for (const rel of ["pages/clientes/Clientes.tsx", "pages/ventas/DetalleFactura.tsx"]) {
      expect(leer(rel)).toContain("decisionDeCobro(");
    }
    expect(leer("pages/clientes/Clientes.tsx")).not.toContain('cobrando.balance ?? "0"');
  });
});
