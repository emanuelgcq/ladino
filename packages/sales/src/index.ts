import { err, ok, type Result } from "@ladino/core";
import {
  ExactMoney,
  Money,
  parseCurrency,
  parseDecimal,
  roundForCost,
  roundForTax,
  type Decimal,
  type RoundingPolicy,
} from "@ladino/money";

/**
 * @ladino/sales — cálculo de línea, totales y diferencial cambiario. PURO.
 *
 * Solo `core` y `money`. Ni una alícuota escrita aquí: la que se aplica llega
 * como argumento, resuelta por `platform.resolve_tax()` (ADR-0038). Un `grep`
 * de números tributarios en este paquete no encuentra nada, y eso es
 * comprobable, no una promesa.
 *
 * Todo pasa por `Decimal` y por los redondeos NOMBRADOS de `@ladino/money`.
 * Ningún `number`, ninguna división sin política.
 */

export type SalesErrorCode =
  "INVALID_QUANTITY" | "INVALID_RATE" | "CURRENCY_MISMATCH" | "EMPTY_DOCUMENT" | "MONEY";

export interface SalesError {
  readonly code: SalesErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const money = (m: { code: string; message: string }): SalesError => ({
  code: "MONEY",
  message: m.message,
  details: { moneyCode: m.code },
});

/** Una línea ya calculada: base, impuesto y total, en UNA moneda. */
export interface CalculatedLine {
  readonly quantity: Decimal;
  readonly unitPrice: Money;
  readonly subtotal: Money;
  readonly taxRate: Decimal;
  readonly taxAmount: Money;
  readonly total: Money;
}

/**
 * Calcula una línea: `subtotal = cantidad × precio`, `impuesto = subtotal ×
 * alícuota`, `total = subtotal + impuesto`.
 *
 * El impuesto pasa por `roundForTax` con la política que se le dé, y el subtotal
 * por `roundForCost`: **son dos contextos distintos y se nombran distinto**, que
 * es el punto de tener redondeos con nombre. Al leer un asiento se sabe si aquel
 * céntimo vino de la base o del impuesto.
 *
 * La alícuota llega como argumento y NUNCA por defecto: sin regla no hay línea
 * (ADR-0038). Por eso `taxRate` no es opcional.
 */
export function calculateLine(input: {
  readonly quantity: Decimal;
  readonly unitPrice: Money;
  readonly taxRate: Decimal;
  readonly basePolicy: RoundingPolicy;
  readonly taxPolicy: RoundingPolicy;
}): Result<CalculatedLine, SalesError> {
  if (!input.quantity.isFinite() || input.quantity.lessThanOrEqualTo(0)) {
    return err({ code: "INVALID_QUANTITY", message: "La cantidad debe ser positiva." });
  }
  if (!input.taxRate.isFinite() || input.taxRate.isNegative() || input.taxRate.greaterThan(1)) {
    return err({
      code: "INVALID_RATE",
      message: "La alícuota debe estar entre 0 y 1. Viene de tax_rules; no se inventa aquí.",
    });
  }

  const subtotalExacto = input.unitPrice.multiply(input.quantity);
  const subtotal = roundForCost(subtotalExacto, input.basePolicy);
  if (!subtotal.ok) return err(money(subtotal.error));

  // El impuesto se calcula sobre la base YA REDONDEADA, no sobre la exacta: es
  // la base que aparece impresa en el documento, y el impuesto tiene que ser
  // reproducible a partir de lo que el cliente ve. Calcularlo sobre la exacta
  // daría un impuesto que no cuadra con la base impresa.
  const impuestoExacto = subtotal.value.value.multiply(input.taxRate);
  const impuesto = roundForTax(impuestoExacto, input.taxPolicy);
  if (!impuesto.ok) return err(money(impuesto.error));

  const total = subtotal.value.value.add(impuesto.value.value);
  if (!total.ok) return err(money(total.error));

  return ok({
    quantity: input.quantity,
    unitPrice: input.unitPrice,
    subtotal: subtotal.value.value,
    taxRate: input.taxRate,
    taxAmount: impuesto.value.value,
    total: total.value,
  });
}

export interface DocumentTotals {
  readonly subtotal: Money;
  readonly taxAmount: Money;
  readonly total: Money;
}

/**
 * Suma las líneas. Agregación **PER_LINE**: cada línea se redondea y luego se
 * suman los redondeados.
 *
 * MONEY_AND_ROUNDING_SPEC §6.2 dice que los dos modos (PER_LINE y PER_DOCUMENT)
 * son soportables y que **el asesor elige**, porque difieren en céntimos y el
 * libro de ventas los acumula. Hoy se implementa PER_LINE porque es lo que un
 * documento impreso muestra —cada línea con su impuesto— y porque el total tiene
 * que ser la suma de lo impreso. Cuando la `RuleSet` traiga `TaxAggregation`,
 * este es el punto donde entra el otro camino.
 */
export function calculateTotals(
  lines: readonly CalculatedLine[],
): Result<DocumentTotals, SalesError> {
  const primera = lines[0];
  if (primera === undefined) {
    return err({
      code: "EMPTY_DOCUMENT",
      message: "Un documento sin líneas no se emite: no habría nada que cobrar.",
    });
  }
  const moneda = primera.subtotal.currency;
  let subtotal = Money.zero(moneda);
  let impuesto = Money.zero(moneda);
  for (const l of lines) {
    if (l.subtotal.currency !== moneda) {
      return err({
        code: "CURRENCY_MISMATCH",
        message: "Todas las líneas de un documento van en la misma moneda.",
      });
    }
    const s = subtotal.add(l.subtotal);
    if (!s.ok) return err(money(s.error));
    subtotal = s.value;
    const i = impuesto.add(l.taxAmount);
    if (!i.ok) return err(money(i.error));
    impuesto = i.value;
  }
  const total = subtotal.add(impuesto);
  if (!total.ok) return err(money(total.error));
  return ok({ subtotal, taxAmount: impuesto, total: total.value });
}

/** El diferencial cambiario de un cobro. */
export interface ExchangeDifference {
  readonly amountTransaction: Money;
  readonly functionalAtIssue: Money;
  readonly functionalAtPayment: Money;
  /** cobro − emisión. Positivo = ganancia; negativo = pérdida. */
  readonly difference: Money;
  readonly isGain: boolean;
}

/**
 * Diferencial cambiario: el MISMO importe en moneda de transacción, valorado con
 * la tasa de EMISIÓN y con la del COBRO.
 *
 * No es «lo que se cobró de más»: el cliente entregó exactamente lo pactado en su
 * moneda. Lo que cambió es cuántos bolívares vale eso, y esa diferencia es un
 * resultado financiero con su propia cuenta — nunca se absorbe en el importe
 * cobrado ni en el impuesto (ADR-0020, y MONEY_AND_ROUNDING §6.4 dice lo mismo
 * del redondeo de caja: la diferencia genera asiento propio).
 *
 * Con la misma tasa, la diferencia es CERO exacta, no «casi cero»: las dos
 * valoraciones salen del mismo producto.
 */
export function exchangeDifference(input: {
  readonly amountTransaction: Money;
  readonly functionalCurrency: string;
  readonly rateAtIssue: Decimal;
  readonly rateAtPayment: Decimal;
  readonly policy: RoundingPolicy;
}): Result<ExchangeDifference, SalesError> {
  for (const [nombre, tasa] of [
    ["de emisión", input.rateAtIssue],
    ["de cobro", input.rateAtPayment],
  ] as const) {
    if (!tasa.isFinite() || tasa.lessThanOrEqualTo(0)) {
      return err({
        code: "INVALID_RATE",
        message: `La tasa ${nombre} debe ser estrictamente positiva.`,
      });
    }
  }
  if (input.amountTransaction.isNegative()) {
    return err({
      code: "MONEY",
      message: "El importe de un cobro no es negativo: una devolución es otro documento.",
    });
  }

  // La moneda funcional se PARSEA: `ExactMoney.from` acepta un `MonetaryValue`
  // estructural y una cadena cualquiera pasaría, produciendo un importe con
  // moneda fuera del registro que parece correcto (la lección de money).
  const funcional = parseCurrency(input.functionalCurrency);
  if (!funcional.ok) return err(money(funcional.error));

  const valorar = (tasa: Decimal): Result<Money, SalesError> => {
    const exacto = ExactMoney.from({
      amount: input.amountTransaction.amount.times(tasa),
      currency: funcional.value,
    });
    const r = roundForCost(exacto, input.policy);
    if (!r.ok) return err(money(r.error));
    return ok(r.value.value);
  };

  const enEmision = valorar(input.rateAtIssue);
  if (!enEmision.ok) return enEmision;
  const enCobro = valorar(input.rateAtPayment);
  if (!enCobro.ok) return enCobro;

  const diferencia = enCobro.value.subtract(enEmision.value);
  if (!diferencia.ok) return err(money(diferencia.error));

  return ok({
    amountTransaction: input.amountTransaction,
    functionalAtIssue: enEmision.value,
    functionalAtPayment: enCobro.value,
    difference: diferencia.value,
    isGain: !diferencia.value.isNegative() && !diferencia.value.isZero(),
  });
}

/** Saldo pendiente = total − Σ cobros. Nunca se persiste: se calcula. */
export function outstandingBalance(
  total: Money,
  payments: readonly Money[],
): Result<Money, SalesError> {
  let saldo = total;
  for (const p of payments) {
    const r = saldo.subtract(p);
    if (!r.ok) return err(money(r.error));
    saldo = r.value;
  }
  return ok(saldo);
}

/** Los cuatro rangos de antigüedad. El mismo vocabulario que `platform.ar_aging`. */
export type AgingBucket = "0-30" | "31-60" | "61-90" | "90+";

/**
 * En qué rango de antigüedad cae una factura, dadas su fecha de emisión y la
 * fecha de referencia (ambas ISO-8601).
 *
 * Recibe LAS DOS FECHAS y no un número de días por dos razones. La primera es
 * que el gate `api-surface` prohíbe la palabra `number` en toda la API pública
 * sin excepciones —la primera versión la tenía y el gate la tumbó—. La segunda
 * es mejor: quien llama no tiene que saber cómo se cuentan los días, que es
 * justo donde se cuela un desfase de uno.
 *
 * `Date.parse` es conversión, no lectura del reloj: la pureza del paquete se
 * mantiene (mismo criterio que la suite de purity de `@ladino/money`).
 */
export function agingBucket(
  issuedAt: string,
  referenceAt: string,
): Result<AgingBucket, SalesError> {
  const desde = Date.parse(issuedAt);
  const hasta = Date.parse(referenceAt);
  if (Number.isNaN(desde) || Number.isNaN(hasta)) {
    return err({ code: "MONEY", message: "Las fechas de antigüedad deben ser ISO-8601." });
  }
  const dias = Math.floor((hasta - desde) / 86_400_000);
  if (dias <= 30) return ok("0-30");
  if (dias <= 60) return ok("31-60");
  if (dias <= 90) return ok("61-90");
  return ok("90+");
}

export function parseAmount(value: string): Result<Decimal, SalesError> {
  const d = parseDecimal(value);
  if (!d.ok) return err({ code: "MONEY", message: d.error.message });
  return ok(d.value);
}
