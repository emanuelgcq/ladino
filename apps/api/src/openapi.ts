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
  UpdateCompanyProfileRequest,
  SetCompanyTaxIdRequest,
  CorrectCompanyTaxIdRequest,
  MyProfileResponse,
  SetMyProfileRequest,
  CompanyResponse,
  MePermissionsResponse,
  OnboardBusinessRequest,
  OnboardBusinessResponse,
  ListMembersResponse,
  MemberResponse,
  AddMemberRequest,
  SetMemberStatusRequest,
  CreateInvitationRequest,
  InvitationResponse,
  InvitationTokenRequest,
  InvitationPreviewResponse,
  AcceptInvitationResponse,
  MeAccessResponse,
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
  SetCustomerCreditLimitRequest,
  SetCustomerTaxpayerTypeRequest,
  CustomerResponse,
  ListCustomersResponse,
  ReceiveStockApiRequest,
  IssueStockRequest,
  CountStockRequest,
  CountStockResponse,
  AdjustStockRequest,
  TransferStockRequest,
  InventoryMoveResponse,
  ListInventoryMovesResponse,
  ListStockResponse,
  CreateWarehouseRequest,
  UpdateWarehouseRequest,
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
  CorrectWithdrawalRequest,
  StockExitPreviewResponse,
  ReversePaymentRequest,
  PaymentReversalResponse,
  RegisterPaymentRequest,
  CreateReturnRequest,
  RefundCustomerCreditRequest,
  CustomerRefundResponse,
  DocumentResponse,
  DocumentDetailResponse,
  ListDocumentsResponse,
  RegisterPaymentResponse,
  PosQuoteRequest,
  PosQuoteResponse,
  PosTenderRequest,
  PosTenderResponse,
  QuickSaleRequest,
  QuickSaleResponse,
  PosChangeResponse,
  UpsertPosCartRequest,
  PosCartResponse,
  ListPosCartsResponse,
  CreateDirectCreditNoteRequest,
  DirectCreditNoteResponse,
  CreateDebitNoteRequest,
  ReturnResponse,
  AgingResponse,
  CustomerStatementResponse,
  CreateFiscalRangeRequest,
  CompleteFiscalRangePrinterRequest,
  CorrectFiscalRangePrinterRequest,
  CancelFiscalRangeRequest,
  FiscalRangeResponse,
  CreateExchangeRateRequest,
  CreateSupplierRequest,
  SupplierResponse,
  ListSuppliersResponse,
  CreatePurchaseOrderRequest,
  PurchaseOrderResponse,
  ClosePurchaseOrderRequest,
  ListPurchaseOrdersResponse,
  ReceiveGoodsRequest,
  GoodsReceiptResponse,
  RegisterSupplierInvoiceRequest,
  SupplierInvoiceResponse,
  MatchingResponse,
  ApplyLandedCostRequest,
  LandedCostResponse,
  RegisterSupplierCreditNoteRequest,
  SupplierCreditNoteResponse,
  SupplierInvoiceLinesResponse,
  RegisterSupplierPaymentRequest,
  SupplierPaymentResponse,
  SimplePurchaseRequest,
  RegisterArrivalRequest,
  ArrivalResponse,
  ArrivalPreviewResponse,
  SupplierPaymentPreviewResponse,
  ArrivalImpactResponse,
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
  DiscardJournalEntryRequest,
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
  ExportSalesBookSummaryRequest,
  ExportSalesBookSummaryResponse,
  ListFiscalBookRunsResponse,
  RegisterSupportedRetentionRequest,
  RegisterSupportedRetentionResponse,
  ListSupportedRetentionsResponse,
  GenerateIvaPeriodRequest,
  IvaPeriodResultResponse,
  ListIvaPeriodResultsResponse,
  LoadFiscalDeadlinesRequest,
  ListFiscalDeadlinesResponse,
  IvaPeriodProposalResponse,
  TaxCalendarResponse,
  EnableIgtfRequest,
  SetIgtfInstrumentRequest,
  IgtfInstrumentResponse,
  IgtfStatusResponse,
  SetCompanyTaxpayerTypeRequest,
  SetCompanyTaxpayerTypeResponse,
  CompanyTaxpayerTypeResponse,
  ListIgtfPerceptionsResponse,
  PosIgtfPreviewResponse,
  CreateProductSimpleRequest,
  ProductSimpleResponse,
  ImportProductsResponse,
  ImportNumberFormat,
  ProductImportPreviewResponse,
  ProductImportJobResponse,
  NegocioResumenResponse,
  NegocioTasaResponse,
  ConvertResponse,
  SearchDocumentsQuery,
  ReportTable,
  SalesReportQuery,
  MarginReportQuery,
  RangeReportQuery,
  ReceivablesReportQuery,
  PayablesReportQuery,
  CashClosingsReportQuery,
  SearchDocumentsResponse,
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
  ListCandidateAccountsResponse,
  ListMoneyLandingGapsResponse,
  CreatePaymentMethodRequest,
  UpdatePaymentMethodRequest,
  PaymentMethodResponse,
  ListPaymentMethodsResponse,
  RegisterExpenseRequest,
  ExpenseResponse,
  ListRecurringExpensesResponse,
  RecurringExpenseResponse,
  SkipRecurringExpenseRequest,
  StopRecurringExpenseRequest,
  ExpensePreviewResponse,
  ListExpensesResponse,
  CloseCashRegisterRequest,
  CashClosingResponse,
  ListCashClosingsResponse,
  KeepDailyRateRequest,
  DailyRateResponse,
  RetentionVoucherResponse,
  CorrectRetentionVoucherRequest,
  DeliverRetentionVoucherRequest,
  SetRetentionVoucherModeRequest,
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

  const misPermisos = registry.register("MePermissionsResponse", MePermissionsResponse);
  const fundar = registry.register("OnboardBusinessRequest", OnboardBusinessRequest);
  const fundado = registry.register("OnboardBusinessResponse", OnboardBusinessResponse);
  const miembros = registry.register("ListMembersResponse", ListMembersResponse);
  const miembro = registry.register("MemberResponse", MemberResponse);
  const agregarMiembro = registry.register("AddMemberRequest", AddMemberRequest);
  const estadoMiembro = registry.register("SetMemberStatusRequest", SetMemberStatusRequest);

  registry.registerPath({
    method: "post",
    path: "/v1/onboarding",
    summary: "Fundar el negocio (ADR-0049)",
    description:
      "El primer día real: crea tenant, membresía, los dos roles del fundador (dueño plano + " +
      "operación de almacén con su binding), la empresa, el primer depósito y el plan contable " +
      "con sus plantillas de asiento — en UNA transacción. Sin X-Company-Id y sin " +
      "Idempotency-Key: la idempotencia es estructural (un negocio por usuario, LAD81 → 409).",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: fundar } } } },
    responses: {
      201: {
        description: "El negocio fundado.",
        content: { "application/json": { schema: fundado } },
      },
      409: errorRef("El usuario ya pertenece a un negocio."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/members",
    summary: "Los miembros del negocio y sus roles",
    description:
      "ADR-0049/ADR-0068 §3: membresías de la empresa activa, con correo y asignaciones. " +
      "Exige membership.read sobre la empresa de la cabecera (asignación de esa empresa o de " +
      "nivel tenant). El Titular de la cuenta (asignación de nivel tenant) ve la cuenta entera; " +
      "un gestor acotado a la empresa ve a las personas con rol en ella (y al Titular), con solo " +
      "las asignaciones de esa empresa o de la cuenta.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "La lista de miembros.",
        content: { "application/json": { schema: miembros } },
      },
      403: errorRef("Sin membership.read sobre esta empresa."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/members",
    summary: "Agregar un miembro por su correo",
    description:
      "La persona se registra sola en Ladino y el dueño la agrega por correo con uno de los " +
      "seis roles de sistema. Un rol acotado recibe bindings a TODOS los almacenes de la " +
      "empresa; un owner recibe además warehouse_ops acotado a la empresa. Exige " +
      "membership.manage sobre la empresa de la cabecera. Si la persona estaba desactivada, " +
      "agregarla la reactiva, y un gestor acotado pasa la misma guarda que al cambiar el acceso.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: agregarMiembro } } } },
    responses: {
      201: {
        description: "El miembro con sus asignaciones.",
        content: { "application/json": { schema: miembro } },
      },
      404: errorRef("Ese correo no tiene cuenta en Ladino todavía."),
      403: errorRef(
        "Sin membership.manage sobre esta empresa (PERMISSION_REQUIRED); o, al reactivar a un " +
          "desactivado, es el Titular o trabaja en otra empresa que el gestor no gestiona " +
          "(MEMBER_PROTECTED).",
      ),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "delete",
    path: "/v1/members/assignments/{id}",
    summary: "Quitar un rol asignado",
    description:
      "Elimina la asignación y sus bindings. El dueño no puede quitarse a sí mismo el rol de " +
      "dueño. Exige membership.manage sobre la empresa de la cabecera; un gestor acotado solo " +
      "quita asignaciones de esa empresa y ninguna del Titular de la cuenta.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: { description: "Asignación eliminada." },
      403: errorRef(
        "Sin membership.manage sobre esta empresa (PERMISSION_REQUIRED), o la asignación es del " +
          "Titular de la cuenta y quien pide es un gestor acotado (MEMBER_PROTECTED).",
      ),
      404: errorRef(
        "La asignación no existe en este negocio o, para un gestor acotado, es de otra empresa.",
      ),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/members/{id}/status",
    summary: "Activar o desactivar el acceso de un miembro",
    description:
      "Desactivar la membresía corta el acceso ENTERO en la consulta siguiente (ADR-0014). " +
      "Nadie puede desactivarse a sí mismo. Exige membership.manage sobre la empresa de la " +
      "cabecera. Un gestor acotado solo cambia el acceso de quien tiene rol en esa empresa, no " +
      "tiene roles en empresas que él no gestiona y no es el Titular de la cuenta.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: estadoMiembro } } } },
    responses: {
      200: { description: "Estado cambiado." },
      403: errorRef(
        "Sin membership.manage sobre esta empresa (PERMISSION_REQUIRED), o la persona es el " +
          "Titular o trabaja en otra empresa que el gestor no gestiona (MEMBER_PROTECTED).",
      ),
      404: errorRef(
        "La membresía no existe en este negocio o, para un gestor acotado, no tiene rol en esta empresa.",
      ),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });
  // ── ADR-0077: segunda empresa, invitación por enlace y acceso perdido ──────
  const crearInvitacion = registry.register("CreateInvitationRequest", CreateInvitationRequest);
  const invitacion = registry.register("InvitationResponse", InvitationResponse);
  const tokenInvitacion = registry.register("InvitationTokenRequest", InvitationTokenRequest);
  const vistaInvitacion = registry.register("InvitationPreviewResponse", InvitationPreviewResponse);
  const aceptada = registry.register("AcceptInvitationResponse", AcceptInvitationResponse);
  const miAcceso = registry.register("MeAccessResponse", MeAccessResponse);

  registry.registerPath({
    method: "post",
    path: "/v1/onboarding/another-company",
    summary: "Crear otra empresa, en un tenant nuevo (ADR-0077 §2)",
    description:
      "El mismo alta de /v1/onboarding en un tenant NUEVO, del que la persona nace Titular y " +
      "Dueño. Solo para el Titular de alguna cuenta (asignación owner de nivel tenant). Sin " +
      "X-Company-Id y sin Idempotency-Key: la clave natural (nombre o RIF entre los negocios de " +
      "la persona, LAD94 → 409) impide fundarla dos veces.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: fundar } } } },
    responses: {
      201: {
        description: "La empresa nueva, con su tenant.",
        content: { "application/json": { schema: fundado } },
      },
      403: errorRef("No es Titular de ninguna cuenta (PERMISSION_REQUIRED)."),
      409: errorRef("Ya tiene un negocio con ese nombre o ese RIF (DUPLICATE)."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/me/access",
    summary: "Los negocios donde la persona perdió el acceso (N-03)",
    description:
      "Negocios donde la persona tiene membresía (desactivada o sin rol) y ninguna empresa " +
      "visible, con el nombre de quien los administra. Solo la historia propia.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "La lista (vacía si no perdió nada).",
        content: { "application/json": { schema: miAcceso } },
      },
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/invitations",
    summary: "Invitar a una persona por enlace (ADR-0077 §3)",
    description:
      "Crea una invitación de un solo uso que vence a los 7 días, con uno de los seis roles de " +
      "sistema, opcionalmente ligada a un correo. El token viaja UNA vez, en esta respuesta; la " +
      "base guarda su huella. Exige membership.manage sobre la empresa de la cabecera.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: crearInvitacion } } } },
    responses: {
      201: {
        description: "La invitación, con su token.",
        content: { "application/json": { schema: invitacion } },
      },
      403: errorRef("Sin membership.manage sobre esta empresa."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/invitations/preview",
    summary: "Lo que ve quien abre el enlace de invitación",
    description:
      "Empresa, negocio, rol, quién invita y el estado (pending, used, revoked, expired, " +
      "other_email). Sin X-Company-Id: la persona todavía no es miembro.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: tokenInvitacion } } } },
    responses: {
      200: {
        description: "La vista previa.",
        content: { "application/json": { schema: vistaInvitacion } },
      },
      404: errorRef("Ese token no corresponde a ninguna invitación."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/invitations/accept",
    summary: "Aceptar la invitación",
    description:
      "Un solo uso, con la fila bloqueada: crea o reactiva la membresía y la asignación acotada a " +
      "la empresa. La misma persona que repite recibe la empresa sin efecto doble. Sin " +
      "X-Company-Id y sin Idempotency-Key.",
    security: [{ bearerAuth: [] }],
    request: { body: { content: { "application/json": { schema: tokenInvitacion } } } },
    responses: {
      200: {
        description: "La empresa a la que entró.",
        content: { "application/json": { schema: aceptada } },
      },
      403: errorRef("La invitación es para otro correo (INVITATION_FOR_OTHER_EMAIL)."),
      404: errorRef("Ese token no corresponde a ninguna invitación."),
      409: errorRef(
        "Ya se usó, venció, o quien la envió ya no gestiona la empresa (INVITATION_UNAVAILABLE).",
      ),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/me/permissions",
    summary: "Los permisos del usuario en la empresa activa",
    description:
      "ADR-0048: el conjunto entero de permisos del actor en la empresa del header " +
      "`X-Company-Id`, resuelto por `platform.ladino_user_permissions()` — la MISMA " +
      "resolución que autoriza cada operación. La webapp forma el menú con esto; " +
      "esconder un botón es cortesía, la autorización real sigue siendo por operación.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "La lista de claves de permiso (puede ser vacía).",
        content: { "application/json": { schema: misPermisos } },
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
  const SUBIDA_IMPORTACION = z.object({
    file: z.string().openapi({ format: "binary" }),
    number_format: ImportNumberFormat.optional().openapi({
      description:
        "Formato de los números del archivo. Por omisión «comma_decimal» (el venezolano: " +
        "1.234,50). Una celda ambigua bajo el formato elegido («0.500» con coma decimal) " +
        "se rechaza con su fila y el motivo (ADR-0074, C-01).",
    }),
  });
  const importProductos = registry.register("ImportProductsResponse", ImportProductsResponse);
  const previaImportacion = registry.register(
    "ProductImportPreviewResponse",
    ProductImportPreviewResponse,
  );
  const trabajoImportacion = registry.register(
    "ProductImportJobResponse",
    ProductImportJobResponse,
  );
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

  // ── Mi empresa y la política de RIF en tres niveles (migración 43) ────────
  const editarPerfil = registry.register(
    "UpdateCompanyProfileRequest",
    UpdateCompanyProfileRequest,
  );
  const ponerRif = registry.register("SetCompanyTaxIdRequest", SetCompanyTaxIdRequest);
  const corregirRif = registry.register("CorrectCompanyTaxIdRequest", CorrectCompanyTaxIdRequest);
  const miFicha = registry.register("MyProfileResponse", MyProfileResponse);
  const ponerMiFicha = registry.register("SetMyProfileRequest", SetMyProfileRequest);

  registry.registerPath({
    method: "patch",
    path: "/v1/companies/profile",
    summary: "Editar el perfil del negocio («Mi empresa», permiso company.settings.manage)",
    description:
      "Nombre comercial, rubro, contacto, ciudad/estado, razón social y dirección fiscal. El " +
      "RIF NO se toca por aquí (tiene su endpoint y su permiso). Con documentos fiscales ya " +
      "emitidos, cambiar razón social o dirección exige `reason`, que queda en el acta de " +
      "auditoría; las facturas emitidas conservan su snapshot (migración 34).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: editarPerfil } } },
    },
    responses: {
      200: okJson(z.object({}).passthrough(), "El perfil actualizado."),
      401: errorRef("Token ausente, inválido o expirado."),
      403: errorRef("Sin company.settings.manage."),
      422: errorRef("Identidad del emisor con documentos emitidos y sin motivo."),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/companies/tax-id",
    summary: "Poner el primer RIF o cambiarlo SIN documentos (permiso company.tax_id.manage)",
    description:
      "Niveles 1 de la política de RIF: reemplazar el placeholder PEND-* (la transición de " +
      "recibos a facturación — los recibos emitidos no la bloquean) o cambiarlo cuando no hay " +
      "documentos fiscales. Con documentos responde 422: el RIF identifica al contribuyente y " +
      "no se cambia; el dedazo tardío va por /v1/companies/tax-id/correct. Exige la dirección " +
      "fiscal cargada. El acta con el valor anterior la escribe el trigger (migración 20).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: ponerRif } } },
    },
    responses: {
      200: okJson(z.object({ tax_id: z.string() }), "El RIF quedó puesto."),
      401: errorRef("Token ausente, inválido o expirado."),
      403: errorRef("Sin company.tax_id.manage."),
      409: errorRef("Ya existe una empresa con ese RIF en el tenant."),
      422: errorRef("RIF bloqueado por documentos emitidos, o falta la dirección fiscal."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/companies/tax-id/correct",
    summary: "Corrección EXCEPCIONAL del RIF (motivo obligatorio, acta propia)",
    description:
      "Nivel 3: el dedazo descubierto tarde. Funciona aunque haya documentos emitidos — " +
      "corregir un error de tipeo no es cambiar de contribuyente — pero exige motivo, deja su " +
      "acta (company.tax_id_corrected) además de la del trigger, y la UI aconseja consultar " +
      "al contador sobre la reemisión de lo ya facturado.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: corregirRif } } },
    },
    responses: {
      200: okJson(z.object({ tax_id: z.string() }), "El RIF corregido."),
      401: errorRef("Token ausente, inválido o expirado."),
      403: errorRef("Sin company.tax_id.manage."),
      409: errorRef("Ya existe una empresa con ese RIF en el tenant."),
      422: errorRef("Falta el motivo o la dirección fiscal."),
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/companies/logo",
    summary: "Subir el logo del negocio (permiso company.settings.manage)",
    description:
      "Multipart con el campo `file` (JPG/PNG/WebP, hasta 6 MB). Patrón product-images: el " +
      "servidor genera logo-256/logo-64 en webp para la app y logo-pdf.png (512px, aplanado " +
      "a blanco) porque pdfkit no lee webp; guarda la RUTA y sirve URL firmada. El logo es " +
      "presentación: no entra al snapshot del emisor ni a ningún dato fiscal.",
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
      201: okJson(
        z.object({ logo_path: z.string(), logo_url: z.string().nullable() }),
        "El logo subido, con su URL firmada.",
      ),
      401: errorRef("Token ausente, inválido o expirado."),
      403: errorRef("Sin company.settings.manage."),
      422: errorRef("Archivo ausente, tipo no soportado o imagen ilegible."),
    },
  });

  registry.registerPath({
    method: "get",
    path: "/v1/me/profile",
    summary: "La ficha de quien administra (users_profile)",
    description: "Cada quien lee SOLO la suya. Campos en null si todavía no la llenó.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: okJson(miFicha, "La ficha propia."),
      401: errorRef("Token ausente, inválido o expirado."),
    },
  });

  registry.registerPath({
    method: "put",
    path: "/v1/me/profile",
    summary: "Guardar la ficha propia (nombre completo, cédula opcional)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: ponerMiFicha } } },
    },
    responses: {
      200: okJson(miFicha, "La ficha guardada."),
      401: errorRef("Token ausente, inválido o expirado."),
      422: errorRef("Forma inválida."),
    },
  });

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
        /** E-07: cotiza por la lista preferida de ese cliente (la que aplicará el carrito). */
        customer_id: z.string().uuid().optional(),
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
    summary: "Importar productos desde .csv o .xlsx, con errores POR FILA en voz de persona",
    description:
      "Multipart con `file` (.csv o .xlsx, hasta 500 filas). CSV con separador «;» o «,» — se " +
      "detecta solo. Bastan las columnas «Nombre» y «Precio»; «Moneda», «Código», «Código de " +
      "barras», «Categoría», «Existencia», «Costo», «Moneda costo» y «Es servicio» son " +
      "opcionales. Cada fila es SU transacción: las buenas entran, las malas se explican con su " +
      "número de fila. Los importes se leen del TEXTO de la celda (coma decimal venezolana " +
      "incluida — «2,50» y «1.234,56» valen), nunca del float de Excel.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: {
        content: {
          "multipart/form-data": {
            schema: z.object({
              file: z.string().openapi({ format: "binary" }),
              number_format: ImportNumberFormat.optional().openapi({
                description:
                  "Formato de los números del archivo. Por omisión «comma_decimal» (el venezolano: " +
                  "1.234,50). Una celda ambigua bajo el formato elegido («0.500» con coma decimal) " +
                  "se rechaza con su fila y el motivo (ADR-0074, C-01).",
              }),
            }),
          },
        },
      },
    },
    responses: {
      201: okJson(importProductos, "El resultado fila por fila, con avisos."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products/import/preview",
    summary: "Vista previa de una importación: las diez primeras filas como se van a guardar",
    description:
      "Multipart con `file` y `number_format` opcional. No escribe nada. Devuelve las diez " +
      "primeras filas INTERPRETADAS con sus avisos (la existencia de un servicio se ignora con " +
      "aviso; el costo sin existencia se acepta como costo de referencia) y TODAS las rechazadas " +
      "con su número de fila y el motivo (ADR-0074, C-01 y C-05).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "multipart/form-data": { schema: SUBIDA_IMPORTACION } } },
    },
    responses: {
      200: okJson(previaImportacion, "Las filas interpretadas y las rechazadas."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/products/import/jobs",
    summary: "Confirmar una importación: crea el TRABAJO que el worker procesa",
    description:
      "Multipart con `file` y `number_format` opcional. La petición solo crea el trabajo (202). " +
      "El mismo archivo con el mismo formato devuelve el trabajo existente (200, `reused: true`): " +
      "la llave es el sha256 del archivo. Exige `Idempotency-Key` con hash canónico (archivo + formato): la misma llave con otro archivo da 409 IDEMPOTENCY_BODY_MISMATCH. Dentro del trabajo, el código del producto es la llave: " +
      "si ya existe, la fila actualiza su precio en vez de duplicar (ADR-0074, C-04).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader.extend({ "Idempotency-Key": z.string().max(255) }),
      body: { content: { "multipart/form-data": { schema: SUBIDA_IMPORTACION } } },
    },
    responses: {
      202: okJson(trabajoImportacion, "El trabajo nuevo, pendiente."),
      200: okJson(trabajoImportacion, "El trabajo que ya existía para ese archivo."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/products/import/jobs/{id}",
    summary: "Progreso e informe de un trabajo de importación",
    description:
      "Estado (pending, running, done, failed), filas procesadas y el informe fila por fila: " +
      "creadas, actualizadas y rechazadas con el motivo (ADR-0074, C-04).",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: okJson(trabajoImportacion, "El trabajo con su progreso y su informe."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/customers/import",
    summary: "Importar clientes desde .csv o .xlsx (permiso customer.manage)",
    description:
      "Multipart con `file` (.csv o .xlsx, hasta 500 filas; separador «;» o «,» — se detecta " +
      "solo). Basta la columna «Nombre o razón social»; «RIF o cédula», «Teléfono», «Correo» y " +
      "«Dirección» son opcionales. El tipo de persona se infiere del documento como en la caja: " +
      "J/G = empresa, V/E o vacío = persona, P = extranjero. Cada fila es su transacción y la " +
      "mala se explica con su número.",
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
      201: okJson(
        z
          .object({
            total: z.number().int(),
            created: z.number().int(),
            failed: z.number().int(),
            rows: z.array(
              z
                .object({
                  row: z.number().int(),
                  status: z.enum(["creado", "error"]),
                  message: z.string().optional(),
                  customer_id: z.string().uuid().optional(),
                  name: z.string().optional(),
                })
                .strict(),
            ),
          })
          .strict()
          .openapi("ImportCustomersResponse"),
        "El resultado fila por fila.",
      ),
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
      z.object({
        code: z.string(),
        name: z.string(),
        description: z.string(),
        status: z.string(),
        /** Si el catálogo de alícuotas con fuente la ofrece en ventas (ADR-0073). */
        offered_in_sales: z.boolean(),
      }),
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
      "facturas emitidas, calculada por el esquema) — la cifra de la pantalla de Clientes. " +
      "Pedir la deuda exige el permiso ar.read: sin él, 403 PERMISSION_REQUIRED (P-04). " +
      "La lista sin `with_debt` no lo exige. `sort=debt_desc` (o `debt_asc`) ordena por esa deuda " +
      "—mayor primero, y lo que no se pudo valorar hoy arriba— en vez de por nombre (P-05); " +
      "exige `with_debt=1` y un valor desconocido es 422.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        search: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
        with_debt: z.enum(["1"]).optional(),
        sort: z.enum(["name", "debt_desc", "debt_asc"]).optional(),
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
  registry.registerPath({
    method: "put",
    path: "/v1/customers/{id}/credit-limit",
    summary:
      "Fijar el límite de fiado del cliente, en USD (permiso customers.credit.set; deja acta). " +
      "Un cliente nace con límite 0",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: registry.register(
              "SetCustomerCreditLimitRequest",
              SetCustomerCreditLimitRequest,
            ),
          },
        },
      },
    },
    responses: { 200: okJson(cliente, "Límite fijado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/customers/{id}/taxpayer-type",
    summary:
      "Cambiar la clasificación fiscal del cliente (permiso customer.tax_id.manage; deja acta)",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: registry.register(
              "SetCustomerTaxpayerTypeRequest",
              SetCustomerTaxpayerTypeRequest,
            ),
          },
        },
      },
    },
    responses: { 200: okJson(cliente, "Clasificación cambiada."), ...erroresComunes },
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
  const recibir = registry.register("ReceiveStockApiRequest", ReceiveStockApiRequest);
  const despachar = registry.register("IssueStockRequest", IssueStockRequest);
  const ajustar = registry.register("AdjustStockRequest", AdjustStockRequest);
  const transferir = registry.register("TransferStockRequest", TransferStockRequest);
  const transferencia = registry.register("TransferResponse", TransferResponse);
  const crearAlmacen = registry.register("CreateWarehouseRequest", CreateWarehouseRequest);
  const almacen = registry.register("WarehouseResponse", WarehouseResponse);
  const cambiarAlmacen = registry.register("UpdateWarehouseRequest", UpdateWarehouseRequest);

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
    "El costo va TOTAL (amount) o POR UNIDAD (unit_amount), uno de los dos; el total lo " +
      "calcula el servidor. En moneda distinta a la funcional se valora con la tasa del BCV " +
      "del día; `fx` desde fuera responde 409 RATE_ONLY_FROM_BCV (ADR-0064). El promedio se " +
      "recalcula.",
    recibir,
    movimiento,
  );
  mueveStock(
    "/v1/inventory/issues",
    "Salida con motivo al costo promedio (permiso inventory.move sobre el almacén)",
    "El costo lo calcula el promedio ponderado móvil; el cliente no lo envía. El motivo es " +
      "obligatorio y de lista cerrada (ADR-0078): merma, rotura, vencido y faltante van a " +
      "«Pérdidas por mermas y faltantes»; consumo propio, regalo, donación y muestra son retiro " +
      "(LIVA art. 4.3) y, en una empresa que factura, emiten una FACTURA de retiro con control " +
      "del talonario (RLIVA art. 31, ADR-0082: withdrawal_invoice; no genera cuenta por cobrar); " +
      "uso en el negocio, activo fijo e incorporado a un inmueble salen sin débito y sin documento.",
    despachar,
    movimiento,
  );
  registry.registerPath({
    method: "post",
    path: "/v1/inventory/issues/preview",
    summary: "Vista previa de una salida: qué va a emitir, con sus cifras (permiso inventory.move)",
    description:
      "ADR-0082. El servidor ENSAYA la salida entera y la deshace: no mueve el kardex ni gasta " +
      "correlativo ni número de control. Responde si se emitirá una factura de retiro (serie, " +
      "base, IVA y total en la moneda funcional) o nada (motivo no gravado, pérdida justificada o " +
      "empresa que no factura). El número no se promete: se asigna al emitir. Un rechazo sale " +
      "aquí igual que saldría al confirmar. Sin Idempotency-Key: no escribe.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: despachar } } },
    },
    responses: {
      200: okJson(
        registry.register("StockExitPreviewResponse", StockExitPreviewResponse),
        "Lo que la salida emitiría.",
      ),
      ...erroresComunes,
    },
  });
  mueveStock(
    "/v1/inventory/adjustments",
    "Ajuste de existencias (permiso inventory.adjust, SEGREGADO de inventory.move)",
    "El motivo es obligatorio: un ajuste sin motivo no es un ajuste, es un descuadre.",
    ajustar,
    movimiento,
  );
  registry.registerPath({
    method: "post",
    path: "/v1/inventory/counts",
    summary: "Conteo de existencias (permiso inventory.adjust sobre el almacén)",
    description:
      "La persona escribe lo que contó; el servidor calcula la diferencia contra el sistema bajo " +
      "el bloqueo de la posición (ADR-0078 §4). Con preview: true solo la devuelve (200); sin él la " +
      "registra como ajuste con su motivo (201). Contado igual al sistema: 200 sin movimiento.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: CountStockRequest } } },
    },
    responses: {
      200: okJson(CountStockResponse, "La diferencia calculada, sin movimiento."),
      201: okJson(CountStockResponse, "La diferencia registrada como ajuste."),
      ...erroresComunes,
    },
  });
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
  registry.registerPath({
    method: "patch",
    path: "/v1/warehouses/{id}",
    summary: "Renombrar, apagar/encender o hacer principal un almacén (warehouse.manage)",
    description:
      "El principal no se apaga, ni un almacén con existencias (WAREHOUSE_IN_USE). Hacerlo " +
      "principal exige además company.settings.manage (migración 60).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: cambiarAlmacen } } },
    },
    responses: {
      200: okJson(almacen, "Almacén actualizado."),
      ...erroresComunes,
      409: errorRef("El principal o un almacén con mercancía no se apaga."),
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
  const reversarCobro = registry.register("ReversePaymentRequest", ReversePaymentRequest);
  const cobroReversado = registry.register("PaymentReversalResponse", PaymentReversalResponse);
  const registrarCobro = registry.register("RegisterPaymentRequest", RegisterPaymentRequest);
  const respuestaCobro = registry.register("RegisterPaymentResponse", RegisterPaymentResponse);
  const crearDevolucion = registry.register("CreateReturnRequest", CreateReturnRequest);
  const pedirReembolso = registry.register(
    "RefundCustomerCreditRequest",
    RefundCustomerCreditRequest,
  );
  const reembolso = registry.register("CustomerRefundResponse", CustomerRefundResponse);
  const devolucion = registry.register("ReturnResponse", ReturnResponse);
  const antiguedad = registry.register("AgingResponse", AgingResponse);
  const estadoCuenta = registry.register("CustomerStatementResponse", CustomerStatementResponse);
  const crearRango = registry.register("CreateFiscalRangeRequest", CreateFiscalRangeRequest);
  const rango = registry.register("FiscalRangeResponse", FiscalRangeResponse);
  const completarImprenta = registry.register(
    "CompleteFiscalRangePrinterRequest",
    CompleteFiscalRangePrinterRequest,
  );
  const corregirImprenta = registry.register(
    "CorrectFiscalRangePrinterRequest",
    CorrectFiscalRangePrinterRequest,
  );
  const anularTalonario = registry.register("CancelFiscalRangeRequest", CancelFiscalRangeRequest);
  const crearTasa = registry.register("CreateExchangeRateRequest", CreateExchangeRateRequest);

  registry.registerPath({
    method: "get",
    path: "/v1/documents",
    summary: "Listar documentos de venta (filtros por tipo, estado, cliente, origen y fechas)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        kind: z.string().optional(),
        status: z.string().optional(),
        customer_id: z.string().uuid().optional(),
        /** Las notas y devoluciones emitidas SOBRE ese documento. */
        source_document_id: z.string().uuid().optional(),
        /** Por «SERIE-número» (parcial) o número de control exacto. */
        search: z.string().optional(),
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
    summary: "Anular una factura o un recibo emitidos y SIN cobros (permiso sales.invoice.annul)",
    description:
      "Anular no es borrar: el documento y su correlativo SE CONSERVAN (regla 1, ADR-0037). " +
      "El número anulado sigue ocupado y no se reutiliza. Anular REPONE la existencia al lote y " +
      "valor con que salió (ADR-0061 §2). Con cobros → 409 DOCUMENT_HAS_PAYMENTS: una venta " +
      "cobrada se deshace con una devolución, no anulándola. G-10 (PA 00071 arts. 22 y 36): una " +
      "FACTURA se anula solo el mismo día de Caracas, antes del cierre de su caja, con el período " +
      "sin declarar y con originals_in_hand = true; si no → 409 ANNULMENT_NOT_ALLOWED con " +
      "details.reason, y el camino es la nota de crédito.",
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
    path: "/v1/invoices/{id}/withdrawal-credit-note",
    summary:
      "Nota de crédito de una factura de retiro (permisos sales.invoice.annul e inventory.move)",
    description:
      "ADR-0082 (PA 00071 arts. 22 y 23). Deja sin efecto el retiro ENTERO cuando ya no se puede " +
      "anular: emite una nota de crédito (kind withdrawal_credit_note) con el correlativo y el " +
      "control de las notas de crédito, a nombre de la propia empresa y por los mismos importes " +
      "que la factura; la mercancía vuelve al kardex al costo con que salió y el asiento es el " +
      "contra-asiento del retiro. No toca cartera ni crea saldo a favor. Una por factura: la " +
      "segunda → 422. Resta en el libro de ventas y en la declaración del período en que se emite.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: registry.register("CorrectWithdrawalRequest", CorrectWithdrawalRequest),
          },
        },
      },
    },
    responses: { 201: okJson(documento, "Nota de crédito emitida."), ...erroresComunes },
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
    path: "/v1/payments/{id}/reversal",
    summary: "Reversar un cobro, con motivo (permiso ar.payment.reverse: dueño y contador)",
    description:
      "ADR-0075 §8. El cobro no se edita ni se borra: se escribe su reversa (append-only), sale " +
      "de la caja lo que entró, su asiento se revierte con un contra-asiento y el documento " +
      "vuelve a deber por la única función de deuda (una factura `paid` vuelve a `issued`). Si " +
      "el cobro percibió IGTF, la percepción queda `pendiente_reintegro` y lo percibido se " +
      "restituye al cliente (PA SNAT/2022/000013 art. 4). Un cobro se reversa una sola vez → 409 " +
      "PAYMENT_ALREADY_REVERSED. Si su IGTF se documentó con nota de débito → 409 IGTF_NOTE_ISSUED. " +
      "El abono de una retención soportada se reversa desde su comprobante.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: reversarCobro } } },
    },
    responses: { 201: okJson(cobroReversado, "Cobro reversado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/supported-retentions/{id}/reversal",
    summary:
      "Reversar un comprobante de retención soportada (permiso ar.retention.correct: contador)",
    description:
      "ADR-0072 §5 y ADR-0075 §8. Reversa el abono del comprobante por la vía de la reversa de " +
      "cobros y deja el comprobante `annulled` con el motivo: sale del libro de ventas y de la " +
      "declaración. Corregirlo es reversarlo y volver a cargarlo (su número queda libre).",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: reversarCobro } } },
    },
    responses: { 201: okJson(cobroReversado, "Comprobante reversado."), ...erroresComunes },
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
      "ventas. La pantalla no suma ni un céntimo (permiso treasury.read). Un total de deuda en " +
      "`null` lleva su motivo en `…_motivo` (`sin_permiso` | `sin_tasa`) y, sin tasa, el nominal " +
      "por moneda en `…_por_moneda`.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(resumenNegocio, "El resumen."), ...erroresComunes },
  });
  const tasaNegocio = registry.register("NegocioTasaResponse", NegocioTasaResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/negocio/tasa",
    summary: "La tasa del día, para cualquier miembro de la empresa",
    description:
      "La misma `tasa_del_dia` del resumen, sin exigir treasury.read: quien cierra su caja o trae " +
      "la tasa la necesita aunque no vea el dinero del negocio (N-05). `null` = nunca se cargó.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(tasaNegocio, "La tasa del día, o null."), ...erroresComunes },
  });
  const busquedaDocumentos = registry.register("SearchDocumentsResponse", SearchDocumentsResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/search/documents",
    summary: "Buscar documentos por su número (la paleta, Ctrl+K)",
    description:
      "Facturas, recibos, notas de crédito y de débito y cotizaciones por serie y número " +
      "(«A-12» o «A-00000012», completo o una parte), y compras por el número, el control o la " +
      "referencia del proveedor. Acotada a la empresa de X-Company-Id y a lo que el rol puede " +
      "leer: las ventas exigen ar.read o un permiso de operación de ventas (sales.invoice.issue, " +
      "sales.quote.manage, sales.order.manage, sales.return.manage, sales.payment.register); las " +
      "compras, ap.read, purchase.invoice.register o purchase.payment.register. Lo que el rol no " +
      "puede leer no aparece ni se cuenta: la respuesta no lleva total y, sin ningún permiso, la " +
      "lista viene vacía. Sin importes. `q` con menos de 2 caracteres es 422.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: SearchDocumentsQuery },
    responses: {
      200: okJson(busquedaDocumentos, "Coincidencia exacta primero; después, lo más reciente."),
      ...erroresComunes,
    },
  });
  // P-07, F-13, H-11: los reportes y las carteras. Una sola forma de respuesta para todos.
  const tablaDeReporte = registry.register("ReportTable", ReportTable);
  const DESCARGA =
    " Con `format=csv` o `format=xlsx` responde el ARCHIVO (no JSON), con todas las filas y " +
    "formato de Venezuela (coma decimal, fechas día/mes/año, CSV con «;» y BOM); descargar " +
    "exige además report.export. Los importes son texto decimal redondeado al servir; `null` " +
    "no es cero (falta la tasa de hoy, o el rol no ve esa cifra) y trae su motivo. Todo rango " +
    "es de días de Caracas, extremos incluidos.";
  const reportes: {
    path: string;
    summary: string;
    description: string;
    query: z.ZodTypeAny;
  }[] = [
    {
      path: "/v1/reports/sales",
      summary:
        "Reporte de ventas del rango (por día, mes, producto, cliente, forma de pago o vendedor)",
      description:
        "Venta = facturas, recibos y notas de débito emitidos, menos notas de crédito y " +
        "devoluciones. Por forma de pago se sirve lo COBRADO en el rango. Exige treasury.read " +
        "o accounting.read.",
      query: SalesReportQuery,
    },
    {
      path: "/v1/reports/margin",
      summary: "Reporte de margen: ventas menos costo, por producto o período",
      description:
        "Con el diferencial cambiario realizado como línea del resumen; la revaluación va en " +
        "null (sin_dato). Exige treasury.read o accounting.read.",
      query: MarginReportQuery,
    },
    {
      path: "/v1/reports/iva",
      summary: "IVA del período: lo ya calculado en la declaración",
      description:
        "La última corrida de cada período de iva_period_results que toca el rango; no " +
        "recalcula. Exige fiscal_book.read.",
      query: RangeReportQuery,
    },
    {
      path: "/v1/reports/inventory",
      summary: "Inventario valorizado (a hoy) y rotación (en el rango)",
      description:
        "Exige warehouse.read, inventory.move, inventory.adjust, accounting.read o " +
        "treasury.read. El VALOR solo viaja con accounting.read o treasury.read; sin él va en " +
        "null con sin_permiso.",
      query: RangeReportQuery,
    },
    {
      path: "/v1/reports/receivables",
      summary: "«Quién me debe»: la cartera de clientes, con totales y tramos",
      description:
        "Una fila por cliente que debe: nominal por moneda, deuda a la tasa de hoy, vencido y " +
        "tramos de antigüedad (platform.ar_aging, customer_overdue_today). Exige ar.read.",
      query: ReceivablesReportQuery,
    },
    {
      path: "/v1/reports/payables",
      summary: "«Qué debo»: la cartera de proveedores, con monto y vencimiento",
      description:
        "Una fila por proveedor al que se le debe (platform.ap_aging, supplier_debt_today). " +
        "Exige ap.read.",
      query: PayablesReportQuery,
    },
    {
      path: "/v1/reports/cash-closings",
      summary: "Cierres de caja con sus diferencias, por cierre o por cajero",
      description: "Exige treasury.read o cash_register.read.",
      query: CashClosingsReportQuery,
    },
    {
      path: "/v1/reports/igtf",
      summary: "IGTF percibido, por quincena",
      description:
        "Cada quincena que toca el rango, entera, con platform.igtf_period_totals. Exige " +
        "fiscal_book.read.",
      query: RangeReportQuery,
    },
  ];
  for (const r of reportes) {
    registry.registerPath({
      method: "get",
      path: r.path,
      summary: r.summary,
      description: r.description + DESCARGA,
      security: [{ bearerAuth: [] }],
      request: { headers: companyHeader, query: r.query as z.AnyZodObject },
      responses: {
        200: okJson(tablaDeReporte, "La tabla del reporte: columnas, filas, totales y resumen."),
        ...erroresComunes,
      },
    });
  }
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
      headers: idemHeader,
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
      "La persona acepta la general desde el catálogo con fuente (ADR-0073): solo dentro del " +
      "rango del art. 27 (8–16,5 %); el 0 % y lo que caiga fuera se rechazan con 422. Otra tasa " +
      "cierra la vigencia de la anterior y abre otra desde hoy (B-02); la misma tasa no crea " +
      "nada. Completa la reducida, la exenta y la adicional desde el catálogo, con su cita. " +
      "Siempre deja el acta en la auditoría.",
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
    summary: "El PDF del documento: copia de cortesía, papel sobre la forma libre o vista previa",
    description:
      "ADR-0071 §4. Sin `destino`, la COPIA DE CORTESÍA (no es la factura: lo dice). " +
      "`destino=papel` imprime sobre la forma libre y deja en blanco lo que la imprenta " +
      "preimprime (PA 00071 art. 31); `destino=vista` lo sombrea. `copia=1` añade «SIN " +
      "DERECHO A CRÉDITO FISCAL» (13.13), la única leyenda legal. Imprime lo PERSISTIDO: los " +
      "snapshots de emisor y cliente, fecha en ocho dígitos (13.6), «(E)» en líneas exentas, " +
      "exoneradas o no sujetas (13.8), base e IVA por alícuota (13.10-11), ambas monedas con " +
      "tipo de cambio (13.14); la NC y la ND citan su factura, su motivo y la tasa de la factura. " +
      "El recibo y el recibo de devolución no tienen copia fiscal (422).",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: companyHeader,
      query: z.object({
        copia: z.enum(["1"]).optional(),
        destino: z.enum(["cortesia", "papel", "vista"]).optional(),
      }),
    },
    responses: {
      200: { description: "El PDF (application/pdf)." },
      ...erroresComunes,
    },
  });

  // ── El punto de venta (Fase C) ─────────────────────────────────────────────
  const posQuote = registry.register("PosQuoteRequest", PosQuoteRequest);
  const posQuoteResp = registry.register("PosQuoteResponse", PosQuoteResponse);
  const posTender = registry.register("PosTenderRequest", PosTenderRequest);
  const posTenderResp = registry.register("PosTenderResponse", PosTenderResponse);
  registry.registerPath({
    method: "post",
    path: "/v1/pos/tender",
    summary: "Vista previa del cobro: abono, IGTF, vuelto y lo que falta (sin escribir)",
    description:
      "El MISMO cálculo que la venta rápida (ADR-0059): lo tecleado es lo ENTREGADO y, si la " +
      "forma de pago causa IGTF, el IGTF va dentro. Tolerancia de una unidad mínima; el vuelto " +
      "solo en efectivo y redondeado hacia abajo. `offer` devuelve cuánto pedir en cada forma " +
      "para cerrar, IGTF incluido.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: posTender } } },
    },
    responses: {
      200: okJson(posTenderResp, "El cobro previsto."),
      ...erroresComunes,
    },
  });
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
      "no da vuelto. El `Idempotency-Key` es el INTENTO de cobro (ADR-0076), nunca el id de la " +
      "cuenta: reintentar con la misma devuelve LA MISMA venta; la misma llave con otro cuerpo da " +
      "409 IDEMPOTENCY_BODY_MISMATCH. Con `cart_id`, la cuenta queda marcada vendida en la misma " +
      "transacción y un segundo cobro de ella da 409 POS_CART_SOLD (con la venta en `details`); " +
      "una cuenta que armó otra persona la cobra su autor o quien tenga pos.carts.manage (403). " +
      "`cart_version` y `attempt_id` quedan en el acta `pos.cart.sold`. Sin `payments` (o con pagos que no " +
      "alcanzan) la venta queda FIADA y `balance` dice el saldo — solo con cliente " +
      "identificado: una venta de mostrador con saldo se rechaza (422).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: ventaRapida } } },
    },
    responses: {
      201: okJson(ventaRapidaResp, "La venta: documento, cobros, vuelto y saldo."),
      ...erroresComunes,
      409: errorRef(
        "Numeración, regla tributaria, tasa o existencias: lo que impida emitir; POS_CART_SOLD si " +
          "la cuenta ya se cobró; IDEMPOTENCY_BODY_MISMATCH si la llave ya viajó con otro cuerpo.",
      ),
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/pos/change",
    summary: "El vuelto en vivo (permiso sales.payment.register)",
    description:
      "`change = tendered − (total − already_paid)/tasa`, en la moneda con la que pagaron y con " +
      "la tasa del día citada. Negativo significa que falta plata. `already_paid` es lo que ya " +
      "cubre la otra forma en un cobro mixto. Es cálculo de dinero: vive en el servidor.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        total: z.string(),
        currency: z.string(),
        tendered: z.string(),
        tendered_currency: z.string().optional(),
        already_paid: z.string().optional(),
        already_paid_currency: z.string().optional(),
      }),
    },
    responses: { 200: okJson(vueltoResp, "El vuelto calculado."), ...erroresComunes },
  });

  // ── Cuentas abiertas del POS (migración 44) ────────────────────────────────
  const guardarCarrito = registry.register("UpsertPosCartRequest", UpsertPosCartRequest);
  const carrito = registry.register("PosCartResponse", PosCartResponse);
  const carritos = registry.register("ListPosCartsResponse", ListPosCartsResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/pos/carts",
    summary: "Las cuentas abiertas de la caja (permiso sales.invoice.issue)",
    description:
      "La INTENCIÓN de cada venta en armado: productos, cantidades, cliente y nota — nunca " +
      "precios (al retomar se recotiza a la tasa de HOY). Ordenadas por último toque. Cada una " +
      "dice quién la armó, cuándo y en qué caja, y si quien pregunta puede cobrarla (`editable`: " +
      "su autor o pos.carts.manage). Las ya cobradas no salen (ADR-0076).",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(carritos, "Las cuentas abiertas."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/pos/carts/{id}",
    summary: "Guardar una cuenta abierta (crea o pisa; permiso sales.invoice.issue)",
    description:
      "El id lo pone la CAJA: misma clave, mismo carrito — idempotente por naturaleza, sin " +
      "`Idempotency-Key`. Última escritura gana entre su autor y quien tenga pos.carts.manage; " +
      "los demás reciben 403. No reserva mercancía ni congela precios: para eso están el pedido y " +
      "la factura. La cuenta muere al cobrarse (`cart_id` en /v1/pos/sales, misma transacción): " +
      "desde ahí, todo PUT responde 409 POS_CART_SOLD (ADR-0076). Sin cobrar, se purga tras 30 " +
      "días sin tocar.",
    security: [{ bearerAuth: [] }],
    request: {
      params: z.object({ id: z.string().uuid() }),
      headers: companyHeader,
      body: { content: { "application/json": { schema: guardarCarrito } } },
    },
    responses: {
      200: okJson(carrito, "La cuenta guardada."),
      ...erroresComunes,
      409: errorRef("POS_CART_SOLD: esa cuenta ya se cobró."),
    },
  });
  registry.registerPath({
    method: "delete",
    path: "/v1/pos/carts/{id}",
    summary: "Descartar una cuenta abierta (permiso sales.invoice.issue)",
    description:
      "Para la que se abandona SIN venta. Descartar lo ya borrado no es error: responde " +
      "`deleted: false`, igual que una cuenta ya cobrada (no se borra: ADR-0076). Una ajena la " +
      "borra su autor o quien tenga pos.carts.manage (403). El cierre normal es el cobro.",
    security: [{ bearerAuth: [] }],
    request: { params: z.object({ id: z.string().uuid() }), headers: companyHeader },
    responses: {
      200: okJson(z.object({ deleted: z.boolean() }).openapi("DeletePosCartResponse"), "Qué pasó."),
      ...erroresComunes,
    },
  });

  registry.registerPath({
    method: "post",
    path: "/v1/returns",
    summary: "Registrar devolución contra su factura o recibo (permiso sales.return.manage)",
    description:
      "No hay devolución sin documento origen, y nunca por más de lo vendido — sumando las " +
      "devoluciones ya confirmadas de la misma línea (ADR-0061 §4).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearDevolucion } } },
    },
    responses: { 201: okJson(devolucion, "Devolución en borrador."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/customer-credits/{id}/refunds",
    summary: "Reembolsar un saldo a favor desde una caja (permiso sales.refund)",
    description:
      "ADR-0061 §8: el camino del dinero de una venta devuelta. Consume el saldo a favor, saca " +
      "el dinero de la cuenta (en la moneda del saldo) y lo asienta contra la caja real.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: pedirReembolso } } },
    },
    responses: { 201: okJson(reembolso, "El reembolso registrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/returns/{id}/confirm",
    summary:
      "Confirmar devolución: reingreso al lote y costo con que SALIÓ, nota de crédito (factura) o recibo de devolución (recibo), y saldo a favor",
    description:
      "Todo en una transacción (ADR-0061 §5). El reingreso reparte lo devuelto entre las salidas " +
      "de la venta, lote por lote y a su valor — no el costo de hoy ni el cost_snapshot. Un " +
      "recibo se corrige con recibo de devolución (no fiscal, sin IVA, fuera de los libros).",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: idemHeader },
    responses: { 200: okJson(devolucion, "Devolución confirmada."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/returns/{id}/cancel",
    summary: "Cancelar una devolución en BORRADOR (sales.return.manage)",
    description:
      "Un borrador no movió inventario, dinero ni asiento: cancelarlo solo cambia su estado y " +
      "queda en la auditoría. Una devolución confirmada no se cancela (QA 2026-09-15, h. 55).",
    security: [{ bearerAuth: [] }],
    request: { params: idParam, headers: idemHeader },
    responses: {
      200: okJson(
        z.object({ id: z.string().uuid(), status: z.literal("cancelled") }),
        "Borrador cancelado.",
      ),
      ...erroresComunes,
    },
  });

  // ── Las NOTAS (ADR-0051) ───────────────────────────────────────────────────
  const ncDirecta = registry.register(
    "CreateDirectCreditNoteRequest",
    CreateDirectCreditNoteRequest,
  );
  const ncDirectaResp = registry.register("DirectCreditNoteResponse", DirectCreditNoteResponse);
  const ndCrear = registry.register("CreateDebitNoteRequest", CreateDebitNoteRequest);

  registry.registerPath({
    method: "post",
    path: "/v1/credit-notes",
    summary: "Nota de crédito DIRECTA, sin devolución (permiso sales.credit_note.direct)",
    description:
      "Corrige una factura emitida por descuento o error de precio, SIN mover mercancía " +
      "(mercancía que vuelve = devolución). Líneas del origen a su precio original; motivo " +
      "obligatorio con acta. Genera saldo a favor aplicable como forma de cobro. El total " +
      "acreditado acumulado contra la factura no puede exceder su total.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: ncDirecta } } },
    },
    responses: {
      201: okJson(ncDirectaResp, "La NC emitida y su saldo a favor."),
      ...erroresComunes,
      409: errorRef("Sin rango de credit_note, sin régimen, o numeración inválida."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/debit-notes",
    summary: "Nota de débito: el espejo de la factura (permiso sales.invoice.issue)",
    description:
      "Intereses de mora, fletes o diferencias de precio contra una factura emitida. Líneas " +
      "con precio EXPLÍCITO en la moneda del origen; motivo obligatorio con acta; sin kardex. " +
      "ES deuda: entra al saldo del cliente y al aging (ADR-0051). Exige su propio rango de " +
      "numeración con kind debit_note.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: ndCrear } } },
    },
    responses: {
      201: okJson(documento, "La ND emitida."),
      ...erroresComunes,
      409: errorRef("Sin rango de debit_note, sin régimen, o numeración inválida."),
    },
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
    summary: "Rangos de número de control autorizados (fiscal.range.manage o sales.invoice.issue)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(z.array(rango), "Los rangos de la empresa."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-number-ranges",
    summary: "Registrar el talonario de la imprenta (permiso fiscal.range.manage)",
    description:
      "ADR-0071: un talonario por empresa e identificador sirve para factura, NC y ND. Sin los datos de la imprenta (razón social, RIF, providencia y su fecha, fecha de elaboración) responde 422; si pisa otro rango del mismo identificador, 409.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearRango } } },
    },
    responses: { 201: okJson(rango, "Talonario registrado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-number-ranges/{id}/printer",
    summary: "Completar los datos de la imprenta de un talonario anterior (fiscal.range.manage)",
    description:
      "Una sola vez: los datos de la imprenta de un talonario completo no se reescriben (409). Hasta completarlos, emitir con ese talonario responde 409.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: completarImprenta } } },
    },
    responses: { 200: okJson(rango, "Datos de la imprenta completados."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-number-ranges/{id}/printer-correction",
    summary: "Corregir los datos de la imprenta con motivo y acta (fiscal.range.manage)",
    description:
      "ADR-0071 (H3, decidido por criterio; alternativa: solo anular y registrar de nuevo). Permitido siempre: lo emitido lleva impreso lo que la imprenta preimprimió y no cambia. El acta fiscal.range.printer_corrected guarda lo anterior y lo nuevo. El identificador solo cambia si el talonario no emitió nada (409).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: corregirImprenta } } },
    },
    responses: { 200: okJson(rango, "Datos de la imprenta corregidos."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-number-ranges/{id}/cancel",
    summary: "Anular un talonario que no emitió nada, con motivo y acta (fiscal.range.manage)",
    description:
      "ADR-0071 (H3). Solo si el talonario no emitió ningún documento; si emitió, 409 legible. Deja el acta fiscal.range.cancelled.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: anularTalonario } } },
    },
    responses: { 200: okJson(rango, "Talonario anulado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-number-ranges/exhaustion",
    summary:
      "Rangos por agotarse (fiscal.range.manage o sales.invoice.issue): la alerta llega antes de que la caja se pare",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            range_id: z.string().uuid(),
            kind: z.string().nullable(),
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
    path: "/v1/exchange-rates/preview",
    summary: "Vista previa de conversión a la tasa del día del hecho (aritmética del servidor)",
    description:
      "El número que las pantallas enseñan al lado de un monto en la otra moneda: entre el " +
      "ancla (USD) y la funcional, con la tasa vigente del día Caracas y su fuente. El " +
      "cliente tiene prohibido calcular dinero, incluso para previsualizar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        amount: z.string(),
        currency: z.string().optional(),
        date: z.string().optional(),
      }),
    },
    responses: {
      200: okJson(
        z.object({
          rate: z.string(),
          source: z.string(),
          rate_date: z.string(),
          in_functional: z.string(),
          in_anchor: z.string(),
        }),
        "La conversión del día, a 2 decimales (display).",
      ),
      409: errorRef("No hay tasa vigente todavía (EXCHANGE_RATE_MISSING)."),
      422: errorRef("Monto o moneda inválidos."),
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
            created_at: z.string(),
            /** «plataforma» = oficial (BCV, sistema); «propia» = de esta empresa (ADR-0057). */
            scope: z.enum(["plataforma", "propia"]),
          }),
        ),
        "Hasta 60 tasas visibles para la empresa (las de la plataforma y las suyas), de la más reciente hacia atrás; a igual día, la propia primero.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/exchange-rates",
    summary: "RETIRADA: cargar una tasa a mano (siempre 409 RATE_ONLY_FROM_BCV)",
    description:
      "Solo existe la tasa del BCV (ADR-0064 §1): ya no se teclea. La ruta responde el motivo " +
      "a un cliente viejo; el cuerpo se ignora.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: crearTasa } } },
    },
    responses: {
      ...erroresComunes,
      409: errorRef("RATE_ONLY_FROM_BCV: solo existe la tasa del BCV; se trae, no se escribe."),
    },
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
      "UPSTREAM_UNAVAILABLE, y mientras tanto rige la última tasa publicada (ADR-0064 §1).",
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
  const notaRecibidaResp = registry.register(
    "SupplierCreditNoteResponse",
    SupplierCreditNoteResponse,
  );
  const lineasDeFactura = registry.register(
    "SupplierInvoiceLinesResponse",
    SupplierInvoiceLinesResponse,
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
    summary:
      "Listar órdenes de compra, estado DERIVADO de las recepciones (ap.read, purchase.order.manage o purchase.receive)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        status: z.string().optional(),
        supplier_id: z.string().uuid().optional(),
        /** «1» = solo lo que sigue esperando mercancía: la bandeja «Por recibir» (ADR-0066). */
        pending: z.string().optional(),
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: { 200: okJson(listaOrdenes, "Página de órdenes."), ...erroresComunes },
  });
  const cerrarPedido = registry.register("ClosePurchaseOrderRequest", ClosePurchaseOrderRequest);
  registry.registerPath({
    method: "post",
    path: "/v1/purchase-orders/{id}/close",
    summary: "«No va a llegar»: cerrar un pedido con su motivo (purchase.order.manage)",
    description:
      "El pedido sale de «Por recibir» y deja escrito POR QUÉ. Lo recibido a medias no se toca: " +
      "eso ya entró al kardex con su costo. No hay borrado — un pedido que desaparece sin rastro " +
      "es una decisión que nadie puede revisar después (ADR-0066, entrega iii).",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: { content: { "application/json": { schema: cerrarPedido } } },
    },
    responses: {
      200: okJson(ordenCompra, "El pedido, ya cerrado."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/purchase-orders/{id}",
    summary: "Detalle de una orden (ap.read, purchase.order.manage o purchase.receive)",
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
    summary: "Detalle de una recepción con sus gastos aplicados (ap.read o purchase.receive)",
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
    summary:
      "Listar facturas de proveedor con su saldo (ap.read, purchase.invoice.register o purchase.payment.register)",
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
        z.object({
          items: z.array(
            z
              .object({
                // Ola 4: `platform.supplier_invoice_balance` solo responde por `posted` y `paid`.
                // Una factura `draft` o `annulled` llega con el saldo en null, no en "0".
                balance: z.string().nullable(),
              })
              .passthrough(),
          ),
          total: z.number().int(),
        }),
        "Facturas con saldo calculado por el esquema. `balance` es null en `draft` y `annulled`.",
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
      "CONTRATO 2026-10-02 (ADR-0072 §3, API 0.2.0): si la empresa es contribuyente especial en " +
      "la fecha de la factura, la retención de IVA se practica SOLA al registrar (75 % con " +
      "«iva_compras»; 100 % con «iva_retention_full_reason», art. 5), salvo proveedor formal, " +
      "factura sin IVA o «retention_exclusion» marcada con motivo; y se emite el comprobante " +
      "(«retention_voucher_number», AAAAMM + 8). Sin regla vigente, 409 RETENTION_RULE_MISSING. " +
      "«retention_concepts» sigue valiendo para los demás conceptos (N-1).",
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
  const comprobanteRetencion = registry.register(
    "RetentionVoucherResponse",
    RetentionVoucherResponse,
  );
  const idRetencion = z.object({ id: z.string().uuid() });
  registry.registerPath({
    method: "get",
    path: "/v1/retention-exclusions",
    summary: "Exclusiones del art. 3 de la PA SNAT/2025/000054 que se pueden marcar (ADR-0072 §3)",
    description:
      "Con «account_id» (la cuenta de la que sale un gasto con factura) no trae las exclusiones " +
      "que esa cuenta no admite: el servicio público domiciliado (art. 3 num. 8) solo se ofrece " +
      "para una cuenta bancaria (AF4-01). Sin el parámetro, el catálogo entero.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ account_id: z.string().uuid().optional() }),
    },
    responses: {
      200: okJson(
        z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
        "Catálogo de plataforma con norma y artículo.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/retention-vouchers",
    summary:
      "Comprobantes de retención de IVA emitidos (ap.read, purchase.invoice.register o retention.receipt.issue)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        from: z.string().date().optional(),
        to: z.string().date().optional(),
        supplier_id: z.string().uuid().optional(),
      }),
    },
    responses: {
      200: okJson(
        z.object({ items: z.array(z.record(z.string(), z.unknown())) }),
        "Comprobantes con su estado (issued/annulled), vencimiento y entrega.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/retention-vouchers/{id}",
    summary: "Un comprobanteRetencion de retención con sus renglones (ADR-0072 §4)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, params: idRetencion },
    responses: { 200: okJson(comprobanteRetencion, "El comprobanteRetencion."), ...erroresComunes },
  });
  for (const [ruta, resumen] of [
    [
      "/v1/payments/{id}/pdf",
      "Comprobante NO fiscal de un cobro: recibido, aplicado y saldo a favor si pagó de más (F-10)",
    ],
    [
      "/v1/customer-refunds/{id}/pdf",
      "Comprobante NO fiscal del reembolso de un saldo a favor (G-15)",
    ],
  ] as const) {
    registry.registerPath({
      method: "get",
      path: ruta,
      summary: resumen,
      security: [{ bearerAuth: [] }],
      request: { headers: companyHeader, params: idRetencion },
      responses: {
        200: {
          description: "application/pdf",
          content: { "application/pdf": { schema: z.string() } },
        },
        ...erroresComunes,
      },
    });
  }
  registry.registerPath({
    method: "get",
    path: "/v1/retention-vouchers/{id}/pdf",
    summary: "PDF del comprobanteRetencion de retención (PA SNAT/2025/000054 art. 16)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, params: idRetencion },
    responses: {
      200: {
        description: "application/pdf",
        content: { "application/pdf": { schema: z.string() } },
      },
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/retention-vouchers/{id}/delivery",
    summary: "Anotar la entrega del comprobanteRetencion, una vez (retention.receipt.issue)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: idRetencion,
      body: { content: { "application/json": { schema: DeliverRetentionVoucherRequest } } },
    },
    responses: {
      200: okJson(comprobanteRetencion, "El comprobanteRetencion entregado."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/retention-vouchers/{id}/corrections",
    summary:
      "Corregir: emite una versión nueva que reemplaza (y anula) a la anterior (retention.receipt.issue)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: idRetencion,
      body: { content: { "application/json": { schema: CorrectRetentionVoucherRequest } } },
    },
    responses: { 201: okJson(comprobanteRetencion, "La versión nueva."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/retention-vouchers/settings",
    summary: "Uno por operación (omisión) o uno por quincena y proveedor (company.settings.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: SetRetentionVoucherModeRequest } } },
    },
    responses: {
      200: okJson(z.object({ company_id: z.string().uuid(), mode: z.string() }), "El modo."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/purchases/matching",
    summary:
      "Matching de tres vías (ap.read o purchase.invoice.register): orden, recepción y factura",
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
    summary: "Variaciones de costo del período (ap.read o purchase.landed_cost.apply)",
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
    method: "get",
    path: "/v1/supplier-invoices/{id}/lines",
    summary:
      "Las líneas de una factura de proveedor, para corregirla con una nota de crédito (ap.read, purchase.credit_note.register o purchase.invoice.register; expense.register SOLO si la factura es de un gasto). No trae precios ni alícuotas",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, params: z.object({ id: z.string().uuid() }) },
    responses: {
      200: okJson(lineasDeFactura, "La clase de la factura y sus líneas."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/supplier-credit-notes",
    summary:
      "Registrar nota de crédito recibida (purchase.credit_note.register; expense.register si la factura es de un gasto)",
    description:
      "Reduce el saldo de la factura que abona. En una factura de mercancía, `kind` dice si la mercancía volvió " +
      "(`devolucion`: sale del kardex a su costo) o si solo bajó el precio (`rebaja`: se " +
      "revaloriza lo que quede). El IVA de cada línea sale de la alícuota de la línea de factura " +
      "que corrige; un `tax_amount` enviado que difiera más de un céntimo se rechaza. Sin número " +
      "de control se registra igual y queda `document_incomplete`. Lo que pase de lo que se debía " +
      "va a la cuenta de saldos a favor con proveedores (`left_credit_in_favor`), no a cuentas por " +
      "pagar. No ajusta la retención practicada ni su comprobante (`retention_untouched`).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: notaRecibida } } },
    },
    responses: {
      201: okJson(notaRecibidaResp, "Nota registrada y saldo recalculado."),
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
  const vistaPago = registry.register(
    "SupplierPaymentPreviewResponse",
    SupplierPaymentPreviewResponse,
  );
  registry.registerPath({
    method: "post",
    path: "/v1/supplier-payments/preview",
    summary: "Vista previa de un pago a proveedor: cuánto sale, a qué tasa y cuánto cancela (D-02)",
    description:
      "El MISMO caso de uso que `POST /v1/supplier-payments`, deshecho al terminar: no escribe " +
      "nada y no lleva Idempotency-Key. Para el pago cruzado (la cuenta vive en otra moneda que " +
      "la factura) dice cuánto sale de la cuenta en su moneda, la tasa BCV del día con la fecha " +
      "en que se publicó, y cuánto cancela de la factura. Falla con los mismos códigos que el " +
      "pago (sin tasa, sin saldo, por encima del saldo).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: pagoProveedor } } },
    },
    responses: {
      200: okJson(vistaPago, "Lo que el pago registraría."),
      ...erroresComunes,
      409: errorRef("Sin tasa del día, o el saldo de la cuenta no alcanza."),
    },
  });
  const llegada = registry.register("RegisterArrivalRequest", RegisterArrivalRequest);
  const llegadaResp = registry.register("ArrivalResponse", ArrivalResponse);
  registry.registerPath({
    method: "post",
    path: "/v1/arrivals",
    summary: "Llegó mercancía: la ÚNICA puerta por la que entra la mercancía (ADR-0066)",
    description:
      "La persona describe el hecho y el servidor deriva el asiento, en UNA transacción. Sin " +
      "`supplier_id` es mercancía que ya era suya (inventario inicial o aporte, contra aportes " +
      "en inventario). Con proveedor, `invoice` dice el resto: «present» es la compra con " +
      "factura —libro de compras, crédito fiscal o IVA al costo, retención si hay regla—, " +
      "«pending» deja la recepción contra «mercancía recibida por facturar», y «none» es la " +
      "compra SIN soporte fiscal, que entra al costo pagado y queda FUERA del libro. El costo " +
      "de cada línea va por unidad o por el total de la línea, y el otro lo calcula el " +
      "servidor. La fecha está acotada (ADR-0066 §5). Los permisos los comprueba cada pieza: " +
      "inventory.move para el aporte, purchase.receive para recibir, purchase.invoice.register " +
      "para la factura.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: llegada } } },
    },
    responses: {
      201: okJson(llegadaResp, "Qué salida tomó la llegada, con su recepción, factura y pago."),
      ...erroresComunes,
      409: errorRef("Documento duplicado del proveedor, sin tasa, o sin regla de IVA."),
    },
  });
  const vistaLlegada = registry.register("ArrivalPreviewResponse", ArrivalPreviewResponse);
  registry.registerPath({
    method: "post",
    path: "/v1/arrivals/preview",
    summary: "Vista previa de una llegada: base, IVA y total antes de confirmar (D-05)",
    description:
      "El MISMO cálculo que `POST /v1/arrivals`, deshecho al terminar: no escribe nada y no " +
      "lleva Idempotency-Key. El pago del cuerpo se ignora. Con `prices_include_tax` el " +
      "servidor quita el IVA del precio escrito. Falla con los mismos códigos que el registro " +
      "(sin tasa del día, proveedor sin RIF con factura…), para decirlo antes de confirmar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: llegada } } },
    },
    responses: {
      200: okJson(vistaLlegada, "Lo que se registraría: base, IVA y total del documento."),
      ...erroresComunes,
      409: errorRef("Sin tasa del día, o sin regla de IVA."),
    },
  });
  const impactoLlegada = registry.register("ArrivalImpactResponse", ArrivalImpactResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/arrivals/impact",
    summary: "Lo que se vendió desde una fecha (antes de fechar una llegada hacia atrás)",
    description:
      "El promedio móvil se calcula en el ORDEN en que entran los movimientos: una llegada " +
      "fechada hacia atrás NO corrige el costo de lo que se vendió entre medias. La pantalla " +
      "enseña esta cuenta antes de confirmar, porque ningún invariante la ve — todos comparan " +
      "sumas, y esto es un problema de orden (ADR-0066 §5).",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string(), product_ids: z.string().optional() }),
    },
    responses: {
      200: okJson(impactoLlegada, "Unidades salidas por producto desde esa fecha."),
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
    summary: "Comprobantes de retención emitidos (paginado; total en X-Total-Count)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({
        page: z.coerce.number().int().min(1).optional(),
        per_page: z.coerce.number().int().min(1).max(200).optional(),
      }),
    },
    responses: {
      200: okJson(z.array(comprobante), "Una página de comprobantes de la empresa."),
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
    summary: "Plan de cuentas de la empresa, en orden de árbol (permiso accounting.read)",
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
    summary: "Plantillas GLOBALES de plan de cuentas (accounting.read; VALIDAR-CONTABLE)",
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
    summary: "Qué cuenta cumple cada PAPEL contable, y cuáles faltan (accounting.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            purpose: z.string(),
            name: z.string(),
            description: z.string(),
            /** No null: la cuenta NO se asigna aquí, la resuelve ese origen (ADR-0060). */
            resolved_by: z.string().nullable(),
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
        /** El asiento DE un documento concreto (con source_kind). */
        source_id: z.string().uuid().optional(),
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
    method: "post",
    path: "/v1/journal-entries/{id}/discard",
    summary: "Descartar un BORRADOR (permiso accounting.entry.create)",
    description:
      "K-06, ADR-0069: el borrador pasa a `discarded` con rastro en audit_events. No se borra. " +
      "Un asiento posteado NO se descarta nunca (regla 2): se reversa.",
    security: [{ bearerAuth: [] }],
    request: {
      params: idParam,
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: registry.register("DiscardJournalEntryRequest", DiscardJournalEntryRequest),
          },
        },
      },
    },
    responses: { 200: okJson(asiento, "Borrador descartado."), ...erroresComunes },
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
    summary: "Períodos contables, con lo que impide cerrarlos (permiso accounting.read)",
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
    path: "/v1/journal-template-presets",
    summary: "Presets de plantillas de asiento disponibles (catálogo global)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(
        z.array(
          z.object({
            code: z.string(),
            name: z.string(),
            description: z.string().nullable().optional(),
            legal_source: z.string().nullable().optional(),
            entry_count: z.number().int(),
          }),
        ),
        "Los presets.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/journal-templates/import-preset",
    summary: "Importar un preset de plantillas de asiento (permiso accounting.template.manage)",
    description:
      "Idempotente: suma lo que falta y no duplica lo que ya está. Es lo que hace que una venta " +
      "no caiga a la cola para siempre después de importar el plan.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: z.object({ company_id: z.string().uuid(), preset_code: z.string() }).strict(),
          },
        },
      },
    },
    responses: {
      201: okJson(
        z.object({ imported: z.number().int(), lines: z.number().int() }),
        "Plantillas importadas.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/accounting/pending/process",
    summary: "Reprocesar la cola de contabilización pendiente (permiso accounting.entry.post)",
    description:
      "Recorre los pendientes y genera el asiento de cada uno con la plantilla vigente a su " +
      "fecha; los que siguen sin plantilla se quedan en cola con su motivo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: {
        content: {
          "application/json": {
            schema: z.object({ limit: z.number().int().min(1).max(500).optional() }).strict(),
          },
        },
      },
    },
    responses: {
      200: okJson(
        z.object({
          revisados: z.number().int(),
          contabilizados: z.number().int(),
          pendientes: z.number().int(),
          primer_motivo: z.string().nullable().optional(),
        }),
        "Resultado del reproceso.",
      ),
      ...erroresComunes,
    },
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
  const pedirResumen = registry.register(
    "ExportSalesBookSummaryRequest",
    ExportSalesBookSummaryRequest,
  );
  const resumenExportado = registry.register(
    "ExportSalesBookSummaryResponse",
    ExportSalesBookSummaryResponse,
  );
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
    method: "post",
    path: "/v1/fiscal-books/runs/{id}/summary-art72",
    summary:
      "El resumen del art. 72 del RLIVA de una generación del libro de ventas (permiso fiscal_book.export)",
    description:
      "Devuelve `resumen-art72.csv` de una generación ya exportada del libro de ventas (H6, " +
      "ADR-0073). No crea otra generación ni cambia el hash firmado; si el libro cambió desde " +
      "entonces, 422 y hay que volver a exportar.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: pedirResumen } } },
    },
    responses: {
      201: okJson(resumenExportado, "El resumen serializado y la generación a la que pertenece."),
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

  // ── Declaraciones de IVA (migración 46) ────────────────────────────────────
  const retencionSoportada = registry.register(
    "RegisterSupportedRetentionRequest",
    RegisterSupportedRetentionRequest,
  );
  const retencionSoportadaHecha = registry.register(
    "RegisterSupportedRetentionResponse",
    RegisterSupportedRetentionResponse,
  );
  const retencionesSoportadas = registry.register(
    "ListSupportedRetentionsResponse",
    ListSupportedRetentionsResponse,
  );
  const generarPeriodoIva = registry.register("GenerateIvaPeriodRequest", GenerateIvaPeriodRequest);
  const periodoIva = registry.register("IvaPeriodResultResponse", IvaPeriodResultResponse);
  const periodosIva = registry.register(
    "ListIvaPeriodResultsResponse",
    ListIvaPeriodResultsResponse,
  );
  const cargarCalendario = registry.register(
    "LoadFiscalDeadlinesRequest",
    LoadFiscalDeadlinesRequest,
  );
  const calendario = registry.register("ListFiscalDeadlinesResponse", ListFiscalDeadlinesResponse);
  const periodoOpcionalQuery = z.object({ from: z.string().optional(), to: z.string().optional() });

  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-declarations/supported-retentions",
    summary:
      "Registrar una retención soportada y abonar la factura (permiso sales.payment.register)",
    description:
      "El comprobante que el cliente-agente nos entregó, TRANSCRITO, y en el mismo acto el abono " +
      "de la factura afectada con el instrumento `retencion_iva` — sin cuenta de efectivo, con " +
      "evento `ar.retention_applied` y su asiento (Dr IVA retenido por cobrar / Cr cuentas por " +
      "cobrar). El abono es EXACTAMENTE el monto retenido: un comprobante no es un monedero.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: retencionSoportada } } },
    },
    responses: {
      201: okJson(retencionSoportadaHecha, "El comprobante y su abono."),
      409: errorRef("El comprobante ya está registrado (mismo agente, mismo número)."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-declarations/supported-retentions",
    summary: "Las retenciones soportadas del período (permiso fiscal_book.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: periodoOpcionalQuery },
    responses: { 200: okJson(retencionesSoportadas, "Los comprobantes."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/fiscal-declarations/iva-periods",
    summary: "Generar el resultado de un período de IVA (permiso fiscal_book.export)",
    description:
      "Calcula débitos, créditos (con prorrata global v1 si hubo ventas sin impuesto), " +
      "retenciones soportadas y el arrastre, y lo persiste como fila insert-only con hash " +
      "(la sustitutiva es OTRA generación). El excedente anterior viene ENCADENADO de la última " +
      "generación del período contiguo: si hay historia previa sin generar responde 422 pidiendo " +
      "generarla primero — los períodos sin actividad también se generan, en cero. NADA de esto " +
      "es una declaración oficial: es la planilla demostrativa con la que se llena el portal.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: generarPeriodoIva } } },
    },
    responses: { 201: okJson(periodoIva, "El resultado del período."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-declarations/iva-periods",
    summary: "Las generaciones de períodos de IVA (permiso fiscal_book.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: periodoOpcionalQuery },
    responses: { 200: okJson(periodosIva, "Las generaciones."), ...erroresComunes },
  });
  const propuestaPeriodo = registry.register(
    "IvaPeriodProposalResponse",
    IvaPeriodProposalResponse,
  );
  const calendarioProvidencia = registry.register("TaxCalendarResponse", TaxCalendarResponse);
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-declarations/iva-periods/proposal",
    summary: "El período de IVA que corresponde declarar (permiso fiscal_book.read)",
    description:
      "L-04 (ADR-0072 §7): según el tipo vigente, la última QUINCENA cerrada para el contribuyente " +
      "especial (PA SNAT/2025/000091) o el último MES cerrado para el ordinario, con el vencimiento " +
      "por terminal del RIF cuando la celda del calendario está ofrecida. La pantalla lo muestra; " +
      "no calcula la quincena.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(propuestaPeriodo, "La propuesta."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-declarations/calendar",
    summary:
      "El calendario de la providencia de especiales para mi terminal (permiso fiscal_book.read)",
    description:
      "L-09 (ADR-0072 §8): las fechas sembradas de la PA SNAT/2025/000091 para el terminal del RIF " +
      "de la empresa, filtradas por fecha de VENCIMIENTO (sin from/to: el año en curso). Solo las " +
      "celdas ofrecidas; las pendientes de cotejo con la Gaceta se cuentan en pending_review. Vacío " +
      "si la empresa no es especial.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: periodoOpcionalQuery },
    responses: { 200: okJson(calendarioProvidencia, "El calendario."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/fiscal-declarations/deadlines",
    summary: "Cargar el calendario de vencimientos (permiso company.settings.manage)",
    description:
      "Las fechas por dígito de RIF de la providencia vigente NO están en el repositorio y no se " +
      "inventan: las carga quien las leyó, con la cita. Reemplazo por (obligación, período): " +
      "cargar dos veces la misma quincena corrige, no duplica.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: cargarCalendario } } },
    },
    responses: { 200: okJson(calendario, "El calendario cargado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/fiscal-declarations/deadlines",
    summary: "Los vencimientos cargados (permiso fiscal_book.read)",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader, query: periodoOpcionalQuery },
    responses: { 200: okJson(calendario, "Los vencimientos."), ...erroresComunes },
  });

  // ── IGTF (migración 46) ────────────────────────────────────────────────────
  const activarIgtf = registry.register("EnableIgtfRequest", EnableIgtfRequest);
  const instrumentoIgtfReq = registry.register(
    "SetIgtfInstrumentRequest",
    SetIgtfInstrumentRequest,
  );
  const instrumentoIgtf = registry.register("IgtfInstrumentResponse", IgtfInstrumentResponse);
  const estadoIgtf = registry.register("IgtfStatusResponse", IgtfStatusResponse);
  const clasificacionFiscal = registry.register(
    "SetCompanyTaxpayerTypeRequest",
    SetCompanyTaxpayerTypeRequest,
  );
  const percepcionesIgtf = registry.register(
    "ListIgtfPerceptionsResponse",
    ListIgtfPerceptionsResponse,
  );
  const avisoIgtf = registry.register("PosIgtfPreviewResponse", PosIgtfPreviewResponse);

  registry.registerPath({
    method: "get",
    path: "/v1/igtf/status",
    summary: "Estado de la percepción de IGTF (permiso sales.payment.register)",
    description:
      "Si la empresa la activó, la regla nacional vigente y qué instrumento causa. La caja lo " +
      "lee para avisar; configurarlo es otro permiso.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(estadoIgtf, "El estado."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/igtf/enable",
    summary: "Activar la percepción de IGTF con acta (permiso company.settings.manage)",
    description:
      "Solo una empresa clasificada `especial` (PA SNAT/2022/000013: SPE como agentes de " +
      "percepción). Siembra el catálogo de instrumentos con un default conservador — las " +
      "divisas obvias causan; `otro` NO (puede ser un pago en bolívares con otro nombre). " +
      "Desde la activación, cada pago en divisa cuyo instrumento causa percibe el 3 % en el " +
      "servidor, dentro del cobro.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: activarIgtf } } },
    },
    responses: { 201: okJson(estadoIgtf, "Activada, con su catálogo."), ...erroresComunes },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/igtf/instruments",
    summary: "Editar qué instrumento causa IGTF (permiso company.settings.manage)",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: instrumentoIgtfReq } } },
    },
    responses: { 200: okJson(instrumentoIgtf, "El instrumento, como quedó."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/igtf/perceptions",
    summary: "Las percepciones del período, con el total a enterar (permiso fiscal_book.read)",
    description:
      "Una fila por pago que causó. `total_functional` suma SOLO lo percibido: lo pendiente de " +
      "reintegro (facturas anuladas después de percibir) se lista aparte y no se entera como " +
      "si se debiera.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ from: z.string().optional(), to: z.string().optional() }),
    },
    responses: { 200: okJson(percepcionesIgtf, "Las percepciones."), ...erroresComunes },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/companies/taxpayer-type",
    summary: "Tipo de contribuyente vigente hoy y su historia (ADR-0072 §1)",
    description:
      "`current` es null cuando la empresa tiene RIF y no ha declarado tipo: no factura hasta " +
      "declararlo (TAXPAYER_TYPE_REQUIRED). Nunca «ordinario por omisión».",
    security: [{ bearerAuth: [] }],
    responses: {
      200: okJson(
        registry.register("CompanyTaxpayerTypeResponse", CompanyTaxpayerTypeResponse),
        "El tipo vigente y la historia append-only.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "put",
    path: "/v1/companies/taxpayer-type",
    summary: "Declara el tipo de contribuyente de la empresa (permiso company.settings.manage)",
    description:
      "Abre una VIGENCIA nueva con acta (ADR-0072 §1): el especial exige la fecha de " +
      "notificación de la providencia y rige desde ella salvo `effective_from`. Si hoy deja de " +
      "ser `especial` con el IGTF activo, la percepción se apaga en el mismo acto.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: clasificacionFiscal } } },
    },
    responses: {
      200: okJson(
        registry.register("SetCompanyTaxpayerTypeResponse", SetCompanyTaxpayerTypeResponse),
        "La declaración, como quedó.",
      ),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/pos/igtf",
    summary: "El «+ IGTF 3 % = X» en vivo, antes de confirmar (permiso sales.payment.register)",
    description:
      "Familia del vuelto: puro cálculo del servidor con las MISMAS condiciones que aplicará " +
      "el cobro. `applies: false` = este pago no causaría.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      query: z.object({ amount: z.string(), currency: z.string(), instrument: z.string() }),
    },
    responses: { 200: okJson(avisoIgtf, "El aviso."), ...erroresComunes },
  });

  // ── Tesorería (Fase C, migraciones 29–31) ──────────────────────────────────
  const cuentaTesoreria = registry.register("CompanyAccountResponse", CompanyAccountResponse);
  const cuentasTesoreria = registry.register(
    "ListCompanyAccountsResponse",
    ListCompanyAccountsResponse,
  );
  const cuentasCandidatas = registry.register(
    "ListCandidateAccountsResponse",
    ListCandidateAccountsResponse,
  );
  const huecosDeCaida = registry.register(
    "ListMoneyLandingGapsResponse",
    ListMoneyLandingGapsResponse,
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
  registry.register("DailyRateResponse", DailyRateResponse);

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
    method: "get",
    path: "/v1/treasury/accounts/candidates",
    summary: "De qué cuentas puede salir el dinero de este instrumento (ADR-0067 §1)",
    description:
      "Las cuentas PROPIAS y activas de la familia del instrumento, en la moneda del pago, en el " +
      "MISMO orden en que el servidor las resolvería si no se mandara ninguna (ADR-0062 §1): la " +
      "primera es la que caería por omisión. Existe para que la pantalla PREGUNTE de qué cuenta " +
      "sale el dinero en vez de dejar que el servidor lo adivine cuando hay más de una; con dos " +
      "bancos, «la más antigua» no es una regla de negocio, es un desempate.\n\n" +
      "**No devuelve saldos**, y es a propósito: elegir la cuenta no es ver el dinero (ADR-0048). " +
      "`fixed_by_method` trae la cuenta que fija una forma de pago configurada — cuando la hay, " +
      "no hay nada que preguntar.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: {
      200: okJson(cuentasCandidatas, "Las candidatas de cada instrumento, en orden de resolución."),
      ...erroresComunes,
    },
  });
  registry.registerPath({
    method: "get",
    path: "/v1/treasury/landing-gaps",
    summary: "Dónde cayó el dinero que nadie eligió — INFORME, no invariante (ADR-0067 §4)",
    description:
      "Cobros, pagos a proveedor y gastos que cayeron en una cuenta de SISTEMA («Sin asignar») o " +
      "en una cuenta cuya familia no corresponde al instrumento —efectivo salido de un banco, un " +
      "pago móvil salido de la caja física—.\n\n" +
      "**Su respuesta correcta NO es cero**: «Sin asignar» es legítima mientras el negocio no " +
      "tenga una cuenta de esa familia. Nada se reescribe aquí; lo que haya que mover lo mueve " +
      "una persona con la transferencia entre cuentas (ADR-0062 §3).",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(huecosDeCaida, "Las filas del informe."), ...erroresComunes },
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
      "CON `invoice` (H-09) el gasto es una compra de servicio: se registra como factura de " +
      "proveedor (libro de compras, crédito fiscal, retención del agente con su comprobante) y " +
      "se paga su saldo desde la cuenta; el importe NO se manda, lo calcula el servidor. SIN " +
      "`invoice`, el gasto llano: " +
      "directo si el mapeo del contador resuelve, a la cola de ADR-0042 si no. El importe va en " +
      "la MONEDA de la cuenta; la conversión a funcional usa la tasa vigente con su fuente.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: registrarGasto } } },
    },
    responses: { 201: okJson(gasto, "El gasto registrado."), ...erroresComunes },
  });
  const vistaGasto = registry.register("ExpensePreviewResponse", ExpensePreviewResponse);
  registry.registerPath({
    method: "post",
    path: "/v1/expenses/preview",
    summary: "Vista previa de un gasto con factura fiscal: bases, IVA, retención y total (H-09)",
    description:
      "El MISMO registro de la factura que `POST /v1/expenses` con `invoice`, deshecho al " +
      "terminar: no escribe nada y no lleva Idempotency-Key. Devuelve la base y el IVA por " +
      "categoría tributaria, el total, lo retenido (en moneda funcional) y lo que saldría de la " +
      "cuenta. El pago no se ensaya: el saldo de la cuenta se pregunta al confirmar. Sin " +
      "`invoice` responde 422: un gasto llano no tiene nada que calcular.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: companyHeader,
      body: { content: { "application/json": { schema: registrarGasto } } },
    },
    responses: {
      200: okJson(vistaGasto, "Lo que el gasto con factura registraría."),
      ...erroresComunes,
      409: errorRef("Sin tasa del día, sin regla de IVA o sin regla de retención."),
    },
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
  // H-07: el gasto que se repite. «Registrar ahora» es POST /v1/expenses con
  // `recurring_expense_id` y `recurring_due_on`: la misma puerta que un gasto a mano.
  const gastosRecurrentes = registry.register(
    "ListRecurringExpensesResponse",
    ListRecurringExpensesResponse,
  );
  const gastoRecurrente = registry.register("RecurringExpenseResponse", RecurringExpenseResponse);
  const omitirGasto = registry.register("SkipRecurringExpenseRequest", SkipRecurringExpenseRequest);
  const dejarGasto = registry.register("StopRecurringExpenseRequest", StopRecurringExpenseRequest);
  registry.registerPath({
    method: "get",
    path: "/v1/recurring-expenses",
    summary: "Los gastos que se repiten y cuáles tocan (permiso expense.read)",
    description:
      "Los recordatorios vivos de la empresa. `is_due` lo decide el servidor al leer: el día " +
      "calendario de Caracas contra `next_due_on`, día contra día. No hay tarea programada. " +
      "«Registrar ahora» es `POST /v1/expenses` con `recurring_expense_id` y `recurring_due_on`.",
    security: [{ bearerAuth: [] }],
    request: { headers: companyHeader },
    responses: { 200: okJson(gastosRecurrentes, "Los recordatorios."), ...erroresComunes },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/recurring-expenses/{id}/skip",
    summary: "Omitir esta vez un gasto que se repite (permiso expense.register)",
    description:
      "El período `due_on` queda atendido sin gasto y el aviso pasa al siguiente. Si `due_on` " +
      "ya no es el período que toca, 409 CONFLICT y no cambia nada.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: omitirGasto } } },
    },
    responses: {
      200: okJson(gastoRecurrente, "El recordatorio, con su próximo día."),
      ...erroresComunes,
      409: errorRef("El período ya se atendió, o el recordatorio ya no se paga."),
    },
  });
  registry.registerPath({
    method: "post",
    path: "/v1/recurring-expenses/{id}/stop",
    summary: "Dejar de avisar de un gasto que ya no se paga (permiso expense.register)",
    description:
      "El recordatorio deja de avisar. Los gastos ya registrados no se tocan. Repetirlo no es " +
      "un error.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      params: z.object({ id: z.string().uuid() }),
      body: { content: { "application/json": { schema: dejarGasto } } },
    },
    responses: { 200: okJson(gastoRecurrente, "El recordatorio, detenido."), ...erroresComunes },
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
    summary: "RETIRADA: «la tasa sigue igual» (siempre 409 RATE_ONLY_FROM_BCV)",
    description:
      "Solo existe la tasa del BCV (ADR-0064 §1): un día sin publicación rige la última tasa " +
      "publicada, sin copiarla. La ruta responde el motivo a un cliente viejo.",
    security: [{ bearerAuth: [] }],
    request: {
      headers: idemHeader,
      body: { content: { "application/json": { schema: confirmarTasa } } },
    },
    responses: {
      ...erroresComunes,
      409: errorRef("RATE_ONLY_FROM_BCV: la tasa ya no se confirma a mano."),
    },
  });

  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: "3.0.3",
    info: {
      title: "Ladino API",
      // 0.2.0 (2026-10-02, ADR-0072 §3-§4): retención de IVA automática del agente y comprobantes.
      version: "0.2.0",
      description:
        "API administrativa, contable y fiscal. Errores: docs/04_PLATFORM/ERROR_CATALOG.md.",
    },
    servers: [{ url: "/" }],
  });
}
