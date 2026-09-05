/**
 * @ladino/domain — Casos de uso administrativos transaccionales.
 *
 * Cada caso de uso recibe la transacción YA ABIERTA (UnitOfWork de @ladino/db,
 * que fijó el GUC de procedencia) y devuelve Result. No abre transacciones, no
 * commitea, no conoce HTTP. El patrón de diez pasos, con su plantilla de
 * referencia, está en create-company.ts.
 */
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
  type ProductError,
} from "./products.js";
export { createPriceList, setPrice, type PricingError } from "./pricing.js";
export {
  receiveStock,
  issueStock,
  adjustStock,
  transferStock,
  type InventoryError,
  type IssueStockInput,
  type ReceiveStockInput,
  type AdjustStockInput,
  revalueStock,
} from "./inventory.js";
export { consumeRecipe, type RecipeError } from "./recipes.js";
export {
  createCustomer,
  updateCustomer,
  setCustomerTaxId,
  setCustomerBlocked,
  type CustomerError,
} from "./customers.js";
export {
  createQuote,
  createOrder,
  confirmOrder,
  createInvoice,
  createReceipt,
  annulInvoice,
  registerPayment,
  createReturn,
  confirmReturn,
  quotePos,
  quickSale,
  type SalesError,
} from "./sales.js";
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
  simplePurchase,
  type PurchaseError,
} from "./purchases.js";
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
  closeFiscalPeriod,
  reopenFiscalPeriod,
  executeYearEndClose,
  type AccountingError,
} from "./accounting.js";
export {
  generateJournalFromDocument,
  type GenerationOutcome,
  type JournalGenerationError,
} from "./journal-generator.js";
export {
  getCompanySettings,
  setCompanySettings,
  type CompanySettings,
  type SettingsError,
} from "./company-settings.js";
export {
  listCompanyAccounts,
  createCompanyAccount,
  updateCompanyAccount,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  registerExpense,
  closeCashRegister,
  keepDailyRate,
  resolverCuentaEfectivo,
  type TreasuryError,
} from "./treasury.js";
export {
  readFiscalBook,
  exportFiscalBook,
  BOOK_GENERATOR_VERSION,
  type LibroLeido,
  type ExportacionHecha,
  type FiscalBookError,
} from "./fiscal-books.js";
export { onboardBusiness, type OnboardingError } from "./onboarding.js";
export {
  listMembers,
  addMember,
  removeAssignment,
  setMemberStatus,
  type MembersError,
} from "./members.js";
