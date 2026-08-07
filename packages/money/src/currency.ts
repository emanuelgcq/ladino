import type { Brand, Result } from "@ladino/core";
import type { MoneyError } from "./errors.js";
import { notImplemented } from "./not-implemented.js";

export type CurrencyCode = Brand<string, "CurrencyCode">;

/**
 * Escala decimal. **Unión literal, no `number`.**
 *
 * Es lo que permite que el gate `api-surface` sea absoluto: ningún `number` en la API pública
 * (criterio de "hecho" de S0.2). Un `number` aquí obligaría a abrirle una excepción al gate,
 * y un gate con excepciones deja de serlo.
 */
export type Scale = 0 | 2 | 4 | 6 | 8;

export interface CurrencyDefinition {
  readonly code: CurrencyCode;
  /** Minor units de ISO-4217. Metadato de la moneda, NO una regla tributaria. */
  readonly minorUnits: Scale;
  readonly name: string;
}

/**
 * Registro de monedas soportadas. Es **dato**, no un enum: añadir una moneda no debe requerir
 * un cambio de tipo. Las escalas son ISO-4217; el modo de redondeo por moneda es un formulario
 * abierto en MONEY_AND_ROUNDING_SPEC.md §6.1 (`VALIDAR-TRIBUTARIO`).
 */
export function registeredCurrencies(): readonly CurrencyDefinition[] {
  return notImplemented("registeredCurrencies");
}

/** Única vía de obtener un `CurrencyCode`. Rechaza lo que no esté en el registro. */
export function parseCurrency(code: string): Result<CurrencyCode, MoneyError> {
  return notImplemented("parseCurrency", code);
}

/** Total para un `CurrencyCode` válido: si existe el código, existe su definición. */
export function currencyDefinition(code: CurrencyCode): CurrencyDefinition {
  return notImplemented("currencyDefinition", code);
}
