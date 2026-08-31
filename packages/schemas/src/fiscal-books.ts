import { z } from "zod";

/**
 * Contratos de LIBROS FISCALES (migración 27, ADR-0044).
 *
 * Un libro no tiene request de creación: es una CONSULTA sobre los documentos
 * ya emitidos, y por eso sus parámetros viajan en el query string. Lo único que
 * se manda por cuerpo es la EXPORTACIÓN, que sí es un acto y sí deja rastro.
 *
 * Todo importe es string decimal (regla 7). Y todas las bases van separadas por
 * tratamiento —gravado, exento, exonerado, no sujeto— porque son columnas
 * legalmente distintas y una alícuota de cero no las distingue.
 */
const uuid = z.string().uuid();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha como YYYY-MM-DD");

export const BookKind = z.enum(["ventas", "compras", "retenciones_iva", "retenciones_islr"]);
export type BookKind = z.infer<typeof BookKind>;

export const TaxTreatment = z.enum(["gravado", "exento", "exonerado", "no_sujeto"]);
export type TaxTreatment = z.infer<typeof TaxTreatment>;

/**
 * Las cuatro bases + la quinta que no debería existir.
 *
 * `base_sin_clasificar` recoge lo emitido ANTES de la migración 27, que no tiene
 * tratamiento congelado. Está en el contrato a propósito y visible en pantalla:
 * un libro que reparte en silencio lo que no sabe clasificar produce una
 * declaración falsa sin avisar a nadie.
 */
const Bases = {
  base_gravada: z.string(),
  base_exenta: z.string(),
  base_exonerada: z.string(),
  base_no_sujeta: z.string(),
  base_sin_clasificar: z.string(),
};

export const SalesBookRow = z
  .object({
    document_id: uuid,
    issued_on: z.string(),
    kind: z.string(),
    series: z.string(),
    document_number: z.number().int().nullable(),
    control_number: z.number().int().nullable(),
    /** `annulled` SÍ aparece: el correlativo se consumió y el libro lo registra. */
    status: z.string(),
    customer_tax_id: z.string().nullable(),
    customer_name: z.string(),
    customer_taxpayer_type: z.string(),
    transaction_currency: z.string(),
    fx_rate: z.string(),
    ...Bases,
    iva_debito: z.string(),
    total_amount: z.string(),
    /** NULL = pendiente en la cola de ADR-0042, no «sin contabilizar por error». */
    journal_entry_id: uuid.nullable(),
  })
  .strict();
export type SalesBookRow = z.infer<typeof SalesBookRow>;

export const PurchasesBookRow = z
  .object({
    invoice_id: uuid,
    invoice_date: z.string(),
    supplier_tax_id: z.string().nullable(),
    supplier_name: z.string(),
    supplier_kind: z.string(),
    /** Del proveedor y como TEXTO, tal como él lo emitió (ADR-0040 §2). */
    supplier_document_number: z.string(),
    supplier_control_number: z.string().nullable(),
    supplier_document_ref: z.string().nullable(),
    status: z.string(),
    ...Bases,
    /** Crédito fiscal solo si es recuperable; si no, el mismo importe es costo. */
    iva_credito: z.string(),
    iva_al_costo: z.string(),
    tax_is_recoverable: z.boolean(),
    retenido_iva: z.string(),
    retenido_islr: z.string(),
    total_amount: z.string(),
    journal_entry_id: uuid.nullable(),
  })
  .strict();
export type PurchasesBookRow = z.infer<typeof PurchasesBookRow>;

export const IvaRetentionBookRow = z
  .object({
    retention_id: uuid,
    receipt_number: z.number().int().nullable(),
    receipt_series: z.string().nullable(),
    fiscal_period: z.string().nullable(),
    issued_on: z.string().nullable(),
    supplier_tax_id: z.string().nullable(),
    supplier_name: z.string(),
    supplier_document_number: z.string(),
    supplier_control_number: z.string().nullable(),
    invoice_date: z.string(),
    base_amount: z.string(),
    rate: z.string(),
    retained_amount: z.string(),
    /** La norma con la que se retuvo. Sin ella el libro dice cuánto, no por qué. */
    legal_source: z.string(),
    receipt_status: z.string().nullable(),
  })
  .strict();
export type IvaRetentionBookRow = z.infer<typeof IvaRetentionBookRow>;

export const IslrRetentionBookRow = z
  .object({
    retention_id: uuid,
    receipt_number: z.number().int().nullable(),
    receipt_series: z.string().nullable(),
    fiscal_period: z.string().nullable(),
    issued_on: z.string().nullable(),
    supplier_tax_id: z.string().nullable(),
    supplier_name: z.string(),
    concept_code: z.string(),
    concept_name: z.string(),
    formula_kind: z.string(),
    supplier_document_number: z.string(),
    invoice_date: z.string(),
    base_amount: z.string(),
    rate: z.string(),
    subtrahend: z.string().nullable(),
    retained_amount: z.string(),
    legal_source: z.string(),
    receipt_status: z.string().nullable(),
  })
  .strict();
export type IslrRetentionBookRow = z.infer<typeof IslrRetentionBookRow>;

export const FiscalBookResponse = z
  .object({
    book_kind: BookKind,
    period_from: fecha,
    period_to: fecha,
    currency: z.string(),
    row_count: z.number().int(),
    /**
     * Los renglones. El tipo real depende de `book_kind`; el contrato los
     * publica como unión porque un libro es un libro y la pantalla es una.
     */
    rows: z.array(
      z.union([SalesBookRow, PurchasesBookRow, IvaRetentionBookRow, IslrRetentionBookRow]),
    ),
    /**
     * Cuántos renglones llevan base sin clasificar. Va en la cabecera para que
     * la pantalla pueda avisar sin recorrer las filas, y para que quede en el
     * hash de la exportación.
     */
    unclassified_rows: z.number().int(),
  })
  .strict();
export type FiscalBookResponse = z.infer<typeof FiscalBookResponse>;

/**
 * `libro = mayor + pendientes en cola` (ADR-0044 §3).
 *
 * Las TRES cifras, no la diferencia sola: mientras exista la cola de ADR-0042
 * un documento correcto puede estar sin contabilizar, y un reporte que solo
 * dijera «no cuadra» convertiría eso en un falso positivo diario.
 */
export const BookReconciliationResponse = z
  .object({
    period_from: fecha,
    period_to: fecha,
    currency: z.string(),
    rows: z.array(
      z
        .object({
          concepto: z.string(),
          libro: z.string(),
          mayor: z.string(),
          en_cola: z.string(),
          diferencia: z.string(),
          cuadra: z.boolean(),
        })
        .strict(),
    ),
    balanced: z.boolean(),
  })
  .strict();
export type BookReconciliationResponse = z.infer<typeof BookReconciliationResponse>;

export const BookFormatAdapterResponse = z
  .object({
    code: z.string(),
    book_kind: z.string(),
    name: z.string(),
    description: z.string(),
    /** Hoy NINGUNO es oficial: el layout del SENIAT no está en el repositorio. */
    is_official: z.boolean(),
    legal_source: z.string(),
    status: z.string(),
    /** Si el adaptador tiene implementación en este release (ADR-0044 §5). */
    implemented: z.boolean(),
  })
  .strict();
export type BookFormatAdapterResponse = z.infer<typeof BookFormatAdapterResponse>;

/**
 * Exportar. Consultar en pantalla no deja rastro; exportar sí, porque es el acto
 * que precede a una presentación y lo que hay que poder demostrar después.
 */
export const ExportFiscalBookRequest = z
  .object({
    company_id: uuid,
    book_kind: BookKind,
    period_from: fecha,
    period_to: fecha,
    format_code: z
      .string()
      .regex(/^[a-z][a-z0-9_]{0,39}$/, "código de adaptador de formato del catálogo"),
    /**
     * La zona horaria con la que se interpretó el período. Va persistida entre
     * los siete campos: sin ella, «el libro de agosto» no significa lo mismo
     * generado desde dos husos distintos.
     */
    timezone: z.string().trim().min(1).max(60),
  })
  .strict();
export type ExportFiscalBookRequest = z.infer<typeof ExportFiscalBookRequest>;

export const FiscalBookRunResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    book_kind: BookKind,
    period_from: z.string(),
    period_to: z.string(),
    parameters: z.record(z.unknown()),
    timezone: z.string(),
    generator_version: z.string(),
    /**
     * SHA-256 del dataset, calculado en Postgres sobre las filas exactas que
     * salieron. Dos exportaciones iguales dan el mismo hash; una distinta dice
     * que algo cambió entre medias.
     */
    dataset_hash: z.string().regex(/^[0-9a-f]{64}$/),
    row_count: z.number().int(),
    format_code: z.string(),
    created_by: uuid.nullable(),
    created_at: z.string(),
  })
  .strict();
export type FiscalBookRunResponse = z.infer<typeof FiscalBookRunResponse>;

export const ExportFiscalBookResponse = z
  .object({
    run: FiscalBookRunResponse,
    book: FiscalBookResponse,
    /** El contenido serializado con el adaptador pedido. */
    content: z.string(),
    content_type: z.string(),
    filename: z.string(),
  })
  .strict();
export type ExportFiscalBookResponse = z.infer<typeof ExportFiscalBookResponse>;

export const ListFiscalBookRunsResponse = z
  .object({ runs: z.array(FiscalBookRunResponse) })
  .strict();
export type ListFiscalBookRunsResponse = z.infer<typeof ListFiscalBookRunsResponse>;
