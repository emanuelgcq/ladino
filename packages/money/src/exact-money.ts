import { err, ok, type Result } from "@ladino/core";
import type { CurrencyCode } from "./currency.js";
import { LadinoDecimal, type Decimal } from "./decimal.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import type { MonetaryValue } from "./monetary-value.js";

const ZERO = new LadinoDecimal(0);

/**
 * Un importe **intermedio de cálculo**. Exacto hasta la precisión del clon (50 dígitos
 * significativos), sin tope de escala y sin tope de magnitud.
 *
 * **No tiene `toAmountString()` ni `toJSON()`, y es deliberado.** La única salida de un
 * `ExactMoney` es un redondeo nombrado — `roundForCurrency`, `roundForTax`, `roundForDocument`
 * o `roundForPayment` (ADR-0023). No es una restricción de estilo: hace **imposible** persistir
 * o publicar un valor calculado sin haber nombrado la política con la que se redondeó.
 *
 * `ExactMoney` no sabe nada de `numeric(24,8)`. Esa cota es una preocupación de persistencia y
 * vive en un solo sitio: el puente `ExactMoney → Money`, que es `roundFor*`.
 *
 * Inmutable y congelado. Toda operación devuelve una instancia nueva.
 */
export class ExactMoney implements MonetaryValue {
  /**
   * Campos **privados con getter en el prototipo**, no propiedades propias.
   *
   * Es lo que cierra las vías de publicación que `toJSON` no alcanza: el spread `{...value}`,
   * `Object.entries`, `Object.keys` y `structuredClone` copian **propiedades propias
   * enumerables**, y con `#` no hay ninguna. `{...exactMoney}` da `{}`, no
   * `{"amount":"1.23456789012345","currency":"VES"}`.
   *
   * Un getter en el prototipo satisface `MonetaryValue` igual que una propiedad, así que el
   * acceso normal (`value.amount`) no cambia para nadie.
   */
  readonly #amount: Decimal;
  readonly #currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    // El cero con signo no significa nada y rompería `equals` por representación.
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

  /** Promueve cualquier valor monetario a intermedio de cálculo. Total: nunca falla. */
  static from(value: MonetaryValue): ExactMoney {
    return new ExactMoney(value.amount, value.currency);
  }

  /** Rechaza NaN e infinitos, que no son importes. La magnitud no se acota aquí. */
  static fromDecimal(amount: Decimal, currency: CurrencyCode): Result<ExactMoney, MoneyError> {
    if (!amount.isFinite()) {
      return err({
        code: MoneyErrorCode.INVALID_AMOUNT,
        message: "Un importe no puede ser NaN ni infinito.",
        details: { amount: amount.toString() },
      });
    }
    return ok(new ExactMoney(amount, currency));
  }

  static zero(currency: CurrencyCode): ExactMoney {
    return new ExactMoney(ZERO, currency);
  }

  private sameCurrency(other: ExactMoney): MoneyError | undefined {
    if (this.#currency !== other.currency) {
      return {
        code: MoneyErrorCode.CURRENCY_MISMATCH,
        message: "No se opera entre monedas distintas. Convierte primero con una tasa trazable.",
        details: { izquierda: this.#currency, derecha: other.currency },
      };
    }
    return undefined;
  }

  /** Solo puede fallar por moneda: aquí no hay cota de magnitud que violar. */
  add(other: ExactMoney): Result<ExactMoney, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return ok(new ExactMoney(this.#amount.plus(other.amount), this.#currency));
  }

  subtract(other: ExactMoney): Result<ExactMoney, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return ok(new ExactMoney(this.#amount.minus(other.amount), this.#currency));
  }

  /** Total: multiplicar por un escalar no puede salirse de ningún dominio. */
  multiply(factor: Decimal): ExactMoney {
    return new ExactMoney(this.#amount.times(factor), this.#currency);
  }

  negate(): ExactMoney {
    return new ExactMoney(this.#amount.negated(), this.#currency);
  }

  isZero(): boolean {
    return this.#amount.isZero();
  }

  isNegative(): boolean {
    return this.#amount.isNegative() && !this.#amount.isZero();
  }

  compare(other: ExactMoney): Result<-1 | 0 | 1, MoneyError> {
    const mismatch = this.sameCurrency(other);
    if (mismatch) return err(mismatch);
    return ok(this.#amount.comparedTo(other.amount) as -1 | 0 | 1);
  }

  equals(other: ExactMoney): boolean {
    return this.#currency === other.currency && this.#amount.equals(other.amount);
  }

  /**
   * Diagnóstico y mensajes de error. **No es una serialización**: no hay contrato que reciba
   * un `ExactMoney`, porque para eso hay que redondear primero.
   */
  toString(): string {
    return `${this.#amount.toString()} ${this.#currency} (exacto, sin redondear)`;
  }

  /**
   * Rechaza la serialización, en voz alta.
   *
   * No basta con **no** tener `toJSON`: `JSON.stringify` enumera las propiedades propias, y
   * `Decimal` trae su propio `toJSON`, así que un `ExactMoney` "sin serializador" se publicaba
   * igual como `{"amount":"1.23456789012345","currency":"VES"}` — exactamente el valor sin
   * redondear que ADR-0023 existe para impedir. Lo detectó su propio test.
   *
   * Ausencia de mecanismo no es prohibición. Para prohibir hay que ponerlo por escrito, y aquí
   * eso significa fallar ruidosamente en el punto exacto donde alguien intenta publicar una
   * cifra que nadie ha redondeado.
   */
  toJSON(): never {
    throw new Error(
      `Un ExactMoney no se serializa: ${this.toString()}. Redondea primero con roundForCurrency, ` +
        `roundForTax, roundForDocument o roundForPayment y publica el Money resultante (ADR-0023).`,
    );
  }
}
