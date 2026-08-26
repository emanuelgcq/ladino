import { err, ok, type Result } from "@ladino/core";
import { currencyDefinition, parseCurrency, type Scale } from "./currency.js";
import { LadinoDecimal, type Decimal } from "./decimal.js";
import { MoneyErrorCode, type MoneyError } from "./errors.js";
import { ExactMoney } from "./exact-money.js";
import { Money } from "./money.js";
import type { MonetaryValue } from "./monetary-value.js";

export type RoundingMode = "HALF_UP" | "HALF_EVEN" | "HALF_DOWN" | "DOWN" | "UP";

/**
 * Lo que se puede redondear: un `Money` (bajar de escala sigue siendo legítimo) o un
 * `ExactMoney` (el caso normal, y la ÚNICA salida que este tiene).
 */
export type Roundable = MonetaryValue;

/**
 * Política de redondeo. Es **dato versionado y vigente por fecha**, resuelto por el motor
 * tributario y pasado como argumento. Este paquete no la busca en ningún sitio: es puro.
 *
 * Los valores exigibles por moneda, impuesto, documento y pago son un formulario abierto en
 * MONEY_AND_ROUNDING_SPEC.md §6, con las celdas tributarias marcadas `VALIDAR-TRIBUTARIO`.
 */
export interface RoundingPolicy {
  /** Identificador estable. Se persiste junto al importe redondeado. */
  readonly id: string;
  readonly scale: Scale;
  readonly mode: RoundingMode;
}

/**
 * Resultado de un redondeo, y **el único puente de `ExactMoney` a `Money`** (ADR-0023).
 *
 * El pre-redondeo es estructural, no opcional: ADR-0013 exige conservarlo y, si fuera opcional,
 * se perdería. Es un `ExactMoney` porque el valor de entrada puede tener más precisión de la que
 * `numeric(24,8)` admite — de hecho ese es el caso normal viniendo de una conversión FX.
 */
export interface RoundedMoney {
  readonly value: Money;
  readonly preRound: ExactMoney;
  readonly policy: RoundingPolicy;
}

/**
 * Modo que usa `roundForCurrency` mientras MONEY_AND_ROUNDING_SPEC.md §6.1 siga abierto.
 *
 * Tiene nombre propio para que el día que el asesor responda el cambio sea una línea
 * localizable por `grep`, y para que aparezca en el `policy.id` de cada resultado: ninguna
 * cifra queda redondeada por un criterio que no se pueda leer después.
 *
 * **No es una decisión fiscal.** `roundForCurrency` es presentación y saldos por moneda; un
 * importe con efecto tributario pasa por `roundForTax`, `roundForDocument` o `roundForPayment`,
 * que exigen la política inyectada.
 */
export const ISO_PRESENTATION_MODE: RoundingMode = "HALF_EVEN";

const DECIMAL_ROUNDING: Readonly<Record<RoundingMode, Decimal.Rounding>> = {
  UP: LadinoDecimal.ROUND_UP,
  DOWN: LadinoDecimal.ROUND_DOWN,
  HALF_UP: LadinoDecimal.ROUND_HALF_UP,
  HALF_DOWN: LadinoDecimal.ROUND_HALF_DOWN,
  HALF_EVEN: LadinoDecimal.ROUND_HALF_EVEN,
};

/**
 * Núcleo compartido por las cuatro funciones nombradas.
 *
 * No se exporta a propósito: no debe existir un `round(value, policy)` genérico. El nombre de
 * la función es parte de la trazabilidad — al leer un asiento se sabe si aquel céntimo vino de
 * un impuesto, de un total de documento o de una liquidación de caja.
 *
 * Es falible porque aquí, y solo aquí, se comprueba la cota de `numeric(24,8)`: `ExactMoney` no
 * la conoce, así que un producto enorme se descubre justo al intentar hacerlo persistible.
 */
function applyPolicy(value: Roundable, policy: RoundingPolicy): Result<RoundedMoney, MoneyError> {
  if (!value.amount.isFinite()) {
    return err({
      code: MoneyErrorCode.INVALID_AMOUNT,
      message: "Un importe no puede ser NaN ni infinito.",
      details: { amount: value.amount.toString() },
    });
  }

  // `Roundable` es estructural, así que aquí puede llegar un literal `{ amount, currency }` con
  // una moneda que nadie validó. Sin esta comprobación saldría un `Money` con moneda fuera del
  // registro — publicable y con toda la pinta de correcto.
  if (!parseCurrency(value.currency).ok) {
    return err({
      code: MoneyErrorCode.UNKNOWN_CURRENCY,
      message: "El código de moneda no está en el registro soportado.",
      details: { code: value.currency },
    });
  }

  // Simétrico con `makeFxRate`, que rechaza una tasa sin fuente citada: un importe redondeado
  // por un criterio anónimo tampoco se puede explicar después.
  if (policy.id.trim() === "") {
    return err({
      code: MoneyErrorCode.INVALID_ROUNDING_POLICY,
      message: "Una política de redondeo necesita identificador: se persiste con el importe.",
      details: { policy },
    });
  }

  const rounded = value.amount.toDecimalPlaces(policy.scale, DECIMAL_ROUNDING[policy.mode]);
  const money = Money.fromDecimal(rounded, value.currency);
  if (!money.ok) return money;

  return ok({ value: money.value, preRound: ExactMoney.from(value), policy });
}

/**
 * ¿Es `value` el resultado de redondear `preRound` bajo `policy`?
 *
 * `RoundedMoney` es una interfaz, no una clase de constructor privado, así que cualquiera puede
 * fabricar uno a mano con un `value` que no tenga nada que ver con su `preRound`. Esta función
 * permite a `toMonetaryFact` cerrar esa entrada lateral al puente único de ADR-0023.
 */
export function isRoundingOf(rounded: RoundedMoney): boolean {
  const esperado = rounded.preRound.amount.toDecimalPlaces(
    rounded.policy.scale,
    DECIMAL_ROUNDING[rounded.policy.mode],
  );
  return (
    rounded.value.currency === rounded.preRound.currency && rounded.value.amount.equals(esperado)
  );
}

/**
 * Redondeo de presentación y saldos por moneda. **El único con default**, y no es una regla
 * tributaria: la escala son las minor units de ISO-4217 de la moneda del importe.
 */
export function roundForCurrency(value: Roundable): Result<RoundedMoney, MoneyError> {
  // Antes de nada: `Roundable` es estructural y `currencyDefinition` lanza si la moneda no está
  // registrada. Devolver `Result` es el contrato de esta función; lanzar lo rompería.
  const code = parseCurrency(value.currency);
  if (!code.ok) return code;

  const definition = currencyDefinition(code.value);
  return applyPolicy(value, {
    id: `iso4217:${definition.code}:${String(definition.minorUnits)}:${ISO_PRESENTATION_MODE}`,
    scale: definition.minorUnits,
    mode: ISO_PRESENTATION_MODE,
  });
}

/** Base imponible e impuesto. Exige política: el paquete no tiene opinión fiscal. */
export function roundForTax(
  value: Roundable,
  policy: RoundingPolicy,
): Result<RoundedMoney, MoneyError> {
  return applyPolicy(value, policy);
}

/** Subtotales y totales del documento fiscal. Exige política. */
export function roundForDocument(
  value: Roundable,
  policy: RoundingPolicy,
): Result<RoundedMoney, MoneyError> {
  return applyPolicy(value, policy);
}

/** Cobros, pagos y vuelto. Exige política. */
export function roundForPayment(
  value: Roundable,
  policy: RoundingPolicy,
): Result<RoundedMoney, MoneyError> {
  return applyPolicy(value, policy);
}

/**
 * Costeo de inventario: el costo de una salida y el costo unitario promedio (MONEY_AND_ROUNDING_SPEC
 * §6.6, ADR-0034). Quinto contexto, con nombre propio por la misma razón que los otros cuatro: al
 * leer un movimiento de kardex se sabe que ese céntimo vino del costeo, no de un impuesto ni de un
 * documento. Exige política — el paquete no decide la escala del costo, la decide el módulo que
 * lo persiste y queda en `rounding_policy_id`.
 */
export function roundForCost(
  value: Roundable,
  policy: RoundingPolicy,
): Result<RoundedMoney, MoneyError> {
  return applyPolicy(value, policy);
}

/**
 * Reparte `total` entre `weights` de forma que **la suma de las partes sea exactamente el
 * total**. Sin céntimos perdidos ni inventados.
 *
 * Algoritmo: mayor resto (Hamilton). Cada parte es un múltiplo de `10^-scale`; el sobrante de
 * unidades mínimas se reparte de una en una entre las partes con mayor resto fraccionario,
 * desempatando por índice ascendente para que el reparto sea determinista.
 *
 * **Precondición:** `total` tiene que ser múltiplo de `10^-scale`. Repartir 0.00000001 en partes
 * de escala 0 no tiene respuesta correcta —o la suma no cuadra, o alguna parte se sale de la
 * escala— así que devuelve `TOTAL_NOT_AT_SCALE` en vez de elegir por su cuenta. **No redondea el
 * total**: redondear es una decisión con nombre y con política, y no le corresponde a `allocate`.
 *
 * El signo se conserva por construcción: se reparte sobre el valor absoluto y se le devuelve el
 * signo a cada parte, así que repartir una nota de crédito es el reflejo exacto de repartir la
 * factura.
 *
 * Es lo que hace verificable el invariante 10 de ACCOUNTING_INVARIANTS_TESTS.md.
 *
 * **Ojo con §6.3:** el mayor resto NO es ninguno de los cuatro modos de absorción que la spec
 * enumera (`FIRST_LINE`, `LAST_LINE`, `LARGEST_LINE`, `PROPORTIONAL`). Con pesos iguales degenera
 * en `FIRST_LINE`, pero con pesos `[1, 2]` sobre 0.10 el céntimo cae en la **segunda** línea. El
 * parámetro `ResidualAllocation` está pendiente de implementar; hasta entonces esto es
 * `LARGEST_REMAINDER` y así hay que leerlo.
 */
export function allocate(
  total: Money,
  weights: readonly Decimal[],
  scale: Scale,
): Result<readonly Money[], MoneyError> {
  if (weights.length === 0) {
    return err({
      code: MoneyErrorCode.INVALID_WEIGHTS,
      message: "No se puede repartir entre cero partes.",
      details: { weights: [] },
    });
  }

  if (weights.some((w) => !w.isFinite() || w.isNegative())) {
    return err({
      code: MoneyErrorCode.INVALID_WEIGHTS,
      message: "Los pesos de un reparto no pueden ser negativos ni no finitos.",
      details: { weights: weights.map((w) => w.toString()) },
    });
  }

  const weightSum = weights.reduce((acc, w) => acc.plus(w), new LadinoDecimal(0));
  if (weightSum.isZero()) {
    return err({
      code: MoneyErrorCode.INVALID_WEIGHTS,
      message: "Todos los pesos son cero: no hay proporción definida.",
      details: { weights: weights.map((w) => w.toString()) },
    });
  }

  const unit = new LadinoDecimal(10).pow(-scale);
  const totalUnits = total.amount.div(unit);
  if (!totalUnits.isInteger()) {
    return err({
      code: MoneyErrorCode.TOTAL_NOT_AT_SCALE,
      message: `El total ${total.toAmountString()} no es múltiplo de la unidad mínima de la escala ${String(scale)}. Redondéalo antes con una política nombrada.`,
      details: { total: total.toAmountString(), scale },
    });
  }

  const negative = total.amount.isNegative();
  const absUnits = totalUnits.abs();

  const ideal = weights.map((w) => absUnits.times(w).div(weightSum));
  const floors = ideal.map((v) => v.floor());
  const remainders = ideal.map((v, i) => v.minus(floors[i]!));
  const distributed = floors.reduce((acc, f) => acc.plus(f), new LadinoDecimal(0));
  const leftover = absUnits.minus(distributed);

  // Mayor resto primero; empate por índice ascendente, que es lo que hace el reparto reproducible.
  const order = weights
    .map((_, i) => i)
    .sort((a, b) => {
      const cmp = remainders[b]!.comparedTo(remainders[a]!);
      return cmp !== 0 ? cmp : a - b;
    });

  const units = [...floors];
  for (let k = 0; k < leftover.toNumber(); k += 1) {
    const i = order[k % order.length]!;
    units[i] = units[i]!.plus(1);
  }

  const parts: Money[] = [];
  for (const u of units) {
    const signed = negative ? u.negated() : u;
    const part = Money.fromDecimal(signed.times(unit), total.currency);
    if (!part.ok) return part;
    parts.push(part.value);
  }

  // Postcondición comprobada, no argumentada. El invariante 10 de
  // ACCOUNTING_INVARIANTS_TESTS.md no puede depender de un razonamiento sobre la precisión de
  // `div`: si por lo que sea la suma no cuadrara, esto falla en vez de devolver un reparto que
  // descuadra un libro tres capas más allá.
  const suma = parts.reduce((acc, p) => acc.plus(p.amount), new LadinoDecimal(0));
  if (!suma.equals(total.amount)) {
    return err({
      code: MoneyErrorCode.INVALID_WEIGHTS,
      message:
        "Invariante roto: el reparto no suma el total. No se devuelve un resultado que descuadraría un asiento.",
      details: {
        total: total.toAmountString(),
        suma: suma.toFixed(),
        partes: parts.map((p) => p.toAmountString()),
      },
    });
  }

  return ok(parts);
}
