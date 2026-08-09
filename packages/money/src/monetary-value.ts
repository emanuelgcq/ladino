import type { CurrencyCode } from "./currency.js";
import type { Decimal } from "./decimal.js";

/**
 * Lo mínimo que comparten `Money` y `ExactMoney`: un decimal y su moneda.
 *
 * Existe por una razón concreta además de la obvia: rompe el ciclo de imports entre los dos
 * módulos. `Money#multiply` devuelve un `ExactMoney`, y `ExactMoney` necesita construirse desde
 * un `Money`; si cada uno importara al otro, `dependency-cruiser` marcaría el ciclo — con razón,
 * porque un ciclo entre el tipo persistible y el tipo de cálculo esconde justo la distinción que
 * ADR-0023 quiere hacer visible.
 *
 * Es un tipo estructural a propósito: `roundFor*` solo necesita leer estos dos campos.
 */
export interface MonetaryValue {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;
}
