import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, UnitOfWork } from "@ladino/db";
import { parseDecimal } from "@ladino/money";
import type {
  CreateProductRequest,
  CreateProductSimpleRequest,
  ProductSimpleResponse,
  MoneyInput,
  PriceItemResponse,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
  ProductResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { createPriceListForProduct, setPriceForProduct } from "./pricing.js";
import { receiveStockFor } from "./inventory.js";

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
  unit_code, tax_category_code, category_id, barcode, image_path,
  is_composed, tracks_lots, tracks_serials, is_manufactured, tracks_expiry,
  template_id, attributes` as const;

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
  image_path: string | null;
  // Banderas de existencia (migraciones 19-20). Las gobierna inventario; el
  // catálogo solo las lleva puestas.
  is_composed: boolean;
  tracks_lots: boolean;
  tracks_serials: boolean;
  is_manufactured: boolean;
  tracks_expiry: boolean;
  template_id: string | null;
  attributes: Record<string, string> | null;
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
  // Sin clasificación en la petición, la de la empresa (la misma regla que el alta simple y
  // la importación): un negocio sin RIF no la elige porque no cobra IVA.
  let clasificacionPedida = input.tax_category_code;
  if (clasificacionPedida === undefined) {
    const [ajustes] = await sql<{ default_tax_category_code: string }[]>`
      select default_tax_category_code from public.company_settings
       where company_id = ${input.company_id}`;
    clasificacionPedida = ajustes?.default_tax_category_code ?? "gravado_general";
  }
  // La categoría tributaria se valida ACTIVA aquí (no solo existente): el FK
  // no sabe de estados.
  const [cat] = await sql<{ code: string }[]>`
    select code from public.product_tax_categories
     where code = ${clasificacionPedida} and status = 'active'`;
  if (!cat) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La clasificación tributaria no existe o está inactiva.",
    });
  }
  const ofrecida = await clasificacionOfrecidaEnVentas(sql, clasificacionPedida);
  if (!ofrecida.ok) return ofrecida;
  const detalle = await detalleDeClasificacion(
    sql,
    clasificacionPedida,
    input.reduced_rate_literal,
    input.tax_category_justification,
  );
  if (!detalle.ok) return detalle;

  // 5. CALCULAR: sin dinero aquí. Versión de reglas para la auditoría.
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // 6. PERSISTIR — el conflicto esperable (SKU/barcode) en savepoint.
  let fila: ProductRow;
  try {
    fila = await sql.savepoint(async (sp) => {
      const [creada] = await sp<ProductRow[]>`
        insert into public.products
          (tenant_id, company_id, sku, name, kind, unit_code, tax_category_code, category_id,
           barcode, status, reduced_rate_literal_code)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.sku}, ${input.name},
                ${input.kind}, ${input.unit_code}, ${cat.code},
                ${input.category_id ?? null}, ${input.barcode ?? null},
                ${input.status ?? "active"}, ${detalle.value.literal})
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
            ${sql.json({
              sku: fila.sku,
              kind: fila.kind,
              tax_category_code: fila.tax_category_code,
              // Hallazgo 10: el literal del art. 64 o la justificación del suntuario, en el acta.
              ...(detalle.value.literal === null
                ? {}
                : { reduced_rate_literal: detalle.value.literal }),
              ...(detalle.value.justificacion === null
                ? {}
                : { justification: detalle.value.justificacion }),
            })})`;
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
  // A5: si la categoría NO cambia, no se le vuelve a exigir nada (ni que esté ofrecida, ni su
  // literal, ni su justificación): se conserva lo que ya tenía, literal incluido.
  const [actual] = await sql<{ tax_category_code: string; literal: string | null }[]>`
    select tax_category_code, reduced_rate_literal_code as literal
      from public.products where id = ${productId} and company_id = ${input.company_id}`;
  const sinCambio = actual?.tax_category_code === input.tax_category_code;
  if (!sinCambio) {
    const ofrecida = await clasificacionOfrecidaEnVentas(sql, input.tax_category_code);
    if (!ofrecida.ok) return ofrecida;
  }
  const detalle = sinCambio
    ? ok({ literal: actual?.literal ?? null, justificacion: null })
    : await detalleDeClasificacion(
        sql,
        input.tax_category_code,
        input.reduced_rate_literal,
        input.tax_category_justification,
      );
  if (!detalle.ok) return detalle;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  const [fila] = await sql<(ProductRow & { anterior: string })[]>`
    update public.products p
       set tax_category_code = ${input.tax_category_code},
           reduced_rate_literal_code = ${detalle.value.literal}
      from (select id, tax_category_code as anterior from public.products
             where id = ${productId} and company_id = ${input.company_id}) previa
     where p.id = previa.id
    returning p.id, p.tenant_id, p.company_id, p.sku, p.name, p.kind, p.status,
              p.unit_code, p.tax_category_code, p.category_id, p.barcode,
              p.is_composed, p.tracks_lots, p.tracks_serials, p.is_manufactured,
              p.tracks_expiry, p.template_id, p.attributes,
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
            ${sql.json({
              from: fila.anterior,
              to: input.tax_category_code,
              ...(detalle.value.literal === null
                ? {}
                : { reduced_rate_literal: detalle.value.literal }),
              ...(detalle.value.justificacion === null
                ? {}
                : { justification: detalle.value.justificacion }),
            })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id},
            'product.tax_category_set', 1,
            ${sql.json({ product_id: fila.id, from: fila.anterior, to: input.tax_category_code })})`;

  return ok(aRespuesta(fila));
}

/**
 * Ata la FOTO al producto (migración 28). La subida al bucket es I/O de la
 * API; aquí solo el hecho de dominio: la ruta, la auditoría y el evento. La
 * ruta vieja no se borra del bucket a propósito — una venta impresa ayer con
 * esa foto no tiene por qué perder su imagen; la limpieza es un job aparte.
 */
/**
 * C-09: ¿puede este usuario poner la foto de ESTE producto? La ruta lo pregunta ANTES de procesar
 * y subir la imagen: un 403 o un 404 no deja objetos huérfanos. `setProductImage` vuelve a
 * autorizar al persistir.
 */
export async function autorizarImagenProducto(
  uow: UnitOfWork,
  productId: string,
  companyId: string,
): Promise<Result<{ tenantId: string }, ProductError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, companyId, "product.manage");
  if (!scope.ok) return scope;
  const [existe] = await sql<{ id: string }[]>`
    select id from public.products where id = ${productId} and company_id = ${companyId}`;
  if (!existe) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  return ok({ tenantId: scope.value.tenantId });
}

export async function setProductImage(
  uow: UnitOfWork,
  productId: string,
  input: { company_id: string; image_path: string },
): Promise<Result<ProductResponse, ProductError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.manage");
  if (!scope.ok) return scope;
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const [fila] = await sql<ProductRow[]>`
    update public.products set image_path = ${input.image_path}
     where id = ${productId} and company_id = ${input.company_id}
    returning ${sql.unsafe(PRODUCT_COLUMNS)},
              to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;
  if (!fila) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.image_set',
            'user', now(), ${RULES_VERSION}, ${sql.json({ image_path: input.image_path })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${fila.tenant_id}, ${fila.company_id}, 'product', ${fila.id}, 'product.image_set', 1,
            ${sql.json({ product_id: fila.id, image_path: input.image_path })})`;
  return ok(aRespuesta(fila));
}

/** La moneda en que se ancla todo precio de lista (ADR-0046/0047). */
const MONEDA_ANCLA = "USD";

// ── El ALTA SIMPLE de la Fase C ─────────────────────────────────────────────

/**
 * Un producto en UNA pantalla: nombre, precio y ya. Compone los casos de uso
 * existentes DENTRO de la misma transacción: crear → activar → precio de detal
 * (y de mayor si aplica) → inventario inicial con su costo. Cada pieza valida
 * sus propios permisos; si algo falla, no queda nada.
 *
 * Lo que este caso decide y el formulario no pregunta:
 *   · el SKU se GENERA (`P-0001`…) si no vino: la persona piensa en «Harina
 *     pan», no en códigos. Si choca con uno existente, prueba el siguiente;
 *   · la clasificación fiscal sale de company_settings (y el contador la
 *     corrige por producto en /admin — nunca se pregunta en el mostrador);
 *   · el precio va en USD a la lista predeterminada de la caja (o a «detal»),
 *     que se crea si no existe;
 *   · el stock inicial es una ENTRADA de kardex con costo y referencia
 *     `inventario-inicial`, no un número suelto en una columna.
 */
export async function createProductSimple(
  uow: UnitOfWork,
  input: CreateProductSimpleRequest,
): Promise<Result<ProductSimpleResponse, ProductError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Los maestros exigen un usuario real." });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "product.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  // EL PRECIO SE ANCLA EN DÓLARES (ADR-0046/0047, regla del dueño): la lista
  // guarda USD y la pantalla enseña el equivalente en Bs con la tasa del día,
  // calculado por el servidor. Un precio en bolívares quedaría congelado y
  // habría que remarcarlo a mano cada vez que se mueve la tasa.
  for (const [etiqueta, p] of [
    ["precio", input.price],
    ["precio al mayor", input.wholesale_price],
  ] as const) {
    if (p !== undefined && p.currency !== MONEDA_ANCLA) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El ${etiqueta} se carga en dólares (USD). Ladino muestra su valor en bolívares con la tasa del día.`,
      });
    }
  }

  // Un precio en cero regala el producto (QA de pantalla 2026-09-15, h. 4). La lista admite
  // cero —un precio gratis puede ser legítimo—, pero el alta simple no lo pone por descuido.
  for (const [etiqueta, p] of [
    ["precio", input.price],
    ["precio al mayor", input.wholesale_price],
  ] as const) {
    if (p !== undefined && !/[1-9]/.test(p.amount)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El ${etiqueta} tiene que ser mayor que cero.`,
      });
    }
  }
  // Con existencia, un costo en cero infla la ganancia de cada venta (h. 5).
  if (input.initial_stock !== undefined && !/[1-9]/.test(input.initial_stock.unit_cost.amount)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Con existencia, el costo por unidad tiene que ser mayor que cero.",
    });
  }

  const esServicio = input.is_service === true;
  if (esServicio && input.initial_stock !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un servicio no tiene existencias: quita el inventario inicial.",
    });
  }

  const [ajustes] = await sql<
    { default_tax_category_code: string; default_warehouse_id: string | null }[]
  >`select default_tax_category_code, default_warehouse_id
      from public.company_settings where company_id = ${input.company_id}`;
  // C-02: la clasificación pedida, o la de la empresa. La valida `createProduct` (activa,
  // ofrecida en ventas, literal o justificación), igual que en el alta completa.
  const clasificacion =
    input.tax_category_code ?? ajustes?.default_tax_category_code ?? "gravado_general";
  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${input.company_id}`;
  const funcional = empresa!.moneda;

  // La categoría por NOMBRE, creada al vuelo. El único (company, name) decide
  // los empates; si otro la creó hace un milisegundo, se relee.
  let categoryId: string | undefined;
  const nombreCategoria = input.category_name;
  if (nombreCategoria !== undefined) {
    const [existente] = await sql<{ id: string }[]>`
      select id from public.product_categories
       where company_id = ${input.company_id} and name = ${nombreCategoria}`;
    if (existente) {
      categoryId = existente.id;
    } else {
      try {
        const creada = await sql.savepoint(async (sp) => {
          const [c] = await sp<{ id: string }[]>`
            insert into public.product_categories (tenant_id, company_id, name)
            values (${scope.value.tenantId}, ${input.company_id}, ${nombreCategoria})
            returning id`;
          return c!;
        });
        categoryId = creada.id;
      } catch (e) {
        if ((e as { code?: string }).code !== "23505") throw e;
        const [otra] = await sql<{ id: string }[]>`
          select id from public.product_categories
           where company_id = ${input.company_id} and name = ${nombreCategoria}`;
        categoryId = otra?.id;
      }
    }
  }

  // El SKU: el de la persona, o el siguiente `P-NNNN` libre.
  const skuManual = input.sku !== undefined;
  const [conteo] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.products
     where company_id = ${input.company_id} and system_code is null`;
  let producto: ProductResponse | null = null;
  for (let intento = 0; intento < 5 && producto === null; intento++) {
    const candidato = skuManual
      ? input.sku!
      : `P-${String((conteo?.n ?? 0) + 1 + intento).padStart(4, "0")}`;
    const creado = await createProduct(uow, {
      company_id: input.company_id,
      sku: candidato,
      name: input.name,
      kind: esServicio ? "service" : "good",
      unit_code: input.unit_code ?? "unidad",
      tax_category_code: clasificacion,
      // Nace vendible: el alta simple es el mostrador, no un borrador de
      // catálogo. Desde 2026-09-10 lo dice el propio alta, así que ya no hace
      // falta una segunda escritura para activarlo.
      status: "active",
      ...(input.reduced_rate_literal === undefined
        ? {}
        : { reduced_rate_literal: input.reduced_rate_literal }),
      ...(input.tax_category_justification === undefined
        ? {}
        : { tax_category_justification: input.tax_category_justification }),
      ...(categoryId === undefined ? {} : { category_id: categoryId }),
      ...(input.barcode === undefined ? {} : { barcode: input.barcode }),
    });
    if (creado.ok) {
      producto = creado.value;
      break;
    }
    if (creado.error.code === "DUPLICATE" && !skuManual) continue;
    return creado;
  }
  if (producto === null) {
    return err({
      code: "VALIDATION_FAILED",
      message: "No se encontró un código libre para el producto. Intenta con uno manual.",
    });
  }

  // El precio de detal en SU moneda; la lista se crea si no existe.
  const precio = await ponerPrecioEnLista(
    uow,
    input.company_id,
    funcional,
    "detal",
    producto.id,
    input.price,
  );
  if (!precio.ok) return precio;
  let mayor: PriceItemResponse | null = null;
  if (input.wholesale_price !== undefined) {
    const r = await ponerPrecioEnLista(
      uow,
      input.company_id,
      funcional,
      "mayor",
      producto.id,
      input.wholesale_price,
    );
    if (!r.ok) return r;
    mayor = r.value;
  }

  // El inventario inicial: una ENTRADA de kardex con costo, no un número suelto.
  let stockInicial: ProductSimpleResponse["initial_stock"] = null;
  if (input.initial_stock !== undefined) {
    const costoUnit = parseDecimal(input.initial_stock.unit_cost.amount);
    const cantidad = parseDecimal(input.initial_stock.quantity);
    if (!costoUnit.ok || !cantidad.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad o costo no interpretables." });
    }
    // Sin almacén explícito, EL PRINCIPAL (migración 60): el de ajustes si está activo, si no el
    // activo más antiguo. Antes, con dos almacenes, el alta con existencia se negaba.
    let almacen = input.initial_stock.warehouse_id ?? null;
    if (almacen === null) {
      const [principal] = await sql<{ id: string | null }[]>`
        select platform.default_warehouse(${input.company_id}) as id`;
      almacen = principal?.id ?? null;
      if (almacen === null) {
        return err({
          code: "VALIDATION_FAILED",
          message: "La empresa no tiene un depósito activo donde entre la mercancía.",
        });
      }
    }
    const monedaCosto = input.initial_stock.unit_cost.currency;
    let fx: { rate: string; source: string; at: string } | undefined;
    if (monedaCosto !== funcional) {
      const [t] = await sql<{ rate: string | null; source: string | null }[]>`
        select f.rate::text as rate, f.source
          from platform.rate_for(${input.company_id}, ${monedaCosto}, ${funcional},
                                 (now() at time zone 'America/Caracas')::date) f`;
      if (!t?.rate) {
        return err({
          code: "VALIDATION_FAILED",
          message: `No hay tasa BCV de ${monedaCosto} a ${funcional}: tráela en Mi dinero antes de costear en divisa.`,
        });
      }
      fx = { rate: t.rate, source: t.source ?? "manual", at: new Date().toISOString() };
    }
    const total = costoUnit.value.times(cantidad.value).toDecimalPlaces(8, 4);
    // La existencia inicial la autoriza EL ALTA (`product.manage`), no `inventory.move`
    // (ADR-0068 §1): quien da de alta el producto registra lo que ya tiene.
    const recibido = await receiveStockFor(
      uow,
      {
        company_id: input.company_id,
        warehouse_id: almacen,
        product_id: producto.id,
        quantity: input.initial_stock.quantity,
        amount: total.toFixed(8),
        currency: monedaCosto,
        ...(fx === undefined ? {} : { fx }),
        reference: "inventario-inicial",
        note: "Inventario inicial del alta simple",
      },
      "product.manage",
    );
    if (!recibido.ok) {
      const e = recibido.error;
      if (e.code === "PERMISSION_REQUIRED" || e.code === "NOT_FOUND") {
        return err({ code: e.code, message: e.message });
      }
      return err({ code: "VALIDATION_FAILED", message: e.message });
    }
    stockInicial = {
      quantity: input.initial_stock.quantity,
      unit_cost: input.initial_stock.unit_cost.amount,
      currency: monedaCosto,
      warehouse_id: almacen,
    };
  }

  return ok({
    product: producto,
    price: precio.value,
    wholesale_price: mayor,
    initial_stock: stockInicial,
  });
}

/**
 * La lista «detal»/«mayor» de la MONEDA pedida. Si la del nombre base vive en
 * otra moneda (createCompany las siembra en la funcional), se usa o se crea la
 * variante `detal USD` — cambiarle la moneda a una lista con precios puestos
 * reinterpretaría todos sus importes de golpe.
 *
 * La lista y el precio los autoriza EL ALTA (`product.manage`), no
 * `price_list.manage`: quien da de alta un producto le pone su precio
 * (ADR-0068 §1, B-16; y la importación, que pasa por aquí fila a fila, C-08).
 */
export async function ponerPrecioEnLista(
  uow: UnitOfWork,
  companyId: string,
  funcional: string,
  base: "detal" | "mayor",
  productId: string,
  precio: MoneyInput,
): Promise<Result<PriceItemResponse, ProductError>> {
  const { sql } = uow;
  const destino = await listaDeDestino(sql, companyId, funcional, base, precio.currency);
  if (destino.monedaLista !== null && destino.monedaLista !== precio.currency) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La lista «${destino.nombre}» vive en ${destino.monedaLista} y el precio vino en ${precio.currency}.`,
    });
  }
  let listaId = destino.id;
  if (listaId === null) {
    const creada = await createPriceListForProduct(uow, {
      company_id: companyId,
      name: destino.nombre,
      currency_code: precio.currency,
    });
    if (!creada.ok) {
      if (creada.error.code === "PERMISSION_REQUIRED" || creada.error.code === "NOT_FOUND") {
        return err({ code: creada.error.code, message: creada.error.message });
      }
      return err({ code: "VALIDATION_FAILED", message: creada.error.message });
    }
    listaId = creada.value.id;
  }
  const puesto = await setPriceForProduct(uow, listaId, {
    company_id: companyId,
    product_id: productId,
    amount: precio.amount,
    effective_from: new Date().toISOString(),
  });
  if (!puesto.ok) {
    if (puesto.error.code === "PERMISSION_REQUIRED" || puesto.error.code === "NOT_FOUND") {
      return err({ code: puesto.error.code, message: puesto.error.message });
    }
    return err({ code: "VALIDATION_FAILED", message: puesto.error.message });
  }
  return ok(puesto.value);
}

/**
 * La lista de DESTINO de un precio «detal»/«mayor» en la moneda pedida — la única copia de esa
 * lógica, la usan `ponerPrecioEnLista` (para escribir) y la importación (para saber si el precio
 * «ya era ese», ADR-0074 A1: comparar contra CUALQUIER lista de la moneda daba por bueno un
 * precio de mayor igual al de la fila).
 *
 *   · «detal» va a la lista PREDETERMINADA de la caja (migración 36) cuando el dueño la fijó y
 *     su moneda coincide: el alta simple escribe donde /vender lee;
 *   · si no, a la lista por nombre. El nombre base («detal»/«mayor») es de la moneda en que la
 *     lista NACIÓ (en una empresa vieja, la funcional; en una nueva, USD); en otra moneda, la
 *     variante «detal VES» / «detal USD».
 *
 * `id` null: la lista no existe todavía y se crearía con `nombre`. `monedaLista` es la moneda
 * de la lista encontrada, para que el llamante rechace una lista de otra moneda.
 */
export async function listaDeDestino(
  sql: TransactionSql,
  companyId: string,
  funcional: string,
  base: "detal" | "mayor",
  moneda: string,
): Promise<{ id: string | null; nombre: string; monedaLista: string | null }> {
  if (base === "detal") {
    const [predeterminada] = await sql<{ id: string; name: string; currency_code: string }[]>`
      select l.id, l.name, l.currency_code
        from public.company_settings cs
        join public.price_lists l on l.id = cs.default_price_list_id
       where cs.company_id = ${companyId} and l.status = 'active'`;
    if (predeterminada !== undefined && predeterminada.currency_code === moneda) {
      return { id: predeterminada.id, nombre: predeterminada.name, monedaLista: moneda };
    }
  }
  const [base_] = await sql<{ currency_code: string }[]>`
    select currency_code from public.price_lists
     where company_id = ${companyId} and name = ${base} and status = 'active'`;
  const monedaBase = base_?.currency_code ?? funcional;
  const nombre = moneda === monedaBase ? base : `${base} ${moneda}`;
  const [lista] = await sql<{ id: string; currency_code: string }[]>`
    select id, currency_code from public.price_lists
     where company_id = ${companyId} and name = ${nombre} and status = 'active'`;
  return { id: lista?.id ?? null, nombre, monedaLista: lista?.currency_code ?? null };
}

/**
 * H3 (ADR-0073): el servidor aplica `offered_in_sales`. Una clasificación sin plantilla vigente
 * del catálogo de alícuotas ofrecida en ventas (`no_sujeto`, pendiente de fuente; `exonerado`,
 * solo importación) no se asigna a un producto: la pantalla ya no la ofrece, y la API tampoco la
 * acepta por otro camino. El día de Caracas decide la vigencia.
 */
export async function clasificacionOfrecidaEnVentas(
  sql: TransactionSql,
  codigo: string,
): Promise<Result<true, { code: "VALIDATION_FAILED"; message: string }>> {
  const [ofrecida] = await sql<{ ok: boolean }[]>`
    select exists (
      select 1 from public.tax_rule_templates t
       where t.product_tax_category = ${codigo} and t.offered_in_sales
         and t.effective_from <= (now() at time zone 'America/Caracas')::date
         and (t.effective_to is null
              or t.effective_to > (now() at time zone 'America/Caracas')::date)) as ok`;
  if (ofrecida?.ok !== true) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        `La clasificación «${codigo}» no se ofrece en ventas: el catálogo de alícuotas no la trae ` +
        "con fuente vigente para vender (ADR-0073). Elige otra, o pídele a tu contador que la revise.",
    });
  }
  return ok(true);
}

/**
 * Hallazgo 10 (ADR-0073): lo que cada clasificación exige además de estar ofrecida.
 *   · `gravado_reducida`: un literal de la LISTA CERRADA del art. 64 (`tax_reduced_rate_literals`).
 *     La lista nace vacía —nadie la trajo con fuente—, así que hoy no se puede clasificar nada como
 *     reducida, y el mensaje lo dice (PENDIENTES_ASESOR P-51).
 *   · `gravado_adicional`: el art. 61 no tiene lista con fuente; se exige por qué el bien es suntuario,
 *     y la justificación queda en el acta (P-60).
 * Lo demás no lleva ni literal ni justificación: si vienen, no se guardan.
 */
async function detalleDeClasificacion(
  sql: TransactionSql,
  codigo: string,
  literal: string | undefined,
  justificacion: string | undefined,
): Promise<
  Result<
    { literal: string | null; justificacion: string | null },
    { code: "VALIDATION_FAILED"; message: string }
  >
> {
  if (codigo === "gravado_reducida") {
    if (literal === undefined) {
      const [lista] = await sql<{ n: number }[]>`
        select count(*)::int as n from public.tax_reduced_rate_literals`;
      return err({
        code: "VALIDATION_FAILED",
        message:
          "La alícuota reducida es una lista cerrada de bienes (LIVA art. 64): indica el literal del " +
          "bien. " +
          ((lista?.n ?? 0) === 0
            ? "La lista todavía no está cargada con su fuente: pídesela a tu contador " +
              "(VALIDAR-TRIBUTARIO, PENDIENTES_ASESOR P-51)."
            : "Elige uno de la lista."),
      });
    }
    const [hay] = await sql<{ code: string }[]>`
      select code from public.tax_reduced_rate_literals where code = ${literal}`;
    if (!hay) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El literal «${literal}» no está en la lista cerrada del art. 64 de la LIVA.`,
      });
    }
    return ok({ literal, justificacion: null });
  }
  if (codigo === "gravado_adicional") {
    if (justificacion === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "La alícuota adicional (LIVA art. 61) grava bienes suntuarios y no hay una lista con fuente " +
          "(VALIDAR-TRIBUTARIO, PENDIENTES_ASESOR P-60): escribe la justificación de por qué este " +
          "bien es suntuario; queda en el acta.",
      });
    }
    return ok({ literal: null, justificacion });
  }
  return ok({ literal: null, justificacion: null });
}
