import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NAV_ADMIN, NAV_NEGOCIO, type NavItem } from "../src/app/nav.js";
import {
  ACCIONES_DE_PALETA,
  accionesDePaleta,
  destinoDeDocumento,
  etiquetaDeDocumento,
  pantallasDePaleta,
  sinTildes,
  type DocumentoHallado,
} from "../src/app/paleta-acciones.js";

/**
 * LA PALETA FILTRA POR PERMISO (recorrido 2026-09-24, P-06; ADR-0081).
 *
 * Los roles de aquí llevan los permisos REALES de los roles de sistema que importan al caso
 * (consultados en `role_permissions`, 2026-10-04), y `visible` es el mismo cálculo del menú
 * (`shell.tsx`): permiso, capa fiscal y módulo activo.
 */
const CAJERO = [
  "sales.invoice.issue",
  "sales.quote.manage",
  "sales.payment.register",
  "sales.return.manage",
  "sales.credit",
  "ar.read",
  "customer.manage",
];
const ALMACEN = ["purchase.receive", "inventory.move"];
const ENCARGADO = [
  ...CAJERO,
  "purchase.receive",
  "purchase.invoice.register",
  "cash.close",
  "treasury.read",
];
const CONTADOR = ["ar.read", "ap.read", "accounting.read", "accounting.entry.create"];

const puedeCon =
  (permisos: readonly string[]) =>
  (p: string | readonly string[]): boolean =>
    typeof p === "string" ? permisos.includes(p) : p.some((x) => permisos.includes(x));

/** El filtro del menú, con todos los módulos avanzados activos y la empresa con RIF. */
const visibleCon =
  (permisos: readonly string[], opciones: { compras?: boolean } = {}) =>
  (item: NavItem): boolean => {
    if (item.permiso !== undefined && !puedeCon(permisos)(item.permiso)) return false;
    if (item.advanced === "compras") return opciones.compras ?? true;
    return true;
  };

const ids = (permisos: readonly string[], q = ""): string[] =>
  accionesDePaleta(q, visibleCon(permisos), puedeCon(permisos)).map((a) => a.id);

const doc = (type: DocumentoHallado["type"]): DocumentoHallado => ({
  type,
  id: "0198c0de-0000-7000-8000-000000000001",
  number: type === "purchase" ? "F-89002" : "A-12",
  party_name: null,
  date: "2026-09-24",
  status: "issued",
});

describe("las acciones de la paleta, por permiso", () => {
  it("el cajero crea clientes y NO cierra caja; el encargado, las dos", () => {
    expect(ids(CAJERO)).toEqual(["nuevo-cliente"]);
    expect(ids(ENCARGADO)).toEqual(["nuevo-cliente", "cerrar-caja"]);
  });

  it("el almacén y el contador no tienen ninguna de las dos", () => {
    expect(ids(ALMACEN)).toEqual([]);
    expect(ids(CONTADOR)).toEqual([]);
  });

  it("«cierre» encuentra «Cerrar caja» (antes: sin resultados); al cajero no se la enseña", () => {
    expect(ids(ENCARGADO, "cierre")).toEqual(["cerrar-caja"]);
    expect(ids(ENCARGADO, "CUADRE")).toEqual(["cerrar-caja"]);
    expect(ids(CAJERO, "cierre")).toEqual([]);
  });

  it("el permiso del acto no basta: hace falta abrir la pantalla donde se hace", () => {
    // Puede crear clientes, pero su rol no abre /clientes ni /admin/clientes.
    const soloElActo = ["customer.manage"];
    expect(ids(soloElActo)).toEqual([]);
    // Y al revés: abre la pantalla (por ventas) sin el permiso del acto.
    expect(ids(["sales.invoice.issue"])).toEqual([]);
  });

  it("«nuevo cliente» va al mostrador si el rol lo abre; si no, a administración", () => {
    const a = accionesDePaleta("nuevo cli", visibleCon(CAJERO), puedeCon(CAJERO));
    expect(a).toEqual([
      { id: "nuevo-cliente", etiqueta: "Nuevo cliente", to: "/clientes?accion=nuevo" },
    ]);
    const cobranzas = ["customer.manage", "customer.tax_id.manage"];
    expect(accionesDePaleta("", visibleCon(cobranzas), puedeCon(cobranzas))[0]!.to).toBe(
      "/admin/clientes?accion=nuevo",
    );
  });

  it("cada acción apunta a entradas que existen en el menú", () => {
    const rutas = [...NAV_NEGOCIO, ...NAV_ADMIN.flatMap((g) => g.items)].map((i) => i.to);
    for (const a of ACCIONES_DE_PALETA) {
      for (const d of a.destinos) {
        expect(rutas, `${a.id} → ${d.entrada}`).toContain(d.entrada);
        expect(d.to.startsWith(d.entrada)).toBe(true);
      }
    }
  });
});

describe("las pantallas de la paleta", () => {
  it("«llego mercancia», sin tildes, encuentra la puerta; el cajero no la tiene", () => {
    expect(sinTildes("Llegó Mercancía")).toBe("llego mercancia");
    expect(pantallasDePaleta("llego mercancia", visibleCon(ALMACEN)).map((i) => i.to)).toEqual([
      "/admin/llego-mercancia",
    ]);
    expect(pantallasDePaleta("llegó", visibleCon(CAJERO))).toEqual([]);
  });

  it("sin texto, todas las que el rol abre y ninguna repetida", () => {
    const todas = pantallasDePaleta("", visibleCon(ENCARGADO)).map((i) => i.to);
    expect(new Set(todas).size).toBe(todas.length);
    expect(todas).toContain("/vender");
    expect(todas).not.toContain("/admin/contabilidad");
  });
});

describe("a dónde lleva un documento hallado", () => {
  it("una venta abre su detalle si el rol abre Ventas; si no, no se enseña", () => {
    for (const tipo of ["invoice", "receipt", "credit_note", "debit_note", "quote"] as const) {
      expect(destinoDeDocumento(doc(tipo), visibleCon(CAJERO))).toBe(
        "/admin/ventas/0198c0de-0000-7000-8000-000000000001",
      );
    }
    expect(destinoDeDocumento(doc("invoice"), visibleCon(["sales.invoice.issue"]))).toBeNull();
    expect(destinoDeDocumento(doc("invoice"), visibleCon(ALMACEN))).toBeNull();
  });

  it("una compra lleva a la lista de facturas de proveedores que el rol abra", () => {
    expect(destinoDeDocumento(doc("purchase"), visibleCon(ENCARGADO))).toBe("/compras?ver=compras");
    expect(destinoDeDocumento(doc("purchase"), visibleCon(CONTADOR))).toBe("/admin/compras");
    // Con el módulo de compras apagado el contador no abre ninguna: no se enseña.
    expect(
      destinoDeDocumento(doc("purchase"), visibleCon(CONTADOR, { compras: false })),
    ).toBeNull();
    expect(destinoDeDocumento(doc("purchase"), visibleCon(CAJERO))).toBeNull();
    expect(destinoDeDocumento(doc("purchase"), visibleCon(ALMACEN))).toBeNull();
  });

  it("se nombra con su tipo y su número", () => {
    expect(etiquetaDeDocumento(doc("credit_note"))).toBe("Nota de crédito A-12");
    expect(etiquetaDeDocumento(doc("purchase"))).toBe("Compra F-89002");
  });

  it("la factura de retiro y su nota (ADR-0082) se nombran y abren en el detalle de ventas", () => {
    expect(etiquetaDeDocumento(doc("withdrawal_invoice"))).toBe("Factura de retiro A-12");
    expect(etiquetaDeDocumento(doc("withdrawal_credit_note"))).toBe(
      "Nota de crédito de retiro A-12",
    );
    for (const tipo of ["withdrawal_invoice", "withdrawal_credit_note"] as const) {
      expect(destinoDeDocumento(doc(tipo), visibleCon(CONTADOR))).toBe(
        "/admin/ventas/0198c0de-0000-7000-8000-000000000001",
      );
      expect(destinoDeDocumento(doc(tipo), visibleCon(ALMACEN))).toBeNull();
    }
  });
});

describe("lo que la paleta deja de prometer (ADR-0081)", () => {
  const fuente = readFileSync(
    fileURLToPath(new URL("../src/app/palette.tsx", import.meta.url)),
    "utf8",
  );

  it("no queda «Próximamente» ni el «Asistente de Ladino»", () => {
    expect(fuente).not.toMatch(/Próximamente/i);
    expect(fuente).not.toMatch(/Asistente/i);
  });

  it("busca los documentos en el servidor, no en el navegador", () => {
    expect(fuente).toContain("/v1/search/documents");
  });
});
