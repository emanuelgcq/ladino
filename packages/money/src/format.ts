/**
 * @ladino/money/format — la ÚNICA entrada que `apps/web`, `apps/mobile` y `packages/ui`
 * pueden importar (ADR-0021).
 *
 * Recibe y devuelve `MoneyJSON`, nunca `Money`. Así el cliente no necesita jamás la entrada
 * raíz, y "solo formateo" deja de ser un comentario en una tabla para ser una regla de import.
 *
 * **Cero aritmética. Cero FX. Cero redondeo fiscal.** Formatear no es redondear: si la UI
 * necesita dos decimales, el dominio ya debió redondear con la función nombrada que
 * corresponda (MONEY_AND_ROUNDING_SPEC.md §5). Por eso `formatMoney` lanza en vez de recortar
 * un importe con más precisión de la que muestra.
 */
import type { Result } from "@ladino/core";
import type { MoneyError } from "./errors.js";
import type { MoneyJSON } from "./money.js";
import { notImplemented } from "./not-implemented.js";

export type { MoneyJSON } from "./money.js";

export interface FormatOptions {
  /** BCP-47. Para Venezuela, `es-VE`. */
  readonly locale: string;
  /** Cómo mostrar la moneda. Por defecto, el símbolo. */
  readonly display?: "symbol" | "code" | "none";
}

export function formatMoney(value: MoneyJSON, options: FormatOptions): string {
  return notImplemented("formatMoney", value, options);
}

/**
 * Normaliza lo que un usuario teclea (`1.234,56` en es-VE) a `MoneyJSON` canónico.
 * Rechaza lo ambiguo en vez de adivinar.
 */
export function parseUserInput(text: string, currency: string): Result<MoneyJSON, MoneyError> {
  return notImplemented("parseUserInput", text, currency);
}
