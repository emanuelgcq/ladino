/**
 * P24–P28 — Conversión FX.
 *
 * P25 (linealidad) es la que obliga a que `convert` NO redondee por dentro. Si redondeara,
 * convertir línea a línea daría un total distinto que convertir el total, y el diferencial
 * cambiario dejaría de cuadrar contra la tasa congelada (ADR-0020, invariante 9 de
 * ACCOUNTING_INVARIANTS_TESTS.md).
 *
 * Desde ADR-0023, `FxConversion.converted` es un `ExactMoney`: el resultado exacto de una
 * conversión casi nunca cabe en `numeric(24,8)` —`0.00000001 × 36.5 = 0.000000365`— y forzarlo
 * a `Money` obligaría a redondear justo donde no se debe. Por eso la linealidad se comprueba
 * con `equals` sobre valores exactos y **ya no tiene tolerancia**: es igualdad, sin más.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ExactMoney,
  Money,
  MoneyErrorCode,
  convert,
  invertFxRate,
  makeFxRate,
  parseDecimal,
  roundForCurrency,
  toMonetaryFact,
} from "../src/index.js";
import { arbAmountString, arbCurrency, must } from "./arbitraries.js";

const TIMESTAMP = "2026-08-07T13:45:00Z";
const SOURCE = "BCV:tasa-oficial";

const rate = (value: string, from = "USD", to = "VES") =>
  must(makeFxRate({ from, to, rate: value, source: SOURCE, timestamp: TIMESTAMP }));

/**
 * Tolerancia de la ida y vuelta (P26). DECLARADA, no descubierta ajustando hasta que pase.
 *
 * Por qué 1e-30, en orden:
 *
 * 1. El clon de Decimal trabaja con **precisión 50** dígitos significativos (`decimal.ts`).
 * 2. La ida y vuelta son **dos operaciones**: `m × r` y luego `× (1/r)`. La inversa `1/r` no es
 *    exacta en base 10 salvo que `r` sea potencia de 10, así que cada paso introduce un error
 *    relativo de a lo sumo 10^-49.
 * 3. Los importes de esta propiedad llegan hasta 10^8. Con error relativo 10^-49 acumulado en
 *    dos pasos, el error absoluto queda por debajo de 10^-40.
 *
 * 1e-30 deja **diez órdenes de magnitud de margen** sobre esa cota y sigue siendo una aserción
 * con dientes: es 10^22 veces más estricta que la unidad mínima de persistencia (10^-8). Si la
 * propiedad fallara, no sería por holgura insuficiente sino porque la conversión está mal.
 *
 * Si en algún momento no bastara, se sube la precisión del clon y se documenta aquí el porqué.
 * NO se relaja esta constante.
 */
const FX_ROUNDTRIP_TOLERANCE = must(parseDecimal(`0.${"0".repeat(29)}1`));

describe("P24 — identidad", () => {
  it("tasa 1 con from = to devuelve el mismo importe", () => {
    fc.assert(
      fc.property(arbAmountString(10n ** 20n), arbCurrency, (amount, currency) => {
        const m = must(Money.of(amount, currency));
        const c = must(convert(m, rate("1", currency, currency)));
        expect(c.converted.equals(ExactMoney.from(m))).toBe(true);
        expect(c.original.equals(m)).toBe(true);
      }),
    );
  });
});

describe("P25 — linealidad: convert no redondea por dentro", () => {
  it("convert(a + b) = convert(a) + convert(b), EXACTAMENTE", () => {
    fc.assert(
      fc.property(
        fc.tuple(arbAmountString(10n ** 18n), arbAmountString(10n ** 18n)),
        fc.constantFrom("36.5", "0.0025", "1", "123.45678901", "7"),
        ([x, y], r) => {
          const fx = rate(r);
          const a = must(Money.of(x, "USD"));
          const b = must(Money.of(y, "USD"));

          const juntos = must(convert(must(a.add(b)), fx)).converted;
          const porSeparado = must(
            must(convert(a, fx)).converted.add(must(convert(b, fx)).converted),
          );

          expect(juntos.equals(porSeparado)).toBe(true);
        },
      ),
    );
  });

  it("convertir 100 líneas y sumar da lo mismo que sumar y convertir", () => {
    fc.assert(
      fc.property(
        fc.array(arbAmountString(10n ** 12n), { minLength: 2, maxLength: 100 }),
        (amounts) => {
          const fx = rate("36.51234567");
          const lines = amounts.map((a) => must(Money.of(a, "USD")));

          const total = lines.reduce((acc, m) => must(acc.add(m)), Money.zero(lines[0]!.currency));
          const convertidoDelTotal = must(convert(total, fx)).converted;

          const sumaDeConvertidos = lines
            .map((m) => must(convert(m, fx)).converted)
            .reduce((acc, m) => must(acc.add(m)), ExactMoney.zero(convertidoDelTotal.currency));

          expect(convertidoDelTotal.equals(sumaDeConvertidos)).toBe(true);
        },
      ),
    );
  });

  it("el contraejemplo que prohíbe redondear dentro de convert", () => {
    // Si `convert` redondeara a 8 decimales, estos dos importes darían 0 por separado y
    // 0.00000001 juntos. Con el valor exacto, las dos vías coinciden.
    const fx = rate("0.5");
    const a = must(Money.of("0.00000001", "USD"));

    const juntos = must(convert(must(a.add(a)), fx)).converted;
    const porSeparado = must(must(convert(a, fx)).converted.add(must(convert(a, fx)).converted));

    expect(juntos.equals(porSeparado)).toBe(true);
    // El clon usa toExpNeg: -40, así que la notación es plana en todo el dominio soportado.
    expect(juntos.amount.toString()).toBe("0.00000001");
  });
});

describe("P26 — ida y vuelta dentro de la tolerancia declarada", () => {
  it("convert(convert(m, r), r⁻¹) recupera m", () => {
    fc.assert(
      fc.property(
        arbAmountString(10n ** 16n),
        fc.constantFrom("36.5", "0.0025", "123.45678901", "7", "1"),
        (amount, r) => {
          const fx = rate(r);
          const m = must(Money.of(amount, "USD"));
          const ida = must(convert(m, fx)).converted;
          const vuelta = convert2(ida, must(invertFxRate(fx)));

          const delta = vuelta.amount.minus(m.amount).abs();
          expect(delta.lessThanOrEqualTo(FX_ROUNDTRIP_TOLERANCE)).toBe(true);
        },
      ),
    );
  });

  it("la inversa conserva source y timestamp: la trazabilidad no se pierde al invertir", () => {
    const fx = rate("36.5");
    const inv = must(invertFxRate(fx));
    expect(inv.source).toBe(SOURCE);
    expect(inv.timestamp).toBe(TIMESTAMP);
    expect(inv.from).toBe("VES");
    expect(inv.to).toBe("USD");
  });
});

/**
 * La vuelta parte de un `ExactMoney`, y `convert` toma un `Money`. Redondear en medio
 * contaminaría la medida, así que el test multiplica por la tasa inversa directamente — que es
 * exactamente lo que `convert` hace por dentro.
 */
function convert2(value: ExactMoney, inverse: ReturnType<typeof rate>): ExactMoney {
  return value.multiply(inverse.rate);
}

describe("P27 — trazabilidad estructural: los 7 campos de ADR-0020", () => {
  it("FxConversion expone original, converted y la tasa completa", () => {
    const fx = rate("36.5");
    const c = must(convert(must(Money.of("100", "USD")), fx));

    expect(c.original.toAmountString()).toBe("100.00000000");
    expect(c.original.currency).toBe("USD");
    expect(c.converted.currency).toBe("VES");
    expect(c.rate.source).toBe(SOURCE);
    expect(c.rate.timestamp).toBe(TIMESTAMP);
  });

  it("toMonetaryFact proyecta exactamente los 8 campos, todos string", () => {
    // Siete de ADR-0020 más la política aplicada (ADR-0024): sin ella no se puede reproducir
    // cómo se llegó del pre-redondeo al importe guardado.
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const functional = must(roundForCurrency(c.converted));
    const fact = must(toMonetaryFact(c, functional));

    expect(Object.keys(fact).sort()).toEqual(
      [
        "amountTransactionCurrency",
        "functionalAmount",
        "functionalCurrency",
        "fxRate",
        "rateSource",
        "rateTimestamp",
        "roundingPolicyId",
        "transactionCurrency",
      ].sort(),
    );
    expect(fact.roundingPolicyId).toBe(functional.policy.id);
    expect(fact.roundingPolicyId).not.toBe("");
    Object.values(fact).forEach((v) => expect(typeof v).toBe("string"));
    expect(fact.amountTransactionCurrency).toBe("100.00000000");
    expect(fact.transactionCurrency).toBe("USD");
    expect(fact.functionalAmount).toBe("3650.00000000");
    expect(fact.functionalCurrency).toBe("VES");
    expect(fact.rateSource).toBe(SOURCE);
    expect(fact.rateTimestamp).toBe(TIMESTAMP);
  });

  it("no se puede construir el hecho sin nombrar el redondeo", () => {
    // Compile-time: `converted` es ExactMoney y no tiene toAmountString, así que no hay forma
    // de producir functional_amount sin pasar por un roundFor*. Si alguien añadiera una
    // sobrecarga de un solo argumento, este @ts-expect-error dejaría de fallar.
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    // @ts-expect-error toMonetaryFact exige el RoundedMoney: sin política no hay hecho monetario
    expect(() => toMonetaryFact(c)).toBeDefined();
  });

  it("rechaza un RoundedMoney que no procede de esta conversión", () => {
    // Cada campo sería individualmente cierto y el conjunto, mentira: el importe funcional no
    // se obtendría de aplicar esa tasa a ese importe transaccional. Indefendible en auditoría.
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const otra = must(convert(must(Money.of("999", "USD")), rate("36.5")));
    const funcionalAjeno = must(roundForCurrency(otra.converted));

    const r = toMonetaryFact(c, funcionalAjeno);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.FACT_ROUNDING_MISMATCH);
  });

  it("rechaza un importe funcional en otra moneda", () => {
    const c = must(convert(must(Money.of("100", "USD")), rate("36.5")));
    const enUsd = must(roundForCurrency(ExactMoney.from(must(Money.of("3650", "USD")))));

    const r = toMonetaryFact(c, enUsd);
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.FACT_ROUNDING_MISMATCH);
  });

  it("makeFxRate rechaza una tasa sin fuente", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.5",
      source: "",
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_SOURCE);
  });

  it("makeFxRate rechaza una fuente que solo es espacios en blanco", () => {
    const r = makeFxRate({
      from: "USD",
      to: "VES",
      rate: "36.5",
      source: "   ",
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_SOURCE);
  });

  it("makeFxRate rechaza timestamps que no son ISO-8601 UTC", () => {
    for (const ts of ["2026-08-07", "2026-08-07T13:45:00+04:00", "ayer", ""]) {
      const r = makeFxRate({ from: "USD", to: "VES", rate: "36.5", source: SOURCE, timestamp: ts });
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE_TIMESTAMP);
    }
  });

  it("makeFxRate rechaza tasas no positivas y no numéricas", () => {
    for (const value of ["0", "-1", "abc", "", "NaN", "Infinity"]) {
      const r = makeFxRate({
        from: "USD",
        to: "VES",
        rate: value,
        source: SOURCE,
        timestamp: TIMESTAMP,
      });
      expect(r.ok).toBe(false);
      expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.INVALID_RATE);
    }
  });

  it("makeFxRate rechaza monedas fuera del registro", () => {
    const r = makeFxRate({
      from: "XYZ",
      to: "VES",
      rate: "36.5",
      source: SOURCE,
      timestamp: TIMESTAMP,
    });
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.UNKNOWN_CURRENCY);
  });
});

describe("P28 — la tasa tiene que corresponder al importe", () => {
  it("convert falla si rate.from ≠ money.currency", () => {
    const r = convert(must(Money.of("100", "VES")), rate("36.5", "USD", "VES"));
    expect(r.ok).toBe(false);
    expect(r.ok ? null : r.error.code).toBe(MoneyErrorCode.FX_CURRENCY_MISMATCH);
  });

  it("no existe ninguna vía de conversión que no exija { rate, source, timestamp }", () => {
    // Compile-time: si alguien añadiera una sobrecarga de convert con un escalar suelto,
    // este @ts-expect-error dejaría de fallar y el typecheck lo denunciaría.
    // @ts-expect-error convert no acepta una tasa suelta sin fuente ni timestamp
    expect(() => convert(must(Money.of("100", "USD")), "36.5")).toBeDefined();
  });
});
