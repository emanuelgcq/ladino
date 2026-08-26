import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import type {
  CreateCustomerRequest,
  UpdateCustomerRequest,
  SetCustomerTaxIdRequest,
  SetCustomerBlockedRequest,
  CustomerResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * Casos de uso de clientes (ADR-0033) — plantilla company-scoped de productos.
 * Tres permisos SEGREGADOS: customer.manage (alta/edición), customer.tax_id.manage
 * (el RIF, M4: el trigger del esquema es la red; el caso de uso exige el mismo
 * permiso antes, con un 403 legible) y customer.block (cobranzas bloquea).
 */
export type CustomerError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string };

const COLUMNS = `id, tenant_id, company_id, tax_id, legal_name, trade_name, person_type_code,
  taxpayer_type_code, fiscal_address, email, phone, status, default_price_list_id,
  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

type Row = CustomerResponse;

function duplicado(e: unknown): CustomerError | null {
  if ((e as { code?: string }).code !== "23505") return null;
  return { code: "DUPLICATE", message: "Ya existe un cliente con ese RIF en esta empresa." };
}

function fkInvalido(e: unknown): CustomerError | null {
  if ((e as { code?: string }).code !== "23503") return null;
  return {
    code: "VALIDATION_FAILED",
    message:
      "Lista de precios, tipo de persona o clasificación fiscal inválidos para esta empresa.",
  };
}

async function auditarYPublicar(
  sql: TransactionSql,
  fila: Row,
  evento: string,
  payload: Record<string, JSONValue>,
): Promise<void> {
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'customer', ${fila.id}, ${evento},
            'user', now(), ${RULES_VERSION}, ${sql.json(payload)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'customer', ${fila.id}, ${evento}, 1,
            ${sql.json({ customer_id: fila.id, company_id: fila.company_id, ...payload })})`;
}

export async function createCustomer(
  uow: UnitOfWork,
  input: CreateCustomerRequest,
): Promise<Result<CustomerResponse, CustomerError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "customer.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  // D-2, dicho con palabras antes de que lo diga el CHECK: sin RIF, solo persona natural.
  if ((input.tax_id ?? null) === null && input.person_type_code !== "natural") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo una persona natural puede registrarse sin RIF.",
    });
  }
  const [cats] = await sql<{ persona: boolean; fiscal: boolean }[]>`
    select exists (select 1 from public.person_types
                    where code = ${input.person_type_code} and status = 'active') as persona,
           exists (select 1 from public.taxpayer_types
                    where code = ${input.taxpayer_type_code} and status = 'active') as fiscal`;
  if (!cats?.persona || !cats.fiscal) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El tipo de persona o la clasificación fiscal no existen o están inactivos.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let fila: Row;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [creada] = await sp<Row[]>`
        insert into public.customers
          (tenant_id, company_id, tax_id, legal_name, trade_name, person_type_code,
           taxpayer_type_code, fiscal_address, email, phone, status, default_price_list_id)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.tax_id ?? null},
                ${input.legal_name}, ${input.trade_name ?? null}, ${input.person_type_code},
                ${input.taxpayer_type_code}, ${input.fiscal_address ?? null},
                ${input.email ?? null}, ${input.phone ?? null}, ${input.status ?? "active"},
                ${input.default_price_list_id ?? null})
        returning ${sp.unsafe(COLUMNS)}`;
      return creada!;
    });
  } catch (e) {
    const conocido = duplicado(e) ?? fkInvalido(e);
    if (conocido) return err(conocido);
    throw e;
  }

  // El trigger M4 ya dejó customer.tax_id_established si hubo RIF (red del
  // esquema). El caso de uso registra el ACTO: customer.created.
  await auditarYPublicar(sql, fila, "customer.created", {
    tax_id: fila.tax_id,
    person_type_code: fila.person_type_code,
    taxpayer_type_code: fila.taxpayer_type_code,
  });
  return ok(fila);
}

export async function updateCustomer(
  uow: UnitOfWork,
  customerId: string,
  input: UpdateCustomerRequest,
): Promise<Result<CustomerResponse, CustomerError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "customer.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [actual] = await sql<{ status: string }[]>`
    select status from public.customers where id = ${customerId} and company_id = ${input.company_id}`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (actual.status === "blocked" && input.status !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El cliente está bloqueado: desbloquearlo exige customer.block, no una edición.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let fila: Row | undefined;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [f] = await sp<Row[]>`
        update public.customers set
          legal_name     = coalesce(${input.legal_name ?? null}, legal_name),
          status         = coalesce(${input.status ?? null}, status),
          trade_name     = case when ${input.trade_name === undefined} then trade_name
                                else ${input.trade_name ?? null} end,
          fiscal_address = case when ${input.fiscal_address === undefined} then fiscal_address
                                else ${input.fiscal_address ?? null} end,
          email          = case when ${input.email === undefined} then email
                                else ${input.email ?? null} end,
          phone          = case when ${input.phone === undefined} then phone
                                else ${input.phone ?? null} end,
          default_price_list_id = case when ${input.default_price_list_id === undefined}
                                       then default_price_list_id
                                       else ${input.default_price_list_id ?? null} end
        where id = ${customerId} and company_id = ${input.company_id}
        returning ${sp.unsafe(COLUMNS)}`;
      return f;
    });
  } catch (e) {
    const conocido = fkInvalido(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  await auditarYPublicar(sql, fila, "customer.updated", {
    legal_name: input.legal_name ?? null,
    status: input.status ?? null,
  });
  return ok(fila);
}

/**
 * M4 del cliente: permiso SEGREGADO exigido aquí (403 legible) y por el
 * trigger (LAD36 cuando hay JWT). El trigger escribe el hecho con el valor
 * anterior; este caso de uso NO lo duplica en audit_events — emite el evento
 * de outbox del mismo nombre (partición, EVENT_CATALOG §Clientes).
 */
export async function setCustomerTaxId(
  uow: UnitOfWork,
  customerId: string,
  input: SetCustomerTaxIdRequest,
): Promise<Result<CustomerResponse, CustomerError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "customer.tax_id.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [actual] = await sql<{ tax_id: string | null; person_type_code: string }[]>`
    select tax_id, person_type_code from public.customers
     where id = ${customerId} and company_id = ${input.company_id}`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (input.tax_id === null && actual.person_type_code !== "natural") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo una persona natural puede quedar sin RIF.",
    });
  }
  if (actual.tax_id === input.tax_id) {
    return err({ code: "VALIDATION_FAILED", message: "El RIF ya es ese." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let fila: Row;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [f] = await sp<Row[]>`
        update public.customers set tax_id = ${input.tax_id}
         where id = ${customerId} and company_id = ${input.company_id}
        returning ${sp.unsafe(COLUMNS)}`;
      return f!;
    });
  } catch (e) {
    const dup = duplicado(e);
    if (dup) return err(dup);
    throw e;
  }

  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'customer', ${fila.id}, 'customer.tax_id_changed', 1,
            ${sql.json({ customer_id: fila.id, from: actual.tax_id, to: input.tax_id })})`;
  return ok(fila);
}

/** Bloquear/desbloquear: permiso customer.block (cobranzas), nunca customer.manage. */
export async function setCustomerBlocked(
  uow: UnitOfWork,
  customerId: string,
  input: SetCustomerBlockedRequest,
): Promise<Result<CustomerResponse, CustomerError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "customer.block");
  if (!scope.ok) return scope;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const nuevo = input.blocked ? "blocked" : "active";
  const [fila] = await sql<Row[]>`
    update public.customers set status = ${nuevo}
     where id = ${customerId} and company_id = ${input.company_id}
       and status ${input.blocked ? sql`<> 'blocked'` : sql`= 'blocked'`}
    returning ${sql.unsafe(COLUMNS)}`;
  if (!fila) {
    // Inexistente O ya en el estado pedido: el segundo caso es un no-op que se
    // dice, no un 404 que confunde.
    const [existe] = await sql<{ status: string }[]>`
      select status from public.customers where id = ${customerId} and company_id = ${input.company_id}`;
    if (!existe) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    return err({
      code: "VALIDATION_FAILED",
      message: input.blocked ? "El cliente ya está bloqueado." : "El cliente no está bloqueado.",
    });
  }
  await auditarYPublicar(sql, fila, input.blocked ? "customer.blocked" : "customer.unblocked", {
    reason: input.reason ?? null,
  });
  return ok(fila);
}
