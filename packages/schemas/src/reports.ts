import { z } from "zod";

/**
 * LOS REPORTES Y LAS CARTERAS (recorrido 2026-09-24: P-07, F-13 y H-11).
 *
 * Cada reporte es una consulta del SERVIDOR bajo `/v1/reports/…`. Todos responden la MISMA forma
 * —una tabla con sus columnas tipadas, sus filas, sus totales y un resumen— para que la pantalla
 * la pinte sin calcular nada y para que la descarga (`format=csv|xlsx`) salga de la misma
 * respuesta que se vio.
 *
 * Dinero: siempre `string`, redondeado al servir. `null` NO es cero: es «no se puede decir»
 * (falta la tasa de hoy, o el rol no ve ese importe), y la respuesta trae el motivo.
 *
 * Fechas: todo rango es de DÍAS de Caracas (`YYYY-MM-DD`), los dos extremos incluidos.
 */

// `z.string().date()` exige la forma AAAA-MM-DD Y que el día exista (el 30 de febrero no pasa):
// el mismo validador de las fechas de `igtf.ts` y `accounting.ts`.
const Dia = z.string().date("La fecha va como AAAA-MM-DD y tiene que existir en el calendario.");

export const ReportFormat = z.enum(["json", "csv", "xlsx"]);
export type ReportFormat = z.infer<typeof ReportFormat>;

/** Cómo se lee una celda: decide el formato en pantalla y en la descarga. */
export const ReportColumnKind = z.enum(["text", "date", "integer", "quantity", "money", "percent"]);
export type ReportColumnKind = z.infer<typeof ReportColumnKind>;

export const ReportColumn = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: ReportColumnKind,
    /** Solo en `money`: la moneda de la columna si NO es la del reporte (un nominal en divisa). */
    currency: z.string().optional(),
  })
  .strict();
export type ReportColumn = z.infer<typeof ReportColumn>;

/** Una cifra con nombre, fuera de la tabla (el total de la cartera, el diferencial…). */
export const ReportSummaryLine = z
  .object({
    key: z.string(),
    label: z.string(),
    kind: ReportColumnKind,
    value: z.string().nullable(),
    currency: z.string().optional(),
    /** Por qué `value` es null. */
    reason: z.enum(["sin_tasa", "sin_permiso", "sin_dato"]).nullable().optional(),
  })
  .strict();
export type ReportSummaryLine = z.infer<typeof ReportSummaryLine>;

export const ReportName = z.enum([
  "sales",
  "margin",
  "iva",
  "inventory",
  "receivables",
  "payables",
  "cash-closings",
  "igtf",
]);
export type ReportName = z.infer<typeof ReportName>;

export const ReportTable = z
  .object({
    report: ReportName,
    title: z.string(),
    /** El rango pedido; null en los reportes «a hoy» (carteras e inventario valorizado). */
    from: z.string().nullable(),
    to: z.string().nullable(),
    /** El día de Caracas en que se calculó. */
    as_of: z.string(),
    /** La moneda de la empresa: la de toda columna `money` sin `currency` propia. */
    currency: z.string(),
    group: z.string().nullable(),
    columns: z.array(ReportColumn),
    rows: z.array(z.record(z.string(), z.string().nullable())),
    /** Por clave de columna. Solo las columnas que tiene sentido sumar. */
    totals: z.record(z.string(), z.string().nullable()),
    summary: z.array(ReportSummaryLine),
    /** Lo que la cifra incluye y lo que no, en voz de persona. */
    notes: z.array(z.string()),
    /** Filas en total (antes de paginar). */
    row_count: z.number().int(),
    page: z.number().int(),
    per_page: z.number().int(),
  })
  .strict();
export type ReportTable = z.infer<typeof ReportTable>;

const rango = {
  from: Dia,
  to: Dia,
  format: ReportFormat.optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(500).optional(),
};
const aHoy = {
  format: ReportFormat.optional(),
  page: z.coerce.number().int().min(1).optional(),
  per_page: z.coerce.number().int().min(1).max(500).optional(),
};
const enOrden = (q: { from: string; to: string }): boolean => q.from <= q.to;
const FUERA_DE_ORDEN = { message: "«from» no puede ser posterior a «to».", path: ["from"] };

export const SalesReportGroup = z.enum([
  "day",
  "month",
  "product",
  "customer",
  "payment_method",
  "seller",
]);
export type SalesReportGroup = z.infer<typeof SalesReportGroup>;
export const SalesReportQuery = z
  .object({ ...rango, group: SalesReportGroup.optional() })
  .strict()
  .refine(enOrden, FUERA_DE_ORDEN);
export type SalesReportQuery = z.infer<typeof SalesReportQuery>;

export const MarginReportGroup = z.enum(["product", "month", "day"]);
export type MarginReportGroup = z.infer<typeof MarginReportGroup>;
export const MarginReportQuery = z
  .object({ ...rango, group: MarginReportGroup.optional() })
  .strict()
  .refine(enOrden, FUERA_DE_ORDEN);
export type MarginReportQuery = z.infer<typeof MarginReportQuery>;

export const CashClosingsReportGroup = z.enum(["closing", "cashier"]);
export type CashClosingsReportGroup = z.infer<typeof CashClosingsReportGroup>;
export const CashClosingsReportQuery = z
  .object({ ...rango, group: CashClosingsReportGroup.optional() })
  .strict()
  .refine(enOrden, FUERA_DE_ORDEN);
export type CashClosingsReportQuery = z.infer<typeof CashClosingsReportQuery>;

/** IVA del período, inventario (la rotación se mide en el rango) e IGTF: solo el rango. */
export const RangeReportQuery = z.object(rango).strict().refine(enOrden, FUERA_DE_ORDEN);
export type RangeReportQuery = z.infer<typeof RangeReportQuery>;

/** «Quién me debe» (F-13). `oldest` = el vencimiento más antiguo primero. */
export const ReceivablesSort = z.enum(["debt_desc", "overdue_desc", "oldest", "name"]);
export type ReceivablesSort = z.infer<typeof ReceivablesSort>;
export const ReceivablesReportQuery = z
  .object({ ...aHoy, sort: ReceivablesSort.optional() })
  .strict();
export type ReceivablesReportQuery = z.infer<typeof ReceivablesReportQuery>;

/** «Qué debo» (H-11). `due` = lo que vence (o venció) antes, primero. */
export const PayablesSort = z.enum(["debt_desc", "overdue_desc", "due", "name"]);
export type PayablesSort = z.infer<typeof PayablesSort>;
export const PayablesReportQuery = z.object({ ...aHoy, sort: PayablesSort.optional() }).strict();
export type PayablesReportQuery = z.infer<typeof PayablesReportQuery>;
