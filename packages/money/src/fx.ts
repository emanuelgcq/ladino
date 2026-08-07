import type { Brand, Instant, Result } from "@ladino/core";
import type { CurrencyCode } from "./currency.js";
import type { Decimal } from "./decimal.js";
import type { MoneyError } from "./errors.js";
import type { Money } from "./money.js";
import { notImplemented } from "./not-implemented.js";

/** Fuente citada de la tasa. ADR-0020: sin `source` no se persiste una conversión. */
export type RateSource = Brand<string, "RateSource">;

/**
 * Tasa de cambio con su trazabilidad.
 *
 * `source` y `timestamp` son **obligatorios en el tipo** — eso sí es garantía de compile-time.
 * Su **no-vacuidad** se valida en `makeFxRate`, que es la única vía de construcción.
 * `'' as RateSource` compila en cualquier sistema de tipos de TypeScript; la documentación de
 * este paquete no promete lo que el compilador no puede dar.
 */
export interface FxRate {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** Unidades de `to` por cada unidad de `from`. Estrictamente positiva. */
  readonly rate: Decimal;
  readonly source: RateSource;
  readonly timestamp: Instant;
}

export interface FxRateInput {
  readonly from: string;
  readonly to: string;
  readonly rate: string;
  readonly source: string;
  readonly timestamp: string;
}

/** Única vía de construcción. Valida monedas, positividad, fuente no vacía y timestamp UTC. */
export function makeFxRate(input: FxRateInput): Result<FxRate, MoneyError> {
  return notImplemented("makeFxRate", input);
}

/** Invierte la tasa **conservando fuente y timestamp**: la trazabilidad no se pierde al invertir. */
export function invertFxRate(rate: FxRate): Result<FxRate, MoneyError> {
  return notImplemented("invertFxRate", rate);
}

/**
 * Una conversión y todo lo que hace falta para explicarla años después. Proyecta los siete
 * campos de ADR-0020 vía `toMonetaryFact`.
 */
export interface FxConversion {
  readonly original: Money;
  /** Convertido y **sin redondear**. Redondear es decisión posterior del contexto. */
  readonly converted: Money;
  readonly rate: FxRate;
}

/**
 * Convierte sin redondear.
 *
 * Que no redondee no es un detalle: si lo hiciera, se perdería la linealidad
 * (`convert(a+b) = convert(a) + convert(b)`), convertir línea a línea daría un total distinto
 * que convertir el total, y el diferencial cambiario dejaría de cuadrar contra la tasa
 * congelada. Falla si `rate.from` no es la moneda del importe.
 */
export function convert(money: Money, rate: FxRate): Result<FxConversion, MoneyError> {
  return notImplemented("convert", money, rate);
}
