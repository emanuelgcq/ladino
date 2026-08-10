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
 *
 * Aquí tampoco aparece un `number`: el agrupamiento se hace sobre `BigInt` y los decimales se
 * copian tal cual de la cadena exacta. Convertir a `number` para "solo mostrarlo" pierde
 * precisión a partir de 2^53 y es justo el atajo que este paquete existe para impedir.
 */
import { err, ok, type Result } from "@ladino/core";
import { currencyDefinition, parseCurrency } from "./currency.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import { Money, type MoneyJSON } from "./money.js";

export type { MoneyJSON } from "./money.js";

export interface FormatOptions {
  /** BCP-47. Para Venezuela, `es-VE`. */
  readonly locale: string;
  /** Cómo mostrar la moneda. Por defecto, el símbolo. */
  readonly display?: "symbol" | "code" | "none";
}

/** Separador decimal del locale, tomado del propio ICU en vez de adivinarlo. */
function decimalSeparator(locale: string): string {
  const parts = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).formatToParts(1.5);
  return parts.find((p) => p.type === "decimal")?.value ?? ".";
}

export function formatMoney(value: MoneyJSON, options: FormatOptions): string {
  const code = parseCurrency(value.currency);
  if (!code.ok) {
    throw new Error(`Moneda no registrada: '${value.currency}'.`);
  }
  const { minorUnits } = currencyDefinition(code.value);

  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.amount);
  if (!match) {
    throw new Error(`Importe no canónico: '${value.amount}'.`);
  }
  const [, sign = "", whole = "0", fraction = ""] = match;

  // Formatear NO es redondear. Un importe con más precisión de la que la moneda muestra tenía
  // que haber pasado antes por roundForCurrency / roundForDocument / roundForPayment.
  const significant = fraction.replace(/0+$/, "");
  if (significant.length > minorUnits) {
    throw new Error(
      `El importe '${value.amount}' tiene más decimales de los que ${code.value} representa (${String(minorUnits)}). ` +
        `Formatear no redondea: aplica un redondeo explícito antes (MONEY_AND_ROUNDING_SPEC.md §5).`,
    );
  }

  const display = options.display ?? "symbol";
  const grouping =
    display === "none"
      ? new Intl.NumberFormat(options.locale, { maximumFractionDigits: 0 })
      : new Intl.NumberFormat(options.locale, {
          style: "currency",
          currency: code.value,
          currencyDisplay: display === "code" ? "code" : "symbol",
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        });

  // Se agrupa la parte entera como BigInt (exacto a cualquier magnitud) y se reinyectan los
  // decimales desde la cadena, sin que ningún `number` toque el importe.
  const parts = grouping.formatToParts(BigInt(whole));
  const tail =
    minorUnits > 0
      ? decimalSeparator(options.locale) + fraction.padEnd(minorUnits, "0").slice(0, minorUnits)
      : "";

  let out = "";
  let injected = false;
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    out += part.value;
    const isLastIntegerChunk =
      part.type === "integer" && !parts.slice(i + 1).some((p) => p.type === "integer");
    if (isLastIntegerChunk) {
      out += tail;
      injected = true;
    }
  }
  if (!injected) out += tail;

  // `BigInt("-0")` es `0n`, así que el signo de un importe entre −1 y 0 hay que reponerlo.
  return sign === "-" && !out.includes("-") ? `-${out}` : out;
}

/**
 * Normaliza lo que un usuario teclea (`1.234,56` en es-VE) a `MoneyJSON` canónico.
 * Rechaza lo ambiguo en vez de adivinar.
 */
export function parseUserInput(text: string, currency: string): Result<MoneyJSON, MoneyError> {
  const code = parseCurrency(currency);
  if (!code.ok) return code;

  const invalid = (): Result<MoneyJSON, MoneyError> =>
    err({
      code: MoneyErrorCode.INVALID_AMOUNT,
      message: "No se reconoce un importe en el texto introducido.",
      details: { text, currency },
    });

  // U+00A0 y U+202F son los espacios no separables que emite Intl al agrupar miles; vuelven
  // cuando el usuario copia y pega un importe ya formateado. Escritos con escape a proposito:
  // un caracter invisible dentro de una expresion regular es un bug esperando su turno.
  const compact = text.replace(/[\s\u00a0\u202f]/g, "");
  if (compact === "" || !/^-?[\d.,]+$/.test(compact)) return invalid();

  const lastDot = compact.lastIndexOf(".");
  const lastComma = compact.lastIndexOf(",");

  let normalized: string;
  if (lastDot >= 0 && lastComma >= 0) {
    // Están los dos: el ÚLTIMO manda como separador decimal, el otro es agrupamiento.
    const decimalAt = Math.max(lastDot, lastComma);
    const groupChar = decimalAt === lastDot ? "," : ".";
    normalized =
      compact.slice(0, decimalAt).split(groupChar).join("") + "." + compact.slice(decimalAt + 1);
  } else if (lastComma >= 0) {
    // Solo comas. Más de una es ambiguo ("1,2,3"): se rechaza en vez de suponer.
    if (compact.indexOf(",") !== lastComma) return invalid();
    normalized = compact.replace(",", ".");
  } else {
    if (lastDot >= 0 && compact.indexOf(".") !== lastDot) return invalid();
    normalized = compact;
  }

  const money = Money.of(normalized, currency);
  if (!money.ok) return money;
  return ok(money.value.toJSON());
}
