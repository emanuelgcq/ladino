import { err, ok, type Result } from "@ladino/core";
import {
  Money,
  parseDecimal,
  roundForCost,
  type Decimal,
  type RoundingPolicy,
} from "@ladino/money";

/**
 * @ladino/purchases — prorrateo de landed cost, cálculo de retenciones y
 * matching de tres vías. PURO.
 *
 * Solo `core` y `money`. **Ni un porcentaje de retención escrito aquí**: el que
 * se aplica llega como argumento, resuelto por `platform.resolve_retention()`
 * (ADR-0039). Un `grep` de números tributarios en este paquete no encuentra
 * nada, y eso es comprobable.
 *
 * Es el paquete donde un error silencioso hace más daño: un costo unitario mal
 * prorrateado se propaga a TODAS las ventas posteriores de ese producto, y no
 * falla nada — solo el margen sale mal para siempre.
 */

export type PurchaseErrorCode =
  | "INVALID_QUANTITY"
  | "INVALID_AMOUNT"
  | "EMPTY_ALLOCATION"
  | "MISSING_WEIGHT"
  | "ZERO_BASE"
  | "UNKNOWN_FORMULA"
  | "MONEY";

export interface PurchaseError {
  readonly code: PurchaseErrorCode;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

// ── Landed cost ─────────────────────────────────────────────────────────────

/** Los tres métodos de ADR-0040 §5. Union escrita a mano: el gate de superficie
 *  de la API prohíbe el literal `number` en los `.d.ts` publicados, y derivarla
 *  de un array con `(typeof M)[number]` lo introduce. */
export type AllocationMethod = "by_value" | "by_weight" | "by_units";

/** Una línea de recepción, con lo que hace falta para prorratear sobre ella. */
export interface AllocatableLine {
  readonly lineId: string;
  readonly quantityReceived: Decimal;
  /** Cuánto queda EN EXISTENCIA de lo recibido en esta línea, hoy. */
  readonly quantityRemaining: Decimal;
  /** Valor funcional de la línea: la base de `by_value`. */
  readonly valueFunctional: Money;
  /** Peso unitario. `null` cuando el producto no lo tiene: `by_weight` falla. */
  readonly unitWeight: Decimal | null;
}

export interface LineAllocation {
  readonly lineId: string;
  /** Total del gasto que le toca a esta línea. */
  readonly allocated: Money;
  /** La parte que revaloriza el inventario: la de las unidades que quedan. */
  readonly toInventory: Money;
  /** La parte que es VARIACIÓN: la de las unidades ya salidas. */
  readonly toVariance: Money;
  /** La base con la que se prorrateó, guardada para reproducir el cálculo. */
  readonly base: Decimal;
}

export interface Allocation {
  readonly method: AllocationMethod;
  readonly lines: readonly LineAllocation[];
  /** Σ allocated. Igual al gasto, por construcción y comprobado. */
  readonly totalAllocated: Money;
  readonly totalToInventory: Money;
  readonly totalToVariance: Money;
}

function base(line: AllocatableLine, method: AllocationMethod): Result<Decimal, PurchaseError> {
  if (method === "by_value") return ok(line.valueFunctional.amount);
  if (method === "by_units") return ok(line.quantityReceived);
  if (line.unitWeight === null) {
    return err({
      code: "MISSING_WEIGHT",
      message:
        "Prorratear por peso exige que TODAS las líneas tengan peso. Sin uno, el flete se repartiría solo entre lo que sí pesa y encarecería de más esa mercancía.",
      details: { lineId: line.lineId },
    });
  }
  return ok(line.quantityReceived.times(line.unitWeight));
}

/**
 * Prorratea un gasto entre las líneas de una recepción, y reparte lo de cada
 * línea entre INVENTARIO y VARIACIÓN según lo que quede en existencia
 * (ADR-0040 §6).
 *
 * El residuo del redondeo va a la línea de MAYOR BASE, y si empatan gana la
 * PRIMERA del array —el orden en que las pasa el llamante, que es el de las
 * líneas del documento—. No es cosmética: sin una regla explícita,
 * `Σ asignado ≠ gasto` y
 * el `CHECK` de la base rechaza la operación entera. Y tiene que ser
 * determinista, o dos ejecuciones del mismo prorrateo darían repartos distintos.
 *
 * La parte de variación NO se prorratea sobre lo que queda. Hacerlo encarecería
 * unidades que no incurrieron en ese costo y ensuciaría el margen de todas las
 * ventas siguientes de ese producto.
 */
export function allocateLandedCost(input: {
  readonly amount: Money;
  readonly method: AllocationMethod;
  readonly lines: readonly AllocatableLine[];
  readonly policy: RoundingPolicy;
}): Result<Allocation, PurchaseError> {
  if (input.lines.length === 0) {
    return err({
      code: "EMPTY_ALLOCATION",
      message: "No hay líneas sobre las que prorratear el gasto.",
    });
  }
  if (!input.amount.amount.isFinite() || input.amount.amount.lessThanOrEqualTo(0)) {
    return err({
      code: "INVALID_AMOUNT",
      message: "El gasto a prorratear debe ser estrictamente positivo.",
    });
  }

  const cero = parseDecimal("0");
  if (!cero.ok) return err({ code: "MONEY", message: cero.error.message });

  const bases: Decimal[] = [];
  let totalBase = cero.value;
  for (const l of input.lines) {
    if (!l.quantityReceived.isFinite() || l.quantityReceived.lessThanOrEqualTo(0)) {
      return err({
        code: "INVALID_QUANTITY",
        message: "Una línea con cantidad recibida no positiva no puede recibir prorrateo.",
        details: { lineId: l.lineId },
      });
    }
    if (l.quantityRemaining.greaterThan(l.quantityReceived) || l.quantityRemaining.isNegative()) {
      return err({
        code: "INVALID_QUANTITY",
        message: "Lo que queda en existencia no puede ser mayor que lo recibido ni negativo.",
        details: { lineId: l.lineId },
      });
    }
    const b = base(l, input.method);
    if (!b.ok) return b;
    bases.push(b.value);
    totalBase = totalBase.plus(b.value);
  }
  if (totalBase.lessThanOrEqualTo(0)) {
    return err({
      code: "ZERO_BASE",
      message:
        "La base total del prorrateo es cero: no hay forma no arbitraria de repartir el gasto.",
      details: { method: input.method },
    });
  }

  // El reparto proporcional, redondeado línea a línea, y el residuo al final.
  const parciales: Decimal[] = [];
  let sumaParcial = cero.value;
  for (const b of bases) {
    const bruto = input.amount.amount.times(b).dividedBy(totalBase);
    const redondeado = roundForCost(
      { amount: bruto, currency: input.amount.currency },
      input.policy,
    );
    if (!redondeado.ok) return err({ code: "MONEY", message: redondeado.error.message });
    parciales.push(redondeado.value.value.amount);
    sumaParcial = sumaParcial.plus(redondeado.value.value.amount);
  }

  const residuo = input.amount.amount.minus(sumaParcial);
  if (!residuo.isZero()) {
    // Mayor base gana; el empate lo rompe el ORDEN DEL ARRAY, que es el de las
    // líneas del documento. Se compara con `>` estricto para que la primera
    // línea empatada se quede con el residuo: determinista, que es lo que hace
    // reproducible el prorrateo.
    let ganador = 0;
    for (let i = 1; i < bases.length; i += 1) {
      if (bases[i]!.greaterThan(bases[ganador]!)) ganador = i;
    }
    parciales[ganador] = parciales[ganador]!.plus(residuo);
  }

  const salida: LineAllocation[] = [];
  let totalInv = cero.value;
  let totalVar = cero.value;
  for (let i = 0; i < input.lines.length; i += 1) {
    const l = input.lines[i]!;
    const asignado = parciales[i]!;
    // Por unidad recibida, y solo lo de las que quedan revaloriza. La resta
    // —en vez de calcular la variación por separado— garantiza que las dos
    // partes sumen exactamente lo asignado, que es lo que el CHECK exige.
    const porUnidad = asignado.dividedBy(l.quantityReceived);
    const invBruto = porUnidad.times(l.quantityRemaining);
    const inv = roundForCost({ amount: invBruto, currency: input.amount.currency }, input.policy);
    if (!inv.ok) return err({ code: "MONEY", message: inv.error.message });
    const variacion = asignado.minus(inv.value.value.amount);

    const mAsignado = Money.of(asignado.toFixed(input.policy.scale), input.amount.currency);
    const mVariacion = Money.of(variacion.toFixed(input.policy.scale), input.amount.currency);
    if (!mAsignado.ok || !mVariacion.ok) {
      return err({ code: "MONEY", message: "Importe fuera de rango al prorratear." });
    }
    salida.push({
      lineId: l.lineId,
      allocated: mAsignado.value,
      toInventory: inv.value.value,
      toVariance: mVariacion.value,
      base: bases[i]!,
    });
    totalInv = totalInv.plus(inv.value.value.amount);
    totalVar = totalVar.plus(variacion);
  }

  const tInv = Money.of(totalInv.toFixed(input.policy.scale), input.amount.currency);
  const tVar = Money.of(totalVar.toFixed(input.policy.scale), input.amount.currency);
  if (!tInv.ok || !tVar.ok) {
    return err({ code: "MONEY", message: "Total fuera de rango al prorratear." });
  }
  return ok({
    method: input.method,
    lines: salida,
    totalAllocated: input.amount,
    totalToInventory: tInv.value,
    totalToVariance: tVar.value,
  });
}

// ── Retenciones ─────────────────────────────────────────────────────────────

/** Vocabulario CERRADO de ADR-0039 §3. Dos formas, y nada evaluado en runtime. */
export type RetentionFormula = "rate" | "rate_minus_subtrahend";

export interface RetentionRule {
  readonly formulaKind: RetentionFormula;
  readonly rate: Decimal;
  /** Obligatorio en `rate_minus_subtrahend`, prohibido en `rate`. */
  readonly subtrahend: Decimal | null;
  readonly minimumExempt: Decimal | null;
}

/**
 * Calcula una retención. **Ningún porcentaje vive aquí**: la regla entera llega
 * como argumento, resuelta por el esquema con su fuente legal.
 *
 * Es el gemelo de `platform.compute_retention()`, y que sean dos
 * implementaciones es deliberado: la de SQL es el oráculo contra el que se
 * comprueba esta, igual que `apply_inventory_move` verifica el costeo (LAD41).
 * Si divergen, el test lo dice antes que una fiscalización.
 */
export function computeRetention(input: {
  readonly base: Money;
  readonly rule: RetentionRule;
  readonly policy: RoundingPolicy;
}): Result<Money, PurchaseError> {
  const { base: importe, rule } = input;
  if (!importe.amount.isFinite() || importe.amount.isNegative()) {
    return err({ code: "INVALID_AMOUNT", message: "La base de retención no puede ser negativa." });
  }
  if (!rule.rate.isFinite() || rule.rate.isNegative() || rule.rate.greaterThan(1)) {
    return err({
      code: "INVALID_AMOUNT",
      message: "El porcentaje de retención tiene que estar entre 0 y 1.",
    });
  }

  if (rule.formulaKind === "rate") {
    if (rule.subtrahend !== null || rule.minimumExempt !== null) {
      return err({
        code: "UNKNOWN_FORMULA",
        message:
          "Una regla `rate` con sustraendo o mínimo exento es una regla mal entendida: la base la rechaza al insertarla y aquí también.",
      });
    }
    const r = roundForCost(
      { amount: importe.amount.times(rule.rate), currency: importe.currency },
      input.policy,
    );
    if (!r.ok) return err({ code: "MONEY", message: r.error.message });
    return ok(r.value.value);
  }

  if (rule.formulaKind === "rate_minus_subtrahend") {
    if (rule.subtrahend === null) {
      return err({
        code: "UNKNOWN_FORMULA",
        message: "La fórmula `rate_minus_subtrahend` exige un sustraendo.",
      });
    }
    // El mínimo exento se comprueba ANTES de restar. Aplicar la fórmula igual y
    // dejar que el max() lo lleve a cero da el mismo número por el camino
    // equivocado: en cuanto el sustraendo cambie, dejaría de coincidir.
    if (rule.minimumExempt !== null && importe.amount.lessThan(rule.minimumExempt)) {
      const cero = Money.of((0).toFixed(input.policy.scale), importe.currency);
      if (!cero.ok) return err({ code: "MONEY", message: cero.error.message });
      return ok(cero.value);
    }
    const bruto = roundForCost(
      { amount: importe.amount.times(rule.rate), currency: importe.currency },
      input.policy,
    );
    if (!bruto.ok) return err({ code: "MONEY", message: bruto.error.message });
    const neto = bruto.value.value.amount.minus(rule.subtrahend);
    const final = neto.isNegative() ? importe.amount.times(0) : neto;
    const m = Money.of(final.toFixed(input.policy.scale), importe.currency);
    if (!m.ok) return err({ code: "MONEY", message: m.error.message });
    return ok(m.value);
  }

  return err({
    code: "UNKNOWN_FORMULA",
    message:
      "Fórmula de retención desconocida. El vocabulario es CERRADO (ADR-0039 §3): una forma nueva entra con su migración y su ADR, no por configuración.",
  });
}

// ── Matching de tres vías ───────────────────────────────────────────────────

export interface MatchInput {
  readonly lineId: string;
  readonly quantityOrdered: Decimal | null;
  readonly quantityReceived: Decimal | null;
  readonly quantityInvoiced: Decimal;
  readonly priceOrdered: Decimal | null;
  readonly priceInvoiced: Decimal;
}

export type MatchIssue = "PRICE_ABOVE_TOLERANCE" | "QUANTITY_MISMATCH" | "NO_ORDER" | "NO_RECEIPT";

export interface MatchResult {
  readonly lineId: string;
  readonly priceDiffPct: Decimal | null;
  readonly issues: readonly MatchIssue[];
  /** true si la línea necesita la aprobación extra de variación de precio. */
  readonly requiresApproval: boolean;
}

/**
 * Cruza orden, recepción y factura. **El precio tolera; la cantidad no**
 * (ADR-0040 §8): una diferencia de cantidad no es un redondeo, es una recepción
 * que falta o un error, y taparla con un umbral escondería mercancía facturada
 * y no recibida.
 *
 * La función no decide qué hacer: informa. La política —el umbral— llega como
 * argumento desde `purchase_settings`, y quien bloquea es el caso de uso.
 */
export function matchThreeWay(input: {
  readonly lines: readonly MatchInput[];
  readonly priceTolerancePct: Decimal;
}): Result<readonly MatchResult[], PurchaseError> {
  if (input.priceTolerancePct.isNegative() || !input.priceTolerancePct.isFinite()) {
    return err({ code: "INVALID_AMOUNT", message: "El umbral de precio no puede ser negativo." });
  }
  const salida: MatchResult[] = [];
  for (const l of input.lines) {
    const issues: MatchIssue[] = [];
    let diff: Decimal | null = null;

    if (l.priceOrdered === null) {
      issues.push("NO_ORDER");
    } else if (l.priceOrdered.isZero()) {
      // Un precio pactado de cero con factura distinta de cero es 100 % de
      // diferencia, no una división por cero que reviente el matching.
      diff = l.priceInvoiced.isZero() ? l.priceInvoiced : l.priceInvoiced.times(0).plus(100);
    } else {
      diff = l.priceInvoiced.minus(l.priceOrdered).abs().times(100).dividedBy(l.priceOrdered);
    }
    if (diff !== null && diff.greaterThan(input.priceTolerancePct)) {
      issues.push("PRICE_ABOVE_TOLERANCE");
    }

    if (l.quantityReceived === null) {
      issues.push("NO_RECEIPT");
    } else if (!l.quantityInvoiced.equals(l.quantityReceived)) {
      issues.push("QUANTITY_MISMATCH");
    }

    salida.push({
      lineId: l.lineId,
      priceDiffPct: diff,
      issues,
      requiresApproval: issues.includes("PRICE_ABOVE_TOLERANCE"),
    });
  }
  return ok(salida);
}

/** Cantidad como string decimal → `Decimal`, con el error del dominio. */
export function parseQuantity(raw: string): Result<Decimal, PurchaseError> {
  const d = parseDecimal(raw);
  if (!d.ok) return err({ code: "INVALID_QUANTITY", message: d.error.message });
  return ok(d.value);
}
