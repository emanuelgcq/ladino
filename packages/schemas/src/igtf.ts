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
  .object({ instrument: IgtfInstrument, causes: z.boolean() })
  .strict();
export type IgtfInstrumentResponse = z.infer<typeof IgtfInstrumentResponse>;

export const IgtfStatusResponse = z
  .object({
    enabled: z.boolean(),
    enabled_at: z.string().nullable(),
    /** La regla nacional vigente HOY (null si no hay ninguna cargada). */
    rate: z.string().nullable(),
    legal_source: z.string().nullable(),
    instruments: z.array(IgtfInstrumentResponse),
  })
  .strict();
export type IgtfStatusResponse = z.infer<typeof IgtfStatusResponse>;

/** Cambiar la clasificación fiscal de LA EMPRESA (cierra H-6). */
export const SetCompanyTaxpayerTypeRequest = z
  .object({
    company_id: uuid,
    taxpayer_type_code: z.enum(["ordinario", "especial", "formal", "no_sujeto", "no_domiciliado"]),
  })
  .strict();
export type SetCompanyTaxpayerTypeRequest = z.infer<typeof SetCompanyTaxpayerTypeRequest>;

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
  })
  .strict();
export type IgtfPerceptionResponse = z.infer<typeof IgtfPerceptionResponse>;

export const ListIgtfPerceptionsResponse = z
  .object({
    items: z.array(IgtfPerceptionResponse),
    /** Σ de lo PERCIBIDO (sin lo pendiente de reintegro), en funcional. */
    total_functional: z.string(),
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
