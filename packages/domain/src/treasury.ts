import { err, ok, type Result } from "@ladino/core";
import { fechaContableDe } from "./fecha-contable.js";
import { diaNegocio } from "./dia-negocio.js";
import { explicarFaltaDeTasa, mensajeFaltaTasa } from "./tasa-oficial.js";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, minorUnitsOf, parseDecimal, toCents, type Decimal } from "@ladino/money";
import { formatMoney } from "@ladino/money/format";
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
  CreateTreasuryTransferRequest,
  TreasuryTransferResponse,
  CandidateAccountResponse,
  CandidatesByInstrument,
  MoneyLandingGapResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { generateJournalFromDocument, type AmountContext } from "./journal-generator.js";

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
  | { code: "PERMISSION_REQUIRED"; message: string }
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

/** D-11: lo que la confirmación de un sobregiro trae del cuerpo, y de qué operación viene. */
export interface ConfirmacionDeSobregiro {
  /** `allow_negative_balance` del cuerpo. */
  readonly permitir: boolean | undefined;
  /** `overdraft_reason` del cuerpo. */
  readonly motivo: string | undefined;
  /** Qué egreso es: queda en el acta. */
  readonly operacion: "expense" | "transfer" | "supplier_payment" | "refund";
}

/** El motivo de un sobregiro es una frase, no un «ok»: mínimo de caracteres útiles. */
export const MOTIVO_DE_SOBREGIRO_MINIMO = 5;

/**
 * ¿Alcanza el saldo para lo que va a salir? (ADR-0062 §4). La cuenta se BLOQUEA: dos egresos
 * simultáneos del mismo saldo pasaban los dos.
 *
 * DEJAR UNA CUENTA EN NEGATIVO EXIGE TRES COSAS (D-11, H-05; RESPUESTA §2.8): que el cuerpo lo
 * confirme (`allow_negative_balance`), que quien opera tenga `treasury.overdraft` en la empresa,
 * y un motivo. Y deja el acta `treasury.overdraft.confirmed` en ESTA transacción: quién, cuenta,
 * importe, saldo resultante y motivo. Antes bastaba con que el cuerpo lo pidiera, y el acta del
 * egreso no decía que se había permitido el negativo.
 *
 * Los cuatro ojos (`platform.approval_allowed`) NO aplican aquí, decidido por criterio (ADR-0066
 * nota de la ola 3 §8, ADR-0068 §8): el sobregiro se confirma EN EL ACTO, quien registra es quien
 * confirma, y sin una aprobación pendiente la regla lo haría imposible en cualquier empresa con
 * más de una persona.
 *
 * Si el saldo alcanza no hay sobregiro que confirmar: no se pide permiso ni motivo, aunque el
 * cuerpo traiga la confirmación.
 */
export async function exigeSaldo(
  sql: TransactionSql,
  accountId: string,
  monto: string,
  confirmacion: ConfirmacionDeSobregiro,
): Promise<Result<true, TreasuryError>> {
  // H6 (ADR-0068 §8): el saldo solo va en el mensaje si quien opera ve el dinero (treasury.read).
  // El actor sale del GUC de la transacción: el mismo que fija la API y que lee la RLS.
  const [fila] = await sql<
    {
      nombre: string;
      moneda: string;
      saldo: string;
      saldo_despues: string;
      alcanza: boolean;
      ve_saldo: boolean;
      puede_sobregirar: boolean;
      tenant_id: string;
      company_id: string;
      actor_id: string | null;
    }[]
  >`
    select ca.name as nombre, ca.currency as moneda,
           coalesce(b.balance, 0)::text as saldo,
           (coalesce(b.balance, 0) - ${monto}::numeric)::numeric(24,8)::text as saldo_despues,
           coalesce(b.balance, 0) >= ${monto}::numeric as alcanza,
           coalesce(platform.ladino_user_has_permission(
             platform.ladino_service_actor_id(), 'treasury.read', ca.company_id), false) as ve_saldo,
           coalesce(platform.ladino_user_has_permission(
             platform.ladino_service_actor_id(), 'treasury.overdraft', ca.company_id), false)
             as puede_sobregirar,
           ca.tenant_id, ca.company_id, platform.ladino_service_actor_id() as actor_id
      from public.company_accounts ca
      left join public.company_account_balances b on b.account_id = ca.id
     where ca.id = ${accountId}
     for update of ca`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (fila.alcanza) return ok(true);

  if (confirmacion.permitir !== true) {
    // H-05: a quien no puede sobregirar no se le propone «regístralo igual»: se le dice qué hacer.
    const salida = fila.puede_sobregirar
      ? "Revisa de qué cuenta sale, o regístralo igual con su motivo."
      : "Elige otra cuenta o pídele a quien administra que lo registre.";
    return err({
      code: "INSUFFICIENT_FUNDS",
      message: fila.ve_saldo
        ? `«${fila.nombre}» tiene ${importeDePersona(fila.saldo, fila.moneda)} y esta operación saca ${importeDePersona(monto, fila.moneda)}: quedaría en negativo. ${salida}`
        : `En «${fila.nombre}» no alcanza para sacar ${importeDePersona(monto, fila.moneda)}: quedaría en negativo. ${salida}`,
    });
  }
  if (!fila.puede_sobregirar) {
    // El 403 de persona lo pone la API a partir de la clave del permiso (errors.ts).
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Dejar una cuenta en negativo exige el permiso treasury.overdraft.",
    });
  }
  const motivo = (confirmacion.motivo ?? "").trim();
  if (motivo.length < MOTIVO_DE_SOBREGIRO_MINIMO) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Para dejar una cuenta en negativo hay que decir el motivo: escribe por qué se registra sin saldo (queda en el historial).",
    });
  }
  await auditarTesoreria(
    sql,
    fila.tenant_id,
    fila.company_id,
    "company_account",
    accountId,
    "treasury.overdraft.confirmed",
    {
      actor_id: fila.actor_id,
      account_id: accountId,
      account_name: fila.nombre,
      currency: fila.moneda,
      amount: monto,
      balance_before: fila.saldo,
      balance_after: fila.saldo_despues,
      reason: motivo,
      operation: confirmacion.operacion,
    },
  );
  return ok(true);
}

/**
 * D-13 (ola 3): el importe de un mensaje, como lo lee una persona —«Bs. 120.000,00»—, no como lo
 * guarda la base («120000.00000000»). Formatear no redondea (MONEY_AND_ROUNDING_SPEC §5): se
 * redondea antes, explícito, a los decimales de la moneda, y SOLO para el texto del aviso.
 */
function importeDePersona(monto: string, moneda: string): string {
  const d = parseDecimal(monto);
  if (!d.ok) return `${monto} ${moneda}`;
  try {
    const visible = d.value.toDecimalPlaces(minorUnitsOf(moneda), 4).toFixed(minorUnitsOf(moneda));
    // El CLDR de es-VE todavía dice «Bs.S»: la reconversión ya pasó y la app dice «Bs.».
    return formatMoney({ amount: visible, currency: moneda }, { locale: "es-VE" }).replace(
      "Bs.S",
      "Bs.",
    );
  } catch {
    return `${monto} ${moneda}`;
  }
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
  // El día se resuelve UNA vez y es el mismo para la regla y para el mensaje: sin tasa dentro
  // del margen (`platform.rate_for`, la única regla) la fila llega con la tasa en NULL. La
  // consulta SIEMPRE devuelve una fila (subconsulta de una fila + `left join … on true`).
  const [t] = await sql<{ dia: string; hoy: string; rate: string | null; source: string | null }[]>`
    select d.dia::text as dia, d.hoy::text as hoy, f.rate::text as rate, f.source
      from (select h.hoy, coalesce(${dia ?? null}::date, h.hoy) as dia
              from (select (now() at time zone 'America/Caracas')::date as hoy) h) d
      left join lateral platform.rate_for(${companyId}, ${desde}, ${hasta}, d.dia) f on true`;
  if (t!.rate === null) {
    return err({ code: "EXCHANGE_RATE_MISSING", message: mensajeFaltaTasa(t!.dia, t!.hoy) });
  }
  return ok({ rate: t!.rate, source: t!.source ?? "manual" });
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
  // H-15: el acta y su evento de outbox viajan en UNA sentencia. Un CTE con INSERT se ejecuta
  // siempre (Postgres lo corre hasta el final aunque nadie lea su resultado): son las dos filas
  // de antes, en la misma transacción, con un viaje menos.
  await sql`
    with acta as (
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${tenantId}, ${companyId}, ${aggregateType}, ${aggregateId}, ${evento},
              'user', now(), ${RULES_VERSION}, ${sql.json(payload)})
    )
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
           ca.ledger_account_id,
           -- El saldo se SIRVE a las unidades mínimas de su moneda (ADR-0063 §4): en la
           -- gaveta no hay «USD 7,02529438». La base conserva su escala.
           round(coalesce(b.balance, 0), platform.currency_minor_units(ca.currency))::text
             as balance
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

/**
 * LA RUTA DEL COMPROBANTE ES DE ESTA EMPRESA (revisión de la ola 4). `attachment_path` era texto
 * libre: un gasto de la empresa A podía guardar la ruta de un comprobante de B, y quien leyera
 * el gasto de A tendría enlazado un documento ajeno. La subida (`POST /v1/expenses/attachment`)
 * escribe siempre bajo `<empresa>/receipts/`: lo que no empiece así no lo subió esta empresa.
 */
export function comprobanteAjeno(
  companyId: string,
  ruta: string | undefined,
): { code: "VALIDATION_FAILED"; message: string } | null {
  if (ruta === undefined) return null;
  if (ruta.startsWith(`${companyId}/receipts/`) && !ruta.includes("..")) return null;
  return {
    code: "VALIDATION_FAILED",
    message:
      "Ese comprobante no es de esta empresa. Vuelve a adjuntarlo desde el formulario del gasto.",
  };
}

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
  const ajeno = comprobanteAjeno(input.company_id, input.attachment_path);
  if (ajeno !== null) return err(ajeno);
  const fecha = input.paid_at ?? new Date().toISOString();
  /**
   * H-15 (recorrido 2026-09-24): UNA lectura donde había cinco viajes. postgres.js no hace
   * pipelining dentro de una transacción, así que cada sentencia es un viaje de ida y vuelta a
   * la base; con la base en otra región son decenas de milisegundos cada uno. La cuenta, la
   * moneda funcional, el día de Caracas del pago, el de hoy y la versión de reglas iban en cinco
   * sentencias: van en una. Mismas lecturas, mismos errores y en el mismo orden.
   */
  const [base] = await sql<
    {
      cuenta_id: string | null;
      currency: string | null;
      name: string | null;
      is_active: boolean | null;
      moneda: string;
      dia_pago: string;
      hoy: string;
    }[]
  >`
    select ca.id as cuenta_id, ca.currency, ca.name, ca.is_active,
           c.functional_currency_code as moneda,
           ((${fecha}::timestamptz) at time zone 'America/Caracas')::date::text as dia_pago,
           (now() at time zone 'America/Caracas')::date::text as hoy,
           set_config('ladino.rules_version', ${RULES_VERSION}, true) as reglas
      from public.companies c
      left join public.company_accounts ca
        on ca.id = ${input.account_id} and ca.company_id = c.id
     where c.id = ${input.company_id}`;
  // La cuenta, validada como en `cuentaDe`: existe en ESTA empresa y está activa.
  if (!base || base.cuenta_id === null || base.currency === null) {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  if (base.is_active !== true) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${base.name ?? ""}» está desactivada.`,
    });
  }
  const cuenta = { value: { id: base.cuenta_id, currency: base.currency, name: base.name ?? "" } };
  const funcionalCode = base.moneda;

  // H-09: el importe solo es opcional para el gasto CON factura, que no pasa por aquí.
  if (input.amount === undefined || input.invoice !== undefined) {
    return err({ code: "VALIDATION_FAILED", message: "Falta el importe del gasto." });
  }
  const importe = Money.of(input.amount, cuenta.value.currency);
  if (!importe.ok) return err({ code: "VALIDATION_FAILED", message: importe.error.message });
  // Regla 8: la tasa es la EFECTIVA a la fecha del pago (día de Caracas), no la
  // de hoy — un gasto fechado el 1 se convertía con la tasa del 8 (auditoría
  // 2026-09-11, M-15).
  const tasa = await tasaHoy(
    sql,
    input.company_id,
    cuenta.value.currency,
    funcionalCode,
    base.dia_pago,
  );
  if (!tasa.ok) return tasa;
  const tasaDec = parseDecimal(tasa.value.rate);
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: tasaDec.error.message });
  // P-03 (ADR-0075 §7): el equivalente funcional de lo que sale de la caja va al céntimo,
  // half-up. Antes 4.278,3125 en la caja y en el mayor.
  const funcional = toCents(importe.value.amount.times(tasaDec.value));

  // El saldo se comprueba AQUÍ, después de la tasa y justo antes de escribir: sin tasa el
  // gasto no se puede ni valorar, y decir «no alcanza» taparía el motivo real. Además, la
  // cuenta queda bloqueada el menor tiempo posible (ADR-0062 §4).
  const alcanza = await exigeSaldo(sql, input.account_id, importe.value.toAmountString(), {
    permitir: input.allow_negative_balance,
    motivo: input.overdraft_reason,
    operacion: "expense",
  });
  if (!alcanza.ok) return alcanza;

  // El DÍA contable del gasto: si el llamante fechó el pago, su fecha manda;
  // si no, el día se decide con el reloj de Venezuela — a las 8 pm de Caracas
  // el UTC ya va por mañana (la familia de bugs de CLAUDE.md §3).
  let fechaContable: string;
  if (input.paid_at !== undefined) {
    // K-04: fechado en un mes cerrado (o antes del inicio de actividades), el asiento va al
    // período en curso; el gasto conserva su paid_at.
    fechaContable = await fechaContableDe(sql, input.company_id, diaNegocio(input.paid_at));
  } else {
    fechaContable = base.hoy;
  }

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

/** El evento del outbox de TODO cierre de caja: el cierre ocurrió, cuadre o no. */
export const CASH_CLOSING_EVENT = "treasury.cash_register.closed";
/** El origen de siempre: sobrante o faltante contra «Faltantes y sobrantes de caja». */
export const CASH_CLOSING_KIND = "cash_closing";
/**
 * J-02: el cierre de una caja en sobregiro. MISMO evento, otro hecho contable: como
 * `purchase_revaluation / ap.invoice_posted`, el hecho va en el origen (migración 20261004180200).
 */
export const CASH_CLOSING_OVERDRAFT_KIND = "cash_closing_overdraft";

/**
 * QUÉ HECHO CONTABLE ES UN CIERRE CON DIFERENCIA (J-02, migraciones 20261004180000 a 180200).
 *
 * Una caja en NEGATIVO no tuvo un sobrante: alguien pagó de su bolsillo dinero que el sistema no
 * tenía cargado (ADR-0062 §4). Como lo contado nunca es negativo, cerrar una caja en sobregiro
 * siempre la sube, y esa subida se parte en dos: lo que la lleva de su saldo negativo a CERO es
 * dinero del dueño (pasivo, «Cuentas por pagar a socios»), y solo lo contado POR ENCIMA de cero es
 * sobrante. Sin sobregiro, el hecho y sus importes son los de siempre. Pura: una sola definición
 * para el cierre y para la reparación de los cierres viejos.
 *
 * Todo en la moneda funcional y al céntimo; `total` es la diferencia ya convertida, y el sobrante
 * es `total − del dueño`, de modo que el asiento cuadra sin residuo.
 */
export function hechoContableDelCierre(
  esperado: Decimal,
  difFuncional: Decimal,
  tasa: Decimal,
  escalaFuncional: number,
  /** Las unidades mínimas de la moneda DE LA CAJA: «en negativo» se decide en ellas. */
  escalaCaja: number,
): {
  readonly sourceKind: string;
  readonly palabra: string;
  readonly amounts: AmountContext;
} {
  // «En negativo» es MENOR QUE CERO en las unidades mínimas de la caja, y lo decide esta función.
  // No `isNegative()`: un saldo de −0,004 redondea a −0, que para Decimal «es negativo», y un
  // sobrante normal se asentaría con el origen del sobregiro (revisión de J-02, reproducido).
  const enLaCaja = esperado.toDecimalPlaces(escalaCaja, 4);
  if (!enLaCaja.lt(0)) {
    return {
      sourceKind: CASH_CLOSING_KIND,
      palabra: difFuncional.isNegative() ? "faltante" : "sobrante",
      // Con SIGNO: la plantilla decide el lado con if_positive / if_negative.
      amounts: { functional_amount: difFuncional.toFixed(8) },
    };
  }
  const delDueno = enLaCaja.negated().times(tasa).toDecimalPlaces(escalaFuncional, 4);
  return {
    sourceKind: CASH_CLOSING_OVERDRAFT_KIND,
    palabra: "sobregiro cubierto por el dueño",
    amounts: {
      total: difFuncional.toFixed(8),
      owner_contribution: delDueno.toFixed(8),
      functional_amount: difFuncional.minus(delDueno).toFixed(8),
    },
  };
}

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
  const [cuenta] = await sql<
    { currency: string; name: string; is_active: boolean; kind: string; is_system: boolean }[]
  >`
    select currency, name, is_active, kind, is_system from public.company_accounts
     where id = ${input.account_id} and company_id = ${input.company_id}
     for update`;
  if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // J-03 (ADR-0048, RESPUESTA §2.8): el cierre solo acepta CAJAS, y nadie lee el saldo de una
  // cuenta que su rol no ve. Con solo `cash.close` se ve la caja (no la de sistema, igual que
  // `listCompanyAccounts`): cualquier otra cuenta no existe para él. Quien sí la ve recibe el
  // motivo, nunca el saldo. Va ANTES del cálculo: el mensaje de la diferencia lleva lo esperado.
  const veTodo = (await companyScope(sql, actor.userId, input.company_id, "treasury.read")).ok;
  const esSuCaja = cuenta.kind === "cash" && (veTodo || !cuenta.is_system);
  if (!esSuCaja) {
    if (!veTodo) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se cierran cajas: «${cuenta.name}» no es una caja.`,
    });
  }
  if (!cuenta.is_active) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${cuenta.name}» está desactivada.`,
    });
  }

  const [saldo] = await sql<{ balance: string }[]>`
    select coalesce((select balance from public.company_account_balances
                      where account_id = ${input.account_id}), 0)::text as balance`;
  const esperadoCrudo = parseDecimal(saldo!.balance);
  const contadoCrudo = parseDecimal(input.counted_amount);
  if (!esperadoCrudo.ok || !contadoCrudo.ok) {
    return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
  }
  /**
   * EL ARQUEO CUENTA DINERO (ADR-0063 §6). Lo esperado, lo contado y la diferencia viven en
   * las unidades mínimas de la moneda: nadie puede contar «USD 4,49999982» ni encontrar un
   * faltante de ocho decimales en la gaveta (QA de pantalla 2026-09-15, h. 28). El saldo de
   * la cuenta conserva su escala; lo que se arquea es lo que se puede tocar.
   */
  const escalaCaja = minorUnitsOf(cuenta.currency);
  const esperado = { ok: true as const, value: esperadoCrudo.value.toDecimalPlaces(escalaCaja, 4) };
  const contado = { ok: true as const, value: contadoCrudo.value.toDecimalPlaces(escalaCaja, 4) };
  const diferencia = contado.value.minus(esperado.value);

  if (!diferencia.isZero() && input.reason === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Contaste ${contado.value.toFixed(escalaCaja)} y el sistema esperaba ${esperado.value.toFixed(escalaCaja)}. Explica en una línea de dónde sale la diferencia.`,
    });
  }

  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${input.company_id}`;
  const funcionalCode = empresa!.moneda;
  const tasa = await tasaHoy(sql, input.company_id, cuenta.currency, funcionalCode);
  if (!tasa.ok) return tasa;
  const tasaDec = parseDecimal(tasa.value.rate);
  if (!tasaDec.ok) return err({ code: "VALIDATION_FAILED", message: tasaDec.error.message });
  // El asiento del faltante o del sobrante, también en céntimos de la moneda de la empresa.
  const difFuncional = diferencia
    .times(tasaDec.value)
    .toDecimalPlaces(minorUnitsOf(funcionalCode), 4);

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
                  -- Un arqueo se sirve en céntimos: es lo que alguien contó (ADR-0063 §6).
                  round(expected_amount, platform.currency_minor_units(transaction_currency))::text
                    as expected_amount,
                  round(counted_amount, platform.currency_minor_units(transaction_currency))::text
                    as counted_amount,
                  round(amount_transaction_currency,
                        platform.currency_minor_units(transaction_currency))::text as difference,
                  reason,
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
  // J-02 (revisión, punto 7): lo que puso el dueño se dice SOLO si el cierre tiene su asiento (o
  // su fila de cola) del origen del sobregiro. La pantalla no afirma lo que el mayor no dice.
  let ownerContribution: string | null = null;
  if (!diferencia.isZero()) {
    const hecho = hechoContableDelCierre(
      esperado.value,
      difFuncional,
      tasaDec.value,
      minorUnitsOf(funcionalCode),
      escalaCaja,
    );
    const generado = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId: input.company_id,
      sourceKind: hecho.sourceKind,
      sourceEvent: CASH_CLOSING_EVENT,
      sourceId: cierre["id"] as string,
      postingDate: cierre["closing_date"] as string,
      postedBy: actor.userId,
      description: `Cierre de caja ${cuenta.name}: ${hecho.palabra}`,
      functionalCurrency: funcionalCode,
      amounts: hecho.amounts,
      backlink: { table: "cash_closings", id: cierre["id"] as string },
    });
    if (!generado.ok) {
      return err({ code: "VALIDATION_FAILED", message: generado.error.message });
    }
    accounting = generado.value.kind === "queued" ? "queued" : "posted";
    entryId = generado.value.kind === "queued" ? null : generado.value.entryId;
    if (hecho.sourceKind === CASH_CLOSING_OVERDRAFT_KIND) {
      ownerContribution = esperado.value.negated().toFixed(escalaCaja);
    }
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
    owner_contribution: ownerContribution,
    journal_entry_id: entryId,
    accounting,
  } as CashClosingResponse);
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
  /**
   * El DÍA del hecho (ADR-0066 §5). Una llegada fechada ayer se valora con la tasa de AYER, y la
   * pantalla tiene que enseñar esa, no la de hoy: si enseñara la de hoy, la persona confirmaría
   * un número y se guardaría otro. Por omisión, el día de Venezuela.
   */
  fecha?: string,
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
      from platform.rate_for(${companyId}, ${ancla}, ${funcional},
             coalesce(${fecha ?? null}::date, (now() at time zone 'America/Caracas')::date)) f`;
  if (!t) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: await explicarFaltaDeTasa(sql, ancla, funcional, fecha),
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
  const alcanza = await exigeSaldo(sql, input.from_account_id, importe.value.toAmountString(), {
    permitir: input.allow_negative_balance,
    motivo: input.overdraft_reason,
    operacion: "transfer",
  });
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
  // P-03 (ADR-0075 §7): el equivalente funcional de lo que sale de la caja va al céntimo,
  // half-up. Antes 4.278,3125 en la caja y en el mayor.
  const funcional = toCents(importe.value.amount.times(tasaDec.value));

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

/**
 * LAS CUENTAS CANDIDATAS (ADR-0067 §1): de dónde puede salir el dinero de este instrumento, en
 * esta moneda, **en el mismo orden en que las resolvería `resolverCuentaEfectivo`**. Comparten la
 * familia y el `order by` a propósito: si la pregunta de la pantalla y el último recurso del
 * servidor se ordenaran distinto, la primera opción de la lista no sería la que cae por omisión y
 * nadie entendería por qué.
 *
 * Devuelve TAMBIÉN la cuenta que fija una forma de pago configurada. Cuando la hay, no hay nada
 * que preguntar: para eso se configuró.
 *
 * El permiso es el de quien REGISTRA el movimiento, no el de quien ve el dinero, y por eso no
 * viaja ningún saldo (ADR-0048; la misma frontera del catálogo de formas de pago).
 */
export async function listCandidateAccounts(
  uow: UnitOfWork,
  companyId: string,
  functionalCurrency: string,
): Promise<Result<CandidatesByInstrument[], TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Elegir la cuenta exige un usuario." });
  }
  const ctx = await companyScope(sql, actor.userId, companyId, [
    "treasury.read",
    "cash.close",
    "sales.invoice.issue",
    "sales.payment.register",
    "purchase.payment.register",
    "expense.register",
  ]);
  if (!ctx.ok) return ctx;

  // Dos consultas para TODOS los instrumentos, no una por cada uno: el POS pinta ocho botones y
  // no va a hacer ocho viajes para saber a dónde lleva cada uno.
  const cuentas = await sql<
    { id: string; name: string; currency: string; kind: string; created_at: string }[]
  >`
    select ca.id, ca.name, ca.currency, ca.kind, ca.created_at::text as created_at
      from public.company_accounts ca
     where ca.company_id = ${companyId} and ca.is_active and not ca.is_system
     order by ca.created_at`;
  const metodos = await sql<{ kind: string; account_id: string; currency: string }[]>`
    select pm.kind, pm.account_id, ca.currency
      from public.payment_methods pm
      join public.company_accounts ca on ca.id = pm.account_id
     where pm.company_id = ${companyId} and pm.is_active and ca.is_active
     order by pm.created_at`;

  const filas: CandidatesByInstrument[] = [];
  for (const [instrument, cual] of Object.entries(MONEDA_DE_INSTRUMENTO)) {
    if (SIN_EFECTIVO.has(instrument)) continue;
    // «cualquiera» (tarjeta, otro) se resuelve en la moneda funcional: es la que la pantalla
    // ofrece por omisión, y quien liquide en otra la elige en su propia lista.
    const moneda = cual === "USD" ? "USD" : functionalCurrency;
    const familia = FAMILIA_DE_INSTRUMENTO[instrument] ?? ["cash", "bank", "wallet"];
    const propias = cuentas
      .filter((c) => c.currency === moneda && familia.includes(c.kind))
      // El MISMO orden que `resolverCuentaEfectivo`: por familia y luego por antigüedad. Si la
      // lista de la pantalla y el último recurso del servidor se ordenaran distinto, la primera
      // opción no sería la que cae por omisión y nadie entendería por qué.
      .sort(
        (a, b) =>
          familia.indexOf(a.kind) - familia.indexOf(b.kind) ||
          a.created_at.localeCompare(b.created_at),
      )
      .map(({ id, name, currency, kind }) => ({ id, name, currency, kind }));
    const fijada = metodos.find((m) => m.kind === instrument && m.currency === moneda);
    filas.push({
      instrument,
      currency: moneda,
      accounts: propias as CandidateAccountResponse[],
      fixed_by_method: fijada?.account_id ?? null,
    });
  }
  return ok(filas);
}

/**
 * EL INFORME de ADR-0067 §4: dónde cayó el dinero que nadie eligió. Solo lectura, y su respuesta
 * correcta no es cero — lo dice la migración 73 y lo repite aquí quien lo llame.
 */
export async function listMoneyLandingGaps(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<MoneyLandingGapResponse[], TreasuryError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver el informe exige un usuario real." });
  }
  const ctx = await companyScope(sql, actor.userId, companyId, "treasury.read");
  if (!ctx.ok) return ctx;
  const filas = await sql<MoneyLandingGapResponse[]>`
    select kind, movement_id, occurred_on::text as occurred_on, instrument,
           -- A las unidades mínimas de su moneda, igual que los saldos (ADR-0063 §4): el mismo
           -- dinero no puede leerse «USD 40,368» aquí y «USD 40,37» en la tarjeta de la cuenta.
           round(amount, platform.currency_minor_units(currency))::text as amount,
           currency, account_id, account_name, problem
      from platform.money_landing_gaps(${companyId})`;
  return ok(filas);
}

/**
 * El actor de un asiento que postea el SISTEMA, no una persona (la reparación de ADR-0070).
 * `journal_entries.posted_by` es obligatorio en un asiento posteado y no tiene FK: el uuid nulo
 * dice «nadie», y el acta en `audit_events` (actor_type = 'system') dice qué lo posteó.
 */
export const SYSTEM_POSTER_ID = "00000000-0000-0000-0000-000000000000";

export type TreasurySubaccountsRepair = {
  readonly company_id: string;
  readonly repaired: number;
  readonly skipped?: string;
  readonly entry_id?: string | null;
  readonly accounts?: JSONValue;
};

/**
 * REPARACIÓN ADR-0070 (J-01): cada caja que todavía apunta a la cuenta de su familia (1.1.01 /
 * 1.1.02) recibe su subcuenta, y su saldo se reclasifica con UN asiento por empresa.
 *
 * La base prepara (subcuentas + asiento en BORRADOR) y cierra (comprobación + acta); el POSTEO
 * vive aquí, en el dominio, como todo posteo de Ladino: ninguna función SQL postea asientos.
 * Las tres piezas van en la transacción de quien llama — una reparación a medias no existe.
 * Idempotente: una segunda llamada no encuentra nada que reparar y no escribe nada.
 *
 * No es un caso de uso de la API: lo corre el dueño de la base con
 * `node scripts/reparar/adr-0070-subcuentas.mjs`, después del git pull (RESPUESTA §7).
 */
export async function repairTreasurySubaccounts(
  sql: TransactionSql,
  companyId: string,
): Promise<TreasurySubaccountsRepair> {
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [p] = await sql<{ r: TreasurySubaccountsRepair & { posting_date?: string } }[]>`
    select platform.treasury_subaccounts_repair_prepare(${companyId}) as r`;
  const preparado = p!.r;
  if (preparado.entry_id) {
    const [num] = await sql<{ n: string }[]>`
      select platform.claim_entry_number(${companyId},
             extract(year from ${preparado.posting_date!}::date)::int)::text as n`;
    await sql`
      update public.journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${SYSTEM_POSTER_ID},
             entry_number = ${num!.n}::bigint
       where id = ${preparado.entry_id} and company_id = ${companyId} and status = 'draft'`;
    // El mismo rastro que el posteo manual (`postJournalEntry`, accounting.ts): `journal.posted`
    // en auditoría y en el outbox, con los mismos campos. Lo postea el sistema, no una persona.
    const [e] = await sql<
      {
        tenant_id: string;
        entry_number: number;
        posting_date: string;
        total_debit: string;
        description: string;
      }[]
    >`
      select e.tenant_id, e.entry_number::int as entry_number,
             e.posting_date::text as posting_date, e.description,
             (select sum(l.functional_debit) from public.journal_lines l
               where l.entry_id = e.id)::text as total_debit
        from public.journal_entries e
       where e.id = ${preparado.entry_id}`;
    const payload = {
      entry_number: e!.entry_number,
      posting_date: e!.posting_date,
      total_debit: e!.total_debit,
      description: e!.description,
    };
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${e!.tenant_id}, ${companyId}, 'journal_entry', ${preparado.entry_id},
              'journal.posted', 'system', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
    await sql`
      insert into public.outbox
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
      values (${e!.tenant_id}, ${companyId}, 'journal_entry', ${preparado.entry_id},
              'journal.posted', 1, ${sql.json({ id: preparado.entry_id, ...payload })})`;
  }
  const [f] = await sql<{ r: TreasurySubaccountsRepair }[]>`
    select platform.treasury_subaccounts_repair_finish(${sql.json(preparado)},
                                                       ${RULES_VERSION}) as r`;
  return f!.r;
}
