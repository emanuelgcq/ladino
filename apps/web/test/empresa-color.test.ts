import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { colorDeEmpresa, inicialDeEmpresa } from "../src/app/empresa-color.js";

/**
 * O-05 (recorrido 2026-09-24): nada distinguía una empresa de otra salvo el texto. La insignia
 * enseña el logo que ya existe o, sin logo, la inicial sobre un color DERIVADO del id de la
 * empresa: no se guarda en ninguna parte, y por eso tiene que ser estable.
 */
const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
const leer = (rel: string): string => fs.readFileSync(path.join(RAIZ, rel), "utf8");

const E2 = "01a0d548-82bb-783e-909e-643fc473d458";
const E3 = "01a0d549-6587-703a-be13-da740c2750d3";

describe("colorDeEmpresa — O-05", () => {
  it("es estable: la misma empresa da siempre el mismo color", () => {
    expect(colorDeEmpresa(E2)).toBe(colorDeEmpresa(E2));
    expect(colorDeEmpresa(E2.toUpperCase())).toBe(colorDeEmpresa(E2));
  });
  it("dos empresas de la misma persona no comparten color", () => {
    expect(colorDeEmpresa(E2)).not.toBe(colorDeEmpresa(E3));
  });
  it("siempre es un tono con la misma saturación y luz", () => {
    for (const id of [E2, E3, "", "x", crypto.randomUUID(), crypto.randomUUID()]) {
      const m = /^hsl\((\d{1,3}) 55% 30%\)$/.exec(colorDeEmpresa(id));
      expect(m, colorDeEmpresa(id)).not.toBeNull();
      expect(Number(m![1])).toBeGreaterThanOrEqual(0);
      expect(Number(m![1])).toBeLessThan(360);
    }
  });
  it("blanco encima se lee (WCAG AA, ≥ 4,5:1) en LOS 360 tonos que la función puede dar", () => {
    // Contraste de verdad, no el tono: hsl(h 55% 30%) → sRGB → luminancia relativa (WCAG 2.x).
    const canal = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const luminancia = (h: number, s: number, l: number): number => {
      const a = s * Math.min(l, 1 - l);
      const f = (n: number): number => {
        const k = (n + h / 30) % 12;
        return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
      };
      return 0.2126 * canal(f(0)) + 0.7152 * canal(f(8)) + 0.0722 * canal(f(4));
    };
    let peor = Infinity;
    for (let h = 0; h < 360; h += 1) {
      peor = Math.min(peor, 1.05 / (luminancia(h, 0.55, 0.3) + 0.05));
    }
    expect(peor).toBeGreaterThanOrEqual(4.5);
    // Y la función no se sale de esa saturación y esa luz (la prueba de arriba lo fija).
    expect(colorDeEmpresa(E2)).toMatch(/ 55% 30%\)$/);
  });
  it("reparte: cien empresas no caen en un puñado de tonos", () => {
    const tonos = new Set(Array.from({ length: 100 }, () => colorDeEmpresa(crypto.randomUUID())));
    expect(tonos.size).toBeGreaterThan(40);
  });
});

describe("inicialDeEmpresa — O-05", () => {
  it("la primera letra del nombre comercial; sin él, de la razón social; en mayúscula", () => {
    expect(
      inicialDeEmpresa({ trade_name: "andina", legal_name: "Distribuidora Andina, C.A." }),
    ).toBe("A");
    expect(inicialDeEmpresa({ trade_name: null, legal_name: "ñandú, C.A." })).toBe("Ñ");
    expect(inicialDeEmpresa({ trade_name: "  ", legal_name: "El Tornillo Feliz" })).toBe("E");
  });
  it("salta lo que no es letra ni número, y nunca devuelve vacío", () => {
    expect(inicialDeEmpresa({ trade_name: "«La Esquina»", legal_name: "x" })).toBe("L");
    expect(inicialDeEmpresa({ trade_name: "3 Hermanos", legal_name: "x" })).toBe("3");
    expect(inicialDeEmpresa({ trade_name: null, legal_name: "" })).toBe("?");
  });
});

describe("las tres vistas pintan la insignia — O-05", () => {
  it("el selector, la cabecera y «Elige la empresa» usan InsigniaEmpresa", () => {
    expect(leer("app/shell.tsx")).toContain("<InsigniaEmpresa");
    expect(leer("app/session.tsx")).toContain("<InsigniaEmpresa");
  });
  it("la insignia enseña el logo cuando existe y, si no carga, cae a la inicial", () => {
    const insignia = leer("components/InsigniaEmpresa.tsx");
    expect(insignia).toContain("logo_url");
    expect(insignia).toContain("onError");
    expect(insignia).toContain("colorDeEmpresa");
  });
});
