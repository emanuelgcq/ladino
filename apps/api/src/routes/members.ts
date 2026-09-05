import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import { AddMemberRequest, SetMemberStatusRequest } from "@ladino/schemas";
import { addMember, listMembers, removeAssignment, setMemberStatus } from "@ladino/domain";
import { DominioError, ValidacionError } from "../middleware/errors.js";
import { requireCompany } from "./products.js";

/**
 * MIEMBROS Y ROLES (ADR-0049). Capa delgada sobre packages/domain/members:
 * la autorización (membership.read/manage a NIVEL TENANT, con rol plano) y
 * los guards (no quitarse el timón, no desactivarse) viven en el dominio.
 */
export function membersRoutes(app: Hono, sql: Sql, idempotencia: MiddlewareHandler): void {
  app.get("/v1/members", async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => listMembers(uow, companyId));
    if (!r.ok) throw new DominioError(r.error);
    return c.json({ members: r.value }, 200);
  });

  app.post("/v1/members", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = AddMemberRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (parsed.data.company_id !== companyId) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con el header X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => addMember(uow, parsed.data));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  app.delete("/v1/members/assignments/:id", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      removeAssignment(uow, { company_id: companyId, assignment_id: c.req.param("id") }),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  app.put("/v1/members/:id/status", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = SetMemberStatusRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (parsed.data.company_id !== companyId) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con el header X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) =>
      setMemberStatus(uow, { ...parsed.data, membership_id: c.req.param("id") }),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });
}
