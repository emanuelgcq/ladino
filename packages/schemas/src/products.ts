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
    /**
     * Clasificación para el IVA. OPCIONAL: sin ella el producto nace con la clasificación por
     * omisión de la empresa, igual que el alta simple y la importación. Un negocio sin RIF no
     * cobra IVA y su pantalla no la pregunta (regla del dueño, 2026-09-16).
     */
    tax_category_code: z.string().regex(CODE_RE).optional(),
    /**
     * Hallazgo 10 (ADR-0073): la reducida es una LISTA CERRADA de bienes (LIVA art. 64). Clasificar
     * como `gravado_reducida` exige el literal del bien (`tax_reduced_rate_literals`).
     */
    reduced_rate_literal: z
      .string()
      .regex(/^64(\.[0-9a-z]+)+$/)
      .optional(),
    /**
     * Hallazgo 10: la adicional del art. 61 (suntuarios) no tiene lista con fuente; clasificar como
     * `gravado_adicional` exige por qué el bien es suntuario. Queda en el acta.
     */
    tax_category_justification: z.string().trim().min(10).max(500).optional(),
    category_id: uuid.optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    /**
     * Con qué estado nace. Por omisión **`active`**: un producto que nace en
     * borrador no se puede vender, y un alta que devuelve «creado» dejando
     * algo inservible es una trampa (2026-09-10).
     *
     * `draft` sigue existiendo y es el único estado donde `kind` todavía se
     * puede corregir (LAD33): quien quiera esa red la pide explícitamente.
     */
    status: z.enum(["draft", "active"]).optional(),
    /**
     * I-04: «es un compuesto». Se vende, pero no lleva existencia propia: venderlo descuenta los
     * ingredientes de su receta (`PUT /v1/products/:id/recipe`). No admite lote ni vencimiento.
     */
    is_composed: z.boolean().optional(),
    /**
     * C-07: «lleva lote y vencimiento». UN interruptor: enciende las dos banderas del esquema
     * (`tracks_lots` y `tracks_expiry`). La llegada pide entonces el lote y su fecha, y la venta
     * toma primero lo que vence antes. No se cambia con movimientos registrados.
     */
    tracks_lots: z.boolean().optional(),
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
    /**
     * I-04: «es un compuesto». Se vende, pero no lleva existencia propia: venderlo descuenta los
     * ingredientes de su receta (`PUT /v1/products/:id/recipe`). No admite lote ni vencimiento.
     */
    is_composed: z.boolean().optional(),
    /**
     * C-07: «lleva lote y vencimiento». UN interruptor: enciende las dos banderas del esquema
     * (`tracks_lots` y `tracks_expiry`). La llegada pide entonces el lote y su fecha, y la venta
     * toma primero lo que vence antes. No se cambia con movimientos registrados.
     */
    tracks_lots: z.boolean().optional(),
  })
  .strict();
export type UpdateProductRequest = z.infer<typeof UpdateProductRequest>;

export const SetProductTaxCategoryRequest = z
  .object({
    company_id: uuid,
    tax_category_code: z.string().regex(CODE_RE),
    /**
     * Hallazgo 10 (ADR-0073): la reducida es una LISTA CERRADA de bienes (LIVA art. 64). Clasificar
     * como `gravado_reducida` exige el literal del bien (`tax_reduced_rate_literals`).
     */
    reduced_rate_literal: z
      .string()
      .regex(/^64(\.[0-9a-z]+)+$/)
      .optional(),
    /**
     * Hallazgo 10: la adicional del art. 61 (suntuarios) no tiene lista con fuente; clasificar como
     * `gravado_adicional` exige por qué el bien es suntuario. Queda en el acta.
     */
    tax_category_justification: z.string().trim().min(10).max(500).optional(),
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
    /** Ruta de la foto en el bucket privado (migración 28); la URL firmada la da la API. */
    image_path: z.string().nullable(),
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
    /**
     * Extras de la CUADRÍCULA de Vender (Fase C): presentes solo si el listado
     * se pidió con `with_price` / `with_stock` / hay foto. Cifras como string.
     */
    image_url: z.string().nullable().optional(),
    price_amount: AmountString.nullable().optional(),
    price_currency: z.string().nullable().optional(),
    price_list_id: uuid.nullable().optional(),
    /** ADR-0046: equivalente en moneda funcional a la tasa de HOY, del servidor; null sin tasa. */
    price_equivalent_amount: AmountString.nullable().optional(),
    price_equivalent_currency: z.string().nullable().optional(),
    stock_quantity: z.string().nullable().optional(),
    /** Costo de referencia importado (ADR-0074, H11): informativo, no es el costo del kardex. */
    reference_cost_amount: AmountString.nullable().optional(),
    reference_cost_currency: z.string().nullable().optional(),
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
    /** true si es la que la caja aplica a un cliente sin preferida (migración 36 o heurística). */
    is_caja_default: z.boolean().optional(),
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

/** `{amount, currency}`: la forma canónica de un importe en la API (regla 7). */
export const MoneyInput = z
  .object({ amount: AmountString, currency: z.string().regex(/^[A-Z]{3}$/) })
  .strict();
export type MoneyInput = z.infer<typeof MoneyInput>;

const quantitySimple = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "cantidad decimal como string")
  .refine((v) => /[1-9]/.test(v), "la cantidad debe ser mayor que cero");

/**
 * El ALTA SIMPLE de la Fase C: foto aparte (endpoint de subida), nombre, precio
 * y ya. Todo lo demás tiene default con criterio: el SKU se genera, la
 * clasificación fiscal sale de company_settings, la unidad es `unidad`, y el
 * stock inicial crea su entrada de «inventario inicial» con costo.
 */
export const CreateProductSimpleRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(1).max(200),
    /** «Es un servicio»: sin existencias, sin stock inicial. */
    is_service: z.boolean().optional(),
    /** El precio de venta al detal, en SU moneda (normalmente USD). */
    price: MoneyInput,
    /** Solo si el negocio vende al mayor (company_settings.sells_wholesale). */
    wholesale_price: MoneyInput.optional(),
    initial_stock: z
      .object({
        quantity: quantitySimple,
        /** Costo UNITARIO; el total lo calcula el servidor. */
        unit_cost: MoneyInput,
        warehouse_id: uuid.optional(),
      })
      .strict()
      .optional(),
    sku: z.string().trim().min(1).max(60).optional(),
    barcode: z.string().trim().min(1).max(64).optional(),
    /** Categoría por NOMBRE: se crea al vuelo si no existe. */
    category_name: z.string().trim().min(2).max(80).optional(),
    unit_code: z.string().regex(CODE_RE).optional(),
    /**
     * C-02: la misma alta sirve en administración. Lo avanzado es OPCIONAL y pasa tal cual al
     * alta completa, que es la que lo valida (`CreateProductRequest`): sin clasificación, la de
     * la empresa.
     */
    tax_category_code: z.string().regex(CODE_RE).optional(),
    reduced_rate_literal: z
      .string()
      .regex(/^64(\.[0-9a-z]+)+$/)
      .optional(),
    tax_category_justification: z.string().trim().min(10).max(500).optional(),
    /**
     * I-04: «es un compuesto». Se vende, pero no lleva existencia propia: venderlo descuenta los
     * ingredientes de su receta (`PUT /v1/products/:id/recipe`). No admite lote ni vencimiento.
     */
    is_composed: z.boolean().optional(),
    /**
     * C-07: «lleva lote y vencimiento». UN interruptor: enciende las dos banderas del esquema
     * (`tracks_lots` y `tracks_expiry`). La llegada pide entonces el lote y su fecha, y la venta
     * toma primero lo que vence antes. No se cambia con movimientos registrados.
     */
    tracks_lots: z.boolean().optional(),
  })
  .strict();
export type CreateProductSimpleRequest = z.infer<typeof CreateProductSimpleRequest>;

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
    /**
     * El equivalente EN LA OTRA MONEDA, calculado por el SERVIDOR con la tasa
     * BCV de HOY — referencia, no dato del precio (la tasa se ancla al
     * documento, no al precio). NULL sin tasa vigente.
     */
    equivalent_amount: z.string().nullable().optional(),
    equivalent_currency: z.string().nullable().optional(),
    /**
     * C-11: el equivalente a la tasa oficial vigente EL DÍA (de Caracas) EN QUE EMPEZÓ A REGIR
     * el precio, con la tasa, su fecha y su fuente (regla 8). Solo en el historial de la lista.
     * `historical_rate_status` dice por qué no hay cifra: `missing` (ese día no había tasa) o
     * `scheduled` (el precio todavía no rige: su día no tiene tasa) o `not_applicable` (la lista
     * no es USD ni VES: no hay par que convertir). Nunca se rellena con la de hoy.
     */
    historical_equivalent_amount: z.string().nullable().optional(),
    historical_equivalent_currency: z.string().nullable().optional(),
    historical_rate: z.string().nullable().optional(),
    historical_rate_date: z.string().nullable().optional(),
    historical_rate_source: z.string().nullable().optional(),
    historical_rate_status: z
      .enum(["available", "missing", "scheduled", "not_applicable"])
      .optional(),
  })
  .strict();
export type PriceItemResponse = z.infer<typeof PriceItemResponse>;

export const ProductSimpleResponse = z
  .object({
    product: ProductResponse,
    price: PriceItemResponse,
    wholesale_price: PriceItemResponse.nullable(),
    initial_stock: z
      .object({
        quantity: z.string(),
        unit_cost: AmountString,
        currency: z.string(),
        warehouse_id: uuid,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProductSimpleResponse = z.infer<typeof ProductSimpleResponse>;

/**
 * El resultado del IMPORT de Excel (Fase C): fila por fila, en voz de persona.
 * El import es PARCIAL por diseño — cada fila es su propia transacción: las
 * buenas entran, las malas se explican con su número de fila, y nadie repite
 * un archivo de 200 productos porque la fila 137 tenía el precio vacío.
 */
export const ImportProductsRowResult = z
  .object({
    /** Número de FILA del archivo (contando el encabezado como 1). */
    row: z.number().int(),
    status: z.enum(["creado", "error"]),
    message: z.string().optional(),
    product_id: uuid.optional(),
    sku: z.string().optional(),
    name: z.string().optional(),
    /** Avisos de la fila (ADR-0074, C-05): lo que se ignoró o se leyó distinto, nunca en silencio. */
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type ImportProductsRowResult = z.infer<typeof ImportProductsRowResult>;

export const ImportProductsResponse = z
  .object({
    total: z.number().int(),
    created: z.number().int(),
    failed: z.number().int(),
    rows: z.array(ImportProductsRowResult),
  })
  .strict();
export type ImportProductsResponse = z.infer<typeof ImportProductsResponse>;

// ── La importación como TRABAJO (ADR-0074; C-01, C-04, C-05) ────────────────

/**
 * El formato de los NÚMEROS del archivo, declarado por la persona (C-01). Por omisión, el de
 * Venezuela: coma decimal y punto de miles («1.234,50»). Una celda ambigua bajo el formato
 * elegido («0.500» con coma decimal: ¿0,5 o 500?) se rechaza con su fila y el motivo.
 */
export const ImportNumberFormat = z.enum(["comma_decimal", "dot_decimal"]);
export type ImportNumberFormat = z.infer<typeof ImportNumberFormat>;

/** Una fila INTERPRETADA: exactamente lo que se va a guardar, con sus avisos. */
export const ProductImportRow = z
  .object({
    /** Número de FILA del archivo (contando el encabezado como 1). */
    row: z.number().int(),
    status: z.enum(["ready", "rejected"]),
    /** El motivo del rechazo, en voz de persona. Solo con `rejected`. */
    message: z.string().optional(),
    warnings: z.array(z.string()),
    name: z.string().optional(),
    sku: z.string().optional(),
    barcode: z.string().optional(),
    category_name: z.string().optional(),
    is_service: z.boolean().optional(),
    price: MoneyInput.optional(),
    initial_stock: z
      .object({ quantity: AmountString, unit_cost: MoneyInput })
      .strict()
      .nullable()
      .optional(),
    /** El costo sin existencia (o de un servicio): se acepta como referencia, con aviso. */
    reference_cost: MoneyInput.nullable().optional(),
    /**
     * El código ya existe en la empresa: la fila solo actualiza el precio (y el costo de
     * referencia); ni la existencia ni el nombre cambian (H1). Lo pone la vista previa.
     */
    updates_existing: z.boolean().optional(),
  })
  .strict();
export type ProductImportRow = z.infer<typeof ProductImportRow>;

export const ProductImportPreviewResponse = z
  .object({
    number_format: ImportNumberFormat,
    file_name: z.string(),
    /** sha256 del archivo: la llave del trabajo al confirmar. */
    file_hash: z.string(),
    total: z.number().int(),
    ready: z.number().int(),
    rejected: z.number().int(),
    /** Las diez primeras filas, como se van a guardar. */
    rows: z.array(ProductImportRow),
    /** TODAS las filas rechazadas, con su número y su motivo. */
    rejected_rows: z.array(ProductImportRow),
    /** TODAS las filas con aviso, también las que no caben en las diez primeras (H5). */
    warned_rows: z.array(ProductImportRow),
    /**
     * El formato que el archivo PARECE usar cuando alguna celda solo se entiende con el contrario
     * al declarado (H6); null si el archivo es coherente con lo declarado.
     */
    suspected_format: ImportNumberFormat.nullable(),
  })
  .strict();
export type ProductImportPreviewResponse = z.infer<typeof ProductImportPreviewResponse>;

export const ProductImportJobRowResult = z
  .object({
    row: z.number().int(),
    status: z.enum(["created", "updated", "rejected"]),
    message: z.string().optional(),
    warnings: z.array(z.string()),
    name: z.string().optional(),
    sku: z.string().optional(),
    product_id: uuid.optional(),
    reference_cost: MoneyInput.nullable().optional(),
  })
  .strict();
export type ProductImportJobRowResult = z.infer<typeof ProductImportJobRowResult>;

export const ProductImportJobResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    file_name: z.string(),
    file_hash: z.string(),
    number_format: ImportNumberFormat,
    status: z.enum(["pending", "running", "done", "failed"]),
    total_rows: z.number().int(),
    processed_rows: z.number().int(),
    created_count: z.number().int(),
    updated_count: z.number().int(),
    rejected_count: z.number().int(),
    /** El informe fila por fila, en el orden en que se procesaron. */
    report: z.array(ProductImportJobRowResult),
    last_error: z.string().nullable(),
    created_at: z.string(),
    finished_at: z.string().nullable(),
    /** true si el archivo ya tenía trabajo y se devolvió el existente (C-04). */
    reused: z.boolean(),
  })
  .strict();
export type ProductImportJobResponse = z.infer<typeof ProductImportJobResponse>;
