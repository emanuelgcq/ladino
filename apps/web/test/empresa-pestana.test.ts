import { describe, expect, it } from "vitest";
import {
  empresaInicial,
  leerEmpresa,
  recordarEmpresa,
  resolverEmpresaDePestana,
  type Almacen,
} from "../src/app/empresa-pestana.js";

/**
 * O-01 (ADR-0077 §1): la empresa activa vive en la PESTAÑA. Dos pestañas del mismo usuario
 * comparten el disco (localStorage) y tienen cada una su sessionStorage; aquí se simulan con
 * mapas, que es lo que el navegador hace con esos dos almacenes.
 */
function almacen(): Almacen & { mapa: Map<string, string> } {
  const mapa = new Map<string, string>();
  return {
    mapa,
    getItem: (k) => mapa.get(k) ?? null,
    setItem: (k, v) => void mapa.set(k, v),
  };
}

const E2 = { id: "e2", legal_name: "Distribuidora Andina" };
const E3 = { id: "e3", legal_name: "Ferretería El Tornillo" };
const EMPRESAS = [E2, E3];
const USUARIO = "u1";

function cargar(pestana: Almacen, disco: Almacen) {
  const { porPestana, ultima } = leerEmpresa(USUARIO, pestana, disco);
  return empresaInicial(EMPRESAS, porPestana, ultima);
}

describe("la empresa activa por pestaña (O-01)", () => {
  it("H3, por el camino REAL de session.tsx: la pestaña nueva arranca en la última A, otra elige B, y tras F5 la primera sigue en A", () => {
    const disco = almacen();
    recordarEmpresa(USUARIO, E2.id, almacen(), disco); // la última elegida: A (E2)
    const pestana1 = almacen();
    // Pestaña 1 NUEVA: recargar() resuelve su empresa y la FIJA en su sessionStorage.
    expect(resolverEmpresaDePestana(USUARIO, EMPRESAS, pestana1, disco)).toBe(E2);
    // Pestaña 2 elige B (E3): setEmpresa recuerda en su pestaña y en el disco.
    const pestana2 = almacen();
    expect(resolverEmpresaDePestana(USUARIO, EMPRESAS, pestana2, disco)).toBe(E2);
    recordarEmpresa(USUARIO, E3.id, pestana2, disco);
    // F5 en la 1: vuelve a pasar por recargar(), y sigue en A.
    expect(resolverEmpresaDePestana(USUARIO, EMPRESAS, pestana1, disco)).toBe(E2);
    expect(resolverEmpresaDePestana(USUARIO, EMPRESAS, pestana2, disco)).toBe(E3);
  });

  it("dos pestañas no se pisan: la 1 recarga y sigue en SU empresa", () => {
    const disco = almacen();
    const pestana1 = almacen();
    const pestana2 = almacen();
    recordarEmpresa(USUARIO, E2.id, pestana1, disco);
    recordarEmpresa(USUARIO, E3.id, pestana2, disco);
    // F5 en la 1: antes quedaba en E3, la elegida en la otra pestaña.
    expect(cargar(pestana1, disco)).toBe(E2);
    expect(cargar(pestana2, disco)).toBe(E3);
  });

  it("una pestaña NUEVA arranca en la última elegida (comodidad, no estado compartido)", () => {
    const disco = almacen();
    recordarEmpresa(USUARIO, E3.id, almacen(), disco);
    expect(cargar(almacen(), disco)).toBe(E3);
  });

  it("la empresa guardada que ya no es visible no se restaura", () => {
    const disco = almacen();
    const pestana = almacen();
    recordarEmpresa(USUARIO, "perdida", pestana, disco);
    expect(cargar(pestana, disco)).toBeNull();
    expect(empresaInicial([E2], "perdida", "perdida")).toBe(E2);
  });

  it("dos usuarios en la misma máquina no comparten la elección", () => {
    const disco = almacen();
    recordarEmpresa("otro", E3.id, almacen(), disco);
    expect(cargar(almacen(), disco)).toBeNull();
  });

  it("sin almacenamiento (modo privado que lanza) no rompe: elige por la lista", () => {
    const roto: Almacen = {
      getItem: () => {
        throw new Error("bloqueado");
      },
      setItem: () => {
        throw new Error("bloqueado");
      },
    };
    expect(() => recordarEmpresa(USUARIO, E2.id, roto, roto)).not.toThrow();
    const { porPestana, ultima } = leerEmpresa(USUARIO, roto, null);
    expect(empresaInicial([E2], porPestana, ultima)).toBe(E2);
  });
});
