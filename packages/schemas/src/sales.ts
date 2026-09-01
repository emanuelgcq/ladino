import { z } from "zod";

/**
 * Contratos de ventas (migración 21, ADR-0037/0038). Todo importe y toda
 * cantidad viajan como STRING decimal — regla 7. Ninguna alícuota aparece aquí:
 * la resuelve `platform.resolve_tax()` y la línea la persiste (ADR-0038).
 */
const uuid = z.string().uuid();
const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");
const noEsCero = (v: string): boolean => /[1-9]/.test(v);
const quantity = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "cantidad decimal como string")
  .refine(noEsCero, "la cantidad debe ser mayor que cero");

export const DocumentKind = z.enum(["quote", "order", "invoice", "credit_note", "debit_note"]);
export const DocumentStatus = z.enum([
  "draft",
  "confirmed",
  "issued",
  "paid",
  "annulled",
  "cancelled",
]);
export const PaymentInstrument = z.enum([
  "efectivo_bs",
  "efectivo_usd",
  "zelle",
  "usdt",
  "transferencia",
  "punto_venta",
  "pago_movil",
  "tarjeta",
  "saldo_a_favor",
  "otro",
]);

export const DocumentLineRequest = z
  .object({
    product_id: uuid,
    quantity,
    /** Descripción; por omisión, el nombre del producto. */
    description: z.string().trim().min(1).max(300).optional(),
  })
  .strict();
export type DocumentLineRequest = z.infer<typeof DocumentLineRequest>;

const documentoBase = {
  company_id: uuid,
  customer_id: uuid,
  branch_id: uuid.nullable().optional(),
  /** Gancho de comisiones: se registra quién vendió, nada más (encargo). */
  vendor_id: uuid.nullable().optional(),
  /**
   * La lista de precios. Si se manda una distinta a la preferida del cliente,
   * exige `sales.price_list.override` — cambiar el precio de una venta es una
   * atribución, no una preferencia de pantalla.
   */
  price_list_id: uuid.optional(),
  series: z.string().trim().min(1).max(10).optional(),
  lines: z.array(DocumentLineRequest).min(1).max(500),
  notes: z.string().trim().min(1).max(1000).optional(),
};

export const CreateQuoteRequest = z.object({ ...documentoBase }).strict();
export type CreateQuoteRequest = z.infer<typeof CreateQuoteRequest>;

export const CreateOrderRequest = z
  .object({ ...documentoBase, source_document_id: uuid.optional() })
  .strict();
export type CreateOrderRequest = z.infer<typeof CreateOrderRequest>;

export const ConfirmOrderRequest = z
  .object({
    company_id: uuid,
    /** Dónde se reserva el stock. Sin almacén no hay reserva que hacer. */
    warehouse_id: uuid,
  })
  .strict();
export type ConfirmOrderRequest = z.infer<typeof ConfirmOrderRequest>;

export const CreateInvoiceRequest = z
  .object({
    ...documentoBase,
    /** Almacén del que sale la mercancía: la emisión genera el kardex. */
    warehouse_id: uuid,
    source_document_id: uuid.optional(),
    /** Fecha de emisión; por omisión, la del servidor. */
    issued_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type CreateInvoiceRequest = z.infer<typeof CreateInvoiceRequest>;

export const AnnulInvoiceRequest = z
  .object({ company_id: uuid, reason: z.string().trim().min(3).max(500) })
  .strict();
export type AnnulInvoiceRequest = z.infer<typeof AnnulInvoiceRequest>;

export const RegisterPaymentRequest = z
  .object({
    company_id: uuid,
    document_id: uuid,
    currency: z.string().regex(/^[A-Z]{3}$/),
    amount,
    instrument: PaymentInstrument,
    reference: z.string().trim().min(1).max(100).optional(),
    paid_at: z.string().datetime({ offset: true }).optional(),
    /** Obligatorio cuando el instrumento es `saldo_a_favor`. */
    customer_credit_id: uuid.optional(),
    /**
     * A qué cuenta ENTRA el dinero (migración 29). Opcional: sin ella el
     * servidor resuelve por la forma de pago configurada para el instrumento,
     * y en último término por «Sin asignar (<moneda>)». Con `saldo_a_favor`
     * no se admite: aplicar un crédito no mete efectivo en ninguna cuenta.
     */
    account_id: uuid.optional(),
  })
  .strict();
export type RegisterPaymentRequest = z.infer<typeof RegisterPaymentRequest>;

export const CreateReturnRequest = z
  .object({
    company_id: uuid,
    /** OBLIGATORIO: no hay devolución sin documento origen. */
    source_document_id: uuid,
    warehouse_id: uuid,
    reason: z.string().trim().min(3).max(500),
    lines: z
      .array(z.object({ source_line_id: uuid, quantity }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type CreateReturnRequest = z.infer<typeof CreateReturnRequest>;

export const DocumentLineResponse = z
  .object({
    id: uuid,
    line_number: z.number().int().positive(),
    product_id: uuid,
    description: z.string(),
    quantity: z.string(),
    unit_price_transaction: z.string(),
    unit_price_functional: z.string(),
    price_list_applied_id: uuid.nullable(),
    tax_rule_id: uuid.nullable(),
    tax_rate_snapshot: z.string(),
    tax_amount: z.string(),
    line_subtotal_transaction: z.string(),
    line_total_transaction: z.string(),
    transaction_currency: z.string(),
    fx_rate: z.string(),
    functional_amount: z.string(),
    functional_currency: z.string(),
    rate_source: z.string(),
    cost_snapshot: z.string().nullable(),
  })
  .strict();
export type DocumentLineResponse = z.infer<typeof DocumentLineResponse>;

export const DocumentResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    kind: DocumentKind,
    series: z.string(),
    document_number: z.number().int().nullable(),
    control_number: z.number().int().nullable(),
    status: DocumentStatus,
    issued_at: z.string().datetime({ offset: true }).nullable(),
    annulled_at: z.string().datetime({ offset: true }).nullable(),
    annul_reason: z.string().nullable(),
    customer_id: uuid,
    vendor_id: uuid.nullable(),
    price_list_id: uuid.nullable(),
    source_document_id: uuid.nullable(),
    transaction_currency: z.string(),
    functional_currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    subtotal_amount: z.string(),
    tax_amount: z.string(),
    total_amount: z.string(),
    regime_version_id: uuid.nullable(),
    rules_version: z.string().nullable(),
  })
  .strict();
export type DocumentResponse = z.infer<typeof DocumentResponse>;

export const PaymentResponse = z
  .object({
    id: uuid,
    document_id: uuid,
    paid_at: z.string().datetime({ offset: true }),
    currency: z.string(),
    amount: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    functional_amount: z.string(),
    instrument: PaymentInstrument,
    reference: z.string().nullable(),
    customer_credit_id: uuid.nullable(),
  })
  .strict();
export type PaymentResponse = z.infer<typeof PaymentResponse>;

export const ExchangeGainLossResponse = z
  .object({
    id: uuid,
    document_id: uuid,
    payment_id: uuid,
    amount_transaction: z.string(),
    transaction_currency: z.string(),
    functional_at_issue: z.string(),
    functional_at_payment: z.string(),
    difference: z.string(),
    fx_rate_issue: z.string(),
    fx_rate_payment: z.string(),
    occurred_on: z.string(),
  })
  .strict();
export type ExchangeGainLossResponse = z.infer<typeof ExchangeGainLossResponse>;

/** Un documento con todo lo que hace falta para entenderlo de una mirada. */
export const DocumentDetailResponse = z
  .object({
    document: DocumentResponse,
    lines: z.array(DocumentLineResponse),
    payments: z.array(PaymentResponse),
    exchange_differences: z.array(ExchangeGainLossResponse),
    /** Calculado, nunca persistido: total − Σ cobros. */
    balance: z.string(),
  })
  .strict();
export type DocumentDetailResponse = z.infer<typeof DocumentDetailResponse>;

export const ListDocumentsResponse = z
  .object({ items: z.array(DocumentResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponse>;

export const RegisterPaymentResponse = z
  .object({
    payment: PaymentResponse,
    /** null cuando no hubo diferencia de tasa que registrar. */
    exchange_difference: ExchangeGainLossResponse.nullable(),
    balance: z.string(),
    document_status: DocumentStatus,
  })
  .strict();
export type RegisterPaymentResponse = z.infer<typeof RegisterPaymentResponse>;

export const ReturnResponse = z
  .object({
    id: uuid,
    source_document_id: uuid,
    credit_note_id: uuid.nullable(),
    status: z.enum(["draft", "confirmed", "cancelled"]),
    reason: z.string(),
    warehouse_id: uuid,
    lines: z.array(
      z
        .object({
          source_line_id: uuid,
          product_id: uuid,
          quantity: z.string(),
          /** El costo ORIGINAL, copiado: el reingreso no usa el costo de hoy. */
          unit_cost_original: z.string(),
          unit_price_transaction: z.string(),
        })
        .strict(),
    ),
    /** El saldo a favor que generó la nota de crédito, si ya se confirmó. */
    customer_credit_id: uuid.nullable(),
  })
  .strict();
export type ReturnResponse = z.infer<typeof ReturnResponse>;

export const AgingResponse = z
  .object({
    reference_date: z.string(),
    buckets: z.array(
      z
        .object({
          customer_id: uuid,
          bucket: z.enum(["0-30", "31-60", "61-90", "90+"]),
          document_count: z.number().int().nonnegative(),
          amount: z.string(),
        })
        .strict(),
    ),
    total: z.string(),
  })
  .strict();
export type AgingResponse = z.infer<typeof AgingResponse>;

export const CustomerStatementResponse = z
  .object({
    customer_id: uuid,
    currency: z.string(),
    documents: z.array(
      z
        .object({
          id: uuid,
          kind: DocumentKind,
          series: z.string(),
          document_number: z.number().int().nullable(),
          issued_at: z.string().datetime({ offset: true }).nullable(),
          status: DocumentStatus,
          total_amount: z.string(),
          paid_amount: z.string(),
          balance: z.string(),
          days_outstanding: z.number().int(),
        })
        .strict(),
    ),
    credits: z.array(
      z
        .object({
          id: uuid,
          source_document_id: uuid,
          amount: z.string(),
          applied_amount: z.string(),
          status: z.enum(["available", "applied", "expired"]),
        })
        .strict(),
    ),
    total_outstanding: z.string(),
    total_credit_available: z.string(),
    aging: AgingResponse,
  })
  .strict();
export type CustomerStatementResponse = z.infer<typeof CustomerStatementResponse>;

export const CreateFiscalRangeRequest = z
  .object({
    company_id: uuid,
    kind: z.enum(["invoice", "credit_note", "debit_note", "delivery_note"]),
    series: z.string().trim().min(1).max(10),
    range_from: z.string().regex(/^\d{1,18}$/),
    range_to: z.string().regex(/^\d{1,18}$/),
    printer_source: z.string().trim().min(1).max(200),
    alert_threshold_pct: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type CreateFiscalRangeRequest = z.infer<typeof CreateFiscalRangeRequest>;

export const FiscalRangeResponse = z
  .object({
    id: uuid,
    kind: z.string(),
    series: z.string(),
    range_from: z.number().int(),
    range_to: z.number().int(),
    next_available: z.number().int(),
    status: z.enum(["active", "exhausted", "cancelled"]),
    printer_source: z.string(),
    remaining: z.number().int(),
  })
  .strict();
export type FiscalRangeResponse = z.infer<typeof FiscalRangeResponse>;

/** Carga manual de tasa: el fallback del adaptador BCV (ADR-0028). */
export const CreateExchangeRateRequest = z
  .object({
    from_currency: z.string().regex(/^[A-Z]{3}$/),
    to_currency: z.string().regex(/^[A-Z]{3}$/),
    rate: amount,
    /** Sin fuente no se persiste una tasa (ADR-0020). */
    source: z.string().trim().min(1).max(120),
    rate_date: z.string().date(),
  })
  .strict();
export type CreateExchangeRateRequest = z.infer<typeof CreateExchangeRateRequest>;
