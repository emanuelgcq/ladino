import { describe, expect, it } from "vitest";
import { sondearModulosActivos } from "../src/app/modulos-activos.js";

/**
 * EL CAJERO PURO Y EL SHELL (cierre RBAC del 2026-09-08).
 *
 * Los GET que la sonda de divulgación progresiva usa ahora exigen permiso de
 * lectura (`/v1/accounts` → accounting.read, `/v1/fiscal-books/runs` →
 * fiscal_book.read). Un cajero con SOLO los cinco permisos de caja recibe 403
 * en ellos, y el contrato del shell es: ese 403 significa «módulo no
 * visible» — la sonda no lanza, no deja promesas sin capturar y no ensucia
 * la consola. Estos tests fijan ese contrato con las tres caras: el cajero
 * (todo prohibido), el contador (contabilidad visible) y la red caída.
 */

function error403(): Promise<never> {
  const e = Object.assign(new Error("PERMISSION_REQUIRED"), { status: 403 });
  return Promise.reject(e);
}

describe("sondearModulosActivos", () => {
  it("el cajero puro: todo 403 → ningún módulo visible, y la sonda NO lanza", async () => {
    const rutas: string[] = [];
    const llamarDeCajero = <T>(path: string): Promise<T> => {
      rutas.push(path);
      // El cajero puede listar proveedores (solo alcance) pero la empresa no
      // tiene; contabilidad y libros le responden 403.
      if (path.startsWith("/v1/suppliers")) return Promise.resolve({ total: 0 } as T);
      return error403() as Promise<T>;
    };

    const activos = await sondearModulosActivos(llamarDeCajero);
    expect(activos).toEqual({ compras: false, contabilidad: false, libros: false });
    // Y sondeó las tres cosas — el 403 no cortocircuitó a las demás.
    expect(rutas).toHaveLength(3);
  });

  it("el contador: puede leer y la empresa tiene plan → contabilidad y libros visibles", async () => {
    const llamarDeContador = <T>(path: string): Promise<T> => {
      if (path.startsWith("/v1/suppliers")) return Promise.resolve({ total: 0 } as T);
      if (path === "/v1/accounts") return Promise.resolve([{ id: "x" }] as T);
      return Promise.resolve({ runs: [] } as T);
    };
    const activos = await sondearModulosActivos(llamarDeContador);
    expect(activos).toEqual({ compras: false, contabilidad: true, libros: true });
  });

  it("la red caída entera: la sonda responde «nada visible», jamás revienta", async () => {
    const llamarRoto = <T>(): Promise<T> => Promise.reject(new Error("fetch failed"));
    const activos = await sondearModulosActivos(llamarRoto);
    expect(activos).toEqual({ compras: false, contabilidad: false, libros: false });
  });
});
