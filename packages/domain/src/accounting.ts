import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import { Money, isAtCents, parseDecimal, toCents, type Decimal } from "@ladino/money";
import { generateReversalLines, validateEntryBalance, type EntryLine } from "@ladino/accounting";
import type {
  CreateAccountRequest,
  UpdateAccountRequest,
  AccountResponse,
  ImportChartTemplateRequest,
  CreateJournalEntryRequest,
  PostJournalEntryRequest,
  ReverseJournalEntryRequest,
  DiscardJournalEntryRequest,
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
  | { code: "PERIOD_OUT_OF_RANGE"; message: string }
  | { code: "ACCOUNT_NOT_POSTABLE"; message: string }
  | { code: "ACCOUNT_PURPOSE_MISSING"; message: string }
  | { code: "ENTRY_GENERATED_BY_DOCUMENT"; message: string }
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

/** ADR-0075 §7: «ningún importe del mayor con más de dos decimales». El mensaje de persona. */
const MENSAJE_CENTIMO = "Los importes del asiento llevan como máximo dos decimales.";

function traducir(e: unknown): AccountingError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD59") return { code: "ENTRY_UNBALANCED", message };
  if (code === "LAD60") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD61") return { code: "PERIOD_CLOSED", message };
  // ADR-0069 §3: antes del inicio de actividades o más allá del período en curso.
  if (code === "LAD91") return { code: "PERIOD_OUT_OF_RANGE", message };
  // ADR-0069 §2: el período de cierre solo admite el cierre y los ajustes del contador.
  if (code === "LAD92") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD62") return { code: "ACCOUNT_NOT_POSTABLE", message };
  // ADR-0075 §7 (C5c): la base rechaza al postear una línea que no esté al céntimo.
  if (code === "LAD71") return { code: "VALIDATION_FAILED", message: MENSAJE_CENTIMO };
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
  /** Quién lo hizo: una persona, o el sistema (una reparación que corre el dueño de la base). */
  actorType: "user" | "system" = "user",
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${companyId}, 'journal_entry', ${aggregateId}, ${evento},
            ${actorType}, now(), ${RULES_VERSION}, ${sql.json(payload)})`;
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
    // ADR-0055: el PRIMER papel rige desde siempre; los siguientes, desde ahora.
    await sql.savepoint(
      (sp) => sp`
        insert into public.company_account_settings
          (tenant_id, company_id, purpose, account_id, effective_from)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.purpose}, ${input.account_id},
                case when exists (select 1 from public.company_account_settings
                                   where company_id = ${input.company_id}
                                     and purpose = ${input.purpose}
                                     and effective_to is not null)
                     then now() else '-infinity'::timestamptz end)`,
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
    // ADR-0075 §7 (C5c): el mayor va al céntimo y el asiento manual era la puerta abierta. Se
    // rechaza aquí con el mensaje de persona; el invariante real es el trigger (LAD71), que
    // rechaza al postear aunque este chequeo se quite.
    if (!isAtCents(debito.value.amount) || !isAtCents(credito.value.amount)) {
      return err({ code: "VALIDATION_FAILED", message: MENSAJE_CENTIMO });
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

  // ADR-0069 §2: un ajuste del contador puede ir al período de cierre («13»), que se
  // fecha el 31-12. Comparación de TEXTO de la fecha ISO: sin reloj ni huso de por medio.
  const alCierre = input.closing_period === true;
  if (alCierre && !input.posting_date.endsWith("-12-31")) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un ajuste del período de cierre se fecha el 31 de diciembre del ejercicio.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const entrada = await sql.savepoint(async (sp) => {
      const [periodo] = alCierre
        ? await sp<{ id: string }[]>`
            select platform.closing_period_for_year(${input.company_id},
                   ${Number(input.posting_date.slice(0, 4))}::int) as id`
        : await sp<{ id: string }[]>`
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
      // ADR-0079 (quinta pasada, B2): la versión de reglas se congela en el HECHO contable, que es
      // el posteo, no el día en que se guardó el borrador. Postear DECLARA DE NUEVO —como ventas
      // al emitir— y la base sella la vigente (el trigger solo ve el UPDATE si nombra la columna).
      const [e] = await sp<Record<string, unknown>[]>`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${actor.userId},
               entry_number = ${num!.n}::bigint, rules_version = ${RULES_VERSION}
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
  return reversar(uow, entryId, input, "accounting.entry.reverse", {});
}

/**
 * LA REVERSA QUE HACE UNA ANULACIÓN (ADR-0068 §1). El paso interior lo autoriza
 * la operación que lo contiene: quien puede anular la venta (`sales.invoice.annul`)
 * reversa su asiento sin tener `accounting.entry.reverse`, que abre la reversa
 * SUELTA de asientos manuales. Solo la llama `annulInvoice`.
 */
export async function reverseJournalEntryForAnnulment(
  uow: UnitOfWork,
  entryId: string,
  input: ReverseJournalEntryRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  return reversar(uow, entryId, input, "sales.invoice.annul", { desdeDocumento: true });
}

/**
 * LA REVERSA QUE HACE LA REVERSA DE UN COBRO (ADR-0075 §8, R-61). Mismo principio que la de la
 * anulación (ADR-0068 §1): el paso interior lo autoriza la operación que lo contiene —
 * `ar.payment.reverse` para un cobro, `ar.retention.correct` para el abono de una retención
 * soportada—. Solo la llama `reversePayment`, que mueve a la vez la caja y el saldo del documento.
 */
export async function reverseJournalEntryForPaymentReversal(
  uow: UnitOfWork,
  entryId: string,
  input: ReverseJournalEntryRequest,
  permiso: "ar.payment.reverse" | "ar.retention.correct",
): Promise<Result<JournalEntryResponse, AccountingError>> {
  return reversar(uow, entryId, input, permiso, { desdeDocumento: true });
}

async function reversar(
  uow: UnitOfWork,
  entryId: string,
  input: ReverseJournalEntryRequest,
  permiso:
    | "accounting.entry.reverse"
    | "sales.invoice.annul"
    | "accounting.period.reopen"
    | "ar.payment.reverse"
    | "ar.retention.correct",
  /**
   * `desdeDocumento`: la reversa la pide el caso de uso DEL DOCUMENTO (anular una venta),
   * que mueve kardex, saldo y asiento a la vez. Sin eso, solo se reversan asientos manuales.
   */
  opciones: {
    readonly desdeDocumento?: boolean;
    /** El contra-asiento va al PERÍODO DE CIERRE de ese ejercicio (reabrir el 13, ADR-0069). */
    readonly alCierre?: number;
  },
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Reversar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso);
  if (!ctx.ok) return ctx;

  const [original] = await sql<{ status: string; description: string; source_kind: string }[]>`
    select status, description, source_kind from public.journal_entries
     where id = ${entryId} and company_id = ${input.company_id}`;
  if (!original) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // Un asiento GENERADO por un documento (venta, costo, cobro, compra, movimiento…) no se
  // reversa suelto: el contra-asiento no toca el kardex, ni el saldo de la caja, ni el
  // documento, y el mayor deja de reproducir el inventario (QA de pantalla 2026-09-15,
  // h. 67: inventory_ledger_gap pasó de 0 a −900). Se corrige desde su documento.
  if (original.source_kind !== "manual" && opciones.desdeDocumento !== true) {
    return err({
      code: "ENTRY_GENERATED_BY_DOCUMENT",
      message: `Este asiento lo generó un documento («${original.description}»). Se corrige desde ese documento —anulando o devolviendo la venta, o con su nota— y no reversando el asiento: el contra-asiento suelto no mueve el inventario ni el dinero.`,
    });
  }
  if (original.status !== "posted") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se reversa un asiento posteado; este está en ${original.status}.`,
    });
  }

  return contraAsiento(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    functionalCurrency: ctx.value.functionalCurrency,
    entryId,
    description: original.description,
    reason: input.reason,
    fecha: input.posting_date ?? diaNegocio(new Date()),
    ...(opciones.alCierre === undefined ? {} : { alCierre: opciones.alCierre }),
    postedBy: actor.userId,
  });
}

/**
 * EL CONTRA-ASIENTO, UNA SOLA IMPLEMENTACIÓN. Lo usan la reversa de una persona (`reversar`,
 * que autoriza y decide si ese asiento se puede reversar) y la reparación J-02
 * (`repairOverdraftClosings`, que corre el dueño de la base y postea como el sistema). Va AL
 * CÉNTIMO (ADR-0075 §7): un original anterior al corte con fracción se reversa redondeado, con
 * su línea de «Diferencias por redondeo»; el espejo crudo lo rechazaría la base (LAD71).
 *
 * `cuentaSiAgrupa`: la cuenta donde reversar una línea asentada en una cuenta que HOY agrupa.
 * Un cierre de caja anterior a ADR-0070 se asentó en la cuenta de familia (1.1.01), que ya no
 * recibe asientos (LAD62) y cuyo saldo se trasladó a la subcuenta de la caja: quien llama dice
 * cuál es esa subcuenta. Se traslada SOLO la línea asentada en el PADRE de esa subcuenta: otra
 * cuenta del original que hoy agrupe (la contrapartida) NO se redirige a la caja —sería mover a la
 * caja un importe que es de resultado—; va a su cuenta de siempre y la base la rechaza (LAD62),
 * como en cualquier reversa. Sin ese parámetro, la reversa va a las cuentas del original.
 *
 * No autoriza ni comprueba el estado del original: eso es de quien llama.
 */
export async function contraAsiento(
  sql: TransactionSql,
  p: {
    readonly tenantId: string;
    readonly companyId: string;
    readonly functionalCurrency: string;
    readonly entryId: string;
    /** La descripción del asiento original. */
    readonly description: string;
    readonly reason: string;
    /** El día del contra-asiento (un `date`, YYYY-MM-DD). */
    readonly fecha: string;
    /** El contra-asiento va al PERÍODO DE CIERRE de ese ejercicio (reabrir el 13, ADR-0069). */
    readonly alCierre?: number;
    /** Quién postea: el usuario, o el uuid nulo del sistema (`SYSTEM_POSTER_ID`). */
    readonly postedBy: string;
    /** Quién firma el acta `journal.reversed`. Por omisión, una persona. */
    readonly actorType?: "user" | "system";
    readonly cuentaSiAgrupa?: string | null;
  },
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const lineasOriginales = await sql<
    {
      account_id: string;
      functional_debit: string;
      functional_credit: string;
      analytical_dimensions: Record<string, string> | null;
      description: string | null;
      original: string;
      moneda: string;
      tasa: string;
      fuente: string;
      hora: string;
    }[]
  >`select case when ${p.cuentaSiAgrupa ?? null}::uuid is not null
                     and jl.account_id = (select s.parent_id from public.accounts s
                                           where s.id = ${p.cuentaSiAgrupa ?? null}::uuid
                                             and s.company_id = ${p.companyId})
                then ${p.cuentaSiAgrupa ?? null}::uuid else jl.account_id end as account_id,
           functional_debit::text as functional_debit,
           functional_credit::text as functional_credit, analytical_dimensions, description,
           amount_transaction_currency::text as original, transaction_currency as moneda,
           fx_rate::text as tasa, rate_source as fuente, rate_timestamp::text as hora
      from public.journal_lines jl where jl.entry_id = ${p.entryId} order by jl.line_number`;

  const entryLines: EntryLine[] = [];
  for (const l of lineasOriginales) {
    const debito = Money.of(l.functional_debit, p.functionalCurrency);
    const credito = Money.of(l.functional_credit, p.functionalCurrency);
    if (!debito.ok || !credito.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe original no interpretable." });
    }
    entryLines.push({ accountId: l.account_id, debit: debito.value, credit: credito.value });
  }
  const reversas = generateReversalLines(entryLines);
  if (!reversas.ok) {
    return err({ code: "VALIDATION_FAILED", message: reversas.error.message });
  }

  // C2 (ADR-0075 §7): LA REVERSA VA AL CÉNTIMO, como cualquier asiento nuevo. Si el original es
  // anterior al corte y tiene fracción, cada línea espejo se redondea al céntimo y el residuo va
  // a «Diferencias por redondeo» en el mismo contra-asiento. La regularización al corte ya se
  // llevó la fracción del saldo: el espejo EXACTO lo dejaría en −fracción; el espejo al céntimo
  // lo deja en cero. Con un original al céntimo (todo lo nuevo) esto es el espejo de siempre.
  const ceroDec = parseDecimal("0");
  if (!ceroDec.ok) return err({ code: "VALIDATION_FAILED", message: ceroDec.error.message });
  const contraLineas: {
    accountId: string;
    debit: Money;
    credit: Money;
    orig: (typeof lineasOriginales)[number] | null;
  }[] = [];
  let residuo: Decimal = ceroDec.value;
  for (const [i, l] of reversas.value.entries()) {
    const d = Money.of(toCents(l.debit.amount).toFixed(2), p.functionalCurrency);
    const c = Money.of(toCents(l.credit.amount).toFixed(2), p.functionalCurrency);
    if (!d.ok || !c.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importe original no interpretable." });
    }
    residuo = residuo.plus(d.value.amount).minus(c.value.amount);
    // Una línea de menos de medio céntimo no es una línea: su importe entero es residuo.
    if (d.value.amount.isZero() && c.value.amount.isZero()) continue;
    contraLineas.push({
      accountId: l.accountId,
      debit: d.value,
      credit: c.value,
      orig: lineasOriginales[i]!,
    });
  }
  if (!residuo.isZero()) {
    const [red] = await sql<{ account_id: string }[]>`
      select s.account_id from public.company_account_settings s
       where s.company_id = ${p.companyId} and s.purpose = 'rounding_difference'
         and s.effective_to is null
       order by s.effective_from desc limit 1`;
    if (!red) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Falta configurar la cuenta de: rounding_difference. La reversa de este asiento deja un residuo de redondeo que va a «Diferencias por redondeo».",
      });
    }
    const importe = Money.of(residuo.abs().toFixed(2), p.functionalCurrency);
    const cero = Money.of("0", p.functionalCurrency);
    if (!importe.ok || !cero.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Residuo de redondeo no representable." });
    }
    contraLineas.push({
      accountId: red.account_id,
      debit: residuo.isNegative() ? importe.value : cero.value,
      credit: residuo.isNegative() ? cero.value : importe.value,
      orig: null,
    });
  }
  if (contraLineas.length < 2) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Este asiento no tiene importes de al menos un céntimo: no hay nada que reversar al céntimo.",
    });
  }

  const fecha = p.fecha;
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const contra = await sql.savepoint(async (sp) => {
      const [periodo] =
        p.alCierre === undefined
          ? await sp<{ id: string }[]>`
              select platform.period_for_date(${p.companyId}, ${fecha}::date) as id`
          : await sp<{ id: string }[]>`
              select platform.closing_period_for_year(${p.companyId},
                     ${p.alCierre}::int) as id`;
      const [e] = await sp<Record<string, unknown>[]>`
        insert into public.journal_entries
          (tenant_id, company_id, period_id, posting_date, source_kind, description, memo,
           is_reversal_of, rules_version)
        values (${p.tenantId}, ${p.companyId}, ${periodo!.id}, ${fecha}::date,
                'manual', ${`Reversión: ${p.description}`}, ${p.reason},
                ${p.entryId}, ${RULES_VERSION})
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;

      let n = 0;
      for (const l of contraLineas) {
        n += 1;
        const orig = l.orig ?? {
          moneda: p.functionalCurrency,
          original: "0",
          tasa: "1",
          fuente: "identidad",
          hora: "",
          analytical_dimensions: null,
          description: "Diferencias por redondeo (ADR-0075 §7)",
        };
        const importe = l.debit.amount.isZero() ? l.credit : l.debit;
        // E-11 (ADR-0075 §6): el contra-asiento deshace la línea EN SU MONEDA. Si la original
        // guardó 5 USD a su tasa, la reversa saca 5 USD a esa misma tasa; escribirla en moneda
        // funcional dejaría los dólares dentro de la subcuenta de la caja.
        const enDivisa = orig.moneda !== p.functionalCurrency;
        const debitoTx = enDivisa
          ? l.debit.amount.isZero()
            ? "0"
            : orig.original
          : l.debit.toAmountString();
        const creditoTx = enDivisa
          ? l.credit.amount.isZero()
            ? "0"
            : orig.original
          : l.credit.toAmountString();
        await sp`
          insert into public.journal_lines
            (tenant_id, company_id, entry_id, line_number, account_id, debit_amount,
             credit_amount, amount_transaction_currency, transaction_currency, fx_rate,
             functional_amount, functional_currency, rate_source, rate_timestamp,
             functional_debit, functional_credit, analytical_dimensions, description)
          values (${p.tenantId}, ${p.companyId}, ${e!["id"] as string}, ${n},
                  ${l.accountId}, ${debitoTx}, ${creditoTx},
                  ${enDivisa ? orig.original : importe.toAmountString()},
                  ${enDivisa ? orig.moneda : p.functionalCurrency},
                  ${enDivisa ? orig.tasa : "1"},
                  ${importe.toAmountString()}, ${p.functionalCurrency},
                  ${enDivisa ? orig.fuente : "identidad"},
                  ${enDivisa ? orig.hora : sp`now()`}::timestamptz,
                  ${l.debit.toAmountString()}, ${l.credit.toAmountString()},
                  ${orig.analytical_dimensions === null ? null : sp.json(orig.analytical_dimensions)},
                  ${orig.description})`;
      }

      const [num] = await sp<{ n: string }[]>`
        select platform.claim_entry_number(${p.companyId},
               extract(year from ${fecha}::date)::int)::text as n`;
      const [posteado] = await sp<Record<string, unknown>[]>`
        update public.journal_entries
           set status = 'posted', posted_at = now(), posted_by = ${p.postedBy},
               entry_number = ${num!.n}::bigint
         where id = ${e!["id"] as string}
        returning ${sp.unsafe(ENTRY_COLUMNS)}`;

      // El original pasa a `reversed` y guarda el enlace. Conserva su número.
      await sp`
        update public.journal_entries
           set status = 'reversed', reversed_by_entry_id = ${e!["id"] as string}
         where id = ${p.entryId}`;
      return posteado!;
    });
    const conTot = await conTotales(sql, contra);
    await auditar(
      sql,
      p.tenantId,
      p.companyId,
      conTot.id,
      "journal.reversed",
      { reversal_of: p.entryId, reason: p.reason, entry_number: conTot.entry_number },
      p.actorType ?? "user",
    );
    return ok(conTot);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * DESCARTA UN BORRADOR (K-06, ADR-0069 §3). El borrador pasa a `discarded` con rastro en
 * `audit_events` (quién, cuándo, por qué). No se borra: que existió y se descartó es un
 * hecho. **Un asiento posteado no se descarta nunca** (regla 2): se reversa. El esquema lo
 * impide también (`assert_entry_immutable`: solo un borrador cambia de estado libremente).
 */
export async function discardJournalEntry(
  uow: UnitOfWork,
  entryId: string,
  input: DiscardJournalEntryRequest,
): Promise<Result<JournalEntryResponse, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Descartar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.entry.create");
  if (!ctx.ok) return ctx;

  const [entrada] = await sql<{ status: string; description: string; posting_date: string }[]>`
    select status, description, posting_date::text as posting_date
      from public.journal_entries
     where id = ${entryId} and company_id = ${input.company_id}
       for update`;
  if (!entrada) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (entrada.status !== "draft") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        entrada.status === "discarded"
          ? "Ese borrador ya está descartado."
          : `Solo se descarta un borrador; este está en ${entrada.status}. Un asiento posteado no se descarta: se corrige reversándolo.`,
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [e] = await sql<Record<string, unknown>[]>`
    update public.journal_entries set status = 'discarded'
     where id = ${entryId} and company_id = ${input.company_id} and status = 'draft'
    returning ${sql.unsafe(ENTRY_COLUMNS)}`;
  const conTot = await conTotales(sql, e!);
  await auditar(sql, ctx.value.tenantId, input.company_id, entryId, "journal.discarded", {
    reason: input.reason,
    description: entrada.description,
    posting_date: entrada.posting_date,
  });
  return ok(conTot);
}

/**
 * Los borradores de un alcance, dichos: «n.º corto, fecha, descripción». `null` si no hay.
 * El cierre los NOMBRA para que la persona sepa cuáles descartar o postear (K-06).
 */
async function borradoresDe(
  sql: TransactionSql,
  companyId: string,
  alcance: { readonly periodId: string } | { readonly desde: string; readonly hasta: string },
): Promise<string | null> {
  // `date` contra `date`: el rango del ejercicio son dos fechas ISO, sin reloj.
  const filas = await sql<{ id: string; posting_date: string; description: string }[]>`
    select id, to_char(posting_date, 'DD/MM/YYYY') as posting_date, description
      from public.journal_entries
     where company_id = ${companyId} and status = 'draft'
       and ${
         "periodId" in alcance
           ? sql`period_id = ${alcance.periodId}`
           : sql`posting_date between ${alcance.desde}::date and ${alcance.hasta}::date`
       }
     order by posting_date, id`;
  if (filas.length === 0) return null;
  const nombrados = filas
    .slice(0, 5)
    .map((f) => `«${f.description}» del ${f.posting_date} (${f.id.slice(0, 8)})`)
    .join("; ");
  return filas.length > 5 ? `${nombrados} y ${filas.length - 5} más` : nombrados;
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

  // El período BLOQUEADO: dos cierres simultáneos no revalúan dos veces.
  const [periodo] = await sql<
    { status: string; year: number; month: number; kind: string; fin: string }[]
  >`
    select status, year, month, kind,
           -- LA FECHA DE LA REVALUACIÓN (H7): el menor entre el fin del período y HOY, día de
           -- Caracas — un período que todavía no terminó se mide a lo que se sabe hoy, no a una
           -- tasa del día 31 que no existe. date contra date (CLAUDE.md §3); nunca antes
           -- del primer día del período.
           greatest(make_date(year, month, 1),
                    least((make_date(year, month, 1) + interval '1 month - 1 day')::date,
                          platform.caracas_day(now())))::text as fin
      from public.fiscal_periods
     where id = ${periodId} and company_id = ${input.company_id}
       for update`;
  if (!periodo) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (periodo.status === "closed") {
    return err({ code: "VALIDATION_FAILED", message: "El período ya está cerrado." });
  }

  const borradores = await borradoresDe(sql, input.company_id, { periodId });
  if (borradores !== null) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Quedan asientos en borrador en el período: ${borradores}. Postéalos o descártalos desde el diario (botón «Descartar»): cerrar por encima los descartaría en silencio.`,
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

  // LA REVALUACIÓN AL CIERRE (ADR-0075 §6; VEN-NIF PYME secc. 30). Antes de cerrar: después, el
  // período ya no admite el asiento. Solo en un mes; el período de cierre del ejercicio no revalúa.
  let revaluacion: RevaluacionAlCierre | null = null;
  if (periodo.kind === "regular") {
    const r = await revaluarAlCierre(uow, ctx.value, input.company_id, periodId, periodo.fin);
    if (!r.ok) return r;
    revaluacion = r.value;
  }

  const [cerrado] = await sql<{ id: string; status: string }[]>`
    update public.fiscal_periods
       set status = 'closed', closed_at = now(), closed_by = ${actor.userId}
     where id = ${periodId} and company_id = ${input.company_id}
    returning id, status`;
  await auditar(sql, ctx.value.tenantId, input.company_id, periodId, "accounting.period_closed", {
    year: periodo.year,
    month: periodo.month,
    fx_revaluation: revaluacion,
  });
  return ok(cerrado!);
}

type RevaluacionAlCierre = {
  readonly as_of: string;
  readonly entry_id: string | null;
  readonly entry_number: number | null;
  readonly items: readonly {
    readonly kind: string;
    readonly label: string;
    readonly currency: string;
    readonly original_balance: string;
    readonly rate: string | null;
    readonly carried: string;
    readonly target: string;
    readonly adjustment: string;
  }[];
};

/** Origen de los asientos de revaluación. Estable: lo leen `platform.fx_revaluation_items` y los tests. */
export const EVENTO_REVALUACION = "fx.revaluation_at_close";

/**
 * EL ASIENTO DE REVALUACIÓN (ADR-0075 §6; E-11, F-04, J-04). Las cajas en divisa y las cuentas
 * por cobrar y por pagar en divisa son partidas monetarias: al cierre se miden a la tasa BCV de
 * ese día y la diferencia va a resultados (ganancia o pérdida en diferencial cambiario).
 *
 * Qué partidas y por cuánto lo dice `platform.fx_revaluation_items` — sin estado: el ajuste es
 * «lo que debe llevar − lo que lleva», así que reabrir y volver a cerrar no duplica nada. Las
 * líneas van en moneda FUNCIONAL: la revaluación cambia los bolívares de la partida, no sus
 * dólares (el invariante `treasury_currency_gaps` no se mueve).
 *
 * Sin diferencias no hay asiento: un hecho que no ocurrió no se registra.
 */
async function revaluarAlCierre(
  uow: UnitOfWork,
  ctx: { tenantId: string; functionalCurrency: string },
  companyId: string,
  periodId: string,
  fin: string,
): Promise<Result<RevaluacionAlCierre, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cerrar exige un usuario real." });
  }
  type Partida = {
    item_kind: string;
    account_id: string;
    label: string;
    currency: string;
    original_balance: string;
    /** NULL cuando la cuenta no tiene saldo en divisa (solo deshace lo ya revaluado) o tiene varias. */
    rate: string | null;
    carried: string;
    target: string;
    adjustment: string;
  };
  let partidas: Partida[];
  try {
    // Con savepoint: un error de Postgres condena la transacción (CLAUDE.md §3).
    partidas = await sql.savepoint(
      async (sp) => sp<Partida[]>`
        select item_kind, account_id, label, currency, original_balance::text as original_balance,
               rate::text as rate, carried::text as carried, target::text as target,
               round(adjustment, 2)::text as adjustment
          from platform.fx_revaluation_items(${companyId}, ${fin}::date)`,
    );
  } catch (e) {
    if (typeof e === "object" && e !== null && (e as { code?: string }).code === "LAD51") {
      // H7: la tasa de cierre es la oficial vigente a la fecha y no más vieja que el margen de
      // `platform.parameters` (`platform.closing_rate`). Fuera del margen el cierre PARA.
      // `fx_revaluation_items` lanza LAD51 por DOS motivos: falta la tasa de CIERRE, o un cobro
      // viejo en otra moneda no tiene la tasa de SU fecha para saber cuánto saldó (el saldo
      // estricto, 20261003210200). Se dice cuál falta y de qué día.
      const texto = e instanceof Error ? e.message : "";
      const cobro = /vigente al (\d{4})-(\d{2})-(\d{2}) para valorar un cobro/.exec(texto);
      if (cobro !== null) {
        return err({
          code: "VALIDATION_FAILED",
          message: `Falta la tasa BCV del ${cobro[3]}/${cobro[2]}/${cobro[1]}: hay un cobro de ese día en otra moneda que no se puede valorar sin ella. Cárgala y vuelve a cerrar.`,
        });
      }
      const [d, m, a] = [fin.slice(8, 10), fin.slice(5, 7), fin.slice(0, 4)];
      return err({
        code: "VALIDATION_FAILED",
        message: `Falta la tasa BCV del cierre (${d}/${m}/${a}). Cárgala y vuelve a cerrar.`,
      });
    }
    throw e;
  }
  const items = partidas.map((p) => ({
    kind: p.item_kind,
    label: p.label,
    currency: p.currency,
    original_balance: p.original_balance,
    rate: p.rate,
    carried: p.carried,
    target: p.target,
    adjustment: p.adjustment,
  }));
  // H2: SE NETEA POR CUENTA antes de armar las líneas. `fx_revaluation_items` ya devuelve una
  // fila por cuenta y solo si hay diferencia; aquí se vuelve a sumar por `account_id` para que
  // dos partidas de la misma cuenta nunca produzcan ganancia y pérdida a la vez.
  const porCuenta = new Map<string, { neto: Decimal; etiquetas: string[]; tasas: string[] }>();
  for (const p of partidas) {
    const a = parseDecimal(p.adjustment);
    if (!a.ok) return err({ code: "VALIDATION_FAILED", message: a.error.message });
    const previo = porCuenta.get(p.account_id);
    if (previo === undefined) {
      porCuenta.set(p.account_id, {
        neto: a.value,
        etiquetas: [p.label],
        tasas: p.rate === null ? [] : [p.rate],
      });
    } else {
      previo.neto = previo.neto.plus(a.value);
      previo.etiquetas.push(p.label);
      if (p.rate !== null) previo.tasas.push(p.rate);
    }
  }
  const conAjuste = [...porCuenta.entries()]
    .map(([account_id, v]) => ({
      account_id,
      neto: v.neto,
      label: [...new Set(v.etiquetas)].join(" + "),
      rate: [...new Set(v.tasas)].join(" / "),
    }))
    .filter((p) => !p.neto.isZero());
  if (conAjuste.length === 0) {
    return ok({ as_of: fin, entry_id: null, entry_number: null, items });
  }

  const papeles = await sql<{ purpose: string; account_id: string }[]>`
    select distinct on (purpose) purpose, account_id
      from public.company_account_settings
     where company_id = ${companyId} and purpose in ('exchange_gain', 'exchange_loss')
       and (effective_from at time zone 'America/Caracas')::date <= ${fin}::date
       and (effective_to is null
            or (effective_to at time zone 'America/Caracas')::date > ${fin}::date)
     order by purpose, effective_from desc`;
  const ganancia = papeles.find((p) => p.purpose === "exchange_gain")?.account_id;
  const perdida = papeles.find((p) => p.purpose === "exchange_loss")?.account_id;

  const lineas: { cuenta: string; debito: string; credito: string; descripcion: string }[] = [];
  for (const p of conAjuste) {
    const importe = p.neto.abs().toFixed(2);
    const sube = p.neto.greaterThan(0);
    const contra = sube ? ganancia : perdida;
    if (contra === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message: `Falta configurar la cuenta de ${sube ? "ganancia" : "pérdida"} en diferencial cambiario: la revaluación de «${p.label}» al cierre no tiene dónde asentarse. Asígnala en el plan de cuentas y vuelve a cerrar.`,
      });
    }
    const detalle = p.rate === "" ? p.label : `${p.label} · tasa de cierre ${p.rate}`;
    lineas.push({
      cuenta: p.account_id,
      debito: sube ? importe : "0",
      credito: sube ? "0" : importe,
      descripcion: `Revaluación al cierre: ${detalle}`,
    });
    lineas.push({
      cuenta: contra,
      debito: sube ? "0" : importe,
      credito: sube ? importe : "0",
      descripcion: `${sube ? "Ganancia" : "Pérdida"} en diferencial cambiario: ${detalle}`,
    });
  }

  const [e] = await sql<{ id: string }[]>`
    insert into public.journal_entries
      (tenant_id, company_id, period_id, posting_date, source_kind, source_id, source_event,
       description, memo, rules_version)
    values (${ctx.tenantId}, ${companyId}, ${periodId}, ${fin}::date, 'exchange_diff',
            platform.uuidv7(), ${EVENTO_REVALUACION},
            ${`Revaluación de partidas monetarias en divisa al cierre del ${fin}`},
            'VEN-NIF PYME secc. 30: cajas y cuentas por cobrar y por pagar en divisa, a la tasa de cierre. No mueve dinero.',
            ${RULES_VERSION})
    returning id`;
  const filas = lineas.map((l, i) => ({ n: i + 1, ...l }));
  await sql`
    insert into public.journal_lines
      (tenant_id, company_id, entry_id, line_number, account_id, debit_amount, credit_amount,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, functional_debit, functional_credit,
       description)
    select ${ctx.tenantId}, ${companyId}, ${e!.id}, x.n, x.cuenta, x.debito, x.credito,
           greatest(x.debito, x.credito), ${ctx.functionalCurrency}, 1,
           greatest(x.debito, x.credito), ${ctx.functionalCurrency}, 'identidad', now(),
           x.debito, x.credito, x.descripcion
      from jsonb_to_recordset(${sql.json(filas)}::jsonb) as x(
        n integer, cuenta uuid, debito numeric, credito numeric, descripcion text)
     order by x.n`;
  const [num] = await sql<{ n: string }[]>`
    select platform.claim_entry_number(${companyId},
           extract(year from ${fin}::date)::int)::text as n`;
  const [posteado] = await sql<{ id: string; entry_number: number }[]>`
    update public.journal_entries
       set status = 'posted', posted_at = now(), posted_by = ${actor.userId},
           entry_number = ${num!.n}::bigint
     where id = ${e!.id}
    returning id, entry_number::int as entry_number`;
  await auditar(sql, ctx.tenantId, companyId, posteado!.id, "accounting.fx_revalued_at_close", {
    as_of: fin,
    period_id: periodId,
    entry_number: posteado!.entry_number,
    items: items,
  });
  return ok({ as_of: fin, entry_id: posteado!.id, entry_number: posteado!.entry_number, items });
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

  const [periodo] = await sql<{ status: string; year: number; month: number; kind: string }[]>`
    select status, year, month, kind from public.fiscal_periods
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

    // REABRIR EL EJERCICIO (el 13) REVIERTE SU ASIENTO DE CIERRE (decisión de la sesión
    // principal, 2026-09-28, sobre ADR-0069 §2). Sin esto, los resultados quedaban en cero y
    // el cierre no se podía rehacer: `journal_entries_source_event_key` daba 23505. Revertido,
    // los resultados vuelven a tener saldo para los ajustes, y el índice —que excluye los
    // `reversed`— deja cerrar otra vez. La reversa la autoriza el permiso de REABRIR (entrada
    // interna de `reversar`, como la anulación de ADR-0068 §1), va al 13 fechada el 31-12 y
    // deja su acta (`journal.reversed`, con el motivo de la reapertura).
    if (periodo.kind === "closing") {
      const [cierre] = await sql<{ id: string }[]>`
        select id from public.journal_entries
         where company_id = ${input.company_id} and period_id = ${periodId}
           and source_kind = 'year_end_close' and status = 'posted'`;
      if (cierre) {
        const rev = await reversar(
          uow,
          cierre.id,
          {
            company_id: input.company_id,
            reason: `Reapertura del ejercicio ${periodo.year}: ${input.reason}`,
            posting_date: `${periodo.year}-12-31`,
          },
          "accounting.period.reopen",
          { desdeDocumento: true, alCierre: periodo.year },
        );
        // withTransaction revierte la transacción entera ante un err (RollbackPorError,
        // packages/db/src/transaction.ts): devolverlo deshace también la reapertura del 13, y la
        // persona recibe un error legible en vez de un 500.
        if (!rev.ok) return rev;
      }
    }
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
 * ADR-0069 §2 (K-03): el asiento vive en el PERÍODO DE CIERRE («13») del ejercicio,
 * fechado el 31-12, así que diciembre puede estar cerrado —el orden normal—. Al postear
 * el cierre, el 13 se cierra; «reabrir el ejercicio» es reabrir el 13. Antes de cerrar,
 * no puede quedar nada a medias: los borradores del ejercicio se NOMBRAN.
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

  const borradores = await borradoresDe(sql, input.company_id, { desde, hasta });
  if (borradores !== null) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Quedan asientos en borrador en ${input.year}: ${borradores}. Postéalos o descártalos desde el diario antes de cerrar el ejercicio.`,
    });
  }
  const [pendientes] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.journal_generation_queue
     where company_id = ${input.company_id} and status = 'pending'`;
  if ((pendientes?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Hay ${pendientes!.n} documento(s) pendientes de contabilizar. Cerrar el ejercicio con la cola llena dejaría resultados fuera del cierre.`,
    });
  }
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
    const exacto = parseDecimal(s.saldo);
    if (!exacto.ok) return err({ code: "VALIDATION_FAILED", message: exacto.error.message });
    // S1 (ADR-0075 §7): EL CIERRE SE ARMA AL CÉNTIMO, como todo asiento. El saldo que se cierra
    // está ACOTADO AL AÑO, y la regularización del céntimo corrige el saldo de toda la vida con
    // un asiento fechado el día que corrió: si las fracciones viejas y la regularización caen en
    // ejercicios distintos, el saldo del año trae fracción y el asiento moría en LAD71 sin salida
    // por la API. Cada cuenta se cierra por su saldo al céntimo y el resultado es la suma de esos
    // céntimos: el asiento cuadra por construcción, sin línea de redondeo. La fracción (menos de
    // medio céntimo por cuenta) queda en el saldo del año y la compensa la regularización en el
    // ejercicio en que corrió; el saldo de toda la vida de la cuenta sigue al céntimo.
    const saldo = { value: toCents(exacto.value) };
    if (saldo.value.isZero()) continue;
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
  //
  // DOS PASOS, en el mismo asiento, como dice la cabecera (antes `year_result` se leía y
  // no se usaba: el resultado iba directo a acumuladas, K-03):
  //   1. cada cuenta de resultado a cero CONTRA «Resultado del ejercicio»;
  //   2. «Resultado del ejercicio» a «Utilidades o pérdidas acumuladas».
  // La cuenta del ejercicio recibe y entrega el mismo importe: queda en cero, y el rastro
  // dice por dónde pasó el resultado.
  if (neto.isNegative()) {
    const utilidad = neto.negated().toFixed(8);
    lineas.push({ account_id: resultado.account_id, debit: "0", credit: utilidad });
    lineas.push({ account_id: resultado.account_id, debit: utilidad, credit: "0" });
    lineas.push({ account_id: acumuladas.account_id, debit: "0", credit: utilidad });
  } else if (!neto.isZero()) {
    const perdida = neto.toFixed(8);
    lineas.push({ account_id: resultado.account_id, debit: perdida, credit: "0" });
    lineas.push({ account_id: resultado.account_id, debit: "0", credit: perdida });
    lineas.push({ account_id: acumuladas.account_id, debit: perdida, credit: "0" });
  } else {
    return err({
      code: "VALIDATION_FAILED",
      message: "El resultado del ejercicio es cero: el asiento de cierre no tendría contrapartida.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const asiento = await sql.savepoint(async (sp) => {
      // El período de CIERRE del ejercicio, no diciembre (ADR-0069 §2).
      const [periodo] = await sp<{ id: string }[]>`
        select platform.closing_period_for_year(${input.company_id}, ${input.year}::int) as id`;
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
      // El 13 se cierra con su asiento: un ajuste posterior exige reabrir el ejercicio (el
      // 13) con motivo. El evento de la historia lo escribe el trigger del esquema.
      await sp`
        update public.fiscal_periods
           set status = 'closed', closed_at = now(), closed_by = ${actor.userId}
         where id = ${periodo!.id} and status <> 'closed'`;
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

/**
 * Importa un PRESET de mapeo contable al de la empresa (migración 26,
 * ADR-0041/0043). Copia las plantillas y las desliga: a partir de aquí son
 * suyas y las edita.
 *
 * Es lo que convierte la contabilidad de «montada» a «viva». Sin esto, cada
 * documento emitido entra en la cola de pendientes con razón «no hay plantilla»
 * — que es correcto, pero no es un sistema que asiente.
 */
export async function importJournalTemplates(
  uow: UnitOfWork,
  input: { readonly company_id: string; readonly preset_code: string },
): Promise<Result<{ imported: number; lines: number }, AccountingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Importar exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.company_id, "accounting.template.manage");
  if (!ctx.ok) return ctx;

  const entradas = await sql<
    { id: string; source_kind: string; source_event: string; description: string }[]
  >`select id, source_kind, source_event, description
      from public.journal_template_preset_entries
     where preset_code = ${input.preset_code} order by source_kind, source_event`;
  if (entradas.length === 0) {
    return err({ code: "NOT_FOUND", message: "Ese preset de mapeo contable no existe." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  let plantillas = 0;
  let lineas = 0;
  try {
    for (const e of entradas) {
      // Si la empresa YA tiene plantilla activa para ese hecho, no se pisa: el
      // preset es un punto de partida, no una sobreescritura. Reemplazar una
      // plantilla que ya está generando asientos cambiaría a qué cuenta van
      // los siguientes sin que nadie lo pidiera.
      const [existe] = await sql<{ id: string }[]>`
        select id from public.journal_templates
         where company_id = ${input.company_id} and source_kind = ${e.source_kind}
           and source_event = ${e.source_event} and is_active`;
      if (existe) continue;

      // ADR-0055: la PRIMERA plantilla de este hecho rige desde siempre, para
      // que lo emitido antes de configurar la contabilidad se contabilice con
      // ella; una versión posterior empieza cuando se crea.
      const [t] = await sql<{ id: string }[]>`
        insert into public.journal_templates
          (tenant_id, company_id, source_kind, source_event, description, effective_from)
        values (${ctx.value.tenantId}, ${input.company_id}, ${e.source_kind}, ${e.source_event},
                ${e.description},
                case when exists (select 1 from public.journal_templates
                                   where company_id = ${input.company_id}
                                     and source_kind = ${e.source_kind}
                                     and source_event = ${e.source_event})
                     then now() else '-infinity'::timestamptz end)
        returning id`;
      plantillas += 1;

      const ls = await sql<
        {
          line_number: number;
          account_purpose: string;
          amount_source: string;
          side: string;
          condition_kind: string;
          description: string | null;
        }[]
      >`select line_number, account_purpose, amount_source, side, condition_kind, description
          from public.journal_template_preset_lines
         where entry_id = ${e.id} order by line_number`;
      for (const l of ls) {
        await sql`
          insert into public.journal_template_lines
            (tenant_id, company_id, template_id, line_number, account_purpose, amount_source,
             side, condition_kind, description)
          values (${ctx.value.tenantId}, ${input.company_id}, ${t!.id}, ${l.line_number},
                  ${l.account_purpose}, ${l.amount_source}, ${l.side}, ${l.condition_kind},
                  ${l.description})`;
        lineas += 1;
      }
    }
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  await auditar(
    sql,
    ctx.value.tenantId,
    input.company_id,
    input.company_id,
    "accounting.templates_imported",
    {
      preset_code: input.preset_code,
      imported: plantillas,
      lines: lineas,
    },
  );
  return ok({ imported: plantillas, lines: lineas });
}
