import { err, ok, type Result } from "@ladino/core";
import {
  Money,
  parseCurrency,
  parseDecimal,
  roundForCost,
  type Decimal,
  type RoundingPolicy,
} from "@ladino/money";

/**
 * @ladino/pricing — resolución del precio de venta. Paquete PURO: solo core y money.
 *
 * La lista se pasa EXPLÍCITA. No hay cascada de reglas, y es deliberado: una
 * cascada («si el cliente tiene lista propia, si no la de su categoría, si no la
 * general…») convierte «por qué este precio» en una arqueología, y esa pregunta
 * es la que un vendedor y una fiscalización hacen. Aquí siempre hay UNA lista,
 * quien la eligió lo hizo a la vista, y la línea persiste cuál fue.
 *
 * La conversión a la moneda del documento se hace con la tasa que se pasa como
 * argumento: buscar la tasa vigente es I/O y es del llamante.
 */

/** El precio de un producto en una lista, ya resuelto por quien consultó. */
export interface ListedPrice {
  readonly priceListId: string;
  readonly amount: Money;
}

export interface ResolvedPrice {
  /** Precio unitario en la moneda de la LISTA (USD en Ladino hoy). */
  readonly unitPriceListCurrency: Money;
  /** El mismo, convertido a la moneda del DOCUMENTO con la tasa dada. */
  readonly unitPriceDocumentCurrency: Money;
  /** Qué lista aplicó. Se persiste en la línea: sin esto no hay «por qué». */
  readonly priceListApplied: string;
}

export type PricingErrorCode =
  "NO_PRICE_FOR_PRODUCT" | "INVALID_QUANTITY" | "CURRENCY_MISMATCH" | "MONEY";

export interface PricingError {
  readonly code: PricingErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Resuelve el precio unitario de un producto en una lista dada y lo convierte a
 * la moneda del documento.
 *
 * `quantity` entra porque el contrato lo pide y porque los descuentos por volumen
 * llegarán por aquí; hoy **no altera el precio** y eso se dice en vez de fingir
 * que lo usa. Un parámetro que se ignora en silencio es peor que uno ausente:
 * quien lo lea supondrá que hay escalas y no las hay.
 */
export function resolvePrice(input: {
  readonly listed: ListedPrice | null;
  readonly quantity: Decimal;
  readonly documentCurrency: string;
  readonly fxRate: Decimal;
  readonly roundingPolicy: RoundingPolicy;
}): Result<ResolvedPrice, PricingError> {
  if (input.listed === null) {
    return err({
      code: "NO_PRICE_FOR_PRODUCT",
      message:
        "El producto no tiene precio vigente en la lista seleccionada a esa fecha. Cárgalo o elige otra lista.",
    });
  }
  if (!input.quantity.isFinite() || input.quantity.lessThanOrEqualTo(0)) {
    return err({ code: "INVALID_QUANTITY", message: "La cantidad debe ser positiva." });
  }
  if (!input.fxRate.isFinite() || input.fxRate.lessThanOrEqualTo(0)) {
    return err({
      code: "MONEY",
      message: "La tasa de cambio debe ser estrictamente positiva.",
    });
  }

  const enLista = input.listed.amount;
  if (enLista.currency === input.documentCurrency) {
    // Misma moneda: la tasa tiene que ser la identidad, o alguien está
    // convirtiendo una moneda a sí misma con un factor, que no significa nada.
    if (!input.fxRate.equals(1)) {
      return err({
        code: "CURRENCY_MISMATCH",
        message:
          "La lista ya está en la moneda del documento y la tasa no es 1: la identidad no es una conversión.",
      });
    }
    return ok({
      unitPriceListCurrency: enLista,
      unitPriceDocumentCurrency: enLista,
      priceListApplied: input.listed.priceListId,
    });
  }

  // La moneda del documento se PARSEA: `Roundable` es estructural y aceptaría
  // una cadena cualquiera, produciendo un Money con moneda fuera del registro
  // — publicable y con toda la pinta de correcto (la lección de money §applyPolicy).
  const moneda = parseCurrency(input.documentCurrency);
  if (!moneda.ok) return err({ code: "MONEY", message: moneda.error.message });
  const convertido = roundForCost(
    { amount: enLista.amount.times(input.fxRate), currency: moneda.value },
    input.roundingPolicy,
  );
  if (!convertido.ok) return err({ code: "MONEY", message: convertido.error.message });

  return ok({
    unitPriceListCurrency: enLista,
    unitPriceDocumentCurrency: convertido.value.value,
    priceListApplied: input.listed.priceListId,
  });
}

/** Construye un `ListedPrice` desde lo que devuelve `platform.price_at()`. */
export function listedPriceOf(
  priceListId: string,
  amount: string | null,
  currency: string,
): Result<ListedPrice | null, PricingError> {
  if (amount === null) return ok(null);
  const m = Money.of(amount, currency);
  if (!m.ok) return err({ code: "MONEY", message: m.error.message });
  return ok({ priceListId, amount: m.value });
}

/** Cantidad de una línea: decimal plano y estrictamente positivo. */
export function parseQuantity(value: string): Result<Decimal, PricingError> {
  const d = parseDecimal(value);
  if (!d.ok) return err({ code: "INVALID_QUANTITY", message: d.error.message });
  if (!d.value.isFinite() || d.value.lessThanOrEqualTo(0)) {
    return err({
      code: "INVALID_QUANTITY",
      message: "La cantidad de una línea debe ser estrictamente positiva.",
    });
  }
  return ok(d.value);
}
