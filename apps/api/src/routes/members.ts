import { createHash, randomBytes } from "node:crypto";
import type { Hono, MiddlewareHandler } from "hono";
import { withTransaction, type Sql } from "@ladino/db";
import {
  AddMemberRequest,
  CreateInvitationRequest,
  InvitationTokenRequest,
  SetMemberStatusRequest,
} from "@ladino/schemas";
import {
  acceptInvitation,
  addMember,
  createInvitation,
  listMembers,
  previewInvitation,
  removeAssignment,
  setMemberStatus,
} from "@ladino/domain";
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

  /**
   * La invitación por enlace (ADR-0077 §3, N-08). Autoriza como agregar (membership.manage sobre
   * la empresa de la cabecera). El token viaja UNA vez, en esta respuesta.
   */
  app.post("/v1/invitations", idempotencia, async (c) => {
    const { companyId } = requireCompany(c);
    const parsed = CreateInvitationRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    if (parsed.data.company_id !== companyId) {
      throw new DominioError({
        code: "VALIDATION_FAILED",
        message: "El company_id del cuerpo no coincide con el header X-Company-Id.",
      });
    }
    const { actor } = c.get("ladino.auth");
    // H2: el token nace aquí y a la base solo va su huella; la respuesta guardada para la
    // idempotencia se redacta sin él (REDACTORES en middleware/idempotency.ts).
    const token = randomBytes(32).toString("hex");
    const huella = createHash("sha256").update(token, "utf8").digest("hex");
    const r = await withTransaction(sql, actor, (uow) =>
      createInvitation(uow, parsed.data, { token, huella }),
    );
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 201);
  });

  /**
   * Lo que ve quien abre el enlace, ANTES de ser miembro: sin X-Company-Id (todavía no tiene
   * ninguna). POST y no GET para que el token no quede en logs de acceso ni en el historial.
   */
  app.post("/v1/invitations/preview", async (c) => {
    const parsed = InvitationTokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => previewInvitation(uow, parsed.data.token));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
  });

  /**
   * Aceptar: un solo uso, con la fila bloqueada. Sin Idempotency-Key (no hay empresa a la que
   * atarla todavía): la idempotencia es estructural —la misma persona que repite recibe la
   * empresa sin efecto doble; cualquier otra, 409—.
   */
  app.post("/v1/invitations/accept", async (c) => {
    const parsed = InvitationTokenRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new ValidacionError(parsed.error.issues);
    const { actor } = c.get("ladino.auth");
    const r = await withTransaction(sql, actor, (uow) => acceptInvitation(uow, parsed.data.token));
    if (!r.ok) throw new DominioError(r.error);
    return c.json(r.value, 200);
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
