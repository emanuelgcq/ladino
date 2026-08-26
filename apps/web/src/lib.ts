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
