import { err, ok, type Instant, type Result } from "@ladino/core";
import { isPersistableAsNumeric, NUMERIC_SCALE } from "./decimal.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import type { FxConversion } from "./fx.js";
import { isRoundingOf, type RoundedMoney } from "./rounding.js";

/**
 * Los **siete campos** que ADR-0020 exige persistir por cada importe. Definición canónica
 * única: ninguna tabla los redeclara por su cuenta a partir de S0.3.
 *
 * Todo string, porque así es como viajan y como se persisten (`numeric(24,8)` y `text`).
 * Ningún `number` — ni siquiera aquí.
 */
export interface MonetaryFact {
  readonly amountTransactionCurrency: string;
  readonly transactionCurrency: string;
  readonly fxRate: string;
  readonly functionalAmount: string;
  readonly functionalCurrency: string;
  readonly rateSource: string;
  readonly rateTimestamp: Instant;
}

/**
 * Proyecta una conversión y **su** redondeo a los siete campos de ADR-0020.
 *
 * Hacen falta los dos argumentos porque `conversion.converted` es un `ExactMoney`: no existe
 * forma de producir `functional_amount` sin haber nombrado antes una política de redondeo
 * (ADR-0023). Eso no es fricción, es el punto entero.
 *
 * Y valida que el `RoundedMoney` **proceda de esta conversión**, comparando `preRound` con el
 * valor convertido. La razón no es defensiva sino de auditoría: los siete campos solo significan
 * algo si son coherentes entre sí. Un `fx_rate` que no corresponde al `functional_amount`
 * persistido produce un registro donde cada campo es individualmente cierto y el conjunto es
 * mentira — el importe funcional no se obtiene de aplicar esa tasa a ese importe transaccional.
 * Nadie puede reproducir esa cifra, y en una inspección no hay forma de defenderla.
 *
 * La firma sola no puede impedirlo: dos `RoundedMoney` de la misma moneda son intercambiables
 * para el compilador. Así que se comprueba en ejecución.
 */
export function toMonetaryFact(
  conversion: FxConversion,
  functional: RoundedMoney,
): Result<MonetaryFact, MoneyError> {
  // La tasa tiene que poder guardarse tal cual. Una tasa derivada (la inversa de 3 son 0.333…)
  // se truncaría al persistirla, y entonces recalcular `functional_amount` a partir de los
  // siete campos daría otra cifra. Es el invariante 9 roto en la frontera de persistencia.
  if (!isPersistableAsNumeric(conversion.rate.rate)) {
    return err({
      code: MoneyErrorCode.RATE_NOT_PERSISTABLE,
      message:
        "La tasa no cabe en numeric(24,8): guardarla la alteraría y el importe funcional dejaría de ser reproducible. Las tasas derivadas sirven para calcular, no para persistir.",
      details: { rate: conversion.rate.rate.toString() },
    });
  }

  // `RoundedMoney` es una interfaz, así que se puede fabricar a mano con un `value` que no sea
  // el redondeo de su `preRound`. Sin esta comprobación, el puente único de ADR-0023 tendría
  // una entrada lateral por la que colar cualquier importe funcional.
  if (!isRoundingOf(functional)) {
    return err({
      code: MoneyErrorCode.FACT_ROUNDING_MISMATCH,
      message:
        "El importe redondeado no se obtiene de aplicar su propia política a su propio pre-redondeo.",
      details: {
        valor: functional.value.toAmountString(),
        preRedondeo: functional.preRound.toString(),
        politica: functional.policy.id,
      },
    });
  }

  if (!functional.preRound.equals(conversion.converted)) {
    return err({
      code: MoneyErrorCode.FACT_ROUNDING_MISMATCH,
      message:
        "El importe redondeado no procede de esta conversión: su pre-redondeo no coincide con el valor convertido. Los siete campos de ADR-0020 quedarían incoherentes entre sí.",
      details: {
        convertido: conversion.converted.toString(),
        preRedondeo: functional.preRound.toString(),
      },
    });
  }

  if (functional.value.currency !== conversion.rate.to) {
    return err({
      code: MoneyErrorCode.FACT_ROUNDING_MISMATCH,
      message: "La moneda del importe funcional no es la moneda destino de la tasa.",
      details: { funcional: functional.value.currency, tasaHacia: conversion.rate.to },
    });
  }

  return ok({
    amountTransactionCurrency: conversion.original.toAmountString(),
    transactionCurrency: conversion.original.currency,
    // Forma canónica de numeric(24,8), no `toString()`: la validación de arriba garantiza que
    // es exacta, y un literal canónico es lo único que Postgres puede releer sin sorpresas.
    fxRate: conversion.rate.rate.toFixed(NUMERIC_SCALE),
    functionalAmount: functional.value.toAmountString(),
    functionalCurrency: functional.value.currency,
    rateSource: conversion.rate.source,
    rateTimestamp: conversion.rate.timestamp,
  });
}
