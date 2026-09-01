import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal } from "@ladino/money";
import type {
  CreateCompanyAccountRequest,
  UpdateCompanyAccountRequest,
  CompanyAccountResponse,
  CreatePaymentMethodRequest,
  UpdatePaymentMethodRequest,
  PaymentMethodResponse,
  RegisterExpenseRequest,
  ExpenseResponse,
  CloseCashRegisterRequest,
  CashClosingResponse,
  KeepDailyRateRequest,
  DailyRateResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { generateJournalFromDocument } from "./journal-generator.js";

/**
 * TESORERÍA (migraciones 29–31) — RIGOR MÁXIMO: es dinero.
 *
 * La cuenta responde «¿dónde está mi dinero?». Lo que este módulo NO decide:
 *   · el saldo lo mantienen los triggers de la base y lo verifica
 *     `platform.treasury_reconciliation()` — aquí solo se LEE;
 *   · a qué cuenta CONTABLE va un gasto o un faltante lo dice el mapeo del
 *     contador (papeles → cuentas); sin mapeo se ENCOLA (ADR-0042), nunca se
 *     adivina;
 *   · la tasa sale de `exchange_rates` con su fuente. Sin tasa, no hay gasto
 *     en divisa.
 */
export type TreasuryError =
  | CompanyScopeError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string }
  | { code: "EXCHANGE_RATE_MISSING"; message: string };

function traducir(e: unknown): TreasuryError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "LAD67") return { code: "VALIDATION_FAILED", message };
  if (code === "23505") return { code: "DUPLICATE", message: "Ya existe uno con ese nombre." };
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  if (code === "23514") return { code: "VALIDATION_FAILED", message };
  return null;
}

/**
 * La escalera de resolución de cuenta para un pago (migración 29):
 *   1. instrumento SIN efectivo (saldo a favor, nota de crédito) → sin cuenta,
 *      que es lo que el CHECK de la tabla exige;
 *   2. la forma de pago configurada para el instrumento, si su cuenta vive en
 *      la moneda del pago («Pago móvil → Banesco»);
 *   3. la cuenta de sistema «Sin asignar (<moneda>)», creada al vuelo: el
 *      dinero queda visible y el contador lo redistribuye después.
 */
const SIN_EFECTIVO = new Set(["saldo_a_favor", "nota_credito"]);

export async function resolverCuentaEfectivo(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  instrument: string,
  currency: string,
): Promise<string | null> {
  if (SIN_EFECTIVO.has(instrument)) return null;

  const [porMetodo] = await sql<{ id: string }[]>`
    select ca.id
      from public.payment_methods pm
      join public.company_accounts ca on ca.id = pm.account_id
     where pm.company_id = ${companyId} and pm.kind = ${instrument}
       and pm.is_active and ca.is_active and ca.currency = ${currency}
     order by pm.created_at
     limit 1`;
  if (porMetodo) return porMetodo.id;

  const nombre = `Sin asignar (${currency})`;
  const [existente] = await sql<{ id: string }[]>`
    select id from public.company_accounts
     where company_id = ${companyId} and is_system and name = ${nombre}`;
  if (existente) return existente.id;

  await sql`
    insert into public.company_accounts (tenant_id, company_id, name, currency, kind, is_system)
    values (${tenantId}, ${companyId}, ${nombre}, ${currency}, 'cash', true)
    on conflict (company_id, name) do nothing`;
  const [creada] = await sql<{ id: string }[]>`
    select id from public.company_accounts
     where company_id = ${companyId} and is_system and name = ${nombre}`;
  return creada!.id;
}

/** La cuenta, validada: existe en ESTA empresa, activa, con su moneda. */
async function cuentaDe(
  sql: TransactionSql,
  companyId: string,
  accountId: string,
): Promise<Result<{ id: string; currency: string; name: string }, TreasuryError>> {
  const [cuenta] = await sql<{ id: string; currency: string; name: string; is_active: boolean }[]>`
    select id, currency, name, is_active from public.company_accounts
     where id = ${accountId} and company_id = ${companyId}`;
  if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!cuenta.is_active) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${cuenta.name}» está desactivada.`,
    });
  }
  return ok({ id: cuenta.id, currency: cuenta.currency, name: cuenta.name });
}

/** Tasa vigente HOY para convertir a funcional; identidad si es la misma moneda. */
async function tasaHoy(
  sql: TransactionSql,
  desde: string,
  hasta: string,
): Promise<Result<{ rate: string; source: string }, TreasuryError>> {
  if (desde === hasta) return ok({ rate: "1", source: "identidad" });
  const [t] = await sql<{ rate: string | null; source: string | null }[]>`
    select r.rate::text as rate, r.source from public.exchange_rates r
     where r.from_currency = ${desde} and r.to_currency = ${hasta}
       and r.rate_date <= current_date
     order by r.rate_date desc, r.created_at desc limit 1`;
  if (!t?.rate) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: `No hay tasa de ${desde} a ${hasta}. Carga la tasa del día primero.`,
    });
  }
  return ok({ rate: t.rate, source: t.source ?? "manual" });
}

async function auditarTesoreria(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  aggregateType: string,
  aggregateId: string,
  evento: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, ${aggregateType}, ${aggregateId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${companyId}, ${aggregateType}, ${aggregateId}, ${evento}, 1,
            ${sql.json(payload)})`;
}

const CUENTA_COLUMNS = `id, name, currency, kind, is_active, is_system, ledger_account_id`;

// ── Cuentas ─────────────────────────────────────────────────────────────────

export async function listCompanyAccounts(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<CompanyAccountResponse[], TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver el dinero exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, companyId, "treasury.read");
  if (!ctx.ok) return ctx;
  const filas = await sql<CompanyAccountResponse[]>`
    select ca.id, ca.name, ca.currency, ca.kind, ca.is_active, ca.is_system,
           ca.ledger_account_id, coalesce(b.balance, 0)::text as balance
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.company_id = ${companyId}
     order by ca.is_system, ca.name`;
  return ok(filas);
}

export async function createCompanyAccount(
  uow: UnitOfWork,
  input: CreateCompanyAccountRequest,
): Promise<Result<CompanyAccountResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Crear cuentas exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "treasury.account.manage");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [r] = await sp<Omit<CompanyAccountResponse, "balance">[]>`
        insert into public.company_accounts
          (tenant_id, company_id, name, currency, kind, ledger_account_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.name}, ${input.currency},
                ${input.kind}, ${input.ledger_account_id ?? null})
        returning ${sp.unsafe(CUENTA_COLUMNS)}`;
      return r!;
    });
    await auditarTesoreria(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "company_account",
      fila.id,
      "treasury.account.created",
      { name: fila.name, currency: fila.currency, kind: fila.kind },
    );
    return ok({ ...fila, balance: "0" });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

export async function updateCompanyAccount(
  uow: UnitOfWork,
  accountId: string,
  input: UpdateCompanyAccountRequest,
): Promise<Result<CompanyAccountResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Editar cuentas exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "treasury.account.manage");
  if (!ctx.ok) return ctx;
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [r] = await sp<(Omit<CompanyAccountResponse, "balance"> & { balance: string })[]>`
        update public.company_accounts ca
           set name = coalesce(${input.name ?? null}, ca.name),
               is_active = coalesce(${input.is_active ?? null}, ca.is_active),
               ledger_account_id = case
                 when ${input.ledger_account_id === undefined} then ca.ledger_account_id
                 else ${input.ledger_account_id ?? null} end
         where ca.id = ${accountId} and ca.company_id = ${input.company_id}
        returning ${sp.unsafe(CUENTA_COLUMNS)},
                  coalesce((select b.balance from public.company_account_balances b
                             where b.account_id = ca.id), 0)::text as balance`;
      return r;
    });
    if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    await auditarTesoreria(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "company_account",
      fila.id,
      "treasury.account.updated",
      { name: fila.name, is_active: fila.is_active },
    );
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

// ── Formas de pago ──────────────────────────────────────────────────────────

export async function listPaymentMethods(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<PaymentMethodResponse[], TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver formas de pago exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, companyId, "treasury.read");
  if (!ctx.ok) return ctx;
  const filas = await sql<PaymentMethodResponse[]>`
    select id, name, kind, account_id, is_active from public.payment_methods
     where company_id = ${companyId} order by name`;
  return ok(filas);
}

export async function createPaymentMethod(
  uow: UnitOfWork,
  input: CreatePaymentMethodRequest,
): Promise<Result<PaymentMethodResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Configurar pagos exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "treasury.account.manage");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const cuenta = await cuentaDe(sql, input.company_id, input.account_id);
  if (!cuenta.ok) return cuenta;
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [r] = await sp<PaymentMethodResponse[]>`
        insert into public.payment_methods (tenant_id, company_id, name, kind, account_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.name}, ${input.kind},
                ${input.account_id})
        returning id, name, kind, account_id, is_active`;
      return r!;
    });
    await auditarTesoreria(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "payment_method",
      fila.id,
      "treasury.payment_method.created",
      { name: fila.name, kind: fila.kind, account_id: fila.account_id },
    );
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

export async function updatePaymentMethod(
  uow: UnitOfWork,
  methodId: string,
  input: UpdatePaymentMethodRequest,
): Promise<Result<PaymentMethodResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Configurar pagos exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "treasury.account.manage");
  if (!ctx.ok) return ctx;
  if (input.account_id !== undefined) {
    const cuenta = await cuentaDe(sql, input.company_id, input.account_id);
    if (!cuenta.ok) return cuenta;
  }
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [r] = await sp<PaymentMethodResponse[]>`
        update public.payment_methods pm
           set name = coalesce(${input.name ?? null}, pm.name),
               is_active = coalesce(${input.is_active ?? null}, pm.is_active),
               account_id = coalesce(${input.account_id ?? null}, pm.account_id)
         where pm.id = ${methodId} and pm.company_id = ${input.company_id}
        returning id, name, kind, account_id, is_active`;
      return r;
    });
    if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    await auditarTesoreria(
      sql,
      ctx.value.tenantId,
      input.company_id,
      "payment_method",
      fila.id,
      "treasury.payment_method.updated",
      { name: fila.name, is_active: fila.is_active, account_id: fila.account_id },
    );
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

// ── Gastos ──────────────────────────────────────────────────────────────────

const EXPENSE_POLICY_ID = "treasury:expense:8:HALF_UP";

export async function registerExpense(
  uow: UnitOfWork,
  input: RegisterExpenseRequest,
): Promise<Result<ExpenseResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Registrar un gasto exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "expense.register");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const cuenta = await cuentaDe(sql, input.company_id, input.account_id);
  if (!cuenta.ok) return cuenta;

  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${input.company_id}`;
  const funcionalCode = empresa!.moneda;

  const importe = Money.of(input.amount, cuenta.value.currency);
  if (!importe.ok) return err({ code: "VALIDATION_FAILED", message: importe.error.message });

  const tasa = await tasaHoy(sql, cuenta.value.currency, funcionalCode);
  if (!tasa.ok) return tasa;
  const tasaDec = parseDecimal(tasa.value.rate);
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: tasaDec.error.message });
  const funcional = importe.value.amount.times(tasaDec.value).toDecimalPlaces(8, 4);

  const fecha = input.paid_at ?? new Date().toISOString();
  // El DÍA contable del gasto: si el llamante fechó el pago, su fecha manda;
  // si no, el día se decide con el reloj de Venezuela — a las 8 pm de Caracas
  // el UTC ya va por mañana (la familia de bugs de CLAUDE.md §3).
  let fechaContable: string;
  if (input.paid_at !== undefined) {
    fechaContable = input.paid_at.slice(0, 10);
  } else {
    const [hoy] = await sql<{ d: string }[]>`
      select (now() at time zone 'America/Caracas')::date::text as d`;
    fechaContable = hoy!.d;
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let gasto: Record<string, unknown>;
  try {
    gasto = await sql.savepoint(async (sp) => {
      const [g] = await sp<Record<string, unknown>[]>`
        insert into public.expenses
          (tenant_id, company_id, branch_id, category, description, paid_at, account_id,
           supplier_id, is_recurring, attachment_path,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.branch_id ?? null},
                ${input.category}, ${input.description ?? null}, ${fecha}, ${input.account_id},
                ${input.supplier_id ?? null}, ${input.is_recurring ?? false},
                ${input.attachment_path ?? null},
                ${importe.value.toAmountString()}, ${cuenta.value.currency},
                ${tasaDec.value.toFixed()}, ${funcional.toFixed(8)}, ${funcionalCode},
                ${tasa.value.source}, now(), ${EXPENSE_POLICY_ID})
        returning id, category, description,
                  to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
                  account_id, amount_transaction_currency::text as amount,
                  transaction_currency as currency, functional_amount::text as functional_amount,
                  functional_currency, fx_rate::text as fx_rate, is_recurring, supplier_id,
                  branch_id, attachment_path`;
      return g!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  // El asiento: directo si el mapeo resuelve, a la cola si no (ADR-0042).
  const generado = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "expense",
    sourceEvent: "treasury.expense.registered",
    sourceId: gasto["id"] as string,
    postingDate: fechaContable,
    postedBy: actor.userId,
    description: `Gasto: ${input.category}`,
    functionalCurrency: funcionalCode,
    amounts: { functional_amount: funcional.toFixed(8) },
    backlink: { table: "expenses", id: gasto["id"] as string },
  });
  if (!generado.ok) {
    return err({ code: "VALIDATION_FAILED", message: generado.error.message });
  }

  await auditarTesoreria(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "expense",
    gasto["id"] as string,
    "treasury.expense.registered",
    {
      category: input.category,
      account_id: input.account_id,
      amount_transaction_currency: gasto["amount"] as string,
      transaction_currency: cuenta.value.currency,
      fx_rate: gasto["fx_rate"] as string,
      functional_amount: gasto["functional_amount"] as string,
      functional_currency: funcionalCode,
      rate_source: tasa.value.source,
      rounding_policy_id: EXPENSE_POLICY_ID,
    },
  );

  return ok({
    ...(gasto as object),
    journal_entry_id: generado.value.kind === "queued" ? null : generado.value.entryId,
    accounting: generado.value.kind === "queued" ? "queued" : "posted",
  } as ExpenseResponse);
}

// ── Cierre de caja ──────────────────────────────────────────────────────────

const CLOSING_POLICY_ID = "treasury:cash_closing:8:HALF_UP";

export async function closeCashRegister(
  uow: UnitOfWork,
  input: CloseCashRegisterRequest,
): Promise<Result<CashClosingResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cerrar la caja exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "cash.close");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  // El candado va en la CUENTA, no en el saldo: serializa cierres concurrentes
  // de la misma caja aunque la fila de saldo aún no exista.
  const [cuenta] = await sql<{ currency: string; name: string; is_active: boolean }[]>`
    select currency, name, is_active from public.company_accounts
     where id = ${input.account_id} and company_id = ${input.company_id}
     for update`;
  if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!cuenta.is_active) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${cuenta.name}» está desactivada.`,
    });
  }

  const [saldo] = await sql<{ balance: string }[]>`
    select coalesce((select balance from public.company_account_balances
                      where account_id = ${input.account_id}), 0)::text as balance`;
  const esperado = parseDecimal(saldo!.balance);
  const contado = parseDecimal(input.counted_amount);
  if (!esperado.ok || !contado.ok) {
    return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
  }
  const diferencia = contado.value.minus(esperado.value);

  if (!diferencia.isZero() && input.reason === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Contaste ${contado.value.toFixed()} y el sistema esperaba ${esperado.value.toFixed()}. Explica en una línea de dónde sale la diferencia.`,
    });
  }

  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${input.company_id}`;
  const funcionalCode = empresa!.moneda;
  const tasa = await tasaHoy(sql, cuenta.currency, funcionalCode);
  if (!tasa.ok) return tasa;
  const tasaDec = parseDecimal(tasa.value.rate);
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: tasaDec.error.message });
  const difFuncional = diferencia.times(tasaDec.value).toDecimalPlaces(8, 4);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let cierre: Record<string, unknown>;
  try {
    cierre = await sql.savepoint(async (sp) => {
      // El DÍA se decide con el reloj de Venezuela: a las 8 pm de Caracas el
      // UTC ya va por mañana, y un cierre del martes fechado miércoles es
      // exactamente el bug de fecha-contra-reloj de CLAUDE.md §3.
      const [c] = await sp<Record<string, unknown>[]>`
        insert into public.cash_closings
          (tenant_id, company_id, branch_id, account_id, closing_date, closed_at,
           expected_amount, counted_amount, reason,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.branch_id ?? null},
                ${input.account_id}, (now() at time zone 'America/Caracas')::date, now(),
                ${esperado.value.toFixed()}, ${contado.value.toFixed()}, ${input.reason ?? null},
                ${diferencia.toFixed()}, ${cuenta.currency}, ${tasaDec.value.toFixed()},
                ${difFuncional.toFixed(8)}, ${funcionalCode}, ${tasa.value.source}, now(),
                ${CLOSING_POLICY_ID})
        returning id, account_id, closing_date::text as closing_date,
                  to_char(closed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as closed_at,
                  expected_amount::text as expected_amount,
                  counted_amount::text as counted_amount,
                  amount_transaction_currency::text as difference, reason,
                  transaction_currency as currency`;
      return c!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  // Con diferencia cero no hay hecho contable: ni asiento ni cola.
  let accounting: "posted" | "queued" | "none" = "none";
  let entryId: string | null = null;
  if (!diferencia.isZero()) {
    const generado = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId: input.company_id,
      sourceKind: "cash_closing",
      sourceEvent: "treasury.cash_register.closed",
      sourceId: cierre["id"] as string,
      postingDate: cierre["closing_date"] as string,
      postedBy: actor.userId,
      description: `Cierre de caja ${cuenta.name}: ${diferencia.isNegative() ? "faltante" : "sobrante"}`,
      functionalCurrency: funcionalCode,
      // Con SIGNO: la plantilla decide el lado con if_positive / if_negative.
      amounts: { functional_amount: difFuncional.toFixed(8) },
      backlink: { table: "cash_closings", id: cierre["id"] as string },
    });
    if (!generado.ok) {
      return err({ code: "VALIDATION_FAILED", message: generado.error.message });
    }
    accounting = generado.value.kind === "queued" ? "queued" : "posted";
    entryId = generado.value.kind === "queued" ? null : generado.value.entryId;
  }

  await auditarTesoreria(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "cash_closing",
    cierre["id"] as string,
    "treasury.cash_register.closed",
    {
      account_id: input.account_id,
      closing_date: cierre["closing_date"] as string,
      expected_amount: cierre["expected_amount"] as string,
      counted_amount: cierre["counted_amount"] as string,
      difference: cierre["difference"] as string,
      reason: input.reason ?? null,
    },
  );

  return ok({
    ...(cierre as object),
    journal_entry_id: entryId,
    accounting,
  } as CashClosingResponse);
}

// ── Tasa del día: «sigue igual» ─────────────────────────────────────────────

export async function keepDailyRate(
  uow: UnitOfWork,
  companyId: string,
  input: KeepDailyRateRequest,
): Promise<Result<DailyRateResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Confirmar la tasa exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, companyId, "fx.rate.manage");
  if (!ctx.ok) return ctx;

  const [ultima] = await sql<{ rate: string; source: string; rate_date: string }[]>`
    select rate::text as rate, source, rate_date::text as rate_date
      from public.exchange_rates
     where from_currency = ${input.from_currency} and to_currency = ${input.to_currency}
       and rate_date <= current_date
     order by rate_date desc, created_at desc limit 1`;
  if (!ultima) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: `Nunca se ha cargado una tasa de ${input.from_currency} a ${input.to_currency}: no hay nada que confirmar.`,
    });
  }

  // SIEMPRE una fila nueva, aunque el número sea el mismo: reutilizar la vieja
  // dejaría indistinguible «nadie miró la tasa» de «se miró y no cambió». Y la
  // fuente dice la verdad: esto es una confirmación humana, no una carga BCV.
  const fuente = `sin cambio, confirmada (antes: ${ultima.source})`.slice(0, 120);
  const [fila] = await sql<DailyRateResponse[]>`
    insert into public.exchange_rates
      (from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values (${input.from_currency}, ${input.to_currency}, ${ultima.rate}, ${fuente},
            (now() at time zone 'America/Caracas')::date, now())
    returning from_currency, to_currency, rate::text as rate, rate_date::text as rate_date,
              source`;
  return ok(fila!);
}
