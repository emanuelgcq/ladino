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
  CreateCustomerRequest,
  UpdateCustomerRequest,
  SetCustomerTaxIdRequest,
  SetCustomerBlockedRequest,
  CustomerResponse,
  ListCustomersResponse,
  ReceiveStockRequest,
  IssueStockRequest,
  AdjustStockRequest,
  TransferStockRequest,
  InventoryMoveResponse,
  ListInventoryMovesResponse,
  ListStockResponse,
  CreateWarehouseRequest,
  WarehouseResponse,
  TransferResponse,
  SetRecipeRequest,
  RecipeResponse,
  ConsumeRecipeRequest,
  ConsumeRecipeResponse,
  CreateProductTemplateRequest,
  ProductTemplateResponse,
  TemplateStockResponse,
  SetStockThresholdRequest,
  LowStockResponse,
  ExpiringLotsResponse,
  CreateQuoteRequest,
  CreateOrderRequest,
  ConfirmOrderRequest,
  CreateInvoiceRequest,
  AnnulInvoiceRequest,
  RegisterPaymentRequest,
  CreateReturnRequest,
  DocumentResponse,
  DocumentDetailResponse,
  ListDocumentsResponse,
  RegisterPaymentResponse,
  ReturnResponse,
  AgingResponse,
  CustomerStatementResponse,
  CreateFiscalRangeRequest,
  FiscalRangeResponse,
  CreateExchangeRateRequest,
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

  // ── Clientes (migración 18, ADR-0033) ─────────────────────────────────────
  const cliente = registry.register("CustomerResponse", CustomerResponse);
  const listaClientes = registry.register("ListCustomersResponse", ListCustomersResponse);
  const crearCliente = registry.register("CreateCustomerRequest", CreateCustomerRequest);
  const actualizarCliente = registry.register("UpdateCustomerRequest", UpdateCustomerRequest);
  const setRif = registry.register("SetCustomerTaxIdRequest", SetCustomerTaxIdRequest);
  const setBloqueo = registry.register("SetCustomerBlockedRequest", SetCustomerBlockedRequest);
  const idemHeader = companyHeader.extend({ "Idempotency-Key": z.string().max(255) });

  registry.registerPath({
    method: "get",
    path: "/v1/customers",
    summary: "Listar clientes (búsqueda por RIF o razón social, paginación en servidor)",
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
      200: okJson(listaClientes, "Página de clientes con el total."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/customers",
    summary: "Crear cliente (permiso customer.manage)",
    description:
      "RIF sin validación de formato (VALIDAR-SENIAT); nullable solo para persona natural; " +
      "único por empresa (case-insensitive). El alta con RIF deja customer.tax_id_established.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearCliente } } },
    },
    responses: {
      201: okJson(cliente, "Cliente creado."),
      ...erroresComunes,
      409: errorRef("RIF duplicado en la empresa."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/customers/{id}",
    summary: "Detalle de un cliente",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(cliente, "El cliente."), ...erroresComunes },
  });
  registry.registerPath({
    method: "patch",
    path: "/v1/customers/{id}",
    summary: "Actualizar cliente (nunca el RIF ni el bloqueo: endpoints y permisos propios)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: actualizarCliente } } },
    },
    responses: { 200: okJson(cliente, "Cliente actualizado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/customers/{id}/tax-id",
    summary: "Cambiar el RIF (permiso customer.tax_id.manage, segregado — M4)",
    description:
      "El esquema registra el hecho con el VALOR ANTERIOR (customer.tax_id_changed). " +
      "Null solo para persona natural.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: setRif } } },
    },
    responses: {
      200: okJson(cliente, "RIF cambiado, hecho auditado."),
      ...erroresComunes,
      409: errorRef("RIF duplicado."),
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/customers/{id}/blocked",
    summary: "Bloquear o desbloquear (permiso customer.block — cobranzas, no ventas)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: setBloqueo } } },
    },
    responses: { 200: okJson(cliente, "Estado cambiado."), ...erroresComunes },
  });
  catalogo(
    "/v1/taxpayer-types",
    "Clasificaciones del sujeto pasivo (global, VALIDAR-TRIBUTARIO)",
    z.array(z.object({ code: z.string(), name: z.string(), description: z.string() })),
    false,
  );
  catalogo(
    "/v1/person-types",
    "Tipos de persona (global)",
    z.array(z.object({ code: z.string(), name: z.string(), description: z.string() })),
    false,
  );

  // ── Inventario (migración 19, ADR-0034) ───────────────────────────────────
  // Cantidades e importes, STRING decimal. Los permisos de movimiento son
  // ACOTADOS: hacen falta sobre EL almacén, no sobre la empresa.
  const movimiento = registry.register("InventoryMoveResponse", InventoryMoveResponse);
  const listaMovimientos = registry.register(
    "ListInventoryMovesResponse",
    ListInventoryMovesResponse,
  );
  const listaStock = registry.register("ListStockResponse", ListStockResponse);
  const recibir = registry.register("ReceiveStockRequest", ReceiveStockRequest);
  const despachar = registry.register("IssueStockRequest", IssueStockRequest);
  const ajustar = registry.register("AdjustStockRequest", AdjustStockRequest);
  const transferir = registry.register("TransferStockRequest", TransferStockRequest);
  const transferencia = registry.register("TransferResponse", TransferResponse);
  const crearAlmacen = registry.register("CreateWarehouseRequest", CreateWarehouseRequest);
  const almacen = registry.register("WarehouseResponse", WarehouseResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/inventory/stock",
    summary: "Existencias por almacén y producto (kardex materializado)",
    description:
      "Lee `stock_balances`, que el trigger del movimiento mantiene en la misma transacción. " +
      "Coincide siempre con el recálculo desde el kardex (ADR-0034; pgTAP 019 lo exige).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        warehouse_id: z.string().uuid().optional(),
        product_id: z.string().uuid().optional(),
        search: z.string().optional(),
        with_stock: z.enum(["true", "false"]).optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: { 200: okJson(listaStock, "Existencias con su valor."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/inventory/moves",
    summary: "Kardex paginado, con filtro por producto, almacén y fecha",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        product_id: z.string().uuid().optional(),
        warehouse_id: z.string().uuid().optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: okJson(listaMovimientos, "Movimientos con saldo y costo tras cada uno."),
      ...erroresComunes,
    },
  });
  const mueveStock = (
    path: string,
    summary: string,
    description: string,
    schema: z.ZodTypeAny,
    respuesta: z.ZodTypeAny,
  ) =>
    registry.registerPath({
      method: "post",
      path,
      summary,
      description,
      security: [{ bearerAuth: [] }],
      request: { headers: idemHeader, body: { content: { "application/json": { schema } } } },
      responses: {
        201: okJson(respuesta, "Movimiento registrado. El kardex es append-only: no se edita."),
        ...erroresComunes,
        409: errorRef(
          "Existencia negativa sin política o sin inventory.negative (NEGATIVE_STOCK), o " +
            "referencia duplicada (DUPLICATE).",
        ),
      },
    });
  mueveStock(
    "/v1/inventory/receipts",
    "Entrada de existencias (permiso inventory.move sobre el almacén)",
    "El importe es el costo TOTAL de la recepción. En moneda distinta a la funcional exige " +
      "la tasa con su fuente: sin fuente no se persiste (ADR-0020). El promedio se recalcula.",
    recibir,
    movimiento,
  );
  mueveStock(
    "/v1/inventory/issues",
    "Salida de existencias al costo promedio (permiso inventory.move sobre el almacén)",
    "El costo lo calcula el promedio ponderado móvil; el cliente no lo envía.",
    despachar,
    movimiento,
  );
  mueveStock(
    "/v1/inventory/adjustments",
    "Ajuste de existencias (permiso inventory.adjust, SEGREGADO de inventory.move)",
    "El motivo es obligatorio: un ajuste sin motivo no es un ajuste, es un descuadre.",
    ajustar,
    movimiento,
  );
  mueveStock(
    "/v1/inventory/transfers",
    "Transferencia entre almacenes (permiso inventory.transfer en LOS DOS)",
    "Salida y entrada en la misma transacción, con referencia mutua y cuadre exigido al " +
      "commit: no existe instante con el stock en ningún lado ni en los dos. No hay estado " +
      "«en tránsito» (ADR-0034).",
    transferir,
    transferencia,
  );
  registry.registerPath({
    method: "get",
    path: "/v1/warehouses",
    summary: "Almacenes de la empresa",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(almacen), "Los almacenes."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/warehouses",
    summary: "Crear almacén (permiso warehouse.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearAlmacen } } },
    },
    responses: {
      201: okJson(almacen, "Almacén creado."),
      ...erroresComunes,
      409: errorRef("Ya existe un almacén con ese código en la empresa."),
    },
  });

  // ── Inventario, segunda vuelta (migración 20, ADR-0035/0036) ──────────────
  const receta = registry.register("RecipeResponse", RecipeResponse);
  const setReceta = registry.register("SetRecipeRequest", SetRecipeRequest);
  const consumir = registry.register("ConsumeRecipeRequest", ConsumeRecipeRequest);
  const consumo = registry.register("ConsumeRecipeResponse", ConsumeRecipeResponse);
  const plantilla = registry.register("ProductTemplateResponse", ProductTemplateResponse);
  const crearPlantilla = registry.register(
    "CreateProductTemplateRequest",
    CreateProductTemplateRequest,
  );
  const stockPlantilla = registry.register("TemplateStockResponse", TemplateStockResponse);
  const umbral = registry.register("SetStockThresholdRequest", SetStockThresholdRequest);
  const bajoStock = registry.register("LowStockResponse", LowStockResponse);
  const porVencer = registry.register("ExpiringLotsResponse", ExpiringLotsResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/products/{id}/recipe",
    summary: "Receta de un producto compuesto, con su costo estimado",
    description:
      "`estimated_unit_cost` es una ESTIMACIÓN con los costos vigentes para enseñar en pantalla; " +
      "el costo real de una venta es la suma de las salidas que persistió el kardex. Es `null` " +
      "si alguna línea no tiene conversión de unidad: un costo a medias sería peor que ninguno.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader,
      query: z.object({ warehouse_id: z.string().uuid().optional() }),
    },
    responses: { 200: okJson(receta, "La receta."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/products/{id}/recipe",
    summary: "Reemplazar la receta entera (permiso product.recipe.manage)",
    description:
      "Se reemplaza COMPLETA: una receta a medias no es una receta, y parchear línea a línea " +
      "deja estados intermedios que sí se pueden vender. Un ingrediente no puede ser a su vez " +
      "compuesto: el anidamiento no está soportado (ADR-0035).",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: setReceta } } },
    },
    responses: {
      200: okJson(receta, "La receta guardada."),
      ...erroresComunes,
      409: errorRef("El producto no es compuesto, o un ingrediente sí lo es (RECIPE_INVALID)."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/inventory/recipe-consumptions",
    summary: "Consumir un compuesto: una salida por ingrediente (permiso inventory.move)",
    description:
      "Vender doce arepas no descuenta arepas: descuenta harina y leche. Las N salidas van en " +
      "la MISMA transacción y comparten `source_document_id`. Si un ingrediente no alcanza, no " +
      "ocurre ninguna: media receta consumida es peor que ninguna.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: consumir } } },
    },
    responses: {
      201: okJson(consumo, "Las salidas y el costo total REAL de lo consumido."),
      ...erroresComunes,
      409: errorRef("Existencia insuficiente (NEGATIVE_STOCK) o receta inválida."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/product-templates",
    summary: "Plantillas de variantes de la empresa",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(plantilla), "Las plantillas."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/product-templates",
    summary: "Crear plantilla de variantes (permiso product.variant.manage)",
    description:
      "`attribute_keys` son los ejes de variación (talla, color). Cada variante es un PRODUCTO " +
      "con su SKU, precio y costo; la plantilla solo agrupa (ADR-0036).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearPlantilla } } },
    },
    responses: { 201: okJson(plantilla, "Plantilla creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/inventory/stock-by-template",
    summary: "Existencias desglosadas por variante, con el total de la plantilla",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ warehouse_id: z.string().uuid().optional() }),
    },
    responses: {
      200: okJson(stockPlantilla, "Una fila por variante; `template_quantity` es el total."),
      ...erroresComunes,
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/inventory/thresholds",
    summary: "Definir mínimo y máximo de reposición (permiso inventory.threshold.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: umbral } } },
    },
    responses: { 200: okJson(umbral, "Umbral guardado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/inventory/low-stock",
    summary: "Productos por debajo del mínimo, con cuánto falta",
    description:
      "Un producto CON umbral y SIN existencias sale con cantidad 0: es justo el que hay que " +
      "reponer. La notificación (correo, in-app) se difiere al worker; esto es la consulta.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ warehouse_id: z.string().uuid().optional() }),
    },
    responses: { 200: okJson(bajoStock, "Lo que falta reponer."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/inventory/expiring-lots",
    summary: "Lotes con existencia que vencen dentro de N días",
    description:
      "Incluye los ya vencidos, con `days_left` negativo: son los que más urgen. Un lote " +
      "agotado que vence mañana no aparece — no es un problema.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ days: z.coerce.number().int().min(0).max(3650).optional() }),
    },
    responses: { 200: okJson(porVencer, "Lotes por vencer."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/inventory/suggest-lot",
    summary: "FEFO: el lote no vencido que caduca primero (SUGERENCIA)",
    description:
      "Es sugerencia para la UI, no obligación: cuál lote sale puede depender de la ubicación " +
      "física, y forzarlo en el servidor sería imponer una política de cliente. Lo que el " +
      "servidor SÍ impone es que un lote vencido no salga sin `inventory.expired` (ADR-0035).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ warehouse_id: z.string().uuid(), product_id: z.string().uuid() }),
    },
    responses: {
      200: okJson(
        z.object({ lot_id: z.string().uuid().nullable() }),
        "El lote sugerido, o null si no hay ninguno con existencia.",
      ),
      ...erroresComunes,
    },
  });

  // ── Ventas (migración 21, ADR-0037/0038) ──────────────────────────────────
  const documento = registry.register("DocumentResponse", DocumentResponse);
  const detalleDoc = registry.register("DocumentDetailResponse", DocumentDetailResponse);
  const listaDocs = registry.register("ListDocumentsResponse", ListDocumentsResponse);
  const crearCotizacion = registry.register("CreateQuoteRequest", CreateQuoteRequest);
  const crearPedido = registry.register("CreateOrderRequest", CreateOrderRequest);
  const confirmarPedido = registry.register("ConfirmOrderRequest", ConfirmOrderRequest);
  const crearFactura = registry.register("CreateInvoiceRequest", CreateInvoiceRequest);
  const anularFactura = registry.register("AnnulInvoiceRequest", AnnulInvoiceRequest);
  const registrarCobro = registry.register("RegisterPaymentRequest", RegisterPaymentRequest);
  const respuestaCobro = registry.register("RegisterPaymentResponse", RegisterPaymentResponse);
  const crearDevolucion = registry.register("CreateReturnRequest", CreateReturnRequest);
  const devolucion = registry.register("ReturnResponse", ReturnResponse);
  const antiguedad = registry.register("AgingResponse", AgingResponse);
  const estadoCuenta = registry.register("CustomerStatementResponse", CustomerStatementResponse);
  const crearRango = registry.register("CreateFiscalRangeRequest", CreateFiscalRangeRequest);
  const rango = registry.register("FiscalRangeResponse", FiscalRangeResponse);
  const crearTasa = registry.register("CreateExchangeRateRequest", CreateExchangeRateRequest);

  registry.registerPath({
    method: "get",
    path: "/v1/documents",
    summary: "Listar documentos de venta (filtros por tipo, estado, cliente y fechas)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        kind: z.string().optional(),
        status: z.string().optional(),
        customer_id: z.string().uuid().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: okJson(listaDocs, "Página de documentos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/documents/{id}",
    summary: "Detalle de un documento: líneas, cobros, diferencial y saldo",
    description:
      "El saldo lo calcula platform.document_balance en el esquema: nunca se lee de una columna.",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(detalleDoc, "El documento completo."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/quotes",
    summary: "Crear cotización (permiso sales.quote.manage)",
    description:
      "Una cotización no compromete stock ni consume correlativo fiscal, pero SÍ resuelve la " +
      "alícuota vigente: sin regla en tax_rules no hay cotización (ADR-0038, LAD50).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearCotizacion } } },
    },
    responses: { 201: okJson(documento, "Cotización creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/orders",
    summary: "Crear pedido (permiso sales.order.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearPedido } } },
    },
    responses: { 201: okJson(documento, "Pedido creado en borrador."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/orders/{id}/confirm",
    summary: "Confirmar pedido y reservar existencias",
    description:
      "La reserva NO es un movimiento de kardex: es un compromiso con caducidad " +
      "(inventory_settings.reservation_ttl_days). El disponible descuenta lo ya reservado.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: confirmarPedido } } },
    },
    responses: {
      200: okJson(documento, "Pedido confirmado con las reservas hechas."),
      ...erroresComunes,
      409: errorRef("No hay disponible suficiente para reservar (LAD39)."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/invoices",
    summary: "Emitir factura (permiso sales.invoice.issue)",
    description:
      "Asigna correlativo del emisor y, si el régimen lo exige, número de control de la " +
      "imprenta (ADR-0037). Genera el kardex al costo del momento en la misma transacción: " +
      "si el stock no alcanza, la factura entera no ocurrió.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearFactura } } },
    },
    responses: {
      201: okJson(documento, "Factura emitida con sus dos números."),
      ...erroresComunes,
      409: errorRef(
        "Numeración inválida o rango agotado (LAD49); sin regla tributaria (LAD50); sin existencia (LAD39).",
      ),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/invoices/{id}/annul",
    summary: "Anular una factura emitida (permiso sales.invoice.annul)",
    description:
      "Anular no es borrar: el documento y su correlativo SE CONSERVAN (regla 1, ADR-0037). " +
      "El número anulado sigue ocupado y no se reutiliza.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: anularFactura } } },
    },
    responses: { 200: okJson(documento, "Factura anulada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/payments",
    summary: "Registrar cobro (permiso sales.payment.register)",
    description:
      "Si el documento se emitió en otra moneda y la tasa cambió, registra además el " +
      "DIFERENCIAL CAMBIARIO. Si no hubo diferencia no se escribe una fila de cero.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: registrarCobro } } },
    },
    responses: {
      201: okJson(respuestaCobro, "Cobro aplicado, con saldo y diferencial."),
      ...erroresComunes,
      409: errorRef("Sin tasa vigente para la fecha del cobro, o saldo a favor insuficiente."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/returns",
    summary: "Registrar devolución contra su factura (permiso sales.return.manage)",
    description: "No hay devolución sin documento origen, y nunca por más de lo vendido.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearDevolucion } } },
    },
    responses: { 201: okJson(devolucion, "Devolución en borrador."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/returns/{id}/confirm",
    summary: "Confirmar devolución: reingreso al COSTO ORIGINAL, nota de crédito y saldo a favor",
    description:
      "Los tres en una transacción. El reingreso usa el cost_snapshot de la línea de origen, " +
      "no el costo de hoy: devolver no puede revalorizar el inventario.",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: idemHeader },
    responses: { 200: okJson(devolucion, "Devolución confirmada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/customers/{id}/aging",
    summary: "Antigüedad de saldos de un cliente (permiso ar.read)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader,
      query: z.object({ reference_date: z.string().optional() }),
    },
    responses: { 200: okJson(antiguedad, "Tramos 0-30, 31-60, 61-90 y 90+."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/customers/{id}/statement",
    summary: "Estado de cuenta con antigüedad y saldos a favor (permiso ar.read)",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(estadoCuenta, "El estado de cuenta."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-number-ranges",
    summary: "Rangos de número de control autorizados",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(rango), "Los rangos de la empresa."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-number-ranges",
    summary: "Cargar un rango autorizado (permiso fiscal.range.manage)",
    description: "El rango viene de la imprenta digital con su autorización; aquí no se inventa.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearRango } } },
    },
    responses: { 201: okJson(rango, "Rango cargado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-number-ranges/exhaustion",
    summary: "Rangos por agotarse — la alerta llega antes de que la caja se pare",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            range_id: z.string().uuid(),
            kind: z.string(),
            series: z.string(),
            remaining: z.number().int(),
            total: z.number().int(),
            pct_remaining: z.string(),
          }),
        ),
        "Rangos bajo su umbral de alerta.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/exchange-rates",
    summary: "Últimas tasas cargadas para un par de monedas",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: {
      200: okJson(
        z.array(
          z.object({
            id: z.string().uuid(),
            from_currency: z.string(),
            to_currency: z.string(),
            rate: z.string(),
            source: z.string(),
            rate_date: z.string(),
          }),
        ),
        "Hasta 60 tasas, de la más reciente hacia atrás.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/exchange-rates",
    summary: "Cargar tasa manualmente (permiso fx.rate.manage)",
    description:
      "Camino manual del adaptador BCV (ADR-0028): hoy el adaptador es NullBCVAdapter y no " +
      "trae nada. Sin fuente citada no se persiste, y la fuente viaja en cada documento.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearTasa } } },
    },
    responses: { 201: okJson(crearTasa, "Tasa cargada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/reports/exchange-difference",
    summary: "Diferencial cambiario acumulado del período (KPI del panel)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: {
      200: okJson(
        z.object({
          ganancia: z.string(),
          perdida: z.string(),
          neto: z.string(),
          currency: z.string(),
          by_month: z.array(z.object({ month: z.string(), amount: z.string() })),
        }),
        "Ganancia, pérdida, neto y desglose mensual.",
      ),
      ...erroresComunes,
    },
  });

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
