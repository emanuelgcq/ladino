import { z } from "zod";

/**
 * Contratos de IGTF — percepción para sujetos pasivos ESPECIALES
 * (migración 46, G.O. Ext. 6.687 + PA SNAT/2022/000013).
 *
 * La percepción es POR PAGO y se calcula en el SERVIDOR: 3 % sobre el importe
 * de cada pago en divisa cuyo instrumento causa. La activación es un acto con
 * acta, solo para empresas clasificadas `especial`. Qué instrumento causa es
 * DATO editable por empresa, sembrado con un default conservador al activar
 * (H-8: sin regla de exención SE PERCIBE; el instrumento `otro`, al revés,
 * por defecto NO causa — puede ser un pago en bolívares con otro nombre).
 */
const uuid = z.string().uuid();

/** Los instrumentos que PUEDEN causar IGTF: los de dinero real. Ni saldo a
 *  favor ni retención — aplicar un papel no es un movimiento en divisa. */
export const IgtfInstrument = z.enum([
  "efectivo_bs",
  "efectivo_usd",
  "zelle",
  "usdt",
  "transferencia",
  "punto_venta",
  "pago_movil",
  "tarjeta",
  "cashea",
  "otro",
]);
export type IgtfInstrument = z.infer<typeof IgtfInstrument>;

export const EnableIgtfRequest = z
  .object({
    company_id: uuid,
    /** El acta: por qué esta empresa percibe desde hoy (su designación SPE). */
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type EnableIgtfRequest = z.infer<typeof EnableIgtfRequest>;

export const SetIgtfInstrumentRequest = z
  .object({
    company_id: uuid,
    instrument: IgtfInstrument,
    causes: z.boolean(),
  })
  .strict();
export type SetIgtfInstrumentRequest = z.infer<typeof SetIgtfInstrumentRequest>;

export const IgtfInstrumentResponse = z
  .object({
    instrument: IgtfInstrument,
    causes: z.boolean(),
    /** Re-revisión 8 (aditivo): la fuente de la clasificación (PA SNAT/2022/000013 art. 1, o «por criterio»). */
    legal_source: z.string().nullable().optional(),
  })
  .strict();
export type IgtfInstrumentResponse = z.infer<typeof IgtfInstrumentResponse>;

export const IgtfStatusResponse = z
  .object({
    /** El acta de activación (histórico). Ya NO gobierna la percepción: ver `perceiving`. */
    enabled: z.boolean(),
    enabled_at: z.string().nullable(),
    /**
     * E-02 (aditivo): la empresa percibe HOY porque su tipo vigente hoy es «especial». Ningún
     * interruptor la apaga: el hecho imponible es el pago en divisas a un SPE (LIGTF art. 4.6).
     */
    perceiving: z.boolean(),
    /** F-05 (aditivo): la empresa asume el IGTF (`absorb_igtf` de los ajustes). */
    absorbs: z.boolean(),
    /**
     * L-15 (aditivo): la quincena EN CURSO (día de Caracas), calculada en el servidor por el mes
     * calendario: 1–15 y 16–último. La fecha de VENCIMIENTO no está aquí: viene del calendario
     * de la PA SNAT/2025/000091 (L-09), que siembra otra familia.
     */
    fortnight: z
      .object({
        from: z.string().date(),
        to: z.string().date(),
        /**
         * El vencimiento, del calendario de la PA SNAT/2025/000091 (`platform.tax_due_date`):
         * `secondary_source` con fecha; `pending_review` con la fecha en null (celda pendiente de
         * cotejo, no se ofrece); `not_available` si no hay calendario para esa quincena o la
         * empresa no es especial al cierre.
         */
        due: z
          .object({
            date: z.string().date().nullable(),
            status: z.enum(["secondary_source", "pending_review", "not_available"]),
            legal_source: z.string().nullable(),
          })
          .strict(),
      })
      .strict(),
    /** La regla nacional vigente HOY (null si no hay ninguna cargada). */
    rate: z.string().nullable(),
    legal_source: z.string().nullable(),
    instruments: z.array(IgtfInstrumentResponse),
  })
  .strict();
export type IgtfStatusResponse = z.infer<typeof IgtfStatusResponse>;

/**
 * Declarar el tipo de contribuyente de LA EMPRESA (ADR-0072 §1; A-03, B-07). Cada declaración
 * abre una VIGENCIA nueva en una historia append-only, con acta: nunca sobrescribe.
 *   · `especial` exige `notified_on` (notificación de la providencia de calificación); por
 *     omisión rige desde ese día, y `effective_from` recoge otra fecha si la providencia la dice;
 *   · los demás no llevan notificación; por omisión rigen desde el inicio de actividades si es la
 *     primera declaración, y desde hoy si cambia una anterior.
 * `formal` se acepta en el contrato; la pantalla lo oculta mientras la periodicidad de la
 * PA 1677 esté pendiente de fuente (P-38).
 */
export const CompanyTaxpayerTypeCode = z.enum([
  "ordinario",
  "especial",
  "formal",
  "no_contribuyente",
]);
export const SetCompanyTaxpayerTypeRequest = z
  .object({
    company_id: uuid,
    taxpayer_type_code: CompanyTaxpayerTypeCode,
    notified_on: z.string().date().optional(),
    effective_from: z.string().date().optional(),
    /** El acta: por qué se declara o se cambia. */
    reason: z.string().trim().min(3).max(500),
  })
  .strict()
  .refine((v) => v.taxpayer_type_code !== "especial" || v.notified_on !== undefined, {
    message: "el contribuyente especial exige la fecha de notificación de la providencia",
    path: ["notified_on"],
  })
  .refine((v) => v.taxpayer_type_code === "especial" || v.notified_on === undefined, {
    message: "la fecha de notificación es solo de la calificación como contribuyente especial",
    path: ["notified_on"],
  });
export type SetCompanyTaxpayerTypeRequest = z.infer<typeof SetCompanyTaxpayerTypeRequest>;

/** Una vigencia del tipo de contribuyente. */
export const CompanyTaxpayerTypePeriod = z
  .object({
    id: uuid,
    taxpayer_type_code: CompanyTaxpayerTypeCode,
    effective_from: z.string().date(),
    notified_on: z.string().date().nullable(),
    reason: z.string(),
    created_at: z.string(),
  })
  .strict();
export type CompanyTaxpayerTypePeriod = z.infer<typeof CompanyTaxpayerTypePeriod>;

/** La declaración, como quedó. */
export const SetCompanyTaxpayerTypeResponse = z
  .object({
    taxpayer_type_code: CompanyTaxpayerTypeCode,
    effective_from: z.string().date(),
    notified_on: z.string().date().nullable(),
    igtf_disabled: z.boolean(),
    /** Documentos fiscales ya emitidos desde `effective_from` (declaración retroactiva). */
    documents_issued_since: z.number().int(),
    /** El aviso, si los hay: no se reemiten; consultar al asesor. */
    retroactive_warning: z.string().nullable(),
  })
  .strict();
export type SetCompanyTaxpayerTypeResponse = z.infer<typeof SetCompanyTaxpayerTypeResponse>;

/** El tipo vigente HOY (null: con RIF y sin declarar — no se factura) y la historia entera. */
export const CompanyTaxpayerTypeResponse = z
  .object({
    today: z.string().date(),
    current: z
      .object({
        taxpayer_type_code: CompanyTaxpayerTypeCode,
        effective_from: z.string().date().nullable(),
        notified_on: z.string().date().nullable(),
      })
      .strict()
      .nullable(),
    history: z.array(CompanyTaxpayerTypePeriod),
    /** Con `?effective_from=`: documentos fiscales emitidos desde esa fecha; si no, null. */
    documents_issued_since: z.number().int().nullable(),
  })
  .strict();
export type CompanyTaxpayerTypeResponse = z.infer<typeof CompanyTaxpayerTypeResponse>;

export const IgtfPerceptionResponse = z
  .object({
    id: uuid,
    payment_id: uuid,
    document_id: uuid,
    base_amount: z.string(),
    currency: z.string(),
    rate: z.string(),
    amount: z.string(),
    functional_amount: z.string(),
    fx_rate: z.string(),
    rate_source: z.string(),
    status: z.enum(["percibido", "pendiente_reintegro"]),
    status_reason: z.string().nullable(),
    occurred_at: z.string(),
    /** F-05 (aditivo): la asumió la empresa. */
    absorbed: z.boolean(),
    /** E-03 (aditivo): la ND por IGTF que la documenta, si el cobro fue posterior a la factura. */
    debit_note_id: uuid.nullable(),
  })
  .strict();
export type IgtfPerceptionResponse = z.infer<typeof IgtfPerceptionResponse>;

export const ListIgtfPerceptionsResponse = z
  .object({
    items: z.array(IgtfPerceptionResponse),
    /** Cuantas hay EN TOTAL (paginado): distinto de las que vinieron. */
    total: z.number().int().nonnegative(),
    /**
     * El total del período, en funcional (platform.igtf_period_totals): lo percibido vigente MÁS
     * lo percibido cuyo cobro se reversó DESPUÉS del fin de la quincena DE LA PERCEPCIÓN
     * (20261003230000; no del `to` de la consulta) — ya se declaró y no se
     * rebaja: se recupera por reintegro (PA SNAT/2022/000013 art. 4). Lo reversado dentro del
     * período no cuenta.
     */
    total_functional: z.string(),
    /** De ese total, cuánto está pendiente de reintegro (reversado después del período). */
    pending_refund_functional: z.string().optional(),
    pending_refund_count: z.number().int().nonnegative().optional(),
    functional_currency: z.string(),
  })
  .strict();
export type ListIgtfPerceptionsResponse = z.infer<typeof ListIgtfPerceptionsResponse>;

/** El aviso en vivo del COBRAR, antes de confirmar: puro cálculo del servidor. */
export const PosIgtfPreviewResponse = z
  .object({
    /** false = este pago no causaría (empresa sin activar, instrumento que no
     *  causa, o moneda funcional). Con false, rate y amount van en null. */
    applies: z.boolean(),
    rate: z.string().nullable(),
    base: z.string(),
    currency: z.string(),
    /** Lo que se percibe, en la MONEDA del pago. */
    amount: z.string().nullable(),
  })
  .strict();
export type PosIgtfPreviewResponse = z.infer<typeof PosIgtfPreviewResponse>;
