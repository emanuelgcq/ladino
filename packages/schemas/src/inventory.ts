import { z } from "zod";

/**
 * Contratos de inventario (migración 19, ADR-0034). Cantidades e importes viajan
 * SIEMPRE como string decimal — regla 7: nunca un number JSON para dinero, y
 * tampoco para cantidades, que se multiplican por dinero.
 */
const uuid = z.string().uuid();

/**
 * ¿Es distinto de cero? Un decimal es cero si y SOLO si no tiene ningún dígito
 * 1-9. Se comprueba así y no con `parseFloat` a propósito: la regla 7 prohíbe
 * convertir un importe a coma flotante, y "0.000000001" ya redondearía.
 */
const noEsCero = (v: string): boolean => /[1-9]/.test(v);

/** Cantidad positiva: hasta 16 enteros y 8 decimales, exactamente numeric(24,8). */
export const QuantityString = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "cantidad decimal como string: hasta 16 enteros y 8 decimales")
  .refine(noEsCero, "la cantidad debe ser mayor que cero");

const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");

/**
 * La tasa de una entrada en moneda distinta a la funcional. Sin `source` no se
 * persiste (ADR-0020); `at` es el momento de la tasa, no el del movimiento.
 */
export const FxInput = z
  .object({
    rate: z.string().regex(/^\d{1,16}(\.\d{1,8})?$/, "tasa decimal como string"),
    source: z.string().trim().min(1).max(120),
    at: z.string().datetime({ offset: true }),
  })
  .strict();
export type FxInput = z.infer<typeof FxInput>;

const posicion = {
  company_id: uuid,
  warehouse_id: uuid,
  product_id: uuid,
  lot_id: uuid.nullable().optional(),
};

export const ReceiveStockRequest = z
  .object({
    ...posicion,
    quantity: QuantityString,
    /** Costo TOTAL de la recepción en `currency`, no unitario: el unitario se deriva. */
    amount,
    currency: z.string().regex(/^[A-Z]{3}$/),
    /** Obligatorio si `currency` no es la moneda funcional de la empresa. */
    fx: FxInput.optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    reference: z.string().trim().min(1).max(60).optional(),
    /** Código de lote: se crea si no existe (un lote aparece al recibir). */
    lot_code: z.string().trim().min(1).max(60).optional(),
    lot_expires_at: z.string().date().optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type ReceiveStockRequest = z.infer<typeof ReceiveStockRequest>;

export const IssueStockRequest = z
  .object({
    ...posicion,
    quantity: QuantityString,
    occurred_at: z.string().datetime({ offset: true }).optional(),
    reference: z.string().trim().min(1).max(60).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type IssueStockRequest = z.infer<typeof IssueStockRequest>;

export const AdjustStockRequest = z
  .object({
    ...posicion,
    /** Delta CON SIGNO: "-3" resta, "3" suma. Cero no es un ajuste. */
    delta: z
      .string()
      .regex(/^-?\d{1,16}(\.\d{1,8})?$/, "delta decimal con signo como string")
      .refine(noEsCero, "un ajuste exige un delta distinto de cero"),
    /** OBLIGATORIO: un ajuste sin motivo no es un ajuste, es un descuadre. */
    reason: z.string().trim().min(3).max(500),
    /** Costo unitario de un ajuste POSITIVO; por omisión, el promedio vigente. */
    unit_cost: amount.optional(),
    occurred_at: z.string().datetime({ offset: true }).optional(),
    reference: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type AdjustStockRequest = z.infer<typeof AdjustStockRequest>;

export const TransferStockRequest = z
  .object({
    company_id: uuid,
    from_warehouse_id: uuid,
    to_warehouse_id: uuid,
    product_id: uuid,
    lot_id: uuid.nullable().optional(),
    quantity: QuantityString,
    occurred_at: z.string().datetime({ offset: true }).optional(),
    reference: z.string().trim().min(1).max(60).optional(),
    note: z.string().trim().min(1).max(500).optional(),
  })
  .strict();
export type TransferStockRequest = z.infer<typeof TransferStockRequest>;

/** Un movimiento del kardex. Los importes, `{amount, currency}` como manda la regla 7. */
export const InventoryMoveResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    warehouse_id: uuid,
    product_id: uuid,
    lot_id: uuid.nullable(),
    kind: z.enum(["entrada", "salida", "ajuste", "transferencia_in", "transferencia_out"]),
    quantity: z.string(),
    functional_amount: z.string(),
    functional_currency: z.string(),
    amount_transaction_currency: z.string(),
    transaction_currency: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    rate_timestamp: z.string().datetime({ offset: true }),
    rounding_policy_id: z.string(),
    unit_cost: z.string(),
    quantity_after: z.string(),
    value_after: z.string(),
    occurred_at: z.string().datetime({ offset: true }),
    reference: z.string().nullable(),
    reason: z.string().nullable(),
    transfer_id: uuid.nullable(),
  })
  .strict();
export type InventoryMoveResponse = z.infer<typeof InventoryMoveResponse>;

export const ListInventoryMovesResponse = z
  .object({ items: z.array(InventoryMoveResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListInventoryMovesResponse = z.infer<typeof ListInventoryMovesResponse>;

export const StockBalanceResponse = z
  .object({
    warehouse_id: uuid,
    warehouse_code: z.string(),
    product_id: uuid,
    product_sku: z.string(),
    product_name: z.string(),
    lot_id: uuid.nullable(),
    lot_code: z.string().nullable(),
    quantity: z.string(),
    value: z.string(),
    currency: z.string(),
    last_unit_cost: z.string(),
  })
  .strict();
export type StockBalanceResponse = z.infer<typeof StockBalanceResponse>;

export const ListStockResponse = z
  .object({ items: z.array(StockBalanceResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListStockResponse = z.infer<typeof ListStockResponse>;

export const CreateWarehouseRequest = z
  .object({
    company_id: uuid,
    code: z.string().trim().min(1).max(30),
    name: z.string().trim().min(1).max(100),
    branch_id: uuid.nullable().optional(),
  })
  .strict();
export type CreateWarehouseRequest = z.infer<typeof CreateWarehouseRequest>;

export const WarehouseResponse = z
  .object({
    id: uuid,
    tenant_id: uuid,
    company_id: uuid,
    branch_id: uuid.nullable(),
    code: z.string(),
    name: z.string(),
    status: z.enum(["active", "inactive"]),
  })
  .strict();
export type WarehouseResponse = z.infer<typeof WarehouseResponse>;

/** La transferencia devuelve LAS DOS patas: es un solo hecho con dos movimientos. */
export const TransferResponse = z
  .object({
    transfer_id: uuid,
    out: InventoryMoveResponse,
    in: InventoryMoveResponse,
  })
  .strict();
export type TransferResponse = z.infer<typeof TransferResponse>;

// ── Recetas de productos compuestos (ADR-0035) ───────────────────────────────

export const RecipeLineRequest = z
  .object({
    child_product_id: uuid,
    /** Cantidad por UNA unidad del compuesto, en `unit_code`. */
    quantity: QuantityString,
    unit_code: z.string().regex(/^[a-z][a-z0-9_]{0,19}$/),
  })
  .strict();
export type RecipeLineRequest = z.infer<typeof RecipeLineRequest>;

/** La receta se reemplaza ENTERA: una receta a medias no es una receta. */
export const SetRecipeRequest = z
  .object({
    company_id: uuid,
    lines: z.array(RecipeLineRequest).min(1).max(100),
  })
  .strict();
export type SetRecipeRequest = z.infer<typeof SetRecipeRequest>;

export const RecipeLineResponse = z
  .object({
    child_product_id: uuid,
    child_sku: z.string(),
    child_name: z.string(),
    quantity: z.string(),
    unit_code: z.string(),
    product_unit_code: z.string(),
    /** null = no hay conversión cargada: esta receta NO se puede consumir. */
    quantity_in_product_unit: z.string().nullable(),
  })
  .strict();
export type RecipeLineResponse = z.infer<typeof RecipeLineResponse>;

export const RecipeResponse = z
  .object({
    product_id: uuid,
    lines: z.array(RecipeLineResponse),
    /** Costo estimado de UNA unidad con los costos vigentes. null si falta alguna conversión. */
    estimated_unit_cost: z.string().nullable(),
    currency: z.string(),
  })
  .strict();
export type RecipeResponse = z.infer<typeof RecipeResponse>;

export const ConsumeRecipeRequest = z
  .object({
    company_id: uuid,
    warehouse_id: uuid,
    /** El producto COMPUESTO que se vende. */
    product_id: uuid,
    quantity: QuantityString,
    occurred_at: z.string().datetime({ offset: true }).optional(),
    reference: z.string().trim().min(1).max(60).optional(),
    /** Si el llamante ya tiene el documento (una venta), lo pasa; si no, se genera. */
    source_document_id: uuid.optional(),
  })
  .strict();
export type ConsumeRecipeRequest = z.infer<typeof ConsumeRecipeRequest>;

export const ConsumeRecipeResponse = z
  .object({
    source_document_id: uuid,
    product_id: uuid,
    quantity: z.string(),
    /** La SUMA de lo que costaron las salidas reales, no una estimación. */
    total_cost: z.string(),
    currency: z.string(),
    moves: z.array(InventoryMoveResponse),
  })
  .strict();
export type ConsumeRecipeResponse = z.infer<typeof ConsumeRecipeResponse>;

// ── Plantillas y variantes (ADR-0036) ────────────────────────────────────────

export const CreateProductTemplateRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(1).max(200),
    attribute_keys: z.array(z.string().trim().min(1).max(40)).min(1).max(8),
  })
  .strict();
export type CreateProductTemplateRequest = z.infer<typeof CreateProductTemplateRequest>;

export const ProductTemplateResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    name: z.string(),
    attribute_keys: z.array(z.string()),
    status: z.enum(["active", "inactive"]),
  })
  .strict();
export type ProductTemplateResponse = z.infer<typeof ProductTemplateResponse>;

export const TemplateStockResponse = z
  .object({
    items: z.array(
      z
        .object({
          template_id: uuid,
          template_name: z.string(),
          product_id: uuid,
          sku: z.string(),
          attributes: z.record(z.string()).nullable(),
          warehouse_id: uuid.nullable(),
          quantity: z.string(),
          value: z.string(),
          template_quantity: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type TemplateStockResponse = z.infer<typeof TemplateStockResponse>;

// ── Umbrales y alertas ───────────────────────────────────────────────────────

export const SetStockThresholdRequest = z
  .object({
    company_id: uuid,
    warehouse_id: uuid,
    product_id: uuid,
    stock_min: amount,
    stock_max: amount.optional(),
  })
  .strict();
export type SetStockThresholdRequest = z.infer<typeof SetStockThresholdRequest>;

export const LowStockResponse = z
  .object({
    items: z.array(
      z
        .object({
          warehouse_id: uuid,
          product_id: uuid,
          product_sku: z.string(),
          product_name: z.string(),
          quantity: z.string(),
          stock_min: z.string(),
          stock_max: z.string().nullable(),
          missing: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type LowStockResponse = z.infer<typeof LowStockResponse>;

export const ExpiringLotsResponse = z
  .object({
    items: z.array(
      z
        .object({
          lot_id: uuid,
          lot_code: z.string(),
          product_id: uuid,
          product_sku: z.string(),
          warehouse_id: uuid,
          expires_at: z.string(),
          /** Negativo = YA vencido, y son los que más urgen. */
          days_left: z.number().int(),
          quantity: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type ExpiringLotsResponse = z.infer<typeof ExpiringLotsResponse>;
