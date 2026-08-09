/**
 * @ladino/money — aritmética monetaria de Ladino. Paquete puro (ADR-0013, ADR-0020).
 *
 * **Esta entrada NO puede ser importada por `apps/web`, `apps/mobile` ni `packages/ui`.**
 * Para presentación existe `@ladino/money/format`, y la restricción es mecánica en
 * `dependency-cruiser` (ADR-0021), no una anotación.
 *
 * Estado: S0.2 en fase roja. Las firmas están completas; la implementación no existe todavía.
 */
export type { CurrencyCode, CurrencyDefinition, Scale } from "./currency.js";
export { currencyDefinition, parseCurrency, registeredCurrencies } from "./currency.js";

export type { Decimal } from "./decimal.js";
export { parseDecimal } from "./decimal.js";

export type { MoneyError } from "./errors.js";
export { MoneyErrorCode } from "./errors.js";

export type { MonetaryValue } from "./monetary-value.js";

export type { MoneyJSON } from "./money.js";
export { Money } from "./money.js";

export { ExactMoney } from "./exact-money.js";

export type { Roundable, RoundedMoney, RoundingMode, RoundingPolicy } from "./rounding.js";
export {
  allocate,
  ISO_PRESENTATION_MODE,
  isRoundingOf,
  roundForCurrency,
  roundForDocument,
  roundForPayment,
  roundForTax,
} from "./rounding.js";

export type { FxConversion, FxRate, FxRateInput, RateSource } from "./fx.js";
export { convert, invertFxRate, makeFxRate } from "./fx.js";

export type { MonetaryFact } from "./monetary-fact.js";
export { toMonetaryFact } from "./monetary-fact.js";
