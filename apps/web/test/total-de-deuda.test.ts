import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { FALTA_LA_TASA, estadoDeTotal, nominalPorMoneda } from "../src/components/deuda.js";

/**
 * Ola 4, la familia de N-05 («no hay» contra «no puedes ver»): `GET /v1/negocio/resumen` manda
 * `lo_que_me_deben` y `lo_que_debo` en `null` por DOS motivos —el rol no tiene `ar.read` /
 * `ap.read`, o falta la tasa de hoy para valorar lo que está en divisa— y ahora dice cuál en
 * `…_motivo`. La pantalla no los confundía bien: con cualquiera de los dos escondía la tarjeta.
 *
 * Sin DOM en este paquete: la decisión vive en `estadoDeTotal` (components/deuda.ts) y la última
 * prueba comprueba que Inicio y Mi dinero la usan.
 */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const leer = (rel: string): string => fs.readFileSync(path.join(RAIZ, rel), "utf8");

describe("estadoDeTotal: qué hace la tarjeta de un total de deuda", () => {
  it("con cifra, la cifra — también si es cero: «no te deben nada» sí es un dato", () => {
    expect(estadoDeTotal("4200.00", null)).toBe("cifra");
    expect(estadoDeTotal("0.00", null)).toBe("cifra");
  });
  it("null por permiso: la tarjeta no se pinta", () => {
    expect(estadoDeTotal(null, "sin_permiso")).toBe("oculta");
  });
  it("null por tasa: la tarjeta se pinta y dice que falta la tasa — nunca se esconde", () => {
    expect(estadoDeTotal(null, "sin_tasa")).toBe("sin_tasa");
  });
  it("null sin motivo (una API anterior a este campo): como antes, no se pinta", () => {
    expect(estadoDeTotal(null, undefined)).toBe("oculta");
    expect(estadoDeTotal(null, null)).toBe("oculta");
  });
  it("todavía cargando: se pinta con «…»", () => {
    expect(estadoDeTotal(undefined, undefined)).toBe("cargando");
  });
});

describe("lo que sí se conoce sin tasa: el nominal por moneda", () => {
  it("se escribe por moneda, sin sumar monedas distintas, y sin «0», «null» ni «NaN»", () => {
    const texto = nominalPorMoneda([
      { currency: "USD", nominal: "116.00" },
      { currency: "VES", nominal: "250.50" },
    ]);
    expect(texto).toContain("116,00");
    expect(texto).toContain("250,50");
    expect(texto).toContain(" + ");
    expect(texto).not.toMatch(/null|NaN|undefined/);
    expect(nominalPorMoneda([])).toBe("");
    expect(nominalPorMoneda(undefined)).toBe("");
  });
});

describe("Inicio y Mi dinero usan la decisión, no un `!== null` suelto", () => {
  it.each(["pages/negocio/Inicio.tsx", "pages/negocio/Dinero.tsx"])("%s", (rel) => {
    const fuente = leer(rel);
    expect(fuente).toContain("estadoDeTotal(");
    expect(fuente).toContain("lo_que_me_deben_motivo");
    expect(fuente).toContain("FALTA_LA_TASA");
    // La condición vieja escondía la tarjeta con cualquier null.
    expect(fuente).not.toMatch(/lo_que_me_deben !== null\) && \(\s*<Card/);
  });
  it("el texto es el único de la casa", () => {
    expect(FALTA_LA_TASA).toBe("Falta la tasa de hoy");
  });
});
