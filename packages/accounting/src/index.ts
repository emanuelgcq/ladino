import { err, ok, type Result } from "@ladino/core";
import { Money, parseDecimal, type Decimal } from "@ladino/money";

/**
 * @ladino/accounting — partida doble. PURO.
 *
 * Solo `core` y `money`. Ni una cuenta contable escrita aquí: las cuentas
 * llegan como identificadores opacos, resueltas por el mapeo de cada empresa
 * (ADR-0041). Un `grep` de códigos de cuenta en este paquete no encuentra nada.
 *
 * Es el paquete donde se comprueba si los módulos anteriores fueron en serio.
 * El invariante REAL vive en Postgres —`platform.assert_entry_balanced()`, en
 * moneda funcional, en un trigger que nadie puede saltarse—; esto es su gemelo
 * en TypeScript, para que la pantalla pueda decir «no cuadra» antes de enviar y
 * para que el caso de uso falle temprano con la diferencia exacta. **Que sean
 * dos implementaciones es deliberado**: si divergen, lo dice un test.
 */

export type AccountingErrorCode =
  "UNBALANCED" | "EMPTY_ENTRY" | "ZERO_ENTRY" | "BOTH_SIDES" | "CURRENCY_MISMATCH" | "MONEY";

export interface AccountingError {
  readonly code: AccountingErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/** Naturaleza de la cuenta. Decide de qué lado suma su saldo. */
export type AccountNature = "deudora" | "acreedora";

/**
 * Una línea, ya en moneda funcional. Débito **o** crédito: la que no aplica va
 * a cero, y las dos a la vez es un error, no una convención.
 */
export interface EntryLine {
  readonly accountId: string;
  readonly debit: Money;
  readonly credit: Money;
}

export interface BalanceCheck {
  readonly balanced: boolean;
  /** débitos − créditos. Cero si cuadra; con signo si no. */
  readonly difference: Decimal;
  readonly totalDebit: Money;
  readonly totalCredit: Money;
}

function cero(currency: string): Result<Money, AccountingError> {
  const m = Money.of("0", currency);
  if (!m.ok) return err({ code: "MONEY", message: m.error.message });
  return ok(m.value);
}

/**
 * Comprueba la partida doble sobre un conjunto de líneas en MONEDA FUNCIONAL.
 *
 * Devuelve la diferencia exacta, no solo un booleano: un «no cuadra» sin el
 * importe obliga a que quien lo lea vuelva a sumar, y quien vuelve a sumar
 * suma distinto. La diferencia es lo único que permite encontrar la línea.
 */
export function validateEntryBalance(
  lines: readonly EntryLine[],
  functionalCurrency: string,
): Result<BalanceCheck, AccountingError> {
  if (lines.length === 0) {
    return err({ code: "EMPTY_ENTRY", message: "Un asiento sin líneas no es un asiento." });
  }
  const z = cero(functionalCurrency);
  if (!z.ok) return z;

  let debitos = z.value.amount;
  let creditos = z.value.amount;
  for (const l of lines) {
    if (l.debit.currency !== functionalCurrency || l.credit.currency !== functionalCurrency) {
      return err({
        code: "CURRENCY_MISMATCH",
        message:
          "La partida doble se comprueba en MONEDA FUNCIONAL: una línea en otra moneda cuadraría o no según qué se sume.",
        details: { accountId: l.accountId },
      });
    }
    const tieneDebito = !l.debit.amount.isZero();
    const tieneCredito = !l.credit.amount.isZero();
    if (tieneDebito && tieneCredito) {
      return err({
        code: "BOTH_SIDES",
        message: "Una línea es débito o crédito, nunca las dos: eso es dos líneas.",
        details: { accountId: l.accountId },
      });
    }
    if (l.debit.amount.isNegative() || l.credit.amount.isNegative()) {
      return err({
        code: "BOTH_SIDES",
        message:
          "Un importe negativo no es un asiento: un débito negativo es un crédito, y se escribe como crédito.",
        details: { accountId: l.accountId },
      });
    }
    debitos = debitos.plus(l.debit.amount);
    creditos = creditos.plus(l.credit.amount);
  }

  if (debitos.isZero() && creditos.isZero()) {
    return err({
      code: "ZERO_ENTRY",
      message: "Un asiento de importe cero no es un hecho contable.",
    });
  }

  const mDebitos = Money.of(debitos.toFixed(8), functionalCurrency);
  const mCreditos = Money.of(creditos.toFixed(8), functionalCurrency);
  if (!mDebitos.ok || !mCreditos.ok) {
    return err({ code: "MONEY", message: "Importe fuera de rango al sumar el asiento." });
  }
  return ok({
    balanced: debitos.equals(creditos),
    difference: debitos.minus(creditos),
    totalDebit: mDebitos.value,
    totalCredit: mCreditos.value,
  });
}

// ── Saldo de una cuenta ─────────────────────────────────────────────────────

/** Un movimiento ya asentado, tal como lo devuelve el mayor. */
export interface LedgerMovement {
  readonly accountId: string;
  /** ISO `YYYY-MM-DD`. Se compara como cadena: el formato lo garantiza. */
  readonly postingDate: string;
  readonly debit: Money;
  readonly credit: Money;
}

export interface AccountBalance {
  readonly accountId: string;
  readonly nature: AccountNature;
  readonly opening: Money;
  readonly periodDebit: Money;
  readonly periodCredit: Money;
  readonly closing: Money;
}

/**
 * Saldo inicial + movimientos del período + saldo final.
 *
 * El saldo se lleva SIEMPRE como `débitos − créditos`, y la naturaleza solo
 * cambia cómo se presenta, no cómo se calcula. Llevarlo con signo según la
 * naturaleza haría que sumar cuentas de distinta naturaleza diera un número sin
 * significado, y esa suma es exactamente el balance de comprobación.
 */
export function computeAccountBalance(input: {
  readonly accountId: string;
  readonly nature: AccountNature;
  readonly movements: readonly LedgerMovement[];
  readonly from: string | null;
  readonly to: string;
  readonly functionalCurrency: string;
}): Result<AccountBalance, AccountingError> {
  const z = cero(input.functionalCurrency);
  if (!z.ok) return z;

  let apertura = z.value.amount;
  let debitos = z.value.amount;
  let creditos = z.value.amount;

  for (const m of input.movements) {
    if (m.accountId !== input.accountId) continue;
    if (m.postingDate > input.to) continue;
    if (input.from !== null && m.postingDate < input.from) {
      apertura = apertura.plus(m.debit.amount).minus(m.credit.amount);
      continue;
    }
    debitos = debitos.plus(m.debit.amount);
    creditos = creditos.plus(m.credit.amount);
  }

  const cierre = apertura.plus(debitos).minus(creditos);
  const mk = (d: Decimal): Result<Money, AccountingError> => {
    const m = Money.of(d.toFixed(8), input.functionalCurrency);
    if (!m.ok) return err({ code: "MONEY", message: m.error.message });
    return ok(m.value);
  };
  const a = mk(apertura);
  const d = mk(debitos);
  const c = mk(creditos);
  const f = mk(cierre);
  if (!a.ok) return a;
  if (!d.ok) return d;
  if (!c.ok) return c;
  if (!f.ok) return f;

  return ok({
    accountId: input.accountId,
    nature: input.nature,
    opening: a.value,
    periodDebit: d.value,
    periodCredit: c.value,
    closing: f.value,
  });
}

// ── Reversión ───────────────────────────────────────────────────────────────

/**
 * Genera las líneas del contra-asiento: cada débito pasa a crédito y al revés,
 * por el MISMO importe.
 *
 * No se invierten los signos —no hay signos que invertir—, se cambia de lado.
 * Un contra-asiento con importes negativos cuadraría igual y dejaría el mayor
 * con movimientos negativos que ninguna cuenta debería tener.
 */
export function generateReversalLines(
  lines: readonly EntryLine[],
): Result<readonly EntryLine[], AccountingError> {
  if (lines.length === 0) {
    return err({ code: "EMPTY_ENTRY", message: "No hay nada que reversar." });
  }
  return ok(lines.map((l) => ({ accountId: l.accountId, debit: l.credit, credit: l.debit })));
}

// ── Balance de comprobación ─────────────────────────────────────────────────

export interface TrialBalanceRow {
  readonly accountId: string;
  readonly nature: AccountNature;
  readonly opening: Money;
  readonly periodDebit: Money;
  readonly periodCredit: Money;
  readonly closing: Money;
}

export interface TrialBalance {
  readonly rows: readonly TrialBalanceRow[];
  readonly totalDebit: Money;
  readonly totalCredit: Money;
  /** Σ débitos == Σ créditos. Si es falso, hay un asiento roto en la base. */
  readonly balanced: boolean;
}

/**
 * El balance de comprobación a una fecha. La fecha es PARÁMETRO —nunca «hoy»—:
 * un balance que no se puede reproducir mañana no sirve para cerrar un mes.
 *
 * Solo aparecen las cuentas con movimiento o con saldo. Una cuenta en cero que
 * nunca se movió es ruido, y un balance con ruido no se revisa.
 */
export function computeTrialBalance(input: {
  readonly accounts: readonly { accountId: string; nature: AccountNature }[];
  readonly movements: readonly LedgerMovement[];
  readonly from: string | null;
  readonly to: string;
  readonly functionalCurrency: string;
}): Result<TrialBalance, AccountingError> {
  const z = cero(input.functionalCurrency);
  if (!z.ok) return z;

  const filas: TrialBalanceRow[] = [];
  let totalD = z.value.amount;
  let totalC = z.value.amount;

  for (const a of input.accounts) {
    const saldo = computeAccountBalance({
      accountId: a.accountId,
      nature: a.nature,
      movements: input.movements,
      from: input.from,
      to: input.to,
      functionalCurrency: input.functionalCurrency,
    });
    if (!saldo.ok) return saldo;
    const s = saldo.value;
    const sinMovimiento =
      s.periodDebit.amount.isZero() && s.periodCredit.amount.isZero() && s.closing.amount.isZero();
    if (sinMovimiento) continue;
    filas.push(s);
    // Los totales son los MOVIMIENTOS del período, no los saldos. Un saldo de
    // apertura no es un débito ni un crédito: es el resultado de otros que ya
    // cuadraron. Mezclarlos rompería el invariante que este balance existe para
    // demostrar — que Σ débitos == Σ créditos — y lo rompería sin que nada
    // fallara, que es la peor forma.
    totalD = totalD.plus(s.periodDebit.amount);
    totalC = totalC.plus(s.periodCredit.amount);
  }

  const mD = Money.of(totalD.toFixed(8), input.functionalCurrency);
  const mC = Money.of(totalC.toFixed(8), input.functionalCurrency);
  if (!mD.ok || !mC.ok) {
    return err({ code: "MONEY", message: "Importe fuera de rango al totalizar el balance." });
  }
  return ok({
    rows: filas,
    totalDebit: mD.value,
    totalCredit: mC.value,
    balanced: totalD.equals(totalC),
  });
}

/** Importe como string decimal → `Decimal`, con el error del dominio. */
export function parseAmount(raw: string): Result<Decimal, AccountingError> {
  const d = parseDecimal(raw);
  if (!d.ok) return err({ code: "MONEY", message: d.error.message });
  return ok(d.value);
}
