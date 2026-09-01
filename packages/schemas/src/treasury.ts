import { z } from "zod";

/**
 * Contratos de TESORERÍA (migraciones 29–31, Fase C).
 *
 * La cuenta es el concepto que la persona entiende: «¿dónde está mi dinero?»
 * — Caja Bs, Banesco, Zelle. Cada cobro ENTRA a una, cada pago y cada gasto
 * SALEN de una, y el cierre de caja las cuadra contra la gaveta. Todo importe
 * viaja como string decimal (regla 7).
 */
const uuid = z.string().uuid();
const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");
/** Importe con signo: la diferencia de un cierre puede ser negativa. */
const signedAmount = z
  .string()
  .regex(/^-?\d{1,16}(\.\d{1,8})?$/, "importe decimal con signo como string");
const currency = z.string().regex(/^[A-Z]{3}$/);

export const TreasuryAccountKind = z.enum(["cash", "bank", "wallet"]);
export type TreasuryAccountKind = z.infer<typeof TreasuryAccountKind>;

/** El MISMO vocabulario de payments.instrument, sin los que no mueven efectivo. */
export const PaymentMethodKind = z.enum([
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
export type PaymentMethodKind = z.infer<typeof PaymentMethodKind>;

export const CompanyAccountResponse = z
  .object({
    id: uuid,
    name: z.string(),
    currency,
    kind: TreasuryAccountKind,
    is_active: z.boolean(),
    /** Las «Sin asignar» del backfill: congeladas, se vacían redistribuyendo. */
    is_system: z.boolean(),
    /** El mapeo a la cuenta CONTABLE, si el contador lo puso. */
    ledger_account_id: uuid.nullable(),
    /** Saldo materializado EN LA MONEDA de la cuenta. */
    balance: amount.or(signedAmount),
  })
  .strict();
export type CompanyAccountResponse = z.infer<typeof CompanyAccountResponse>;

export const CreateCompanyAccountRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(2).max(80),
    currency,
    kind: TreasuryAccountKind,
    ledger_account_id: uuid.optional(),
  })
  .strict();
export type CreateCompanyAccountRequest = z.infer<typeof CreateCompanyAccountRequest>;

/**
 * La moneda NO se cambia: el dinero que ya está dentro no cambia de moneda
 * por editar una etiqueta. Una cuenta en la moneda equivocada se desactiva y
 * se crea bien.
 */
export const UpdateCompanyAccountRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(2).max(80).optional(),
    is_active: z.boolean().optional(),
    ledger_account_id: uuid.nullable().optional(),
  })
  .strict();
export type UpdateCompanyAccountRequest = z.infer<typeof UpdateCompanyAccountRequest>;

export const ListCompanyAccountsResponse = z
  .object({ accounts: z.array(CompanyAccountResponse) })
  .strict();
export type ListCompanyAccountsResponse = z.infer<typeof ListCompanyAccountsResponse>;

export const PaymentMethodResponse = z
  .object({
    id: uuid,
    name: z.string(),
    kind: PaymentMethodKind,
    account_id: uuid,
    is_active: z.boolean(),
  })
  .strict();
export type PaymentMethodResponse = z.infer<typeof PaymentMethodResponse>;

export const CreatePaymentMethodRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(2).max(80),
    kind: PaymentMethodKind,
    account_id: uuid,
  })
  .strict();
export type CreatePaymentMethodRequest = z.infer<typeof CreatePaymentMethodRequest>;

export const UpdatePaymentMethodRequest = z
  .object({
    company_id: uuid,
    name: z.string().trim().min(2).max(80).optional(),
    is_active: z.boolean().optional(),
    account_id: uuid.optional(),
  })
  .strict();
export type UpdatePaymentMethodRequest = z.infer<typeof UpdatePaymentMethodRequest>;

export const ListPaymentMethodsResponse = z
  .object({ methods: z.array(PaymentMethodResponse) })
  .strict();
export type ListPaymentMethodsResponse = z.infer<typeof ListPaymentMethodsResponse>;

/** Si el asiento salió directo o quedó en la cola de ADR-0042. Ambos correctos. */
export const AccountingOutcome = z.enum(["posted", "queued"]);
export type AccountingOutcome = z.infer<typeof AccountingOutcome>;

export const RegisterExpenseRequest = z
  .object({
    company_id: uuid,
    /** Vocabulario de persona: «Alquiler», «Luz», «Nómina». Libre, con sugerencias. */
    category: z.string().trim().min(2).max(60),
    description: z.string().trim().min(1).max(500).optional(),
    /** La cuenta de la que SALIÓ el dinero. El importe va en SU moneda. */
    account_id: uuid,
    amount,
    paid_at: z.string().datetime({ offset: true }).optional(),
    supplier_id: uuid.optional(),
    is_recurring: z.boolean().optional(),
    branch_id: uuid.optional(),
    /** Ruta en el bucket `receipts`, si ya se subió el comprobante. */
    attachment_path: z.string().trim().min(3).max(300).optional(),
  })
  .strict();
export type RegisterExpenseRequest = z.infer<typeof RegisterExpenseRequest>;

export const ExpenseResponse = z
  .object({
    id: uuid,
    category: z.string(),
    description: z.string().nullable(),
    paid_at: z.string(),
    account_id: uuid,
    amount: amount,
    currency,
    functional_amount: amount,
    functional_currency: currency,
    fx_rate: z.string(),
    is_recurring: z.boolean(),
    supplier_id: uuid.nullable(),
    branch_id: uuid.nullable(),
    attachment_path: z.string().nullable(),
    journal_entry_id: uuid.nullable(),
    accounting: AccountingOutcome,
  })
  .strict();
export type ExpenseResponse = z.infer<typeof ExpenseResponse>;

export const ListExpensesResponse = z
  .object({
    items: z.array(ExpenseResponse.omit({ accounting: true })),
    total: z.number().int(),
  })
  .strict();
export type ListExpensesResponse = z.infer<typeof ListExpensesResponse>;

export const CloseCashRegisterRequest = z
  .object({
    company_id: uuid,
    account_id: uuid,
    /** Lo que la persona CONTÓ. Lo esperado lo dice el servidor, nunca el cliente. */
    counted_amount: amount,
    /** Obligatorio cuando hay diferencia; el servidor lo exige, no la UI. */
    reason: z.string().trim().min(3).max(300).optional(),
    branch_id: uuid.optional(),
  })
  .strict();
export type CloseCashRegisterRequest = z.infer<typeof CloseCashRegisterRequest>;

export const CashClosingResponse = z
  .object({
    id: uuid,
    account_id: uuid,
    closing_date: z.string(),
    closed_at: z.string(),
    expected_amount: signedAmount,
    counted_amount: amount,
    /** Con signo: positiva = sobrante, negativa = faltante, cero = cuadró. */
    difference: signedAmount,
    reason: z.string().nullable(),
    currency,
    journal_entry_id: uuid.nullable(),
    /** `none` cuando la diferencia es cero: no hay hecho contable que asentar. */
    accounting: z.enum(["posted", "queued", "none"]),
  })
  .strict();
export type CashClosingResponse = z.infer<typeof CashClosingResponse>;

export const ListCashClosingsResponse = z
  .object({
    items: z.array(CashClosingResponse.omit({ accounting: true })),
    total: z.number().int(),
  })
  .strict();
export type ListCashClosingsResponse = z.infer<typeof ListCashClosingsResponse>;

/**
 * «Sigue igual»: confirma que la tasa de HOY es la misma de la última carga.
 * SIEMPRE crea una fila nueva con la fecha de hoy — reutilizar la vieja dejaría
 * indistinguible «nadie miró la tasa» de «se miró y no cambió».
 */
export const KeepDailyRateRequest = z
  .object({
    from_currency: currency,
    to_currency: currency,
  })
  .strict();
export type KeepDailyRateRequest = z.infer<typeof KeepDailyRateRequest>;

export const DailyRateResponse = z
  .object({
    from_currency: currency,
    to_currency: currency,
    rate: amount,
    rate_date: z.string(),
    source: z.string(),
  })
  .strict();
export type DailyRateResponse = z.infer<typeof DailyRateResponse>;
