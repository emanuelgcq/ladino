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
