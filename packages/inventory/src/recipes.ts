import { err, ok, type Result } from "@ladino/core";
import { Money, isPersistableAsNumeric, roundForCost, type Decimal } from "@ladino/money";
import { COST_ROUNDING_POLICY, type InventoryError } from "./costing.js";

/**
 * Explosión de recetas — ADR-0035. RIGOR MÁXIMO: define cuánto sale del almacén
 * y, con ello, el costo de lo que se vende.
 *
 * Puro, como todo este paquete: la conversión de unidades entra ya resuelta como
 * un factor. Buscarla es I/O (tabla `unit_conversions`) y eso es del llamante;
 * lo que aquí se garantiza es que si el factor falta, la explosión FALLA — nunca
 * se supone 1, que es exactamente el error que convertiría 200 gramos en 200
 * kilos sin que nada chille.
 *
 * ANIDAMIENTO NO SOPORTADO en esta iteración (ADR-0035 §Anidamiento): un
 * ingrediente no puede ser a su vez compuesto, y el esquema lo fuerza (LAD44).
 * Por eso esta función explota UN nivel y no recursa.
 */

/** Una línea de receta ya resuelta: cuánto del hijo lleva UNA unidad del padre. */
export interface RecipeLine {
  readonly childProductId: string;
  /** Cantidad en la unidad de la LÍNEA. */
  readonly quantity: Decimal;
  /**
   * Factor de la unidad de la línea a la unidad BASE del producto hijo, ya
   * buscado en `unit_conversions`. `null` = no hay conversión cargada, y
   * entonces esto no se consume: se rechaza.
   */
  readonly factorToProductUnit: Decimal | null;
  /** Para el mensaje de error, que tiene que decir QUÉ conversión falta. */
  readonly lineUnitCode: string;
  readonly productUnitCode: string;
}

/** Lo que hay que sacar del almacén por un ingrediente. */
export interface ExplodedLine {
  readonly childProductId: string;
  /** Cantidad en la unidad del PRODUCTO, que es como se persiste el movimiento. */
  readonly quantity: Decimal;
}

/**
 * Cuánto de cada ingrediente sale al producir/vender `times` unidades del
 * compuesto.
 *
 * El orden de las operaciones no es indiferente: se multiplica
 * `cantidad × factor × times` en UN solo producto exacto y se redondea a 8
 * decimales AL FINAL. Redondear el factor primero, o la conversión antes de
 * multiplicar por las unidades vendidas, acumula el error por línea y por venta
 * — el mismo motivo por el que `convert()` de money no redondea.
 *
 * **CONSECUENCIA QUE HAY QUE SABER, y que encontró el property test:** con eso,
 * vender 12 arepas de una vez y venderlas de una en una pueden consumir
 * cantidades distintas, en menos de `(n+1)/2` unidades de 10⁻⁸. La linealidad
 * EXACTA es imposible a escala finita: o se redondea una vez (y el total depende
 * de si la venta fue en bloque) o se redondea por unidad (y se acumula el error
 * en cada una). Se elige redondear al final porque es lo más cercano al consumo
 * real y porque el error no crece con el volumen del día, solo con el tamaño de
 * la venta. En recetas reales —200 g de una harina que se lleva en kg— el
 * producto es exacto y la diferencia es cero; solo aparece cuando la cantidad de
 * receta ya tiene ocho decimales.
 */
export function explodeRecipe(
  lines: readonly RecipeLine[],
  times: Decimal,
): Result<readonly ExplodedLine[], InventoryError> {
  if (lines.length === 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un producto compuesto sin receta no se puede vender: no consumiría nada.",
    });
  }
  if (!times.isFinite() || times.lessThanOrEqualTo(0)) {
    return err({
      code: "INVALID_QUANTITY",
      message: "Las unidades del compuesto deben ser estrictamente positivas.",
    });
  }

  const out: ExplodedLine[] = [];
  for (const line of lines) {
    if (line.factorToProductUnit === null) {
      return err({
        code: "UNIT_CONVERSION_MISSING",
        message: `No hay conversión de ${line.lineUnitCode} a ${line.productUnitCode}: cárgala en unit_conversions. El sistema no la adivina.`,
        details: { from: line.lineUnitCode, to: line.productUnitCode },
      });
    }
    if (line.quantity.lessThanOrEqualTo(0)) {
      return err({
        code: "INVALID_QUANTITY",
        message: "Una línea de receta con cantidad cero o negativa no es una receta.",
      });
    }
    // Un solo producto exacto, un solo redondeo al final.
    const exacto = line.quantity.times(line.factorToProductUnit).times(times);
    const cantidad = exacto.toDecimalPlaces(8, 4 /* ROUND_HALF_UP, igual que el esquema */);
    if (!isPersistableAsNumeric(cantidad)) {
      return err({
        code: "INVALID_QUANTITY",
        message: `El consumo de un ingrediente no cabe en numeric(24,8): ${exacto.toString()}.`,
        details: { childProductId: line.childProductId },
      });
    }
    if (cantidad.isZero()) {
      // 0.000000004 g × 1 unidad redondea a cero. Sacar cero del almacén no es
      // un movimiento: es un movimiento que el CHECK de quantity rechazaría, y
      // decirlo aquí da un mensaje que se entiende.
      return err({
        code: "INVALID_QUANTITY",
        message: `El consumo del ingrediente redondea a cero con esta cantidad (${exacto.toString()}): revisa la receta o la unidad.`,
        details: { childProductId: line.childProductId },
      });
    }
    out.push({ childProductId: line.childProductId, quantity: cantidad });
  }
  return ok(out);
}

/**
 * Costo total de un consumo: la suma de lo que costó CADA salida real.
 *
 * No es «cantidad × costo estimado»: es la suma de los importes que el costeo
 * por promedio produjo para cada ingrediente. La estimación previa
 * (`platform.recipe_cost`) sirve para enseñar un número en pantalla; esto es lo
 * que de verdad salió del inventario, y es lo que la contabilidad usará como
 * COGS.
 */
export function totalCost(costs: readonly Money[]): Result<Money, InventoryError> {
  const primero = costs[0];
  if (primero === undefined) {
    return err({ code: "VALIDATION_FAILED", message: "No hay costos que sumar." });
  }
  let total = Money.zero(primero.currency);
  for (const c of costs) {
    const suma = total.add(c);
    if (!suma.ok) {
      // Los códigos de money van prefijados (`MONEY_CURRENCY_MISMATCH`): se
      // compara por el sufijo para no acoplar este paquete a la cadena exacta.
      return err({
        code: suma.error.code.endsWith("CURRENCY_MISMATCH") ? "CURRENCY_MISMATCH" : "MONEY",
        message: suma.error.message,
      });
    }
    total = suma.value;
  }
  // Pasa por el mismo puente que todo lo demás: el total se persiste, así que se
  // redondea con la política nombrada aunque ya venga a escala.
  const r = roundForCost(total, COST_ROUNDING_POLICY);
  if (!r.ok) return err({ code: "MONEY", message: r.error.message });
  return ok(r.value.value);
}
