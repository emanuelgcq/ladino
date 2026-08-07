import type { Result } from "@ladino/core";
import type { CurrencyCode } from "./currency.js";
import type { Decimal } from "./decimal.js";
import type { MoneyError } from "./errors.js";
import { notImplemented } from "./not-implemented.js";

/** Forma del contrato de la API. `amount` siempre con 8 decimales (API_SPEC.md §Dinero). */
export interface MoneyJSON {
  readonly amount: string;
  readonly currency: string;
}

/**
 * Un importe con su moneda. Inmutable y congelado.
 *
 * El constructor es privado: no existe forma de fabricar un Money que no haya pasado por la
 * validación. Toda operación devuelve una instancia nueva.
 */
export class Money {
  readonly amount: Decimal;
  readonly currency: CurrencyCode;

  private constructor(amount: Decimal, currency: CurrencyCode) {
    this.amount = amount;
    this.currency = currency;
    Object.freeze(this);
  }

  /** Construye desde la cadena canónica y un código de moneda sin validar. */
  static of(amount: string, currency: string): Result<Money, MoneyError> {
    return notImplemented("Money.of", amount, currency);
  }

  /** Construye desde un Decimal ya validado y un código de moneda ya parseado. */
  static fromDecimal(amount: Decimal, currency: CurrencyCode): Result<Money, MoneyError> {
    return notImplemented("Money.fromDecimal", amount, currency);
  }

  /** Cero en la moneda dada. Total: un cero siempre cabe en el dominio. */
  static zero(currency: CurrencyCode): Money {
    return notImplemented("Money.zero", currency);
  }

  add(other: Money): Result<Money, MoneyError> {
    return notImplemented("Money#add", this, other);
  }

  subtract(other: Money): Result<Money, MoneyError> {
    return notImplemented("Money#subtract", this, other);
  }

  /** Multiplica por un escalar. Nunca por otro Money: VES × VES no es una magnitud. */
  multiply(factor: Decimal): Result<Money, MoneyError> {
    return notImplemented("Money#multiply", this, factor);
  }

  negate(): Money {
    return notImplemented("Money#negate", this);
  }

  isZero(): boolean {
    return notImplemented("Money#isZero", this);
  }

  isNegative(): boolean {
    return notImplemented("Money#isNegative", this);
  }

  compare(other: Money): Result<-1 | 0 | 1, MoneyError> {
    return notImplemented("Money#compare", this, other);
  }

  equals(other: Money): boolean {
    return notImplemented("Money#equals", this, other);
  }

  /**
   * Cadena canónica: siempre 8 decimales, notación plana, sin separador de miles.
   * **Solo para persistencia y paridad con numeric(24,8).** No es forma válida del contrato
   * de la API: ahí todo importe viaja como `{ amount, currency }`.
   */
  toAmountString(): string {
    return notImplemented("Money#toAmountString", this);
  }

  toJSON(): MoneyJSON {
    return notImplemented("Money#toJSON", this);
  }

  /** Diagnóstico, no contrato. Lleva la moneda pegada para que se note si alguien lo serializa. */
  toString(): string {
    return notImplemented("Money#toString", this);
  }
}
