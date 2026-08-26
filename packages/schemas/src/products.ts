import { z } from "zod";

/**
 * Contratos del catálogo de productos y de precios (migraciones 16-17,
 * ADR-0032). Los IMPORTES viajan SIEMPRE como string decimal — regla 7 de
 * CLAUDE.md: nunca un number JSON para dinero. La forma acepta hasta 16
 * enteros y 8 decimales: exactamente numeric(24,8).
 */
export const AmountString = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");

const uuid = z.string().uuid();
const CODE_RE = /^[a-z][a-z0-9_]{0,39}$/;

export const CreateProductRequest = z
  .object({
    company_id: uuid,
    sku: z.string().trim().min(1).max(60),
    name: z.string().trim().min(1).max(200),
    kind: z.enum(["good", "service"]),
    unit_code: z.string().regex(CODE_RE),
    tax_category_code: z.string().regex(CODE_RE),
    category_id: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
  })
  .strict();
export type CreateProductRequest = z.infer<typeof CreateProductRequest>;

export const UpdateProductRequest = z
  .object({
    company_id: uuid,
    // `kind` NO se actualiza: es inmutable tras draft (LAD33, D-8) y en draft
    // el camino honesto es recrear. `tax_category_code` tiene su endpoint con
    // permiso propio (segregación del mapeo tributario).
    name: z.string().trim().min(1).max(200).optional(),
    status: z.enum(["draft", "active", "inactive"]).optional(),
    category_id: uuid.nullable().optional(),
    barcode: z.string().trim().min(1).max(64).nullable().optional(),
  })
  .strict();
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

export const SetProductTaxCategoryRequest = z
  .object({
    company_id: uuid,
    tax_category_code: z.string().regex(CODE_RE),
  })
  .strict();
export type SetProductTaxCategoryRequest = z.infer<typeof SetProductTaxCategoryRequest>;

export const ProductResponse = z
  .object({
    id: uuid,
    tenant_id: uuid,
    company_id: uuid,
    sku: z.string(),
    name: z.string(),
    kind: z.enum(["good", "service"]),
    status: z.enum(["draft", "active", "inactive"]),
    unit_code: z.string(),
    tax_category_code: z.string(),
    category_id: uuid.nullable(),
    barcode: z.string().nullable(),
    // Banderas de existencia (migraciones 19-20, ADR-0034/0035/0036). Viven en
    // el catálogo pero las gobierna inventario: un compuesto no tiene stock, un
    // producto con seriales no se mueve todavía, y una variante cuelga de una
    // plantilla.
    is_composed: z.boolean(),
    tracks_lots: z.boolean(),
    tracks_serials: z.boolean(),
    is_manufactured: z.boolean(),
    tracks_expiry: z.boolean(),
    template_id: uuid.nullable(),
    attributes: z.record(z.string()).nullable(),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProductResponse = z.infer<typeof ProductResponse>;

export const ListProductsResponse = z
  .object({
    items: z.array(ProductResponse),
    /** Total de la búsqueda, para paginar en servidor (WEBAPP_SPEC). */
    total: z.number().int().nonnegative(),
  })
  .strict();
export type ListProductsResponse = z.infer<typeof ListProductsResponse>;

export const CreatePriceListRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(1).max(100),
    currency_code: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type CreatePriceListRequest = z.infer<typeof CreatePriceListRequest>;

export const PriceListResponse = z
  .object({
    id: uuid,
    tenant_id: uuid,
    company_id: uuid,
    name: z.string(),
    currency_code: z.string(),
    status: z.enum(["active", "inactive"]),
    created_at: z.string().datetime({ offset: true }),
  })
  .strict();
export type PriceListResponse = z.infer<typeof PriceListResponse>;

export const SetPriceRequest = z
  .object({
    company_id: uuid,
    product_id: uuid,
    amount: AmountString,
    effective_from: z.string().datetime({ offset: true }),
    effective_to: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type SetPriceRequest = z.infer<typeof SetPriceRequest>;

/** Un precio: `{amount, currency}` como manda la regla 7 — la moneda es de la lista. */
export const PriceItemResponse = z
  .object({
    id: uuid,
    price_list_id: uuid,
    product_id: uuid,
    amount: AmountString,
    currency: z.string(),
    effective_from: z.string().datetime({ offset: true }),
    effective_to: z.string().datetime({ offset: true }).nullable(),
  })
  .strict();
export type PriceItemResponse = z.infer<typeof PriceItemResponse>;
