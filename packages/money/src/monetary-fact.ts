import type { Instant } from "@ladino/core";
import type { FxConversion } from "./fx.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Los **siete campos** que ADR-0020 exige persistir por cada importe. Definición canónica
 * única: ninguna tabla los redeclara por su cuenta a partir de S0.3.
 *
 * Todo string, porque así es como viajan y como se persisten (`numeric(24,8)` y `text`).
 * Ningún `number` — ni siquiera aquí.
 */
export interface MonetaryFact {
  readonly amountTransactionCurrency: string;
  readonly transactionCurrency: string;
  readonly fxRate: string;
  readonly functionalAmount: string;
  readonly functionalCurrency: string;
  readonly rateSource: string;
  readonly rateTimestamp: Instant;
}

export function toMonetaryFact(conversion: FxConversion): MonetaryFact {
  return notImplemented("toMonetaryFact", conversion);
}
