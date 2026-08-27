/**
 * Resolución de precio — la lista se pasa EXPLÍCITA y la línea persiste cuál
 * aplicó. Sin cascada: «por qué este precio» tiene que tener una respuesta de
 * una línea, no una arqueología.
 *
 *   P1  convertir con tasa 1 en la misma moneda es la identidad;
 *   P2  el precio convertido es el redondeo a 8 decimales de precio × tasa;
 *   P3  determinismo;
 *   P4  sin precio en la lista, no hay línea (nunca un cero por defecto).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Money, parseDecimal, type RoundingPolicy } from "@ladino/money";
import { listedPriceOf, parseQuantity, resolvePrice } from "../src/index.js";

const POL: RoundingPolicy = { id: "test:8:HALF_UP", scale: 8, mode: "HALF_UP" };
const SCALE = 10n ** 8n;

function must<T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T {
  if (!r.ok) throw new Error(`Se esperaba ok, llegó ${r.error.code}: ${r.error.message}`);
  return r.value;
}
const dec = (s: string) => must(parseDecimal(s));
const fmt = (u: bigint): string => `${u / SCALE}.${(u % SCALE).toString().padStart(8, "0")}`;
const units = (s: string): bigint => {
  const [w = "0", f = ""] = s.split(".");
  return BigInt(w) * SCALE + BigInt(f.padEnd(8, "0").slice(0, 8));
};

const LISTA = "aaaa0000-0000-4000-8000-000000000001";
const arbUsd = fc
  .bigInt({ min: 1n, max: 10n ** 12n })
  .map((u) => ({ priceListId: LISTA, amount: must(Money.of(fmt(u), "USD")) }));
const arbTasa = fc.bigInt({ min: 10n ** 6n, max: 10n ** 10n }).map((u) => dec(fmt(u)));

describe("P1 — misma moneda y tasa 1: identidad", () => {
  it("el precio del documento es el de la lista, sin tocar", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 12n }).map((u) => must(Money.of(fmt(u), "VES"))),
        (precio) => {
          const r = must(
            resolvePrice({
              listed: { priceListId: LISTA, amount: precio },
              quantity: dec("1"),
              documentCurrency: "VES",
              fxRate: dec("1"),
              roundingPolicy: POL,
            }),
          );
          expect(r.unitPriceDocumentCurrency.toAmountString()).toBe(precio.toAmountString());
          expect(r.priceListApplied).toBe(LISTA);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("misma moneda con tasa distinta de 1 se RECHAZA: la identidad no es una conversión", () => {
    const r = resolvePrice({
      listed: { priceListId: LISTA, amount: must(Money.of("10", "VES")) },
      quantity: dec("1"),
      documentCurrency: "VES",
      fxRate: dec("40"),
      roundingPolicy: POL,
    });
    expect(!r.ok && r.error.code).toBe("CURRENCY_MISMATCH");
  });
});

describe("P2 — el precio convertido es el redondeo del producto exacto", () => {
  it("|convertido − precio × tasa| < 10^-8", () => {
    fc.assert(
      fc.property(arbUsd, arbTasa, (listed, tasa) => {
        const r = resolvePrice({
          listed,
          quantity: dec("1"),
          documentCurrency: "VES",
          fxRate: tasa,
          roundingPolicy: POL,
        });
        if (!r.ok) {
          expect(r.error.code).toBe("MONEY");
          return;
        }
        const exacto = listed.amount.amount.times(tasa);
        const diff = r.value.unitPriceDocumentCurrency.amount.minus(exacto).abs();
        expect(diff.lessThan("0.00000001")).toBe(true);
        // Y la lista aplicada viaja siempre: es lo que responde «por qué».
        expect(r.value.priceListApplied).toBe(LISTA);
        expect(r.value.unitPriceListCurrency.currency).toBe("USD");
      }),
      { numRuns: 300 },
    );
  });
});

describe("P3 — determinismo", () => {
  it("dos resoluciones del mismo dato coinciden", () => {
    fc.assert(
      fc.property(arbUsd, arbTasa, (listed, tasa) => {
        const entrada = {
          listed,
          quantity: dec("2"),
          documentCurrency: "VES",
          fxRate: tasa,
          roundingPolicy: POL,
        };
        const a = resolvePrice(entrada);
        const b = resolvePrice(entrada);
        expect(a.ok).toBe(b.ok);
        if (!a.ok || !b.ok) return;
        expect(a.value.unitPriceDocumentCurrency.toAmountString()).toBe(
          b.value.unitPriceDocumentCurrency.toAmountString(),
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe("P4 — sin precio en la lista NO hay línea", () => {
  it("no se devuelve cero: un cero por defecto es una venta regalada", () => {
    const r = resolvePrice({
      listed: null,
      quantity: dec("1"),
      documentCurrency: "VES",
      fxRate: dec("1"),
      roundingPolicy: POL,
    });
    expect(!r.ok && r.error.code).toBe("NO_PRICE_FOR_PRODUCT");
    expect(!r.ok && r.error.message).toContain("lista");
  });

  it("listedPriceOf traduce el NULL de price_at() sin inventar nada", () => {
    expect(must(listedPriceOf(LISTA, null, "USD"))).toBeNull();
    expect(must(listedPriceOf(LISTA, "12.50", "USD"))!.amount.toAmountString()).toBe("12.50000000");
  });
});

describe("ejemplos a mano", () => {
  it("10,00 USD a tasa 40 → 400,00 Bs", () => {
    const r = must(
      resolvePrice({
        listed: must(listedPriceOf(LISTA, "10.00", "USD")),
        quantity: dec("3"),
        documentCurrency: "VES",
        fxRate: dec("40"),
        roundingPolicy: POL,
      }),
    );
    expect(r.unitPriceDocumentCurrency.toAmountString()).toBe("400.00000000");
    // El precio es UNITARIO: la cantidad no lo multiplica aquí, eso es la línea.
    expect(units(r.unitPriceDocumentCurrency.toAmountString())).toBe(400n * SCALE);
  });

  it("cantidad cero o negativa no es una línea", () => {
    for (const q of ["0", "-1"]) {
      expect(parseQuantity(q).ok).toBe(false);
    }
    expect(must(parseQuantity("2.5")).toFixed()).toBe("2.5");
  });

  it("una tasa no positiva se rechaza", () => {
    const r = resolvePrice({
      listed: must(listedPriceOf(LISTA, "10", "USD")),
      quantity: dec("1"),
      documentCurrency: "VES",
      fxRate: dec("0"),
      roundingPolicy: POL,
    });
    expect(!r.ok && r.error.code).toBe("MONEY");
  });
});
