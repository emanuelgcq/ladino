import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import type {
  CreateCustomerRequest,
  UpdateCustomerRequest,
  SetCustomerTaxIdRequest,
  SetCustomerBlockedRequest,
  SetCustomerCreditLimitRequest,
  SetCustomerTaxpayerTypeRequest,
  CustomerResponse,
} from "@ladino/schemas";
import { normalizarDocumento } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import {
  registrarDigitoDudoso,
  validarDocumentoCliente,
  type DocumentoLeido,
} from "./documento-identidad.js";
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

/**
 * Qué tipo de contraparte declara cada prefijo del RIF (ADR-0033). J = persona
 * jurídica, G = ente público, ambos contribuyentes ordinarios; P = extranjera
 * no domiciliada; V/E (cédula) o sin documento = persona natural, consumidor
 * final. VALIDAR-SENIAT: el prefijo no dice si un V es contribuyente ordinario
 * (puede serlo); quien lo sepa lo corrige en la ficha.
 */
export function clasificacionPorPrefijo(taxId: string | null): {
  persona: string;
  contribuyente: string;
} {
  const prefijo = (taxId ?? "").trim().charAt(0).toUpperCase();
  if (prefijo === "J") return { persona: "juridica", contribuyente: "ordinario" };
  if (prefijo === "G") return { persona: "gobierno", contribuyente: "ordinario" };
  if (prefijo === "P") return { persona: "extranjera", contribuyente: "no_domiciliado" };
  return { persona: "natural", contribuyente: "consumidor_final" };
}

const COLUMNS = `id, tenant_id, company_id, tax_id, legal_name, trade_name, person_type_code,
  taxpayer_type_code, fiscal_address, email, phone, status, default_price_list_id,
  credit_limit_usd::text as credit_limit_usd,
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
  // El documento: RIF o cédula, validado y NORMALIZADO aquí para todos los caminos (P-02:
  // la administración guardaba lo tecleado y el mostrador lo compuesto). Estructura bloquea;
  // el dígito verificador solo se registra (A-08).
  let documento: DocumentoLeido | null = null;
  if ((input.tax_id ?? null) !== null) {
    const leido = validarDocumentoCliente(input.tax_id!);
    if (!leido.ok) return leido;
    documento = leido.value;
  }
  const taxId = documento?.normalizado ?? null;
  // La clasificación que la web no manda se infiere del prefijo del RIF: es
  // regla tributaria y vive aquí, no en los componentes (CLAUDE.md §2).
  const inferido = clasificacionPorPrefijo(taxId);
  const personTypeCode = input.person_type_code ?? inferido.persona;
  const taxpayerTypeCode = input.taxpayer_type_code ?? inferido.contribuyente;
  // D-2, dicho con palabras antes de que lo diga el CHECK: sin RIF, solo persona natural.
  if (taxId === null && personTypeCode !== "natural") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo una persona natural puede registrarse sin RIF.",
    });
  }
  // Una factura a una empresa o a un ente público lleva su domicilio fiscal
  // (ADR-0033; el snapshot de la migración 33 lo congela en el documento).
  // Para persona natural o extranjera es opcional. Y solo lo exige quien FACTURA: un negocio
  // sin RIF da recibos, que no imprimen domicilio fiscal (regla del dueño, 2026-09-16: con
  // RIF facturas, sin RIF recibos). Sin RIF, la empresa lleva el marcador PEND-… del registro.
  const [emisor] = await sql<{ factura: boolean }[]>`
    select tax_id not like 'PEND-%' as factura from public.companies
     where id = ${input.company_id}`;
  if (
    emisor?.factura === true &&
    (personTypeCode === "juridica" || personTypeCode === "gobierno") &&
    (input.fiscal_address ?? "").trim() === ""
  ) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Una factura a una empresa lleva su domicilio fiscal: escribe la dirección del cliente.",
    });
  }
  const [cats] = await sql<{ persona: boolean; fiscal: boolean }[]>`
    select exists (select 1 from public.person_types
                    where code = ${personTypeCode} and status = 'active') as persona,
           exists (select 1 from public.taxpayer_types
                    where code = ${taxpayerTypeCode} and status = 'active') as fiscal`;
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
        values (${scope.value.tenantId}, ${input.company_id}, ${taxId},
                ${input.legal_name}, ${input.trade_name ?? null}, ${personTypeCode},
                ${taxpayerTypeCode}, ${input.fiscal_address ?? null},
                ${input.email ?? null}, ${input.phone ?? null}, ${input.status ?? "active"},
                ${input.default_price_list_id ?? null})
        returning ${sp.unsafe(COLUMNS)}`;
      return creada!;
    });
  } catch (e) {
    const conocido = duplicado(e) ?? fkInvalido(e);
    // ADR-0082: si el RIF choca con la ficha OCULTA de la propia empresa (el adquirente de sus
    // facturas de retiro, que no sale en Clientes), «ya existe un cliente con ese RIF» mandaría
    // a la persona a buscar algo que no puede ver. Se le dice lo que pasa.
    if (conocido?.code === "DUPLICATE" && taxId !== null) {
      const [propia] = await sql<{ id: string }[]>`
        select cu.id from public.customers cu
         where cu.company_id = ${input.company_id} and cu.own_company
           and upper(regexp_replace(cu.tax_id, '[^a-zA-Z0-9]', '', 'g'))
               = upper(regexp_replace(${taxId}, '[^a-zA-Z0-9]', '', 'g'))`;
      if (propia) {
        return err({
          code: "VALIDATION_FAILED",
          message: "Ese es el RIF de tu propio negocio: no se registra como cliente.",
        });
      }
    }
    if (conocido) return err(conocido);
    throw e;
  }

  // El trigger M4 ya dejó customer.tax_id_established si hubo RIF (red del
  // esquema). El caso de uso registra el ACTO: customer.created.
  if (documento !== null) {
    await registrarDigitoDudoso(sql, {
      tenantId: fila.tenant_id,
      companyId: fila.company_id,
      aggregateType: "customer",
      aggregateId: fila.id,
      documento,
      rulesVersion: RULES_VERSION,
    });
  }
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
  let documento: DocumentoLeido | null = null;
  if (input.tax_id !== null) {
    const leido = validarDocumentoCliente(input.tax_id);
    if (!leido.ok) return leido;
    documento = leido.value;
  }
  const nuevo = documento?.normalizado ?? null;
  const [actual] = await sql<{ tax_id: string | null; person_type_code: string }[]>`
    select tax_id, person_type_code from public.customers
     where id = ${customerId} and company_id = ${input.company_id}`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (nuevo === null && actual.person_type_code !== "natural") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo una persona natural puede quedar sin RIF.",
    });
  }
  // Hallazgo 5 (revisión 2026-09-28): el MISMO documento con otra grafía (el guardado antes de
  // la reparación P-02 puede llevar guiones) no es un cambio: ok, sin acta ni outbox.
  if (actual.tax_id !== null && nuevo !== null && normalizarDocumento(actual.tax_id) === nuevo) {
    const [igual] = await sql<Row[]>`
      select ${sql.unsafe(COLUMNS)} from public.customers
       where id = ${customerId} and company_id = ${input.company_id}`;
    return ok(igual!);
  }
  if (actual.tax_id === nuevo) {
    return err({ code: "VALIDATION_FAILED", message: "El RIF ya es ese." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let fila: Row;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [f] = await sp<Row[]>`
        update public.customers set tax_id = ${nuevo}
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
            ${sql.json({ customer_id: fila.id, from: actual.tax_id, to: nuevo })})`;
  if (documento !== null) {
    await registrarDigitoDudoso(sql, {
      tenantId: fila.tenant_id,
      companyId: fila.company_id,
      aggregateType: "customer",
      aggregateId: fila.id,
      documento,
      rulesVersion: RULES_VERSION,
    });
  }
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

/**
 * E-09 · EL LÍMITE DE FIADO (RESPUESTA §2.8). Permiso propio, `customers.credit.set` —
 * administrativo y dueño; el cajero no—. En USD, al céntimo. El ACTA la escribe el trigger del
 * esquema (`customer.credit_limit_set`, con el valor anterior y el nuevo): no hay camino que
 * cambie el límite sin dejarla, y este caso de uso no la duplica. El mismo trigger es la red del
 * permiso (LAD79). Fijar el mismo valor es un no-op que se dice.
 */
export async function setCustomerCreditLimit(
  uow: UnitOfWork,
  customerId: string,
  input: SetCustomerCreditLimitRequest,
): Promise<Result<CustomerResponse, CustomerError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "customers.credit.set");
  if (!scope.ok) {
    if (scope.error.code !== "PERMISSION_REQUIRED") return scope;
    return err({
      code: "PERMISSION_REQUIRED",
      message:
        "Necesitas el permiso para fijar límites de fiado (customers.credit.set). " +
        "Pídeselo a quien administra el negocio.",
    });
  }
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [actual] = await sql<{ is_system: boolean; igual: boolean }[]>`
    select is_system, credit_limit_usd = ${input.credit_limit_usd}::numeric as igual
      from public.customers
     where id = ${customerId} and company_id = ${input.company_id} for update`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (actual.is_system) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Al «Consumidor final» no se le fía: no hay a quién cobrarle. Identifica al cliente.",
    });
  }
  if (actual.igual) {
    return err({ code: "VALIDATION_FAILED", message: "El límite de fiado ya es ese." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [fila] = await sql<Row[]>`
    update public.customers set credit_limit_usd = ${input.credit_limit_usd}::numeric
     where id = ${customerId} and company_id = ${input.company_id}
    returning ${sql.unsafe(COLUMNS)}`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'customer', ${fila.id},
            'customer.credit_limit_set', 1,
            ${sql.json({
              customer_id: fila.id,
              company_id: fila.company_id,
              credit_limit_usd: fila.credit_limit_usd,
            })})`;
  return ok(fila);
}

/**
 * E-14 · LA CLASIFICACIÓN FISCAL DEL CLIENTE se cambia aparte de la edición rutinaria: de ella
 * depende quién retiene IVA. Decidido por criterio (§2.16): el permiso es el de la identidad
 * fiscal del cliente, `customer.tax_id.manage` (administrativo y dueño; el cajero no), en vez
 * de estrenar otro. Deja acta con el valor anterior y el nuevo.
 */
export async function setCustomerTaxpayerType(
  uow: UnitOfWork,
  customerId: string,
  input: SetCustomerTaxpayerTypeRequest,
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
  const [actual] = await sql<{ taxpayer_type_code: string; is_system: boolean }[]>`
    select taxpayer_type_code, is_system from public.customers
     where id = ${customerId} and company_id = ${input.company_id} for update`;
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (actual.is_system) {
    return err({ code: "VALIDATION_FAILED", message: "«Consumidor final» no se edita." });
  }
  if (actual.taxpayer_type_code === input.taxpayer_type_code) {
    return err({ code: "VALIDATION_FAILED", message: "La clasificación ya es esa." });
  }
  const [cat] = await sql<{ ok: boolean }[]>`
    select exists (select 1 from public.taxpayer_types
                    where code = ${input.taxpayer_type_code} and status = 'active') as ok`;
  if (!cat?.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La clasificación fiscal no existe o está inactiva.",
    });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [fila] = await sql<Row[]>`
    update public.customers set taxpayer_type_code = ${input.taxpayer_type_code}
     where id = ${customerId} and company_id = ${input.company_id}
    returning ${sql.unsafe(COLUMNS)}`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  await auditarYPublicar(sql, fila, "customer.taxpayer_type_changed", {
    from: actual.taxpayer_type_code,
    to: fila.taxpayer_type_code,
  });
  return ok(fila);
}
