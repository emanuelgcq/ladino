import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type { AddMemberRequest, MemberResponse, SetMemberStatusRequest } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";

/**
 * MIEMBROS Y ROLES (ADR-0049): la gestión de quién entra al negocio y con qué
 * oficio. Agregar es «por su correo» — la persona se registra sola y el dueño
 * la suma; los roles asignables son los SEIS de sistema, y los acotados
 * reciben bindings a TODOS los almacenes de la empresa (el recorte fino por
 * almacén queda para cuando haga falta).
 *
 * La autorización es de NIVEL TENANT (mismo patrón que createCompany): un rol
 * PLANO con membership.manage/membership.read. Un rol acotado no gobierna
 * personas — gobierna almacenes.
 */
export interface MembersError {
  readonly code: string;
  readonly message: string;
}

async function nivelTenant(
  sql: TransactionSql,
  userId: string,
  tenantId: string,
  permiso: string,
): Promise<boolean> {
  const [r] = await sql<{ autorizado: boolean }[]>`
    select exists (
      select 1
        from public.memberships m
        join public.user_role_assignments ura
          on ura.membership_id = m.id and ura.company_id is null
        join public.roles r on r.id = ura.role_id and not r.requires_scope
        join public.role_permissions rp
          on rp.role_id = r.id and rp.permission_key = ${permiso}
       where m.tenant_id = ${tenantId} and m.user_id = ${userId} and m.status = 'active'
    ) as autorizado`;
  return r?.autorizado === true;
}

async function tenantDe(sql: TransactionSql, companyId: string): Promise<string | null> {
  const [c] = await sql<{ tenant_id: string }[]>`
    select tenant_id from public.companies where id = ${companyId}`;
  return c?.tenant_id ?? null;
}

export async function listMembers(
  uow: UnitOfWork,
  companyId: string,
): Promise<Result<MemberResponse[], MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver los miembros exige un usuario real." });
  }
  const tenantId = await tenantDe(sql, companyId);
  if (tenantId === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.read"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Ver los miembros exige membership.read a nivel de negocio.",
    });
  }
  const filas = await sql<
    {
      membership_id: string;
      user_id: string;
      email: string | null;
      status: string;
      assignment_id: string | null;
      role_key: string | null;
      role_name: string | null;
      assignment_company_id: string | null;
    }[]
  >`
    select m.id as membership_id, m.user_id,
           platform.user_email(m.user_id) as email, m.status,
           ura.id as assignment_id, r.key as role_key, r.name as role_name,
           ura.company_id as assignment_company_id
      from public.memberships m
      left join public.user_role_assignments ura on ura.membership_id = m.id
      left join public.roles r on r.id = ura.role_id
     where m.tenant_id = ${tenantId}
     order by m.created_at, m.id, r.key`;

  const porMiembro = new Map<string, MemberResponse>();
  for (const f of filas) {
    let miembro = porMiembro.get(f.membership_id);
    if (miembro === undefined) {
      miembro = {
        membership_id: f.membership_id,
        user_id: f.user_id,
        email: f.email,
        status: f.status,
        assignments: [],
      };
      porMiembro.set(f.membership_id, miembro);
    }
    if (f.assignment_id !== null && f.role_key !== null && f.role_name !== null) {
      miembro.assignments.push({
        id: f.assignment_id,
        role_key: f.role_key,
        role_name: f.role_name,
        company_id: f.assignment_company_id,
      });
    }
  }
  return ok([...porMiembro.values()]);
}

const ROLES_ASIGNABLES = new Set([
  "owner",
  "cashier",
  "store_manager",
  "back_office",
  "accountant",
  "warehouse_ops",
]);

export async function addMember(
  uow: UnitOfWork,
  input: AddMemberRequest,
): Promise<Result<MemberResponse, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Agregar miembros exige un usuario real." });
  }
  const tenantId = await tenantDe(sql, input.company_id);
  if (tenantId === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Agregar miembros exige membership.manage a nivel de negocio.",
    });
  }
  if (!ROLES_ASIGNABLES.has(input.role_key)) {
    return err({ code: "VALIDATION_FAILED", message: "Ese rol no existe." });
  }

  const [persona] = await sql<{ id: string | null }[]>`
    select platform.user_id_by_email(${input.email}) as id`;
  if (persona?.id === null || persona?.id === undefined) {
    return err({
      code: "NOT_FOUND",
      message:
        "Esa persona todavía no tiene cuenta en Ladino. Pídele que se registre con ese correo y vuelve a agregarla.",
    });
  }
  const userId = persona.id;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // La membresía: se reusa la existente (reactivándola si estaba apagada) o
  // se crea. Un usuario = una membresía por tenant (clave natural del esquema).
  const [previa] = await sql<{ id: string; status: string }[]>`
    select id, status from public.memberships
     where tenant_id = ${tenantId} and user_id = ${userId}`;
  let membershipId: string;
  if (previa !== undefined) {
    membershipId = previa.id;
    if (previa.status !== "active") {
      await sql`update public.memberships set status = 'active' where id = ${previa.id}`;
    }
  } else {
    const [nueva] = await sql<{ id: string }[]>`
      insert into public.memberships (tenant_id, user_id)
      values (${tenantId}, ${userId}) returning id`;
    membershipId = nueva!.id;
  }

  // La asignación, ACOTADA a la empresa desde la que se agrega: un invitado
  // manda donde lo invitaron. (El fundador tiene las suyas a nivel tenant.)
  const [rol] = await sql<{ id: string; requires_scope: boolean }[]>`
    select id, requires_scope from public.roles
     where key = ${input.role_key} and tenant_id is null`;
  const [asignacion] = await sql<{ id: string }[]>`
    insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
    values (${tenantId}, ${membershipId}, ${rol!.id}, ${input.company_id})
    returning id`;

  // Rol acotado → bindings a TODOS los almacenes de la empresa. Sin almacenes
  // no hay nada que atar y el rol no concede nada: se dice, no se esconde.
  if (rol!.requires_scope) {
    const almacenes = await sql<{ n: string }[]>`
      insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
      select ${tenantId}, ${input.company_id}, ${asignacion!.id}, 'warehouse', w.id
        from public.warehouses w
       where w.company_id = ${input.company_id}
      returning id as n`;
    if (almacenes.length === 0) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Ese rol trabaja por almacén y la empresa no tiene ninguno todavía: crea el depósito primero.",
      });
    }
  }

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${input.company_id}, 'membership', ${membershipId},
            'member.role_assigned', 'user', now(), ${RULES_VERSION},
            ${sql.json({ user_id: userId, role_key: input.role_key, assignment_id: asignacion!.id })})`;

  const lista = await listMembers(uow, input.company_id);
  if (!lista.ok) return lista;
  const miembro = lista.value.find((m) => m.membership_id === membershipId);
  return miembro !== undefined
    ? ok(miembro)
    : err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
}

export async function removeAssignment(
  uow: UnitOfWork,
  input: { company_id: string; assignment_id: string },
): Promise<Result<{ removed: true }, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Quitar roles exige un usuario real." });
  }
  const tenantId = await tenantDe(sql, input.company_id);
  if (tenantId === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Quitar roles exige membership.manage a nivel de negocio.",
    });
  }
  const [asignacion] = await sql<{ id: string; user_id: string; role_key: string }[]>`
    select ura.id, m.user_id, r.key as role_key
      from public.user_role_assignments ura
      join public.memberships m on m.id = ura.membership_id
      join public.roles r on r.id = ura.role_id
     where ura.id = ${input.assignment_id} and ura.tenant_id = ${tenantId}`;
  if (asignacion === undefined) {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  // El dueño no se quita a sí mismo el timón: evita el negocio sin dueño.
  if (asignacion.user_id === actor.userId && asignacion.role_key === "owner") {
    return err({
      code: "VALIDATION_FAILED",
      message: "No puedes quitarte a ti mismo el rol de dueño.",
    });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  await sql`delete from public.scope_bindings where assignment_id = ${input.assignment_id}`;
  await sql`delete from public.user_role_assignments where id = ${input.assignment_id}`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${input.company_id}, 'membership', ${input.assignment_id},
            'member.role_revoked', 'user', now(), ${RULES_VERSION},
            ${sql.json({ user_id: asignacion.user_id, role_key: asignacion.role_key })})`;
  return ok({ removed: true });
}

export async function setMemberStatus(
  uow: UnitOfWork,
  input: SetMemberStatusRequest & { membership_id: string },
): Promise<Result<{ status: string }, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cambiar el acceso exige un usuario real.",
    });
  }
  const tenantId = await tenantDe(sql, input.company_id);
  if (tenantId === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cambiar el acceso exige membership.manage a nivel de negocio.",
    });
  }
  const [miembro] = await sql<{ id: string; user_id: string }[]>`
    select id, user_id from public.memberships
     where id = ${input.membership_id} and tenant_id = ${tenantId}`;
  if (miembro === undefined) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (miembro.user_id === actor.userId) {
    return err({
      code: "VALIDATION_FAILED",
      message: "No puedes desactivarte a ti mismo: pídeselo a otro dueño.",
    });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  await sql`update public.memberships set status = ${input.status}
             where id = ${input.membership_id}`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${input.company_id}, 'membership', ${input.membership_id},
            ${input.status === "active" ? "member.reactivated" : "member.deactivated"},
            'user', now(), ${RULES_VERSION}, ${sql.json({ user_id: miembro.user_id })})`;
  return ok({ status: input.status });
}
