import { z } from "zod";

/**
 * Contratos de contabilidad (migración 25, ADR-0041/0042/0043). Todo importe
 * viaja como STRING decimal — regla 7. Ninguna cuenta contable aparece escrita
 * aquí: las plantillas nombran PAPELES y las líneas manuales traen el id de la
 * cuenta que eligió el usuario.
 */
const uuid = z.string().uuid();
const amount = z
  .string()
  .regex(/^\d{1,16}(\.\d{1,8})?$/, "importe decimal como string: hasta 16 enteros y 8 decimales");
const currency = z.string().regex(/^[A-Z]{3}$/);

export const AccountKind = z.enum(["activo", "pasivo", "patrimonio", "ingreso", "gasto", "orden"]);
export const AccountNature = z.enum(["deudora", "acreedora"]);
export const EntryStatus = z.enum(["draft", "posted", "reversed"]);

export const CreateAccountRequest = z
  .object({
    company_id: uuid,
    code: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(500).optional(),
    parent_id: uuid.nullable().optional(),
    kind: AccountKind,
    /** Se DERIVA del tipo si no se manda; el esquema la comprueba igual. */
    nature: AccountNature.optional(),
    currency_code: currency.optional(),
    /** Si exige centro de costo, proyecto o tercero en cada línea. */
    requires_analytical: z.boolean().optional(),
  })
  .strict();
export type CreateAccountRequest = z.infer<typeof CreateAccountRequest>;

export const UpdateAccountRequest = z
  .object({
    company_id: uuid,
    /** Solo lo NO estructural. El código, el tipo y el padre no se tocan. */
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().min(1).max(500).nullable().optional(),
    requires_analytical: z.boolean().optional(),
  })
  .strict();
export type UpdateAccountRequest = z.infer<typeof UpdateAccountRequest>;

export const AccountResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    code: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    parent_id: uuid.nullable(),
    kind: AccountKind,
    nature: AccountNature,
    is_leaf: z.boolean(),
    is_active: z.boolean(),
    currency_code: z.string().nullable(),
    requires_analytical: z.boolean(),
    level: z.number().int(),
    path: z.string(),
  })
  .strict();
export type AccountResponse = z.infer<typeof AccountResponse>;

export const ImportChartTemplateRequest = z
  .object({
    company_id: uuid,
    template_code: z.string().trim().min(1).max(40),
    /**
     * Si además de las cuentas se aplican los papeles SUGERIDOS por la
     * plantilla. Por omisión sí: crear doscientas cuentas y dejar sin decir
     * cuál es la de IVA débito fiscal deja el trabajo difícil sin hacer.
     */
    apply_suggested_purposes: z.boolean().optional(),
  })
  .strict();
export type ImportChartTemplateRequest = z.infer<typeof ImportChartTemplateRequest>;

export const JournalLineRequest = z
  .object({
    account_id: uuid,
    /** Débito O crédito. Los dos, o ninguno, se rechaza. */
    debit: amount.optional(),
    credit: amount.optional(),
    currency: currency.optional(),
    description: z.string().trim().min(1).max(300).optional(),
    /** Centro de costo, proyecto, tercero. Objeto plano de strings. */
    analytical_dimensions: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type JournalLineRequest = z.infer<typeof JournalLineRequest>;

export const CreateJournalEntryRequest = z
  .object({
    company_id: uuid,
    posting_date: z.string().date(),
    description: z.string().trim().min(3).max(500),
    memo: z.string().trim().min(1).max(1000).optional(),
    lines: z.array(JournalLineRequest).min(2).max(500),
  })
  .strict();
export type CreateJournalEntryRequest = z.infer<typeof CreateJournalEntryRequest>;

export const PostJournalEntryRequest = z.object({ company_id: uuid }).strict();
export type PostJournalEntryRequest = z.infer<typeof PostJournalEntryRequest>;

export const ReverseJournalEntryRequest = z
  .object({
    company_id: uuid,
    reason: z.string().trim().min(3).max(500),
    /** Fecha del contra-asiento; por omisión, hoy. */
    posting_date: z.string().date().optional(),
  })
  .strict();
export type ReverseJournalEntryRequest = z.infer<typeof ReverseJournalEntryRequest>;

export const JournalLineResponse = z
  .object({
    id: uuid,
    line_number: z.number().int(),
    account_id: uuid,
    account_code: z.string(),
    account_name: z.string(),
    debit_amount: z.string(),
    credit_amount: z.string(),
    transaction_currency: z.string(),
    fx_rate: z.string(),
    functional_debit: z.string(),
    functional_credit: z.string(),
    functional_currency: z.string(),
    rate_source: z.string(),
    analytical_dimensions: z.record(z.string(), z.string()).nullable(),
    description: z.string().nullable(),
  })
  .strict();
export type JournalLineResponse = z.infer<typeof JournalLineResponse>;

export const JournalEntryResponse = z
  .object({
    id: uuid,
    company_id: uuid,
    period_id: uuid,
    entry_number: z.number().int().nullable(),
    posting_date: z.string(),
    source_kind: z.string(),
    source_id: uuid.nullable(),
    source_event: z.string().nullable(),
    description: z.string(),
    memo: z.string().nullable(),
    status: EntryStatus,
    posted_at: z.string().datetime({ offset: true }).nullable(),
    is_reversal_of: uuid.nullable(),
    reversed_by_entry_id: uuid.nullable(),
    rules_version: z.string().nullable(),
    total_debit: z.string(),
    total_credit: z.string(),
  })
  .strict();
export type JournalEntryResponse = z.infer<typeof JournalEntryResponse>;

export const JournalEntryDetailResponse = z
  .object({ entry: JournalEntryResponse, lines: z.array(JournalLineResponse) })
  .strict();
export type JournalEntryDetailResponse = z.infer<typeof JournalEntryDetailResponse>;

export const ListJournalEntriesResponse = z
  .object({ items: z.array(JournalEntryResponse), total: z.number().int().nonnegative() })
  .strict();
export type ListJournalEntriesResponse = z.infer<typeof ListJournalEntriesResponse>;

export const LedgerResponse = z
  .object({
    account_id: uuid,
    account_code: z.string(),
    account_name: z.string(),
    nature: AccountNature,
    currency: z.string(),
    opening_balance: z.string(),
    closing_balance: z.string(),
    movements: z.array(
      z
        .object({
          entry_id: uuid,
          entry_number: z.number().int().nullable(),
          posting_date: z.string(),
          description: z.string(),
          debit: z.string(),
          credit: z.string(),
          running_balance: z.string(),
          source_kind: z.string(),
          source_id: uuid.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
export type LedgerResponse = z.infer<typeof LedgerResponse>;

export const TrialBalanceResponse = z
  .object({
    /** La fecha es PARÁMETRO, nunca «hoy»: un balance irreproducible no cierra un mes. */
    as_of: z.string(),
    from_date: z.string().nullable(),
    currency: z.string(),
    rows: z.array(
      z
        .object({
          account_id: uuid,
          account_code: z.string(),
          account_name: z.string(),
          nature: AccountNature,
          opening_balance: z.string(),
          period_debit: z.string(),
          period_credit: z.string(),
          closing_balance: z.string(),
        })
        .strict(),
    ),
    total_debit: z.string(),
    total_credit: z.string(),
    balanced: z.boolean(),
  })
  .strict();
export type TrialBalanceResponse = z.infer<typeof TrialBalanceResponse>;

export const FiscalPeriodResponse = z
  .object({
    id: uuid,
    year: z.number().int(),
    month: z.number().int(),
    status: z.string(),
    closed_at: z.string().datetime({ offset: true }).nullable(),
    reopened_at: z.string().datetime({ offset: true }).nullable(),
    reopened_reason: z.string().nullable(),
    /** Lo que impide cerrar: borradores y pendientes de contabilizar. */
    draft_entry_count: z.number().int().nonnegative(),
    pending_queue_count: z.number().int().nonnegative(),
  })
  .strict();
export type FiscalPeriodResponse = z.infer<typeof FiscalPeriodResponse>;

export const ClosePeriodRequest = z.object({ company_id: uuid }).strict();
export type ClosePeriodRequest = z.infer<typeof ClosePeriodRequest>;

export const ReopenPeriodRequest = z
  .object({
    company_id: uuid,
    /** OBLIGATORIO y con longitud mínima: «error» no es una justificación. */
    reason: z.string().trim().min(10).max(500),
  })
  .strict();
export type ReopenPeriodRequest = z.infer<typeof ReopenPeriodRequest>;

export const YearEndCloseRequest = z
  .object({ company_id: uuid, year: z.number().int().min(2000).max(2200) })
  .strict();
export type YearEndCloseRequest = z.infer<typeof YearEndCloseRequest>;

export const SetAccountPurposeRequest = z
  .object({ company_id: uuid, purpose: z.string().trim().min(1).max(50), account_id: uuid })
  .strict();
export type SetAccountPurposeRequest = z.infer<typeof SetAccountPurposeRequest>;

export const CreateJournalTemplateRequest = z
  .object({
    company_id: uuid,
    source_kind: z.string().trim().min(1).max(40),
    source_event: z.string().trim().min(1).max(60),
    description: z.string().trim().min(3).max(500),
    lines: z
      .array(
        z
          .object({
            account_purpose: z.string().trim().min(1).max(50),
            amount_source: z.enum([
              "subtotal",
              "tax_amount",
              "total",
              "retained_iva",
              "retained_islr",
              "retained_total",
              "net_amount",
              "cost_amount",
              "landed_to_inventory",
              "landed_to_variance",
              "exchange_difference",
              "functional_amount",
            ]),
            side: z.enum(["debit", "credit"]),
            condition_kind: z
              .enum([
                "always",
                "if_amount_nonzero",
                "if_tax_recoverable",
                "if_tax_not_recoverable",
                "if_supplier_foreign",
                "if_supplier_national",
                "if_positive",
                "if_negative",
              ])
              .optional(),
            description: z.string().trim().min(1).max(300).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(50),
  })
  .strict();
export type CreateJournalTemplateRequest = z.infer<typeof CreateJournalTemplateRequest>;

export const PendingJournalResponse = z
  .object({
    items: z.array(
      z
        .object({
          id: uuid,
          source_kind: z.string(),
          source_id: uuid,
          source_event: z.string(),
          reason: z.string(),
          created_at: z.string().datetime({ offset: true }),
        })
        .strict(),
    ),
    total: z.number().int().nonnegative(),
  })
  .strict();
export type PendingJournalResponse = z.infer<typeof PendingJournalResponse>;

export const IncomeStatementResponse = z
  .object({
    from_date: z.string(),
    to_date: z.string(),
    currency: z.string(),
    income: z.array(
      z.object({ account_code: z.string(), account_name: z.string(), amount: z.string() }).strict(),
    ),
    expenses: z.array(
      z.object({ account_code: z.string(), account_name: z.string(), amount: z.string() }).strict(),
    ),
    total_income: z.string(),
    total_expenses: z.string(),
    result: z.string(),
  })
  .strict();
export type IncomeStatementResponse = z.infer<typeof IncomeStatementResponse>;

export const BalanceSheetResponse = z
  .object({
    as_of: z.string(),
    currency: z.string(),
    assets: z.array(
      z.object({ account_code: z.string(), account_name: z.string(), amount: z.string() }).strict(),
    ),
    liabilities: z.array(
      z.object({ account_code: z.string(), account_name: z.string(), amount: z.string() }).strict(),
    ),
    equity: z.array(
      z.object({ account_code: z.string(), account_name: z.string(), amount: z.string() }).strict(),
    ),
    total_assets: z.string(),
    total_liabilities: z.string(),
    total_equity: z.string(),
    /** activo == pasivo + patrimonio. Si es falso, hay un asiento roto. */
    balanced: z.boolean(),
  })
  .strict();
export type BalanceSheetResponse = z.infer<typeof BalanceSheetResponse>;
