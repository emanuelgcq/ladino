/**
 * P29 — Pureza.
 *
 * "El dominio es puro" es una aspiración hasta que algo lo falsa. Este test instrumenta el
 * reloj: si cualquier función pública de @ladino/money lee `Date.now()` o construye
 * `new Date()` sin argumentos, falla. ENGINEERING_STANDARDS.md §Fechas: el reloj se inyecta.
 *
 * `new Date(millis)` y `Date.parse(texto)` sí están permitidos: son conversión, no lectura
 * del reloj.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  Money,
  allocate,
  convert,
  invertFxRate,
  makeFxRate,
  parseDecimal,
  roundForCurrency,
  roundForDocument,
  roundForPayment,
  roundForTax,
  toMonetaryFact,
} from "../src/index.js";
import { must } from "./arbitraries.js";

const RealDate = globalThis.Date;
let clockReads = 0;

beforeEach(() => {
  clockReads = 0;

  const GuardedDate = new Proxy(RealDate, {
    construct(target, args, newTarget) {
      if (args.length === 0) clockReads += 1;
      // `Reflect.*` devuelve `any`; se acota aquí para no propagar unsafe al resto del test.
      return Reflect.construct(target, args, newTarget) as object;
    },
    get(target, prop, receiver) {
      if (prop === "now") {
        return () => {
          clockReads += 1;
          return 0;
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });

  vi.stubGlobal("Date", GuardedDate);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("P29 — ninguna función pública lee el reloj del sistema", () => {
  it("el recorrido completo de la API no toca Date.now() ni new Date()", () => {
    const policy = { id: "purity", scale: 2 as const, mode: "HALF_EVEN" as const };

    const a = must(Money.of("1234.56789", "USD"));
    const b = must(Money.of("0.00000001", "USD"));

    must(a.add(b));
    must(a.subtract(b));
    a.multiply(must(parseDecimal("3")));
    a.negate();
    a.isZero();
    must(a.compare(b));
    a.toAmountString();
    a.toJSON();
    a.toString();

    must(roundForCurrency(a));
    must(roundForTax(a, policy));
    must(roundForDocument(a, policy));
    must(roundForPayment(a, policy));

    must(
      allocate(
        must(roundForCurrency(a)).value,
        [must(parseDecimal("1")), must(parseDecimal("2"))],
        2,
      ),
    );

    const fx = must(
      makeFxRate({
        from: "USD",
        to: "VES",
        rate: "36.5",
        source: "BCV:tasa-oficial",
        timestamp: "2026-08-07T13:45:00Z",
      }),
    );
    must(invertFxRate(fx));
    const conversion = must(convert(a, fx));
    must(toMonetaryFact(conversion, must(roundForCurrency(conversion.converted))));

    expect(clockReads).toBe(0);
  });

  it("el propio guardián funciona (si no, el test anterior no probaría nada)", () => {
    const antes = clockReads;
    void new Date();
    void Date.now();
    expect(clockReads).toBe(antes + 2);
  });

  it("un timestamp inválido no se rescata leyendo el reloj", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.5",
      source: "BCV:tasa-oficial",
      timestamp: "",
    });
    expect(r.ok).toBe(false);
    expect(clockReads).toBe(0);
  });
});

describe("inmutabilidad: un Money nunca se modifica en sitio", () => {
  it("las operaciones devuelven instancias nuevas y dejan el original intacto", () => {
    const a = must(Money.of("100.00", "VES"));
    const antes = a.toAmountString();

    must(a.add(must(Money.of("1.00", "VES"))));
    must(a.subtract(must(Money.of("1.00", "VES"))));
    a.negate();
    must(roundForCurrency(a));

    expect(a.toAmountString()).toBe(antes);
  });

  it("el objeto está congelado", () => {
    const a = must(Money.of("100.00", "VES"));
    expect(Object.isFrozen(a)).toBe(true);
  });
});
