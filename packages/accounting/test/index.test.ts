import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { Money, parseDecimal, type Decimal } from "@ladino/money";
import {
  computeAccountBalance,
  computeTrialBalance,
  generateReversalLines,
  validateEntryBalance,
  type EntryLine,
  type LedgerMovement,
} from "../src/index.js";

const VES = "VES";
const m = (s: string): Money => {
  const r = Money.of(s, VES);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const d = (s: string): Decimal => {
  const r = parseDecimal(s);
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const ZERO = m("0");

const debito = (cuenta: string, importe: string): EntryLine => ({
  accountId: cuenta,
  debit: m(importe),
  credit: ZERO,
});
const credito = (cuenta: string, importe: string): EntryLine => ({
  accountId: cuenta,
  debit: ZERO,
  credit: m(importe),
});

describe("partida doble — el invariante", () => {
  it("acepta un asiento cuadrado", () => {
    const r = validateEntryBalance(
      [debito("cxc", "11600"), credito("ing", "10000"), credito("iva", "1600")],
      VES,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.balanced).toBe(true);
    expect(r.value.difference.isZero()).toBe(true);
  });

  it("rechaza uno descuadrado y dice la DIFERENCIA EXACTA", () => {
    const r = validateEntryBalance([debito("cxc", "11600"), credito("ing", "10000")], VES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.balanced).toBe(false);
    // La diferencia es lo único que permite encontrar la línea que falta.
    expect(r.value.difference.toFixed(2)).toBe("1600.00");
  });

  it("una línea con débito Y crédito se rechaza: eso son dos líneas", () => {
    const r = validateEntryBalance(
      [{ accountId: "x", debit: m("100"), credit: m("100") }, credito("y", "100")],
      VES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("BOTH_SIDES");
  });

  it("un asiento de importe cero no es un hecho contable", () => {
    const r = validateEntryBalance([debito("x", "0"), credito("y", "0")], VES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("ZERO_ENTRY");
  });

  it("una línea en otra moneda se rechaza: la partida doble es en funcional", () => {
    const usd = Money.of("100", "USD");
    if (!usd.ok) throw new Error("fixture");
    const r = validateEntryBalance(
      [{ accountId: "x", debit: usd.value, credit: ZERO }, credito("y", "100")],
      VES,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("CURRENCY_MISMATCH");
  });

  /**
   * P1. Construir un asiento cuadrado por construcción: N débitos arbitrarios y
   * un crédito por la suma. Cualquier reparto tiene que aceptarse.
   */
  it("P1 · cualquier asiento cuadrado por construcción se acepta", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 1_000_000 }), { minLength: 1, maxLength: 12 }),
        (importes) => {
          const total = importes.reduce((a, b) => a + b, 0);
          const lineas = [
            ...importes.map((v, i) => debito(`d${i}`, String(v))),
            credito("c", String(total)),
          ];
          const r = validateEntryBalance(lineas, VES);
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          expect(r.value.balanced).toBe(true);
          expect(r.value.difference.isZero()).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  /**
   * P2. Y su inversa, que es la que de verdad protege: con un desvío distinto
   * de cero, NUNCA cuadra, y la diferencia es exactamente el desvío.
   */
  it("P2 · con cualquier desvío no nulo, no cuadra y la diferencia es el desvío", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 100_000 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 99_999 }),
        (importes, desvio) => {
          const total = importes.reduce((a, b) => a + b, 0);
          const lineas = [
            ...importes.map((v, i) => debito(`d${i}`, String(v))),
            credito("c", String(total + desvio)),
          ];
          const r = validateEntryBalance(lineas, VES);
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          expect(r.value.balanced).toBe(false);
          expect(r.value.difference.toFixed(8)).toBe(d(String(-desvio)).toFixed(8));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("saldo de cuenta", () => {
  const mov = (cuenta: string, fecha: string, deb: string, cred: string): LedgerMovement => ({
    accountId: cuenta,
    postingDate: fecha,
    debit: m(deb),
    credit: m(cred),
  });

  it("saldo inicial + movimientos = saldo final", () => {
    const r = computeAccountBalance({
      accountId: "caja",
      nature: "deudora",
      movements: [
        mov("caja", "2026-01-15", "1000", "0"),
        mov("caja", "2026-02-10", "500", "0"),
        mov("caja", "2026-02-20", "0", "300"),
      ],
      from: "2026-02-01",
      to: "2026-02-28",
      functionalCurrency: VES,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.opening.toAmountString()).toBe("1000.00000000");
    expect(r.value.periodDebit.toAmountString()).toBe("500.00000000");
    expect(r.value.periodCredit.toAmountString()).toBe("300.00000000");
    expect(r.value.closing.toAmountString()).toBe("1200.00000000");
  });

  it("un movimiento POSTERIOR a la fecha de corte no entra: el pasado no se reinterpreta", () => {
    const r = computeAccountBalance({
      accountId: "caja",
      nature: "deudora",
      movements: [mov("caja", "2026-02-10", "500", "0"), mov("caja", "2026-03-01", "9999", "0")],
      from: null,
      to: "2026-02-28",
      functionalCurrency: VES,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.closing.toAmountString()).toBe("500.00000000");
  });

  /** P3. La identidad del mayor, para cualquier historia de movimientos. */
  it("P3 · cierre == apertura + débitos − créditos, siempre", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.integer({ min: 1, max: 28 }),
            fc.integer({ min: 0, max: 50_000 }),
            fc.integer({ min: 0, max: 50_000 }),
          ),
          { minLength: 0, maxLength: 20 },
        ),
        (movs) => {
          const movimientos = movs.map(([dia, deb, cred]) =>
            mov(
              "x",
              `2026-0${dia <= 14 ? "1" : "2"}-${String(dia).padStart(2, "0")}`,
              String(deb),
              String(cred),
            ),
          );
          const r = computeAccountBalance({
            accountId: "x",
            nature: "deudora",
            movements: movimientos,
            from: "2026-02-01",
            to: "2026-02-28",
            functionalCurrency: VES,
          });
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          const esperado = r.value.opening.amount
            .plus(r.value.periodDebit.amount)
            .minus(r.value.periodCredit.amount);
          expect(r.value.closing.amount.toFixed(8)).toBe(esperado.toFixed(8));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe("reversión", () => {
  it("cambia de lado, no de signo", () => {
    const original = [debito("cxc", "11600"), credito("ing", "10000"), credito("iva", "1600")];
    const r = generateReversalLines(original);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value[0]!.debit.amount.isZero()).toBe(true);
    expect(r.value[0]!.credit.toAmountString()).toBe("11600.00000000");
    // Ningún importe negativo: un débito negativo es un crédito, y se escribe así.
    for (const l of r.value) {
      expect(l.debit.amount.isNegative()).toBe(false);
      expect(l.credit.amount.isNegative()).toBe(false);
    }
  });

  /**
   * P4. La propiedad que define una reversión: original + reverso deja CADA
   * cuenta involucrada en cero. No el total —eso lo cumpliría cualquier asiento
   * cuadrado—: cada cuenta.
   */
  it("P4 · original + reverso == 0 en CADA cuenta, siempre", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 1, max: 500_000 }), { minLength: 1, maxLength: 10 }),
        (importes) => {
          const total = importes.reduce((a, b) => a + b, 0);
          const original = [
            ...importes.map((v, i) => debito(`cuenta${i}`, String(v))),
            credito("contrapartida", String(total)),
          ];
          const rev = generateReversalLines(original);
          if (!rev.ok) return;

          const neto = new Map<string, Decimal>();
          for (const l of [...original, ...rev.value]) {
            const previo = neto.get(l.accountId) ?? d("0");
            neto.set(l.accountId, previo.plus(l.debit.amount).minus(l.credit.amount));
          }
          for (const [, saldo] of neto) expect(saldo.isZero()).toBe(true);
        },
      ),
      { numRuns: 400 },
    );
  });

  it("y el reverso de un asiento cuadrado también cuadra", () => {
    const original = [debito("a", "100"), credito("b", "100")];
    const rev = generateReversalLines(original);
    expect(rev.ok).toBe(true);
    if (!rev.ok) return;
    const chk = validateEntryBalance(rev.value, VES);
    expect(chk.ok).toBe(true);
    if (chk.ok) expect(chk.value.balanced).toBe(true);
  });
});

describe("balance de comprobación", () => {
  const mov = (cuenta: string, fecha: string, deb: string, cred: string): LedgerMovement => ({
    accountId: cuenta,
    postingDate: fecha,
    debit: m(deb),
    credit: m(cred),
  });

  it("omite las cuentas sin movimiento ni saldo: un balance con ruido no se revisa", () => {
    const r = computeTrialBalance({
      accounts: [
        { accountId: "a", nature: "deudora" },
        { accountId: "sin_uso", nature: "acreedora" },
      ],
      movements: [mov("a", "2026-02-01", "100", "0"), mov("b", "2026-02-01", "0", "100")],
      from: null,
      to: "2026-02-28",
      functionalCurrency: VES,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.rows).toHaveLength(1);
    expect(r.value.rows[0]!.accountId).toBe("a");
  });

  /**
   * P5. Σ débitos == Σ créditos, para cualquier conjunto de asientos que ya
   * cuadraban. Es el invariante que el balance existe para demostrar: si se
   * rompe, hay un asiento roto en la base.
   */
  it("P5 · Σ débitos == Σ créditos para cualquier conjunto de asientos cuadrados", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.integer({ min: 1, max: 100_000 }), fc.integer({ min: 1, max: 9 })), {
          minLength: 1,
          maxLength: 15,
        }),
        (asientos) => {
          const movimientos: LedgerMovement[] = [];
          const cuentas = new Set<string>();
          for (const [importe, cuenta] of asientos) {
            movimientos.push(mov(`c${cuenta}`, "2026-02-10", String(importe), "0"));
            movimientos.push(mov("contrapartida", "2026-02-10", "0", String(importe)));
            cuentas.add(`c${cuenta}`);
          }
          cuentas.add("contrapartida");
          const r = computeTrialBalance({
            accounts: [...cuentas].map((c) => ({
              accountId: c,
              nature: "deudora",
            })),
            movements: movimientos,
            from: null,
            to: "2026-02-28",
            functionalCurrency: VES,
          });
          if (!r.ok) {
            expect(r.error.code).toBe("MONEY");
            return;
          }
          expect(r.value.balanced).toBe(true);
          expect(r.value.totalDebit.toAmountString()).toBe(r.value.totalCredit.toAmountString());
        },
      ),
      { numRuns: 300 },
    );
  });
});
