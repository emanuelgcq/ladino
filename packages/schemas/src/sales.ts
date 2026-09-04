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

export const DocumentKind = z.enum([
  "quote",
  "order",
  "invoice",
  "credit_note",
  "debit_note",
  "receipt",
]);
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
  series: z.string().trim().min(1).max(30).optional(),
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
    /** ADR-0046: procedencia de la conversión lista→funcional (null si la lista ya era funcional). */
    pricing_currency: z.string().nullable(),
    pricing_fx_rate: z.string().nullable(),
    pricing_rate_source: z.string().nullable(),
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

// ── El PUNTO DE VENTA de la Fase C ──────────────────────────────────────────

/**
 * Cotizar el carrito SIN crear nada: la pantalla de Vender pregunta con
 * debounce y el servidor responde los totales — el cliente NUNCA calcula
 * dinero (regla de apps/web). Sin cliente explícito, es la venta de mostrador
 * (Consumidor final) con la lista «detal» resuelta por el servidor.
 */
export const PosQuoteRequest = z
  .object({
    company_id: uuid,
    customer_id: uuid.optional(),
    price_list_id: uuid.optional(),
    lines: z.array(DocumentLineRequest).min(1).max(200),
  })
  .strict();
export type PosQuoteRequest = z.infer<typeof PosQuoteRequest>;

export const PosQuoteLine = z
  .object({
    product_id: uuid,
    description: z.string(),
    quantity: z.string(),
    unit_price: z.string(),
    /** ADR-0046: el precio de lista exacto en la moneda ancla (USD); null si la lista era funcional. */
    reference_unit_price: z.string().nullable(),
    subtotal: z.string(),
    tax_rate: z.string(),
    tax_amount: z.string(),
    total: z.string(),
  })
  .strict();
export type PosQuoteLine = z.infer<typeof PosQuoteLine>;

export const PosQuoteResponse = z
  .object({
    customer_id: uuid,
    price_list_id: uuid,
    currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    /** ADR-0046: la conversión lista→Bs que formó estos importes, y el total de referencia en la moneda ancla. */
    pricing_currency: z.string().nullable(),
    pricing_fx_rate: z.string().nullable(),
    pricing_rate_source: z.string().nullable(),
    reference_total: z.string().nullable(),
    lines: z.array(PosQuoteLine),
    subtotal: z.string(),
    tax_amount: z.string(),
    total: z.string(),
    functional_total: z.string(),
    functional_currency: z.string(),
  })
  .strict();
export type PosQuoteResponse = z.infer<typeof PosQuoteResponse>;

/**
 * Un pago del COBRAR: `amount` es lo ENTREGADO. Si es efectivo y supera lo
 * pendiente, el servidor registra lo aplicado y devuelve el vuelto; si no es
 * efectivo, pasarse es un error — un punto de venta no da vuelto por tarjeta.
 */
export const QuickSalePaymentInput = z
  .object({
    instrument: PaymentInstrument.exclude(["saldo_a_favor"]),
    amount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().trim().min(1).max(100).optional(),
    account_id: uuid.optional(),
  })
  .strict();
export type QuickSalePaymentInput = z.infer<typeof QuickSalePaymentInput>;

/**
 * La VENTA RÁPIDA: factura emitida + cobros + vuelto, en una transacción.
 * El `Idempotency-Key` es el id de venta del cliente: reintentar con la misma
 * clave devuelve la MISMA venta, nunca una segunda factura.
 */
export const QuickSaleRequest = z
  .object({
    company_id: uuid,
    /** Sin cliente = venta de mostrador (el «Consumidor final» de sistema). */
    customer_id: uuid.optional(),
    warehouse_id: uuid,
    branch_id: uuid.nullable().optional(),
    series: z.string().trim().min(1).max(30).optional(),
    price_list_id: uuid.optional(),
    lines: z.array(DocumentLineRequest).min(1).max(200),
    /** Hasta DOS formas de pago (decisión de la fase: más es otra pantalla). */
    payments: z.array(QuickSalePaymentInput).max(2).optional(),
  })
  .strict();
export type QuickSaleRequest = z.infer<typeof QuickSaleRequest>;

export const QuickSaleResponse = z
  .object({
    document: DocumentResponse,
    payments: z.array(RegisterPaymentResponse),
    /** El vuelto de efectivo, si lo hubo. Calculado en el SERVIDOR. */
    change: z.object({ amount: z.string(), currency: z.string() }).strict().nullable(),
    balance: z.string(),
    document_status: DocumentStatus,
  })
  .strict();
export type QuickSaleResponse = z.infer<typeof QuickSaleResponse>;

/** El vuelto en vivo, antes de confirmar: puro cálculo del servidor. */
export const PosChangeResponse = z
  .object({
    total: z.string(),
    currency: z.string(),
    tendered: z.string(),
    tendered_currency: z.string(),
    rate: z.string(),
    rate_source: z.string(),
    /** Lo que se devuelve, en la MONEDA con la que pagaron. Negativo = falta. */
    change: z.string(),
    change_currency: z.string(),
  })
  .strict();
export type PosChangeResponse = z.infer<typeof PosChangeResponse>;

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
    series: z.string().trim().min(1).max(30),
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

/**
 * Contingencia (PA 102, migración 35): el talonario físico con la palabra
 * «contingencia» en la serie, y el registro A POSTERIORI de cada factura
 * emitida en papel durante la falla — con los números tal como quedaron
 * impresos, que el registro tiene que reproducir o negarse.
 */
export const RegisterContingencyRangeRequest = z
  .object({
    company_id: uuid,
    /** La serie impresa en el talonario; debe empezar por «contingencia». */
    series: z
      .string()
      .trim()
      .regex(
        /^contingencia/i,
        "la serie de un talonario de contingencia empieza por «contingencia»",
      )
      .max(30),
    range_from: z.string().regex(/^\d{1,18}$/),
    range_to: z.string().regex(/^\d{1,18}$/),
    printer_source: z.string().trim().min(1).max(200),
    /** Por qué se emitió en papel: la falla, contada para el fiscalizador. */
    reason: z.string().trim().min(5).max(500),
    failure_started_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type RegisterContingencyRangeRequest = z.infer<typeof RegisterContingencyRangeRequest>;

export const ContingencyRangeResponse = z
  .object({
    id: uuid,
    fiscal_number_range_id: uuid,
    series: z.string(),
    range_from: z.number().int(),
    range_to: z.number().int(),
    next_available: z.number().int(),
    remaining: z.number().int(),
    status: z.string(),
    reason: z.string(),
    failure_started_at: z.string().datetime({ offset: true }),
    failure_ended_at: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type ContingencyRangeResponse = z.infer<typeof ContingencyRangeResponse>;

export const RegisterContingencyInvoiceRequest = z
  .object({
    company_id: uuid,
    contingency_range_id: uuid,
    customer_id: uuid,
    warehouse_id: uuid,
    price_list_id: uuid.optional(),
    /** Cuándo se emitió EN PAPEL: dentro del período de la falla. */
    issued_at: z.string().datetime({ offset: true }),
    lines: z.array(DocumentLineRequest).min(1).max(500),
    /** Los números tal como quedaron impresos en el talonario. */
    paper_document_number: z.string().regex(/^\d{1,18}$/),
    paper_control_number: z.string().regex(/^\d{1,18}$/),
  })
  .strict();
export type RegisterContingencyInvoiceRequest = z.infer<typeof RegisterContingencyInvoiceRequest>;

export const CloseContingencyRequest = z
  .object({ company_id: uuid, failure_ended_at: z.string().datetime({ offset: true }) })
  .strict();
export type CloseContingencyRequest = z.infer<typeof CloseContingencyRequest>;

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

/**
 * Puesta a punto fiscal del asistente (Fase C, PARTE 4): el catálogo de
 * regímenes con su norma citada, el vigente de la empresa y si la alícuota
 * general del IVA ya fue aceptada en esta instancia.
 */
export const FiscalSetupResponse = z
  .object({
    regimes: z.array(
      z
        .object({
          code: z.string(),
          name: z.string(),
          description: z.string(),
          numbering_mode: z.string(),
          /** La norma que sustenta el régimen, sembrada en la migración. */
          legal_source: z.string(),
        })
        .strict(),
    ),
    current_regime: z.string().nullable(),
    iva_general: z.object({ rate: amount, legal_source: z.string() }).strict().nullable(),
  })
  .strict();
export type FiscalSetupResponse = z.infer<typeof FiscalSetupResponse>;

export const AssignFiscalRegimeRequest = z
  .object({ regime_code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/) })
  .strict();
export type AssignFiscalRegimeRequest = z.infer<typeof AssignFiscalRegimeRequest>;

/**
 * La ACEPTACIÓN consciente de la alícuota general del IVA. Ladino no la
 * afirma: la declara la persona y queda su acta (VALIDAR-TRIBUTARIO).
 */
export const AcceptIvaGeneralRequest = z
  .object({
    /** Como fracción: "0.16" es 16%. */
    rate: z.string().regex(/^0(\.\d{1,4})?$/),
  })
  .strict();
export type AcceptIvaGeneralRequest = z.infer<typeof AcceptIvaGeneralRequest>;

export const AcceptIvaGeneralResponse = z
  .object({
    rate: amount,
    /** Cuántas reglas creó esta aceptación (0 si otra empresa ya las creó). */
    rules_created: z.number().int(),
    accepted_on: z.string().date(),
  })
  .strict();
export type AcceptIvaGeneralResponse = z.infer<typeof AcceptIvaGeneralResponse>;
