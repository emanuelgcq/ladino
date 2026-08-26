import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type {
  CreatePriceListRequest,
  PriceListResponse,
  SetPriceRequest,
  PriceItemResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * Casos de uso de precios (ADR-0032) — RIGOR MÁXIMO: es dinero.
 *
 * El importe entra como STRING (AmountString, regla 7), viaja como parámetro
 * a numeric(24,8) y vuelve como string: en ningún punto pasa por un number.
 * El solapamiento de vigencias no se comprueba aquí: lo hace IMPOSIBLE el
 * EXCLUDE del esquema, y este caso de uso solo traduce el 23P01 al contrato.
 */

export type PricingError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "PRICE_OVERLAP"; message: string };

export async function createPriceList(
  uow: UnitOfWork,
  input: CreatePriceListRequest,
): Promise<Result<PriceListResponse, PricingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "price_list.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [moneda] = await sql<{ code: string }[]>`
    select code from public.currencies where code = ${input.currency_code}`;
  if (!moneda) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La moneda no está en el catálogo. Añadirla es una fila en currencies, no un texto libre.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  interface Fila {
    id: string;
    tenant_id: string;
    company_id: string;
    name: string;
    currency_code: string;
    status: "active" | "inactive";
    created_at: string;
  }
  let fila: Fila;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [creada] = await sp<Fila[]>`
        insert into public.price_lists (tenant_id, company_id, name, currency_code)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.name}, ${input.currency_code})
        returning id, tenant_id, company_id, name, currency_code, status,
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
      return creada!;
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") {
      return err({
        code: "DUPLICATE",
        message: "Ya existe una lista de precios con ese nombre en esta empresa.",
      });
    }
    throw e;
  }

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'price_list', ${fila.id}, 'price_list.created',
            'user', now(), ${RULES_VERSION},
            ${sql.json({ name: fila.name, currency_code: fila.currency_code })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'price_list', ${fila.id}, 'price_list.created', 1,
            ${sql.json({ price_list_id: fila.id, company_id: fila.company_id })})`;

  return ok(fila);
}

/**
 * Carga un precio por vigencia — APPEND: si hay un período abierto anterior,
 * el esquema lo cierra en el mismo INSERT (autocierre, ADR-0032). Un precio
 * mal cargado se corrige con otra fila; el importe de una fila no se toca.
 */
export async function setPrice(
  uow: UnitOfWork,
  priceListId: string,
  input: SetPriceRequest,
): Promise<Result<PriceItemResponse, PricingError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "price_list.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  // La lista se lee ANTES para responder con su moneda y validar estado; el FK
  // compuesto (company_id, id) sigue siendo la defensa real contra la lista
  // ajena.
  const [lista] = await sql<{ id: string; currency_code: string; status: string }[]>`
    select id, currency_code, status from public.price_lists
     where id = ${priceListId} and company_id = ${input.company_id}`;
  if (!lista) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (lista.status !== "active") {
    return err({ code: "VALIDATION_FAILED", message: "La lista de precios está inactiva." });
  }
  if (input.effective_to !== undefined && input.effective_to <= input.effective_from) {
    return err({
      code: "VALIDATION_FAILED",
      message: "effective_to debe ser posterior a effective_from.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  interface Fila {
    id: string;
    tenant_id: string;
    company_id: string;
    price_list_id: string;
    product_id: string;
    amount: string;
    effective_from: string;
    effective_to: string | null;
  }
  let fila: Fila;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [creada] = await sp<Fila[]>`
        insert into public.price_list_items
          (tenant_id, company_id, price_list_id, product_id, amount, effective_from, effective_to)
        values (${scope.value.tenantId}, ${input.company_id}, ${priceListId}, ${input.product_id},
                ${input.amount}, ${input.effective_from}, ${input.effective_to ?? null})
        returning id, tenant_id, company_id, price_list_id, product_id,
                  amount::text as amount,
                  to_char(effective_from at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as effective_from,
                  case when effective_to is null then null
                       else to_char(effective_to at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') end as effective_to`;
      return creada!;
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23P01") {
      // El EXCLUDE: la vigencia nueva pisa un período CERRADO (los abiertos
      // los cierra el autocierre). Corregir historia exige rangos explícitos.
      return err({
        code: "PRICE_OVERLAP",
        message: "La vigencia se solapa con un período ya cerrado de este producto en la lista.",
      });
    }
    if (code === "23505") {
      return err({
        code: "DUPLICATE",
        message: "Ya hay un precio de este producto en la lista con esa misma fecha de inicio.",
      });
    }
    if (code === "23503") {
      return err({
        code: "VALIDATION_FAILED",
        message: "El producto no pertenece a esta empresa.",
      });
    }
    throw e;
  }

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'price_list', ${fila.price_list_id}, 'price.set',
            'user', now(), ${RULES_VERSION},
            ${sql.json({
              product_id: fila.product_id,
              amount: fila.amount,
              currency: lista.currency_code,
              effective_from: fila.effective_from,
              effective_to: fila.effective_to,
            })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'price_list', ${fila.price_list_id}, 'price.set', 1,
            ${sql.json({
              price_list_id: fila.price_list_id,
              product_id: fila.product_id,
              amount: fila.amount,
              currency: lista.currency_code,
            })})`;

  return ok({
    id: fila.id,
    price_list_id: fila.price_list_id,
    product_id: fila.product_id,
    amount: fila.amount,
    currency: lista.currency_code,
    effective_from: fila.effective_from,
    effective_to: fila.effective_to,
  });
}
