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
  /** La misma verdad en voz de persona (Fase C): qué pasó y qué hacer. */
  readonly person_message?: string;
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

/**
 * El error EN VOZ DE PERSONA, para las pantallas de negocio: primero el
 * `person_message` del servidor; si el dominio mandó un mensaje más concreto
 * que el genérico, ese (ya viene en español y dice qué hacer); y si no hay
 * nada usable, una frase honesta. Nunca un código, nunca un SQLSTATE.
 */
export function errorDePersona(e: unknown): string {
  if (e instanceof LlamadaApiError) {
    return e.body.person_message ?? e.body.message;
  }
  if (e instanceof TypeError) {
    return "No hay conexión con el servidor. Revisa tu internet y vuelve a intentar.";
  }
  return "Algo salió mal de nuestro lado. Vuelve a intentar; si sigue, avísanos.";
}

export interface Company {
  id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  /** Domicilio fiscal del emisor (PA 00071 art. 13.5). NULL hasta cargarlo en /empezar. */
  fiscal_address: string | null;
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
  // FormData pone su propio Content-Type con el boundary: fijarlo aquí lo
  // rompería (las subidas de foto y de Excel van en multipart).
  if (init.body !== undefined && !(init.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
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

// ── Compras (migración 22, ADR-0039/0040) ────────────────────────────────────

export interface Supplier {
  id: string;
  company_id: string;
  tax_id: string | null;
  legal_name: string;
  trade_name: string | null;
  /** Gobierna la forma fiscal: el extranjero no tiene RIF ni clasificación. */
  supplier_kind: "nacional" | "extranjero";
  person_type_code: string | null;
  taxpayer_type_code: string | null;
  fiscal_address: string | null;
  email: string | null;
  phone: string | null;
  status: string;
  payment_terms_days: number;
}
export interface PurchaseOrder {
  id: string;
  company_id: string;
  supplier_id: string;
  warehouse_id: string;
  order_number: number | null;
  status: string;
  /** DERIVADO de las recepciones, no leído de una columna. */
  derived_status?: string;
  ordered_at: string | null;
  expected_at: string | null;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
  amount_transaction_currency: string;
  functional_amount: string;
}
export interface PurchaseOrderDetail {
  order: PurchaseOrder;
  lines: {
    id: string;
    line_number: number;
    product_id: string;
    description: string;
    quantity: string;
    unit_price_transaction: string;
    line_total_transaction: string;
    unit_weight: string | null;
  }[];
  progress: {
    order_line_id: string;
    product_id: string;
    quantity_ordered: string;
    quantity_received: string;
    quantity_pending: string;
  }[];
  receipts: {
    id: string;
    receipt_number: number | null;
    status: string;
    received_at: string | null;
    functional_amount: string;
  }[];
  invoices: {
    id: string;
    supplier_document_number: string;
    invoice_date: string;
    status: string;
    total_amount: string;
  }[];
  derived_status: string;
}
export interface GoodsReceiptDetail {
  receipt: {
    id: string;
    supplier_id: string;
    purchase_order_id: string | null;
    warehouse_id: string;
    receipt_number: number | null;
    status: string;
    received_at: string | null;
    delivery_note_ref: string | null;
    transaction_currency: string;
    functional_currency: string;
    fx_rate: string;
    rate_source: string;
    functional_amount: string;
  };
  lines: {
    id: string;
    line_number: number;
    product_id: string;
    quantity: string;
    unit_price_transaction: string;
    unit_cost_functional: string;
    /** DERIVADO de las asignaciones: no es una columna (migración 24). */
    landed_cost_functional: string;
    unit_weight: string | null;
  }[];
  landed_costs: {
    id: string;
    concept: string;
    allocation_method: string;
    status: string;
    functional_amount: string;
    incurred_on: string;
  }[];
}
export interface SupplierInvoice {
  id: string;
  supplier_id: string;
  purchase_order_id: string | null;
  /** Del PROVEEDOR, como él lo emitió. Texto, no número. */
  supplier_document_number: string;
  supplier_control_number: string | null;
  supplier_document_ref: string | null;
  invoice_date: string;
  due_date: string | null;
  status: string;
  subtotal_amount: string;
  tax_amount: string;
  total_amount: string;
  /** Derivado del contribuyente de la EMPRESA, no configurable. */
  tax_is_recoverable: boolean;
  retention_total: string;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
  balance?: string;
  retentions?: SupplierRetention[];
}
export interface SupplierRetention {
  id: string;
  retention_code: string;
  concept_code: string;
  formula_kind: string;
  rate_snapshot: string;
  base_amount: string;
  retained_amount: string;
  /** La norma con la que se retuvo, copiada. Sin ella no sería auditable. */
  legal_source_snapshot: string;
  status: string;
}
export interface MatchingRow {
  invoice_line_id: string;
  product_id: string;
  qty_ordered: string | null;
  qty_received: string | null;
  qty_invoiced: string;
  price_ordered: string | null;
  price_invoiced: string;
  price_diff_pct: string | null;
}
export interface LandedCostResult {
  id: string;
  goods_receipt_id: string;
  concept: string;
  allocation_method: string;
  functional_amount: string;
  functional_currency: string;
  allocations: {
    goods_receipt_line_id: string;
    allocated_functional: string;
    to_inventory_functional: string;
    to_variance_functional: string;
    quantity_remaining: string;
    quantity_received: string;
  }[];
  /** Lo que NO capitalizó: gasto del período (ADR-0040 §6). */
  total_variance: string;
}
export interface ApAging {
  reference_date: string;
  buckets: { supplier_id: string; bucket: string; document_count: number; amount: string }[];
  total: string;
}
export interface SupplierStatement {
  supplier_id: string;
  currency: string;
  invoices: {
    id: string;
    supplier_document_number: string;
    invoice_date: string;
    due_date: string | null;
    status: string;
    total_amount: string;
    paid_amount: string;
    balance: string;
    days_outstanding: number;
  }[];
  total_outstanding: string;
  total_retained: string;
  aging: ApAging;
}
export interface RetentionRule {
  id: string;
  jurisdiction: string;
  retention_code: string;
  concept_code: string;
  formula_kind: string;
  rate: string;
  subtrahend: string | null;
  minimum_exempt: string | null;
  effective_from: string;
  effective_to: string | null;
  /** Obligatoria: una regla sin norma citada es una retención inventada. */
  legal_source: string;
  priority: number;
  status: string;
}
export interface RetentionConcept {
  code: string;
  retention_code: string;
  name: string;
  description: string;
}

// ── Contabilidad (migración 25, ADR-0041/0042/0043) ──────────────────────────
// Todos los importes son STRING y la webapp NO hace aritmética con ellos. El
// saldo, el balance y los estados llegan calculados por el esquema.

export interface Account {
  id: string;
  company_id: string;
  code: string;
  name: string;
  description: string | null;
  parent_id: string | null;
  kind: "activo" | "pasivo" | "patrimonio" | "ingreso" | "gasto" | "orden";
  nature: "deudora" | "acreedora";
  /** Solo las hojas activas reciben asientos. */
  is_leaf: boolean;
  is_active: boolean;
  currency_code: string | null;
  requires_analytical: boolean;
  level: number;
  path: string;
}
export interface ChartTemplate {
  code: string;
  name: string;
  /** Lleva VALIDAR-CONTABLE dentro: se muestra tal cual, sin recortar. */
  description: string;
  framework: string;
  legal_source: string;
  account_count: number;
}
export interface AccountPurposeRow {
  purpose: string;
  name: string;
  description: string;
  /** null = papel sin cuenta asignada. Es lo que impide generar su asiento. */
  account_id: string | null;
  account_code: string | null;
  account_name: string | null;
}
export interface JournalEntry {
  id: string;
  company_id: string;
  period_id: string;
  entry_number: number | null;
  posting_date: string;
  source_kind: string;
  source_id: string | null;
  source_event: string | null;
  description: string;
  memo: string | null;
  status: "draft" | "posted" | "reversed";
  posted_at: string | null;
  is_reversal_of: string | null;
  reversed_by_entry_id: string | null;
  rules_version: string | null;
  total_debit: string;
  total_credit: string;
}
export interface JournalLine {
  id: string;
  line_number: number;
  account_id: string;
  account_code: string;
  account_name: string;
  debit_amount: string;
  credit_amount: string;
  transaction_currency: string;
  fx_rate: string;
  functional_debit: string;
  functional_credit: string;
  functional_currency: string;
  rate_source: string;
  analytical_dimensions: Record<string, string> | null;
  description: string | null;
}
export interface JournalEntryDetail {
  entry: JournalEntry;
  lines: JournalLine[];
}
export interface LedgerView {
  account_id: string;
  account_code: string;
  account_name: string;
  nature: "deudora" | "acreedora";
  currency: string;
  opening_balance: string;
  closing_balance: string;
  movements: {
    entry_id: string;
    entry_number: number | null;
    posting_date: string;
    description: string;
    debit: string;
    credit: string;
    running_delta: string;
    source_kind: string;
    source_id: string | null;
  }[];
}
export interface TrialBalance {
  as_of: string;
  from_date: string | null;
  currency: string;
  rows: {
    account_id: string;
    account_code: string;
    account_name: string;
    nature: string;
    opening_balance: string;
    period_debit: string;
    period_credit: string;
    closing_balance: string;
  }[];
  total_debit: string;
  total_credit: string;
  /** Σ débitos == Σ créditos. Falso significa un asiento roto en la base. */
  balanced: boolean;
}
export interface FiscalPeriod {
  id: string;
  year: number;
  month: number;
  status: string;
  closed_at: string | null;
  reopened_at: string | null;
  reopened_reason: string | null;
  /** Lo que impide cerrar. Se muestra en la pantalla de cierre. */
  draft_entry_count: number;
  pending_queue_count: number;
}
export interface PendingJournal {
  items: {
    id: string;
    source_kind: string;
    source_id: string;
    source_event: string;
    reason: string;
    created_at: string;
  }[];
  total: number;
}
export interface IncomeStatement {
  from_date: string;
  to_date: string;
  currency: string;
  income: { account_code: string; account_name: string; amount: string }[];
  expenses: { account_code: string; account_name: string; amount: string }[];
  total_income: string;
  total_expenses: string;
  result: string;
}
export interface BalanceSheet {
  as_of: string;
  currency: string;
  assets: { account_code: string; account_name: string; amount: string }[];
  liabilities: { account_code: string; account_name: string; amount: string }[];
  equity: { account_code: string; account_name: string; amount: string }[];
  total_assets: string;
  total_liabilities: string;
  total_equity: string;
  /** activo == pasivo + patrimonio. Lo comprueba el servidor, no el cliente. */
  balanced: boolean;
}

// ── Libros fiscales (ADR-0044) ──────────────────────────────────────────────

export type BookKind = "ventas" | "compras" | "retenciones_iva" | "retenciones_islr";

export interface FiscalBook {
  book_kind: BookKind;
  period_from: string;
  period_to: string;
  currency: string;
  row_count: number;
  /**
   * Las filas van sin tipar columna a columna a propósito: son cuatro libros
   * con cuatro formas, las columnas las fija la migración 27 y la pantalla las
   * enseña tal como llegan. Tipar aquí las cuatro sería una quinta definición
   * que se desincroniza con las otras cuatro.
   */
  rows: Record<string, unknown>[];
  /** Renglones con base que el sistema NO puede clasificar. Se enseñan, no se reparten. */
  unclassified_rows: number;
}
export interface BookReconciliation {
  period_from: string;
  period_to: string;
  currency: string;
  rows: {
    concepto: string;
    libro: string;
    mayor: string;
    en_cola: string;
    diferencia: string;
    cuadra: boolean;
  }[];
  balanced: boolean;
}
export interface BookFormatAdapter {
  code: string;
  book_kind: string;
  name: string;
  description: string;
  /** Hoy NINGUNO: el layout del SENIAT no está en el repositorio y no se inventa. */
  is_official: boolean;
  legal_source: string;
  status: string;
  /** Si este release sabe escribirlo. Estar en el catálogo no es tener implementación. */
  implemented: boolean;
}
export interface FiscalBookRun {
  id: string;
  company_id: string;
  book_kind: BookKind;
  period_from: string;
  period_to: string;
  parameters: Record<string, unknown>;
  timezone: string;
  generator_version: string;
  dataset_hash: string;
  row_count: number;
  format_code: string;
  created_by: string | null;
  created_at: string;
}
