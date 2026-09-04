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
  SetCompanyFiscalAddressRequest,
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
  PosQuoteRequest,
  PosQuoteResponse,
  QuickSaleRequest,
  QuickSaleResponse,
  PosChangeResponse,
  ReturnResponse,
  AgingResponse,
  CustomerStatementResponse,
  CreateFiscalRangeRequest,
  FiscalRangeResponse,
  CreateExchangeRateRequest,
  CreateSupplierRequest,
  SupplierResponse,
  ListSuppliersResponse,
  CreatePurchaseOrderRequest,
  PurchaseOrderResponse,
  ListPurchaseOrdersResponse,
  ReceiveGoodsRequest,
  GoodsReceiptResponse,
  RegisterSupplierInvoiceRequest,
  SupplierInvoiceResponse,
  MatchingResponse,
  ApplyLandedCostRequest,
  LandedCostResponse,
  RegisterSupplierCreditNoteRequest,
  RegisterSupplierPaymentRequest,
  SupplierPaymentResponse,
  SimplePurchaseRequest,
  SimplePurchaseResponse,
  RetentionReceiptResponse,
  CreateRetentionRuleRequest,
  ApAgingResponse,
  SupplierStatementResponse,
  CreateAccountRequest,
  UpdateAccountRequest,
  AccountResponse,
  ImportChartTemplateRequest,
  CreateJournalEntryRequest,
  PostJournalEntryRequest,
  ReverseJournalEntryRequest,
  JournalEntryResponse,
  JournalEntryDetailResponse,
  ListJournalEntriesResponse,
  LedgerResponse,
  TrialBalanceResponse,
  FiscalPeriodResponse,
  ClosePeriodRequest,
  ReopenPeriodRequest,
  YearEndCloseRequest,
  SetAccountPurposeRequest,
  PendingJournalResponse,
  IncomeStatementResponse,
  BalanceSheetResponse,
  FiscalBookResponse,
  BookReconciliationResponse,
  BookFormatAdapterResponse,
  ExportFiscalBookRequest,
  ExportFiscalBookResponse,
  ListFiscalBookRunsResponse,
  CreateProductSimpleRequest,
  ProductSimpleResponse,
  ImportProductsResponse,
  NegocioResumenResponse,
  ConvertResponse,
  CompanySettingsResponse,
  UpdateCompanySettingsRequest,
  FiscalSetupResponse,
  AssignFiscalRegimeRequest,
  AcceptIvaGeneralRequest,
  AcceptIvaGeneralResponse,
  RegisterContingencyRangeRequest,
  ContingencyRangeResponse,
  RegisterContingencyInvoiceRequest,
  CloseContingencyRequest,
  CreateCompanyAccountRequest,
  UpdateCompanyAccountRequest,
  CompanyAccountResponse,
  ListCompanyAccountsResponse,
  CreatePaymentMethodRequest,
  UpdatePaymentMethodRequest,
  PaymentMethodResponse,
  ListPaymentMethodsResponse,
  RegisterExpenseRequest,
  ExpenseResponse,
  ListExpensesResponse,
  CloseCashRegisterRequest,
  CashClosingResponse,
  ListCashClosingsResponse,
  KeepDailyRateRequest,
  DailyRateResponse,
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

  const setDomicilio = registry.register(
    "SetCompanyFiscalAddressRequest",
    SetCompanyFiscalAddressRequest,
  );
  // ── Módulo de productos (migraciones 16-17, ADR-0032) ─────────────────────
  // Todo lo company-scoped exige X-Company-Id, validado por el middleware de
  // scope contra ladino_user_company_ids(). Los importes son STRING decimal
  // {amount, currency} — regla 7: nunca number para dinero.
  const producto = registry.register("ProductResponse", ProductResponse);
  const listaProductos = registry.register("ListProductsResponse", ListProductsResponse);
  const crearProducto = registry.register("CreateProductRequest", CreateProductRequest);
  const crearProductoSimple = registry.register(
    "CreateProductSimpleRequest",
    CreateProductSimpleRequest,
  );
  const productoSimple = registry.register("ProductSimpleResponse", ProductSimpleResponse);
  const importProductos = registry.register("ImportProductsResponse", ImportProductsResponse);
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
    description:
      "La búsqueda cubre SKU, nombre y código de barras (la cuadrícula de Vender tiene lector). " +
      "`with_price=1` añade el precio vigente de la lista pedida — o de la lista «detal» de la " +
      "empresa si no se indica —, `with_stock=1` el total en existencia, `only_active=1` filtra " +
      "el catálogo vendible.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
        only_active: z.enum(["1"]).optional(),
        with_price: z.enum(["1"]).optional(),
        with_stock: z.enum(["1"]).optional(),
        price_list_id: z.string().uuid().optional(),
      }),
    },
    responses: {
      200: okJson(listaProductos, "Página de productos con el total."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products/simple",
    summary: "El alta simple de la Fase C: nombre + precio (+ stock inicial) en un paso",
    description:
      "El SKU se genera si no viene, la clasificación fiscal sale de company_settings, el precio " +
      "va a la lista «detal» de su moneda (creada si hace falta) y el stock inicial es una " +
      "ENTRADA de kardex con costo y referencia `inventario-inicial`. Todo o nada, en una " +
      "transacción.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: crearProductoSimple } } },
    },
    responses: {
      201: okJson(productoSimple, "El producto activo, con su precio y su stock inicial."),
      ...erroresComunes,
      409: errorRef("SKU o código de barras duplicado en la empresa."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products/import",
    summary: "Importar productos desde Excel, con errores POR FILA en voz de persona",
    description:
      "Multipart con `file` (.xlsx, hasta 500 filas). Bastan las columnas «Nombre» y «Precio»; " +
      "«Moneda», «Código», «Código de barras», «Categoría», «Existencia», «Costo», «Moneda " +
      "costo» y «Es servicio» son opcionales. Cada fila es SU transacción: las buenas entran, " +
      "las malas se explican con su número de fila. Los importes se leen del TEXTO de la celda " +
      "(coma decimal venezolana incluida), nunca del float de Excel.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({ file: z.string().openapi({ format: "binary" }) }),
          },
        },
      },
    },
    responses: {
      201: okJson(importProductos, "El resultado fila por fila."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products/{id}/image",
    summary: "Subir la foto del producto (permiso product.manage)",
    description:
      "Multipart con el campo `file` (JPG/PNG/WebP, hasta 6 MB). El servidor la convierte a " +
      "webp, genera las miniaturas de 400 y 96 px al subir, y guarda la RUTA — nunca una URL " +
      "firmada, que caduca. La cuadrícula recibe `image_url` firmada de la miniatura; sin " +
      "almacenamiento configurado el endpoint lo dice en vez de fingir.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: companyHeader,
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({ file: z.string().openapi({ format: "binary" }) }),
          },
        },
      },
    },
    responses: {
      201: okJson(
        z.object({ image_path: z.string(), image_url: z.string().nullable() }),
        "La ruta persistida y una URL firmada para enseñarla ya.",
      ),
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
      "ayer se recalcula con el precio de ayer. Cada fila trae además su EQUIVALENTE en la " +
      "otra moneda, calculado por el SERVIDOR con la tasa BCV de HOY (`rate` dice cuál, con " +
      "fuente y fecha) — es referencia, no dato del precio: la tasa se ancla al documento, " +
      "no al precio, así que las filas históricas también convierten a la de hoy. Sin tasa " +
      "vigente, `rate` y los equivalentes vienen null.",
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
          rate: z
            .object({ rate: z.string(), rate_date: z.string(), source: z.string() })
            .nullable(),
        }),
        "Historial (y el vigente si se pidió), con la tasa de referencia.",
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
    description:
      "`with_debt=1` añade a cada cliente lo que debe (suma de saldos positivos de sus " +
      "facturas emitidas, calculada por el esquema) — la cifra de la pantalla de Clientes.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
        with_debt: z.enum(["1"]).optional(),
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
      "único por empresa sobre la forma NORMALIZADA (sin separadores, case-insensitive — " +
      "migración 33). Persona jurídica o ente público exigen domicilio fiscal: una factura " +
      "a una empresa lo lleva. El alta con RIF deja customer.tax_id_established.",
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
    path: "/v1/customers/lookup",
    summary: "Buscar UN cliente por su documento exacto (el primer paso del mostrador)",
    description:
      "El documento viaja como prefijo (V, E, J, G o P) más el número, con o sin separadores: " +
      "se normaliza (mayúsculas, sin guiones ni puntos) y se compara EXACTO contra la clave " +
      "natural — la búsqueda va por el índice único. Sin regex de formato ni dígito " +
      "verificador (VALIDAR-SENIAT). 404 idéntico para «no existe» y «no es visible».",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ document: z.string() }),
    },
    responses: {
      200: okJson(cliente, "El cliente, exacto."),
      ...erroresComunes,
      404: errorRef("Ningún cliente con ese documento en esta empresa."),
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

  const resumenNegocio = registry.register("NegocioResumenResponse", NegocioResumenResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/negocio/resumen",
    summary: "Los números de Inicio y Mi dinero, calculados TODOS en el servidor",
    description:
      "Vendido y ganado (hoy/mes, con el corte del día de VENEZUELA y el margen desde el costo " +
      "CONGELADO de cada línea), lo que me deben y lo que debo (saldos del esquema), el dinero " +
      "por moneda, los productos por agotarse, la tasa del día con su fuente y las últimas " +
      "ventas. La pantalla no suma ni un céntimo (permiso treasury.read).",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(resumenNegocio, "El resumen."), ...erroresComunes },
  });
  const convertir = registry.register("ConvertResponse", ConvertResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/negocio/convertir",
    summary: "Convertir un importe con la tasa vigente, en el SERVIDOR",
    description:
      "`converted = amount × tasa`, calculado en SQL numeric. La pantalla que enseña «≈ Bs.» " +
      "junto a un precio en dólares pregunta aquí: multiplicar en el navegador sería aritmética " +
      "de dinero en el cliente.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        amount: z.string(),
        from: z.string().optional(),
        to: z.string().optional(),
      }),
    },
    responses: {
      200: okJson(convertir, "El importe convertido, con la tasa y su fuente."),
      ...erroresComunes,
      409: errorRef("Sin tasa vigente para ese par."),
    },
  });
  const ajustesNegocio = registry.register("CompanySettingsResponse", CompanySettingsResponse);
  const editarAjustes = registry.register(
    "UpdateCompanySettingsRequest",
    UpdateCompanySettingsRequest,
  );
  registry.registerPath({
    method: "get",
    path: "/v1/company-settings",
    summary: "Los ajustes del negocio (cualquier miembro)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(ajustesNegocio, "Los ajustes (defaults si nunca se guardaron)."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/company-settings",
    summary: "Cambiar los ajustes del negocio (permiso company.settings.manage)",
    description:
      "Upsert parcial: solo lo enviado cambia. Son interruptores de EXPERIENCIA, no de verdad " +
      "fiscal — la defensa real contra vender sin existencia sigue siendo la del kardex.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: editarAjustes } } },
    },
    responses: { 200: okJson(ajustesNegocio, "Los ajustes resultantes."), ...erroresComunes },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/companies/fiscal-address",
    summary: "Cargar el domicilio fiscal del emisor (permiso company.settings.manage)",
    description:
      "PA 00071 art. 13.5: la factura lleva el domicilio fiscal del emisor. Se guarda en el " +
      "maestro y queda auditado con el valor anterior; los documentos YA emitidos no cambian — " +
      "cada uno congeló el domicilio vigente el día que nació (R-05, migración 34).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: setDomicilio } } },
    },
    responses: {
      200: okJson(z.object({ fiscal_address: z.string() }), "El domicilio guardado."),
      ...erroresComunes,
    },
  });

  const setupFiscal = registry.register("FiscalSetupResponse", FiscalSetupResponse);
  const asignarRegimen = registry.register("AssignFiscalRegimeRequest", AssignFiscalRegimeRequest);
  const aceptarIva = registry.register("AcceptIvaGeneralRequest", AcceptIvaGeneralRequest);
  const aceptacionIva = registry.register("AcceptIvaGeneralResponse", AcceptIvaGeneralResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal/setup",
    summary: "La puesta a punto fiscal: regímenes con su norma, el vigente y el IVA general",
    description:
      "Lo que el asistente de /empezar necesita leer: el catálogo de regímenes (cada uno con la " +
      "norma citada en la migración), el régimen vigente de la empresa y la regla general del " +
      "IVA si esta instancia ya la aceptó.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(setupFiscal, "El estado de la puesta a punto."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal/regime",
    summary: "Asignar el régimen fiscal (permiso fiscal.regime.manage)",
    description:
      "Solo si la empresa no tiene régimen vigente: el asistente asigna una vez; cambiar " +
      "después es un acto del mundo técnico (append-only, ADR-0029).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: asignarRegimen } } },
    },
    responses: {
      201: okJson(z.object({ regime_code: z.string() }), "El régimen asignado."),
      ...erroresComunes,
      409: errorRef("La empresa ya tiene un régimen vigente."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal/iva-general",
    summary: "ACEPTAR la alícuota general del IVA (permiso tax.rules.manage)",
    description:
      "Ladino no afirma la alícuota: la declara y la acepta LA PERSONA. Crea —si no existen— " +
      "las reglas generales (gravado a la alícuota aceptada, exento a cero; venta y compra) " +
      "con el acta de aceptación como `legal_source`, y siempre deja el acta en la auditoría. " +
      "VALIDAR-TRIBUTARIO: confirmar contra la Ley de IVA vigente antes de producción.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: aceptarIva } } },
    },
    responses: {
      201: okJson(aceptacionIva, "La aceptación registrada."),
      ...erroresComunes,
    },
  });

  // ── Contingencia (PA 102, migración 35) ───────────────────────────────────
  const rangoContingencia = registry.register(
    "RegisterContingencyRangeRequest",
    RegisterContingencyRangeRequest,
  );
  const rangoContingenciaResp = registry.register(
    "ContingencyRangeResponse",
    ContingencyRangeResponse,
  );
  const facturaContingencia = registry.register(
    "RegisterContingencyInvoiceRequest",
    RegisterContingencyInvoiceRequest,
  );
  const cerrarContingencia = registry.register("CloseContingencyRequest", CloseContingencyRequest);
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal/contingency-ranges",
    summary: "Los talonarios de contingencia registrados (permiso de lectura de la company)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.object({ items: z.array(rangoContingenciaResp) }),
        "Talonarios con su rango, motivo y período.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal/contingency-ranges",
    summary: "Registrar un talonario físico de contingencia (fiscal.contingency.manage)",
    description:
      "PA 102: la serie lleva la palabra «contingencia» (el esquema lo exige, LAD69). El " +
      "talonario ES un rango de numeración normal; esta tabla añade el motivo y el período " +
      "de la falla. De un registro solo se puede cerrar el período, una vez (LAD06).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: rangoContingencia } } },
    },
    responses: {
      201: okJson(rangoContingenciaResp, "El talonario registrado."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal/contingency-invoices",
    summary: "Registrar a posteriori una factura emitida en papel durante la falla",
    description:
      "Pasa por la emisión COMPLETA (kardex, impuestos, numeración, contabilidad, libros) " +
      "con la serie del talonario y la fecha del papel. Los números asignados TIENEN que " +
      "reproducir los impresos — se registra en el orden del talonario, o el 422 dice cuál " +
      "se esperaba y no queda nada escrito.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: facturaContingencia } } },
    },
    responses: {
      201: okJson(
        z.object({ document: documento }),
        "La factura de contingencia, en libros y contabilidad como cualquier otra.",
      ),
      ...erroresComunes,
      409: errorRef("Sin tasa o sin regla vigentes a la fecha del papel, o rango agotado."),
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/fiscal/contingency-ranges/{id}/close",
    summary: "Cerrar el período de la falla (una vez)",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "application/json": { schema: cerrarContingencia } } },
    },
    responses: { 200: okJson(rangoContingenciaResp, "El período cerrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/branches",
    summary: "Las sucursales de la empresa (cualquier miembro)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.object({
          items: z.array(
            z
              .object({
                id: z.string().uuid(),
                code: z.string(),
                name: z.string(),
                status: z.string(),
              })
              .strict(),
          ),
        }),
        "Las sucursales.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/documents/{id}/pdf",
    summary: "El PDF del documento — formato libre, y lo dice en el pie",
    description:
      "VALIDAR-SENIAT: layout NO homologado, con la marca visible en el pie. Imprime lo " +
      "PERSISTIDO — los snapshots congelados de emisor y cliente (R-05, migraciones 33-34), " +
      "importes exactos vestidos, la tasa del día de emisión citada, ANULADA en rojo si " +
      "aplica. Del art. 13 de PA 00071: fecha en ocho dígitos (13.6), «(E)» en líneas " +
      "exentas/exoneradas/no sujetas (13.9), leyenda de copia (13.13, `copia=1`) y ambas " +
      "monedas con tipo de cambio (13.14).",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: companyHeader,
      query: z.object({ copia: z.enum(["1"]).optional() }),
    },
    responses: {
      200: { description: "El PDF (application/pdf)." },
      ...erroresComunes,
    },
  });

  // ── El punto de venta (Fase C) ─────────────────────────────────────────────
  const posQuote = registry.register("PosQuoteRequest", PosQuoteRequest);
  const posQuoteResp = registry.register("PosQuoteResponse", PosQuoteResponse);
  const ventaRapida = registry.register("QuickSaleRequest", QuickSaleRequest);
  const ventaRapidaResp = registry.register("QuickSaleResponse", QuickSaleResponse);
  const vueltoResp = registry.register("PosChangeResponse", PosChangeResponse);

  registry.registerPath({
    method: "post",
    path: "/v1/pos/quote",
    summary: "Cotizar el carrito SIN crear nada (permiso sales.invoice.issue)",
    description:
      "Los mismos precios, la misma regla tributaria y la misma tasa que usaría la factura: es " +
      "el corazón compartido de cotización, pedido y factura, sin escribir. La pantalla de " +
      "Vender pregunta con debounce; el cliente jamás suma dinero. Sin `customer_id` es la " +
      "venta de mostrador (Consumidor final) con la lista «detal» resuelta por el servidor.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: posQuote } } },
    },
    responses: {
      200: okJson(posQuoteResp, "El carrito cotizado."),
      ...erroresComunes,
      409: errorRef("Sin regla tributaria o sin tasa vigente."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/pos/sales",
    summary: "La venta rápida: factura + cobros + vuelto, en una transacción",
    description:
      "Emite por el MISMO camino que /v1/invoices (numeración gapless, kardex, asiento) y " +
      "registra hasta dos cobros. El vuelto del efectivo lo calcula el servidor; una tarjeta " +
      "no da vuelto. El `Idempotency-Key` es el id de venta del cliente: reintentar devuelve " +
      "LA MISMA venta, nunca una segunda factura.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: ventaRapida } } },
    },
    responses: {
      201: okJson(ventaRapidaResp, "La venta: documento, cobros, vuelto y saldo."),
      ...erroresComunes,
      409: errorRef("Numeración, regla tributaria, tasa o existencias: lo que impida emitir."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/pos/change",
    summary: "El vuelto en vivo (permiso sales.payment.register)",
    description:
      "`change = tendered − total/tasa`, en la moneda con la que pagaron y con la tasa del día " +
      "citada. Negativo significa que falta plata. Es cálculo de dinero: vive en el servidor.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        total: z.string(),
        currency: z.string(),
        tendered: z.string(),
        tendered_currency: z.string().optional(),
      }),
    },
    responses: { 200: okJson(vueltoResp, "El vuelto calculado."), ...erroresComunes },
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
      "El FALLBACK del adaptador BCV (ADR-0028): sin internet, la tasa se teclea. Sin fuente " +
      "citada no se persiste, y la fuente viaja en cada documento.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearTasa } } },
    },
    responses: { 201: okJson(crearTasa, "Tasa cargada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/exchange-rates/bcv",
    summary: "Traer la tasa OFICIAL del BCV desde DolarAPI (permiso fx.rate.manage)",
    description:
      "El adaptador BCV de ADR-0028, ya no null: consulta `GET /v1/dolares/oficial` de " +
      "DolarAPI, extrae `promedio` del cuerpo CRUDO (la tasa nunca pasa por un float) y la " +
      "persiste como USD→VES con el día PUBLICADO por la fuente y la fuente citada " +
      "(«BCV oficial vía DolarAPI (<fechaActualizacion>)»). Si la fuente no responde: 502 " +
      "UPSTREAM_UNAVAILABLE, y el fallback es la carga manual de siempre.",
    security: [{ bearerAuth: [] }],
    request: { headers: idemHeader },
    responses: {
      200: okJson(crearTasa, "La MISMA publicación ya estaba cargada: la fila existente."),
      201: okJson(crearTasa, "La tasa traída y persistida."),
      ...erroresComunes,
      502: errorRef("DolarAPI no respondió o la respuesta no trae promedio/fecha reconocibles."),
    },
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

  // ── Compras (migración 22, ADR-0039/0040) ─────────────────────────────────
  const proveedor = registry.register("SupplierResponse", SupplierResponse);
  const listaProveedores = registry.register("ListSuppliersResponse", ListSuppliersResponse);
  const crearProveedor = registry.register("CreateSupplierRequest", CreateSupplierRequest);
  const ordenCompra = registry.register("PurchaseOrderResponse", PurchaseOrderResponse);
  const listaOrdenes = registry.register("ListPurchaseOrdersResponse", ListPurchaseOrdersResponse);
  const crearOrden = registry.register("CreatePurchaseOrderRequest", CreatePurchaseOrderRequest);
  const recibirMercancia = registry.register("ReceiveGoodsRequest", ReceiveGoodsRequest);
  const recepcion = registry.register("GoodsReceiptResponse", GoodsReceiptResponse);
  const registrarFactura = registry.register(
    "RegisterSupplierInvoiceRequest",
    RegisterSupplierInvoiceRequest,
  );
  const facturaProveedor = registry.register("SupplierInvoiceResponse", SupplierInvoiceResponse);
  const matching = registry.register("MatchingResponse", MatchingResponse);
  const aplicarLanded = registry.register("ApplyLandedCostRequest", ApplyLandedCostRequest);
  const landed = registry.register("LandedCostResponse", LandedCostResponse);
  const notaRecibida = registry.register(
    "RegisterSupplierCreditNoteRequest",
    RegisterSupplierCreditNoteRequest,
  );
  const pagoProveedor = registry.register(
    "RegisterSupplierPaymentRequest",
    RegisterSupplierPaymentRequest,
  );
  const respuestaPago = registry.register("SupplierPaymentResponse", SupplierPaymentResponse);
  const comprobante = registry.register("RetentionReceiptResponse", RetentionReceiptResponse);
  const crearReglaRet = registry.register("CreateRetentionRuleRequest", CreateRetentionRuleRequest);
  const antiguedadAp = registry.register("ApAgingResponse", ApAgingResponse);
  const estadoProveedor = registry.register("SupplierStatementResponse", SupplierStatementResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/suppliers",
    summary: "Listar proveedores (búsqueda por RIF o razón social)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: okJson(listaProveedores, "Página de proveedores."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/suppliers",
    summary: "Crear proveedor (permiso supplier.manage)",
    description:
      "El extranjero no lleva RIF ni clasificación fiscal venezolana; el nacional exige ambos. " +
      "Sin formato de RIF (VALIDAR-SENIAT).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearProveedor } } },
    },
    responses: {
      201: okJson(proveedor, "Proveedor creado."),
      ...erroresComunes,
      409: errorRef("RIF duplicado en la empresa."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/purchase-orders",
    summary: "Listar órdenes de compra con su estado DERIVADO de las recepciones",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        status: z.string().optional(),
        supplier_id: z.string().uuid().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: okJson(listaOrdenes, "Página de órdenes."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/purchase-orders/{id}",
    summary: "Detalle de una orden: líneas, avance por línea, recepciones y facturas",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: {
      200: okJson(
        z.object({
          order: ordenCompra,
          lines: z.array(z.record(z.string(), z.unknown())),
          progress: z.array(z.record(z.string(), z.unknown())),
          receipts: z.array(z.record(z.string(), z.unknown())),
          invoices: z.array(z.record(z.string(), z.unknown())),
          derived_status: z.string(),
        }),
        "La orden con lo recibido y lo facturado.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/purchase-orders",
    summary: "Crear orden de compra (permiso purchase.order.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearOrden } } },
    },
    responses: { 201: okJson(ordenCompra, "Orden creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/goods-receipts",
    summary: "Recibir mercancía, total o parcialmente (permiso purchase.receive, por almacén)",
    description:
      "Es el documento que mueve stock y FIJA EL COSTO: la tasa es la vigente a la fecha de la " +
      "recepción, no de la orden ni de la factura (ADR-0040 §4). No admite recibir más de lo " +
      "pendiente en la línea de la orden.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: recibirMercancia } } },
    },
    responses: {
      201: okJson(recepcion, "Recepción confirmada, con el kardex movido."),
      ...erroresComunes,
      409: errorRef("Sin tasa vigente para la fecha de la recepción."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/goods-receipts/{id}",
    summary: "Detalle de una recepción con sus líneas y los gastos ya aplicados",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: {
      200: okJson(
        z.object({
          receipt: recepcion,
          lines: z.array(z.record(z.string(), z.unknown())),
          landed_costs: z.array(z.record(z.string(), z.unknown())),
        }),
        "La recepción completa.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/supplier-invoices",
    summary: "Listar facturas de proveedor con su saldo",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        status: z.string().optional(),
        supplier_id: z.string().uuid().optional(),
      }),
    },
    responses: {
      200: okJson(
        z.object({ items: z.array(z.record(z.string(), z.unknown())), total: z.number().int() }),
        "Facturas con saldo calculado por el esquema.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/supplier-invoices",
    summary: "Registrar factura del proveedor y calcular retenciones (purchase.invoice.register)",
    description:
      "Registra el correlativo y el número de control DEL PROVEEDOR tal como él los emitió; el " +
      "extranjero aporta referencia de documento origen en su lugar. Cruza orden-recepción-" +
      "factura: el precio tolera hasta el umbral de la empresa, la cantidad no tolera nada. " +
      "Las retenciones se calculan aquí con la regla vigente y se aplican al pagar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: registrarFactura } } },
    },
    responses: {
      201: okJson(facturaProveedor, "Factura asentada con sus retenciones calculadas."),
      ...erroresComunes,
      409: errorRef(
        "Sin regla de retención (LAD53); precio fuera del umbral sin aprobación; documento del proveedor ya cargado.",
      ),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/purchases/matching",
    summary: "Matching de tres vías: orden, recepción y factura, con la diferencia de precio",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ supplier_invoice_id: z.string().uuid() }),
    },
    responses: { 200: okJson(matching, "Una fila por línea de factura."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/landed-costs",
    summary: "Aplicar un gasto de importación al costo de una recepción",
    description:
      "Prorratea por valor, peso o unidades. Lo que corresponde a la mercancía que SIGUE en " +
      "existencia revaloriza el inventario por el kardex; lo de la ya vendida es VARIACIÓN DE " +
      "COSTO, un gasto del período (ADR-0040 §6). No se prorratea sobre lo que queda: eso " +
      "encarecería unidades que no incurrieron en el gasto.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: aplicarLanded } } },
    },
    responses: {
      201: okJson(landed, "Gasto aplicado, con el reparto congelado."),
      ...erroresComunes,
      422: errorRef("Prorrateo por peso con alguna línea sin peso (LAD55)."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/landed-costs/variances",
    summary: "Variaciones de costo del período: lo que el landed cost tardío no capitalizó",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: {
      200: okJson(
        z.object({
          items: z.array(z.record(z.string(), z.unknown())),
          total: z.string(),
          currency: z.string(),
        }),
        "Las variaciones y su total.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/supplier-credit-notes",
    summary: "Registrar nota de crédito recibida (permiso purchase.credit_note.register)",
    description: "Reduce el saldo de la factura que abona. No hay abono sin factura que abonar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: notaRecibida } } },
    },
    responses: {
      201: okJson(
        z.object({ id: z.string().uuid(), total_amount: z.string(), balance: z.string() }),
        "Nota registrada y saldo recalculado.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/supplier-payments",
    summary: "Pagar al proveedor aplicando la retención (permiso purchase.payment.register)",
    description:
      "El importe que viaja es el BRUTO: es lo que cancela deuda. El proveedor cobra el neto y " +
      "la diferencia se le debe al fisco. La retención solo se aplica cuando el pago cancela la " +
      "factura entera — prorratearla en un abono parcial no correspondería a ninguna base " +
      "declarable. Si se pide, emite el comprobante con su correlativo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: pagoProveedor } } },
    },
    responses: {
      201: okJson(respuestaPago, "Pago aplicado, con el comprobante si se pidió."),
      ...erroresComunes,
    },
  });
  const compraSimple = registry.register("SimplePurchaseRequest", SimplePurchaseRequest);
  const compraSimpleResp = registry.register("SimplePurchaseResponse", SimplePurchaseResponse);
  registry.registerPath({
    method: "post",
    path: "/v1/purchases/simple",
    summary: "La compra simple: orden + recepción + factura (+ pago) en UN paso",
    description:
      "«Llegó mercancía con su factura»: crea la orden, la recibe completa al costo de la " +
      "recepción, registra la factura del proveedor (matching de tres vías, IVA por regla, " +
      "asiento o cola) y — si se pide — la paga entera. Nada se salta: es el flujo completo de " +
      "compras preguntado una sola vez. Todo o nada, en una transacción.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: compraSimple } } },
    },
    responses: {
      201: okJson(compraSimpleResp, "Orden, recepción, factura y pago (si lo hubo)."),
      ...erroresComunes,
      409: errorRef("Factura duplicada del proveedor, sin tasa, o sin regla de IVA."),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/retention-receipts",
    summary: "Comprobantes de retención emitidos",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(z.array(comprobante), "Los comprobantes de la empresa."),
      ...erroresComunes,
    },
  });
  catalogo(
    "/v1/retention-concepts",
    "Conceptos de retención (vocabulario global, SIN porcentajes)",
    z.array(
      z.object({
        code: z.string(),
        retention_code: z.string(),
        name: z.string(),
        description: z.string(),
      }),
    ),
    false,
  );
  registry.registerPath({
    method: "get",
    path: "/v1/retention-rules",
    summary: "Reglas de retención cargadas (el catálogo nace VACÍO)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(z.array(z.record(z.string(), z.unknown())), "Las reglas y su fuente legal."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/retention-rules",
    summary: "Cargar una regla de retención con su norma (permiso retention.rules.manage)",
    description:
      "Es el acto por el que una empresa PUEDE retener. El catálogo nace vacío a propósito " +
      "(ADR-0039) y sin regla no se retiene: retener cero dejaría a la empresa debiendo al " +
      "fisco en silencio. La fuente legal es obligatoria.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearReglaRet } } },
    },
    responses: { 201: okJson(crearReglaRet, "Regla cargada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/suppliers/{id}/aging",
    summary: "Antigüedad de saldos por pagar de un proveedor (permiso ap.read)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: companyHeader,
      query: z.object({ reference_date: z.string().optional() }),
    },
    responses: { 200: okJson(antiguedadAp, "Tramos 0-30, 31-60, 61-90 y 90+."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/suppliers/{id}/statement",
    summary: "Estado de cuenta del proveedor con antigüedad y retenido (permiso ap.read)",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(estadoProveedor, "El estado de cuenta."), ...erroresComunes },
  });

  // ── Contabilidad (migración 25, ADR-0041/0042/0043) ───────────────────────
  const cuenta = registry.register("AccountResponse", AccountResponse);
  const crearCuenta = registry.register("CreateAccountRequest", CreateAccountRequest);
  const editarCuenta = registry.register("UpdateAccountRequest", UpdateAccountRequest);
  const importarPlan = registry.register("ImportChartTemplateRequest", ImportChartTemplateRequest);
  const asiento = registry.register("JournalEntryResponse", JournalEntryResponse);
  const detalleAsiento = registry.register(
    "JournalEntryDetailResponse",
    JournalEntryDetailResponse,
  );
  const listaAsientos = registry.register("ListJournalEntriesResponse", ListJournalEntriesResponse);
  const crearAsiento = registry.register("CreateJournalEntryRequest", CreateJournalEntryRequest);
  const postearAsiento = registry.register("PostJournalEntryRequest", PostJournalEntryRequest);
  const reversarAsiento = registry.register(
    "ReverseJournalEntryRequest",
    ReverseJournalEntryRequest,
  );
  const mayor = registry.register("LedgerResponse", LedgerResponse);
  const balanceComprobacion = registry.register("TrialBalanceResponse", TrialBalanceResponse);
  const periodo = registry.register("FiscalPeriodResponse", FiscalPeriodResponse);
  const cerrarPeriodo = registry.register("ClosePeriodRequest", ClosePeriodRequest);
  const reabrirPeriodo = registry.register("ReopenPeriodRequest", ReopenPeriodRequest);
  const cierreAnual = registry.register("YearEndCloseRequest", YearEndCloseRequest);
  const fijarPapel = registry.register("SetAccountPurposeRequest", SetAccountPurposeRequest);
  const pendientes = registry.register("PendingJournalResponse", PendingJournalResponse);
  const resultados = registry.register("IncomeStatementResponse", IncomeStatementResponse);
  const situacion = registry.register("BalanceSheetResponse", BalanceSheetResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/accounts",
    summary: "Plan de cuentas de la empresa, en orden de árbol",
    description:
      "Nace VACÍO (ADR-0043): el plan de cuentas no se hard-codea. Se llena creando cuentas " +
      "o importando una plantilla con un acto explícito.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ leaves_only: z.string().optional() }),
    },
    responses: {
      200: okJson(z.array(cuenta), "Las cuentas, ordenadas por path."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/accounts",
    summary: "Crear cuenta (permiso accounting.account.manage)",
    description:
      "La naturaleza la impone el tipo: activo y gasto son deudoras; pasivo, patrimonio e " +
      "ingreso, acreedoras. Un padre deja de ser hoja al recibir un hijo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearCuenta } } },
    },
    responses: { 201: okJson(cuenta, "Cuenta creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "patch",
    path: "/v1/accounts/{id}",
    summary: "Editar una cuenta: SOLO lo no estructural",
    description:
      "Nombre, descripción y si exige analíticas. El código, el tipo y el padre no se tocan: " +
      "renumerar una cuenta con movimientos reescribiría el pasado del mayor sin tocar un asiento.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: editarCuenta } } },
    },
    responses: { 200: okJson(cuenta, "Cuenta actualizada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/accounts/{id}/deactivate",
    summary: "Desactivar una cuenta — nunca borrarla",
    description: "Desactivar no borra histórico: los asientos anteriores siguen apuntando a ella.",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: idemHeader },
    responses: { 200: okJson(cuenta, "Cuenta desactivada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/chart-templates",
    summary: "Plantillas GLOBALES de plan de cuentas (VALIDAR-CONTABLE)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            description: z.string(),
            framework: z.string(),
            legal_source: z.string(),
            account_count: z.number().int(),
          }),
        ),
        "Las plantillas disponibles. Ladino no afirma que ninguna sea correcta para una empresa concreta.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/accounts/import-template",
    summary: "Importar una plantilla al plan de la empresa (acto explícito)",
    description:
      "Copia las cuentas y las DESLIGA: a partir de aquí son de la empresa. Solo sobre un plan " +
      "vacío — importar sobre uno existente mezclaría dos planes.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: importarPlan } } },
    },
    responses: {
      201: okJson(
        z.object({ imported: z.number().int(), purposes: z.number().int() }),
        "Cuentas importadas y papeles aplicados.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/company-account-settings",
    summary: "Qué cuenta cumple cada PAPEL contable, y cuáles están sin asignar",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            purpose: z.string(),
            name: z.string(),
            description: z.string(),
            account_id: z.string().uuid().nullable(),
            account_code: z.string().nullable(),
            account_name: z.string().nullable(),
          }),
        ),
        "Los papeles, con su cuenta o null si falta.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/company-account-settings",
    summary: "Asignar la cuenta de un papel (permiso accounting.template.manage)",
    description:
      "La vigencia anterior se CIERRA, no se borra (ADR-0029): los asientos que resolvieron con " +
      "la cuenta antigua siguen siendo explicables.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: fijarPapel } } },
    },
    responses: {
      200: okJson(
        z.object({ purpose: z.string(), account_id: z.string().uuid() }),
        "Papel asignado.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/journal-entries",
    summary: "Diario: asientos con filtros (permiso accounting.read)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        status: z.string().optional(),
        source_kind: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: okJson(listaAsientos, "Página de asientos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/journal-entries/{id}",
    summary: "Un asiento con sus líneas y el documento origen",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: companyHeader },
    responses: { 200: okJson(detalleAsiento, "El asiento completo."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/journal-entries",
    summary: "Crear asiento manual en BORRADOR (permiso accounting.entry.create)",
    description:
      "No postea: postear es un acto propio con su permiso, porque es el que lo hace inmutable. " +
      "El balance se comprueba aquí para dar la diferencia exacta, pero el invariante real es un " +
      "trigger de Postgres.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearAsiento } } },
    },
    responses: {
      201: okJson(asiento, "Asiento en borrador."),
      ...erroresComunes,
      409: errorRef("La partida doble no cuadra (LAD59), con la diferencia exacta en el mensaje."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/journal-entries/{id}/post",
    summary: "Postear un asiento (permiso accounting.entry.post)",
    description:
      "El acto que lo hace inmutable y lo lleva al mayor. Valida partida doble en moneda " +
      "funcional, período abierto, y que cada cuenta sea hoja, activa y con las dimensiones que exija.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: postearAsiento } } },
    },
    responses: {
      200: okJson(asiento, "Asiento posteado, con su correlativo."),
      ...erroresComunes,
      409: errorRef("Desbalanceado (LAD59), período cerrado (LAD61) o cuenta no postable (LAD62)."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/journal-entries/{id}/reverse",
    summary: "Reversar con un contra-asiento vinculado (permiso accounting.entry.reverse)",
    description:
      "No borra ni edita: los dos asientos quedan visibles y el saldo neto por cuenta es cero. " +
      "El contra-asiento consume SU propio correlativo; el original conserva el suyo.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: reversarAsiento } } },
    },
    responses: { 201: okJson(asiento, "Contra-asiento posteado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/ledger",
    summary: "Mayor de una cuenta: saldo inicial, movimientos y saldo final",
    description: "La fecha final es OBLIGATORIA: un mayor sin corte no se puede reproducir mañana.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        account: z.string().uuid(),
        from: z.string().optional(),
        to: z.string(),
      }),
    },
    responses: { 200: okJson(mayor, "El mayor de la cuenta."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/trial-balance",
    summary: "Balance de comprobación A FECHA (nunca «hoy»)",
    description:
      "Cinco columnas por cuenta con saldo o movimiento. Σ débitos == Σ créditos; si sale falso, " +
      "hay un asiento roto en la base.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ date: z.string(), from: z.string().optional() }),
    },
    responses: { 200: okJson(balanceComprobacion, "El balance."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-periods",
    summary: "Períodos contables, con lo que impide cerrarlos",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(periodo), "Los períodos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-periods/{id}/close",
    summary: "Cerrar período (permiso accounting.period.close)",
    description:
      "Rechaza si quedan borradores o documentos pendientes de contabilizar: un borrador es una " +
      "decisión no tomada, y una cola sin procesar es contabilidad que falta.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: cerrarPeriodo } } },
    },
    responses: { 200: okJson(periodo, "Período cerrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-periods/{id}/reopen",
    summary: "Reabrir período (permiso accounting.period.reopen, motivo OBLIGATORIO)",
    description:
      "El motivo tiene mínimo de longitud y queda en fiscal_periods y en auditoría: «¿por qué se " +
      "reabrió febrero?» tiene que tener respuesta seis meses después.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: reabrirPeriodo } } },
    },
    responses: { 200: okJson(periodo, "Período reabierto, con traza."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-periods/year-end-close",
    summary: "Cierre anual: ingresos y gastos a resultado, y el resultado a acumuladas",
    description:
      "Exige las cuentas de year_result y retained_earnings configuradas. Sin ellas no cierra: " +
      "adivinar cuál es el resultado del ejercicio sería inventar el patrimonio de la empresa.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: cierreAnual } } },
    },
    responses: { 201: okJson(asiento, "Asiento de cierre posteado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/accounting/pending",
    summary: "Documentos emitidos sin plantilla de mapeo (ADR-0042)",
    description:
      "La cola de contabilización pendiente. Una cola que nadie mira es una contabilidad que no " +
      "existe, y por eso su contador aparece en la pantalla de cierre.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(pendientes, "Los pendientes."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/accounting/coverage-gaps",
    summary: "El invariante de ADR-0042, consultable",
    description:
      "Documentos posteados SIN asiento y SIN fila pendiente (missing), o con las dos cosas " +
      "(duplicated). Vacío es lo correcto.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.object({
          gaps: z.array(
            z.object({
              source_kind: z.string(),
              source_id: z.string().uuid(),
              problem: z.string(),
            }),
          ),
          healthy: z.boolean(),
        }),
        "Los huecos de cobertura contable.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/accounting/reports/income-statement",
    summary: "Estado de resultados del período",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: z.object({ from: z.string(), to: z.string() }) },
    responses: { 200: okJson(resultados, "Ingresos, gastos y resultado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/accounting/reports/balance-sheet",
    summary: "Balance general a una fecha",
    description: "Comprueba activo == pasivo + patrimonio; si sale falso, hay un asiento roto.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: z.object({ date: z.string() }) },
    responses: { 200: okJson(situacion, "La situación financiera."), ...erroresComunes },
  });

  // ── Libros fiscales (migración 27, ADR-0044) ───────────────────────────────
  const libro = registry.register("FiscalBookResponse", FiscalBookResponse);
  const conciliacionLibro = registry.register(
    "BookReconciliationResponse",
    BookReconciliationResponse,
  );
  const adaptador = registry.register("BookFormatAdapterResponse", BookFormatAdapterResponse);
  const exportarLibro = registry.register("ExportFiscalBookRequest", ExportFiscalBookRequest);
  const libroExportado = registry.register("ExportFiscalBookResponse", ExportFiscalBookResponse);
  const generaciones = registry.register("ListFiscalBookRunsResponse", ListFiscalBookRunsResponse);
  const periodoQuery = z.object({ from: z.string(), to: z.string() });

  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-books/reports/reconciliation",
    summary: "Conciliación libro ↔ mayor, con la cola a la vista (permiso fiscal_book.read)",
    description:
      "El invariante de ADR-0044 §3: `libro = mayor + pendientes en cola`. Devuelve las TRES " +
      "cifras, no la diferencia sola — mientras exista la cola de ADR-0042 un documento correcto " +
      "puede estar sin contabilizar, y un reporte que solo dijera «no cuadra» convertiría eso en " +
      "un falso positivo diario.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: periodoQuery },
    responses: { 200: okJson(conciliacionLibro, "Libro, mayor y cola."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-books/formats",
    summary: "Catálogo de adaptadores de formato (permiso fiscal_book.read)",
    description:
      "Ninguno es OFICIAL hoy: el layout que exige el SENIAT no está en el repositorio y no se " +
      "inventa (ADR-0044 §5). `implemented` dice cuáles sabe escribir este release, que es cosa " +
      "distinta de estar en el catálogo.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(adaptador), "Los formatos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-books/runs",
    summary: "Generaciones oficiales ya hechas (permiso fiscal_book.read)",
    description:
      "Una fila por EXPORTACIÓN, con su hash. Consultar en pantalla no aparece aquí: es una " +
      "lectura, y no hay nada que demostrar sobre ella.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: z.object({ kind: z.string().optional() }) },
    responses: { 200: okJson(generaciones, "Las generaciones."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-books/export",
    summary: "Exportar un libro dejando su rastro reproducible (permiso fiscal_book.export)",
    description:
      "Escribe una fila en `fiscal_book_runs` con los siete campos y el SHA-256 del dataset. " +
      "Pedir un adaptador que está en el catálogo pero sin implementación responde 409 " +
      "BOOK_FORMAT_UNAVAILABLE (LAD65): un fichero con nombre de oficial que no lo es sería peor " +
      "que no exportar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: exportarLibro } } },
    },
    responses: {
      201: okJson(libroExportado, "El libro, su serialización y el rastro."),
      409: errorRef("El adaptador de formato no tiene implementación cargada."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-books/{kind}",
    summary: "El libro de ventas, compras o retenciones (permiso fiscal_book.read)",
    description:
      "Se calcula desde los documentos cada vez, que es lo que garantiza que cuadre con ellos. " +
      "Las bases van separadas por tratamiento; `base_sin_clasificar` recoge lo emitido antes de " +
      "la migración 27, que no tiene el tratamiento congelado y NO se adivina.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      params: z.object({
        kind: z.enum(["ventas", "compras", "retenciones_iva", "retenciones_islr"]),
      }),
      query: periodoQuery,
    },
    responses: { 200: okJson(libro, "El libro del período."), ...erroresComunes },
  });

  // ── Tesorería (Fase C, migraciones 29–31) ──────────────────────────────────
  const cuentaTesoreria = registry.register("CompanyAccountResponse", CompanyAccountResponse);
  const cuentasTesoreria = registry.register(
    "ListCompanyAccountsResponse",
    ListCompanyAccountsResponse,
  );
  const crearCuentaTes = registry.register(
    "CreateCompanyAccountRequest",
    CreateCompanyAccountRequest,
  );
  const editarCuentaTes = registry.register(
    "UpdateCompanyAccountRequest",
    UpdateCompanyAccountRequest,
  );
  const formaPago = registry.register("PaymentMethodResponse", PaymentMethodResponse);
  const formasPago = registry.register("ListPaymentMethodsResponse", ListPaymentMethodsResponse);
  const crearFormaPago = registry.register(
    "CreatePaymentMethodRequest",
    CreatePaymentMethodRequest,
  );
  const editarFormaPago = registry.register(
    "UpdatePaymentMethodRequest",
    UpdatePaymentMethodRequest,
  );
  const registrarGasto = registry.register("RegisterExpenseRequest", RegisterExpenseRequest);
  const gasto = registry.register("ExpenseResponse", ExpenseResponse);
  const gastos = registry.register("ListExpensesResponse", ListExpensesResponse);
  const cerrarCaja = registry.register("CloseCashRegisterRequest", CloseCashRegisterRequest);
  const cierreCaja = registry.register("CashClosingResponse", CashClosingResponse);
  const cierresCaja = registry.register("ListCashClosingsResponse", ListCashClosingsResponse);
  const confirmarTasa = registry.register("KeepDailyRateRequest", KeepDailyRateRequest);
  const tasaDiaria = registry.register("DailyRateResponse", DailyRateResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/treasury/accounts",
    summary: "Las cuentas del negocio con su saldo (permiso treasury.read)",
    description:
      "«¿Dónde está mi dinero?» — cada cuenta con su saldo materializado EN SU MONEDA, " +
      "mantenido por triggers y verificado por `treasury_reconciliation()`. Las «Sin asignar» " +
      "de sistema son la lista de lo que el contador aún no redistribuyó.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(cuentasTesoreria, "Las cuentas."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/treasury/accounts",
    summary: "Crear una cuenta (permiso treasury.account.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearCuentaTes } } },
    },
    responses: { 201: okJson(cuentaTesoreria, "La cuenta creada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "patch",
    path: "/v1/treasury/accounts/{id}",
    summary: "Renombrar, activar/desactivar o mapear a cuenta contable",
    description:
      "La MONEDA no se cambia: el dinero que ya está dentro no cambia de moneda por editar una " +
      "etiqueta. Las cuentas de sistema están congeladas (LAD06).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: editarCuentaTes } } },
    },
    responses: { 200: okJson(cuentaTesoreria, "La cuenta editada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/payment-methods",
    summary: "Las formas de pago configuradas (permiso treasury.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(formasPago, "Las formas de pago."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/payment-methods",
    summary: "Crear una forma de pago apuntando a su cuenta (permiso treasury.account.manage)",
    description:
      "«Pago móvil → Banesco»: al cobrar con ese instrumento, el dinero entra a esa cuenta solo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearFormaPago } } },
    },
    responses: { 201: okJson(formaPago, "La forma de pago."), ...erroresComunes },
  });
  registry.registerPath({
    method: "patch",
    path: "/v1/payment-methods/{id}",
    summary: "Editar una forma de pago",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: editarFormaPago } } },
    },
    responses: { 200: okJson(formaPago, "La forma de pago editada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/expenses",
    summary: "Registrar un gasto en un paso (permiso expense.register)",
    description:
      "Alquiler, luz, nómina, flete: sale de su cuenta, baja el saldo y va a contabilidad — " +
      "directo si el mapeo del contador resuelve, a la cola de ADR-0042 si no. El importe va en " +
      "la MONEDA de la cuenta; la conversión a funcional usa la tasa vigente con su fuente.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: registrarGasto } } },
    },
    responses: { 201: okJson(gasto, "El gasto registrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/expenses/attachment",
    summary: "Subir el comprobante de un gasto (permiso expense.register)",
    description:
      "Multipart con `file` (foto o PDF, hasta 6 MB) al bucket privado `receipts`. Devuelve la " +
      "RUTA que luego viaja en `attachment_path` de POST /v1/expenses — nunca una URL firmada.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({ file: z.string().openapi({ format: "binary" }) }),
          },
        },
      },
    },
    responses: {
      201: okJson(z.object({ attachment_path: z.string() }), "La ruta del comprobante."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/expenses",
    summary: "Los gastos del período (permiso expense.read)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: { 200: okJson(gastos, "Los gastos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/cash-closings",
    summary: "Cerrar la caja del día (permiso cash.close)",
    description:
      "El servidor dice cuánto ESPERABA (el saldo materializado), la persona dice cuánto contó, " +
      "y la diferencia queda registrada con su motivo, ajusta el saldo a lo contado y va a " +
      "contabilidad como faltante o sobrante. Un cierre no se edita: se cierra de nuevo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: cerrarCaja } } },
    },
    responses: { 201: okJson(cierreCaja, "El cierre registrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/cash-closings",
    summary: "Los cierres hechos (permiso treasury.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(cierresCaja, "Los cierres."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/exchange-rates/keep",
    summary: "«La tasa sigue igual»: confirmarla para hoy (permiso fx.rate.manage)",
    description:
      "SIEMPRE crea una fila nueva con la fecha de hoy y una fuente que dice que fue una " +
      "confirmación humana. Reutilizar la fila vieja dejaría indistinguible «nadie miró la " +
      "tasa» de «se miró y no cambió».",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: confirmarTasa } } },
    },
    responses: { 201: okJson(tasaDiaria, "La tasa confirmada."), ...erroresComunes },
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
