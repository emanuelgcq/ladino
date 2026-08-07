import { Decimal } from "decimal.js";
import type { Result } from "@ladino/core";
import type { MoneyError } from "./errors.js";
import { notImplemented } from "./not-implemented.js";

/**
 * Clon PRIVADO de Decimal. Nunca el constructor global.
 *
 * `decimal.js` tiene configuración global y mutable: si `packages/fiscal` o cualquier
 * dependencia transitiva llamara `Decimal.set({ precision: 20 })`, cambiaría en silencio el
 * resultado de todos nuestros cálculos. Un clon es inmune a eso.
 *
 * `precision: 50` — numeric(24,8) son 24 dígitos significativos, y un producto FX
 * (importe × tasa) puede necesitar hasta 48 antes del redondeo explícito. 50 deja margen para
 * que los intermedios sean exactos. Si al implementar P25 o P26 hiciera falta más, se sube
 * aquí y se documenta el porqué en el propio test.
 */
export const LadinoDecimal = Decimal.clone({
  precision: 50,
  toExpNeg: -40,
  toExpPos: 40,
  defaults: true,
});

export type { Decimal };

/**
 * Única vía pública de construir un Decimal para pasarlo a `multiply` o a los pesos de
 * `allocate`. Rechaza notación exponencial, NaN, Infinity y basura.
 */
export function parseDecimal(value: string): Result<Decimal, MoneyError> {
  return notImplemented("parseDecimal", value);
}
