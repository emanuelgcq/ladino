import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { SkipRecurringExpenseRequest, StopRecurringExpenseRequest } from "@ladino/schemas";
import { listRecurringExpenses, skipRecurringExpense, stopRecurringExpense } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * Rutas del GASTO QUE SE REPITE (H-07). Capa delgada: validar → delegar → mapear.
 * «Registrar ahora» NO vive aquí: es `POST /v1/expenses` con `recurring_expense_id` y
 * `recurring_due_on`, la misma puerta que un gasto a mano.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function idDe(crudo: string): string {
  if (!UUID_RE.test(crudo)) {
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  return crudo;
}

function coherente(header: string, body: string): void {
  if (header !== body) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con el del header X-Company-Id.",
    });
  }
}

export function recurringExpenseRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  /** Los gastos que se repiten, con «toca» decidido por el servidor (permiso expense.read). */
  app.get("/v1/recurring-expenses", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listRecurringExpenses(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/recurring-expenses/:id/skip", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idDe(c.req.param("id"));
    const parsed = SkipRecurringExpenseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      skipRecurringExpense(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/recurring-expenses/:id/stop", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idDe(c.req.param("id"));
    const parsed = StopRecurringExpenseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      stopRecurringExpense(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}
