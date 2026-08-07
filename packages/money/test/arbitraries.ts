/**
 * Generadores y oráculo independiente para las propiedades de @ladino/money.
 *
 * El oráculo es **BigInt escalado a 10^8**, no decimal.js. Si comprobáramos decimal.js contra
 * decimal.js, la suite pasaría también con la librería mal configurada. La aritmética entera
 * exacta de BigInt es una segunda implementación de verdad.
 */
import fc from "fast-check";
import type { Money, RoundingMode, Scale } from "../src/index.js";

/** Escala interna del paquete. Paridad con numeric(24,8) de Postgres. */
export const INTERNAL_SCALE = 8;
export const SCALE_FACTOR = 10n ** 8n;

/** numeric(24,8): 24 dígitos significativos en total, 8 de ellos decimales. */
export const MAX_SCALED = 10n ** 24n - 1n;

/**
 * Rango reducido para propiedades que suman tres valores (asociatividad): garantiza que el
 * resultado sigue dentro del dominio y que un fallo señala un bug, no un desbordamiento
 * legítimo. El desbordamiento tiene su propia propiedad.
 */
export const SAFE_SCALED = MAX_SCALED / 4n;

/** Convierte unidades escaladas a la cadena canónica de 8 decimales. Oráculo, no implementación. */
export function scaledToString(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / SCALE_FACTOR;
  const frac = abs % SCALE_FACTOR;
  const body = `${whole}.${frac.toString().padStart(INTERNAL_SCALE, "0")}`;
  return negative && abs !== 0n ? `-${body}` : body;
}

/** Inversa de `scaledToString`. Acepta cualquier número de decimales hasta 8. */
export function stringToScaled(value: string): bigint {
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const [whole = "0", frac = ""] = body.split(".");
  const padded = frac.padEnd(INTERNAL_SCALE, "0").slice(0, INTERNAL_SCALE);
  const units = BigInt(whole) * SCALE_FACTOR + BigInt(padded === "" ? "0" : padded);
  return negative ? -units : units;
}

// ---------------------------------------------------------------- arbitraries

export const arbScaled = (max: bigint = MAX_SCALED): fc.Arbitrary<bigint> =>
  fc.bigInt({ min: -max, max });

export const arbAmountString = (max: bigint = MAX_SCALED): fc.Arbitrary<string> =>
  arbScaled(max).map(scaledToString);

/** Monedas registradas. Su escala ISO-4217 es metadato, no una regla tributaria. */
export const SUPPORTED_CURRENCIES = ["VES", "USD"] as const;

export const arbCurrency: fc.Arbitrary<string> = fc.constantFrom(...SUPPORTED_CURRENCIES);

export const ALL_ROUNDING_MODES: readonly RoundingMode[] = [
  "HALF_UP",
  "HALF_EVEN",
  "HALF_DOWN",
  "DOWN",
  "UP",
];

export const ALL_SCALES: readonly Scale[] = [0, 2, 4, 6, 8];

export const arbRoundingMode: fc.Arbitrary<RoundingMode> = fc.constantFrom(...ALL_ROUNDING_MODES);
export const arbScale: fc.Arbitrary<Scale> = fc.constantFrom(...ALL_SCALES);

export const arbRoundingPolicy = fc
  .record({ scale: arbScale, mode: arbRoundingMode })
  .map(({ scale, mode }) => ({ id: `test:${mode}:${scale}`, scale, mode }));

// --------------------------------------------------------------------- helpers

/** Extrae el valor de un Result o falla el test con el código de error. */
export function must<T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T {
  if (!r.ok) throw new Error(`Se esperaba ok, llegó ${r.error.code}`);
  return r.value;
}

/** Las unidades escaladas de un Money, para comparar contra el oráculo BigInt. */
export function unitsOf(money: Money): bigint {
  return stringToScaled(money.toAmountString());
}
