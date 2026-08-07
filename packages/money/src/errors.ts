import type { DomainError } from "@ladino/core";

/**
 * Códigos de error de @ladino/money. **Estables y parte del contrato**: cambiar uno es un
 * cambio incompatible (ENGINEERING_STANDARDS.md §Estructura del código).
 */
export const MoneyErrorCode = {
  /** La cadena no es un decimal válido, o trae más de 8 decimales. */
  INVALID_AMOUNT: "MONEY_INVALID_AMOUNT",
  /** El importe no cabe en numeric(24,8). Nunca se trunca en silencio. */
  AMOUNT_OUT_OF_RANGE: "MONEY_AMOUNT_OUT_OF_RANGE",
  /** El código de moneda no está en el registro ISO-4217 soportado. */
  UNKNOWN_CURRENCY: "MONEY_UNKNOWN_CURRENCY",
  /** Operación aritmética entre monedas distintas. Nunca se coacciona. */
  CURRENCY_MISMATCH: "MONEY_CURRENCY_MISMATCH",
  /** Tasa no numérica, cero o negativa. */
  INVALID_RATE: "MONEY_INVALID_RATE",
  /** Tasa sin fuente citada. ADR-0020: sin `source` no se persiste una conversión. */
  INVALID_RATE_SOURCE: "MONEY_INVALID_RATE_SOURCE",
  /** Timestamp de la tasa ausente o fuera de ISO-8601 UTC. */
  INVALID_RATE_TIMESTAMP: "MONEY_INVALID_RATE_TIMESTAMP",
  /** La moneda de origen de la tasa no coincide con la del importe. */
  FX_CURRENCY_MISMATCH: "MONEY_FX_CURRENCY_MISMATCH",
  /** Pesos de reparto vacíos, negativos o todos a cero. */
  INVALID_WEIGHTS: "MONEY_INVALID_WEIGHTS",
} as const;

export type MoneyErrorCode = (typeof MoneyErrorCode)[keyof typeof MoneyErrorCode];

export interface MoneyError extends DomainError {
  readonly code: MoneyErrorCode;
}
