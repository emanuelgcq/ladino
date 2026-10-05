import type { ReportColumn, ReportSummaryLine, ReportTable } from "@ladino/schemas";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { fechaLocal } from "../../fechas.js";
import { FALTA_LA_TASA } from "../../components/deuda.js";

/**
 * LOS REPORTES EN LA WEB (P-07, F-13, H-11): cómo se LEE lo que mandó el servidor.
 *
 * Nada de esto calcula (apps/web/CLAUDE.md): cada cifra, cada total y cada fila llegan hechos de
 * `/v1/reports/…`. Aquí solo se viste el texto —moneda, coma decimal, fecha— y se dice, en un
 * solo sitio, qué significa un `null`: «falta la tasa de hoy», «tu rol no ve esta cifra» o «no
 * hay dato». Nunca «0».
 */

export type { ReportTable, ReportColumn, ReportSummaryLine };

export const SIN_PERMISO_DE_CIFRA = "Tu rol no ve esta cifra";
export const SIN_DATO = "No disponible";

/** El texto de una celda. `null` en dinero de una cartera es deuda sin valorar, no cero. */
export function textoDeCelda(
  valor: string | null | undefined,
  col: Pick<ReportColumn, "kind" | "currency">,
  tabla: Pick<ReportTable, "report" | "currency">,
): string {
  if (valor === null || valor === undefined) {
    if (col.kind !== "money") return "";
    return tabla.report === "receivables" || tabla.report === "payables" ? FALTA_LA_TASA : "—";
  }
  switch (col.kind) {
    case "money":
      return mostrarImporte({ amount: valor, currency: col.currency ?? tabla.currency });
    case "quantity":
      return mostrarCantidad(valor);
    case "percent":
      return `${mostrarCantidad(valor)} %`;
    case "date":
      return fechaLocal(valor);
    default:
      return valor;
  }
}

/** El texto de una línea del resumen: la cifra vestida, o POR QUÉ no hay cifra. */
export function textoDeResumen(
  s: ReportSummaryLine,
  tabla: Pick<ReportTable, "report" | "currency">,
): string {
  if (s.value === null) {
    if (s.reason === "sin_permiso") return SIN_PERMISO_DE_CIFRA;
    if (s.reason === "sin_tasa") return FALTA_LA_TASA;
    return SIN_DATO;
  }
  return textoDeCelda(s.value, s, tabla);
}

/** ¿La columna se alinea a la derecha (es una cifra)? */
export function esCifra(col: Pick<ReportColumn, "kind">): boolean {
  return col.kind !== "text" && col.kind !== "date";
}

export interface ReporteDelCatalogo {
  readonly clave: ReportTable["report"];
  readonly titulo: string;
  readonly detalle: string;
  /** Basta UNO. Los mismos que exige el servidor (`PERMISOS_DE_REPORTE`): si no, 403. */
  readonly permisos: readonly string[];
  /** Solo para quien factura (tiene libros). */
  readonly fiscal?: boolean;
  /** `false`: el reporte es «a hoy» y no lleva rango. */
  readonly conRango: boolean;
  readonly grupos?: readonly { readonly clave: string; readonly etiqueta: string }[];
}

/** El catálogo, en el orden que fijó el dueño (P-07). Lo que no está aquí no tiene enlace. */
export const REPORTES: readonly ReporteDelCatalogo[] = [
  {
    clave: "sales",
    titulo: "Ventas",
    detalle: "Por día, mes, producto, cliente, forma de pago o vendedor.",
    permisos: ["treasury.read", "accounting.read"],
    conRango: true,
    grupos: [
      { clave: "day", etiqueta: "Por día" },
      { clave: "month", etiqueta: "Por mes" },
      { clave: "product", etiqueta: "Por producto" },
      { clave: "customer", etiqueta: "Por cliente" },
      { clave: "payment_method", etiqueta: "Por forma de pago" },
      { clave: "seller", etiqueta: "Por vendedor" },
    ],
  },
  {
    clave: "margin",
    titulo: "Margen",
    detalle: "Ventas menos costo, con el diferencial cambiario del período.",
    permisos: ["treasury.read", "accounting.read"],
    conRango: true,
    grupos: [
      { clave: "product", etiqueta: "Por producto" },
      { clave: "month", etiqueta: "Por mes" },
      { clave: "day", etiqueta: "Por día" },
    ],
  },
  {
    clave: "iva",
    titulo: "IVA del período",
    detalle: "Débitos, créditos, retenciones y lo que toca pagar, ya calculado.",
    permisos: ["fiscal_book.read"],
    fiscal: true,
    conRango: true,
  },
  {
    clave: "inventory",
    titulo: "Inventario valorizado y rotación",
    detalle: "Lo que hay, lo que vale y cuánto dura al ritmo de venta.",
    permisos: [
      "warehouse.read",
      "inventory.move",
      "inventory.adjust",
      "accounting.read",
      "treasury.read",
    ],
    conRango: true,
  },
  {
    clave: "receivables",
    titulo: "Quién me debe",
    detalle: "Cada cliente que debe, lo vencido y su antigüedad.",
    permisos: ["ar.read"],
    conRango: false,
  },
  {
    clave: "payables",
    titulo: "Qué debo",
    detalle: "Cada proveedor al que se le debe, cuánto y cuándo vence.",
    permisos: ["ap.read"],
    conRango: false,
  },
  {
    clave: "cash-closings",
    titulo: "Cierres de caja",
    detalle: "Esperado, contado y diferencias, por cierre o por cajero.",
    permisos: ["treasury.read"],
    conRango: true,
    grupos: [
      { clave: "closing", etiqueta: "Cada cierre" },
      { clave: "cashier", etiqueta: "Por cajero" },
    ],
  },
  {
    clave: "igtf",
    titulo: "IGTF percibido",
    detalle: "Lo percibido en cada quincena y lo que queda por reintegrar.",
    permisos: ["fiscal_book.read"],
    fiscal: true,
    conRango: true,
  },
];

/** Los reportes que ESTE rol puede abrir, en el orden del catálogo. */
export function reportesVisibles(
  puede: (p: string | readonly string[]) => boolean,
  conFacturas: boolean,
): ReporteDelCatalogo[] {
  return REPORTES.filter((r) => puede(r.permisos) && (r.fiscal !== true || conFacturas));
}

/** La ruta del servidor de un reporte, con su consulta. */
export function rutaDeReporte(
  r: Pick<ReporteDelCatalogo, "clave" | "conRango">,
  q: {
    from?: string;
    to?: string;
    group?: string | null;
    sort?: string | null;
    page?: number;
    perPage?: number;
    format?: "csv" | "xlsx";
  },
): string {
  const p = new URLSearchParams();
  if (r.conRango) {
    p.set("from", q.from ?? "");
    p.set("to", q.to ?? "");
  }
  if (q.group) p.set("group", q.group);
  if (q.sort) p.set("sort", q.sort);
  if (q.format === undefined) {
    if (q.page !== undefined) p.set("page", String(q.page));
    if (q.perPage !== undefined) p.set("per_page", String(q.perPage));
  } else {
    p.set("format", q.format);
  }
  const consulta = p.toString();
  return `/v1/reports/${r.clave}${consulta === "" ? "" : `?${consulta}`}`;
}
