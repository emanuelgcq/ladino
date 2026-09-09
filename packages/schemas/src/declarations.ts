import { z } from "zod";
import { RegisterPaymentResponse } from "./sales.js";

/**
 * Contratos de DECLARACIONES DE IVA (migración 46).
 *
 * Tres piezas: las retenciones SOPORTADAS (las que un cliente-agente nos
 * practicó — se transcriben, no se calculan), el RESULTADO del período con su
 * arrastre encadenado, y el CALENDARIO de vencimientos cargable como dato.
 *
 * Todo importe viaja como string decimal (regla 7). Ninguna cifra que aquí
 * aparezca es una declaración oficial: la pantalla lo dice y el contrato
 * también — la planilla demostrativa es NO OFICIAL hasta validar el mapeo de
 * casillas con el asesor (PENDIENTES_ASESOR.md).
 */
const uuid = z.string().uuid();
const fecha = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "fecha como YYYY-MM-DD");
const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");
/** Un agregado que PUEDE ser negativo (débitos con más NC que ventas). */
const amountSigned = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,8})?$/, "importe decimal como string, con signo");
/** Una fracción (0, 1]: la porción retenida (0.75 o 1.00) o la prorrata. */
const fraction = z
  .string()
  .regex(/^(0(\.\d{1,8})?|1(\.0{1,8})?)$/, "fracción decimal como string, entre 0 y 1");

// ── Retenciones soportadas ──────────────────────────────────────────────────

/**
 * Registrar el comprobante que el agente nos entregó Y abonar la factura
 * afectada en el mismo acto: el comprobante ES el instrumento de abono
 * (`retencion_iva`, sin cuenta de efectivo). Todo se TRANSCRIBE del papel:
 * la porción retenida es dato del comprobante, no una regla que se resuelve.
 */
export const RegisterSupportedRetentionRequest = z
  .object({
    company_id: uuid,
    /** El AGENTE que retuvo: un cliente nuestro (sujeto pasivo especial). */
    customer_id: uuid,
    /** La factura NUESTRA afectada por la retención. */
    document_id: uuid,
    /** El número del comprobante TAL COMO EL AGENTE LO EMITIÓ. */
    receipt_number: z.string().trim().min(1).max(40),
    /** Cuándo nos retuvieron: la fecha que asigna la retención a su período. */
    retained_on: fecha,
    base: amount.refine((v) => /[1-9]/.test(v), "la base debe ser mayor que cero"),
    /** La porción retenida como fracción: 0.75 o 1.00, transcrita. */
    rate: fraction.refine((v) => /[1-9]/.test(v), "la porción retenida debe ser mayor que cero"),
    amount: amount.refine((v) => /[1-9]/.test(v), "el monto retenido debe ser mayor que cero"),
  })
  .strict();
export type RegisterSupportedRetentionRequest = z.infer<typeof RegisterSupportedRetentionRequest>;

export const SupportedRetentionResponse = z
  .object({
    id: uuid,
    customer_id: uuid,
    document_id: uuid,
    receipt_number: z.string(),
    retained_on: fecha,
    base: z.string(),
    rate: z.string(),
    amount: z.string(),
    functional_currency: z.string(),
    status: z.enum(["registered", "annulled"]),
    annul_reason: z.string().nullable(),
    created_at: z.string(),
  })
  .strict();
export type SupportedRetentionResponse = z.infer<typeof SupportedRetentionResponse>;

/** El comprobante registrado y el abono que produjo, juntos: fue UN acto. */
export const RegisterSupportedRetentionResponse = z
  .object({
    retention: SupportedRetentionResponse,
    payment: RegisterPaymentResponse,
  })
  .strict();
export type RegisterSupportedRetentionResponse = z.infer<typeof RegisterSupportedRetentionResponse>;

export const ListSupportedRetentionsResponse = z
  .object({ items: z.array(SupportedRetentionResponse) })
  .strict();
export type ListSupportedRetentionsResponse = z.infer<typeof ListSupportedRetentionsResponse>;

// ── Resultado del período IVA ───────────────────────────────────────────────

/**
 * Generar el resultado de UN período. El arrastre viene ENCADENADO: el
 * excedente anterior sale de la última generación del período contiguo
 * anterior, nunca de un número tecleado — y por eso los períodos en cero
 * también se generan (mantienen viva la cadena).
 */
export const GenerateIvaPeriodRequest = z
  .object({
    company_id: uuid,
    period_from: fecha,
    period_to: fecha,
  })
  .strict();
export type GenerateIvaPeriodRequest = z.infer<typeof GenerateIvaPeriodRequest>;

/** El desglose por alícuota que pinta la pantalla, desde los snapshots. */
export const IvaPeriodDetalleAlicuota = z
  .object({
    alicuota: z.string(),
    base: z.string(),
    impuesto: z.string(),
  })
  .strict();
export type IvaPeriodDetalleAlicuota = z.infer<typeof IvaPeriodDetalleAlicuota>;

export const IvaPeriodResultResponse = z
  .object({
    id: uuid,
    period_from: fecha,
    period_to: fecha,
    /** PUEDE ser negativo: un período con más notas de crédito que ventas. */
    debitos: amountSigned,
    creditos: z.string(),
    creditos_deducibles: z.string(),
    /** Solo cuando hubo ventas sin impuesto en el período (prorrata global v1). */
    prorrata_pct: z.string().nullable(),
    retenciones_soportadas: z.string(),
    excedente_anterior: z.string(),
    cuota_a_pagar: z.string(),
    excedente_siguiente: z.string(),
    detalle: z.array(IvaPeriodDetalleAlicuota),
    generator_version: z.string(),
    dataset_hash: z.string().regex(/^[0-9a-f]{64}$/),
    created_by: uuid.nullable(),
    created_at: z.string(),
  })
  .strict();
export type IvaPeriodResultResponse = z.infer<typeof IvaPeriodResultResponse>;

export const ListIvaPeriodResultsResponse = z
  .object({ items: z.array(IvaPeriodResultResponse) })
  .strict();
export type ListIvaPeriodResultsResponse = z.infer<typeof ListIvaPeriodResultsResponse>;

// ── Calendario de vencimientos (cargable como DATO) ─────────────────────────

export const FiscalObligation = z.enum(["iva", "igtf", "ret_iva", "islr"]);
export type FiscalObligation = z.infer<typeof FiscalObligation>;

const deadlineInput = z
  .object({
    obligation: FiscalObligation,
    period_from: fecha,
    period_to: fecha,
    due_date: fecha,
    /** La providencia o gaceta de la que sale la fecha. Sin fuente no se carga. */
    legal_source: z.string().trim().min(10).max(500),
  })
  .strict();

/**
 * Cargar el calendario. Es un REEMPLAZO por (obligación, período): cargar dos
 * veces la misma quincena corrige, no duplica. Las fechas por dígito de RIF
 * NO están en el repositorio y no se inventan (H-4): las trae quien las leyó
 * en la providencia, con la cita.
 */
export const LoadFiscalDeadlinesRequest = z
  .object({
    company_id: uuid,
    deadlines: z.array(deadlineInput).min(1).max(200),
  })
  .strict();
export type LoadFiscalDeadlinesRequest = z.infer<typeof LoadFiscalDeadlinesRequest>;

export const FiscalDeadlineResponse = z
  .object({
    id: uuid,
    obligation: FiscalObligation,
    period_from: fecha,
    period_to: fecha,
    due_date: fecha,
    legal_source: z.string(),
  })
  .strict();
export type FiscalDeadlineResponse = z.infer<typeof FiscalDeadlineResponse>;

export const ListFiscalDeadlinesResponse = z
  .object({ items: z.array(FiscalDeadlineResponse) })
  .strict();
export type ListFiscalDeadlinesResponse = z.infer<typeof ListFiscalDeadlinesResponse>;
