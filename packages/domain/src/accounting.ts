import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, parseDecimal, type Decimal } from "@ladino/money";
import { generateReversalLines, validateEntryBalance, type EntryLine } from "@ladino/accounting";
import type {
  CreateAccountRequest,
  UpdateAccountRequest,
  AccountResponse,
  ImportChartTemplateRequest,
  CreateJournalEntryRequest,
  PostJournalEntryRequest,
  ReverseJournalEntryRequest,
  JournalEntryResponse,
  ClosePeriodRequest,
  ReopenPeriodRequest,
  YearEndCloseRequest,
  SetAccountPurposeRequest,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * Casos de uso de CONTABILIDAD — RIGOR MÁXIMO, sin zonas.
 *
 * Lo que este módulo NO decide, y por eso no aparece escrito en ningún número:
 *   · si un asiento cuadra lo dice `platform.assert_entry_balanced()`, en
 *     Postgres, en moneda funcional. Aquí se comprueba ANTES solo para dar un
 *     mensaje útil con la diferencia exacta — **el invariante no vive aquí**;
 *   · a qué cuenta va cada importe lo dice el mapeo de la empresa (ADR-0041);
 *   · qué cuenta cumple cada papel lo dice `company_account_settings`, con
 *     vigencia por fecha.
 *
 * El orden de las operaciones importa: un asiento se construye en BORRADOR con
 * sus líneas y solo al final se postea, que es cuando el trigger valida partida
 * doble, período abierto y cuentas admisibles. Al revés dejaría un asiento a
 * medio hacer si algo falla.
 */
export type AccountingError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "ENTRY_UNBALANCED"; message: string }
  | { code: "PERIOD_CLOSED"; message: string }
  | { code: "ACCOUNT_NOT_POSTABLE"; message: string }
  | { code: "ACCOUNT_PURPOSE_MISSING"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string };

const NATURALEZA: Record<string, "deudora" | "acreedora"> = {
  activo: "deudora",
  gasto: "deudora",
  pasivo: "acreedora",
  patrimonio: "acreedora",
  ingreso: "acreedora",
};

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
}

function traducir(e: unknown): AccountingError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD59") return { code: "ENTRY_UNBALANCED", message };
  if (code === "LAD60") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD61") return { code: "PERIOD_CLOSED", message };
  if (code === "LAD62") return { code: "ACCOUNT_NOT_POSTABLE", message };
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "23505") {
    return { code: "DUPLICATE", message: "Ya existe un registro con esos datos." };
  }
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  if (code === "23P01") {
    return {
      code: "DUPLICATE",
      message:
        "Ya hay una cuenta vigente para ese papel: dos a la vez sería un asiento que no se sabe dónde va.",
    };
  }
  return null;
}

async function autorizar(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
): Promise<Result<Contexto, AccountingError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [cfg] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok({ tenantId: scope.value.tenantId, functionalCurrency: cfg.moneda });
}

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  aggregateId: string,
  evento: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'journal_entry', ${aggregateId}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${tenantId}, ${companyId}, 'journal_entry', ${aggregateId}, ${evento}, 1,
            ${sql.json({ id: aggregateId, ...payload })})`;
}

// ── Plan de cuentas ─────────────────────────────────────────────────────────

export async function createAccount(
  uow: UnitOfWork,
  input: CreateAccountRequest,
): Promise<Result<AccountResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Crear cuentas exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.account.manage");
  if (!ctx.ok) return ctx;

  // La naturaleza la impone el tipo. Si el llamante manda otra, se rechaza
  // aquí con un mensaje que lo explica en vez de dejar salir un 23514 opaco.
  const derivada = NATURALEZA[input.kind] ?? null;
  if (input.nature !== undefined && derivada !== null && input.nature !== derivada) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Una cuenta de ${input.kind} es de naturaleza ${derivada}, no ${input.nature}: la naturaleza la impone el tipo.`,
    });
  }
  const nature = input.nature ?? derivada ?? "deudora";

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const fila = await sql.savepoint(async (sp) => {
      const [a] = await sp<AccountResponse[]>`
        insert into public.accounts
          (tenant_id, company_id, code, name, description, parent_id, kind, nature,
           currency_code, requires_analytical, rules_version)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.code}, ${input.name},
                ${input.description ?? null}, ${input.parent_id ?? null}, ${input.kind},
                ${nature}, ${input.currency_code ?? null},
                ${input.requires_analytical ?? false}, ${RULES_VERSION})
        returning id, company_id, code, name, description, parent_id, kind, nature, is_leaf,
                  is_active, currency_code, requires_analytical, level::int as level, path`;
      return a!;
    });
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      fila.id,
      "accounting.account_created",
      {
        code: fila.code,
        name: fila.name,
        kind: fila.kind,
      },
    );
    return ok(fila);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) {
      return err(
        conocido.code === "DUPLICATE"
          ? { code: "DUPLICATE", message: `Ya existe una cuenta con el código ${input.code}.` }
          : conocido,
      );
    }
    throw e;
  }
}

/**
 * Actualiza una cuenta. **Solo lo no estructural**: nombre, descripción y si
 * exige analíticas. El código, el tipo y el padre no se tocan una vez creada —
 * renumerar o remover una cuenta con movimientos reescribiría el pasado del
 * mayor sin tocar un solo asiento, que es la peor forma de romperlo.
 */
export async function updateAccount(
  uow: UnitOfWork,
  accountId: string,
  input: UpdateAccountRequest,
): Promise<Result<AccountResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Editar cuentas exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.account.manage");
  if (!ctx.ok) return ctx;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [a] = await sql<AccountResponse[]>`
    update public.accounts
       set name = coalesce(${input.name ?? null}, name),
           description = case when ${input.description !== undefined}
                              then ${input.description ?? null} else description end,
           requires_analytical = coalesce(${input.requires_analytical ?? null},
                                          requires_analytical)
     where id = ${accountId} and company_id = ${input.company_id}
    returning id, company_id, code, name, description, parent_id, kind, nature, is_leaf,
              is_active, currency_code, requires_analytical, level::int as level, path`;
  if (!a) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok(a);
}

/**
 * Desactiva una cuenta. No la borra: `CHART_OF_ACCOUNTS_SPEC` es explícito —
 * «desactivar cuenta con saldo no borra histórico». Borrarla dejaría asientos
 * apuntando al vacío, y el mayor de años anteriores sin cuenta que mostrar.
 */
export async function deactivateAccount(
  uow: UnitOfWork,
  accountId: string,
  companyId: string,
): Promise<Result<AccountResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Desactivar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, companyId, "accounting.account.manage");
  if (!ctx.ok) return ctx;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [a] = await sql<AccountResponse[]>`
    update public.accounts set is_active = false
     where id = ${accountId} and company_id = ${companyId}
    returning id, company_id, code, name, description, parent_id, kind, nature, is_leaf,
              is_active, currency_code, requires_analytical, level::int as level, path`;
  if (!a) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  await auditar(sql, ctx.value.tenantId, companyId, accountId, "accounting.account_deactivated", {
    code: a.code,
  });
  return ok(a);
}

/**
 * Importa una plantilla de plan de cuentas (ADR-0043). Copia las cuentas al
 * plan de la empresa y **las desliga**: a partir de aquí son suyas.
 *
 * Se importa en orden de nivel para que cada padre exista antes que sus hijos,
 * y el trigger del esquema calcula el path y marca los padres como no-hoja.
 */
export async function importChartTemplate(
  uow: UnitOfWork,
  input: ImportChartTemplateRequest,
): Promise<Result<{ imported: number; purposes: number }, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Importar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.account.manage");
  if (!ctx.ok) return ctx;

  const [existentes] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.accounts where company_id = ${input.company_id}`;
  if ((existentes?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La empresa ya tiene plan de cuentas. Importar sobre uno existente mezclaría dos planes y dejaría códigos duplicados o huérfanos: crea las cuentas que falten a mano.",
    });
  }

  const plantilla = await sql<
    {
      code: string;
      name: string;
      parent_code: string | null;
      kind: string;
      nature: string;
      level: number;
      suggested_purpose: string | null;
    }[]
  >`select code, name, parent_code, kind, nature, level::int as level, suggested_purpose
      from public.chart_template_accounts
     where template_code = ${input.template_code}
     order by level, code`;
  if (plantilla.length === 0) {
    return err({ code: "NOT_FOUND", message: "Esa plantilla de plan de cuentas no existe." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const porCodigo = new Map<string, string>();
  let importadas = 0;
  try {
    for (const c of plantilla) {
      const padre = c.parent_code === null ? null : (porCodigo.get(c.parent_code) ?? null);
      const [a] = await sql<{ id: string }[]>`
        insert into public.accounts
          (tenant_id, company_id, code, name, parent_id, kind, nature, rules_version)
        values (${ctx.value.tenantId}, ${input.company_id}, ${c.code}, ${c.name}, ${padre},
                ${c.kind}, ${c.nature}, ${RULES_VERSION})
        returning id`;
      porCodigo.set(c.code, a!.id);
      importadas += 1;
    }
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  let papeles = 0;
  if (input.apply_suggested_purposes !== false) {
    for (const c of plantilla) {
      if (c.suggested_purpose === null) continue;
      await sql`
        insert into public.company_account_settings
          (tenant_id, company_id, purpose, account_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${c.suggested_purpose},
                ${porCodigo.get(c.code)!})`;
      papeles += 1;
    }
  }

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    input.company_id,
    "accounting.chart_imported",
    {
      template_code: input.template_code,
      imported: importadas,
      purposes: papeles,
    },
  );
  return ok({ imported: importadas, purposes: papeles });
}

export async function setAccountPurpose(
  uow: UnitOfWork,
  input: SetAccountPurposeRequest,
): Promise<Result<{ purpose: string; account_id: string }, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Configurar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.template.manage");
  if (!ctx.ok) return ctx;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    // La vigencia anterior se CIERRA, no se borra (ADR-0029): los asientos que
    // ya resolvieron con la cuenta antigua siguen siendo explicables.
    await sql`
      update public.company_account_settings set effective_to = now()
       where company_id = ${input.company_id} and purpose = ${input.purpose}
         and effective_to is null`;
    await sql.savepoint(
      (sp) => sp`
        insert into public.company_account_settings (tenant_id, company_id, purpose, account_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.purpose}, ${input.account_id})`,
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  return ok({ purpose: input.purpose, account_id: input.account_id });
}

// ── Asientos ────────────────────────────────────────────────────────────────

const ENTRY_COLUMNS = `id, company_id, period_id, entry_number::int as entry_number,
  posting_date::text as posting_date, source_kind, source_id, source_event, description, memo,
  status,
  to_char(posted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as posted_at,
  is_reversal_of, reversed_by_entry_id, rules_version`;

async function conTotales(
  sql: TransactionSql,
  entrada: Record<string, unknown>,
): Promise<JournalEntryResponse> {
  const [t] = await sql<{ d: string; c: string }[]>`
    select coalesce(sum(functional_debit), 0)::text as d,
           coalesce(sum(functional_credit), 0)::text as c
      from public.journal_lines where entry_id = ${entrada["id"] as string}`;
  return {
    ...entrada,
    total_debit: t?.d ?? "0",
    total_credit: t?.c ?? "0",
  } as JournalEntryResponse;
}

/**
 * Crea un asiento manual en BORRADOR. No postea: postear es un acto propio, con
 * su permiso, porque es el que lo hace inmutable.
 *
 * El balance se comprueba aquí para dar la diferencia exacta —encontrar la línea
 * que falta sin ella obliga a volver a sumar, y quien vuelve a sumar suma
 * distinto—, pero **el invariante real es el trigger**: este chequeo puede
 * quitarse y el asiento descuadrado seguiría sin poder postearse.
 */
export async function createManualJournalEntry(
  uow: UnitOfWork,
  input: CreateJournalEntryRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Asentar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.entry.create");
  if (!ctx.ok) return ctx;

  // Las líneas, a moneda funcional. Un asiento manual va en funcional con tasa
  // 1; si algún día se admiten líneas en otra moneda, la conversión entra aquí
  // y los siete campos de ADR-0020 ya están en el esquema para recibirla.
  const lineas: EntryLine[] = [];
  for (const [i, l] of input.lines.entries()) {
    const tieneDebito = (l.debit ?? "") !== "";
    const tieneCredito = (l.credit ?? "") !== "";
    if (tieneDebito === tieneCredito) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La línea ${i + 1} tiene que ser débito o crédito, exactamente uno de los dos.`,
      });
    }
    const debito = Money.of(l.debit ?? "0", ctx.value.functionalCurrency);
    const credito = Money.of(l.credit ?? "0", ctx.value.functionalCurrency);
    if (!debito.ok || !credito.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe no interpretable." });
    }
    lineas.push({ accountId: l.account_id, debit: debito.value, credit: credito.value });
  }

  const balance = validateEntryBalance(lineas, ctx.value.functionalCurrency);
  if (!balance.ok) {
    return err({ code: "VALIDATION_FAILED", message: balance.error.message });
  }
  if (!balance.value.balanced) {
    return err({
      code: "ENTRY_UNBALANCED",
      message: `La partida doble no cuadra: débitos ${balance.value.totalDebit.toAmountString()} contra créditos ${balance.value.totalCredit.toAmountString()}, diferencia ${balance.value.difference.toFixed(8)}.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const entrada = await sql.savepoint(async (sp) => {
      const [periodo] = await sp<{ id: string }[]>`
        select platform.period_for_date(${input.company_id}, ${input.posting_date}::date) as id`;
      const [e] = await sp<Record<string, unknown>[]>`
        insert into public.journal_entries
          (tenant_id, company_id, period_id, posting_date, source_kind, description, memo,
           rules_version)
        values (${ctx.value.tenantId}, ${input.company_id}, ${periodo!.id},
                ${input.posting_date}::date, 'manual', ${input.description},
                ${input.memo ?? null}, ${RULES_VERSION})
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;

      let n = 0;
      for (const [i, l] of input.lines.entries()) {
        n += 1;
        const linea = lineas[i]!;
        await sp`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit, analytical_dimensions, description)
          values (${ctx.value.tenantId}, ${input.company_id}, ${e!["id"] as string}, ${n},
                  ${l.account_id}, ${linea.debit.toAmountString()},
                  ${linea.credit.toAmountString()},
                  ${linea.debit.amount.isZero() ? linea.credit.toAmountString() : linea.debit.toAmountString()},
                  ${ctx.value.functionalCurrency}, 1,
                  ${linea.debit.amount.isZero() ? linea.credit.toAmountString() : linea.debit.toAmountString()},
                  ${ctx.value.functionalCurrency}, 'identidad', now(),
                  ${linea.debit.toAmountString()}, ${linea.credit.toAmountString()},
                  ${l.analytical_dimensions === undefined ? null : sp.json(l.analytical_dimensions)},
                  ${l.description ?? null})`;
      }
      return e!;
    });
    return ok(await conTotales(sql, entrada));
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/** Postea un asiento: el acto que lo hace inmutable y lo lleva al mayor. */
export async function postJournalEntry(
  uow: UnitOfWork,
  entryId: string,
  input: PostJournalEntryRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Postear exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.entry.post");
  if (!ctx.ok) return ctx;

  const [entrada] = await sql<{ status: string; posting_date: string }[]>`
    select status, posting_date::text as posting_date from public.journal_entries
     where id = ${entryId} and company_id = ${input.company_id}`;
  if (!entrada) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (entrada.status !== "draft") {
    return err({
      code: "VALIDATION_FAILED",
      message: `El asiento está en ${entrada.status}: solo se postea un borrador.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const posteado = await sql.savepoint(async (sp) => {
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_entry_number(${input.company_id},
               extract(year from ${entrada.posting_date}::date)::int)::text as n`;
      const [e] = await sp<Record<string, unknown>[]>`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actor.userId},
               entry_number = ${num!.n}::bigint
         where id = ${entryId} and company_id = ${input.company_id}
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;
      return e!;
    });
    const conTot = await conTotales(sql, posteado);
    await auditar(sql, ctx.value.tenantId, input.company_id, entryId, "journal.posted", {
      entry_number: conTot.entry_number,
      posting_date: conTot.posting_date,
      total_debit: conTot.total_debit,
      description: conTot.description,
    });
    return ok(conTot);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * Reversa un asiento posteado con un contra-asiento vinculado. **No lo borra ni
 * lo edita**: los dos quedan visibles en la cuenta y el saldo neto es cero, que
 * es lo que hace auditable la corrección.
 *
 * El contra-asiento lleva SU PROPIO número: reversar consume correlativo, no lo
 * libera. El original conserva el suyo.
 */
export async function reverseJournalEntry(
  uow: UnitOfWork,
  entryId: string,
  input: ReverseJournalEntryRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Reversar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.entry.reverse");
  if (!ctx.ok) return ctx;

  const [original] = await sql<{ status: string; description: string }[]>`
    select status, description from public.journal_entries
     where id = ${entryId} and company_id = ${input.company_id}`;
  if (!original) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (original.status !== "posted") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se reversa un asiento posteado; este está en ${original.status}.`,
    });
  }

  const lineasOriginales = await sql<
    {
      account_id: string;
      functional_debit: string;
      functional_credit: string;
      analytical_dimensions: Record<string, string> | null;
      description: string | null;
    }[]
  >`select account_id, functional_debit::text as functional_debit,
           functional_credit::text as functional_credit, analytical_dimensions, description
      from public.journal_lines where entry_id = ${entryId} order by line_number`;

  const entryLines: EntryLine[] = [];
  for (const l of lineasOriginales) {
    const debito = Money.of(l.functional_debit, ctx.value.functionalCurrency);
    const credito = Money.of(l.functional_credit, ctx.value.functionalCurrency);
    if (!debito.ok || !credito.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe original no interpretable." });
    }
    entryLines.push({ accountId: l.account_id, debit: debito.value, credit: credito.value });
  }
  const reversas = generateReversalLines(entryLines);
  if (!reversas.ok) {
    return err({ code: "VALIDATION_FAILED", message: reversas.error.message });
  }

  const fecha = input.posting_date ?? new Date().toISOString().slice(0, 10);
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const contra = await sql.savepoint(async (sp) => {
      const [periodo] = await sp<{ id: string }[]>`
        select platform.period_for_date(${input.company_id}, ${fecha}::date) as id`;
      const [e] = await sp<Record<string, unknown>[]>`
        insert into public.journal_entries
          (tenant_id, company_id, period_id, posting_date, source_kind, description, memo,
           is_reversal_of, rules_version)
        values (${ctx.value.tenantId}, ${input.company_id}, ${periodo!.id}, ${fecha}::date,
                'manual', ${`Reversión: ${original.description}`}, ${input.reason},
                ${entryId}, ${RULES_VERSION})
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;

      let n = 0;
      for (const [i, l] of reversas.value.entries()) {
        n += 1;
        const orig = lineasOriginales[i]!;
        const importe = l.debit.amount.isZero() ? l.credit : l.debit;
        await sp`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit, analytical_dimensions, description)
          values (${ctx.value.tenantId}, ${input.company_id}, ${e!["id"] as string}, ${n},
                  ${l.accountId}, ${l.debit.toAmountString()}, ${l.credit.toAmountString()},
                  ${importe.toAmountString()}, ${ctx.value.functionalCurrency}, 1,
                  ${importe.toAmountString()}, ${ctx.value.functionalCurrency}, 'identidad',
                  now(), ${l.debit.toAmountString()}, ${l.credit.toAmountString()},
                  ${orig.analytical_dimensions === null ? null : sp.json(orig.analytical_dimensions)},
                  ${orig.description})`;
      }

      const [num] = await sp<{ n: string }[]>`
        select platform.claim_entry_number(${input.company_id},
               extract(year from ${fecha}::date)::int)::text as n`;
      const [posteado] = await sp<Record<string, unknown>[]>`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actor.userId},
               entry_number = ${num!.n}::bigint
         where id = ${e!["id"] as string}
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;

      // El original pasa a `reversed` y guarda el enlace. Conserva su número.
      await sp`
        update public.journal_entries
           set status = 'reversed', reversed_by_entry_id = ${e!["id"] as string}
         where id = ${entryId}`;
      return posteado!;
    });
    const conTot = await conTotales(sql, contra);
    await auditar(sql, ctx.value.tenantId, input.company_id, conTot.id, "journal.reversed", {
      reversal_of: entryId,
      reason: input.reason,
      entry_number: conTot.entry_number,
    });
    return ok(conTot);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

// ── Períodos ────────────────────────────────────────────────────────────────

/**
 * Cierra un período. **Rechaza si quedan borradores o pendientes de
 * contabilizar**: un borrador es una decisión no tomada y cerrar por encima lo
 * descarta en silencio; una cola sin procesar es contabilidad que falta
 * (ADR-0042 §Consecuencias).
 */
export async function closeFiscalPeriod(
  uow: UnitOfWork,
  periodId: string,
  input: ClosePeriodRequest,
): Promise<Result<{ id: string; status: string }, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cerrar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.period.close");
  if (!ctx.ok) return ctx;

  const [periodo] = await sql<{ status: string; year: number; month: number }[]>`
    select status, year, month from public.fiscal_periods
     where id = ${periodId} and company_id = ${input.company_id}`;
  if (!periodo) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (periodo.status === "closed") {
    return err({ code: "VALIDATION_FAILED", message: "El período ya está cerrado." });
  }

  const [borradores] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.journal_entries
     where company_id = ${input.company_id} and period_id = ${periodId} and status = 'draft'`;
  if ((borradores?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Quedan ${borradores!.n} asiento(s) en borrador en el período. Postéalos o descártalos: cerrar por encima los descartaría en silencio.`,
    });
  }
  const [pendientes] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.journal_generation_queue
     where company_id = ${input.company_id} and status = 'pending'`;
  if ((pendientes?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Hay ${pendientes!.n} documento(s) pendientes de contabilizar. Un período cerrado con la cola llena es contabilidad que falta y que ya nadie va a poder asentar en su fecha.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [cerrado] = await sql<{ id: string; status: string }[]>`
    update public.fiscal_periods
       set status = 'closed', closed_at = now(), closed_by = ${actor.userId}
     where id = ${periodId} and company_id = ${input.company_id}
    returning id, status`;
  await auditar(sql, ctx.value.tenantId, input.company_id, periodId, "accounting.period_closed", {
    year: periodo.year,
    month: periodo.month,
  });
  return ok(cerrado!);
}

/** Reabre un período. Exige permiso propio y motivo escrito, y deja traza. */
export async function reopenFiscalPeriod(
  uow: UnitOfWork,
  periodId: string,
  input: ReopenPeriodRequest,
): Promise<Result<{ id: string; status: string }, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Reabrir exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.period.reopen");
  if (!ctx.ok) return ctx;

  const [periodo] = await sql<{ status: string; year: number; month: number }[]>`
    select status, year, month from public.fiscal_periods
     where id = ${periodId} and company_id = ${input.company_id}`;
  if (!periodo) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (periodo.status !== "closed") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se reabre un período cerrado; este está en ${periodo.status}.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const [reabierto] = await sql<{ id: string; status: string }[]>`
      update public.fiscal_periods
         set status = 'reopened', reopened_at = now(), reopened_by = ${actor.userId},
             reopened_reason = ${input.reason}
       where id = ${periodId} and company_id = ${input.company_id}
      returning id, status`;
    // La traza va a auditoría con el MOTIVO. Sin él, «¿por qué se reabrió
    // febrero?» no tiene respuesta seis meses después.
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      periodId,
      "accounting.period_reopened",
      {
        year: periodo.year,
        month: periodo.month,
        reason: input.reason,
      },
    );
    return ok(reabierto!);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * Cierre anual: lleva ingresos y gastos a Resultado del ejercicio, y el
 * resultado a Utilidades o pérdidas acumuladas.
 *
 * Exige que `year_result` y `retained_earnings` estén configuradas. Sin ellas
 * no cierra, y lo dice: adivinar qué cuenta es el resultado del ejercicio sería
 * inventar el patrimonio de una empresa.
 */
export async function executeYearEndClose(
  uow: UnitOfWork,
  input: YearEndCloseRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cerrar el año exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.period.close");
  if (!ctx.ok) return ctx;

  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select purpose, account_id from public.company_account_settings
     where company_id = ${input.company_id} and purpose in ('year_result', 'retained_earnings')
       and effective_to is null`;
  const resultado = papeles.find((p) => p.purpose === "year_result");
  const acumuladas = papeles.find((p) => p.purpose === "retained_earnings");
  if (!resultado || !acumuladas) {
    const faltan = [
      resultado ? null : "year_result",
      acumuladas ? null : "retained_earnings",
    ].filter((x) => x !== null);
    return err({
      code: "ACCOUNT_PURPOSE_MISSING",
      message: `El cierre anual exige las cuentas de ${faltan.join(" y ")}. Configúralas antes: adivinar cuál es el resultado del ejercicio sería inventar el patrimonio de la empresa.`,
    });
  }

  const desde = `${input.year}-01-01`;
  const hasta = `${input.year}-12-31`;
  const saldos = await sql<{ account_id: string; kind: string; saldo: string }[]>`
    select a.id as account_id, a.kind,
           (coalesce(sum(jl.functional_debit), 0)
            - coalesce(sum(jl.functional_credit), 0))::text as saldo
      from public.accounts a
      join public.journal_lines jl on jl.account_id = a.id
      join public.journal_entries e on e.id = jl.entry_id
     where a.company_id = ${input.company_id} and a.kind in ('ingreso', 'gasto')
       and e.status in ('posted', 'reversed')
       and e.posting_date between ${desde}::date and ${hasta}::date
     group by a.id, a.kind
    having (coalesce(sum(jl.functional_debit), 0)
            - coalesce(sum(jl.functional_credit), 0)) <> 0`;

  if (saldos.length === 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `No hay saldos de ingresos ni gastos en ${input.year}: no hay nada que cerrar.`,
    });
  }

  // Cada cuenta de resultado se lleva a cero por su lado contrario, y la
  // diferencia va a Resultado del ejercicio. Que la contrapartida sea UNA sola
  // línea es lo que hace que el asiento cuadre por construcción.
  const cero = parseDecimal("0");
  if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
  let neto: Decimal = cero.value;
  const lineas: { account_id: string; debit: string; credit: string }[] = [];
  for (const s of saldos) {
    const saldo = parseDecimal(s.saldo);
    if (!saldo.ok) return err({ code: "VALIDATION_FAILED", message: saldo.error.message });
    neto = neto.plus(saldo.value);
    if (saldo.value.isNegative()) {
      lineas.push({
        account_id: s.account_id,
        debit: saldo.value.negated().toFixed(8),
        credit: "0",
      });
    } else {
      lineas.push({ account_id: s.account_id, debit: "0", credit: saldo.value.toFixed(8) });
    }
  }
  // `neto` = débitos − créditos de resultado. Positivo = pérdida (gastos
  // mayores); negativo = utilidad. La contrapartida invierte el signo.
  if (neto.isNegative()) {
    lineas.push({
      account_id: acumuladas.account_id,
      debit: "0",
      credit: neto.negated().toFixed(8),
    });
  } else if (!neto.isZero()) {
    lineas.push({ account_id: acumuladas.account_id, debit: neto.toFixed(8), credit: "0" });
  } else {
    return err({
      code: "VALIDATION_FAILED",
      message: "El resultado del ejercicio es cero: el asiento de cierre no tendría contrapartida.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const asiento = await sql.savepoint(async (sp) => {
      const [periodo] = await sp<{ id: string }[]>`
        select platform.period_for_date(${input.company_id}, ${hasta}::date) as id`;
      const [e] = await sp<Record<string, unknown>[]>`
        insert into public.journal_entries
          (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
           description, rules_version)
        values (${ctx.value.tenantId}, ${input.company_id}, ${periodo!.id}, ${hasta}::date,
                'year_end_close', ${input.company_id},
                ${`accounting.year_end_close.${input.year}`},
                ${`Cierre del ejercicio ${input.year}`}, ${RULES_VERSION})
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;
      let n = 0;
      for (const l of lineas) {
        n += 1;
        const importe = l.debit === "0" ? l.credit : l.debit;
        await sp`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit)
          values (${ctx.value.tenantId}, ${input.company_id}, ${e!["id"] as string}, ${n},
                  ${l.account_id}, ${l.debit}, ${l.credit}, ${importe},
                  ${ctx.value.functionalCurrency}, 1, ${importe},
                  ${ctx.value.functionalCurrency}, 'identidad', now(), ${l.debit}, ${l.credit})`;
      }
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_entry_number(${input.company_id}, ${input.year})::text as n`;
      const [posteado] = await sp<Record<string, unknown>[]>`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actor.userId},
               entry_number = ${num!.n}::bigint
         where id = ${e!["id"] as string}
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;
      return posteado!;
    });
    const conTot = await conTotales(sql, asiento);
    await auditar(
      sql,
      ctx.value.tenantId,
      input.company_id,
      conTot.id,
      "accounting.year_end_closed",
      {
        year: input.year,
        accounts_closed: saldos.length,
        result: neto.negated().toFixed(8),
      },
    );
    return ok(conTot);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}
