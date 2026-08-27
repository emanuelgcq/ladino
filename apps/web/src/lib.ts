import { createClient, type Session } from "@supabase/supabase-js";

/**
 * La webapp habla con DOS servicios y solo dos:
 *   · Supabase Auth (supabase-js con la publishable key) — SOLO sesión: signup,
 *     login, refresh. La webapp no toca PostgREST: los datos van SIEMPRE por
 *     la API (CLAUDE.md §7 — la app móvil/web no es vía para saltarse el
 *     backend).
 *   · La API de Ladino — fetch con el access_token como Bearer.
 *
 * Cero reglas de negocio aquí: presentación y llamadas (apps/web/CLAUDE.md).
 */
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string;
const publishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
export const API_URL = (import.meta.env.VITE_API_URL as string) ?? "http://127.0.0.1:3000";

export const supabase = createClient(supabaseUrl, publishableKey);

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly request_id?: string | null;
}

export class LlamadaApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiError,
  ) {
    super(`${body.code}: ${body.message}`);
  }
}

export interface Company {
  id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  status: string;
  created_at: string;
}
export interface Product {
  id: string;
  company_id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  status: "draft" | "active" | "inactive";
  unit_code: string;
  tax_category_code: string;
  category_id: string | null;
  barcode: string | null;
  /** Compuesto: se vende pero no se almacena (ADR-0035). */
  is_composed: boolean;
  template_id?: string | null;
  attributes?: Record<string, string> | null;
}
export interface PriceList {
  id: string;
  name: string;
  currency_code: string;
  status: string;
}
export interface PriceItem {
  id: string;
  product_id: string;
  amount: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
}
export interface Customer {
  id: string;
  company_id: string;
  tax_id: string | null;
  legal_name: string;
  trade_name: string | null;
  person_type_code: string;
  taxpayer_type_code: string;
  fiscal_address: string | null;
  email: string | null;
  phone: string | null;
  status: "lead" | "active" | "blocked" | "inactive";
  default_price_list_id: string | null;
}
export interface Warehouse {
  id: string;
  company_id: string;
  branch_id: string | null;
  code: string;
  name: string;
  status: "active" | "inactive";
}
export interface StockBalance {
  warehouse_id: string;
  warehouse_code: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  lot_id: string | null;
  lot_code: string | null;
  /** Cantidad e importes: STRING siempre. La webapp no hace aritmética con ellos. */
  quantity: string;
  value: string;
  currency: string;
  last_unit_cost: string;
}
export interface InventoryMove {
  id: string;
  warehouse_id: string;
  product_id: string;
  lot_id: string | null;
  kind: "entrada" | "salida" | "ajuste" | "transferencia_in" | "transferencia_out";
  quantity: string;
  functional_amount: string;
  functional_currency: string;
  amount_transaction_currency: string;
  transaction_currency: string;
  fx_rate: string;
  rate_source: string;
  unit_cost: string;
  /** Saldo y valor TRAS el movimiento, calculados y guardados por el servidor. */
  quantity_after: string;
  value_after: string;
  occurred_at: string;
  reference: string | null;
  reason: string | null;
  transfer_id: string | null;
}
export interface CodeCatalog {
  code: string;
  name: string;
  description: string;
}
export interface Unit {
  code: string;
  name: string;
  symbol: string;
}
export interface TaxCategory {
  code: string;
  name: string;
  description: string;
}

/** fetch con el contrato de la API: Bearer, JSON, y errores con `code` estable. */
export async function api<T>(
  session: Session,
  path: string,
  init: RequestInit & { companyId?: string } = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${session.access_token}`);
  if (init.body !== undefined) headers.set("Content-Type", "application/json");
  if (init.companyId) headers.set("X-Company-Id", init.companyId);
  const res = await fetch(`${API_URL}${path}`, { ...init, headers });
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    throw new LlamadaApiError(
      res.status,
      (body ?? { code: "UNKNOWN", message: `HTTP ${res.status}` }) as ApiError,
    );
  }
  return body as T;
}

export interface LowStockItem {
  warehouse_id: string;
  product_id: string;
  product_sku: string;
  product_name: string;
  quantity: string;
  stock_min: string;
  missing: string;
}
export interface ExpiringLot {
  lot_id: string;
  lot_code: string;
  product_id: string;
  product_sku: string;
  warehouse_id: string;
  expires_at: string;
  /** Negativo = ya vencido, y son los que más urgen. */
  days_left: number;
  quantity: string;
}
export interface RecipeLineView {
  child_product_id: string;
  child_sku: string;
  child_name: string;
  quantity: string;
  unit_code: string;
  product_unit_code: string;
  /** null = falta la conversión: esta receta NO se puede consumir. */
  quantity_in_product_unit: string | null;
}

// ── Ventas (migración 21, ADR-0037/0038) ─────────────────────────────────────
// Todos los importes son STRING y la webapp NO hace aritmética con ellos: los
// muestra con `mostrarImporte` y los manda tal cual. El saldo, el diferencial y
// la antigüedad los calcula el servidor y llegan calculados.

export interface SalesDocument {
  id: string;
  company_id: string;
  kind: "quote" | "order" | "invoice" | "credit_note" | "debit_note";
  series: string;
  /** null mientras es borrador: un correlativo fiscal solo existe al emitir. */
  document_number: number | null;
  /** null cuando el régimen no usa número de control (ADR-0037). */
  control_number: number | null;
  status: "draft" | "confirmed" | "issued" | "paid" | "annulled" | "cancelled";
  issued_at: string | null;
  annulled_at: string | null;
  annul_reason: string | null;
  customer_id: string;
  vendor_id: string | null;
  price_list_id: string | null;
  source_document_id: string | null;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
  subtotal_amount: string;
  tax_amount: string;
  total_amount: string;
  regime_version_id: string | null;
  rules_version: string | null;
}
export interface SalesDocumentLine {
  id: string;
  line_number: number;
  product_id: string;
  description: string;
  quantity: string;
  unit_price_transaction: string;
  unit_price_functional: string;
  price_list_applied_id: string | null;
  /** La regla tributaria concreta que se aplicó, congelada con la línea. */
  tax_rule_id: string | null;
  tax_rate_snapshot: string;
  tax_amount: string;
  line_subtotal_transaction: string;
  line_total_transaction: string;
  transaction_currency: string;
  fx_rate: string;
  functional_amount: string;
  functional_currency: string;
  rate_source: string;
  cost_snapshot: string | null;
}
export interface SalesPayment {
  id: string;
  document_id: string;
  paid_at: string;
  currency: string;
  amount: string;
  fx_rate: string;
  rate_source: string;
  functional_amount: string;
  instrument: string;
  reference: string | null;
  customer_credit_id: string | null;
}
export interface ExchangeGainLoss {
  id: string;
  document_id: string;
  payment_id: string;
  amount_transaction: string;
  transaction_currency: string;
  functional_at_issue: string;
  functional_at_payment: string;
  /** Positivo = ganancia cambiaria; negativo = pérdida. */
  difference: string;
  fx_rate_issue: string;
  fx_rate_payment: string;
  occurred_on: string;
}
export interface SalesDocumentDetail {
  document: SalesDocument;
  lines: SalesDocumentLine[];
  payments: SalesPayment[];
  exchange_differences: ExchangeGainLoss[];
  /** Calculado por el servidor: total − Σ cobros. Nunca se recalcula aquí. */
  balance: string;
}
export interface AgingBucketRow {
  customer_id: string;
  bucket: "0-30" | "31-60" | "61-90" | "90+";
  document_count: number;
  amount: string;
}
export interface Aging {
  reference_date: string;
  buckets: AgingBucketRow[];
  total: string;
}
export interface CustomerStatement {
  customer_id: string;
  currency: string;
  documents: {
    id: string;
    kind: string;
    series: string;
    document_number: number | null;
    issued_at: string | null;
    status: string;
    total_amount: string;
    paid_amount: string;
    balance: string;
    days_outstanding: number;
  }[];
  credits: {
    id: string;
    source_document_id: string;
    amount: string;
    applied_amount: string;
    status: "available" | "applied" | "expired";
  }[];
  total_outstanding: string;
  total_credit_available: string;
  aging: Aging;
}
export interface SalesReturn {
  id: string;
  source_document_id: string;
  credit_note_id: string | null;
  status: "draft" | "confirmed" | "cancelled";
  reason: string;
  warehouse_id: string;
  lines: {
    source_line_id: string;
    product_id: string;
    quantity: string;
    /** El costo ORIGINAL: el reingreso no usa el costo de hoy. */
    unit_cost_original: string;
    unit_price_transaction: string;
  }[];
  customer_credit_id: string | null;
}
export interface FiscalRange {
  id: string;
  kind: string;
  series: string;
  range_from: number;
  range_to: number;
  next_available: number;
  status: "active" | "exhausted" | "cancelled";
  printer_source: string;
  remaining: number;
}
export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: string;
  source: string;
  rate_date: string;
}
export interface ExchangeDifferenceReport {
  currency: string;
  ganancia: string;
  perdida: string;
  neto: string;
  by_month: { month: string; amount: string }[];
}
