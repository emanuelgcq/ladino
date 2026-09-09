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
  readIgtfStatus,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const FECHA_RE = /^\d{4}-\d{2}-\d{2}$/;

async function exigePermiso(
  tx: TransactionSql,
  actor: { kind: string; userId?: string },
  companyId: string,
  permiso: string,
): Promise<void> {
  if (actor.kind !== "user" || actor.userId === undefined) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: "Esta consulta exige un usuario real.",
    });
  }
  const [r] = await tx<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${actor.userId}, ${permiso}, ${companyId}) as ok`;
  if (!r?.ok) {
    throw new DominioError({
      code: "PERMISSION_REQUIRED",
      message: `Esta consulta exige el permiso ${permiso}.`,
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
      // La caja también necesita saber si el cobro causará: el permiso de
      // cobrar basta para LEER el estado (configurarlo es otro permiso).
      await exigePermiso(tx, actor, companyId, "sales.payment.register");
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
    const { actor } = c.get("ladino.auth");
    const cuerpo = await withTransaction(sql, actor, async ({ sql: tx }) => {
      await exigePermiso(tx, actor, companyId, "fiscal_book.read");
      const items = await tx<Record<string, unknown>[]>`
        select id, payment_id, document_id, base_amount::text as base_amount, currency,
               rate::text as rate, amount::text as amount,
               functional_amount::text as functional_amount, fx_rate::text as fx_rate,
               rate_source, status, status_reason,
               to_char(occurred_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                 as occurred_at
          from public.igtf_perceptions
         where company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and occurred_at >= ${periodo[0]}::date and occurred_at < (${periodo[1]}::date + 1)`}
         order by occurred_at desc
         limit 500`;
      // El total de la quincena que se entera: SOLO lo percibido — lo
      // pendiente de reintegro se lista, pero no se suma como si se debiera.
      const [total] = await tx<{ total: string; moneda: string }[]>`
        select coalesce(sum(p.functional_amount) filter (where p.status = 'percibido'), 0)::text
                 as total,
               (select functional_currency_code from public.companies where id = ${companyId})
                 as moneda
          from public.igtf_perceptions p
         where p.company_id = ${companyId}
           ${periodo === null ? tx`` : tx`and p.occurred_at >= ${periodo[0]}::date and p.occurred_at < (${periodo[1]}::date + 1)`}`;
      return {
        items,
        total_functional: total?.total ?? "0",
        functional_currency: total?.moneda ?? "",
      };
    });
    return c.json(cuerpo, 200);
  });

  // Cierra H-6: la clasificación fiscal de la empresa por la API (la semilla
  // de producción tuvo que ponerla por SQL). Vive aquí y no en companies.ts
  // porque su efecto colateral —apagar la percepción si deja de ser SPE— es
  // de esta familia.
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
