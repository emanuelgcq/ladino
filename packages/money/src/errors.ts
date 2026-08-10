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
  /**
   * El resultado exacto de una operación necesita más de 8 decimales. El valor existe, pero no
   * se puede persistir sin redondear antes — y elegir el redondeo es del contexto, no de la
   * operación. Se distingue de `INVALID_AMOUNT` a propósito: aquí la entrada era válida.
   */
  RESULT_NOT_REPRESENTABLE: "MONEY_RESULT_NOT_REPRESENTABLE",
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
  /**
   * El total a repartir no es múltiplo de la unidad mínima de la escala pedida. Repartir
   * 0.00000001 en partes de escala 0 no tiene respuesta correcta: o la suma no cuadra, o alguna
   * parte se sale de la escala. `allocate` no elige por su cuenta ni redondea el total.
   */
  TOTAL_NOT_AT_SCALE: "MONEY_TOTAL_NOT_AT_SCALE",
  /**
   * El `RoundedMoney` que se pasa a `toMonetaryFact` no procede de esa conversión. Un `fx_rate`
   * que no corresponde al `functional_amount` persistido rompe la coherencia de los siete campos
   * de ADR-0020 y es indefendible en una auditoría.
   */
  FACT_ROUNDING_MISMATCH: "MONEY_FACT_ROUNDING_MISMATCH",
  /**
   * La tasa no cabe en `numeric(24,8)` sin redondear, así que persistirla la alteraría. Le pasa
   * a toda tasa **derivada** —la inversa de 3 son 0.333… periódico—, que sirve para calcular
   * pero no puede figurar como `fx_rate` de un hecho monetario: quien recalcule con la tasa
   * truncada no obtendría el importe funcional guardado.
   */
  RATE_NOT_PERSISTABLE: "MONEY_RATE_NOT_PERSISTABLE",
  /**
   * Política de redondeo sin identificador. Un importe redondeado por un criterio anónimo no se
   * puede explicar después, que es justo lo que ADR-0013 exige poder hacer.
   */
  INVALID_ROUNDING_POLICY: "MONEY_INVALID_ROUNDING_POLICY",
} as const;

export type MoneyErrorCode = (typeof MoneyErrorCode)[keyof typeof MoneyErrorCode];

export interface MoneyError extends DomainError {
  readonly code: MoneyErrorCode;
}
