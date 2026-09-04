import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork } from "@ladino/db";
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
import { createPriceList, setPrice } from "./pricing.js";
import { receiveStock } from "./inventory.js";

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
            ${sql.json({ from: fila.anterior, to: input.tax_category_code })})`;
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
 *   · el precio va a la lista «detal» de SU moneda, que se crea si no existe;
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
  const clasificacion = ajustes?.default_tax_category_code ?? "gravado_general";
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
    select count(*)::int as n from public.products where company_id = ${input.company_id}`;
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

  // Nace vendible: el alta simple es el mostrador, no un borrador de catálogo.
  const activado = await updateProduct(uow, producto.id, {
    company_id: input.company_id,
    status: "active",
  });
  if (!activado.ok) return activado;
  producto = activado.value;

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
    let almacen = input.initial_stock.warehouse_id ?? ajustes?.default_warehouse_id ?? null;
    if (almacen === null) {
      const almacenes = await sql<{ id: string }[]>`
        select id from public.warehouses where company_id = ${input.company_id} limit 2`;
      if (almacenes.length === 1) {
        almacen = almacenes[0]!.id;
      } else {
        return err({
          code: "VALIDATION_FAILED",
          message: "Hay más de un almacén: indica en cuál entra la mercancía.",
        });
      }
    }
    const monedaCosto = input.initial_stock.unit_cost.currency;
    let fx: { rate: string; source: string; at: string } | undefined;
    if (monedaCosto !== funcional) {
      const [t] = await sql<{ rate: string | null; source: string | null }[]>`
        select r.rate::text as rate, r.source from public.exchange_rates r
         where r.from_currency = ${monedaCosto} and r.to_currency = ${funcional}
           and r.rate_date <= current_date
         order by r.rate_date desc, r.created_at desc limit 1`;
      if (!t?.rate) {
        return err({
          code: "VALIDATION_FAILED",
          message: `No hay tasa de ${monedaCosto} a ${funcional}: carga la tasa del día antes de costear en divisa.`,
        });
      }
      fx = { rate: t.rate, source: t.source ?? "manual", at: new Date().toISOString() };
    }
    const total = costoUnit.value.times(cantidad.value).toDecimalPlaces(8, 4);
    const recibido = await receiveStock(uow, {
      company_id: input.company_id,
      warehouse_id: almacen,
      product_id: producto.id,
      quantity: input.initial_stock.quantity,
      amount: total.toFixed(8),
      currency: monedaCosto,
      ...(fx === undefined ? {} : { fx }),
      reference: "inventario-inicial",
      note: "Inventario inicial del alta simple",
    });
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
 */
async function ponerPrecioEnLista(
  uow: UnitOfWork,
  companyId: string,
  funcional: string,
  base: "detal" | "mayor",
  productId: string,
  precio: MoneyInput,
): Promise<Result<PriceItemResponse, ProductError>> {
  const { sql } = uow;
  // El precio «detal» va a la lista PREDETERMINADA de la caja (migración 36)
  // cuando el dueño la fijó y su moneda coincide: el alta simple escribe
  // donde /vender lee. Sin el dato —o en otra moneda—, la variante por nombre
  // de siempre.
  if (base === "detal") {
    const [predeterminada] = await sql<{ id: string; currency_code: string }[]>`
      select l.id, l.currency_code
        from public.company_settings cs
        join public.price_lists l on l.id = cs.default_price_list_id
       where cs.company_id = ${companyId} and l.status = 'active'`;
    if (predeterminada !== undefined && predeterminada.currency_code === precio.currency) {
      const puestoDirecto = await setPrice(uow, predeterminada.id, {
        company_id: companyId,
        product_id: productId,
        amount: precio.amount,
        effective_from: new Date().toISOString(),
      });
      if (!puestoDirecto.ok) {
        if (
          puestoDirecto.error.code === "PERMISSION_REQUIRED" ||
          puestoDirecto.error.code === "NOT_FOUND"
        ) {
          return err({ code: puestoDirecto.error.code, message: puestoDirecto.error.message });
        }
        return err({ code: "VALIDATION_FAILED", message: puestoDirecto.error.message });
      }
      return ok(puestoDirecto.value);
    }
  }
  const nombre = precio.currency === funcional ? base : `${base} ${precio.currency}`;
  const [lista] = await sql<{ id: string; currency_code: string }[]>`
    select id, currency_code from public.price_lists
     where company_id = ${companyId} and name = ${nombre} and status = 'active'`;
  let listaId = lista?.id;
  if (lista !== undefined && lista.currency_code !== precio.currency) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La lista «${nombre}» vive en ${lista.currency_code} y el precio vino en ${precio.currency}.`,
    });
  }
  if (listaId === undefined) {
    const creada = await createPriceList(uow, {
      company_id: companyId,
      name: nombre,
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
  const puesto = await setPrice(uow, listaId, {
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
