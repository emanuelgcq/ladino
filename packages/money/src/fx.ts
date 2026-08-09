import { err, ok, parseInstant, type Brand, type Instant, type Result } from "@ladino/core";
import { parseCurrency, type CurrencyCode } from "./currency.js";
import {
  isPersistableAsNumeric,
  LadinoDecimal,
  NUMERIC_SCALE,
  parseDecimal,
  type Decimal,
} from "./decimal.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import { ExactMoney } from "./exact-money.js";
import type { Money } from "./money.js";

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
  const from = parseCurrency(input.from);
  if (!from.ok) return from;

  const to = parseCurrency(input.to);
  if (!to.ok) return to;

  const rate = parseDecimal(input.rate);
  if (!rate.ok || !rate.value.isFinite() || rate.value.lessThanOrEqualTo(0)) {
    return err({
      code: MoneyErrorCode.INVALID_RATE,
      message: "La tasa debe ser un decimal estrictamente positivo.",
      details: { rate: input.rate },
    });
  }

  // ADR-0013: numeric(24,8) para todo monto **y toda tasa**. Una tasa que no cabe se altera al
  // persistirla, y entonces el importe funcional guardado deja de ser reproducible a partir de
  // los siete campos. `makeFxRate` construye tasas citadas y persistibles: si no cabe, no entra.
  if (!isPersistableAsNumeric(rate.value)) {
    return err({
      code: MoneyErrorCode.RATE_NOT_PERSISTABLE,
      message: `Una tasa citada debe caber en numeric(24,8): como mucho ${String(NUMERIC_SCALE)} decimales.`,
      details: { rate: input.rate, decimales: rate.value.decimalPlaces() },
    });
  }

  if (input.source.trim() === "") {
    return err({
      code: MoneyErrorCode.INVALID_RATE_SOURCE,
      message: "Una tasa sin fuente citada no se puede usar ni persistir (ADR-0020).",
      details: { source: input.source },
    });
  }

  const timestamp = parseInstant(input.timestamp);
  if (!timestamp.ok) {
    return err({
      code: MoneyErrorCode.INVALID_RATE_TIMESTAMP,
      message: "El momento de la tasa debe ser ISO-8601 en UTC.",
      details: { timestamp: input.timestamp },
    });
  }

  return ok(
    Object.freeze({
      from: from.value,
      to: to.value,
      rate: rate.value,
      source: input.source as RateSource,
      timestamp: timestamp.value,
    }),
  );
}

/**
 * Invierte la tasa **conservando fuente y timestamp**: la trazabilidad no se pierde al invertir.
 *
 * **La tasa resultante sirve para calcular, no para persistir.** El inverso de 3 es 0.333…
 * periódico, que no cabe en `numeric(24,8)`; guardarlo lo truncaría y quien recalculase con el
 * valor truncado no obtendría el importe funcional almacenado. `toMonetaryFact` rechaza estas
 * tasas con `RATE_NOT_PERSISTABLE`, así que el error no puede llegar a un registro.
 *
 * Es el mismo reparto de papeles que `Money` / `ExactMoney`: lo derivado se calcula, lo citado
 * se guarda.
 */
export function invertFxRate(rate: FxRate): Result<FxRate, MoneyError> {
  if (rate.rate.isZero()) {
    return err({
      code: MoneyErrorCode.INVALID_RATE,
      message: "No se puede invertir una tasa cero.",
      details: { rate: rate.rate.toString() },
    });
  }

  return ok(
    Object.freeze({
      from: rate.to,
      to: rate.from,
      rate: new LadinoDecimal(1).div(rate.rate),
      source: rate.source,
      timestamp: rate.timestamp,
    }),
  );
}

/**
 * Una conversión y todo lo que hace falta para explicarla años después. Proyecta los siete
 * campos de ADR-0020 vía `toMonetaryFact`.
 */
export interface FxConversion {
  readonly original: Money;
  /**
   * Convertido y **sin redondear**: un `ExactMoney`, no un `Money` (ADR-0023).
   *
   * No es un detalle de tipos. `0.00000001 USD × 36.5 = 0.000000365 VES` necesita nueve
   * decimales, así que el resultado exacto de una conversión casi nunca cabe en `numeric(24,8)`.
   * Devolverlo como `Money` obligaría a redondear aquí dentro, y eso rompe la linealidad.
   */
  readonly converted: ExactMoney;
  readonly rate: FxRate;
}

/**
 * Convierte sin redondear.
 *
 * Que no redondee no es un detalle de precisión: **redondear aquí rompe la linealidad**, y con
 * ella el cuadre del diferencial cambiario. El contraejemplo mínimo, con redondeo a 8 decimales:
 *
 * ```
 *   a·r = 0.000000005      b·r = 0.000000005
 *   redondear cada uno:    0.00000000 + 0.00000000 = 0.00000000
 *   redondear la suma:     round(0.00000001)       = 0.00000001
 * ```
 *
 * Convertir línea a línea daría un total distinto que convertir el total, y ningún asiento
 * cuadraría contra la tasa congelada (ADR-0020, invariante 9 de ACCOUNTING_INVARIANTS_TESTS.md).
 *
 * Solo puede fallar si `rate.from` no es la moneda del importe: `ExactMoney` no tiene cota de
 * magnitud, así que el desbordamiento se descubre al redondear, no aquí.
 */
export function convert(money: Money, rate: FxRate): Result<FxConversion, MoneyError> {
  if (money.currency !== rate.from) {
    return err({
      code: MoneyErrorCode.FX_CURRENCY_MISMATCH,
      message: "La tasa no parte de la moneda del importe.",
      details: { importe: money.currency, tasaDesde: rate.from, tasaHacia: rate.to },
    });
  }

  const converted = ExactMoney.from({ amount: money.amount.times(rate.rate), currency: rate.to });
  return ok(Object.freeze({ original: money, converted, rate }));
}
