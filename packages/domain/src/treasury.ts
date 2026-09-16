import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
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
  CreateTreasuryTransferRequest,
  TreasuryTransferResponse,
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
  | { code: "INSUFFICIENT_FUNDS"; message: string }
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
const SIN_EFECTIVO = new Set(["saldo_a_favor", "nota_credito", "retencion_iva"]);

/**
 * En qué moneda vive cada instrumento, DEL LADO DEL SERVIDOR (ADR-0062 §2). La web tenía su
 * propia copia y nada impedía apuntar un Zelle (USD) a una cuenta en bolívares: el cobro en
 * divisa entraba a una caja en Bs y el arqueo mezclaba monedas (QA 2026-09-15, h. 27).
 * `null` = cualquiera: una tarjeta o un «otro» pueden liquidar en la moneda que sea.
 */
export const MONEDA_DE_INSTRUMENTO: Record<string, "funcional" | "USD" | null> = {
  efectivo_bs: "funcional",
  pago_movil: "funcional",
  transferencia: "funcional",
  punto_venta: "funcional",
  cashea: "funcional",
  efectivo_usd: "USD",
  zelle: "USD",
  usdt: "USD",
  tarjeta: null,
  otro: null,
};

/**
 * La FAMILIA de cuenta que le toca a cada instrumento cuando no hay forma configurada: el
 * efectivo va a una caja física; lo digital, a un banco o a una billetera — nunca a la caja,
 * porque el arqueo contaría billetes que no están.
 */
const FAMILIA_DE_INSTRUMENTO: Record<string, readonly string[]> = {
  efectivo_bs: ["cash"],
  efectivo_usd: ["cash"],
  pago_movil: ["bank", "wallet"],
  transferencia: ["bank", "wallet"],
  punto_venta: ["bank", "wallet"],
  tarjeta: ["bank", "wallet"],
  cashea: ["bank", "wallet"],
  zelle: ["wallet", "bank"],
  usdt: ["wallet", "bank"],
  otro: ["bank", "wallet", "cash"],
};

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

  /**
   * NUEVO (ADR-0062 §1): la cuenta PROPIA de la familia del instrumento, en la moneda del pago.
   * Empezar obliga a crear cuentas prometiendo que «cada cobro va a caer en una de estas
   * cuentas», y sin formas configuradas todo caía en «Sin asignar» mientras «Caja del local»
   * quedaba en cero (QA de pantalla 2026-09-15, hallazgo 15).
   */
  const familia = FAMILIA_DE_INSTRUMENTO[instrument] ?? ["cash", "bank", "wallet"];
  const [propia] = await sql<{ id: string }[]>`
    select ca.id
      from public.company_accounts ca
     where ca.company_id = ${companyId} and ca.is_active and not ca.is_system
       and ca.currency = ${currency} and ca.kind = any(${[...familia]}::text[])
     order by array_position(${[...familia]}::text[], ca.kind), ca.created_at
     limit 1`;
  if (propia) return propia.id;

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

/**
 * ¿Alcanza el saldo para lo que va a salir? (ADR-0062 §4). La cuenta se BLOQUEA: dos egresos
 * simultáneos del mismo saldo pasaban los dos. Un egreso que deja la cuenta en negativo exige
 * `allow_negative_balance`, y la pantalla lo pide con el número delante (QA h. 33, 50, 77).
 */
export async function exigeSaldo(
  sql: TransactionSql,
  accountId: string,
  monto: string,
  permitirNegativo: boolean | undefined,
): Promise<Result<true, TreasuryError>> {
  if (permitirNegativo === true) return ok(true);
  const [fila] = await sql<{ nombre: string; moneda: string; saldo: string; alcanza: boolean }[]>`
    select ca.name as nombre, ca.currency as moneda,
           coalesce(b.balance, 0)::text as saldo,
           coalesce(b.balance, 0) >= ${monto}::numeric as alcanza
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.id = ${accountId}
     for update of ca`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (fila.alcanza) return ok(true);
  return err({
    code: "INSUFFICIENT_FUNDS",
    message: `«${fila.nombre}» tiene ${fila.saldo} ${fila.moneda} y esta operación saca ${monto}: quedaría en negativo. Revisa de qué cuenta sale, o confirma que quieres registrarlo igual.`,
  });
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
/**
 * La tasa vigente a un DÍA de Caracas (por omisión, hoy). `current_date` era
 * el día UTC: de 20:00 a 23:59 ya era mañana (auditoría 2026-09-11, M-25).
 */
async function tasaHoy(
  sql: TransactionSql,
  companyId: string,
  desde: string,
  hasta: string,
  dia?: string,
): Promise<Result<{ rate: string; source: string }, TreasuryError>> {
  if (desde === hasta) return ok({ rate: "1", source: "identidad" });
  const [t] = await sql<{ rate: string | null; source: string | null }[]>`
    select f.rate::text as rate, f.source
      from platform.rate_for(${companyId}, ${desde}, ${hasta},
             coalesce(${dia ?? null}::date, (now() at time zone 'America/Caracas')::date)) f`;
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
  // ADR-0048: con treasury.read se ve TODO el dinero. Con SOLO cash.close se
  // ve únicamente LA CAJA (efectivo, no de sistema): quien cierra va a contar
  // ese efectivo de todas formas, pero el banco y el Zelle no son suyos de ver.
  const ctx = await companyScope(sql, actor.userId, companyId, "treasury.read");
  let soloCaja = false;
  if (!ctx.ok) {
    const cierre = await companyScope(sql, actor.userId, companyId, "cash.close");
    if (!cierre.ok) return ctx;
    soloCaja = true;
  }
  const filas = await sql<CompanyAccountResponse[]>`
    select ca.id, ca.name, ca.currency, ca.kind, ca.is_active, ca.is_system,
           ca.ledger_account_id, coalesce(b.balance, 0)::text as balance
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.company_id = ${companyId}
       ${soloCaja ? sql`and ca.kind = 'cash' and not ca.is_system` : sql``}
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
  // El CATÁLOGO de formas de pago no es «ver el dinero»: la cajera lo necesita
  // para cobrar con la forma configurada y el encargado para pagar una compra.
  // Con solo treasury.read, cajero y encargado recibían 403 y sus cobros caían
  // en «Sin asignar» (auditoría 2026-09-11, A-08).
  const ctx = await companyScope(sql, actor.userId, companyId, [
    "treasury.read",
    "cash.close",
    "sales.invoice.issue",
    "sales.payment.register",
    "purchase.payment.register",
    "expense.register",
  ]);
  if (!ctx.ok) return ctx;
  const filas = await sql<PaymentMethodResponse[]>`
    select id, name, kind, account_id, is_active from public.payment_methods
     where company_id = ${companyId} order by name`;
  return ok(filas);
}

/** La moneda del instrumento contra la de la cuenta (ADR-0062 §2). */
async function monedaDeFormaValida(
  sql: TransactionSql,
  companyId: string,
  kind: string,
  monedaCuenta: string,
): Promise<Result<true, TreasuryError>> {
  const exigida = MONEDA_DE_INSTRUMENTO[kind] ?? null;
  if (exigida === null) return ok(true);
  let esperada: string = exigida;
  if (exigida === "funcional") {
    const [empresa] = await sql<{ moneda: string }[]>`
      select functional_currency_code as moneda from public.companies where id = ${companyId}`;
    esperada = empresa?.moneda ?? "VES";
  }
  if (esperada === monedaCuenta) return ok(true);
  return err({
    code: "VALIDATION_FAILED",
    message: `Esa forma de pago cobra en ${esperada} y la cuenta elegida vive en ${monedaCuenta}: el dinero entraría a una caja de otra moneda.`,
  });
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
  const monedaOk = await monedaDeFormaValida(
    sql,
    input.company_id,
    input.kind,
    cuenta.value.currency,
  );
  if (!monedaOk.ok) return monedaOk;
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
  const fecha = input.paid_at ?? new Date().toISOString();
  // Regla 8: la tasa es la EFECTIVA a la fecha del pago (día de Caracas), no la
  // de hoy — un gasto fechado el 1 se convertía con la tasa del 8 (auditoría
  // 2026-09-11, M-15).
  const [diaPago] = await sql<{ dia: string }[]>`
    select ((${fecha}::timestamptz) at time zone 'America/Caracas')::date::text as dia`;
  const tasa = await tasaHoy(
    sql,
    input.company_id,
    cuenta.value.currency,
    funcionalCode,
    diaPago!.dia,
  );
  if (!tasa.ok) return tasa;
  const tasaDec = parseDecimal(tasa.value.rate);
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: tasaDec.error.message });
  const funcional = importe.value.amount.times(tasaDec.value).toDecimalPlaces(8, 4);

  // El saldo se comprueba AQUÍ, después de la tasa y justo antes de escribir: sin tasa el
  // gasto no se puede ni valorar, y decir «no alcanza» taparía el motivo real. Además, la
  // cuenta queda bloqueada el menor tiempo posible (ADR-0062 §4).
  const alcanza = await exigeSaldo(
    sql,
    input.account_id,
    importe.value.toAmountString(),
    input.allow_negative_balance,
  );
  if (!alcanza.ok) return alcanza;

  // El DÍA contable del gasto: si el llamante fechó el pago, su fecha manda;
  // si no, el día se decide con el reloj de Venezuela — a las 8 pm de Caracas
  // el UTC ya va por mañana (la familia de bugs de CLAUDE.md §3).
  let fechaContable: string;
  if (input.paid_at !== undefined) {
    fechaContable = diaNegocio(input.paid_at);
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
  const tasa = await tasaHoy(sql, input.company_id, cuenta.currency, funcionalCode);
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
    select f.rate::text as rate, f.source, f.rate_date::text as rate_date
      from platform.rate_for(${companyId}, ${input.from_currency}, ${input.to_currency},
                             (now() at time zone 'America/Caracas')::date) f`;
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
      (tenant_id, company_id, from_currency, to_currency, rate, source, rate_date, rate_timestamp)
    values (${ctx.value.tenantId}, ${companyId}, ${input.from_currency}, ${input.to_currency},
            ${ultima.rate}, ${fuente}, (now() at time zone 'America/Caracas')::date, now())
    returning from_currency, to_currency, rate::text as rate, rate_date::text as rate_date,
              source`;
  return ok(fila!);
}

/**
 * PREVISUALIZAR una conversión con la tasa vigente de HOY (día Caracas) — el
 * dato que las pantallas enseñan al lado de un monto en la otra moneda. La
 * aritmética vive AQUÍ (numeric de Postgres), jamás en el cliente; redondeo a
 * 2 decimales porque es DISPLAY: el valor contable lo calcula cada caso de
 * uso con su propia política al persistir.
 */
export interface VistaConversion {
  readonly rate: string;
  readonly source: string;
  readonly rate_date: string;
  /** El monto expresado en la moneda funcional (Bs), a 2 decimales. */
  readonly in_functional: string;
  /** El monto expresado en el ancla (USD), a 2 decimales. */
  readonly in_anchor: string;
}

export async function previsualizarConversion(
  sql: TransactionSql,
  companyId: string,
  amount: string,
  currency: string,
): Promise<
  Result<VistaConversion, { code: "EXCHANGE_RATE_MISSING" | "VALIDATION_FAILED"; message: string }>
> {
  const [empresa] = await sql<{ functional_currency_code: string }[]>`
    select functional_currency_code from public.companies where id = ${companyId}`;
  const funcional = empresa?.functional_currency_code ?? "VES";
  const ancla = "USD";
  if (currency !== funcional && currency !== ancla) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La vista previa solo convierte entre ${ancla} y ${funcional}.`,
    });
  }
  const [t] = await sql<{ rate: string; source: string; rate_date: string }[]>`
    select f.rate::text as rate, f.source, f.rate_date::text as rate_date
      from platform.rate_for(${companyId}, ${ancla}, ${funcional}, (now() at time zone 'America/Caracas')::date) f`;
  if (!t) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: `No hay tasa de ${ancla} a ${funcional} todavía. Confírmala en Mi dinero.`,
    });
  }
  const [calc] = await sql<{ in_functional: string; in_anchor: string }[]>`
    select case when ${currency} = ${ancla}
                then round(${amount}::numeric(24,8) * ${t.rate}::numeric(24,8), 2)::text
                else round(${amount}::numeric(24,8), 2)::text end as in_functional,
           case when ${currency} = ${ancla}
                then round(${amount}::numeric(24,8), 2)::text
                else round(${amount}::numeric(24,8) / ${t.rate}::numeric(24,8), 2)::text
                end as in_anchor`;
  return ok({
    rate: t.rate,
    source: t.source,
    rate_date: t.rate_date,
    in_functional: calc!.in_functional,
    in_anchor: calc!.in_anchor,
  });
}

// ── Transferencia entre cuentas (ADR-0062 §3, migración 61) ─────────────────

const TRANSFER_POLICY_ID = "treasury:transfer:8:HALF_UP";

/**
 * MOVER DINERO DE UNA CUENTA A OTRA: repartir lo que entró en «Sin asignar», llevar el efectivo
 * al banco, pasar de una caja a otra. Un solo hecho con dos patas sobre los saldos, en la MISMA
 * moneda — cambiar dólares por bolívares tiene tasa y diferencial, y no es esto.
 *
 * El QA de pantalla del 2026-09-15 (hallazgo 24) lo encontró prometido y ausente: la tarjeta de
 * «Sin asignar» decía «Por repartir» y no había ninguna acción.
 */
export async function transferBetweenAccounts(
  uow: UnitOfWork,
  input: CreateTreasuryTransferRequest,
): Promise<Result<TreasuryTransferResponse, TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Transferir exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, input.company_id, "treasury.reassign");
  if (!ctx.ok) return ctx;
  if (ctx.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  if (input.from_account_id === input.to_account_id) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El origen y el destino son la misma cuenta.",
    });
  }
  const origen = await cuentaDe(sql, input.company_id, input.from_account_id);
  if (!origen.ok) return origen;
  const destino = await cuentaDe(sql, input.company_id, input.to_account_id);
  if (!destino.ok) return destino;
  if (origen.value.currency !== destino.value.currency) {
    return err({
      code: "VALIDATION_FAILED",
      message: `«${origen.value.name}» está en ${origen.value.currency} y «${destino.value.name}» en ${destino.value.currency}: una transferencia mueve la misma moneda. Cambiar de moneda se registra como venta o compra de divisas.`,
    });
  }
  const importe = Money.of(input.amount, origen.value.currency);
  if (!importe.ok) return err({ code: "VALIDATION_FAILED", message: importe.error.message });
  const alcanza = await exigeSaldo(
    sql,
    input.from_account_id,
    importe.value.toAmountString(),
    input.allow_negative_balance,
  );
  if (!alcanza.ok) return alcanza;

  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${input.company_id}`;
  const funcionalCode = empresa!.moneda;
  const [hoy] = await sql<{ d: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as d`;
  let tasaDec = parseDecimal("1");
  let fuenteTasa = "identidad";
  if (origen.value.currency !== funcionalCode) {
    const tasa = await tasaHoy(sql, input.company_id, origen.value.currency, funcionalCode, hoy!.d);
    if (!tasa.ok) return tasa;
    tasaDec = parseDecimal(tasa.value.rate);
    fuenteTasa = tasa.value.source;
  }
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: "Tasa no interpretable." });
  const funcional = importe.value.amount.times(tasaDec.value).toDecimalPlaces(8, 4);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  let transferencia: Record<string, unknown>;
  try {
    transferencia = await sql.savepoint(async (sp) => {
      const [t] = await sp<Record<string, unknown>[]>`
        insert into public.treasury_transfers
          (tenant_id, company_id, from_account_id, to_account_id, reason,
           amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
           functional_currency, rate_source, rate_timestamp, rounding_policy_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.from_account_id},
                ${input.to_account_id}, ${input.reason},
                ${importe.value.toAmountString()}, ${origen.value.currency},
                ${tasaDec.value.toFixed()}, ${funcional.toFixed(8)}, ${funcionalCode},
                ${fuenteTasa}, now(), ${TRANSFER_POLICY_ID})
        returning id, from_account_id, to_account_id, reason,
                  to_char(transferred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    as transferred_at,
                  amount_transaction_currency::text as amount, transaction_currency as currency,
                  functional_amount::text as functional_amount, functional_currency,
                  fx_rate::text as fx_rate`;
      return t!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  const generado = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "treasury_transfer",
    sourceEvent: "treasury.transfer.registered",
    sourceId: transferencia["id"] as string,
    postingDate: hoy!.d,
    postedBy: actor.userId,
    description: `Transferencia: ${origen.value.name} → ${destino.value.name}`,
    functionalCurrency: funcionalCode,
    amounts: { functional_amount: funcional.toFixed(8) },
    backlink: { table: "treasury_transfers", id: transferencia["id"] as string },
  });
  if (!generado.ok) {
    return err({ code: "VALIDATION_FAILED", message: generado.error.message });
  }

  await auditarTesoreria(
    sql,
    ctx.value.tenantId,
    input.company_id,
    "treasury_transfer",
    transferencia["id"] as string,
    "treasury.transfer.registered",
    {
      from_account_id: input.from_account_id,
      to_account_id: input.to_account_id,
      amount_transaction_currency: transferencia["amount"] as string,
      transaction_currency: origen.value.currency,
      functional_amount: transferencia["functional_amount"] as string,
      functional_currency: funcionalCode,
      reason: input.reason,
      rounding_policy_id: TRANSFER_POLICY_ID,
    },
  );

  return ok({
    ...(transferencia as object),
    journal_entry_id: generado.value.kind === "queued" ? null : generado.value.entryId,
    accounting: generado.value.kind === "queued" ? "queued" : "posted",
  } as TreasuryTransferResponse);
}
