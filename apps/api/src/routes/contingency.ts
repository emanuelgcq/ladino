import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  RegisterContingencyRangeRequest,
  RegisterContingencyInvoiceRequest,
  CloseContingencyRequest,
} from "@ladino/schemas";
import {
  registerContingencyRange,
  registerContingencyInvoice,
  closeContingency,
} from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function coherente(header: string, body: string): void {
  if (header !== body) {
    throw new DominioError({
      code: "VALIDATION_FAILED",
      message: "El company_id del cuerpo no coincide con X-Company-Id.",
    });
  }
}

/** Rutas de CONTINGENCIA (PA 102, migración 35): capa delgada sobre el dominio. */
export function contingencyRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  app.get("/v1/fiscal/contingency-ranges", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const filas = await withTransaction(
      sql,
      actor,
      ({ sql: tx }) => tx<Record<string, unknown>[]>`
        select cr.id, cr.fiscal_number_range_id, r.series,
               r.range_from::int as range_from, r.range_to::int as range_to,
               r.next_available::int as next_available,
               (r.range_to - r.next_available + 1)::int as remaining, r.status, cr.reason,
               to_char(cr.failure_started_at at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as failure_started_at,
               to_char(cr.failure_ended_at at time zone 'utc',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as failure_ended_at
          from public.contingency_ranges cr
          join public.fiscal_number_ranges r on r.id = cr.fiscal_number_range_id
         where cr.company_id = ${companyId}
         order by cr.failure_started_at desc`,
    );
    return c.json({ items: filas }, 200);
  });

  app.post("/v1/fiscal/contingency-ranges", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterContingencyRangeRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      registerContingencyRange(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.post("/v1/fiscal/contingency-invoices", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = RegisterContingencyInvoiceRequest.safeParse(
      await c.req.json().catch(() => null),
    );
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      registerContingencyInvoice(uow, parsed.data),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.put("/v1/fiscal/contingency-ranges/:id/close", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const id = c.req.param("id");
    if (!UUID_RE.test(id)) {
      throw new DominioError({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    const parsed = CloseContingencyRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    coherente(companyId, parsed.data.company_id);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => closeContingency(uow, id, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}
