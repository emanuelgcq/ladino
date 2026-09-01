/**
 * @ladino/domain — Casos de uso administrativos transaccionales.
 *
 * Cada caso de uso recibe la transacción YA ABIERTA (UnitOfWork de @ladino/db,
 * que fijó el GUC de procedencia) y devuelve Result. No abre transacciones, no
 * commitea, no conoce HTTP. El patrón de diez pasos, con su plantilla de
 * referencia, está en create-company.ts.
 */
export { createCompany, RULES_VERSION, type CreateCompanyError } from "./create-company.js";
export { tenantVisible } from "./tenant-visibility.js";
export { companyScope, type CompanyScopeError } from "./company-scope.js";
export {
  createProduct,
  createProductSimple,
  updateProduct,
  setProductTaxCategory,
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
  annulInvoice,
  registerPayment,
  createReturn,
  confirmReturn,
  quotePos,
  quickSale,
  type SalesError,
} from "./sales.js";
export {
  createSupplier,
  createPurchaseOrder,
  receiveGoods,
  registerSupplierInvoice,
  applyLandedCost,
  registerSupplierCreditNote,
  registerSupplierPayment,
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
