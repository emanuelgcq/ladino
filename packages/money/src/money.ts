import { err, ok, type Result } from "@ladino/core";
import { parseCurrency, type CurrencyCode } from "./currency.js";
import { LadinoDecimal, parseDecimal, type Decimal } from "./decimal.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import { ExactMoney } from "./exact-money.js";
import type { MonetaryValue } from "./monetary-value.js";

/** Forma del contrato de la API. `amount` siempre con 8 decimales (API_SPEC.md §Dinero). */
export interface MoneyJSON {
  readonly amount: string;
  readonly currency: string;
}

/** Escala interna. Paridad exacta con `numeric(24,8)` de Postgres. */
const INTERNAL_SCALE = 8;

/** Cota de `numeric(24,8)`: 24 dígitos significativos, 8 de ellos decimales. */
const MAX_ABS = new LadinoDecimal("9999999999999999.99999999");

const ZERO = new LadinoDecimal(0);

/**
 * Un importe con su moneda. Inmutable y congelado.
 *
 * **Invariante:** todo `Money` es exactamente representable en `numeric(24,8)` — como mucho 8
 * decimales, y dentro de la cota de magnitud. No es una comodidad: significa que persistir un
 * `Money` nunca pierde información, y que `toAmountString()` no necesita redondear jamás.
 *
 * De ahí que las operaciones que podrían salirse del invariante devuelvan `Result` en vez de
 * ajustar por su cuenta. Un redondeo implícito aquí sería exactamente lo que
 * `ENGINEERING_STANDARDS.md` §Dinero prohíbe.
 *
 * El constructor es privado: no existe forma de fabricar un Money que no haya pasado por la
 * validación. Toda operación devuelve una instancia nueva.
 */
export class Money implements MonetaryValue {
  /**
   * Campos privados con getter, igual que en `ExactMoney` y por una razón propia: con
   * propiedades propias, `JSON.stringify({ ...money })` producía
   * `{"amount":"1.005","currency":"VES"}` — un importe **no canónico** con toda la pinta de un
   * payload válido, saltándose el `toAmountString()` que garantiza los 8 decimales.
   *
   * La única serialización de un `Money` es `toJSON()`.
   */
  readonly #amount: Decimal;
  readonly #currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    // Normaliza el cero con signo. `-0` no significa nada en un libro contable y rompería
    // tanto la comparación por cadena como `toFixed`, que lo emitiría como "-0.00000000".
    this.#amount = amount.isZero() ? ZERO : amount;
    this.#currency = currency;
    Object.freeze(this);
  }

  get amount(): Decimal {
    return this.#amount;
  }

  get currency(): CurrencyCode {
    return this.#currency;
  }

  /**
   * Construye tras validar el invariante. `scaleError` distingue el motivo según el origen:
   * una entrada con demasiados decimales es un dato inválido; un resultado aritmético con
   * demasiados decimales es un valor que existe pero no se puede persistir sin redondear
   * explícitamente antes.
   */
  private static guarded(
    amount: Decimal,
    currency: CurrencyCode,
    scaleError:
      typeof MoneyErrorCode.INVALID_AMOUNT | typeof MoneyErrorCode.RESULT_NOT_REPRESENTABLE,
  ): Result<Money, MoneyError> {
    if (!amount.isFinite()) {
      return err({
        code: MoneyErrorCode.INVALID_AMOUNT,
        message: "Un importe no puede ser NaN ni infinito.",
        details: { amount: amount.toString() },
      });
    }

    if (amount.decimalPlaces() > INTERNAL_SCALE) {
      return err({
        code: scaleError,
        message: `Un importe admite como mucho ${String(INTERNAL_SCALE)} decimales (numeric(24,8)). Redondea de forma explícita con roundForCurrency / roundForTax / roundForDocument / roundForPayment.`,
        details: { amount: amount.toString(), decimales: amount.decimalPlaces() },
      });
    }

    if (amount.abs().greaterThan(MAX_ABS)) {
      return err({
        code: MoneyErrorCode.AMOUNT_OUT_OF_RANGE,
        message: "El importe no cabe en numeric(24,8).",
        details: { amount: amount.toString(), maximo: MAX_ABS.toFixed(INTERNAL_SCALE) },
      });
    }

    return ok(new Money(amount, currency));
  }

  /** Construye desde la cadena canónica y un código de moneda sin validar. */
  static of(amount: string, currency: string): Result<Money, MoneyError> {
    // La moneda primero: un importe correcto en una moneda inexistente sigue sin significar nada.
    const code = parseCurrency(currency);
    if (!code.ok) return code;

    const value = parseDecimal(amount);
    if (!value.ok) return value;

    return Money.guarded(value.value, code.value, MoneyErrorCode.INVALID_AMOUNT);
  }

  /** Construye desde un Decimal ya validado y un código de moneda ya parseado. */
  static fromDecimal(amount: Decimal, currency: CurrencyCode): Result<Money, MoneyError> {
    return Money.guarded(amount, currency, MoneyErrorCode.RESULT_NOT_REPRESENTABLE);
  }

  /** Cero en la moneda dada. Total: un cero siempre cabe en el dominio. */
  static zero(currency: CurrencyCode): Money {
    return new Money(ZERO, currency);
  }

  private sameCurrency(other: Money): MoneyError | undefined {
    if (this.#currency !== other.currency) {
      return {
        code: MoneyErrorCode.CURRENCY_MISMATCH,
        message: "No se opera entre monedas distintas. Convierte primero con una tasa trazable.",
        details: { izquierda: this.#currency, derecha: other.currency },
      };
    }
    return undefined;
  }

  add(other: Money): Result<Money, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return Money.guarded(
      this.#amount.plus(other.amount),
      this.#currency,
      MoneyErrorCode.RESULT_NOT_REPRESENTABLE,
    );
  }

  subtract(other: Money): Result<Money, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return Money.guarded(
      this.#amount.minus(other.amount),
      this.#currency,
      MoneyErrorCode.RESULT_NOT_REPRESENTABLE,
    );
  }

  /**
   * Multiplica por un escalar. Nunca por otro Money: VES × VES no es una magnitud.
   *
   * Devuelve **`ExactMoney`**, no `Money`, y no puede fallar: el producto exacto casi nunca cabe
   * en 8 decimales, y fingir que sí obligaría a redondear en silencio aquí dentro. Multiplicar
   * te saca del mundo persistible; para volver hay que nombrar una política de redondeo
   * (ADR-0023).
   */
  multiply(factor: Decimal): ExactMoney {
    return ExactMoney.from({ amount: this.#amount.times(factor), currency: this.#currency });
  }

  negate(): Money {
    return new Money(this.#amount.negated(), this.#currency);
  }

  isZero(): boolean {
    return this.#amount.isZero();
  }

  isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  compare(other: Money): Result<-1 | 0 | 1, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return ok(this.#amount.comparedTo(other.amount) as -1 | 0 | 1);
  }

  equals(other: Money): boolean {
    return this.#currency === other.currency && this.#amount.equals(other.amount);
  }

  /**
   * Cadena canónica: siempre 8 decimales, notación plana, sin separador de miles.
   *
   * Nunca redondea, porque el invariante de la clase garantiza que no hace falta.
   *
   * **Solo para persistencia y paridad con numeric(24,8).** No es forma válida del contrato
   * de la API: ahí todo importe viaja como `{ amount, currency }`.
   */
  toAmountString(): string {
    return this.#amount.toFixed(INTERNAL_SCALE);
  }

  toJSON(): MoneyJSON {
    return { amount: this.toAmountString(), currency: this.#currency };
  }

  /** Diagnóstico, no contrato. Lleva la moneda pegada para que se note si alguien lo serializa. */
  toString(): string {
    return `${this.toAmountString()} ${this.#currency}`;
  }
}
