import { describe, expect, it } from "vitest";
import { NAV_ADMIN, NAV_NEGOCIO, rutaInicial } from "../src/app/nav.js";

/**
 * LA PUERTA EN EL MENÚ (ADR-0066) — el smoke por rol que pidió el encargo.
 *
 * Lo que se asevera no es el aspecto, sino tres decisiones que se toman una vez y luego nadie
 * vuelve a mirar: dónde vive la entrada, con qué permisos se abre, y **dónde aterriza quien solo
 * puede recibir mercancía**. Esa última cambia con esta entrega: antes el almacén caía en
 * Administración → Inventario, que era donde estaba la «entrada de existencias» que ya no
 * existe.
 */
const LLEGADA = "/admin/llego-mercancia";
const puedeCon =
  (permisos: readonly string[]) =>
  (p: string | readonly string[]): boolean =>
    typeof p === "string" ? permisos.includes(p) : p.some((x) => permisos.includes(x));

describe("«Llegó mercancía» en el menú", () => {
  const operacion = NAV_ADMIN.find((g) => g.label === "Operación");
  const item = operacion?.items.find((i) => i.to === LLEGADA);

  it("vive en OPERACIÓN, justo antes de Compras y gastos", () => {
    expect(item).toBeDefined();
    const orden = operacion!.items.map((i) => i.to);
    expect(orden.indexOf(LLEGADA)).toBe(orden.indexOf("/compras") - 1);
  });

  it("se abre con CUALQUIERA de los tres caminos: aportar, recibir o facturar", () => {
    expect(item!.permiso).toEqual([
      "inventory.move",
      "purchase.receive",
      "purchase.invoice.register",
    ]);
  });

  it("NO lleva marca fiscal ni de módulo avanzado: toda empresa recibe mercancía", () => {
    // Con `fiscal` desaparecería para quien vende con recibos; con `advanced`, para quien no
    // tenga activado el módulo de compras. Las dos reciben mercancía igual.
    expect(item!.fiscal).toBeUndefined();
    expect(item!.advanced).toBeUndefined();
  });

  it("el mostrador no la lleva: arriba se vende y se consulta", () => {
    expect(NAV_NEGOCIO.some((i) => i.to === LLEGADA)).toBe(false);
  });
});

describe("dónde aterriza cada rol", () => {
  it("quien solo mueve existencia y recibe, aterriza en la puerta", () => {
    expect(rutaInicial(puedeCon(["inventory.move", "purchase.receive"]))).toBe(LLEGADA);
  });

  it("el dueño sigue aterrizando en Inicio, y quien vende, en el mostrador", () => {
    expect(rutaInicial(puedeCon(["treasury.read", "sales.invoice.issue"]))).toBe("/inicio");
    expect(rutaInicial(puedeCon(["sales.invoice.issue"]))).toBe("/vender");
  });

  it("el contador sigue aterrizando en su contabilidad", () => {
    expect(rutaInicial(puedeCon(["accounting.entry.create"]))).toBe("/admin/contabilidad");
  });
});
