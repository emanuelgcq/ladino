import type { Result } from "@ladino/core";
import type { Scale } from "./currency.js";
import type { Decimal } from "./decimal.js";
import type { MoneyError } from "./errors.js";
import type { Money } from "./money.js";
import { notImplemented } from "./not-implemented.js";

export type RoundingMode = "HALF_UP" | "HALF_EVEN" | "HALF_DOWN" | "DOWN" | "UP";

/**
 * Política de redondeo. Es **dato versionado y vigente por fecha**, resuelto por el motor
 * tributario y pasado como argumento. Este paquete no la busca en ningún sitio: es puro.
 *
 * Los valores exigibles por moneda, impuesto, documento y pago son un formulario abierto en
 * MONEY_AND_ROUNDING_SPEC.md §6, con todas las celdas marcadas `VALIDAR-TRIBUTARIO`.
 */
export interface RoundingPolicy {
  /** Identificador estable. Se persiste junto al importe redondeado. */
  readonly id: string;
  readonly scale: Scale;
  readonly mode: RoundingMode;
}

/**
 * Resultado de un redondeo. El pre-redondeo es **estructural, no opcional**: ADR-0013 exige
 * conservarlo y, si fuera opcional, se perdería.
 */
export interface RoundedMoney {
  readonly value: Money;
  readonly preRound: Money;
  readonly policy: RoundingPolicy;
}

/**
 * Redondeo de presentación y saldos por moneda. **El único con default**, y no es una regla
 * tributaria: la escala son las minor units de ISO-4217 de la moneda del importe.
 */
export function roundForCurrency(money: Money): RoundedMoney {
  return notImplemented("roundForCurrency", money);
}

/** Base imponible e impuesto. Exige política: el paquete no tiene opinión fiscal. */
export function roundForTax(money: Money, policy: RoundingPolicy): RoundedMoney {
  return notImplemented("roundForTax", money, policy);
}

/** Subtotales y totales del documento fiscal. Exige política. */
export function roundForDocument(money: Money, policy: RoundingPolicy): RoundedMoney {
  return notImplemented("roundForDocument", money, policy);
}

/** Cobros, pagos y vuelto. Exige política. */
export function roundForPayment(money: Money, policy: RoundingPolicy): RoundedMoney {
  return notImplemented("roundForPayment", money, policy);
}

/**
 * Reparte `total` entre `weights` de forma que **la suma de las partes sea exactamente el
 * total**. Sin céntimos perdidos ni inventados.
 *
 * Es lo que hace verificable el invariante 10 de ACCOUNTING_INVARIANTS_TESTS.md. Qué línea
 * concreta recibe el sobrante tiene consecuencias en el libro y está abierto en
 * MONEY_AND_ROUNDING_SPEC.md §6.3 (`VALIDAR-TRIBUTARIO`); lo que aquí se garantiza es que
 * cuadra y que es determinista.
 */
export function allocate(
  total: Money,
  weights: readonly Decimal[],
  scale: Scale,
): Result<readonly Money[], MoneyError> {
  return notImplemented("allocate", total, weights, scale);
}
