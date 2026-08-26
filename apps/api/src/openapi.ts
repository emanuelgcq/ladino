import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
  extendZodWithOpenApi,
} from "@asteasolutions/zod-to-openapi";
import { z } from "zod";

// Necesario para que los z.object de parámetros (headers) generen metadatos.
extendZodWithOpenApi(z);
import {
  CreateCompanyRequest,
  CompanyResponse,
  ErrorResponse,
  CreateProductRequest,
  UpdateProductRequest,
  SetProductTaxCategoryRequest,
  ProductResponse,
  ListProductsResponse,
  CreatePriceListRequest,
  PriceListResponse,
  SetPriceRequest,
  PriceItemResponse,
} from "@ladino/schemas";

/**
 * El documento OpenAPI se GENERA desde los Zod de @ladino/schemas (ADR-0004,
 * ADR-0015): los esquemas son la fuente única, y `openapi.json` en la raíz es
 * su proyección commiteada. `pnpm openapi:check` falla si divergen — es un
 * diff contra el fichero commiteado, no una validación semántica.
 *
 * Los importes monetarios, cuando lleguen, se documentan como objeto
 * `{amount, currency}` con `amount` string `format: decimal` — nunca number
 * (regla 7, API_SPEC.md §Dinero). Aquí todavía no hay ninguno.
 */
export function buildOpenApiDocument(): object {
  const registry = new OpenAPIRegistry();

  const createCompany = registry.register("CreateCompanyRequest", CreateCompanyRequest);
  const company = registry.register("CompanyResponse", CompanyResponse);
  const error = registry.register("ErrorResponse", ErrorResponse);

  const errorRef = (description: string) => ({
    description,
    content: { "application/json": { schema: error } },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/companies",
    summary: "Listar las empresas visibles para el usuario",
    description:
      "Devuelve las companies que `platform.ladino_user_company_ids()` resuelve para el " +
      "actor — el MISMO predicado que valida `X-Company-Id`, así que esta lista y ese " +
      "header no pueden divergir. Array plano, sin paginación por ahora.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Las companies visibles (puede ser un array vacío).",
        content: { "application/json": { schema: z.array(company) } },
      },
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/companies",
    summary: "Crear una empresa",
    description:
      "Operación de nivel tenant. Exige `company.manage` en una asignación " +
      "tenant-wide, `Idempotency-Key`, y un usuario real (no el actor de sistema). " +
      "El RIF no se valida en formato: VALIDAR-SENIAT pendiente.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: z.object({
        "Idempotency-Key": z.string().max(255),
      }),
      body: { content: { "application/json": { schema: createCompany } } },
    },
    responses: {
      201: {
        description: "Empresa creada. Un replay con la misma clave devuelve esta misma respuesta.",
        content: { "application/json": { schema: company } },
      },
      400: errorRef("Falta Idempotency-Key en una operación crítica."),
      401: errorRef("Token ausente, inválido o expirado (TOKEN_EXPIRED se distingue)."),
      403: errorRef("Tenant visible pero sin company.manage (PERMISSION_REQUIRED)."),
      404: errorRef(
        "Tenant inexistente O no visible para el usuario — indistinguibles a propósito.",
      ),
      409: errorRef("RIF duplicado, tenant suspendido, clave reutilizada o en vuelo."),
      422: errorRef("Forma inválida (VALIDATION_FAILED) o clave fuera de cota."),
    },
  });

  // ── Módulo de productos (migraciones 16-17, ADR-0032) ─────────────────────
  // Todo lo company-scoped exige X-Company-Id, validado por el middleware de
  // scope contra ladino_user_company_ids(). Los importes son STRING decimal
  // {amount, currency} — regla 7: nunca number para dinero.
  const producto = registry.register("ProductResponse", ProductResponse);
  const listaProductos = registry.register("ListProductsResponse", ListProductsResponse);
  const crearProducto = registry.register("CreateProductRequest", CreateProductRequest);
  const actualizarProducto = registry.register("UpdateProductRequest", UpdateProductRequest);
  const setTaxCat = registry.register("SetProductTaxCategoryRequest", SetProductTaxCategoryRequest);
  const crearLista = registry.register("CreatePriceListRequest", CreatePriceListRequest);
  const listaPrecios = registry.register("PriceListResponse", PriceListResponse);
  const setPrecio = registry.register("SetPriceRequest", SetPriceRequest);
  const itemPrecio = registry.register("PriceItemResponse", PriceItemResponse);

  const companyHeader = z.object({ "X-Company-Id": z.string().uuid() });
  const idParam = z.object({ id: z.string().uuid() });
  const okJson = (schema: z.ZodTypeAny, description: string) => ({
    description,
    content: { "application/json": { schema } },
  });
  const erroresComunes = {
    401: errorRef("Sin token válido."),
    403: errorRef("Company visible pero sin el permiso requerido."),
    404: errorRef("Company o recurso no visible — indistinguible de inexistente."),
    422: errorRef("Forma inválida, o company_id del cuerpo ≠ X-Company-Id."),
  };

  registry.registerPath({
    method: "get",
    path: "/v1/products",
    summary: "Listar productos (búsqueda y paginación en servidor)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: {
      200: okJson(listaProductos, "Página de productos con el total."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products",
    summary: "Crear producto (permiso product.manage)",
    description: "La clave natural es el SKU, único por empresa (case-insensitive).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: crearProducto } } },
    },
    responses: {
      201: okJson(producto, "Producto creado, en estado draft."),
      ...erroresComunes,
      409: errorRef("SKU o código de barras duplicado en la empresa."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/products/{id}",
    summary: "Detalle de un producto",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(producto, "El producto."), ...erroresComunes },
  });
  registry.registerPath({
    method: "patch",
    path: "/v1/products/{id}",
    summary: "Actualizar producto (nunca kind ni la clasificación tributaria)",
    description:
      "`kind` es inmutable tras draft (LAD33) y la clasificación tributaria tiene su " +
      "endpoint con permiso propio.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: actualizarProducto } } },
    },
    responses: { 200: okJson(producto, "Producto actualizado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/products/{id}/tax-category",
    summary: "Reclasificar tributariamente (permiso product.tax_category.set, segregado)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: setTaxCat } } },
    },
    responses: {
      200: okJson(producto, "Producto reclasificado; el hecho auditado lleva from/to."),
      ...erroresComunes,
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/price-lists",
    summary: "Listas de precios de la empresa",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(listaPrecios), "Las listas."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/price-lists",
    summary: "Crear lista de precios (permiso price_list.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: crearLista } } },
    },
    responses: { 201: okJson(listaPrecios, "Lista creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/price-lists/{id}/prices",
    summary: "Historial de precios; con `at` y `product_id`, el vigente A ESA FECHA",
    description:
      "La fecha es parámetro, nunca el reloj del servidor (ADR-0032): un documento de " +
      "ayer se recalcula con el precio de ayer.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader,
      query: z.object({
        product_id: z.string().uuid().optional(),
        at: z.string().datetime({ offset: true }).optional(),
      }),
    },
    responses: {
      200: okJson(
        z.object({
          items: z.array(itemPrecio),
          vigente: z.object({ amount: z.string(), currency: z.string() }).nullable(),
        }),
        "Historial (y el vigente si se pidió).",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/price-lists/{id}/prices",
    summary: "Cargar un precio por vigencia (append; permiso price_list.manage)",
    description:
      "Un precio no se edita: corregir es una fila nueva. El período abierto anterior " +
      "se cierra en el mismo INSERT (autocierre). Solape con un período cerrado → 409 PRICE_OVERLAP.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: setPrecio } } },
    },
    responses: {
      201: okJson(itemPrecio, "Precio cargado, {amount, currency} como strings."),
      ...erroresComunes,
      409: errorRef(
        "Solape con un período cerrado (PRICE_OVERLAP) o misma fecha de inicio (DUPLICATE).",
      ),
    },
  });

  const catalogo = (path: string, summary: string, schema: z.ZodTypeAny, conCompany: boolean) =>
    registry.registerPath({
      method: "get",
      path,
      summary,
      security: [{ bearerAuth: [] }],
      ...(conCompany ? { request: { headers: companyHeader } } : {}),
      responses: { 200: okJson(schema, "El catálogo."), 401: errorRef("Sin token válido.") },
    });
  catalogo(
    "/v1/units",
    "Unidades de medida (global)",
    z.array(z.object({ code: z.string(), name: z.string(), symbol: z.string() })),
    false,
  );
  catalogo(
    "/v1/tax-categories",
    "Clasificaciones tributarias activas (global, VALIDAR-TRIBUTARIO)",
    z.array(
      z.object({ code: z.string(), name: z.string(), description: z.string(), status: z.string() }),
    ),
    false,
  );
  catalogo(
    "/v1/product-categories",
    "Categorías comerciales de la empresa",
    z.array(z.object({ id: z.string().uuid(), name: z.string(), status: z.string() })),
    true,
  );

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Ladino API",
      version: "0.1.0",
      description:
        "API administrativa, contable y fiscal. Errores: docs/04_PLATFORM/ERROR_CATALOG.md.",
    },
    servers: [{ url: "/" }],
  });
}
