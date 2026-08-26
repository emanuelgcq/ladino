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
