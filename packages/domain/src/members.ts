import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import type {
  AcceptInvitationResponse,
  AddMemberRequest,
  CreateInvitationRequest,
  InvitationPreviewResponse,
  InvitationResponse,
  MeAccessResponse,
  MemberResponse,
  SetMemberStatusRequest,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";

/**
 * MIEMBROS Y ROLES (ADR-0049): la gestión de quién entra al negocio y con qué
 * oficio. Agregar es «por su correo» — la persona se registra sola y el dueño
 * la suma; los roles asignables son los SEIS de sistema, y los acotados
 * reciben bindings a TODOS los almacenes de la empresa (el recorte fino por
 * almacén queda para cuando haga falta).
 *
 * La autorización es POR EMPRESA (ADR-0068 §3, N-02): quien tiene
 * membership.manage/membership.read sobre la empresa de la cabecera —por una
 * asignación de esa empresa o de nivel tenant— gestiona a las personas de ESA
 * empresa. Lo que gobierna la cuenta es del TITULAR (la asignación de nivel
 * tenant, la del fundador): un gestor acotado a la empresa ve y toca solo las
 * asignaciones de su empresa, no quita roles ni desactiva al Titular, y solo
 * desactiva a quien no trabaja en empresas que él no gestiona.
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

/** ¿Tiene `permiso` sobre ESTA empresa? (asignación de la empresa o de nivel tenant) */
async function enEmpresa(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
): Promise<boolean> {
  const [r] = await sql<{ autorizado: boolean }[]>`
    select platform.ladino_user_has_permission(${userId}, ${permiso}, ${companyId}) as autorizado`;
  return r?.autorizado === true;
}

/** El TITULAR de la cuenta: quien tiene una asignación de nivel tenant (ADR-0068 §3). */
async function esTitular(sql: TransactionSql, tenantId: string, userId: string): Promise<boolean> {
  const [r] = await sql<{ titular: boolean }[]>`
    select exists (
      select 1
        from public.memberships m
        join public.user_role_assignments ura
          on ura.membership_id = m.id and ura.company_id is null
       where m.tenant_id = ${tenantId} and m.user_id = ${userId}
    ) as titular`;
  return r?.titular === true;
}

const NO_AL_TITULAR = {
  code: "MEMBER_PROTECTED",
  message:
    "Esa persona es el Titular de la cuenta: sus roles y su acceso solo los cambia el propio Titular.",
} as const;

/**
 * La guarda de un gestor ACOTADO sobre el ACCESO de una persona (la membresía es de la cuenta:
 * apagarla o encenderla vale para todas sus empresas). Devuelve el error, o null si puede:
 *   · al Titular no lo toca (MEMBER_PROTECTED);
 *   · con `exigirRolEn`, la persona tiene que trabajar en ESA empresa (404 si no: para el
 *     gestor de A, quien no está en A no existe — tampoco sale en su lista);
 *   · no tiene roles en empresas que el gestor no gestiona (MEMBER_PROTECTED).
 * La usan setMemberStatus y la REACTIVACIÓN dentro de addMember: si solo la tuviera la primera,
 * agregar a alguien desactivado sería la puerta de atrás.
 */
async function guardaDeAcceso(
  sql: TransactionSql,
  actorId: string,
  tenantId: string,
  miembro: { id: string; user_id: string },
  exigirRolEn: string | null,
): Promise<MembersError | null> {
  if (await esTitular(sql, tenantId, miembro.user_id)) return NO_AL_TITULAR;
  if (exigirRolEn !== null) {
    const [en] = await sql<{ hay: boolean }[]>`
      select exists (
        select 1 from public.user_role_assignments u
         where u.membership_id = ${miembro.id} and u.company_id = ${exigirRolEn}
      ) as hay`;
    if (en?.hay !== true) return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  }
  const [fuera] = await sql<{ hay: boolean }[]>`
    select exists (
      select 1 from public.user_role_assignments u
       where u.membership_id = ${miembro.id}
         and not platform.ladino_user_has_permission(${actorId}, 'membership.manage',
                                                     u.company_id)
    ) as hay`;
  if (fuera?.hay === true) {
    return {
      code: "MEMBER_PROTECTED",
      message:
        "Esa persona también trabaja en otra empresa de la cuenta. Quítale el rol en esta empresa; desactivarla del todo lo hace quien administra todas sus empresas.",
    };
  }
  return null;
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
  if (!(await enEmpresa(sql, actor.userId, companyId, "membership.read"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Ver los miembros exige membership.read sobre esta empresa.",
    });
  }
  // El Titular ve la cuenta entera, como siempre. Un gestor acotado ve a las personas de SU
  // empresa (y al Titular), y de cada una solo las asignaciones de esta empresa o de la cuenta.
  const todo = await nivelTenant(sql, actor.userId, tenantId, "membership.read");
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
      left join public.user_role_assignments ura
        on ura.membership_id = m.id
       and (${todo} or ura.company_id is null or ura.company_id = ${companyId})
      left join public.roles r on r.id = ura.role_id
     where m.tenant_id = ${tenantId}
       and (${todo} or exists (
             select 1 from public.user_role_assignments u2
              where u2.membership_id = m.id
                and (u2.company_id is null or u2.company_id = ${companyId})))
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
  if (!(await enEmpresa(sql, actor.userId, input.company_id, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Agregar miembros exige membership.manage sobre esta empresa.",
    });
  }
  if (!ROLES_ASIGNABLES.has(input.role_key)) {
    return err({ code: "VALIDATION_FAILED", message: "Ese rol no existe." });
  }

  const [persona] = await sql<{ id: string | null }[]>`
    select platform.user_id_by_email(${input.email}) as id`;
  if (persona?.id === null || persona?.id === undefined) {
    // Código propio (404) y no NOT_FOUND: NOT_FOUND viaja con el mensaje de persona FIJO
    // («Eso no existe o no está disponible para ti») y la pantalla no decía qué hacer
    // (QA de pantalla 2026-09-15, h. 74). Quien agrega ya tiene el permiso de miembros.
    return err({
      code: "MEMBER_NOT_REGISTERED",
      message:
        "Esa persona todavía no tiene cuenta en Ladino. Crea un enlace de invitación y mándaselo: entra con él y queda con su oficio.",
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
      // REACTIVAR es cambiar el acceso a la cuenta entera: un gestor acotado pasa la MISMA
      // guarda que en setMemberStatus (sin exigir rol en su empresa: lo está agregando ahora).
      if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
        const negado = await guardaDeAcceso(
          sql,
          actor.userId,
          tenantId,
          { id: previa.id, user_id: userId },
          null,
        );
        if (negado !== null) return err(negado);
      }
      await sql`update public.memberships set status = 'active' where id = ${previa.id}`;
      // N-10: reactivar desde «Agregar persona» deja su acta, como desde el botón.
      await sql`
        insert into public.audit_events
          (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
           actor_type, occurred_at, rules_version, payload)
        values (${tenantId}, ${input.company_id}, 'membership', ${previa.id},
                'member.reactivated', 'user', now(), ${RULES_VERSION},
                ${sql.json({ user_id: userId, via: "add_member" })})`;
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

  // Un Dueño de la empresa opera también su almacén, como el fundador (ADR-0049, ADR-0068 §3):
  // warehouse_ops ACOTADO a la empresa, con bindings a sus almacenes. Si ya lo tenía, no se
  // duplica; sin almacenes no hay binding (los ata el caso de uso al crear el almacén).
  if (input.role_key === "owner") {
    await sql`
      with wo as (
        insert into public.user_role_assignments (tenant_id, membership_id, role_id, company_id)
        select ${tenantId}, ${membershipId}, r.id, ${input.company_id}
          from public.roles r
         where r.key = 'warehouse_ops' and r.tenant_id is null
           and not exists (
                 select 1 from public.user_role_assignments u
                  where u.membership_id = ${membershipId} and u.role_id = r.id
                    and u.company_id = ${input.company_id})
        returning id
      )
      insert into public.scope_bindings (tenant_id, company_id, assignment_id, scope_type, scope_id)
      select ${tenantId}, ${input.company_id}, wo.id, 'warehouse', w.id
        from wo cross join public.warehouses w
       where w.company_id = ${input.company_id}`;
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
  if (!(await enEmpresa(sql, actor.userId, input.company_id, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Quitar roles exige membership.manage sobre esta empresa.",
    });
  }
  const [asignacion] = await sql<
    {
      id: string;
      membership_id: string;
      user_id: string;
      role_key: string;
      company_id: string | null;
    }[]
  >`
    select ura.id, ura.membership_id, m.user_id, r.key as role_key, ura.company_id
      from public.user_role_assignments ura
      join public.memberships m on m.id = ura.membership_id
      join public.roles r on r.id = ura.role_id
     where ura.id = ${input.assignment_id} and ura.tenant_id = ${tenantId}`;
  if (asignacion === undefined) {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  // Un gestor ACOTADO a la empresa toca solo las asignaciones de su empresa, y al Titular de
  // la cuenta no le quita nada (ADR-0068 §3). El Titular sigue gobernando la cuenta entera.
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
    // Primero el 404: una asignación de OTRA empresa no existe para este gestor, sea de quien
    // sea. La de nivel tenant (company_id nulo) es del Titular y cae en la guarda siguiente.
    if (asignacion.company_id !== null && asignacion.company_id !== input.company_id) {
      return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    }
    if (await esTitular(sql, tenantId, asignacion.user_id)) return err(NO_AL_TITULAR);
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
    -- N-10: el acta va en el historial de la MEMBRESÍA (antes llevaba el id de la asignación).
    -- E1 (ADR-0077, segunda revisión): el acta dice de qué empresa era la ASIGNACIÓN, no desde
    -- qué empresa se quitó. El Titular puede quitar una asignación de B con la cabecera de A, y
    -- platform.lost_access_to_company lee assignment_company_id para decidir a quién le dice
    -- «tu acceso ya no está activo»: anclada a la cabecera, se lo decía en A a quien nunca
    -- trabajó en A. null = la asignación era de nivel tenant (alcanzaba todo el negocio), y
    -- solo entonces el acta se ancla a la empresa de la cabecera.
    values (${tenantId}, ${asignacion.company_id ?? input.company_id}, 'membership',
            ${asignacion.membership_id},
            'member.role_revoked', 'user', now(), ${RULES_VERSION},
            ${sql.json({
              user_id: asignacion.user_id,
              role_key: asignacion.role_key,
              assignment_id: input.assignment_id,
              assignment_company_id: asignacion.company_id,
            })})`;
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
  if (!(await enEmpresa(sql, actor.userId, input.company_id, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cambiar el acceso exige membership.manage sobre esta empresa.",
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
  // La membresía es de la CUENTA: desactivarla corta el acceso a todas sus empresas. Un gestor
  // acotado solo la apaga si la persona no trabaja en ninguna empresa que él no gestione, y
  // nunca al Titular (ADR-0068 §3).
  if (!(await nivelTenant(sql, actor.userId, tenantId, "membership.manage"))) {
    const negado = await guardaDeAcceso(sql, actor.userId, tenantId, miembro, input.company_id);
    if (negado !== null) return err(negado);
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

// ─────────────────────────────────────────────────────────────────────────────
// LA INVITACIÓN POR ENLACE (ADR-0077 §3; N-08, K-09)
// ─────────────────────────────────────────────────────────────────────────────

/** Una invitación vive siete días (decidido por criterio; la tabla admite hasta 30). */
const DIAS_DE_INVITACION = 7;

/**
 * Crea la invitación. Autoriza igual que addMember (membership.manage sobre la empresa de la
 * cabecera): invitar es agregar a alguien que todavía no tiene cuenta. El token lo genera la API
 * (`crypto.randomBytes(32)`, parámetro `secreto`) y viaja UNA vez en la respuesta; la tabla guarda
 * solo su huella.
 */
export async function createInvitation(
  uow: UnitOfWork,
  input: CreateInvitationRequest,
  /**
   * H2 (revisión ADR-0077): el token lo genera la API (`crypto.randomBytes(32)`) y a la base solo
   * llega su huella sha256 en hex. El dominio no ve más que lo que tiene que guardar y devolver.
   */
  secreto: { readonly token: string; readonly huella: string },
): Promise<Result<InvitationResponse, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Invitar exige un usuario real." });
  }
  const tenantId = await tenantDe(sql, input.company_id);
  if (tenantId === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!(await enEmpresa(sql, actor.userId, input.company_id, "membership.manage"))) {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Invitar personas exige membership.manage sobre esta empresa.",
    });
  }
  // Un rol acotado sin almacenes no concedería nada al aceptarse: se dice ahora, como en addMember.
  const [rol] = await sql<{ requires_scope: boolean; almacenes: number }[]>`
    select r.requires_scope,
           (select count(*)::int from public.warehouses w where w.company_id = ${input.company_id})
             as almacenes
      from public.roles r
     where r.key = ${input.role_key} and r.tenant_id is null`;
  if (rol === undefined) return err({ code: "VALIDATION_FAILED", message: "Ese rol no existe." });
  if (rol.requires_scope && rol.almacenes === 0) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Ese rol trabaja por almacén y la empresa no tiene ninguno todavía: crea el depósito primero.",
    });
  }
  const email = input.email === undefined ? null : input.email.trim().toLowerCase();
  // H7 (decidido por criterio): una invitación de Dueño va SIEMPRE a un correo. Un enlace sin correo
  // lo usa quien lo tenga, y como Dueño eso es entregar el negocio.
  if (input.role_key === "owner" && email === null) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Una invitación de Dueño va a un correo: escribe el correo de la persona, y solo esa cuenta podrá usarla.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const { token, huella } = secreto;
  const [fila] = await sql<{ id: string; expires_at: string }[]>`
    insert into public.member_invitations
      (tenant_id, company_id, role_key, email, token_hash, expires_at)
    values (${tenantId}, ${input.company_id}, ${input.role_key}, ${email},
            ${huella},
            now() + make_interval(days => ${DIAS_DE_INVITACION}))
    returning id,
              to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at`;

  // El acta: quién invitó, a qué empresa, con qué rol y a qué correo. NUNCA el token.
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${tenantId}, ${input.company_id}, 'member_invitation', ${fila!.id},
            'member.invited', 'user', now(), ${RULES_VERSION},
            ${sql.json({ role_key: input.role_key, email, expires_at: fila!.expires_at })})`;

  return ok({
    id: fila!.id,
    company_id: input.company_id,
    role_key: input.role_key,
    email,
    token,
    expires_at: fila!.expires_at,
  });
}

/** Lo que la persona invitada ve antes de entrar: «Te invitaron a <empresa>». */
export async function previewInvitation(
  uow: UnitOfWork,
  token: string,
): Promise<Result<InvitationPreviewResponse, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Ver una invitación exige un usuario." });
  }
  const [v] = await sql<InvitationPreviewResponse[]>`
    select status, company_name, business_name, role_key, inviter_name,
           to_char(expires_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as expires_at
      from platform.invitation_preview(${token})`;
  if (v === undefined) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok(v);
}

const NO_DISPONIBLE: Record<string, MembersError> = {
  LAD85: { code: "NOT_FOUND", message: "Recurso no encontrado." },
  LAD86: {
    code: "INVITATION_UNAVAILABLE",
    message: "Esta invitación ya se usó o fue anulada. Pide a quien te invitó un enlace nuevo.",
  },
  LAD87: {
    code: "INVITATION_UNAVAILABLE",
    message: "Esta invitación venció. Pide a quien te invitó un enlace nuevo.",
  },
  LAD88: {
    code: "INVITATION_FOR_OTHER_EMAIL",
    message:
      "Esta invitación es para otro correo. Entra con la cuenta del correo al que te invitaron.",
  },
  // H1: una invitación nunca reactiva una membresía desactivada.
  LAD89: {
    code: "INVITATION_UNAVAILABLE",
    message:
      "Tu acceso a este negocio está desactivado: pídele a quien lo administra que te reactive desde Usuarios.",
  },
  LAD90: {
    code: "INVITATION_UNAVAILABLE",
    message:
      "Esta invitación ya no se puede usar: quien la envió ya no gestiona las personas de esa empresa. Pide un enlace nuevo a quien administra el negocio.",
  },
};

/**
 * Acepta la invitación: UNA vez, con la fila bloqueada, en `platform.accept_member_invitation`
 * (SECURITY DEFINER: la persona todavía no es miembro y la RLS no la deja escribir su membresía).
 * SAVEPOINT porque sus LAD son errores esperables y un error crudo condena la transacción.
 */
export async function acceptInvitation(
  uow: UnitOfWork,
  token: string,
): Promise<Result<AcceptInvitationResponse, MembersError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Aceptar exige un usuario real." });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const companyId = await sql.savepoint(async (sp) => {
      const [r] = await sp<{ company_id: string }[]>`
        select platform.accept_member_invitation(${token}) as company_id`;
      return r!.company_id;
    });
    return ok({ company_id: companyId });
  } catch (e) {
    const conocido = NO_DISPONIBLE[(e as { code?: string }).code ?? ""];
    if (conocido !== undefined) return err(conocido);
    throw e;
  }
}

/** N-03: los negocios donde la persona tuvo acceso y hoy no, con el nombre de quien administra. */
export async function myLostAccess(
  uow: UnitOfWork,
): Promise<Result<MeAccessResponse, MembersError>> {
  const filas = await uow.sql<{ business_name: string; admin_name: string | null }[]>`
    select business_name, admin_name from platform.my_lost_access()`;
  return ok({
    lost_access: filas.map((f) => ({ business_name: f.business_name, admin_name: f.admin_name })),
  });
}
