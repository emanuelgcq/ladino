import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type {
  ExpenseRecurrence,
  ExpenseResponse,
  ListRecurringExpensesResponse,
  RecurringExpenseResponse,
  RegisterExpenseRequest,
  SkipRecurringExpenseRequest,
  StopRecurringExpenseRequest,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope } from "./company-scope.js";
import { registerExpense, type TreasuryError } from "./treasury.js";
import { registerInvoicedExpense, type PurchaseError } from "./purchases.js";

/**
 * EL GASTO QUE SE REPITE (H-07, recorrido 2026-09-24; migración 20261005140000).
 *
 * El recordatorio NO registra dinero. Avisa cuando toca —`next_due_on` contra el día de Caracas,
 * los dos como DÍA calendario, calculado al leer: no hay tarea programada— y «registrar ahora»
 * pasa por la MISMA puerta que un gasto a mano (`registerExpense` o `registerInvoicedExpense`,
 * con sus validaciones de período, tasa, saldo y retención), con los datos precargados y el
 * importe confirmado por la persona.
 *
 * Idempotencia: el Idempotency-Key del intento acota la ventana; la clave natural la cierra. Un
 * período solo se atiende si es EL QUE TOCA (lo exige el trigger de `recurring_expense_periods`
 * bajo `FOR UPDATE`, y debajo su `unique`): el segundo clic recibe 409 y no registra otro gasto.
 */
export type RecurringExpenseError =
  TreasuryError | PurchaseError | { code: "CONFLICT"; message: string };

type Fila = Omit<RecurringExpenseResponse, "is_due" | "days_overdue"> & {
  is_due: boolean;
  days_overdue: number;
};

/** Los recordatorios vivos de la empresa, con «toca» decidido por el servidor. */
async function leer(
  sql: TransactionSql,
  companyId: string,
  id: string | null,
): Promise<{ today: string; items: Fila[] }> {
  // GRANULARIDAD: `date` contra `date`. «Hoy» es el día calendario de Caracas; `next_due_on` es
  // un día sin hora. Ningún instante entra en la comparación.
  const [h] = await sql<{ hoy: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as hoy`;
  const hoy = h!.hoy;
  const items = await sql<Fila[]>`
    select r.id, r.category, r.description, r.account_id, r.supplier_id,
           r.suggested_amount::text as suggested_amount, r.currency, r.with_invoice,
           r.periodicity, r.next_due_on::text as next_due_on, r.status,
           platform.recurring_due_after(r.anchor_date, r.periodicity, r.next_due_on)::text
             as following_due_on,
           (r.next_due_on <= ${hoy}::date) as is_due,
           greatest(${hoy}::date - r.next_due_on, 0)::int as days_overdue
      from public.recurring_expenses r
     where r.company_id = ${companyId}
       and (${id}::uuid is null and r.status = 'active' or r.id = ${id}::uuid)
     order by r.next_due_on, r.category`;
  return { today: hoy, items: [...items] };
}

export async function listRecurringExpenses(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<ListRecurringExpensesResponse, RecurringExpenseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver los gastos exige un usuario." });
  }
  // El aviso respeta `expense.read`: quien no ve los gastos no ve qué gasto toca.
  const scope = await companyScope(sql, actor.userId, companyId, "expense.read");
  if (!scope.ok) return scope;
  return ok(await leer(sql, companyId, null));
}

const YA_ATENDIDO =
  "Ese período ya se atendió (se registró u omitió). Revisa la lista de gastos antes de registrar otro.";
const YA_NO_SE_PAGA = "Ese recordatorio ya no se paga: no se le registran más períodos.";

/**
 * El recordatorio, bloqueado, y la comprobación de que `dueOn` es el período que toca. Va ANTES
 * de escribir nada: el segundo clic no llega a crear un gasto.
 */
async function exigePeriodoQueToca(
  sql: TransactionSql,
  companyId: string,
  recurringId: string,
  dueOn: string,
  /** La categoría del gasto que lo atiende; `null` al omitir (no hay gasto). */
  categoria: string | null,
): Promise<Result<{ tenantId: string }, RecurringExpenseError>> {
  const [r] = await sql<
    {
      tenant_id: string;
      status: string;
      category: string;
      es_el_que_toca: boolean;
      misma_categoria: boolean;
    }[]
  >`
    select r.tenant_id, r.status, r.category,
           (r.next_due_on = ${dueOn}::date) as es_el_que_toca,
           -- La MISMA normalización que el único de la tabla (lower + btrim).
           (${categoria}::text is null
             or lower(btrim(r.category)) = lower(btrim(${categoria}::text))) as misma_categoria
      from public.recurring_expenses r
     where r.id = ${recurringId} and r.company_id = ${companyId}
       for update`;
  if (!r) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (r.status !== "active") return err({ code: "CONFLICT", message: YA_NO_SE_PAGA });
  // Un gasto de «Luz» no atiende el período de «Alquiler» ni le cambia cuenta, proveedor e
  // importe sugerido: el recordatorio es de UNA categoría.
  if (!r.misma_categoria) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Ese aviso es de «${r.category}» y este gasto dice «${(categoria ?? "").trim()}». Regístralo desde su propio aviso o como un gasto aparte.`,
    });
  }
  if (!r.es_el_que_toca) return err({ code: "CONFLICT", message: YA_ATENDIDO });
  return ok({ tenantId: r.tenant_id });
}

async function acta(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  recurringId: string,
  evento: string,
  payload: Record<string, string | boolean | null>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'recurring_expense', ${recurringId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
}

/*
 * SIN `catch` de los errores de la base (55000 del trigger, 23505 del único, 23503). Un error de
 * Postgres CONDENA la transacción y `sql.begin` rechaza con el error original aunque el callback
 * lo capture (CLAUDE.md §3): un catch sin savepoint sería código muerto que parece funcionar. Y
 * no hay camino que llegue a ellos: `exigePeriodoQueToca` bloquea el recordatorio con
 * `FOR UPDATE` y el segundo intento espera, relee y recibe su 409 de ahí. El trigger y el único
 * son la defensa de la base: si alguna vez disparan, es un defecto de este fichero y sale como
 * lo que es (un 500), no disfrazado de «ya se atendió».
 */

/**
 * REGISTRAR UN GASTO — la puerta de `POST /v1/expenses`. Sin los campos de H-07 es exactamente
 * `registerExpense` / `registerInvoicedExpense`, sin una sola lectura más.
 *
 *   · `recurring_expense_id` + `recurring_due_on` («registrar ahora»): comprueba que el período
 *     es el que toca, registra el gasto por la puerta de siempre y deja el período atendido;
 *   · `is_recurring` a secas: registra el gasto y, si la categoría no tiene recordatorio vivo,
 *     lo crea con ancla en el día (de Caracas) del pago. Este gasto es su primer período.
 */
export async function registerExpenseWithRecurrence(
  uow: UnitOfWork,
  input: RegisterExpenseRequest,
): Promise<Result<ExpenseResponse, RecurringExpenseError>> {
  const { sql, actor } = uow;
  const {
    recurrence,
    recurring_expense_id: recurringId,
    recurring_due_on: dueOn,
    ...resto
  } = input;
  const atiende = recurringId !== undefined || dueOn !== undefined;

  if (atiende && (recurringId === undefined || dueOn === undefined)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Para registrar un gasto que toca van el recordatorio y su período, los dos.",
    });
  }
  if (recurrence !== undefined && resto.is_recurring !== true) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La periodicidad solo se indica en un gasto marcado como «se repite».",
    });
  }

  if (recurringId !== undefined && dueOn !== undefined) {
    if (actor.kind !== "user") {
      return err({ code: "PERMISSION_REQUIRED", message: "Registrar un gasto exige un usuario." });
    }
    // El permiso ANTES de mirar el recordatorio: sin él no se distingue «no existe» de «ya se
    // atendió».
    const scope = await companyScope(sql, actor.userId, input.company_id, "expense.register");
    if (!scope.ok) return scope;
    const toca = await exigePeriodoQueToca(
      sql,
      input.company_id,
      recurringId,
      dueOn,
      input.category,
    );
    if (!toca.ok) return toca;
  }

  // El gasto que atiende un período lleva la marca, como el primero.
  const cuerpo: RegisterExpenseRequest = atiende ? { ...resto, is_recurring: true } : resto;
  const registrado =
    cuerpo.invoice === undefined
      ? await registerExpense(uow, cuerpo)
      : await registerInvoicedExpense(uow, cuerpo);
  if (!registrado.ok) return registrado;
  if (!atiende && cuerpo.is_recurring !== true) return registrado;

  const gasto = registrado.value;
  const facturaId = gasto.supplier_invoice_id ?? null;
  const gastoId = facturaId === null ? gasto.id : null;
  // Lo que salió de la cuenta, como sugerencia para la próxima vez. Un gasto con factura
  // retenido entero no saca nada: sin importe no hay sugerencia (nunca un cero).
  const sale = /^0+(\.0+)?$/.test(gasto.amount) ? null : gasto.amount;

  {
    if (recurringId !== undefined && dueOn !== undefined) {
      const [r] = await sql<{ tenant_id: string }[]>`
        update public.recurring_expenses
           set account_id = ${gasto.account_id}, supplier_id = ${gasto.supplier_id},
               description = ${gasto.description},
               suggested_amount = ${sale}::numeric,
               currency = case when ${sale}::numeric is null then null else ${gasto.currency} end,
               with_invoice = ${facturaId !== null}
         where id = ${recurringId} and company_id = ${input.company_id}
        returning tenant_id`;
      if (!r) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
      await sql`
        insert into public.recurring_expense_periods
          (tenant_id, company_id, recurring_expense_id, due_on, outcome, expense_id,
           supplier_invoice_id)
        values (${r.tenant_id}, ${input.company_id}, ${recurringId}, ${dueOn}::date,
                'registered', ${gastoId}, ${facturaId})`;
      await acta(sql, r.tenant_id, input.company_id, recurringId, "recurring_expense.registered", {
        due_on: dueOn,
        expense_id: gastoId,
        supplier_invoice_id: facturaId,
      });
      return registrado;
    }

    // El primer gasto con la marca: nace el recordatorio, salvo que la categoría ya tenga uno
    // vivo (el único parcial). En ese caso NO se toca el que hay: un gasto a mano no atiende
    // períodos por su cuenta (decidido por criterio — la alternativa, atender en silencio el
    // período pendiente, movería el aviso sin que nadie lo pidiera).
    const [nuevo] = await sql<{ id: string; tenant_id: string; anchor: string }[]>`
      insert into public.recurring_expenses
        (tenant_id, company_id, category, description, account_id, supplier_id,
         suggested_amount, currency, with_invoice, periodicity, anchor_date, next_due_on)
      select c.tenant_id, c.id, ${gasto.category}, ${gasto.description}, ${gasto.account_id},
             ${gasto.supplier_id}, ${sale}::numeric,
             case when ${sale}::numeric is null then null else ${gasto.currency} end,
             ${facturaId !== null}, ${recurrence ?? "monthly"},
             -- El ancla es el DÍA de Caracas del pago: un día calendario, no un instante.
             (${gasto.paid_at}::timestamptz at time zone 'America/Caracas')::date,
             (${gasto.paid_at}::timestamptz at time zone 'America/Caracas')::date
        from public.companies c
       where c.id = ${input.company_id}
      on conflict (company_id, lower(btrim(category))) where status = 'active' do nothing
      returning id, tenant_id, anchor_date::text as anchor`;
    if (!nuevo) {
      // F9: la categoría ya tenía recordatorio vivo. El gasto se registra (no se pierde lo
      // tecleado) y la RESPUESTA lo dice: la periodicidad pedida no se aplicó, sigue la que había.
      const [vivo] = await sql<{ periodicity: ExpenseRecurrence; next_due_on: string }[]>`
        select r.periodicity, r.next_due_on::text as next_due_on
          from public.recurring_expenses r
         where r.company_id = ${input.company_id} and r.status = 'active'
           and lower(btrim(r.category)) = lower(btrim(${gasto.category}))`;
      return vivo === undefined ? registrado : ok({ ...gasto, recurrence_kept: vivo });
    }
    await sql`
      insert into public.recurring_expense_periods
        (tenant_id, company_id, recurring_expense_id, due_on, outcome, expense_id,
         supplier_invoice_id)
      values (${nuevo.tenant_id}, ${input.company_id}, ${nuevo.id}, ${nuevo.anchor}::date,
              'registered', ${gastoId}, ${facturaId})`;
    await acta(sql, nuevo.tenant_id, input.company_id, nuevo.id, "recurring_expense.created", {
      category: gasto.category,
      periodicity: recurrence ?? "monthly",
      anchor_date: nuevo.anchor,
      expense_id: gastoId,
      supplier_invoice_id: facturaId,
    });
    return registrado;
  }
}

/** «Omitir esta vez»: el período que toca queda atendido sin gasto. */
export async function skipRecurringExpense(
  uow: UnitOfWork,
  recurringId: string,
  input: SkipRecurringExpenseRequest,
): Promise<Result<RecurringExpenseResponse, RecurringExpenseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Omitir un gasto exige un usuario." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "expense.register");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const toca = await exigePeriodoQueToca(sql, input.company_id, recurringId, input.due_on, null);
  if (!toca.ok) return toca;
  await sql`
    insert into public.recurring_expense_periods
      (tenant_id, company_id, recurring_expense_id, due_on, outcome)
    values (${toca.value.tenantId}, ${input.company_id}, ${recurringId}, ${input.due_on}::date,
            'skipped')`;
  await acta(sql, toca.value.tenantId, input.company_id, recurringId, "recurring_expense.skipped", {
    due_on: input.due_on,
  });
  const { items } = await leer(sql, input.company_id, recurringId);
  return ok(items[0]!);
}

/** «Ya no se paga»: deja de avisar. Repetirlo no es un error. */
export async function stopRecurringExpense(
  uow: UnitOfWork,
  recurringId: string,
  input: StopRecurringExpenseRequest,
): Promise<Result<RecurringExpenseResponse, RecurringExpenseError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Dejar de avisar exige un usuario." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "expense.register");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [r] = await sql<{ tenant_id: string; status: string }[]>`
    select r.tenant_id, r.status from public.recurring_expenses r
     where r.id = ${recurringId} and r.company_id = ${input.company_id}
       for update`;
  if (!r) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (r.status === "active") {
    await sql`
      update public.recurring_expenses
         set status = 'stopped', stopped_at = now(), stopped_by = ${actor.userId}
       where id = ${recurringId} and company_id = ${input.company_id}`;
    await acta(sql, r.tenant_id, input.company_id, recurringId, "recurring_expense.stopped", {});
  }
  const { items } = await leer(sql, input.company_id, recurringId);
  return ok(items[0]!);
}
