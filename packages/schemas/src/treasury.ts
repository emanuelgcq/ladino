import { z } from "zod";
import { IvaRetentionFullReason, RetentionExclusionMark } from "./purchases.js";
import { ExpenseRecurrence } from "./recurring-expenses.js";

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
  "cashea",
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

/**
 * H-09 (recorrido 2026-09-24): LA FACTURA FISCAL DE UN GASTO. La luz, el teléfono, el alquiler:
 * una compra de servicio. Con este bloque el gasto se registra por el mismo camino que una
 * factura de proveedor —libro de compras, crédito fiscal (LIVA art. 33), retención del agente y
 * su comprobante— y se paga en el acto desde la cuenta. El RIF y la razón social son los del
 * proveedor. La persona escribe la BASE por alícuota tal como viene impresa; el IVA, el total,
 * lo retenido y lo que sale de la cuenta los calcula el servidor.
 */
export const ExpenseInvoice = z
  .object({
    supplier_id: uuid,
    document_number: z.string().trim().min(1).max(60),
    control_number: z.string().trim().min(1).max(60),
    invoice_date: z.string().date(),
    /**
     * LA MONEDA EN QUE VIENE IMPRESA LA FACTURA (por omisión, la funcional de la empresa). Las
     * bases van en ESTA moneda y así entran al libro de compras: lo impreso, no una conversión.
     * La cuenta de la que sale el dinero puede vivir en otra: el pago cruza a la tasa BCV del
     * día (ADR-0075 §3) y la vista previa dice cuánto sale.
     */
    currency: currency.optional(),
    /** Una línea por categoría tributaria de la factura: «gravado_general», «exento»… */
    lines: z
      .array(
        z
          .object({
            tax_category_code: z
              .string()
              .trim()
              .regex(/^[a-z][a-z0-9_]{0,39}$/),
            base: amount,
          })
          .strict(),
      )
      .min(1)
      .max(10),
    /** Solo la empresa agente: una exclusión del art. 3 de la PA SNAT/2025/000054, con motivo. */
    retention_exclusion: RetentionExclusionMark.optional(),
    /** Solo la empresa agente: el supuesto del art. 5 por el que se retiene el 100 %. */
    iva_retention_full_reason: IvaRetentionFullReason.optional(),
  })
  .strict();
export type ExpenseInvoice = z.infer<typeof ExpenseInvoice>;

export const RegisterExpenseRequest = z
  .object({
    company_id: uuid,
    /** Vocabulario de persona: «Alquiler», «Luz», «Nómina». Libre, con sugerencias. */
    category: z.string().trim().min(2).max(60),
    description: z.string().trim().min(1).max(500).optional(),
    /** La cuenta de la que SALIÓ el dinero. El importe va en SU moneda. */
    account_id: uuid,
    /**
     * Lo que salió de la cuenta. Obligatorio SIN factura fiscal. CON factura (`invoice`) no se
     * manda: lo calcula el servidor (total de la factura menos lo retenido), y mandar los dos
     * se rechaza. Lo exige el caso de uso, con su mensaje.
     */
    amount: amount.optional(),
    /** H-09: con este bloque, el gasto es una compra de servicio que va al libro de compras. */
    invoice: ExpenseInvoice.optional(),
    paid_at: z.string().datetime({ offset: true }).optional(),
    supplier_id: uuid.optional(),
    is_recurring: z.boolean().optional(),
    /**
     * H-07: cada cuánto se paga. Solo con `is_recurring: true`; sin él, cada mes (lo que la
     * pantalla prometía). Crea el recordatorio de esta categoría si no hay uno vivo.
     */
    recurrence: ExpenseRecurrence.optional(),
    /**
     * H-07, «registrar ahora»: este gasto ATIENDE el período `recurring_due_on` del
     * recordatorio. Van los dos o ninguno. Si ese período ya no es el que toca (segundo clic,
     * otra pestaña), 409 y NO se registra el gasto.
     */
    recurring_expense_id: uuid.optional(),
    recurring_due_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "día calendario YYYY-MM-DD")
      .optional(),
    branch_id: uuid.optional(),
    /** Ruta en el bucket `receipts`, si ya se subió el comprobante. */
    attachment_path: z.string().trim().min(3).max(300).optional(),
    /**
     * Confirmar EXPLÍCITAMENTE que la cuenta quede en negativo (ADR-0062 §4). Sin esto, un
     * egreso mayor que el saldo responde 409 INSUFFICIENT_FUNDS con el número delante.
     */
    allow_negative_balance: z.boolean().optional(),
    /**
     * D-11: POR QUÉ se deja la cuenta en negativo, en palabras de quien lo confirma. Obligatorio
     * (con el permiso `treasury.overdraft`) cuando el egreso sobregira de verdad; queda en el
     * acta `treasury.overdraft.confirmed`. El mínimo lo exige el caso de uso, con su mensaje.
     */
    overdraft_reason: z.string().trim().max(300).optional(),
  })
  .strict();
export type RegisterExpenseRequest = z.infer<typeof RegisterExpenseRequest>;

/** Mover dinero entre dos cuentas de la misma moneda (ADR-0062 §3, migración 61). */
export const CreateTreasuryTransferRequest = z
  .object({
    company_id: uuid,
    from_account_id: uuid,
    to_account_id: uuid,
    amount,
    /** Por qué se mueve: «repartir lo cobrado del día», «depósito en el banco». */
    reason: z.string().trim().min(3).max(300),
    /**
     * Confirmar EXPLÍCITAMENTE que la cuenta quede en negativo (ADR-0062 §4). Sin esto, un
     * egreso mayor que el saldo responde 409 INSUFFICIENT_FUNDS con el número delante.
     */
    allow_negative_balance: z.boolean().optional(),
    /**
     * D-11: POR QUÉ se deja la cuenta en negativo, en palabras de quien lo confirma. Obligatorio
     * (con el permiso `treasury.overdraft`) cuando el egreso sobregira de verdad; queda en el
     * acta `treasury.overdraft.confirmed`. El mínimo lo exige el caso de uso, con su mensaje.
     */
    overdraft_reason: z.string().trim().max(300).optional(),
  })
  .strict();
export type CreateTreasuryTransferRequest = z.infer<typeof CreateTreasuryTransferRequest>;

export const TreasuryTransferResponse = z
  .object({
    id: uuid,
    from_account_id: uuid,
    to_account_id: uuid,
    amount: z.string(),
    currency: z.string(),
    functional_amount: z.string(),
    functional_currency: z.string(),
    fx_rate: z.string(),
    reason: z.string(),
    transferred_at: z.string().datetime({ offset: true }),
    /** posted = asentado; queued = en la cola contable (ADR-0042). */
    accounting: z.enum(["posted", "queued"]),
    journal_entry_id: uuid.nullable(),
  })
  .strict();
export type TreasuryTransferResponse = z.infer<typeof TreasuryTransferResponse>;

export const ExpenseResponse = z
  .object({
    /**
     * H-07 (F9): el gasto venía marcado «se repite» y su categoría YA tenía un recordatorio vivo.
     * El gasto se registró; el recordatorio NO cambió: sigue con esta periodicidad y este próximo
     * día. Ausente en cualquier otro caso.
     */
    recurrence_kept: z
      .object({
        periodicity: ExpenseRecurrence,
        next_due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      })
      .strict()
      .optional(),
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
    /**
     * H-09: no nulo = el gasto tiene factura fiscal y ES esta factura de proveedor (`id` es el
     * mismo). `amount` es lo que salió de la cuenta: el total menos lo retenido.
     */
    supplier_invoice_id: uuid.nullable().optional(),
    /** H-09: las cifras de la factura del gasto, calculadas por el servidor. */
    invoice: z
      .object({
        document_number: z.string().nullable(),
        control_number: z.string().nullable(),
        invoice_date: z.string(),
        currency,
        subtotal_amount: z.string(),
        tax_amount: z.string(),
        total_amount: z.string(),
        retention_total: z.string(),
        retention_voucher_number: z.string().nullable(),
        /** true = el IVA es crédito fiscal y va al libro; false = fue al costo. */
        tax_is_recoverable: z.boolean(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
export type ExpenseResponse = z.infer<typeof ExpenseResponse>;

/**
 * LA VISTA PREVIA DE UN GASTO CON FACTURA (`POST /v1/expenses/preview`, H-09). El mismo caso de
 * uso que registra la factura, deshecho al terminar: lo que la pantalla enseña ANTES de
 * confirmar —base por categoría, impuesto, retención, total y lo que sale de la cuenta— son las
 * cifras que el registro escribiría. El pago también se ensaya: si la cuenta no alcanza, la
 * vista previa lo dice (`insufficient_funds`) SIN dejar de enseñar las cifras; el sobregiro se
 * confirma al registrar, con su permiso y su motivo (ADR-0062 §4).
 */
export const ExpensePreviewResponse = z
  .object({
    /** La moneda de la factura: en ella van las bases, el impuesto y el total. */
    currency,
    lines: z.array(
      z
        .object({
          tax_category_code: z.string(),
          base: z.string(),
          /** La alícuota como fracción («0.16000000»), del motor de impuestos. */
          tax_rate: z.string(),
          tax_amount: z.string(),
        })
        .strict(),
    ),
    subtotal_amount: z.string(),
    tax_amount: z.string(),
    total_amount: z.string(),
    /** Lo retenido, en la moneda FUNCIONAL (así se declara), y esa moneda. */
    retention_total: z.string(),
    retention_currency: currency,
    /** true = el impuesto es crédito fiscal y va al libro; false = va al costo. */
    tax_is_recoverable: z.boolean(),
    /** Lo que saldría de la cuenta, en la moneda DE LA CUENTA (`account_currency`). */
    amount: z.string(),
    account_currency: currency,
    /** Si el pago cruza monedas: la tasa BCV del día de la divisa a la funcional, y su fecha. */
    fx_rate: z.string().nullable(),
    fx_rate_currency: z.string().nullable(),
    fx_rate_date: z.string().nullable(),
    /** No nulo = la cuenta no alcanza: el mensaje del control de saldo (cuánto hay, cuánto sale). */
    insufficient_funds: z.string().nullable(),
  })
  .strict();
export type ExpensePreviewResponse = z.infer<typeof ExpensePreviewResponse>;

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
    /**
     * J-02: la caja estaba en NEGATIVO al cerrarla. Lo que la llevó a cero, en su moneda: no es
     * un sobrante, es dinero que puso el dueño (pasivo). Lo contado por encima de cero
     * (`counted_amount`) sí es sobrante. `null` si la caja no estaba en negativo.
     */
    owner_contribution: amount.nullable(),
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

/**
 * UNA CUENTA CANDIDATA (ADR-0067 §1): de dónde puede salir —o a dónde puede entrar— el dinero de
 * un instrumento concreto, en una moneda concreta.
 *
 * **Sin saldo, y es a propósito.** Elegir de qué cuenta sale el dinero no es «ver el dinero»: la
 * cajera que cobra y el encargado que paga una compra tienen que poder decir «salió de Mercantil»
 * sin que la pantalla les enseñe cuánto hay en Mercantil, que es lo que ADR-0048 reserva a
 * `treasury.read`. Es la misma frontera que ya se trazó con el catálogo de formas de pago.
 */
export const CandidateAccountResponse = z
  .object({
    id: uuid,
    name: z.string(),
    currency,
    kind: TreasuryAccountKind,
  })
  .strict();
export type CandidateAccountResponse = z.infer<typeof CandidateAccountResponse>;

export const CandidatesByInstrument = z
  .object({
    instrument: z.string(),
    currency,
    /**
     * En el MISMO orden en que el servidor las resolvería (ADR-0062 §1): la primera es la que
     * caería por omisión. La pantalla no la preselecciona —una preselección es la adivinanza con
     * un sello (ADR-0067 §1)—, pero el orden hace que la lista se lea de lo más probable a lo
     * menos.
     */
    accounts: z.array(CandidateAccountResponse),
    /** La cuenta que fija la forma de pago configurada, si hay una: entonces no se pregunta. */
    fixed_by_method: uuid.nullable(),
  })
  .strict();
export type CandidatesByInstrument = z.infer<typeof CandidatesByInstrument>;

export const ListCandidateAccountsResponse = z
  .object({ instruments: z.array(CandidatesByInstrument) })
  .strict();
export type ListCandidateAccountsResponse = z.infer<typeof ListCandidateAccountsResponse>;

/** Una fila del informe de ADR-0067 §4: dinero que cayó donde nadie eligió. */
export const MoneyLandingGapResponse = z
  .object({
    kind: z.string(),
    movement_id: uuid,
    occurred_on: z.string(),
    instrument: z.string().nullable(),
    amount,
    currency,
    account_id: uuid,
    account_name: z.string(),
    problem: z.enum(["sin_asignar", "familia_no_corresponde"]),
  })
  .strict();
export type MoneyLandingGapResponse = z.infer<typeof MoneyLandingGapResponse>;

export const ListMoneyLandingGapsResponse = z
  .object({ items: z.array(MoneyLandingGapResponse) })
  .strict();
export type ListMoneyLandingGapsResponse = z.infer<typeof ListMoneyLandingGapsResponse>;
