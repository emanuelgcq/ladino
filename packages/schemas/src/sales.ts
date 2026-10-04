import { z } from "zod";

/**
 * Contratos de ventas (migración 21, ADR-0037/0038). Todo importe y toda
 * cantidad viajan como STRING decimal — regla 7. Ninguna alícuota aparece aquí:
 * la resuelve `platform.resolve_tax()` y la línea la persiste (ADR-0038).
 */
const uuid = z.string().uuid();
/**
 * La serie de un documento fiscal: letras, dígitos y guion. Va impresa, a la
 * numeración y a la cabecera Content-Disposition del PDF — un carácter libre
 * ahí es inyección de cabeceras (auditoría 2026-09-11, M-32).
 */
// '' = el papel no trae serie («serie si el papel la trae», RESPUESTA §2.1; ADR-0071, H11).
const serie = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9-]{0,30}$/, "la serie admite letras, dígitos y guion, hasta 30");
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
  /** ADR-0061: recibo de devolución — corrige un recibo; no fiscal, fuera de los libros. */
  "receipt_return",
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
  // Crédito de consumo (compra ahora, paga después): cobra la VENTA; a un
  // proveedor no se le paga así (PurchaseInstrument no lo tiene). Migración 42.
  "cashea",
  "saldo_a_favor",
  // Retención de IVA que un cliente-agente nos practicó (migración 46): abona
  // la factura afectada SIN mover efectivo, contra su comprobante transcrito.
  "retencion_iva",
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
  series: serie.optional(),
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
    /** Obligatorio cuando el instrumento es `retencion_iva`: el comprobante. */
    supported_retention_id: uuid.optional(),
    /**
     * A qué cuenta ENTRA el dinero (migración 29). Opcional: sin ella el
     * servidor resuelve por la forma de pago configurada para el instrumento,
     * y en último término por «Sin asignar (<moneda>)». Con `saldo_a_favor`
     * no se admite: aplicar un crédito no mete efectivo en ninguna cuenta.
     */
    account_id: uuid.optional(),
    /**
     * F-05 (RESPUESTA §2.6; revisión 11, decidido por criterio «nunca se registra dinero que no
     * entró»). POR OMISIÓN (sin el campo, o `true`) `amount` es lo que el cliente ENTREGÓ, con el
     * IGTF dentro: si el pago causa IGTF, el servidor lo reparte como la caja —base + IGTF(base) =
     * entregado— y lo que no alcance queda pendiente en el documento. Con `false`, `amount` es lo
     * que ABONA al documento y el IGTF se percibe aparte: solo para quien ya repartió lo entregado
     * con el mismo cálculo (`/v1/pos/tender`). CAMBIO DE COMPORTAMIENTO del contrato: antes, por
     * omisión, el IGTF se percibía ADEMÁS de `amount`.
     */
    igtf_included: z.boolean().optional(),
  })
  .strict();
export type RegisterPaymentRequest = z.infer<typeof RegisterPaymentRequest>;

/**
 * NOTA DE CRÉDITO DIRECTA (ADR-0051): corrige una factura SIN devolución de
 * mercancía — descuento o corrección de precio. Las líneas son un subconjunto
 * de las del origen, al precio DEL ORIGEN; motivo obligatorio (acta). Genera
 * saldo a favor, igual que la NC de devolución: una sola semántica de NC.
 */
export const CreateDirectCreditNoteRequest = z
  .object({
    company_id: uuid,
    source_document_id: uuid,
    reason: z.string().trim().min(3).max(500),
    lines: z
      .array(z.object({ source_line_id: uuid, quantity }).strict())
      .min(1)
      .max(500),
  })
  .strict();
export type CreateDirectCreditNoteRequest = z.infer<typeof CreateDirectCreditNoteRequest>;

/**
 * NOTA DE DÉBITO (ADR-0051): el espejo de la factura — intereses de mora,
 * fletes, diferencias de precio. Referida obligatoriamente a su factura,
 * líneas con precio EXPLÍCITO en la moneda del origen, motivo obligatorio.
 * ES deuda: entra al saldo y al aging del cliente.
 */
export const CreateDebitNoteRequest = z
  .object({
    company_id: uuid,
    source_document_id: uuid,
    reason: z.string().trim().min(3).max(500),
    lines: z
      .array(
        z
          .object({
            product_id: uuid,
            quantity,
            unit_price: amount,
            /**
             * B-5 (aditivo): la línea de la factura que la ND corrige. Con ella, la ND va a la
             * alícuota y condición de esa línea, como la NC; sin ella (ajuste global), a la de hoy.
             */
            source_line_id: uuid.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(200),
    /**
     * Hallazgo 13 (§2.7, G-11): "corrects_invoice" (por omisión) va a la tasa de la factura;
     * "new_concept" (interés, flete) va a la tasa BCV del día de la nota. Aditivo.
     */
    basis: z.enum(["corrects_invoice", "new_concept"]).optional(),
  })
  .strict();
export type CreateDebitNoteRequest = z.infer<typeof CreateDebitNoteRequest>;

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
    /** Los 2 dígitos del identificador del control (ADR-0071): se imprime `00-00001234`. */
    control_identifier: z.string().nullable(),
    /**
     * El control como se imprime, `00-00001234` (ADR-0071 §4), vestido por el SERVIDOR: el
     * diálogo de impresión lo enseña como «Próximo control» para que la persona confirme que la
     * hoja de la forma libre coincide. Null si el documento no consume control.
     */
    control_display: z.string().nullable(),
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

/** La NC directa responde con su documento y el saldo a favor que nació. */
export const DirectCreditNoteResponse = z
  .object({ document: DocumentResponse, customer_credit_id: uuid })
  .strict();
export type DirectCreditNoteResponse = z.infer<typeof DirectCreditNoteResponse>;

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
    supported_retention_id: uuid.nullable(),
    /**
     * La reversa de este cobro (ADR-0075 §8, H4), si la tiene: cuándo, quién y por qué. Un cobro
     * reversado no cuenta en el saldo ni en lo pagado. Solo lo trae el detalle del documento.
     */
    reversal: z
      .object({
        id: uuid,
        reversed_at: z.string().datetime({ offset: true }),
        reversed_by: uuid.nullable(),
        reversed_by_name: z.string().nullable(),
        reason: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
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
    /** Calculado, nunca persistido. null = documento en divisa sin tasa de hoy (H12). */
    balance: z.string().nullable(),
    /** ADR-0076 (O-02): quién armó la cuenta del POS que esta venta cerró. null = no vino de una. */
    pos_cart: z
      .object({ author_id: uuid.nullable(), author_name: z.string().nullable() })
      .strict()
      .nullable(),
  })
  .strict();
export type DocumentDetailResponse = z.infer<typeof DocumentDetailResponse>;

export const ListDocumentsResponse = z
  .object({ items: z.array(DocumentResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListDocumentsResponse = z.infer<typeof ListDocumentsResponse>;

/**
 * La percepción de IGTF que causó UN pago (migración 46): 3 % sobre ESE pago
 * en divisa, calculado en el SERVIDOR. En un pago mixto solo la porción en
 * divisa causa. null = este pago no causó (empresa sin activar, instrumento
 * que no causa, o moneda funcional).
 */
export const IgtfOnPayment = z
  .object({
    id: uuid,
    base_amount: z.string(),
    currency: z.string(),
    rate: z.string(),
    amount: z.string(),
    functional_amount: z.string(),
    /** F-05: la asumió la empresa (`absorb_igtf`): el cliente no la pagó; se entera igual. */
    absorbed: z.boolean(),
  })
  .strict();
export type IgtfOnPayment = z.infer<typeof IgtfOnPayment>;

export const RegisterPaymentResponse = z
  .object({
    payment: PaymentResponse,
    /** null cuando no hubo diferencia de tasa que registrar. */
    exchange_difference: ExchangeGainLossResponse.nullable(),
    balance: z.string(),
    document_status: DocumentStatus,
    /** null cuando el pago no causó IGTF. */
    igtf: IgtfOnPayment.nullable(),
    /**
     * E-03 (RESPUESTA §2.6, aditivo): la Nota de Débito por IGTF que documenta la percepción de
     * un cobro POSTERIOR a la factura (fiado o abono). null si no hubo percepción, si la empresa
     * la absorbe, o si el cobro es el de la propia venta (el IGTF va impreso en la factura).
     */
    igtf_debit_note: z
      .object({
        id: uuid,
        series: z.string(),
        document_number: z.number().int().nullable(),
        /** El control impreso (00-00001234), o null fuera de forma libre. */
        control_display: z.string().nullable(),
      })
      .strict()
      .nullable()
      .optional(),
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
    subtotal: z.string(),
    tax_rate: z.string(),
    tax_amount: z.string(),
    total: z.string(),
    /** ADR-0047: el mismo lado funcional (Bs) que congelará el documento, por línea. */
    functional_unit_price: z.string(),
    functional_total: z.string(),
    /** El ancla (USD) por línea, del servidor; null sin tasa del día. */
    anchor_unit_price: z.string().nullable(),
    anchor_total: z.string().nullable(),
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
    lines: z.array(PosQuoteLine),
    subtotal: z.string(),
    tax_amount: z.string(),
    total: z.string(),
    /** ADR-0047: el pie en Bs, derivado como en la emisión (impuesto = total − subtotal). */
    functional_subtotal: z.string(),
    functional_tax_amount: z.string(),
    functional_total: z.string(),
    functional_currency: z.string(),
    /**
     * ADR-0047: el total en el ANCLA (USD) para el carrito, calculado por el
     * servidor a la tasa del día de la empresa y a las minor units del dólar.
     * Presentación, no se persiste; `null` cuando no hay tasa del día.
     */
    anchor_currency: z.string(),
    anchor_total: z.string().nullable(),
    anchor_rate: z.string().nullable(),
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
    // Ni saldo a favor ni retención: los abonos sin efectivo exigen su propio
    // recurso (crédito / comprobante) y no caben en el mostrador rápido.
    instrument: PaymentInstrument.exclude(["saldo_a_favor", "retencion_iva"]),
    amount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    reference: z.string().trim().min(1).max(100).optional(),
    account_id: uuid.optional(),
  })
  .strict();
export type QuickSalePaymentInput = z.infer<typeof QuickSalePaymentInput>;

/**
 * La VENTA RÁPIDA: factura emitida + cobros + vuelto, en una transacción.
 * El `Idempotency-Key` es el INTENTO de cobro (ADR-0076), nunca el id de la cuenta:
 * reintentar con la misma clave devuelve la MISMA venta; un cobro nuevo de una cuenta
 * ya vendida da 409 POS_CART_SOLD, nunca una segunda factura.
 */
export const QuickSaleRequest = z
  .object({
    company_id: uuid,
    /** Sin cliente = venta de mostrador (el «Consumidor final» de sistema). */
    customer_id: uuid.optional(),
    warehouse_id: uuid,
    branch_id: uuid.nullable().optional(),
    series: serie.optional(),
    price_list_id: uuid.optional(),
    lines: z.array(DocumentLineRequest).min(1).max(200),
    /** Hasta CUATRO formas de pago (una caja real: Bs, pago móvil, USD, Zelle). */
    payments: z.array(QuickSalePaymentInput).max(4).optional(),
    /** La cuenta abierta que esta venta CIERRA: queda marcada como vendida en la MISMA
     *  transacción (ADR-0076) — y un segundo cobro de esa cuenta da 409 POS_CART_SOLD. */
    cart_id: uuid.optional(),
    /** Las ediciones de la cuenta que la caja llevaba al cobrar (ADR-0076): constancia en el
     *  acta de la venta, y dos cobros de la misma cuenta nunca son bytes iguales. */
    cart_version: z.number().int().min(0).max(1_000_000).optional(),
    /** El intento de cobro: el mismo uuid que viaja como `Idempotency-Key` (ADR-0076). */
    attempt_id: uuid.optional(),
  })
  .strict();
export type QuickSaleRequest = z.infer<typeof QuickSaleRequest>;

/**
 * CUENTAS ABIERTAS del POS (migración 44): la INTENCIÓN de una venta en
 * armado — productos y cantidades, nunca precios (al retomar se recotiza a
 * la tasa de HOY). El id lo pone la CAJA: el upsert es idempotente por
 * naturaleza y el eco local del navegador y la nube hablan del mismo
 * carrito.
 */
export const PosCartLine = z
  .object({
    product_id: uuid,
    qty: z.string().regex(/^\d{1,16}(\.\d{1,8})?$/, "cantidad decimal como string"),
  })
  .strict();
export type PosCartLine = z.infer<typeof PosCartLine>;

export const UpsertPosCartRequest = z
  .object({
    company_id: uuid,
    label: z.string().trim().min(1).max(80),
    customer_id: uuid.nullable().optional(),
    lines: z.array(PosCartLine).max(500),
    note: z.string().trim().min(1).max(500).nullable().optional(),
    /** La caja (equipo) donde se arma: un uuid que la web guarda en el disco (ADR-0076). */
    station_id: uuid.nullable().optional(),
  })
  .strict();
export type UpsertPosCartRequest = z.infer<typeof UpsertPosCartRequest>;

export const PosCartResponse = z
  .object({
    id: uuid,
    label: z.string(),
    customer_id: uuid.nullable(),
    lines: z.array(PosCartLine),
    note: z.string().nullable(),
    updated_at: z.string(),
    /** De quién es la cuenta (ADR-0076, E-08): quién la armó, cuándo y en qué caja. */
    created_at: z.string(),
    created_by: uuid.nullable(),
    author_name: z.string().nullable(),
    station_id: uuid.nullable(),
    /** ¿Puede quien pregunta cobrarla, cambiarla o borrarla? Su autor, o quien tenga
     *  `pos.carts.manage`. Si no, la caja la enseña en solo lectura. */
    editable: z.boolean(),
  })
  .strict();
export type PosCartResponse = z.infer<typeof PosCartResponse>;

export const ListPosCartsResponse = z.object({ items: z.array(PosCartResponse) }).strict();
export type ListPosCartsResponse = z.infer<typeof ListPosCartsResponse>;

export const QuickSaleResponse = z
  .object({
    document: DocumentResponse,
    payments: z.array(RegisterPaymentResponse),
    /** El vuelto de efectivo, si lo hubo. Calculado en el SERVIDOR. */
    change: z.object({ amount: z.string(), currency: z.string() }).strict().nullable(),
    balance: z.string(),
    document_status: DocumentStatus,
    /**
     * El IGTF total de la venta, en moneda funcional: la suma de lo que causó
     * cada pago (el desglose por pago viaja en `payments`). null = nada causó.
     */
    igtf: z.object({ functional_amount: z.string(), currency: z.string() }).strict().nullable(),
  })
  .strict();
export type QuickSaleResponse = z.infer<typeof QuickSaleResponse>;

/**
 * La VISTA PREVIA del cobro (ADR-0059): lo que haría la venta con estas formas
 * de pago, sin escribir. `total` es el total funcional que ya cotizó el
 * servidor; `offer` son las formas que la caja ofrece, para decir cuánto
 * pedir en cada una (IGTF incluido) para cerrar.
 */
export const PosTenderRequest = z
  .object({
    company_id: uuid,
    total: amount,
    payments: z
      .array(
        z
          .object({
            instrument: PaymentInstrument.exclude(["saldo_a_favor", "retencion_iva"]),
            currency: z.string().regex(/^[A-Z]{3}$/),
            amount: z.string().regex(/^\d{1,16}(\.\d{1,8})?$/),
          })
          .strict(),
      )
      .max(4),
    offer: z
      .array(
        z
          .object({
            instrument: PaymentInstrument.exclude(["saldo_a_favor", "retencion_iva"]),
            currency: z.string().regex(/^[A-Z]{3}$/),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type PosTenderRequest = z.infer<typeof PosTenderRequest>;

export const PosTenderResponse = z
  .object({
    functional_currency: z.string(),
    total: z.string(),
    paid_functional: z.string(),
    remaining_functional: z.string(),
    /** true = con estas formas la venta queda pagada. */
    complete: z.boolean(),
    change: z.object({ amount: z.string(), currency: z.string() }).strict().nullable(),
    rows: z.array(
      z
        .object({
          instrument: z.string(),
          currency: z.string(),
          tendered: z.string(),
          /** Lo que abona al documento, en la moneda del pago. */
          applied: z.string().nullable(),
          applied_functional: z.string().nullable(),
          /** El IGTF que va DENTRO de lo entregado. */
          igtf: z.string().nullable(),
          change: z.string().nullable(),
          covers: z.boolean(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
    suggestions: z.array(
      z
        .object({
          instrument: z.string(),
          currency: z.string(),
          /** Cuánto pedir en esta forma para cerrar, IGTF incluido. */
          amount: z.string().nullable(),
          igtf: z.string().nullable(),
          error: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type PosTenderResponse = z.infer<typeof PosTenderResponse>;

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
    /**
     * G-06 (RESPUESTA §2.6, aditivo; solo al confirmar): el IGTF que se percibió en el cobro de
     * la factura devuelta. La percepción fue debida y se entera: la NC no lo lleva y el reembolso
     * lo excluye. `notice` es el texto que la pantalla muestra tal cual. null si no hubo IGTF.
     */
    igtf_not_refunded: z
      .object({
        amount: z.string(),
        currency: z.string(),
        functional_amount: z.string(),
        notice: z.string(),
      })
      .strict()
      .nullable()
      .optional(),
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
          /** null = el tramo tiene deuda en divisa y falta la tasa de hoy (ADR-0075 §5, H12). */
          amount: z.string().nullable(),
        })
        .strict(),
    ),
    total: z.string().nullable(),
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
          /** null = documento en divisa sin tasa de hoy, o sin saldo calculable (H12). */
          balance: z.string().nullable(),
          /**
           * La moneda del documento y lo que se debe EN ELLA (ADR-0075 §5): la deuda nominal.
           * null = no se puede calcular (un cobro viejo en otra moneda sin tasa con que valorarlo):
           * nunca «0», que diría que no debe.
           */
          debt_currency: z.string(),
          debt_nominal: z.string().nullable(),
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
    /** null = hay deuda en divisa y falta la tasa de hoy; el nominal va en `debt.by_currency`. */
    total_outstanding: z.string().nullable(),
    /**
     * LA DEUDA, por la única función (ADR-0075 §5, F-04): nominal por moneda y, solo para
     * mostrar, su valor en la moneda de la empresa a la tasa de hoy, con la tasa y su fecha.
     * `total_outstanding` es la suma de `functional_today`. El aviso al cliente sale de aquí.
     */
    debt: z
      .object({
        functional_currency: z.string(),
        as_of: z.string(),
        by_currency: z.array(
          z
            .object({
              currency: z.string(),
              nominal: z.string(),
              rate: z.string().nullable(),
              functional_today: z.string().nullable(),
            })
            .strict(),
        ),
        /**
         * Cuántos documentos del cliente NO entran en `by_currency` porque su deuda nominal no
         * se puede calcular (un cobro viejo en otra moneda sin tasa). Con más de cero, las
         * cifras de arriba son parciales y la pantalla lo dice.
         */
        unvalued_documents: z.number().int().nonnegative().optional(),
      })
      .strict(),
    total_credit_available: z.string(),
    aging: AgingResponse,
  })
  .strict();
export type CustomerStatementResponse = z.infer<typeof CustomerStatementResponse>;

/**
 * El talonario de la imprenta (ADR-0071, enmienda ADR-0037): se registra UNA vez por empresa e
 * identificador y sirve para factura, nota de crédito y nota de débito. `kind` ya no separa el
 * correlativo de control: se acepta por compatibilidad y se ignora. Los datos de la imprenta son
 * opcionales en el ESQUEMA para que su ausencia responda un 422 que diga cuál falta (lo decide la
 * API, no el esquema compartido con los clientes: CLAUDE.md §7).
 */
const fechaIso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const datosImprenta = {
  /** Razón social de la imprenta autorizada. */
  printer_legal_name: z.string().trim().min(2).max(200),
  /** RIF de la imprenta, con o sin guiones; la API valida la estructura y lo normaliza. */
  printer_tax_id: z.string().trim().min(1).max(20),
  /** Nomenclatura de la providencia que autoriza a la imprenta. */
  printer_authorization: z.string().trim().min(3).max(100),
  /** Fecha de esa providencia. */
  printer_authorization_date: fechaIso,
  /** Fecha de elaboración del talonario (la imprenta la preimprime, art. 31). */
  printed_on: fechaIso,
} as const;

export const CreateFiscalRangeRequest = z
  .object({
    company_id: uuid,
    /** COMPATIBILIDAD: se ignora. Un talonario sirve a las tres clases (ADR-0071). */
    kind: z.enum(["invoice", "credit_note", "debit_note", "delivery_note"]).optional(),
    /** Como viene impresa; '' si el papel no trae serie. «contingencia…» es solo de la PA 102. */
    series: serie.refine((s) => !/^contingencia/i.test(s), {
      message:
        "una serie «contingencia…» es del talonario de contingencia: se registra en Contingencia (PA 102)",
    }),
    /** Los 2 dígitos del identificador del control (PA 00071 art. 44). «00» por omisión. */
    printer_identifier: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    range_from: z.string().regex(/^\d{1,18}$/),
    range_to: z.string().regex(/^\d{1,18}$/),
    /** COMPATIBILIDAD: el nombre libre de antes. Si falta, se usa la razón social. */
    printer_source: z.string().trim().min(1).max(200).optional(),
    printer_legal_name: datosImprenta.printer_legal_name.optional(),
    printer_tax_id: datosImprenta.printer_tax_id.optional(),
    printer_authorization: datosImprenta.printer_authorization.optional(),
    printer_authorization_date: datosImprenta.printer_authorization_date.optional(),
    printed_on: datosImprenta.printed_on.optional(),
    alert_threshold_pct: z.number().int().min(0).max(100).optional(),
  })
  .strict();
export type CreateFiscalRangeRequest = z.infer<typeof CreateFiscalRangeRequest>;

/** Completar los datos de la imprenta de un talonario anterior a ADR-0071 (una sola vez). */
export const CompleteFiscalRangePrinterRequest = z
  .object({
    company_id: uuid,
    ...datosImprenta,
    /** Solo mientras el talonario no haya emitido nada (ADR-0071, H3). */
    printer_identifier: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
  })
  .strict();
export type CompleteFiscalRangePrinterRequest = z.infer<typeof CompleteFiscalRangePrinterRequest>;

/**
 * Corregir los datos de la imprenta de un talonario completo (ADR-0071, H3, decidido por criterio):
 * con motivo y acta que guarda lo anterior y lo nuevo. Lo emitido no cambia: lleva impreso lo que
 * la imprenta preimprimió. El identificador solo si el talonario no emitió nada.
 */
export const CorrectFiscalRangePrinterRequest = z
  .object({
    company_id: uuid,
    ...datosImprenta,
    printer_identifier: z
      .string()
      .regex(/^\d{2}$/)
      .optional(),
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type CorrectFiscalRangePrinterRequest = z.infer<typeof CorrectFiscalRangePrinterRequest>;

/** Anular un talonario que no emitió nada (ADR-0071, H3), con motivo y acta. */
export const CancelFiscalRangeRequest = z
  .object({ company_id: uuid, reason: z.string().trim().min(10).max(500) })
  .strict();
export type CancelFiscalRangeRequest = z.infer<typeof CancelFiscalRangeRequest>;

export const FiscalRangeResponse = z
  .object({
    id: uuid,
    /** Histórico: null en los talonarios registrados desde ADR-0071. */
    kind: z.string().nullable(),
    series: z.string(),
    printer_identifier: z.string(),
    range_from: z.number().int(),
    range_to: z.number().int(),
    next_available: z.number().int(),
    status: z.enum(["active", "exhausted", "cancelled"]),
    printer_source: z.string(),
    printer_legal_name: z.string().nullable(),
    printer_tax_id: z.string().nullable(),
    printer_authorization: z.string().nullable(),
    printer_authorization_date: z.string().nullable(),
    printed_on: z.string().nullable(),
    /** Sin los datos de la imprenta no se emite con este talonario. */
    printer_data_complete: z.boolean(),
    /** Talonario de contingencia (PA 102): no es papel de la caja. */
    is_contingency: z.boolean(),
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
      .regex(/^[A-Za-z0-9-]{1,30}$/, "la serie admite letras, dígitos y guion, hasta 30")
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
/**
 * EL MODO DE VENTA (migración 54): la única definición, derivada del régimen
 * vigente con la lógica del trigger de emisión. La web no lo deduce del nombre
 * del régimen: lo lee de aquí.
 */
export const SalesMode = z.enum(["facturas", "recibos", "ninguno"]);
export type SalesMode = z.infer<typeof SalesMode>;

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
    /** Qué vende la empresa hoy: facturas, recibos o ninguno (migración 54). */
    sales_mode: SalesMode,
    iva_general: z.object({ rate: amount, legal_source: z.string() }).strict().nullable(),
    /**
     * La general del CATÁLOGO de plataforma, con su cita y el rango del art. 27 (ADR-0073,
     * B-11): la referencia que la pantalla enseña. NULL si el catálogo no trae una vigente.
     */
    iva_catalog: z
      .object({ rate: amount, rate_min: amount, rate_max: amount, legal_source: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type FiscalSetupResponse = z.infer<typeof FiscalSetupResponse>;

export const AssignFiscalRegimeRequest = z
  .object({
    regime_code: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    /** Con documentos fiscales ya emitidos, el cambio exige MOTIVO (acta). */
    reason: z.string().trim().min(3).max(300).optional(),
  })
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
    /**
     * Desde qué día rige (día de Caracas, YYYY-MM-DD). Por omisión, hoy. Nunca antes de hoy: lo ya
     * emitido conserva su regla. Sirve para cuando hoy ya se facturó con la tasa anterior
     * (ADR-0073, H2): la nueva puede regir desde mañana.
     */
    effective_from: z.string().date().optional(),
  })
  .strict();
export type AcceptIvaGeneralRequest = z.infer<typeof AcceptIvaGeneralRequest>;

export const AcceptIvaGeneralResponse = z
  .object({
    rate: amount,
    /** Cuántas reglas creó esta aceptación (0 si la misma tasa ya regía y el catálogo estaba completo). */
    rules_created: z.number().int(),
    accepted_on: z.string().date(),
    /**
     * B5: falso si esa misma tasa ya regía en la fecha efectiva (no se cerró ni se abrió ninguna
     * general). La pantalla dice «Ya regía esa alícuota» en vez de «Alícuota cambiada».
     */
    changed: z.boolean(),
  })
  .strict();
export type AcceptIvaGeneralResponse = z.infer<typeof AcceptIvaGeneralResponse>;

/**
 * EL REEMBOLSO DE UN SALDO A FAVOR (ADR-0061 §8). El dinero sale de una caja
 * (`account_id`, en la moneda del saldo) y el saldo a favor baja por lo
 * reembolsado. Es la única vía para el «consumidor final», que no conserva saldo.
 */
export const RefundCustomerCreditRequest = z
  .object({
    company_id: uuid,
    account_id: uuid,
    amount,
    reason: z.string().trim().min(3).max(300),
    /**
     * Confirmar EXPLÍCITAMENTE que la cuenta quede en negativo (ADR-0062 §4). Sin esto, un
     * egreso mayor que el saldo responde 409 INSUFFICIENT_FUNDS con el número delante.
     */
    allow_negative_balance: z.boolean().optional(),
    /**
     * D-11: POR QUÉ se deja la cuenta en negativo, en palabras de quien lo confirma. Obligatorio
     * (con el permiso `treasury.overdraft`) cuando el egreso sobregira de verdad; queda en el
     * acta `treasury.overdraft.confirmed`. El mínimo lo exige el caso de uso, con su mensaje.
     */
    overdraft_reason: z.string().trim().max(300).optional(),
  })
  .strict();
export type RefundCustomerCreditRequest = z.infer<typeof RefundCustomerCreditRequest>;

export const CustomerRefundResponse = z
  .object({
    id: uuid,
    customer_credit_id: uuid,
    account_id: uuid,
    amount: z.string(),
    currency: z.string(),
    refunded_at: z.string().datetime({ offset: true }),
    /** posted = asentado; queued = en la cola contable (ADR-0042). */
    accounting: z.enum(["posted", "queued"]),
    journal_entry_id: uuid.nullable(),
    /** Lo que queda del saldo a favor después del reembolso. */
    credit_remaining: z.string(),
  })
  .strict();
export type CustomerRefundResponse = z.infer<typeof CustomerRefundResponse>;

/** La reversa de un cobro (ADR-0075 §8, R-61): motivo obligatorio, queda en el acta. */
export const ReversePaymentRequest = z
  .object({ company_id: uuid, reason: z.string().trim().min(10).max(300) })
  .strict();
export type ReversePaymentRequest = z.infer<typeof ReversePaymentRequest>;

export const PaymentReversalResponse = z
  .object({
    id: uuid,
    payment_id: uuid,
    document_id: uuid,
    kind: z.enum(["payment", "supported_retention"]),
    reason: z.string(),
    reversed_at: z.string().datetime({ offset: true }),
    currency: z.string(),
    amount: z.string(),
    functional_amount: z.string(),
    reversal_entry_id: uuid.nullable(),
    igtf_reversal_entry_id: uuid.nullable(),
    document: z.object({ id: uuid, status: DocumentStatus }).strict(),
    /** Lo que el documento vuelve a deber, por la única función de deuda. Null sin tasa de hoy. */
    debt: z
      .object({
        currency: z.string(),
        /** null = no se puede calcular (un cobro viejo en otra moneda sin tasa). */
        nominal: z.string().nullable(),
        functional_currency: z.string(),
        rate: z.string().nullable(),
        rate_date: z.string(),
        /** null = falta la tasa de hoy. */
        functional_today: z.string().nullable(),
      })
      .strict()
      .nullable(),
    /** El IGTF que ese cobro percibió: restituido al cliente y pendiente de reintegro (P-67). */
    igtf: z
      .object({
        perception_id: uuid,
        status: z.literal("pendiente_reintegro"),
        currency: z.string(),
        restituted_amount: z.string(),
        absorbed: z.boolean(),
      })
      .strict()
      .nullable(),
    supported_retention: z
      .object({ id: uuid, status: z.literal("annulled") })
      .strict()
      .nullable(),
  })
  .strict();
export type PaymentReversalResponse = z.infer<typeof PaymentReversalResponse>;
