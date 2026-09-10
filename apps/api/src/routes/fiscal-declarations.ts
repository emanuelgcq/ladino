import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  GenerateIvaPeriodRequest,
  LoadFiscalDeadlinesRequest,
  RegisterSupportedRetentionRequest,
} from "@ladino/schemas";
import { generateIvaPeriod, loadFiscalDeadlines, registerSupportedRetention } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Página pedida, acotada. Estos listados llevaban un `limit` fijo y ningún
 * `total`: al pasar del tope, las filas siguientes desaparecían **en
 * silencio** — el mismo pecado que el módulo condena en los libros
 * («un libro que reparte en silencio lo que no sabe clasificar produce una
 * declaración falsa sin avisar a nadie»). Corregido el 2026-09-10.
 */
function paginaDe(c: { req: { query: (k: string) => string | undefined } }): [number, number] {
  const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
  const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
  return [porPagina, pagina];
}

/** `items` + el `total` REAL, para que la pantalla sepa si falta algo. */
function cuerpoPaginado(filas: Record<string, unknown>[]): {
  items: Record<string, unknown>[];
  total: number;
} {
  const total = filas.length > 0 ? (filas[0]!["total"] as number) : 0;
  return { items: filas.map(({ total: _t, ...r }) => r), total };
}

/** Período explícito u omitido ENTERO: medio período no reproduce nada. */
function periodoOpcional(c: {
  req: { query: (k: string) => string | undefined };
}): [string, string] | null {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from === undefined && to === undefined) return null;
  if (from === undefined || to === undefined || !FECHA_RE.test(from) || !FECHA_RE.test(to)) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El filtro exige `from` y `to` juntos, como YYYY-MM-DD.",
    });
  }
  if (to < from) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El período termina antes de empezar.",
    });
  }
  return [from, to];
}

async function exigeLectura(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar las declaraciones exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'fiscal_book.read', ${companyId})
           as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar las declaraciones exige el permiso fiscal_book.read.",
    });
  }
}

/**
 * Rutas de DECLARACIONES DE IVA (migración 46).
 *
 * Registrar una retención soportada y generar el período son ACTOS y dejan
 * rastro (pago + asiento; fila insert-only con hash). Las consultas no. El
 * calendario es configuración: se carga con cita de fuente y se lee sin más.
 */
export function fiscalDeclarationsRoutes(
  app: Hono,
  sql: Sql,
  idempotencia: MiddlewareHandler,
): void {
  app.post("/v1/fiscal-declarations/supported-retentions", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterSupportedRetentionRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      registerSupportedRetention(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/fiscal-declarations/supported-retentions", async (c) => {
    const { companyId } = requireCompany(c);
    const periodo = periodoOpcional(c);
    const { actor } = c.get("ladino.auth");
    const [porPagina, pagina] = paginaDe(c);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select id, customer_id, document_id, receipt_number, retained_on::text as retained_on,
               base::text as base, rate::text as rate, amount::text as amount,
               functional_currency, status, annul_reason,
               to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 as created_at,
               count(*) over ()::int as total
          from public.supported_retention_receipts
         where company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and retained_on between ${periodo[0]}::date and ${periodo[1]}::date`}
         order by retained_on desc, created_at desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    return c.json(cuerpoPaginado(filas), 200);
  });

  app.post("/v1/fiscal-declarations/iva-periods", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = GenerateIvaPeriodRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => generateIvaPeriod(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.get("/v1/fiscal-declarations/iva-periods", async (c) => {
    const { companyId } = requireCompany(c);
    const periodo = periodoOpcional(c);
    const { actor } = c.get("ladino.auth");
    const [porPagina, pagina] = paginaDe(c);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select id, period_from::text as period_from, period_to::text as period_to,
               debitos::text as debitos, creditos::text as creditos,
               creditos_deducibles::text as creditos_deducibles,
               prorrata_pct::text as prorrata_pct,
               retenciones_soportadas::text as retenciones_soportadas,
               excedente_anterior::text as excedente_anterior,
               cuota_a_pagar::text as cuota_a_pagar,
               excedente_siguiente::text as excedente_siguiente,
               detalle,
               (select c.functional_currency_code from public.companies c
                 where c.id = ${companyId}) as functional_currency,
               generator_version, dataset_hash, created_by,
               to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 as created_at,
               count(*) over ()::int as total
          from public.iva_period_results
         where company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and period_from >= ${periodo[0]}::date and period_to <= ${periodo[1]}::date`}
         order by period_from desc, created_at desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    return c.json(cuerpoPaginado(filas), 200);
  });

  app.put("/v1/fiscal-declarations/deadlines", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = LoadFiscalDeadlinesRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => loadFiscalDeadlines(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.get("/v1/fiscal-declarations/deadlines", async (c) => {
    const { companyId } = requireCompany(c);
    const periodo = periodoOpcional(c);
    const { actor } = c.get("ladino.auth");
    const [porPagina, pagina] = paginaDe(c);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select id, obligation, period_from::text as period_from, period_to::text as period_to,
               due_date::text as due_date, legal_source,
               count(*) over ()::int as total
          from public.company_fiscal_deadlines
         where company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and due_date between ${periodo[0]}::date and ${periodo[1]}::date`}
         order by due_date
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
    });
    return c.json(cuerpoPaginado(filas), 200);
  });
}
