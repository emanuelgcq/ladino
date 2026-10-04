import { describe, expect, it } from "vitest";
import {
  debeResondear,
  sondearContabilidadConfigurada,
  sondearModulosActivos,
} from "../src/app/modulos-activos.js";

/**
 * EL CAJERO PURO Y EL SHELL (cierre RBAC del 2026-09-08).
 *
 * Los GET que la sonda de divulgación progresiva usa ahora exigen permiso de
 * lectura (`/v1/journal-entries` → accounting.read). Un cajero con SOLO los cinco permisos de caja recibe 403
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

  it("el contador: por su rol, aunque la empresa no tenga un solo dato → contabilidad y libros visibles", async () => {
    const llamarDeContador = <T>(path: string): Promise<T> => {
      if (path.startsWith("/v1/suppliers")) return Promise.resolve({ total: 0 } as T);
      return Promise.resolve({ runs: [] } as T);
    };
    // A-04: lo que hace visibles los módulos al contador es su ROL, no el plan de cuentas (que
    // toda empresa tiene desde el alta). La entrada dice ahora que es contador.
    const activos = await sondearModulosActivos(llamarDeContador, { esContador: true });
    expect(activos).toEqual({ compras: false, contabilidad: true, libros: true });
  });

  // ── A-04: «aparecen solos cuando tienen datos», y el plan de cuentas no es un dato ──────────
  const empresaNueva = <T>(path: string): Promise<T> => {
    // Recién fundada: ni un asiento, ni una factura, ni un proveedor.
    return Promise.resolve({ items: [], total: 0 } as T);
  };

  it("A-04 · la dueña de una empresa recién fundada (con su plan importado) no ve ni Contabilidad ni Libros", async () => {
    const activos = await sondearModulosActivos(empresaNueva);
    expect(activos).toEqual({ compras: false, contabilidad: false, libros: false });
  });

  it("A-04 · el primer asiento POSTEADO enciende Contabilidad; la primera factura, Libros", async () => {
    const rutas: string[] = [];
    const conAsiento = <T>(path: string): Promise<T> => {
      rutas.push(path);
      if (path.startsWith("/v1/journal-entries")) return Promise.resolve({ total: 1 } as T);
      return empresaNueva<T>(path);
    };
    expect(await sondearModulosActivos(conAsiento)).toEqual({
      compras: false,
      contabilidad: true,
      libros: false,
    });
    // Posteado, no «cualquier asiento»: un borrador no es un dato contable.
    expect(rutas.find((r) => r.startsWith("/v1/journal-entries"))).toContain("status=posted");

    const conFactura = <T>(path: string): Promise<T> => {
      if (path.startsWith("/v1/documents")) {
        // Solo cuentan las facturas: un recibo o una cotización no son documentos fiscales.
        return Promise.resolve({ total: path.includes("kind=invoice") ? 1 : 0 } as T);
      }
      return empresaNueva<T>(path);
    };
    expect(await sondearModulosActivos(conFactura)).toEqual({
      compras: false,
      contabilidad: false,
      libros: true,
    });
  });

  it("A-04 · el contador de una empresa sin un solo dato ve Contabilidad y Libros: por su rol", async () => {
    const activos = await sondearModulosActivos(empresaNueva, { esContador: true });
    expect(activos).toEqual({ compras: false, contabilidad: true, libros: true });
  });

  it("la red caída entera: la sonda responde «nada visible», jamás revienta", async () => {
    const llamarRoto = <T>(): Promise<T> => Promise.reject(new Error("fetch failed"));
    const activos = await sondearModulosActivos(llamarRoto);
    expect(activos).toEqual({ compras: false, contabilidad: false, libros: false });
  });
});

/**
 * F9 de la revisión de la ola 4: la sonda se cachea cinco minutos. Tras el primer documento o el
 * primer asiento se vuelve a sondear — y solo entonces: la venta mil no cuesta tres GET.
 */
describe("debeResondear", () => {
  const nada = { compras: false, contabilidad: false, libros: false };
  const todo = { compras: false, contabilidad: true, libros: true };

  it("la primera factura resondea: puede encender Contabilidad y Libros", () => {
    expect(debeResondear(nada, "factura")).toBe(true);
    expect(debeResondear({ ...nada, contabilidad: true }, "factura")).toBe(true);
    expect(debeResondear({ ...nada, libros: true }, "factura")).toBe(true);
  });
  it("un recibo o un asiento posteado solo pueden encender Contabilidad", () => {
    expect(debeResondear(nada, "recibo")).toBe(true);
    expect(debeResondear(nada, "asiento")).toBe(true);
    expect(debeResondear({ ...nada, contabilidad: true }, "recibo")).toBe(false);
    expect(debeResondear({ ...nada, contabilidad: true }, "asiento")).toBe(false);
  });
  it("con todo encendido, ningún hecho resondea", () => {
    for (const h of ["factura", "recibo", "asiento"] as const) {
      expect(debeResondear(todo, h)).toBe(false);
    }
  });
  it("sin sonda todavía no hay nada que refrescar", () => {
    expect(debeResondear(undefined, "factura")).toBe(false);
  });
});

/**
 * La pregunta de las PANTALLAS (detalle del documento, tablero), que no es la del menú: ¿hay plan
 * de cuentas que esta persona pueda leer? La empresa recién fundada responde SÍ aunque el menú
 * todavía no enseñe Contabilidad.
 */
describe("sondearContabilidadConfigurada", () => {
  it("con plan de cuentas legible: configurada, aunque no haya un solo asiento", async () => {
    const llamar = <T>(path: string): Promise<T> =>
      Promise.resolve((path === "/v1/accounts" ? [{ id: "x" }] : { total: 0 }) as T);
    expect(await sondearContabilidadConfigurada(llamar)).toBe(true);
    expect((await sondearModulosActivos(llamar)).contabilidad).toBe(false);
  });
  it("sin plan, o sin permiso (403): no configurada, y no lanza", async () => {
    expect(await sondearContabilidadConfigurada(<T>() => Promise.resolve([] as T))).toBe(false);
    expect(await sondearContabilidadConfigurada(() => error403())).toBe(false);
  });
});
