import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql, type TransactionSql } from "@ladino/db";
import {
  EnableIgtfRequest,
  SetIgtfInstrumentRequest,
  SetCompanyTaxpayerTypeRequest,
} from "@ladino/schemas";
import {
  enableIgtf,
  setIgtfInstrument,
  setCompanyTaxpayerType,
  readCompanyTaxpayerType,
  readIgtfStatus,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

async function exigePermiso(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: string | readonly string[],
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Esta consulta exige un usuario real.",
    });
  }
  const permisos = typeof permiso === "string" ? [permiso] : [...permiso];
  const [r] = await tx<{ ok: boolean }[]>`
    select bool_or(platform.ladino_user_has_permission(${actor.userId}, p, ${companyId})) as ok
      from unnest(${permisos}::text[]) as p`;
  if (!r?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `Esta consulta exige el permiso ${permisos.join(" o ")}.`,
    });
  }
}

/**
 * Rutas de IGTF (migración 46). La PERCEPCIÓN no tiene endpoint propio: la
 * calcula el servidor dentro del cobro (registerPayment / venta rápida) y
 * viaja en la respuesta. Aquí vive lo que la gobierna — activación con acta,
 * catálogo de instrumentos, clasificación fiscal — y sus consultas.
 */
export function igtfRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  app.get("/v1/igtf/status", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const estado = await withTransaction(sql, actor, async ({ sql: tx }) => {
      // La caja necesita saber si el cobro causará; el contador, la quincena a
      // enterar; quien configura, el estado. Cualquiera de los tres LEE
      // (configurar es otro permiso). Antes solo cobrar: el contador entraba
      // por el menú y recibía 403 (auditoría 2026-09-11, A-09).
      await exigePermiso(tx, actor, companyId, [
        "sales.payment.register",
        "fiscal_book.read",
        "company.settings.manage",
      ]);
      return readIgtfStatus(tx, companyId);
    });
    return c.json(estado, 200);
  });

  app.post("/v1/igtf/enable", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = EnableIgtfRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => enableIgtf(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.put("/v1/igtf/instruments", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SetIgtfInstrumentRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setIgtfInstrument(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.get("/v1/igtf/perceptions", async (c) => {
    const { companyId } = requireCompany(c);
    const desde = c.req.query("from");
    const hasta = c.req.query("to");
    // La tupla, no dos variables sueltas: así el filtro es «los dos o
    // ninguno» también para el compilador, y no hay rama con medio período.
    let periodo: [string, string] | null = null;
    if (desde !== undefined || hasta !== undefined) {
      if (
        desde === undefined ||
        hasta === undefined ||
        !FECHA_RE.test(desde) ||
        !FECHA_RE.test(hasta)
      ) {
        throw new DominioError({
          code: "VALIDATION_FAILED",
          message: "El filtro exige `from` y `to` juntos, como YYYY-MM-DD.",
        });
      }
      periodo = [desde, hasta];
    }
    // PAGINADO (2026-09-10): antes `limit 500` y sin `total` — una quincena
    // con más percepciones perdía filas sin decirlo, y el total a enterar
    // parecía completo. El total en dinero se calcula aparte, sobre TODAS.
    const porPagina = Math.min(Math.max(Number(c.req.query("per_page") ?? 50) || 50, 1), 200);
    const pagina = Math.max(Number(c.req.query("page") ?? 1) || 1, 1);
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "fiscal_book.read");
      const filas = await tx<Record<string, unknown>[]>`
        select id, payment_id, document_id, base_amount::text as base_amount, currency,
               rate::text as rate, amount::text as amount,
               functional_amount::text as functional_amount, fx_rate::text as fx_rate,
               rate_source, status, status_reason, absorbed, debit_note_id,
               to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 as occurred_at,
               count(*) over ()::int as total
          from public.igtf_perceptions
         where company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and platform.caracas_day(occurred_at) between ${periodo[0]}::date and ${periodo[1]}::date`}
         order by occurred_at desc
         limit ${porPagina} offset ${(pagina - 1) * porPagina}`;
      // El total del rango pedido. AF-M11 (PA SNAT/2022/000013 art. 4): la regla vive en UNA
      // función de la base (20261003230000). Una percepción cuyo cobro se reversó DESPUÉS del fin
      // de SU quincena —la de la percepción, no el rango de esta consulta— sigue contando (ya se
      // declaró: se recupera por reintegro, no rebajándola) y se dice aparte; la reversada dentro
      // de su quincena no cuenta. Sin rango, solo lo percibido vigente.
      const [total] = await tx<
        { total: string; pendiente: string; cuantas: number; moneda: string }[]
      >`
        select t.total_functional::text as total,
               t.pending_refund_functional::text as pendiente,
               t.pending_refund_count::int as cuantas,
               (select functional_currency_code from public.companies where id = ${companyId})
                 as moneda
          from platform.igtf_period_totals(${companyId}, ${periodo === null ? null : periodo[0]}::date,
                                           ${periodo === null ? null : periodo[1]}::date) t`;
      return {
        items: filas.map(({ total: _t, ...r }) => r),
        total: filas.length > 0 ? (filas[0]!["total"] as number) : 0,
        total_functional: total?.total ?? "0",
        pending_refund_functional: total?.pendiente ?? "0",
        pending_refund_count: total?.cuantas ?? 0,
        functional_currency: total?.moneda ?? "",
      };
    });
    return c.json(cuerpo, 200);
  });

  // Cierra H-6: la clasificación fiscal de la empresa por la API (la semilla
  // de producción tuvo que ponerla por SQL). Vive aquí y no en companies.ts
  // porque su efecto colateral —apagar la percepción si deja de ser SPE— es
  // de esta familia.
  // ADR-0072 §1: el tipo vigente hoy y su historia. SIN permiso propio, decidido por criterio
  // (ADR-0072, nota de aplicación): lo lee cualquier miembro de la empresa, porque la web decide
  // flujos con él (facturar, IGTF, Empezar); el X-Company-Id ya exige ser miembro. Con
  // ?effective_from= devuelve además cuántos documentos fiscales se emitieron desde esa fecha.
  app.get("/v1/companies/taxpayer-type", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const desdeCrudo = c.req.query("effective_from");
    if (desdeCrudo !== undefined && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(desdeCrudo)) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "effective_from va como AAAA-MM-DD.",
      });
    }
    const cuerpo = await withTransaction(sql, actor, ({ sql: tx }) =>
      readCompanyTaxpayerType(tx, companyId, desdeCrudo),
    );
    return c.json(cuerpo, 200);
  });

  app.put("/v1/companies/taxpayer-type", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SetCompanyTaxpayerTypeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (companyId !== parsed.data.company_id) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => setCompanyTaxpayerType(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}
