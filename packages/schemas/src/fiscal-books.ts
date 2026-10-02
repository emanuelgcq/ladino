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
    /** H11 (ADR-0071): el identificador del control, que con el número forma el control completo. */
    control_identifier: z.string().nullable(),
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
    /**
     * L-08 (RLIVA arts. 72 y 76, ADR-0073): base e IVA POR ALÍCUOTA, leídos de la categoría
     * congelada en la línea. La alícuota (fracción) es NULL si el documento no tiene líneas de
     * esa categoría.
     */
    base_alicuota_general: z.string(),
    iva_alicuota_general: z.string(),
    alicuota_general: z.string().nullable(),
    base_alicuota_adicional: z.string(),
    iva_alicuota_adicional: z.string(),
    alicuota_adicional: z.string().nullable(),
    base_alicuota_reducida: z.string(),
    iva_alicuota_reducida: z.string(),
    alicuota_reducida: z.string().nullable(),
    /**
     * H5: lo que no cae en ninguna de las tres alícuotas. Base gravada sin categoría reconocida
     * (debería ser cero) e IVA de las líneas sin categoría congelada (anteriores a la migración
     * 27). Con ellas, Σ por alícuota = base_gravada e iva_debito en cada renglón.
     */
    base_gravada_sin_alicuota: z.string(),
    iva_sin_clasificar: z.string(),
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
    /**
     * La moneda en que el proveedor FACTURÓ y la tasa con la que se llevó a bolívares. Todos
     * los importes de la fila están en moneda funcional (migración 65).
     */
    transaction_currency: z.string(),
    fx_rate: z.string(),
    ...Bases,
    /** Crédito fiscal solo si es recuperable; si no, el mismo importe es costo. */
    iva_credito: z.string(),
    iva_al_costo: z.string(),
    tax_is_recoverable: z.boolean(),
    retenido_iva: z.string(),
    retenido_islr: z.string(),
    total_amount: z.string(),
    journal_entry_id: uuid.nullable(),
    /**
     * ADR-0069 §4 (K-04): fecha en que se REGISTRÓ (la del período del libro). Si difiere de
     * `invoice_date` (la original del documento), la factura se recibió con retraso.
     */
    booked_on: z.string(),
    received_late: z.boolean(),
    /**
     * Hallazgo 6 (RLIVA arts. 72 y 75, P-59): base e IVA POR ALÍCUOTA de la compra, leídos de la
     * categoría congelada en la línea; y lo que las líneas no explican.
     */
    base_alicuota_general: z.string(),
    iva_alicuota_general: z.string(),
    alicuota_general: z.string().nullable(),
    base_alicuota_adicional: z.string(),
    iva_alicuota_adicional: z.string(),
    alicuota_adicional: z.string().nullable(),
    base_alicuota_reducida: z.string(),
    iva_alicuota_reducida: z.string(),
    alicuota_reducida: z.string().nullable(),
    base_gravada_sin_alicuota: z.string(),
    iva_sin_clasificar: z.string(),
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
    /**
     * F6: incluye los renglones con base gravada sin alícuota o IVA sin clasificar distintos de
     * cero.
     */
    unclassified_rows: z.number().int(),
    /**
     * Solo en los libros de VENTAS y de COMPRAS (hallazgo 6, P-59): el resumen del art. 72 del
     * RLIVA (L-08, ADR-0073). Una fila
     * por concepto (`gravado_general`, `gravado_adicional`, `gravado_reducida`, `exento`,
     * `exonerado`, `no_sujeto`, `sin_clasificar`) y alícuota; `adjustments_*` es la parte que
     * viene de notas de crédito (en negativo), de débito y, en compras, de ajustes de período
     * anterior.
     */
    summary: z
      .array(
        z
          .object({
            concept: z.string(),
            rate: z.string().nullable(),
            base: z.string(),
            tax: z.string(),
            adjustments_base: z.string(),
            adjustments_tax: z.string(),
            documents: z.number().int(),
          })
          .strict(),
      )
      .optional(),
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
    /**
     * L-06: los documentos y asientos concretos donde libro y mayor no dicen lo mismo
     * (`platform.book_ledger_discrepancies`). `document_id` nulo = un asiento de la cuenta de
     * IVA que ningún renglón del libro respalda. Opcional: campo nuevo y aditivo.
     */
    discrepancies: z
      .array(
        z
          .object({
            concepto: z.string(),
            document_id: uuid.nullable(),
            document_kind: z.string().nullable(),
            journal_entry_id: uuid.nullable(),
            entry_number: z.number().int().nullable(),
            libro: z.string(),
            mayor: z.string(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Los huecos de `accounting_coverage_gaps()` de la empresa: un documento posteado sin
     * asiento ni fila en cola. Es lo único que autoriza a la pantalla a decir que falta un
     * asiento. Opcional: campo nuevo y aditivo.
     */
    coverage_gaps: z
      .array(z.object({ source_kind: z.string(), source_id: uuid, problem: z.string() }).strict())
      .optional(),
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
    /** Solo en ventas y compras (B1): el resumen del art. 72 de esta generación y su fichero. */
    summary_content: z.string().optional(),
    summary_filename: z.string().optional(),
    /** ADR-0072 §6 (H4): avisos, p. ej. correcciones de comprobantes ya declarados fuera del TXT. */
    warnings: z.array(z.string()).optional(),
  })
  .strict();
export type ExportFiscalBookResponse = z.infer<typeof ExportFiscalBookResponse>;

/** El resumen del art. 72 de una generación del libro de ventas (H6, ADR-0073). */
export const ExportSalesBookSummaryRequest = z.object({ company_id: uuid }).strict();
export type ExportSalesBookSummaryRequest = z.infer<typeof ExportSalesBookSummaryRequest>;

export const ExportSalesBookSummaryResponse = z
  .object({
    run_id: uuid,
    /** El hash firmado de la generación: el mismo antes y después de pedir el resumen. */
    dataset_hash: z.string(),
    /** `resumen-art72.csv`: rótulo «RESUMEN (RLIVA art. 72)», cabeceras y filas. */
    content: z.string(),
    content_type: z.string(),
    filename: z.string(),
  })
  .strict();
export type ExportSalesBookSummaryResponse = z.infer<typeof ExportSalesBookSummaryResponse>;

export const ListFiscalBookRunsResponse = z
  .object({ runs: z.array(FiscalBookRunResponse) })
  .strict();
export type ListFiscalBookRunsResponse = z.infer<typeof ListFiscalBookRunsResponse>;
