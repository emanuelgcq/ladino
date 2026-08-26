import { err, ok, type Result } from "@ladino/core";
import {
  ExactMoney,
  Money,
  isPersistableAsNumeric,
  parseDecimal,
  roundForCost,
  type CurrencyCode,
  type Decimal,
  type MoneyError,
  type RoundingPolicy,
} from "@ladino/money";

/**
 * Costeo de inventario — PROMEDIO PONDERADO MÓVIL (ADR-0034, decisión 1 del módulo).
 *
 * Paquete puro: recibe la posición de existencias y devuelve la posición nueva más el
 * movimiento valorado. No lee reloj, no toca base de datos, no conoce almacenes: la
 * granularidad (company, almacén, producto, lote) la decide quien lo llama.
 *
 * Lo que este módulo garantiza y los tests de propiedad exigen:
 *   · el VALOR de la posición tras N movimientos es EXACTAMENTE la suma de las entradas menos
 *     el costo de las salidas — el valor se lleva por sumas y restas de importes ya
 *     redondeados, nunca se recalcula como cantidad × promedio;
 *   · recorrer los mismos movimientos en el mismo orden da el mismo resultado (determinismo,
 *     criterio «costeo reproducible» de INVENTORY_SPEC);
 *   · el promedio se recalcula en cada entrada, y el costo unitario RESULTANTE se proyecta a
 *     8 decimales con `roundForCost` bajo la política de abajo, que se persiste con el
 *     movimiento (ADR-0024).
 *
 * El método es DATO en la configuración de la empresa (`inventory_settings.costing_method`);
 * hoy solo existe uno. Añadir FIFO es añadir un módulo aquí, no rehacer este.
 */

/** Política de redondeo del costeo (MONEY_AND_ROUNDING_SPEC §6.6). Se persiste en cada movimiento. */
export const COST_ROUNDING_POLICY: RoundingPolicy = Object.freeze({
  id: "inventory:cost:8:HALF_UP",
  scale: 8,
  mode: "HALF_UP",
});

/**
 * Métodos de costeo soportados. El tipo se escribe como unión literal EXPLÍCITA y
 * no como `(typeof COSTING_METHODS)[number]`: el gate `api-surface` prohíbe la
 * palabra `number` en toda la API pública sin excepciones —es lo que lo hace un
 * gate y no una recomendación—, y ahí `[number]` es indexación, no un importe.
 * Añadir FIFO es añadir el literal aquí y la fila en el CHECK de la migración.
 */
export type CostingMethod = "promedio_ponderado_movil";
export const COSTING_METHODS: readonly CostingMethod[] = ["promedio_ponderado_movil"];

export type InventoryErrorCode =
  "INVALID_QUANTITY" | "NEGATIVE_STOCK" | "CURRENCY_MISMATCH" | "MONEY";

export interface InventoryError {
  readonly code: InventoryErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

/**
 * Posición de existencias en MONEDA FUNCIONAL (ADR-0020: el promedio se calcula siempre en
 * funcional). `lastUnitCost` es el último promedio conocido con existencia positiva: es lo que
 * valora una salida cuando la existencia es cero o negativa (política explícita de negativo),
 * porque con cantidad ≤ 0 el cociente valor/cantidad no significa nada.
 */
export interface StockPosition {
  readonly quantity: Decimal;
  readonly value: Money;
  readonly lastUnitCost: Money;
}

/** Un movimiento valorado. `quantity` y `value` van CON SIGNO: entrada > 0, salida < 0. */
export interface CostedMove {
  readonly quantity: Decimal;
  readonly value: Money;
  /** Costo unitario promedio RESULTANTE tras el movimiento (proyección a 8 decimales). */
  readonly unitCostAfter: Money;
  readonly quantityAfter: Decimal;
  readonly valueAfter: Money;
}

export interface Costed {
  readonly move: CostedMove;
  readonly position: StockPosition;
}

const money = (e: MoneyError): InventoryError => ({
  code: "MONEY",
  message: e.message,
  details: { moneyCode: e.code, ...(e.details ?? {}) },
});

export function emptyPosition(currency: CurrencyCode): StockPosition {
  return Object.freeze({
    quantity: parseQuantityOrZero(),
    value: Money.zero(currency),
    lastUnitCost: Money.zero(currency),
  });
}

function parseQuantityOrZero(): Decimal {
  const z = parseDecimal("0");
  if (!z.ok) throw new Error("invariante roto: '0' no parsea");
  return z.value;
}

/** Construye una posición desde lo que viene de la base (strings de numeric(24,8)). */
export function positionOf(input: {
  readonly quantity: string;
  readonly value: string;
  readonly lastUnitCost: string;
  readonly currency: string;
}): Result<StockPosition, InventoryError> {
  const q = parseDecimal(input.quantity);
  if (!q.ok) return err(money(q.error));
  const v = Money.of(input.value, input.currency);
  if (!v.ok) return err(money(v.error));
  const u = Money.of(input.lastUnitCost, input.currency);
  if (!u.ok) return err(money(u.error));
  if (u.value.isNegative()) {
    return err({
      code: "MONEY",
      message: "El costo unitario no puede ser negativo.",
      details: { lastUnitCost: input.lastUnitCost },
    });
  }
  return ok(Object.freeze({ quantity: q.value, value: v.value, lastUnitCost: u.value }));
}

/**
 * Cantidad de un movimiento: decimal plano, > 0, con la escala y cota de numeric(24,8). El
 * signo lo pone la operación (entrada/salida), no el dato.
 */
export function parseQuantity(value: string): Result<Decimal, InventoryError> {
  const d = parseDecimal(value);
  if (!d.ok) return err({ code: "INVALID_QUANTITY", message: d.error.message, details: { value } });
  if (!d.value.isFinite() || d.value.lessThanOrEqualTo(0)) {
    return err({
      code: "INVALID_QUANTITY",
      message: "La cantidad de un movimiento debe ser estrictamente positiva.",
      details: { value },
    });
  }
  if (!isPersistableAsNumeric(d.value)) {
    return err({
      code: "INVALID_QUANTITY",
      message: "La cantidad no cabe en numeric(24,8): como mucho 16 enteros y 8 decimales.",
      details: { value },
    });
  }
  return ok(d.value);
}

/**
 * ¿Tiene sentido el cociente valor/cantidad? Solo con cantidad > 0 Y valor ≥ 0. Una posición
 * negativa (política explícita) o con valor negativo tras regularizar cantidad con una entrada
 * barata NO define un promedio: se arrastra el último conocido y el residuo queda VISIBLE en el
 * valor (ADR-0034 §Negativo). Nunca un costo unitario negativo persistido.
 */
export function hasMeaningfulAverage(quantity: Decimal, value: Money): boolean {
  return quantity.greaterThan(0) && !value.isNegative();
}

/** Proyección del promedio a 8 decimales, o el último conocido si el cociente no significa nada. */
function unitCostAfter(
  quantityAfter: Decimal,
  valueAfter: Money,
  carried: Money,
): Result<Money, InventoryError> {
  if (!hasMeaningfulAverage(quantityAfter, valueAfter)) return ok(carried);
  const rounded = roundForCost(
    { amount: valueAfter.amount.div(quantityAfter), currency: valueAfter.currency },
    COST_ROUNDING_POLICY,
  );
  if (!rounded.ok) return err(money(rounded.error));
  return ok(rounded.value.value);
}

function sameCurrency(position: StockPosition, amount: Money): InventoryError | null {
  if (position.value.currency !== amount.currency) {
    return {
      code: "CURRENCY_MISMATCH",
      message:
        "El costo debe venir en la moneda funcional de la posición: el promedio se calcula siempre en moneda funcional (ADR-0020).",
      details: { posicion: position.value.currency, importe: amount.currency },
    };
  }
  return null;
}

function finish(
  position: StockPosition,
  quantity: Decimal,
  value: Money,
): Result<Costed, InventoryError> {
  const quantityAfter = position.quantity.plus(quantity);
  const valueAfter = position.value.add(value);
  if (!valueAfter.ok) return err(money(valueAfter.error));
  const unit = unitCostAfter(quantityAfter, valueAfter.value, position.lastUnitCost);
  if (!unit.ok) return unit;
  return ok(
    Object.freeze({
      move: Object.freeze({
        quantity,
        value,
        unitCostAfter: unit.value,
        quantityAfter,
        valueAfter: valueAfter.value,
      }),
      position: Object.freeze({
        quantity: quantityAfter,
        value: valueAfter.value,
        lastUnitCost: unit.value,
      }),
    }),
  );
}

/**
 * ENTRADA: la cantidad entra al costo dado (ya en moneda funcional y ya redondeado por quien
 * convirtió — ADR-0020: los siete campos son de quien persiste, aquí llega el funcional). El
 * promedio se recalcula: (valor + costo) / (cantidad + q).
 */
export function receive(
  position: StockPosition,
  quantity: Decimal,
  cost: Money,
): Result<Costed, InventoryError> {
  if (quantity.lessThanOrEqualTo(0)) {
    return err({ code: "INVALID_QUANTITY", message: "Una entrada exige cantidad positiva." });
  }
  const mismatch = sameCurrency(position, cost);
  if (mismatch) return err(mismatch);
  if (cost.isNegative()) {
    return err({ code: "MONEY", message: "El costo de una entrada no puede ser negativo." });
  }
  return finish(position, quantity, cost);
}

/**
 * Costo de una SALIDA de `quantity` unidades desde `position`, exacto y con la regla de
 * ADR-0034 §Costeo:
 *   · 0 < q < existencia: round8(valor × q / existencia);
 *   · q = existencia: TODO el valor (la posición cierra en cero exacto, sin residuo);
 *   · q > existencia > 0: todo el valor + round8((q − existencia) × promedio) — la parte que
 *     deja la posición en negativo se valora al promedio vigente;
 *   · sin promedio significativo (existencia ≤ 0, o valor < 0): round8(q × lastUnitCost).
 * El esquema verifica esta misma regla con multiplicaciones exactas (LAD41).
 */
export function issueCost(
  position: StockPosition,
  quantity: Decimal,
): Result<Money, InventoryError> {
  const currency = position.value.currency;
  const q = quantity;
  const have = position.quantity;
  if (!hasMeaningfulAverage(have, position.value)) {
    return round(ExactMoney.from(position.lastUnitCost).multiply(q));
  }
  if (q.equals(have)) return ok(position.value);
  if (q.lessThan(have)) {
    return round(ExactMoney.from({ amount: position.value.amount.times(q).div(have), currency }));
  }
  const average = position.value.amount.div(have);
  const beyond = round(ExactMoney.from({ amount: q.minus(have).times(average), currency }));
  if (!beyond.ok) return beyond;
  const total = position.value.add(beyond.value);
  if (!total.ok) return err(money(total.error));
  return ok(total.value);
}

function round(value: ExactMoney): Result<Money, InventoryError> {
  const r = roundForCost(value, COST_ROUNDING_POLICY);
  if (!r.ok) return err(money(r.error));
  return ok(r.value.value);
}

/**
 * SALIDA al promedio. Sin `allowNegative`, una salida mayor que la existencia es
 * NEGATIVE_STOCK — nunca negativo silencioso (decisión 2). Con ella, la posición queda en
 * negativo y valorada (issueCost).
 */
export function issue(
  position: StockPosition,
  quantity: Decimal,
  options: { readonly allowNegative: boolean },
): Result<Costed, InventoryError> {
  if (quantity.lessThanOrEqualTo(0)) {
    return err({ code: "INVALID_QUANTITY", message: "Una salida exige cantidad positiva." });
  }
  if (!options.allowNegative && quantity.greaterThan(position.quantity)) {
    return err({
      code: "NEGATIVE_STOCK",
      message: "La salida deja la existencia en negativo y la empresa no lo permite.",
      details: { existencia: position.quantity.toFixed(), salida: quantity.toFixed() },
    });
  }
  const cost = issueCost(position, quantity);
  if (!cost.ok) return cost;
  return finish(position, quantity.negated(), cost.value.negate());
}

/**
 * AJUSTE: un delta con signo. Positivo entra al costo unitario dado o, si no se da, al
 * promedio vigente (`lastUnitCost`). Negativo sale como una salida.
 */
export function adjust(
  position: StockPosition,
  delta: Decimal,
  options: { readonly allowNegative: boolean; readonly unitCost?: Money },
): Result<Costed, InventoryError> {
  if (!delta.isFinite() || delta.isZero()) {
    return err({ code: "INVALID_QUANTITY", message: "Un ajuste exige un delta distinto de cero." });
  }
  if (delta.isNegative()) return issue(position, delta.negated(), options);
  const unit = options.unitCost ?? position.lastUnitCost;
  const mismatch = sameCurrency(position, unit);
  if (mismatch) return err(mismatch);
  const cost = round(ExactMoney.from(unit).multiply(delta));
  if (!cost.ok) return cost;
  return receive(position, delta, cost.value);
}

export type MoveInput =
  | { readonly kind: "receive"; readonly quantity: Decimal; readonly cost: Money }
  | { readonly kind: "issue"; readonly quantity: Decimal }
  | { readonly kind: "adjust"; readonly delta: Decimal; readonly unitCost?: Money };

/** Recorre movimientos en orden. Es lo que los tests de determinismo comparan consigo mismo. */
export function replay(
  initial: StockPosition,
  moves: readonly MoveInput[],
  options: { readonly allowNegative: boolean },
): Result<
  { readonly position: StockPosition; readonly moves: readonly CostedMove[] },
  InventoryError
> {
  let position = initial;
  const out: CostedMove[] = [];
  for (const m of moves) {
    const r =
      m.kind === "receive"
        ? receive(position, m.quantity, m.cost)
        : m.kind === "issue"
          ? issue(position, m.quantity, options)
          : adjust(position, m.delta, {
              ...options,
              ...(m.unitCost ? { unitCost: m.unitCost } : {}),
            });
    if (!r.ok) return r;
    position = r.value.position;
    out.push(r.value.move);
  }
  return ok({ position, moves: out });
}
