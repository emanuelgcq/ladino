import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import { BookKind, ExportFiscalBookRequest } from "@ladino/schemas";
import { readFiscalBook, exportFiscalBook } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * El período de un libro es PARÁMETRO, siempre. Nunca «el mes en curso»
 * calculado aquí: un libro que se genera con un período implícito no se puede
 * volver a generar igual mañana, y volver a generarlo igual es literalmente lo
 * que exige la reproducibilidad de `fiscal_book_runs`.
 */
function periodoValido(c: { req: { query: (k: string) => string | undefined } }): [string, string] {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (from === undefined || to === undefined || !FECHA_RE.test(from) || !FECHA_RE.test(to)) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message:
        "El libro exige `from` y `to` como YYYY-MM-DD: un libro sin período explícito no se puede reproducir.",
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
      message: "Consultar un libro fiscal exige un usuario real.",
    });
  }
  const [permiso] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, 'fiscal_book.read', ${companyId})
           as ok`;
  if (!permiso?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Consultar un libro fiscal exige el permiso fiscal_book.read.",
    });
  }
}

/**
 * Rutas de LIBROS FISCALES (ADR-0044).
 *
 * Consultar es un GET y no deja rastro. Exportar es un POST, exige otro permiso
 * y escribe en `fiscal_book_runs` con el hash del dataset. La diferencia no es
 * de verbo HTTP: es que una presentación al SENIAT tiene que poder demostrarse
 * después y una mirada en pantalla no.
 */
export function fiscalBooksRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  /**
   * `libro = mayor + pendientes en cola`, con las TRES cifras.
   *
   * Es la consulta que cruza el módulo con contabilidad, de la misma familia que
   * `accounting_coverage_gaps()`. Si algún día deja de cuadrar, aquí es donde se
   * ve, y con el importe y el concepto, no con un «no cuadra» pelado.
   */
  app.get("/v1/fiscal-books/reports/reconciliation", async (c) => {
    const { companyId } = requireCompany(c);
    const [from, to] = periodoValido(c);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      const [empresa] = await tx<{ moneda: string }[]>`
        select functional_currency_code as moneda from public.companies where id = ${companyId}`;
      const rows = await tx<Record<string, unknown>[]>`
        select concepto, libro::text as libro, mayor::text as mayor, en_cola::text as en_cola,
               diferencia::text as diferencia, cuadra
          from platform.book_ledger_reconciliation(${companyId}, ${from}::date, ${to}::date)`;
      return {
        period_from: from,
        period_to: to,
        currency: empresa?.moneda ?? "",
        rows,
        balanced: rows.every((r) => r["cuadra"] === true),
      };
    });
    return c.json(cuerpo, 200);
  });

  /**
   * El catálogo de formatos, y si cada uno tiene implementación HOY.
   *
   * `implemented` NO es una columna de la tabla, y no debe serlo: la tabla dice
   * qué formatos existen en el mundo (dato, ADR-0044 §5) y el código dice cuáles
   * sabe escribir este release. Son dos cosas que cambian por vías distintas.
   * La pantalla lo necesita para no ofrecer un botón que va a fallar.
   */
  app.get("/v1/fiscal-books/formats", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select code, book_kind, name, description, is_official, legal_source, status,
               -- Hoy solo uno tiene implementación, y NO es oficial. La lista
               -- vive en el dominio; aquí se refleja para la pantalla.
               (code = 'csv_columnas_legales') as implemented
          from public.book_format_adapters
         where status = 'active'
         order by is_official desc, code`;
    });
    return c.json(filas, 200);
  });

  app.get("/v1/fiscal-books/runs", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const kindRaw = c.req.query("kind");
    const kind = kindRaw === undefined ? null : BookKind.parse(kindRaw);
    const filas = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return tx<Record<string, unknown>[]>`
        select id, company_id, book_kind, period_from::text as period_from,
               period_to::text as period_to, parameters, timezone, generator_version,
               dataset_hash, row_count, format_code, created_by,
               to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at
          from public.fiscal_book_runs
         where company_id = ${companyId}
           ${kind === null ? tx`` : tx`and book_kind = ${kind}`}
         order by created_at desc
         limit 200`;
    });
    return c.json({ runs: filas }, 200);
  });

  app.post("/v1/fiscal-books/export", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = ExportFiscalBookRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => exportFiscalBook(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /**
   * El libro en sí. Va AL FINAL a propósito: `:kind` es un comodín de un solo
   * segmento y Hono resuelve por orden de registro, así que declarado antes se
   * tragaría `/formats` y `/runs` y los devolvería como un libro inexistente.
   */
  app.get("/v1/fiscal-books/:kind", async (c) => {
    const { companyId } = requireCompany(c);
    const kind = BookKind.safeParse(c.req.param("kind"));
    if (!kind.success) throw new ValidacionError(kind.error.issues);
    const [from, to] = periodoValido(c);
    const { actor } = c.get("ladino.auth");
    const libro = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigeLectura(tx, actor, companyId);
      return readFiscalBook(tx, companyId, kind.data, from, to);
    });
    return c.json(libro, 200);
  });
}
