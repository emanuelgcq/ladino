import { err, ok, type Brand, type Result } from "@ladino/core";
import { MoneyErrorCode, type MoneyError } from "./errors.js";

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
 * un cambio de tipo.
 *
 * Las escalas son ISO-4217 y por eso están aquí. El **modo** de redondeo por moneda no está:
 * es un formulario abierto en MONEY_AND_ROUNDING_SPEC.md §6.1 (`VALIDAR-TRIBUTARIO`) y este
 * paquete no tiene opinión fiscal.
 *
 * Este objeto es el **único sitio** autorizado a acuñar un `CurrencyCode`. Fuera de aquí, la
 * única vía es `parseCurrency`.
 */
const DEFINITIONS: readonly CurrencyDefinition[] = Object.freeze([
  Object.freeze({ code: "VES" as CurrencyCode, minorUnits: 2, name: "Bolívar" }),
  Object.freeze({ code: "USD" as CurrencyCode, minorUnits: 2, name: "Dólar estadounidense" }),
]);

const BY_CODE: ReadonlyMap<string, CurrencyDefinition> = new Map(
  DEFINITIONS.map((d) => [d.code as string, d]),
);

export function registeredCurrencies(): readonly CurrencyDefinition[] {
  return DEFINITIONS;
}

/**
 * Única vía de obtener un `CurrencyCode`. Rechaza lo que no esté en el registro.
 *
 * Estricta con las mayúsculas a propósito: ISO-4217 son códigos en mayúscula, y aceptar `ves`
 * abriría la puerta a que dos representaciones del mismo importe no comparen iguales.
 */
export function parseCurrency(code: string): Result<CurrencyCode, MoneyError> {
  const definition = BY_CODE.get(code);
  if (definition === undefined) {
    return err({
      code: MoneyErrorCode.UNKNOWN_CURRENCY,
      message: "El código de moneda no está en el registro soportado.",
      details: { code, soportadas: DEFINITIONS.map((d) => d.code) },
    });
  }
  return ok(definition.code);
}

/**
 * Total para un `CurrencyCode` válido: si existe el código, existe su definición.
 *
 * Lanza solo si alguien fabricó un `CurrencyCode` esquivando `parseCurrency` con un cast. No es
 * control de flujo: es un invariante roto, y prefiero que se vea a que devuelva algo plausible.
 */
export function currencyDefinition(code: CurrencyCode): CurrencyDefinition {
  const definition = BY_CODE.get(code);
  if (definition === undefined) {
    throw new Error(
      `Invariante roto: '${code}' no está en el registro de monedas. Un CurrencyCode solo se obtiene de parseCurrency.`,
    );
  }
  return definition;
}
