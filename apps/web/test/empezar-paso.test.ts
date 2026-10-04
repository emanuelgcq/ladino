import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  pasoGuardado,
  pasoInicial,
  pasoPedido,
  recordarPaso,
  sinPaso,
  traePaso,
} from "../src/pages/negocio/empezar-paso.js";

/**
 * Recorrido 2026-09-24, bloques B y M: el asistente de /empezar.
 *   B-10 · recuerda el paso en que la persona iba (antes: siempre el 1);
 *   M-06 · la banda de la caja lleva al paso de las facturas, no a «Tus productos»;
 *   B-09 · la tasa «se actualiza sola»: no queda «Un toque al día»;
 *   M-07 · la escalera lleva el nombre de cada paso a la vista;
 *   B-12 · el paso 4 dice que está cargando;
 *   M-09 · la caja dice que ya se factura.
 * Las cuatro últimas son de texto y forma: se comprueban sobre la fuente.
 */
const fuente = (ruta: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${ruta}`, import.meta.url)), "utf8");

describe("el paso inicial de /empezar", () => {
  it("B-10 · sin enlace, vuelve al paso donde iba", () => {
    expect(pasoInicial("", 2)).toBe(2);
    expect(pasoInicial("?otra=cosa", 1)).toBe(1);
  });

  it("B-10 · sin nada recordado (o con basura), el primero", () => {
    expect(pasoInicial("", null)).toBe(0);
    expect(pasoInicial("", 7)).toBe(0);
    expect(pasoInicial("", -1)).toBe(0);
    expect(pasoInicial("", Number.NaN)).toBe(0);
    expect(pasoInicial("", 1.5)).toBe(0);
  });

  it("M-06 · el enlace manda sobre lo recordado: ?paso=facturas abre el cuarto paso", () => {
    expect(pasoInicial("?paso=facturas", 0)).toBe(3);
    expect(pasoInicial("?paso=facturas", null)).toBe(3);
    expect(pasoInicial("?paso=recibos", 1)).toBe(3);
    expect(pasoInicial("?paso=tasa", 0)).toBe(2);
  });

  it("un ?paso= desconocido no manda: se usa lo recordado", () => {
    expect(pasoInicial("?paso=contabilidad", 2)).toBe(2);
    expect(pasoInicial("?paso=", null)).toBe(0);
  });
});

describe("el enlace se consume una vez", () => {
  it("pasoPedido: solo los pasos que existen (y ningún nombre heredado de Object)", () => {
    expect(pasoPedido("?paso=facturas")).toBe(3);
    expect(pasoPedido("?paso=dinero&x=1")).toBe(1);
    expect(pasoPedido("?paso=contabilidad")).toBeNull();
    expect(pasoPedido("?paso=toString")).toBeNull();
    expect(pasoPedido("")).toBeNull();
  });

  it("sinPaso quita el parámetro y conserva lo demás", () => {
    expect(sinPaso("?paso=facturas")).toBe("");
    expect(sinPaso("?paso=facturas&origen=caja")).toBe("?origen=caja");
    expect(sinPaso("?origen=caja")).toBe("?origen=caja");
    expect(traePaso("?paso=loquesea")).toBe(true);
    expect(traePaso("?origen=caja")).toBe(false);
  });

  it("llegó por la banda, avanzó y recarga: manda lo recordado, no el enlace viejo", () => {
    // 1. llega con el enlace: abre el cuarto paso, y la pantalla lo consume.
    const llegada = "?paso=facturas";
    expect(pasoInicial(llegada, null)).toBe(3);
    const trasConsumir = sinPaso(llegada);
    // 2. la persona va al paso 2 (recordado = 1) y recarga: la URL ya no trae el enlace.
    expect(pasoInicial(trasConsumir, 1)).toBe(1);
  });
});

describe("el paso recordado (sessionStorage)", () => {
  afterEach(() => vi.unstubAllGlobals());

  function almacenFalso(): Storage {
    const datos = new Map<string, string>();
    return {
      getItem: (k: string) => datos.get(k) ?? null,
      setItem: (k: string, v: string) => void datos.set(k, v),
      removeItem: (k: string) => void datos.delete(k),
      clear: () => datos.clear(),
      key: () => null,
      get length() {
        return datos.size;
      },
    };
  }

  it("B-10 · recuerda por empresa: otra empresa no hereda el paso", () => {
    vi.stubGlobal("window", { sessionStorage: almacenFalso() });
    expect(pasoGuardado("empresa-a")).toBeNull();
    recordarPaso("empresa-a", 2);
    expect(pasoGuardado("empresa-a")).toBe(2);
    expect(pasoGuardado("empresa-b")).toBeNull();
    recordarPaso("empresa-b", 3);
    expect(pasoGuardado("empresa-a")).toBe(2);
  });

  it("un almacenamiento que lanza no rompe la pantalla: no recuerda, y ya", () => {
    const roto = (): never => {
      throw new Error("SecurityError");
    };
    vi.stubGlobal("window", {
      sessionStorage: { ...almacenFalso(), getItem: roto, setItem: roto },
    });
    expect(() => recordarPaso("empresa-a", 2)).not.toThrow();
    expect(pasoGuardado("empresa-a")).toBeNull();
  });

  it("sin window (ni sessionStorage) tampoco lanza", () => {
    vi.stubGlobal("window", undefined);
    expect(() => recordarPaso("empresa-a", 1)).not.toThrow();
    expect(pasoGuardado("empresa-a")).toBeNull();
  });

  it("lo guardado que no es un paso se descarta al arrancar", () => {
    const almacen = almacenFalso();
    almacen.setItem("ladino.empezar.paso.empresa-a", "basura");
    vi.stubGlobal("window", { sessionStorage: almacen });
    expect(pasoInicial("", pasoGuardado("empresa-a"))).toBe(0);
  });
});

describe("lo que /empezar y la caja dicen (fuente)", () => {
  const empezar = fuente("pages/negocio/Empezar.tsx");
  const aviso = fuente("components/capa-fiscal/AvisoFacturacion.tsx");
  const textos = fuente("components/capa-fiscal/textos.ts");

  it("M-06 · la banda de recibos enlaza al paso de las facturas", () => {
    expect(aviso).toContain('to="/empezar?paso=facturas"');
    expect(aviso).not.toContain('to="/empezar"');
  });

  it("B-09 · queda «Se actualiza sola»; se borró «Un toque al día»", () => {
    expect(empezar).not.toMatch(/Un toque al día/);
    expect(empezar).toMatch(/Se actualiza sola/);
  });

  it("M-07 · cada paso de la escalera enseña su nombre", () => {
    expect(empezar).toMatch(/\{i \+ 1\}\. \{p\.titulo\}/);
    expect(empezar).toContain('aria-label="Pasos para empezar"');
  });

  it("el enlace se consume: /empezar quita ?paso= de la URL con replace", () => {
    expect(empezar).toContain("navigate({ search: sinPaso(busqueda) }, { replace: true })");
  });

  it("B-12 · el paso 4 tiene estado de carga", () => {
    expect(empezar).toMatch(/paso === 3 && fiscal\.isPending/);
  });

  it("M-09 · la caja dice que ya se factura, con el texto del dueño y la decisión del servidor", () => {
    expect(textos).toContain("Ya facturas con tu RIF: tus ventas salen como factura.");
    expect(aviso).toContain("invoicing_notice");
    expect(fuente("pages/negocio/Vender.tsx")).toContain("<AvisoYaFacturas />");
  });
});
