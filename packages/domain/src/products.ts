import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
import type {
  CreateProductRequest,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
  ProductResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

/**
 * Casos de uso del catálogo de productos — la plantilla de create-company.ts
 * con los diez pasos, en versión COMPANY-SCOPED: la autorización pasa por
 * `companyScope()` (una sola copia), el conflicto esperable vive en un
 * savepoint (H-1: postgres.js rechaza begin() aunque el callback capture), y
 * auditoría + outbox van en la MISMA transacción.
 *
 * Desviación declarada respecto de la plantilla: NO se toma `FOR UPDATE`
 * sobre la company. El lock del tenant en create-company protege una decisión
 * que depende del estado leído; aquí serializaría TODO el catálogo de la
 * empresa por un maestro reversible (rigor normal). El único que compite de
 * verdad es el SKU, y eso lo decide el índice único, no un lock.
 */

export type ProductError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string };

const PRODUCT_COLUMNS = `id, tenant_id, company_id, sku, name, kind, status,
  unit_code, tax_category_code, category_id, barcode` as const;

interface ProductRow {
  id: string;
  tenant_id: string;
  company_id: string;
  sku: string;
  name: string;
  kind: "good" | "service";
  status: "draft" | "active" | "inactive";
  unit_code: string;
  tax_category_code: string;
  category_id: string | null;
  barcode: string | null;
  created_at: string;
}

function aRespuesta(fila: ProductRow): ProductResponse {
  return { ...fila };
}

/** El 23505 dice QUÉ único violó: el mensaje del dominio lo traduce (H-1: se
 *  aserta el mensaje, no solo el código). */
function duplicado(e: unknown): ProductError | null {
  const pg = e as { code?: string; constraint_name?: string };
  if (pg.code !== "23505") return null;
  if (pg.constraint_name === "products_company_barcode_uidx") {
    return {
      code: "DUPLICATE",
      message: "Ya existe un producto con ese código de barras en esta empresa.",
    };
  }
  return { code: "DUPLICATE", message: "Ya existe un producto con ese SKU en esta empresa." };
}

export async function createProduct(
  uow: UnitOfWork,
  input: CreateProductRequest,
): Promise<Result<ProductResponse, ProductError>> {
  const { sql, actor } = uow;

  // 1. AUTORIZAR (usuario real + visibilidad + product.manage).
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.manage");
  if (!scope.ok) return scope;
  // (2. idempotencia: en el middleware.)
  // 3-4. VALIDAR negocio: una empresa suspendida no altera su catálogo.
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  // La categoría tributaria se valida ACTIVA aquí (no solo existente): el FK
  // no sabe de estados.
  const [cat] = await sql<{ code: string }[]>`
    select code from public.product_tax_categories
     where code = ${input.tax_category_code} and status = 'active'`;
  if (!cat) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La clasificación tributaria no existe o está inactiva.",
    });
  }

  // 5. CALCULAR: sin dinero aquí. Versión de reglas para la auditoría.
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // 6. PERSISTIR — el conflicto esperable (SKU/barcode) en savepoint.
  let fila: ProductRow;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [creada] = await sp<ProductRow[]>`
        insert into public.products
          (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, category_id, barcode)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.sku}, ${input.name},
                ${input.kind}, ${input.unit_code}, ${input.tax_category_code},
                ${input.category_id ?? null}, ${input.barcode ?? null})
        returning ${sp.unsafe(PRODUCT_COLUMNS)},
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
      return creada!;
    });
  } catch (e) {
    const dup = duplicado(e);
    if (dup) return err(dup);
    if ((e as { code?: string }).code === "23503") {
      // unidad o categoría comercial inexistente/ajena: dato inválido, no 500.
      return err({
        code: "VALIDATION_FAILED",
        message: "Unidad o categoría inválida para esta empresa.",
      });
    }
    throw e;
  }

  // 7. contabilidad/inventario: no-op declarado (catálogo puro).
  // 8-9. AUDITAR y OUTBOX, misma transacción.
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.created',
            'user', now(), ${RULES_VERSION},
            ${sql.json({ sku: fila.sku, kind: fila.kind, tax_category_code: fila.tax_category_code })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.created', 1,
            ${sql.json({ product_id: fila.id, company_id: fila.company_id, sku: fila.sku })})`;

  // 10. commit: de withTransaction.
  return ok(aRespuesta(fila));
}

export async function updateProduct(
  uow: UnitOfWork,
  productId: string,
  input: UpdateProductRequest,
): Promise<Result<ProductResponse, ProductError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  if (
    input.name === undefined &&
    input.status === undefined &&
    input.category_id === undefined &&
    input.barcode === undefined
  ) {
    return err({ code: "VALIDATION_FAILED", message: "Nada que actualizar." });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let fila: ProductRow | undefined;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [actualizada] = await sp<ProductRow[]>`
        update public.products set
          name        = coalesce(${input.name ?? null}, name),
          status      = coalesce(${input.status ?? null}, status),
          category_id = case when ${input.category_id === undefined}
                             then category_id else ${input.category_id ?? null} end,
          barcode     = case when ${input.barcode === undefined}
                             then barcode else ${input.barcode ?? null} end
        where id = ${productId} and company_id = ${input.company_id}
        returning ${sp.unsafe(PRODUCT_COLUMNS)},
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
      return actualizada;
    });
  } catch (e) {
    const dup = duplicado(e);
    if (dup) return err(dup);
    if ((e as { code?: string }).code === "23503") {
      return err({
        code: "VALIDATION_FAILED",
        message: "Unidad o categoría inválida para esta empresa.",
      });
    }
    throw e;
  }
  // El producto de OTRA company ya murió en companyScope (404). Este es el
  // id inexistente DENTRO de la company visible.
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.updated',
            'user', now(), ${RULES_VERSION},
            ${sql.json({
              name: input.name ?? null,
              status: input.status ?? null,
              category_id: input.category_id ?? null,
              barcode: input.barcode ?? null,
            })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.updated', 1,
            ${sql.json({ product_id: fila.id, company_id: fila.company_id })})`;

  return ok(aRespuesta(fila));
}

/**
 * El mapeo tributario tiene PERMISO PROPIO (product.tax_category.set): la spec
 * dice «contador aprueba mapeo contable/tributario» — quien mantiene el
 * catálogo no reclasifica impuestos por accidente (D-10, segregación).
 */
export async function setProductTaxCategory(
  uow: UnitOfWork,
  productId: string,
  input: SetProductTaxCategoryRequest,
): Promise<Result<ProductResponse, ProductError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.tax_category.set");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [cat] = await sql<{ code: string }[]>`
    select code from public.product_tax_categories
     where code = ${input.tax_category_code} and status = 'active'`;
  if (!cat) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La clasificación tributaria no existe o está inactiva.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  const [fila] = await sql<(ProductRow & { anterior: string })[]>`
    update public.products p
       set tax_category_code = ${input.tax_category_code}
      from (select id, tax_category_code as anterior from public.products
             where id = ${productId} and company_id = ${input.company_id}) previa
     where p.id = previa.id
    returning p.id, p.tenant_id, p.company_id, p.sku, p.name, p.kind, p.status,
              p.unit_code, p.tax_category_code, p.category_id, p.barcode,
              previa.anterior,
              to_char(p.created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  // El hecho auditado lleva el ANTES y el DESPUÉS: una reclasificación fiscal
  // sin el valor anterior no se puede revisar (la lección de la migración 10).
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id},
            'product.tax_category_set', 'user', now(), ${RULES_VERSION},
            ${sql.json({ from: fila.anterior, to: input.tax_category_code })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id},
            'product.tax_category_set', 1,
            ${sql.json({ product_id: fila.id, from: fila.anterior, to: input.tax_category_code })})`;

  return ok(aRespuesta(fila));
}
