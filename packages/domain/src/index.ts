/**
 * @ladino/domain — Casos de uso administrativos transaccionales.
 *
 * Cada caso de uso recibe la transacción YA ABIERTA (UnitOfWork de @ladino/db,
 * que fijó el GUC de procedencia) y devuelve Result. No abre transacciones, no
 * commitea, no conoce HTTP. El patrón de diez pasos, con su plantilla de
 * referencia, está en create-company.ts.
 */
export {
  guardarTasaOficial,
  mensajeFaltaTasa,
  explicarFaltaDeTasa,
  type TasaOficialCapturada,
  type FilaTasaOficial,
} from "./tasa-oficial.js";
export { cargarReglaDeRetencion, type ReglaDeRetencion } from "./retention-rules.js";
export { asignarRegimenFiscal, aceptarIvaGeneral, type FiscalSetupError } from "./fiscal-setup.js";
export {
  createCompany,
  setCompanyFiscalAddress,
  RULES_VERSION,
  type CreateCompanyError,
  type SetFiscalAddressError,
} from "./create-company.js";
export { tenantVisible } from "./tenant-visibility.js";
export { companyScope, type CompanyScopeError } from "./company-scope.js";
export {
  createProduct,
  createProductSimple,
  updateProduct,
  setProductTaxCategory,
  setProductImage,
  autorizarImagenProducto,
  type ProductError,
} from "./products.js";
export {
  leerNumeroDeclarado,
  interpretarFilasProductos,
  importarFila,
  anotarCodigosExistentes,
  guardarCostoReferencia,
  SIN_PERMISO_DE_PRECIO,
  crearTrabajoImportacion,
  leerTrabajoImportacion,
  procesarFilaDeTrabajo,
  procesarTrabajoImportacion,
  MAX_FILAS_IMPORTACION,
  type FilaLista,
  type ProductImportError,
} from "./product-import.js";
export { createPriceList, setPrice, type PricingError } from "./pricing.js";
export {
  receiveStock,
  totalDeEntrada,
  unitarioDeEntrada,
  issueStock,
  countStock,
  issueStockBatch,
  adjustStock,
  transferStock,
  type InventoryError,
  type IssueStockInput,
  type ReceiveStockInput,
  type AdjustStockInput,
  revalueStock,
} from "./inventory.js";
export { consumeRecipe, type RecipeError } from "./recipes.js";
// ADR-0066: la ÚNICA puerta por la que la mercancía entra al negocio.
export {
  registerArrival,
  previewArrival,
  ventasIntermedias,
  DIAS_HACIA_ATRAS,
  type ArrivalError,
} from "./arrivals.js";
export {
  createCustomer,
  updateCustomer,
  setCustomerTaxId,
  setCustomerBlocked,
  setCustomerCreditLimit,
  setCustomerTaxpayerType,
  type CustomerError,
} from "./customers.js";
export {
  customerStatement,
  customerOverdue,
  type CustomerStatement,
  type CustomerOverdue,
} from "./customer-statement.js";
export {
  createQuote,
  createOrder,
  confirmOrder,
  createInvoice,
  createReceipt,
  annulInvoice,
  annulmentStatus,
  refundCustomerCredit,
  registerPayment,
  createReturn,
  confirmReturn,
  cancelReturn,
  quotePos,
  quickSale,
  previsualizarCobro,
  pasoDeCobro,
  percibirIgtf,
  avisoIgtf,
  igtfQueSePide,
  type SalesError,
} from "./sales.js";
export {
  registrarTalonario,
  completarImprenta,
  serieDelTalonario,
  corregirImprenta,
  anularTalonario,
  bloquearTalonario,
  TALONARIO_COLUMNS,
  type TalonarioError,
} from "./talonario.js";
export {
  registerContingencyRange,
  registerContingencyInvoice,
  closeContingency,
  type ContingencyError,
} from "./contingency.js";
export {
  createSupplier,
  createPurchaseOrder,
  receiveGoods,
  registerSupplierInvoice,
  applyLandedCost,
  registerSupplierCreditNote,
  registerSupplierPayment,
  registerInvoicedExpense,
  previewInvoicedExpense,
  retentionExclusionsNotOfferedFor,
  previewSupplierPayment,
  simplePurchase,
  closePurchaseOrder,
  type PurchaseError,
} from "./purchases.js";
export {
  correctRetentionVoucher,
  deliverRetentionVoucher,
  setRetentionVoucherMode,
  leerComprobante,
  type RetentionVoucherError,
} from "./retention-vouchers.js";
export {
  createAccount,
  updateAccount,
  deactivateAccount,
  importChartTemplate,
  importJournalTemplates,
  setAccountPurpose,
  createManualJournalEntry,
  postJournalEntry,
  reverseJournalEntry,
  discardJournalEntry,
  closeFiscalPeriod,
  reopenFiscalPeriod,
  executeYearEndClose,
  type AccountingError,
} from "./accounting.js";
export {
  reprocessPendingJournals,
  type BackfillResultado,
  type BackfillError,
} from "./journal-backfill.js";
export {
  generateJournalFromDocument,
  type GenerationOutcome,
  type JournalGenerationError,
} from "./journal-generator.js";
export {
  listWarehouses,
  createWarehouse,
  updateWarehouse,
  type WarehouseError,
} from "./warehouses.js";
export {
  getCompanySettings,
  setCompanySettings,
  type CompanySettings,
  type SettingsError,
} from "./company-settings.js";
export {
  listCompanyAccounts,
  listCandidateAccounts,
  listMoneyLandingGaps,
  previsualizarConversion,
  createCompanyAccount,
  updateCompanyAccount,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  registerExpense,
  transferBetweenAccounts,
  exigeSaldo,
  closeCashRegister,
  resolverCuentaEfectivo,
  repairTreasurySubaccounts,
  SYSTEM_POSTER_ID,
  type TreasurySubaccountsRepair,
  type TreasuryError,
} from "./treasury.js";
export {
  readFiscalBook,
  exportFiscalBook,
  exportSalesBookSummary,
  type ResumenExportado,
  BOOK_GENERATOR_VERSION,
  type LibroLeido,
  type ExportacionHecha,
  type FiscalBookError,
} from "./fiscal-books.js";
export {
  registerSupportedRetention,
  generateIvaPeriod,
  loadFiscalDeadlines,
  proposeIvaPeriod,
  listTaxCalendar,
  IVA_PERIOD_GENERATOR_VERSION,
  type DeclarationsError,
  type IvaPeriodProposal,
  type TaxCalendarEntry,
} from "./declarations.js";
export {
  enableIgtf,
  setIgtfInstrument,
  setCompanyTaxpayerType,
  readIgtfStatus,
  type IgtfError,
} from "./igtf.js";
export {
  tipoVigente,
  exigeTipoParaFacturar,
  readCompanyTaxpayerType,
  type TaxpayerTypeRequiredError,
} from "./tipo-contribuyente.js";
export { onboardBusiness, type OnboardingError } from "./onboarding.js";
export { listPosCarts, upsertPosCart, deletePosCart, type PosCartError } from "./pos-carts.js";
export { createDirectCreditNote, createDebitNote } from "./sales.js";
// Las unidades mínimas de una moneda viven en @ladino/money (ADR-0063): se reexporta para que
// la API no tenga que importar dos paquetes por una función de tres líneas.
export { minorUnitsOf } from "@ladino/money";
export {
  updateCompanyProfile,
  setCompanyTaxId,
  correctCompanyTaxId,
  setCompanyLogo,
  autorizarLogo,
  logosPurgables,
  getMyProfile,
  setMyProfile,
  type CompanyProfileError,
} from "./company-profile.js";
export {
  listMembers,
  addMember,
  removeAssignment,
  setMemberStatus,
  createInvitation,
  previewInvitation,
  acceptInvitation,
  myLostAccess,
  type MembersError,
} from "./members.js";
export { diaNegocio, ZONA_NEGOCIO } from "./dia-negocio.js";
export {
  modoDeVenta,
  exigeEmpresaQueFactura,
  exigeEmpresaConRif,
  avisoYaFactura,
} from "./modo-venta.js";
export { repairCents, type CentRegularization } from "./cent-regularization.js";
export { repairOverdraftClosings, type OverdraftClosingsRepair } from "./overdraft-closings.js";
export {
  reversePayment,
  reverseSupportedRetention,
  type PaymentReversalError,
  type PaymentReversalResult,
  type ReversePaymentInput,
} from "./payment-reversals.js";
export {
  repairTreasuryCurrency,
  type TreasuryCurrencyRegularization,
} from "./treasury-currency.js";
