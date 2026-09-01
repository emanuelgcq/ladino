import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CreateCompanyAccountRequest,
  UpdateCompanyAccountRequest,
  CreatePaymentMethodRequest,
  UpdatePaymentMethodRequest,
  RegisterExpenseRequest,
  CloseCashRegisterRequest,
  KeepDailyRateRequest,
} from "@ladino/schemas";
import {
  listCompanyAccounts,
  createCompanyAccount,
  updateCompanyAccount,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  registerExpense,
  closeCashRegister,
  keepDailyRate,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * Rutas de TESORERÍA (Fase C, migraciones 29–31): cuentas, formas de pago,
 * gastos, cierre de caja y la confirmación diaria de la tasa. Capa delgada:
 * validar → delegar al caso de uso → mapear. Cero reglas de negocio.
 */

function coherente(header: string, body: string): void {
  if (header !== body) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con el del header X-Company-Id.",
    });
  }
}

async function exigePermiso(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: string,
  quehacer: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `${quehacer} exige un usuario real.`,
    });
  }
  const [p] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, ${permiso}, ${companyId}) as ok`;
  if (!p?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `${quehacer} exige el permiso ${permiso}.`,
    });
  }
}

export function treasuryRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // ── Cuentas ───────────────────────────────────────────────────────────────
  app.get("/v1/treasury/accounts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listCompanyAccounts(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ accounts: r.value }, 200);
  });

  app.post("/v1/treasury/accounts", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateCompanyAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createCompanyAccount(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/treasury/accounts/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = UpdateCompanyAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    const r = await withTransaction(sql, actor, (uow) =>
      updateCompanyAccount(uow, id, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Formas de pago ────────────────────────────────────────────────────────
  app.get("/v1/payment-methods", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listPaymentMethods(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ methods: r.value }, 200);
  });

  app.post("/v1/payment-methods", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreatePaymentMethodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createPaymentMethod(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/payment-methods/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = UpdatePaymentMethodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const id = c.req.param("id");
    const r = await withTransaction(sql, actor, (uow) => updatePaymentMethod(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Gastos ────────────────────────────────────────────────────────────────
  app.post("/v1/expenses", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterExpenseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => registerExpense(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/expenses", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = c.req.query("from") ?? null;
    const hasta = c.req.query("to") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "expense.read", "Ver los gastos");
      const filas = await tx<Record<string, unknown>[]>`
        select id, category, description,
               to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
               account_id, amount_transaction_currency::text as amount,
               transaction_currency as currency, functional_amount::text as functional_amount,
               functional_currency, fx_rate::text as fx_rate, is_recurring, supplier_id,
               branch_id, attachment_path, journal_entry_id
          from public.expenses
         where company_id = ${companyId}
           and (${desde}::date is null or paid_at::date >= ${desde}::date)
           and (${hasta}::date is null or paid_at::date <= ${hasta}::date)
         order by paid_at desc
         limit 200`;
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.expenses
         where company_id = ${companyId}
           and (${desde}::date is null or paid_at::date >= ${desde}::date)
           and (${hasta}::date is null or paid_at::date <= ${hasta}::date)`;
      return { items: filas, total: total?.n ?? 0 };
    });
    return c.json(cuerpo, 200);
  });

  // ── Cierre de caja ────────────────────────────────────────────────────────
  app.post("/v1/cash-closings", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CloseCashRegisterRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => closeCashRegister(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/cash-closings", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "treasury.read", "Ver los cierres");
      const filas = await tx<Record<string, unknown>[]>`
        select cc.id, cc.account_id, cc.closing_date::text as closing_date,
               to_char(cc.closed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as closed_at,
               cc.expected_amount::text as expected_amount,
               cc.counted_amount::text as counted_amount,
               cc.amount_transaction_currency::text as difference, cc.reason,
               cc.transaction_currency as currency, cc.journal_entry_id
          from public.cash_closings cc
         where cc.company_id = ${companyId}
         order by cc.closed_at desc
         limit 200`;
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.cash_closings where company_id = ${companyId}`;
      return { items: filas, total: total?.n ?? 0 };
    });
    return c.json(cuerpo, 200);
  });

  // ── «La tasa sigue igual» ─────────────────────────────────────────────────
  app.post("/v1/exchange-rates/keep", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = KeepDailyRateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      keepDailyRate(uow, companyId, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });
}
