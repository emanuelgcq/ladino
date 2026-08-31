import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  CreateAccountRequest,
  UpdateAccountRequest,
  ImportChartTemplateRequest,
  CreateJournalEntryRequest,
  PostJournalEntryRequest,
  ReverseJournalEntryRequest,
  ClosePeriodRequest,
  ReopenPeriodRequest,
  YearEndCloseRequest,
  SetAccountPurposeRequest,
} from "@ladino/schemas";
import {
  createAccount,
  updateAccount,
  deactivateAccount,
  importChartTemplate,
  importJournalTemplates,
  setAccountPurpose,
  createManualJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  closeFiscalPeriod,
  reopenFiscalPeriod,
  executeYearEndClose,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

function idValido(id: string): string {
  if (!UUID_RE.test(id))
    throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return id;
}

/**
 * La fecha de un reporte es PARÁMETRO, nunca «hoy». Si llega malformada se
 * rechaza en vez de caer a `now()`: un balance con fecha silenciosamente
 * distinta de la pedida es peor que un error.
 */
function fechaValida(raw: string | undefined, nombre: string): string {
  if (raw === undefined || !FECHA_RE.test(raw)) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: `${nombre} es obligatoria y va como YYYY-MM-DD: un reporte sin fecha explícita no se puede reproducir mañana.`,
    });
  }
  return raw;
}

function coherente(companyIdHeader: string, companyIdBody: string): void {
  if (companyIdHeader !== companyIdBody) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

/** Consultar contabilidad es un permiso propio, no una consecuencia de ver la empresa. */
async function exigeLectura(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar contabilidad exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'accounting.read', ${companyId})
           as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar contabilidad exige el permiso accounting.read.",
    });
  }
}

/**
 * Rutas de contabilidad. La capa es delgada: el mayor, el balance y los estados
 * los calcula el ESQUEMA (`recompute_ledger`, `trial_balance`), no esta capa.
 * Sumar aquí sería una segunda contabilidad que un día diferiría de la primera.
 */
export function accountingRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  // ── Plan de cuentas ───────────────────────────────────────────────────────

  app.get("/v1/accounts", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const soloHojas = c.req.query("leaves_only") === "true";
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select id, company_id, code, name, description, parent_id, kind, nature, is_leaf,
               is_active, currency_code, requires_analytical, level::int as level, path
          from public.accounts
         where company_id = ${companyId} ${soloHojas ? tx`and is_leaf and is_active` : tx``}
         order by path`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/accounts", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => createAccount(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.patch("/v1/accounts/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = UpdateAccountRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => updateAccount(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/accounts/:id/deactivate", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => deactivateAccount(uow, id, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.get("/v1/chart-templates", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx`
        select t.code, t.name, t.description, t.framework, t.legal_source,
               (select count(*)::int from public.chart_template_accounts a
                 where a.template_code = t.code) as account_count
          from public.chart_templates t where t.status = 'active' order by t.code`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/accounts/import-template", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ImportChartTemplateRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => importChartTemplate(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/journal-template-presets", async (c) => {
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select p.code, p.name, p.description, p.legal_source,
               (select count(*)::int from public.journal_template_preset_entries e
                 where e.preset_code = p.code) as entry_count
          from public.journal_template_presets p
         where p.status = 'active' order by p.code`,
    );
    return c.json(filas, 200);
  });

  /**
   * Importar el preset es lo que convierte la contabilidad de MONTADA a VIVA:
   * sin plantillas, cada documento emitido entra en la cola de pendientes con
   * razón «no hay plantilla» — correcto, pero no es un sistema que asiente.
   */
  app.post("/v1/journal-templates/import-preset", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const cuerpo = (await c.req.json().catch(() => null)) as {
      company_id?: string;
      preset_code?: string;
    } | null;
    if (cuerpo?.company_id === undefined || cuerpo.preset_code === undefined) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "Hacen falta company_id y preset_code.",
      });
    }
    coherente(companyId, cuerpo.company_id);
    const { actor } = c.get("ladino.auth");
    const preset = cuerpo.preset_code;
    const r = await withTransaction(sql, actor, (uow) =>
      importJournalTemplates(uow, { company_id: companyId, preset_code: preset }),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Papeles contables ─────────────────────────────────────────────────────

  app.get("/v1/company-account-settings", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select p.code as purpose, p.name, p.description,
               s.account_id, a.code as account_code, a.name as account_name
          from public.account_purposes p
          left join public.company_account_settings s
            on s.purpose = p.code and s.company_id = ${companyId} and s.effective_to is null
          left join public.accounts a on a.id = s.account_id
         order by p.code`,
    );
    return c.json(filas, 200);
  });

  app.put("/v1/company-account-settings", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SetAccountPurposeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setAccountPurpose(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  // ── Diario ────────────────────────────────────────────────────────────────

  app.get("/v1/journal-entries", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const status = c.req.query("status") ?? "";
    const sourceKind = c.req.query("source_kind") ?? "";
    const desde = c.req.query("from") ?? "";
    const hasta = c.req.query("to") ?? "";
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 25) || 25, 1), 100);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select e.id, e.company_id, e.period_id, e.entry_number::int as entry_number,
               e.posting_date::text as posting_date, e.source_kind, e.source_id, e.source_event,
               e.description, e.memo, e.status,
               to_char(e.posted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as posted_at,
               e.is_reversal_of, e.reversed_by_entry_id, e.rules_version,
               coalesce((select sum(jl.functional_debit) from public.journal_lines jl
                          where jl.entry_id = e.id), 0)::text as total_debit,
               coalesce((select sum(jl.functional_credit) from public.journal_lines jl
                          where jl.entry_id = e.id), 0)::text as total_credit,
               count(*) over ()::int as total
          from public.journal_entries e
         where e.company_id = ${companyId}
           ${status === "" ? tx`` : tx`and e.status = ${status}`}
           ${sourceKind === "" ? tx`` : tx`and e.source_kind = ${sourceKind}`}
           ${desde === "" ? tx`` : tx`and e.posting_date >= ${desde}::date`}
           ${hasta === "" ? tx`` : tx`and e.posting_date <= ${hasta}::date`}
         order by e.posting_date desc, e.entry_number desc nulls last, e.id
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
    return c.json({ items: filas.map(({ total: _t, ...r }) => r), total }, 200);
  });

  app.get("/v1/journal-entries/:id", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const id = idValido(c.req.param("id"));
    const detalle = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [entrada] = await tx<Record<string, unknown>[]>`
        select e.id, e.company_id, e.period_id, e.entry_number::int as entry_number,
               e.posting_date::text as posting_date, e.source_kind, e.source_id, e.source_event,
               e.description, e.memo, e.status,
               to_char(e.posted_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as posted_at,
               e.is_reversal_of, e.reversed_by_entry_id, e.rules_version,
               coalesce((select sum(jl.functional_debit) from public.journal_lines jl
                          where jl.entry_id = e.id), 0)::text as total_debit,
               coalesce((select sum(jl.functional_credit) from public.journal_lines jl
                          where jl.entry_id = e.id), 0)::text as total_credit
          from public.journal_entries e where e.id = ${id} and e.company_id = ${companyId}`;
      if (!entrada) return null;
      const lines = await tx<Record<string, unknown>[]>`
        select jl.id, jl.line_number, jl.account_id, a.code as account_code, a.name as account_name,
               jl.debit_amount::text as debit_amount, jl.credit_amount::text as credit_amount,
               jl.transaction_currency, jl.fx_rate::text as fx_rate,
               jl.functional_debit::text as functional_debit,
               jl.functional_credit::text as functional_credit, jl.functional_currency,
               jl.rate_source, jl.analytical_dimensions, jl.description
          from public.journal_lines jl
          join public.accounts a on a.id = jl.account_id
         where jl.entry_id = ${id} order by jl.line_number`;
      return { entry: entrada, lines };
    });
    if (detalle === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(detalle, 200);
  });

  app.post("/v1/journal-entries", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateJournalEntryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      createManualJournalEntry(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/journal-entries/:id/post", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = PostJournalEntryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => postJournalEntry(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/journal-entries/:id/reverse", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = ReverseJournalEntryRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => reverseJournalEntry(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── Mayor y balance ───────────────────────────────────────────────────────

  app.get("/v1/ledger", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const accountId = idValido(c.req.query("account") ?? "");
    const desde = c.req.query("from") ?? null;
    const hasta = fechaValida(c.req.query("to"), "La fecha final del mayor");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [cuenta] = await tx<
        { code: string; name: string; nature: string; moneda: string }[]
      >`select a.code, a.name, a.nature, c.functional_currency_code as moneda
          from public.accounts a join public.companies c on c.id = a.company_id
         where a.id = ${accountId} and a.company_id = ${companyId}`;
      if (!cuenta) return null;
      // El saldo de apertura lo calcula el ESQUEMA sobre los asientos crudos.
      const [apertura] = await tx<{ balance: string }[]>`
        select coalesce(balance, 0)::text as balance from platform.recompute_ledger(
          ${companyId}, ${accountId}, null,
          ${desde === null ? null : desde}::date - 1)`;
      const movimientos = await tx<Record<string, unknown>[]>`
        select e.id as entry_id, e.entry_number::int as entry_number,
               e.posting_date::text as posting_date, e.description,
               jl.functional_debit::text as debit, jl.functional_credit::text as credit,
               sum(jl.functional_debit - jl.functional_credit)
                 over (order by e.posting_date, e.entry_number, jl.line_number)::text
                 as running_delta,
               e.source_kind, e.source_id
          from public.journal_lines jl
          join public.journal_entries e on e.id = jl.entry_id
         where jl.company_id = ${companyId} and jl.account_id = ${accountId}
           and e.status in ('posted', 'reversed')
           and (${desde}::date is null or e.posting_date >= ${desde}::date)
           and e.posting_date <= ${hasta}::date
         order by e.posting_date, e.entry_number, jl.line_number`;
      const [cierre] = await tx<{ balance: string }[]>`
        select coalesce(balance, 0)::text as balance
          from platform.recompute_ledger(${companyId}, ${accountId}, null, ${hasta}::date)`;
      return {
        account_id: accountId,
        account_code: cuenta.code,
        account_name: cuenta.name,
        nature: cuenta.nature,
        currency: cuenta.moneda,
        opening_balance: apertura?.balance ?? "0",
        closing_balance: cierre?.balance ?? "0",
        movements: movimientos,
      };
    });
    if (cuerpo === null)
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return c.json(cuerpo, 200);
  });

  app.get("/v1/trial-balance", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const hasta = fechaValida(c.req.query("date"), "La fecha del balance de comprobación");
    const desde = c.req.query("from") ?? null;
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const rows = await tx<Record<string, unknown>[]>`
        select account_id, account_code, account_name, nature,
               opening_balance::text as opening_balance, period_debit::text as period_debit,
               period_credit::text as period_credit, closing_balance::text as closing_balance
          from platform.trial_balance(${companyId}, ${hasta}::date, ${desde}::date)`;
      const [totales] = await tx<{ d: string; c: string; cuadra: boolean }[]>`
        select coalesce(sum(period_debit), 0)::text as d,
               coalesce(sum(period_credit), 0)::text as c,
               coalesce(sum(period_debit), 0) = coalesce(sum(period_credit), 0) as cuadra
          from platform.trial_balance(${companyId}, ${hasta}::date, ${desde}::date)`;
      return {
        as_of: hasta,
        from_date: desde,
        currency: empresa?.moneda ?? "",
        rows,
        total_debit: totales?.d ?? "0",
        total_credit: totales?.c ?? "0",
        balanced: totales?.cuadra ?? true,
      };
    });
    return c.json(cuerpo, 200);
  });

  // ── Períodos ──────────────────────────────────────────────────────────────

  app.get("/v1/fiscal-periods", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select p.id, p.year, p.month, p.status,
               to_char(p.closed_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as closed_at,
               to_char(p.reopened_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as reopened_at,
               p.reopened_reason,
               (select count(*)::int from public.journal_entries e
                 where e.period_id = p.id and e.status = 'draft') as draft_entry_count,
               (select count(*)::int from public.journal_generation_queue q
                 where q.company_id = p.company_id and q.status = 'pending')
                 as pending_queue_count
          from public.fiscal_periods p
         where p.company_id = ${companyId} order by p.year desc, p.month desc`,
    );
    return c.json(filas, 200);
  });

  app.post("/v1/fiscal-periods/:id/close", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = ClosePeriodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => closeFiscalPeriod(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/fiscal-periods/:id/reopen", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = idValido(c.req.param("id"));
    const parsed = ReopenPeriodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => reopenFiscalPeriod(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.post("/v1/fiscal-periods/year-end-close", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = YearEndCloseRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => executeYearEndClose(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  // ── La cola de pendientes (ADR-0042) ──────────────────────────────────────

  app.get("/v1/accounting/pending", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const items = await tx<Record<string, unknown>[]>`
        select id, source_kind, source_id, source_event, reason,
               to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
          from public.journal_generation_queue
         where company_id = ${companyId} and status = 'pending'
         order by created_at limit 200`;
      const [total] = await tx<{ n: number }[]>`
        select count(*)::int as n from public.journal_generation_queue
         where company_id = ${companyId} and status = 'pending'`;
      return { items, total: total?.n ?? 0 };
    });
    return c.json(cuerpo, 200);
  });

  /**
   * El invariante de ADR-0042, expuesto. Que se pueda consultar es lo que
   * convierte «todo documento posteado tiene asiento o fila pendiente» en algo
   * que alguien puede mirar, en vez de una frase en un ADR.
   */
  app.get("/v1/accounting/coverage-gaps", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select source_kind, source_id, problem
          from platform.accounting_coverage_gaps(${companyId})`;
    });
    return c.json({ gaps: filas, healthy: filas.length === 0 }, 200);
  });

  // ── Estados financieros ───────────────────────────────────────────────────

  app.get("/v1/accounting/reports/income-statement", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desde = fechaValida(c.req.query("from"), "La fecha inicial del estado de resultados");
    const hasta = fechaValida(c.req.query("to"), "La fecha final del estado de resultados");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      // TODA la aritmética va en SQL con `numeric`. Sumar en JavaScript con
      // Number() sería float sobre dinero — regla 7 — y aquí el resultado del
      // ejercicio es exactamente lo que no puede llevar un error de redondeo.
      // Los ingresos se presentan por su saldo acreedor y los gastos por su
      // saldo deudor, los dos en POSITIVO: presentar un gasto en negativo
      // obliga a quien lee a saber el signo de cada cuenta para entender la fila.
      const filas = await tx<{ kind: string; code: string; name: string; importe: string }[]>`
        select a.kind, a.code, a.name,
               case when a.kind = 'ingreso'
                    then coalesce(sum(jl.functional_credit), 0) - coalesce(sum(jl.functional_debit), 0)
                    else coalesce(sum(jl.functional_debit), 0) - coalesce(sum(jl.functional_credit), 0)
               end::text as importe
          from public.accounts a
          join public.journal_lines jl on jl.account_id = a.id
          join public.journal_entries e on e.id = jl.entry_id
         where a.company_id = ${companyId} and a.kind in ('ingreso', 'gasto')
           and e.status in ('posted', 'reversed')
           and e.posting_date between ${desde}::date and ${hasta}::date
         group by a.kind, a.code, a.name
        having coalesce(sum(jl.functional_credit), 0) <> coalesce(sum(jl.functional_debit), 0)
         order by a.code`;
      const [totales] = await tx<{ ti: string; tg: string; res: string }[]>`
        with saldos as (
          select a.kind,
                 coalesce(sum(jl.functional_credit), 0) - coalesce(sum(jl.functional_debit), 0)
                   as acreedor
            from public.accounts a
            join public.journal_lines jl on jl.account_id = a.id
            join public.journal_entries e on e.id = jl.entry_id
           where a.company_id = ${companyId} and a.kind in ('ingreso', 'gasto')
             and e.status in ('posted', 'reversed')
             and e.posting_date between ${desde}::date and ${hasta}::date
           group by a.kind, a.id
        )
        select coalesce(sum(acreedor) filter (where kind = 'ingreso'), 0)::text as ti,
               coalesce(-sum(acreedor) filter (where kind = 'gasto'), 0)::text as tg,
               coalesce(sum(acreedor), 0)::text as res
          from saldos`;
      const mapear = (k: string) =>
        filas
          .filter((f) => f.kind === k)
          .map((f) => ({ account_code: f.code, account_name: f.name, amount: f.importe }));
      return {
        from_date: desde,
        to_date: hasta,
        currency: empresa?.moneda ?? "",
        income: mapear("ingreso"),
        expenses: mapear("gasto"),
        total_income: totales?.ti ?? "0",
        total_expenses: totales?.tg ?? "0",
        result: totales?.res ?? "0",
      };
    });
    return c.json(cuerpo, 200);
  });

  app.get("/v1/accounting/reports/balance-sheet", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const hasta = fechaValida(c.req.query("date"), "La fecha del balance general");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      // Cada grupo por su naturaleza y en positivo; los totales y la
      // comprobación activo == pasivo + patrimonio, en SQL con `numeric`.
      const filas = await tx<{ kind: string; code: string; name: string; importe: string }[]>`
        select a.kind, a.code, a.name,
               case when a.kind = 'activo'
                    then coalesce(sum(jl.functional_debit), 0) - coalesce(sum(jl.functional_credit), 0)
                    else coalesce(sum(jl.functional_credit), 0) - coalesce(sum(jl.functional_debit), 0)
               end::text as importe
          from public.accounts a
          join public.journal_lines jl on jl.account_id = a.id
          join public.journal_entries e on e.id = jl.entry_id
         where a.company_id = ${companyId} and a.kind in ('activo', 'pasivo', 'patrimonio')
           and e.status in ('posted', 'reversed') and e.posting_date <= ${hasta}::date
         group by a.kind, a.code, a.name
        having coalesce(sum(jl.functional_debit), 0) <> coalesce(sum(jl.functional_credit), 0)
         order by a.code`;
      const [totales] = await tx<{ ta: string; tp: string; tq: string; cuadra: boolean }[]>`
        with saldos as (
          select a.kind,
                 coalesce(sum(jl.functional_debit), 0) - coalesce(sum(jl.functional_credit), 0)
                   as deudor
            from public.accounts a
            join public.journal_lines jl on jl.account_id = a.id
            join public.journal_entries e on e.id = jl.entry_id
           where a.company_id = ${companyId} and a.kind in ('activo', 'pasivo', 'patrimonio')
             and e.status in ('posted', 'reversed') and e.posting_date <= ${hasta}::date
           group by a.kind, a.id
        )
        select coalesce(sum(deudor) filter (where kind = 'activo'), 0)::text as ta,
               coalesce(-sum(deudor) filter (where kind = 'pasivo'), 0)::text as tp,
               coalesce(-sum(deudor) filter (where kind = 'patrimonio'), 0)::text as tq,
               coalesce(sum(deudor) filter (where kind = 'activo'), 0)
                 = coalesce(-sum(deudor) filter (where kind in ('pasivo', 'patrimonio')), 0)
                 as cuadra
          from saldos`;
      const mapear = (k: string) =>
        filas
          .filter((f) => f.kind === k)
          .map((f) => ({ account_code: f.code, account_name: f.name, amount: f.importe }));
      return {
        as_of: hasta,
        currency: empresa?.moneda ?? "",
        assets: mapear("activo"),
        liabilities: mapear("pasivo"),
        equity: mapear("patrimonio"),
        total_assets: totales?.ta ?? "0",
        total_liabilities: totales?.tp ?? "0",
        total_equity: totales?.tq ?? "0",
        balanced: totales?.cuadra ?? true,
      };
    });
    return c.json(cuerpo, 200);
  });
}
