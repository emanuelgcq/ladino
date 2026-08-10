import { Decimal } from "decimal.js";
import { err, ok, type Result } from "@ladino/core";
import { MoneyErrorCode, type MoneyError } from "./errors.js";

/**
 * Clon PRIVADO de Decimal. Nunca el constructor global.
 *
 * `decimal.js` tiene configuración global y mutable: si `packages/fiscal` o cualquier
 * dependencia transitiva llamara `Decimal.set({ precision: 20 })`, cambiaría en silencio el
 * resultado de todos nuestros cálculos. Un clon es inmune a eso.
 *
 * `precision: 50` — numeric(24,8) son 24 dígitos significativos, y un producto FX
 * (importe × tasa) puede necesitar hasta 48 antes del redondeo explícito. 50 deja margen para
 * que los intermedios sean exactos.
 *
 * `toExpNeg`/`toExpPos` en ±40 mantienen la notación plana en todo el dominio soportado:
 * `toFixed` nunca debe devolver notación exponencial, que no es un literal válido de
 * `numeric(24,8)`.
 */
export const LadinoDecimal = Decimal.clone({
  precision: 50,
  // Fijado explícitamente, no heredado de los defaults. Solo actúa cuando una operación supera
  // los 50 dígitos significativos, pero de ese modo cuelga la simetría de signo de `multiply` y
  // `convert` —y con ella el invariante 3, que una nota de crédito revierta la factura—. Un modo
  // asimétrico como ROUND_FLOOR heredado por accidente no lo detectaría ningún test.
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -40,
  toExpPos: 40,
  defaults: true,
});

export type { Decimal };

/** Dígitos significativos que el clon puede representar sin redondear. */
const MAX_SIGNIFICANT_DIGITS = 50;

/** Escala de `numeric(24,8)`. ADR-0013: aplica a **todo monto y toda tasa**. */
export const NUMERIC_SCALE = 8;

/** Cota de magnitud de `numeric(24,8)`: 24 dígitos significativos, 8 de ellos decimales. */
export const NUMERIC_MAX_ABS = new LadinoDecimal("9999999999999999.99999999");

/**
 * ¿Cabe este decimal en `numeric(24,8)` **sin redondear**?
 *
 * Vale tanto para importes como para tasas. ADR-0013 no distingue: si un valor no cabe aquí,
 * persistirlo lo altera, y una cifra alterada al persistir no se puede reproducir después.
 */
export function isPersistableAsNumeric(value: Decimal): boolean {
  return (
    value.isFinite() &&
    value.decimalPlaces() <= NUMERIC_SCALE &&
    value.abs().lessThanOrEqualTo(NUMERIC_MAX_ABS)
  );
}

/**
 * Decimal en notación plana, con signo opcional. Deliberadamente estricto:
 * sin exponente (`1e10`), sin signo `+`, sin separador de miles, sin espacios.
 * Normalizar lo que teclea un humano es trabajo de `@ladino/money/format`, no del dominio.
 */
const DECIMAL_PATTERN = /^-?\d+(?:\.\d+)?$/;

/**
 * Única vía pública de construir un Decimal para pasarlo a `multiply` o a los pesos de
 * `allocate`. Rechaza notación exponencial, NaN, Infinity y basura.
 */
export function parseDecimal(value: string): Result<Decimal, MoneyError> {
  if (!DECIMAL_PATTERN.test(value)) {
    return err({
      code: MoneyErrorCode.INVALID_AMOUNT,
      message: "El valor no es un decimal en notación plana.",
      details: { value },
    });
  }

  // Más dígitos de los que el clon representa se redondearían en silencio al construir.
  const significant = value.replace(/[-.]/g, "").replace(/^0+(?=\d)/, "");
  if (significant.length > MAX_SIGNIFICANT_DIGITS) {
    return err({
      code: MoneyErrorCode.AMOUNT_OUT_OF_RANGE,
      message: `El valor excede los ${String(MAX_SIGNIFICANT_DIGITS)} dígitos significativos que se representan de forma exacta.`,
      details: { value },
    });
  }

  return ok(new LadinoDecimal(value));
}
