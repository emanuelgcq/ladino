import { z } from "zod";
import { InventoryMoveResponse } from "./inventory.js";

/**
 * Contratos de compras (migración 22, ADR-0039/0040). Todo importe y toda
 * cantidad viajan como STRING decimal — regla 7. Ningún porcentaje de retención
 * aparece aquí: lo resuelve `platform.resolve_retention()` y la retención lo
 * persiste copiado (ADR-0039).
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
const currency = z.string().regex(/^[A-Z]{3}$/);

export const SupplierKind = z.enum(["nacional", "extranjero"]);
export const AllocationMethod = z.enum(["by_value", "by_weight", "by_units"]);
/**
 * Los mismos valores que el CHECK `supplier_payments_instrument_chk` de la base
 * (migración 29). Antes el contrato ofrecía `cheque` y `nota_credito`, que la
 * base rechazaba con 23514, y le faltaban punto de venta, pago móvil y tarjeta,
 * que la base sí admite (auditoría 2026-09-11, A-21). Una nota de crédito del
 * proveedor se aplica por su propio endpoint, no como instrumento de pago.
 */
export const PurchaseInstrument = z.enum([
  "efectivo_bs",
  "efectivo_usd",
  "zelle",
  "usdt",
  "transferencia",
  "punto_venta",
  "pago_movil",
  "tarjeta",
  "otro",
]);

export const CreateSupplierRequest = z
  .object({
    company_id: uuid,
    /**
     * Sin validación de formato (VALIDAR-SENIAT, OPEN_QUESTIONS 9). Nullable
     * SOLO para el extranjero: un proveedor nacional sin RIF no se puede llevar
     * al libro de compras.
     */
    tax_id: z.string().trim().min(1).max(30).nullable().optional(),
    legal_name: z.string().trim().min(1).max(200),
    trade_name: z.string().trim().min(1).max(200).nullable().optional(),
    supplier_kind: SupplierKind.default("nacional"),
    person_type_code: z.string().trim().min(1).max(40).nullable().optional(),
    taxpayer_type_code: z.string().trim().min(1).max(40).nullable().optional(),
    fiscal_address: z.string().trim().min(1).max(500).nullable().optional(),
    email: z.string().trim().email().max(254).nullable().optional(),
    phone: z.string().trim().min(3).max(40).nullable().optional(),
    payment_terms_days: z.number().int().min(0).max(3650).optional(),
  })
  .strict();
export type CreateSupplierRequest = z.infer<typeof CreateSupplierRequest>;

export const SupplierResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    tax_id: z.string().nullable(),
    legal_name: z.string(),
    trade_name: z.string().nullable(),
    supplier_kind: SupplierKind,
    person_type_code: z.string().nullable(),
    taxpayer_type_code: z.string().nullable(),
    fiscal_address: z.string().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    status: z.string(),
    payment_terms_days: z.number().int(),
  })
  .strict();
export type SupplierResponse = z.infer<typeof SupplierResponse>;

export const ListSuppliersResponse = z
  .object({ items: z.array(SupplierResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListSuppliersResponse = z.infer<typeof ListSuppliersResponse>;

export const PurchaseLineRequest = z
  .object({
    product_id: uuid,
    description: z.string().trim().min(1).max(300).optional(),
    quantity,
    unit_price: amount,
    /** Peso unitario; sin él, el prorrateo `by_weight` de esta línea falla. */
    unit_weight: amount.optional(),
  })
  .strict();
export type PurchaseLineRequest = z.infer<typeof PurchaseLineRequest>;

export const CreatePurchaseOrderRequest = z
  .object({
    company_id: uuid,
    supplier_id: uuid,
    warehouse_id: uuid,
    branch_id: uuid.nullable().optional(),
    /** Moneda del proveedor. Puede no ser la funcional. */
    currency,
    expected_at: z.string().date().optional(),
    notes: z.string().trim().min(1).max(1000).optional(),
    lines: z.array(PurchaseLineRequest).min(1).max(500),
  })
  .strict();
export type CreatePurchaseOrderRequest = z.infer<typeof CreatePurchaseOrderRequest>;

export const ReceiveGoodsLineRequest = z
  .object({
    /** La línea de la orden que satisface. Ausente = recepción sin orden. */
    purchase_order_line_id: uuid.optional(),
    product_id: uuid,
    quantity,
    unit_price: amount,
    unit_weight: amount.optional(),
    lot_code: z.string().trim().min(1).max(60).optional(),
    lot_expires_at: z.string().date().optional(),
  })
  .strict();
export type ReceiveGoodsLineRequest = z.infer<typeof ReceiveGoodsLineRequest>;

export const ReceiveGoodsRequest = z
  .object({
    company_id: uuid,
    supplier_id: uuid,
    purchase_order_id: uuid.optional(),
    warehouse_id: uuid,
    currency,
    delivery_note_ref: z.string().trim().min(1).max(60).optional(),
    /** Fecha de la recepción: es la que fija la tasa y el costo (ADR-0040 §4). */
    received_at: z.string().datetime({ offset: true }).optional(),
    notes: z.string().trim().min(1).max(1000).optional(),
    lines: z.array(ReceiveGoodsLineRequest).min(1).max(500),
  })
  .strict();
export type ReceiveGoodsRequest = z.infer<typeof ReceiveGoodsRequest>;

export const RegisterSupplierInvoiceLineRequest = z
  .object({
    goods_receipt_line_id: uuid.optional(),
    product_id: uuid,
    description: z.string().trim().min(1).max(300).optional(),
    quantity,
    unit_price: amount,
  })
  .strict();

export const RegisterSupplierInvoiceRequest = z
  .object({
    company_id: uuid,
    supplier_id: uuid,
    purchase_order_id: uuid.optional(),
    /**
     * El correlativo DEL PROVEEDOR, tal como él lo emitió. OPCIONAL desde ADR-0066: una compra
     * sin soporte fiscal no tiene número que copiar, y exigirlo era lo que empujaba a
     * inventarlo. La llave contra el doble pago es condicional (migración 69).
     */
    supplier_document_number: z.string().trim().min(1).max(60).optional(),
    /** Su número de control. Nulo para el extranjero, que aporta referencia. */
    supplier_control_number: z.string().trim().min(1).max(60).optional(),
    supplier_document_ref: z.string().trim().min(1).max(120).optional(),
    invoice_date: z.string().date(),
    due_date: z.string().date().optional(),
    currency,
    notes: z.string().trim().min(1).max(1000).optional(),
    lines: z.array(RegisterSupplierInvoiceLineRequest).min(1).max(500),
    /**
     * Conceptos de retención a practicar. La regla y el porcentaje NO viajan
     * aquí: los resuelve el esquema con su fuente legal.
     */
    retention_concepts: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    /**
     * Aceptar una diferencia de precio fuera del umbral. Exige el permiso
     * `purchase.price_variance.approve`; sin él, la factura se rechaza.
     */
    approve_price_variance: z.boolean().optional(),
    /**
     * FALSE = compra real SIN soporte fiscal (ADR-0066 §2): entra al inventario y al dinero,
     * NO al libro de compras y NO genera crédito fiscal. Por omisión, true.
     * VALIDAR-TRIBUTARIO: P-27 y P-28 de PENDIENTES_ASESOR.
     */
    fiscal_support: z.boolean().optional(),
  })
  .strict();
export type RegisterSupplierInvoiceRequest = z.infer<typeof RegisterSupplierInvoiceRequest>;

export const ApplyLandedCostRequest = z
  .object({
    company_id: uuid,
    goods_receipt_id: uuid,
    concept: z.string().trim().min(1).max(120),
    allocation_method: AllocationMethod,
    amount,
    currency,
    supplier_id: uuid.optional(),
    reference: z.string().trim().min(1).max(120).optional(),
    incurred_on: z.string().date(),
  })
  .strict();
export type ApplyLandedCostRequest = z.infer<typeof ApplyLandedCostRequest>;

export const RegisterSupplierCreditNoteRequest = z
  .object({
    company_id: uuid,
    supplier_invoice_id: uuid,
    supplier_document_number: z.string().trim().min(1).max(60),
    supplier_control_number: z.string().trim().min(1).max(60).optional(),
    supplier_document_ref: z.string().trim().min(1).max(120).optional(),
    note_date: z.string().date(),
    reason: z.string().trim().min(3).max(500),
    currency,
    lines: z
      .array(
        z
          .object({
            supplier_invoice_line_id: uuid.optional(),
            product_id: uuid,
            description: z.string().trim().min(1).max(300).optional(),
            quantity,
            unit_price: amount,
            tax_amount: amount.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(500),
  })
  .strict();
export type RegisterSupplierCreditNoteRequest = z.infer<typeof RegisterSupplierCreditNoteRequest>;

export const RegisterSupplierPaymentRequest = z
  .object({
    company_id: uuid,
    supplier_invoice_id: uuid,
    /** BRUTO: lo que cancela deuda. El neto sale de restarle la retención. */
    gross_amount: amount,
    currency,
    instrument: PurchaseInstrument,
    reference: z.string().trim().min(1).max(100).optional(),
    bank_account_id: uuid.optional(),
    paid_at: z.string().datetime({ offset: true }).optional(),
    /** Emitir el comprobante de retención con este pago. */
    issue_retention_receipt: z.boolean().optional(),
    retention_receipt_series: z.string().trim().min(1).max(10).optional(),
    /**
     * De qué cuenta SALE el dinero (migración 29). Opcional: sin ella el
     * servidor resuelve por la forma de pago del instrumento y en último
     * término por «Sin asignar (<moneda>)». Con `nota_credito` no se admite.
     */
    account_id: uuid.optional(),
    /**
     * Confirmar EXPLÍCITAMENTE que la cuenta quede en negativo (ADR-0062 §4). Sin esto, un
     * egreso mayor que el saldo responde 409 INSUFFICIENT_FUNDS con el número delante.
     */
    allow_negative_balance: z.boolean().optional(),
  })
  .strict();
export type RegisterSupplierPaymentRequest = z.infer<typeof RegisterSupplierPaymentRequest>;

/**
 * La COMPRA SIMPLE de la Fase C: «llegó mercancía con su factura» en UN paso.
 * Crea la orden, la recepción completa, la factura del proveedor y —si se
 * indica— el pago del total. El detrás de cámaras es el flujo completo de
 * compras: nada se salta, solo se pregunta una vez.
 */
export const SimplePurchaseRequest = z
  .object({
    company_id: uuid,
    supplier_id: uuid,
    warehouse_id: uuid,
    branch_id: uuid.nullable().optional(),
    /** Moneda del proveedor: la de los costos unitarios. */
    currency,
    /** El correlativo DEL PROVEEDOR, tal como él lo emitió. */
    supplier_document_number: z.string().trim().min(1).max(60),
    supplier_control_number: z.string().trim().min(1).max(60).optional(),
    invoice_date: z.string().date().optional(),
    lines: z.array(PurchaseLineRequest).min(1).max(200),
    /** Pagarla completa ya mismo, con esta forma. Ausente = queda por pagar. */
    payment: z
      .object({
        instrument: PurchaseInstrument,
        reference: z.string().trim().min(1).max(100).optional(),
        account_id: uuid.optional(),
        /** Igual que en el pago suelto: confirmar que la cuenta quede en negativo (ADR-0062 §4). */
        allow_negative_balance: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type SimplePurchaseRequest = z.infer<typeof SimplePurchaseRequest>;

export const CreateRetentionRuleRequest = z
  .object({
    jurisdiction: z.string().regex(/^[A-Z]{2}(-[A-Z0-9]{1,10})?$/),
    retention_code: z.enum(["iva", "islr"]),
    concept_code: z.string().trim().min(1).max(40),
    taxpayer_type: z.string().trim().min(1).max(40).nullable().optional(),
    supplier_person_type: z.string().trim().min(1).max(40).nullable().optional(),
    formula_kind: z.enum(["rate", "rate_minus_subtrahend"]),
    rate: amount,
    subtrahend: amount.nullable().optional(),
    minimum_exempt: amount.nullable().optional(),
    effective_from: z.string().date(),
    effective_to: z.string().date().nullable().optional(),
    /** Sin norma citada no se persiste una regla (ADR-0039). */
    legal_source: z.string().trim().min(3).max(300),
    priority: z.number().int().min(0).max(10000).optional(),
  })
  .strict();
export type CreateRetentionRuleRequest = z.infer<typeof CreateRetentionRuleRequest>;

export const PurchaseOrderResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    supplier_id: uuid,
    warehouse_id: uuid,
    order_number: z.number().int().nullable(),
    status: z.string(),
    ordered_at: z.string().datetime({ offset: true }).nullable(),
    expected_at: z.string().nullable(),
    transaction_currency: z.string(),
    functional_currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    amount_transaction_currency: z.string(),
    functional_amount: z.string(),
  })
  .strict();
export type PurchaseOrderResponse = z.infer<typeof PurchaseOrderResponse>;

export const GoodsReceiptResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    supplier_id: uuid,
    purchase_order_id: uuid.nullable(),
    warehouse_id: uuid,
    receipt_number: z.number().int().nullable(),
    status: z.string(),
    received_at: z.string().datetime({ offset: true }).nullable(),
    delivery_note_ref: z.string().nullable(),
    transaction_currency: z.string(),
    functional_currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    functional_amount: z.string(),
  })
  .strict();
export type GoodsReceiptResponse = z.infer<typeof GoodsReceiptResponse>;

export const SupplierRetentionResponse = z
  .object({
    id: uuid,
    retention_code: z.string(),
    concept_code: z.string(),
    formula_kind: z.string(),
    rate_snapshot: z.string(),
    subtrahend_snapshot: z.string().nullable(),
    base_amount: z.string(),
    retained_amount: z.string(),
    /** La norma con la que se retuvo, copiada. Sin ella no sería auditable. */
    legal_source_snapshot: z.string(),
    status: z.string(),
  })
  .strict();
export type SupplierRetentionResponse = z.infer<typeof SupplierRetentionResponse>;

export const SupplierInvoiceResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    supplier_id: uuid,
    purchase_order_id: uuid.nullable(),
    supplier_document_number: z.string().nullable(),
    supplier_control_number: z.string().nullable(),
    supplier_document_ref: z.string().nullable(),
    invoice_date: z.string(),
    due_date: z.string().nullable(),
    status: z.string(),
    subtotal_amount: z.string(),
    tax_amount: z.string(),
    total_amount: z.string(),
    /** ADR-0040 §7: derivado del contribuyente de la EMPRESA. */
    tax_is_recoverable: z.boolean(),
    /** ADR-0066 §2: false = compra sin soporte fiscal, fuera del libro y sin crédito fiscal. */
    fiscal_support: z.boolean(),
    retention_total: z.string(),
    transaction_currency: z.string(),
    functional_currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    retentions: z.array(SupplierRetentionResponse),
  })
  .strict();
export type SupplierInvoiceResponse = z.infer<typeof SupplierInvoiceResponse>;

export const MatchingRow = z
  .object({
    invoice_line_id: uuid,
    product_id: uuid,
    qty_ordered: z.string().nullable(),
    qty_received: z.string().nullable(),
    qty_invoiced: z.string(),
    price_ordered: z.string().nullable(),
    price_invoiced: z.string(),
    price_diff_pct: z.string().nullable(),
  })
  .strict();

export const MatchingResponse = z
  .object({
    supplier_invoice_id: uuid,
    price_tolerance_pct: z.string(),
    rows: z.array(MatchingRow),
  })
  .strict();
export type MatchingResponse = z.infer<typeof MatchingResponse>;

export const LandedCostResponse = z
  .object({
    id: uuid,
    goods_receipt_id: uuid,
    concept: z.string(),
    allocation_method: AllocationMethod,
    status: z.string(),
    functional_amount: z.string(),
    functional_currency: z.string(),
    allocations: z.array(
      z
        .object({
          goods_receipt_line_id: uuid,
          allocated_functional: z.string(),
          to_inventory_functional: z.string(),
          to_variance_functional: z.string(),
          quantity_remaining: z.string(),
          quantity_received: z.string(),
        })
        .strict(),
    ),
    /** Lo que NO fue al inventario: gasto del período (ADR-0040 §6). */
    total_variance: z.string(),
  })
  .strict();
export type LandedCostResponse = z.infer<typeof LandedCostResponse>;

export const RetentionReceiptResponse = z
  .object({
    id: uuid,
    supplier_id: uuid,
    supplier_invoice_id: uuid,
    series: z.string(),
    receipt_number: z.number().int().nullable(),
    control_number: z.number().int().nullable(),
    status: z.string(),
    issued_at: z.string().datetime({ offset: true }).nullable(),
    fiscal_period: z.string(),
    total_retained: z.string(),
    functional_currency: z.string(),
  })
  .strict();
export type RetentionReceiptResponse = z.infer<typeof RetentionReceiptResponse>;

export const SupplierPaymentResponse = z
  .object({
    payment: z
      .object({
        id: uuid,
        supplier_invoice_id: uuid,
        paid_at: z.string().datetime({ offset: true }),
        instrument: z.string(),
        gross_amount: z.string(),
        retained_amount: z.string(),
        net_amount: z.string(),
        currency: z.string(),
        reference: z.string().nullable(),
      })
      .strict(),
    retention_receipt: RetentionReceiptResponse.nullable(),
    balance: z.string(),
    invoice_status: z.string(),
  })
  .strict();
export type SupplierPaymentResponse = z.infer<typeof SupplierPaymentResponse>;

export const ApAgingResponse = z
  .object({
    reference_date: z.string(),
    buckets: z.array(
      z
        .object({
          supplier_id: uuid,
          bucket: z.enum(["0-30", "31-60", "61-90", "90+"]),
          document_count: z.number().int().nonnegative(),
          amount: z.string(),
        })
        .strict(),
    ),
    total: z.string(),
  })
  .strict();
export type ApAgingResponse = z.infer<typeof ApAgingResponse>;

export const SupplierStatementResponse = z
  .object({
    supplier_id: uuid,
    currency: z.string(),
    invoices: z.array(
      z
        .object({
          id: uuid,
          supplier_document_number: z.string(),
          invoice_date: z.string(),
          due_date: z.string().nullable(),
          status: z.string(),
          /** La moneda de la factura: total, pagado y saldo van en ELLA. */
          transaction_currency: z.string(),
          total_amount: z.string(),
          paid_amount: z.string(),
          balance: z.string(),
          /** Lo que se debe HOY por esta factura, en moneda funcional (la de `currency`). */
          balance_today: z.string().nullable(),
          days_outstanding: z.number().int(),
        })
        .strict(),
    ),
    total_outstanding: z.string(),
    total_retained: z.string(),
    aging: ApAgingResponse,
  })
  .strict();
export type SupplierStatementResponse = z.infer<typeof SupplierStatementResponse>;

export const ListPurchaseOrdersResponse = z
  .object({
    items: z.array(PurchaseOrderResponse.extend({ derived_status: z.string() })),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type ListPurchaseOrdersResponse = z.infer<typeof ListPurchaseOrdersResponse>;

export const SimplePurchaseResponse = z
  .object({
    order: PurchaseOrderResponse,
    receipt: GoodsReceiptResponse,
    invoice: SupplierInvoiceResponse,
    payment: SupplierPaymentResponse.nullable(),
  })
  .strict();
export type SimplePurchaseResponse = z.infer<typeof SimplePurchaseResponse>;

/**
 * LA LLEGADA DE MERCANCÍA (ADR-0066) — el contrato de la única puerta por la que la mercancía
 * entra al negocio. La persona describe el hecho y el servidor deriva el asiento:
 *
 *   · sin `supplier_id`        → «ya era mía»: inventario inicial o aporte;
 *   · `invoice: "present"`     → compra con factura: libro, crédito fiscal o costo, retención;
 *   · `invoice: "pending"`     → recepción: la factura llega después;
 *   · `invoice: "none"`        → compra sin soporte fiscal: fuera del libro y sin crédito.
 */
export const ArrivalLineRequest = z
  .object({
    product_id: uuid,
    quantity,
    /** El costo POR UNIDAD de la línea. */
    unit_amount: amount.optional(),
    /** O el TOTAL de la línea: uno de los dos, nunca los dos. El otro lo calcula el servidor. */
    amount: amount.optional(),
    /** La línea del pedido que satisface, si la llegada viene de uno. */
    purchase_order_line_id: uuid.optional(),
    /** Lote y vencimiento: obligatorios de hecho para el producto que los lleva (FEFO). */
    lot_code: z.string().trim().min(1).max(60).optional(),
    lot_expires_at: z.string().date().optional(),
  })
  .strict()
  .refine((l) => (l.unit_amount === undefined) !== (l.amount === undefined), {
    message:
      "Da el costo por unidad (unit_amount) o el total de la línea (amount): uno de los dos.",
  });
export type ArrivalLineRequest = z.infer<typeof ArrivalLineRequest>;

export const RegisterArrivalRequest = z
  .object({
    company_id: uuid,
    warehouse_id: uuid,
    /** La moneda en la que se escribió el costo. La conversión la hace el servidor. */
    currency,
    /** Ausente = la mercancía YA ERA TUYA (inventario inicial o aporte del dueño). */
    supplier_id: uuid.optional(),
    /** Con proveedor: en qué estado está su factura. Obligatorio si hay proveedor. */
    invoice: z.enum(["present", "pending", "none"]).optional(),
    /** Referencia del documento del proveedor: solo con `invoice: "present"`. */
    supplier_document_number: z.string().trim().min(1).max(60).optional(),
    supplier_control_number: z.string().trim().min(1).max(60).optional(),
    supplier_document_ref: z.string().trim().min(1).max(120).optional(),
    /** El día que llegó. Por omisión, hoy en Venezuela. Acotado en el servidor (ADR-0066 §5). */
    arrived_on: z.string().date().optional(),
    /** Guía, nota de entrega, «lo traje yo»: queda en el documento. */
    reference: z.string().trim().min(1).max(60).optional(),
    /** El pedido del que viene, si viene de uno. */
    purchase_order_id: uuid.optional(),
    retention_concepts: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
    /** Pagada en el acto. Ausente = queda debiendo. */
    payment: z
      .object({
        instrument: PurchaseInstrument,
        /** Lo pagado. Ausente = el saldo entero de la factura. */
        amount: amount.optional(),
        account_id: uuid.optional(),
        reference: z.string().trim().min(1).max(100).optional(),
        allow_negative_balance: z.boolean().optional(),
      })
      .strict()
      .optional(),
    lines: z.array(ArrivalLineRequest).min(1).max(200),
  })
  .strict()
  .refine((r) => (r.supplier_id === undefined) === (r.invoice === undefined), {
    message:
      "Con proveedor hay que decir en qué estado está su factura (present, pending, none); sin proveedor, no hay factura que declarar.",
  })
  .refine((r) => r.supplier_id !== undefined || r.payment === undefined, {
    message: "La mercancía que ya era tuya no se paga a nadie.",
  })
  .refine(
    (r) =>
      r.invoice === "present" ||
      (r.supplier_document_number === undefined &&
        r.supplier_control_number === undefined &&
        r.supplier_document_ref === undefined),
    { message: "Los datos de la factura solo se mandan cuando la factura existe." },
  );
export type RegisterArrivalRequest = z.infer<typeof RegisterArrivalRequest>;

export const ArrivalResponse = z
  .object({
    /** Cuál de las cuatro salidas contables tomó la llegada. */
    kind: z.enum(["own", "receipt", "invoiced", "unsupported"]),
    receipt: GoodsReceiptResponse.nullable(),
    invoice: SupplierInvoiceResponse.nullable(),
    payment: SupplierPaymentResponse.nullable(),
    /** Movimientos de kardex del camino «ya era mía»; en los demás van dentro de la recepción. */
    moves: z.array(InventoryMoveResponse),
  })
  .strict();
export type ArrivalResponse = z.infer<typeof ArrivalResponse>;

/**
 * Lo que se vendió entre la fecha de la llegada y hoy. La pantalla lo muestra ANTES de
 * confirmar una llegada fechada hacia atrás: ese costo ya quedó registrado y no se corrige
 * (ADR-0066 §5).
 */
export const ArrivalImpactResponse = z
  .object({
    sales_since: z.array(
      z.object({ product_id: uuid, name: z.string(), quantity: z.string() }).strict(),
    ),
  })
  .strict();
export type ArrivalImpactResponse = z.infer<typeof ArrivalImpactResponse>;
