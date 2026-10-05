import { NAV_ADMIN, NAV_NEGOCIO, type NavItem } from "./nav.js";

/**
 * LO QUE LA PALETA (Ctrl+K) OFRECE, sin React (recorrido 2026-09-24, P-06; ADR-0081).
 *
 * Tres cosas, y las tres salen de lo que YA decide el menú —`visible`, el mismo filtro de
 * `shell.tsx`: permiso, capa fiscal y módulo activo— más el permiso del acto, que es el que
 * la pantalla de destino ya usa para enseñar su botón. Aquí no nace ninguna regla nueva:
 *   · PANTALLAS: las entradas del menú;
 *   · ACCIONES: «Nuevo cliente» y «Cerrar caja», que viven DENTRO de una pantalla y por eso el
 *     menú no las nombra («cierre» no encontraba nada). «Llegó mercancía» ya es una entrada del
 *     menú (ADR-0066): se encuentra como pantalla, también escrita sin tilde;
 *   · DOCUMENTOS: los que devuelve el servidor (`GET /v1/search/documents`), que ya vienen
 *     filtrados por lo que el rol puede leer. Aquí solo se decide a qué pantalla llevan.
 * Esconder es cortesía: quien decide es siempre el servidor.
 */
export type Visible = (item: NavItem) => boolean;
export type Puede = (permiso: string | readonly string[]) => boolean;

const ENTRADAS: readonly NavItem[] = [...NAV_NEGOCIO, ...NAV_ADMIN.flatMap((g) => g.items)];

/** Sin tildes ni mayúsculas: «llego mercancia» encuentra «Llegó mercancía». */
export function sinTildes(texto: string): string {
  return texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function entradaVisible(to: string, visible: Visible): boolean {
  const item = ENTRADAS.find((i) => i.to === to);
  return item !== undefined && visible(item);
}

/** Las pantallas del menú que el rol abre y cuyo nombre contiene lo escrito. */
export function pantallasDePaleta(q: string, visible: Visible): NavItem[] {
  const buscado = sinTildes(q);
  // Una misma ruta no sale dos veces aunque el menú la nombre en dos grupos.
  const vistas = ENTRADAS.filter(visible).filter(
    (i, n, todas) => todas.findIndex((x) => x.to === i.to) === n,
  );
  return buscado === "" ? vistas : vistas.filter((i) => sinTildes(i.label).includes(buscado));
}

interface DefinicionDeAccion {
  readonly id: string;
  readonly etiqueta: string;
  /** Cómo la pide la gente, además de por su nombre. */
  readonly palabras: readonly string[];
  /** El permiso del ACTO: el mismo con que la pantalla de destino enseña su botón. */
  readonly permiso: string;
  /** Dónde se hace, por orden de preferencia: la primera entrada del menú que el rol abra. */
  readonly destinos: readonly { readonly entrada: string; readonly to: string }[];
}

export const ACCIONES_DE_PALETA: readonly DefinicionDeAccion[] = [
  {
    id: "nuevo-cliente",
    etiqueta: "Nuevo cliente",
    palabras: ["agregar cliente", "crear cliente", "registrar cliente"],
    permiso: "customer.manage",
    destinos: [
      { entrada: "/clientes", to: "/clientes?accion=nuevo" },
      { entrada: "/admin/clientes", to: "/admin/clientes?accion=nuevo" },
    ],
  },
  {
    id: "cerrar-caja",
    etiqueta: "Cerrar caja",
    palabras: ["cierre de caja", "cuadrar la caja", "cuadre", "arqueo"],
    permiso: "cash.close",
    destinos: [{ entrada: "/dinero", to: "/dinero?accion=cerrar-caja" }],
  },
];

export interface AccionDePaleta {
  readonly id: string;
  readonly etiqueta: string;
  readonly to: string;
}

/**
 * Las acciones que este rol puede hacer y que casan con lo escrito. Una acción existe si el rol
 * tiene el permiso del acto Y abre alguna de las pantallas donde se hace.
 */
export function accionesDePaleta(q: string, visible: Visible, puede: Puede): AccionDePaleta[] {
  const buscado = sinTildes(q);
  const salida: AccionDePaleta[] = [];
  for (const a of ACCIONES_DE_PALETA) {
    if (!puede(a.permiso)) continue;
    const destino = a.destinos.find((d) => entradaVisible(d.entrada, visible));
    if (destino === undefined) continue;
    const casa =
      buscado === "" ||
      [a.etiqueta, ...a.palabras].some((texto) => sinTildes(texto).includes(buscado));
    if (casa) salida.push({ id: a.id, etiqueta: a.etiqueta, to: destino.to });
  }
  return salida;
}

/** Lo que devuelve `GET /v1/search/documents` (`SearchDocumentItem`). */
export interface DocumentoHallado {
  readonly type:
    | "invoice"
    | "receipt"
    | "credit_note"
    | "debit_note"
    | "quote"
    | "withdrawal_invoice"
    | "withdrawal_credit_note"
    | "purchase";
  readonly id: string;
  readonly number: string;
  readonly party_name: string | null;
  readonly date: string;
  readonly status: string;
}

const NOMBRE_DE_TIPO: Record<DocumentoHallado["type"], string> = {
  invoice: "Factura",
  receipt: "Recibo",
  credit_note: "Nota de crédito",
  debit_note: "Nota de débito",
  quote: "Cotización",
  withdrawal_invoice: "Factura de retiro",
  withdrawal_credit_note: "Nota de crédito de retiro",
  purchase: "Compra",
};

/** «Factura A-12», «Compra F-89002». */
export function etiquetaDeDocumento(d: DocumentoHallado): string {
  return `${NOMBRE_DE_TIPO[d.type]} ${d.number}`;
}

/**
 * A qué pantalla lleva un documento hallado, o `null` si el rol no abre ninguna (y entonces no
 * se enseña: un resultado que rebota en la guardia de rutas sería un botón muerto).
 * Una venta abre su detalle. Una compra no tiene pantalla de detalle: lleva a la lista de
 * facturas de proveedores.
 */
export function destinoDeDocumento(d: DocumentoHallado, visible: Visible): string | null {
  if (d.type === "purchase") {
    if (entradaVisible("/compras", visible)) return "/compras?ver=compras";
    if (entradaVisible("/admin/compras", visible)) return "/admin/compras";
    return null;
  }
  return entradaVisible("/admin/ventas", visible) ? `/admin/ventas/${d.id}` : null;
}
