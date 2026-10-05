import { z } from "zod";

/**
 * Contratos del GASTO QUE SE REPITE (H-07, migración 20261005140000).
 *
 * El recordatorio no registra dinero: avisa cuando toca y precarga el formulario de siempre.
 * «Toca» es el día de Caracas contra `next_due_on`, los dos como DÍA calendario (`YYYY-MM-DD`),
 * sin hora: lo decide el servidor al leer. Todo importe viaja como string decimal (regla 7).
 */
const uuid = z.string().uuid();
const dia = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "día calendario YYYY-MM-DD");

/**
 * Cada cuánto se paga. `semimonthly` = dos veces al mes («cada quincena»): el día del primer
 * pago y quince días después, y los mismos dos días de cada mes siguiente.
 */
export const ExpenseRecurrence = z.enum(["weekly", "semimonthly", "monthly", "yearly"]);
export type ExpenseRecurrence = z.infer<typeof ExpenseRecurrence>;

export const RecurringExpenseResponse = z
  .object({
    id: uuid,
    category: z.string(),
    description: z.string().nullable(),
    /** De qué cuenta salió la última vez. Sugerencia: la persona la confirma. */
    account_id: uuid.nullable(),
    supplier_id: uuid.nullable(),
    /** Lo que salió de la cuenta la última vez, en `currency`. Sugerencia, nunca un cargo. */
    suggested_amount: z.string().nullable(),
    currency: z.string().nullable(),
    /** La última vez se registró con factura fiscal: la pantalla abre por esa rama. */
    with_invoice: z.boolean(),
    periodicity: ExpenseRecurrence,
    /** El próximo día que toca (día calendario de Caracas). */
    next_due_on: dia,
    /** El período que vendría después de `next_due_on`: adonde pasa el aviso si este se omite. */
    following_due_on: dia,
    /** `next_due_on` ya llegó: hoy (Caracas) es ese día o uno posterior. Lo dice el servidor. */
    is_due: z.boolean(),
    /** Días calendario de atraso; 0 si toca hoy o todavía no toca. */
    days_overdue: z.number().int(),
    status: z.enum(["active", "stopped"]),
  })
  .strict();
export type RecurringExpenseResponse = z.infer<typeof RecurringExpenseResponse>;

export const ListRecurringExpensesResponse = z
  .object({
    /** El día de Caracas contra el que se decidió `is_due`. */
    today: dia,
    items: z.array(RecurringExpenseResponse),
  })
  .strict();
export type ListRecurringExpensesResponse = z.infer<typeof ListRecurringExpensesResponse>;

/** «Omitir esta vez»: el período que toca queda atendido sin gasto y el aviso pasa al siguiente. */
export const SkipRecurringExpenseRequest = z
  .object({
    company_id: uuid,
    /** El período que la persona vio en pantalla. Si ya no es el que toca, 409. */
    due_on: dia,
  })
  .strict();
export type SkipRecurringExpenseRequest = z.infer<typeof SkipRecurringExpenseRequest>;

/** «Ya no se paga»: el recordatorio deja de avisar. Los gastos ya registrados no se tocan. */
export const StopRecurringExpenseRequest = z.object({ company_id: uuid }).strict();
export type StopRecurringExpenseRequest = z.infer<typeof StopRecurringExpenseRequest>;
