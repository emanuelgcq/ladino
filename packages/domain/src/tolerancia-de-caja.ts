import { minorUnitsOf, parseDecimal, type Decimal } from "@ladino/money";

/**
 * LA TOLERANCIA DE CAJA (ADR-0063 §2; ADR-0075, nota «el pago cruzado a tasa real»).
 *
 * El dinero real solo viene en unidades mínimas: de una cuenta en dólares salen 1,45, no
 * 1,4512. Cuando ese dinero paga un documento que vive en OTRA moneda, lo redondeado se aparta
 * de lo debido como mucho en MEDIA unidad mínima de la moneda del dinero, valorada en la moneda
 * del documento a la tasa del pago (medio céntimo de dólar a 854,4637 son 4,27 Bs). Dentro de
 * esa distancia el pago que cierra CIERRA.
 *
 * Nunca es menor que media unidad mínima de la moneda del documento: es la holgura que el tope
 * ya tenía cuando el dinero es más fino que el documento (bolívares pagando dólares).
 *
 * CUÁNDO COINCIDE CON VENTAS, EXACTAMENTE. El cobro de ventas calcula su tolerancia en línea
 * (`registerPayment`, «EL COBRO QUE CIERRA», `sales.ts`): media unidad mínima de la moneda del
 * cobro × la tasa del cobro, SIEMPRE EN MONEDA FUNCIONAL, comparada contra lo pendiente en
 * moneda funcional y sin suelo. Esta función la da EN LA MONEDA DEL DOCUMENTO, con suelo. Las dos
 * cifras son la misma solo cuando el documento vive en la moneda funcional (`tasaDocumento` = 1)
 * y el dinero vale al menos una unidad de ella (el suelo no actúa): documento en Bs, dinero en
 * USD a 854,4637 → 4,27231850 en los dos lados. NO coinciden cuando el documento vive en divisa:
 *   · documento en USD cobrado/pagado en Bs: ventas tolera 0,005 Bs funcionales; aquí queda el
 *     suelo, 0,005 USD (4,27 Bs a esa tasa);
 *   · documento en una divisa y dinero en otra: ventas mide en funcional, aquí en la divisa del
 *     documento (se divide por su tasa).
 * Lo que sí comparten siempre: sin redondear hacia arriba, y comparada con `<=`.
 * DEUDA (ADR-0075, nota «el pago cruzado a tasa real»): una sola función para los dos lados.
 * Esta ola no toca el cobro de ventas. Pura: no toca la base.
 */
export function toleranciaDeCaja(p: {
  /** La moneda en que se mueve el dinero (la de la cuenta). */
  readonly monedaDinero: string;
  /** La moneda en que vive el documento que se salda. */
  readonly monedaDocumento: string;
  /** Tasa del día del pago, moneda del dinero → moneda funcional. */
  readonly tasaDinero: Decimal;
  /** Tasa del día del pago, moneda del documento → moneda funcional. */
  readonly tasaDocumento: Decimal;
}): Decimal {
  const minima = mediaUnidad(p.monedaDocumento);
  if (p.monedaDinero === p.monedaDocumento || !p.tasaDocumento.greaterThan(0)) return minima;
  const convertida = mediaUnidad(p.monedaDinero).times(p.tasaDinero).dividedBy(p.tasaDocumento);
  return convertida.greaterThan(minima) ? convertida : minima;
}

/** Media unidad mínima de una moneda: 0,005 en VES y USD. */
function mediaUnidad(moneda: string): Decimal {
  const escala = minorUnitsOf(moneda);
  const u = parseDecimal(escala === 0 ? "1" : `0.${"0".repeat(escala - 1)}1`);
  if (!u.ok) throw new Error(`unidad mínima de ${moneda} no interpretable`);
  return u.value.dividedBy(2);
}
