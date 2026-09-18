import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import { parseDecimal } from "@ladino/money";
import type {
  RegisterArrivalRequest,
  ArrivalResponse,
  ReceiveGoodsRequest,
  RegisterSupplierInvoiceRequest,
  InventoryMoveResponse,
  SupplierPaymentResponse,
} from "@ladino/schemas";
import { receiveStock, totalDeEntrada, unitarioDeEntrada } from "./inventory.js";
import {
  applyLandedCost,
  receiveGoods,
  registerSupplierInvoice,
  registerSupplierPayment,
} from "./purchases.js";

/**
 * LA LLEGADA DE MERCANCÍA (ADR-0066) — la única puerta por la que la mercancía entra al
 * negocio, y el único sitio donde se decide cuál de las cuatro salidas contables le toca.
 *
 * La persona describe el hecho —de quién vino, qué llegó, si hay factura, si ya se pagó— y
 * ESTE caso de uso deriva el asiento. Nunca al revés: elegir la contrapartida contable eligiendo
 * una pantalla es lo que este ADR cierra.
 *
 * Las cuatro salidas:
 *   · `own`         — ya era tuya (inventario inicial, aporte): inventario contra aportes;
 *   · `receipt`     — de un proveedor, la factura viene después: inventario contra «mercancía
 *                     recibida por facturar»;
 *   · `invoiced`    — de un proveedor, con su factura: libro de compras, crédito fiscal o IVA al
 *                     costo según el contribuyente, retención si hay regla;
 *   · `unsupported` — de un proveedor, sin factura y sin que vaya a haberla: entra al costo
 *                     pagado, el dinero sale o queda deuda, FUERA del libro y sin crédito fiscal.
 *
 * TODO OCURRE EN UNA TRANSACCIÓN. Si la pantalla encadenara tres llamadas, una caída a mitad
 * dejaría mercancía dentro y factura fuera; por eso la puerta es un caso de uso y no un guion
 * del navegador (regla de la casa: la UI invoca UN caso de uso transaccional).
 *
 * LOS PERMISOS NO SE COMPRUEBAN AQUÍ: los comprueba cada caso de uso que se compone, con su
 * alcance de almacén incluido. Una segunda tabla de permisos en la puerta sería una segunda
 * fuente de verdad que se desincroniza.
 */
export type ArrivalError =
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "PERMISSION_REQUIRED"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "DUPLICATE"; message: string }
  | { code: string; message: string };

/** Días que se admite fechar una llegada hacia atrás (ADR-0066 §5). */
export const DIAS_HACIA_ATRAS = 2;

/**
 * LA FECHA DEL HECHO, ACOTADA (ADR-0066 §5). El costo promedio se calcula en el ORDEN en que
 * entran los movimientos: una llegada fechada hacia atrás entra con el saldo de hoy y NO
 * recalcula el costo de lo que se vendió entre medias. Ese costo de ventas queda mal para
 * siempre —los movimientos no se editan— y, lo que obliga a acotar, **ningún invariante lo ve**:
 * todos comparan SUMAS, y esto es un problema de orden.
 *
 * Tres topes, y el «hoy» lo pone la BASE (inicio de transacción), no el reloj de Node.
 */
async function fechaAdmisible(
  sql: TransactionSql,
  companyId: string,
  fecha: string,
  cuentaPago: string | null,
): Promise<Result<true, ArrivalError>> {
  const [dias] = await sql<{ hoy: string; minimo: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as hoy,
           ((now() at time zone 'America/Caracas')::date - ${DIAS_HACIA_ATRAS}::int)::text as minimo`;
  if (!dias) return err({ code: "VALIDATION_FAILED", message: "No se pudo leer la fecha." });
  if (fecha > dias.hoy) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una llegada no se fecha en el futuro: la mercancía todavía no está aquí.",
    });
  }
  if (fecha < dias.minimo) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Una llegada se registra el día que llega, o hasta ${DIAS_HACIA_ATRAS} días después. Más atrás no es una llegada: el costo de lo que se vendió entre medias ya quedó registrado y no cambia. Regístralo en Conteo, ajustes y traslados, con su motivo.`,
    });
  }
  const [cerrado] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.fiscal_periods
     where company_id = ${companyId} and status = 'closed'
       and year = extract(year from ${fecha}::date)::int
       and month = extract(month from ${fecha}::date)::int`;
  if ((cerrado?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Ese mes ya está cerrado en contabilidad: una llegada con esa fecha cambiaría un período cerrado. Fecha la llegada en el mes abierto.",
    });
  }
  if (cuentaPago !== null) {
    const [cierre] = await sql<{ ultimo: string | null }[]>`
      select max(closing_date)::text as ultimo from public.cash_closings
       where account_id = ${cuentaPago}`;
    if (cierre?.ultimo != null && fecha <= cierre.ultimo) {
      return err({
        code: "VALIDATION_FAILED",
        message: `Esa cuenta ya cerró caja el ${cierre.ultimo}: un pago con fecha anterior cambiaría un arqueo firmado. Paga con otra cuenta o fecha la llegada después del cierre.`,
      });
    }
  }
  return ok(true);
}

/**
 * LO QUE SE VENDIÓ ENTRE MEDIAS. Lectura para la pantalla: si la llegada se fecha hacia atrás,
 * la persona tiene que ver —ANTES de confirmar— cuántas unidades de esos productos salieron
 * desde esa fecha, porque su costo ya quedó registrado y no se corrige.
 */
export async function ventasIntermedias(
  sql: TransactionSql,
  companyId: string,
  desde: string,
  productos: readonly string[],
): Promise<{ product_id: string; name: string; quantity: string }[]> {
  if (productos.length === 0) return [];
  return sql<{ product_id: string; name: string; quantity: string }[]>`
    select m.product_id, p.name, (-sum(m.quantity))::text as quantity
      from public.inventory_moves m
      join public.products p on p.id = m.product_id
     where m.company_id = ${companyId}
       and m.product_id = any(${productos as string[]}::uuid[])
       and m.quantity < 0
       and (m.occurred_at at time zone 'America/Caracas')::date >= ${desde}::date
     group by m.product_id, p.name
     order by p.name`;
}

/** El ancla del sistema: la única moneda contra la que hay tasa publicada (ADR-0064). */
const ANCLA = "USD";

interface CostoDeLinea {
  /** Costo POR UNIDAD, ya en la moneda del documento. */
  readonly unitario: string;
  /** Lo que la persona escribió: en qué moneda y si dio el de cada uno o el total. */
  readonly captureCurrency: string;
  readonly captureMode: "unit" | "total";
}

/**
 * EL COSTO DE UNA LÍNEA, Y LO QUE LA PERSONA ESCRIBIÓ (migración 71).
 *
 * Dos derivaciones, las dos en el SERVIDOR: el unitario cuando dieron el total de la línea, y la
 * conversión cuando escribieron en otra moneda que la del documento —se compra con factura en
 * bolívares y el dueño piensa en dólares—. La tasa es la del DÍA DEL HECHO, no la de hoy.
 *
 * Solo se convierte entre el ancla y la moneda del documento: un cruce entre dos monedas que no
 * sean el ancla exigiría una tasa que nadie publica, y componerla con dos divisiones es
 * inventarla.
 */
async function costoDeLinea(
  sql: TransactionSql,
  companyId: string,
  fecha: string,
  monedaDocumento: string,
  l: RegisterArrivalRequest["lines"][number],
): Promise<Result<CostoDeLinea, ArrivalError>> {
  // RECEPCIÓN A CIEGAS: la línea viene de un pedido y no trae importe. El costo es el ACORDADO
  // en el pedido, y lo lee el servidor: quien recibe cuenta bultos, no valora mercancía, y el
  // precio no pasa por su pantalla ni por su navegador.
  if (l.unit_amount === undefined && l.amount === undefined) {
    const [linea] = await sql<{ precio: string }[]>`
      select unit_price_transaction::text as precio from public.purchase_order_lines
       where id = ${l.purchase_order_line_id ?? null} and company_id = ${companyId}`;
    if (!linea) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Esa línea del pedido no existe: sin ella no hay costo acordado que usar.",
      });
    }
    return ok({ unitario: linea.precio, captureCurrency: monedaDocumento, captureMode: "unit" });
  }

  const captureMode = l.unit_amount !== undefined ? "unit" : "total";
  const captureCurrency = l.capture_currency ?? monedaDocumento;
  const escrito = l.unit_amount ?? l.amount ?? "";
  const unitarioEscrito =
    captureMode === "unit" ? ok(escrito) : unitarioDeEntrada(escrito, l.quantity);
  if (!unitarioEscrito.ok) return err(unitarioEscrito.error);
  if (captureCurrency === monedaDocumento) {
    return ok({ unitario: unitarioEscrito.value, captureCurrency, captureMode });
  }
  if (captureCurrency !== ANCLA && monedaDocumento !== ANCLA) {
    return err({
      code: "VALIDATION_FAILED",
      message: `No hay tasa de ${captureCurrency} a ${monedaDocumento}: el costo se escribe en la moneda del documento o en ${ANCLA}.`,
    });
  }
  const [t] = await sql<{ rate: string }[]>`
    select f.rate::text as rate
      from platform.rate_for(${companyId}, ${ANCLA},
             ${captureCurrency === ANCLA ? monedaDocumento : captureCurrency},
             ${fecha}::date) f`;
  if (!t) {
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message: `No hay tasa del BCV de ese día para convertir lo que escribiste. Tráela en Mi dinero.`,
    });
  }
  const escritoDec = parseDecimal(unitarioEscrito.value);
  const tasa = parseDecimal(t.rate);
  if (!escritoDec.ok || !tasa.ok || tasa.value.isZero()) {
    return err({ code: "VALIDATION_FAILED", message: "Importe o tasa no interpretables." });
  }
  // Escrito en el ancla → se multiplica; escrito en la del documento cuando el documento va en
  // el ancla → se divide. No hay tercer caso: el guard de arriba lo cerró.
  const unitario =
    captureCurrency === ANCLA
      ? escritoDec.value.times(tasa.value).toDecimalPlaces(8, 4)
      : escritoDec.value.dividedBy(tasa.value).toDecimalPlaces(8, 4);
  return ok({ unitario: unitario.toFixed(8), captureCurrency, captureMode });
}

export async function registerArrival(
  uow: UnitOfWork,
  input: RegisterArrivalRequest,
): Promise<Result<ArrivalResponse, ArrivalError>> {
  const { sql } = uow;

  // La fecha del hecho: la de la llegada, y por omisión el día de Venezuela.
  const [hoy] = await sql<{ d: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as d`;
  const fecha = input.arrived_on ?? hoy!.d;
  const cuentaPago = input.payment?.account_id ?? null;
  const admisible = await fechaAdmisible(sql, input.company_id, fecha, cuentaPago);
  if (!admisible.ok) return admisible;

  // Cada línea con su costo unitario resuelto por el SERVIDOR: la pantalla manda lo que la
  // persona escribió —por unidad o el total, en la moneda que tenga a mano— y nunca el
  // resultado de dividirlo ni de convertirlo.
  const costos: CostoDeLinea[] = [];
  for (const l of input.lines) {
    const u = await costoDeLinea(sql, input.company_id, fecha, input.currency, l);
    if (!u.ok) return u;
    costos.push(u.value);
  }
  const unitarios = costos.map((c) => c.unitario);

  // ── Camino «ya era mía»: inventario inicial o aporte ──────────────────────
  if (input.supplier_id === undefined) {
    const movimientos: InventoryMoveResponse[] = [];
    for (const [i, l] of input.lines.entries()) {
      const total = totalDeEntrada(unitarios[i]!, l.quantity);
      if (!total.ok) return err(total.error);
      const mov = await receiveStock(uow, {
        company_id: input.company_id,
        warehouse_id: input.warehouse_id,
        product_id: l.product_id,
        quantity: l.quantity,
        amount: total.value,
        currency: input.currency,
        occurred_at: `${fecha}T12:00:00.000Z`,
        accounting: "stock_opening",
        ...(l.lot_code === undefined ? {} : { lot_code: l.lot_code }),
        ...(l.lot_expires_at === undefined ? {} : { lot_expires_at: l.lot_expires_at }),
        capture_currency: costos[i]!.captureCurrency,
        capture_mode: costos[i]!.captureMode,
        // La referencia es la del papel con el que llegó, si lo hay. NO se inventa una por
        // omisión: `inventory_moves` tiene llave única por (empresa, tipo, referencia, producto)
        // y una referencia fija haría que la segunda llegada del mismo producto chocara.
        ...(input.reference === undefined ? {} : { reference: input.reference }),
      });
      if (!mov.ok) return err(mov.error);
      movimientos.push(mov.value);
    }
    return ok({
      kind: "own",
      receipt: null,
      invoice: null,
      payment: null,
      moves: movimientos,
    });
  }

  // ── Camino «me la trajo un proveedor»: siempre hay recepción ──────────────
  const lineasRecepcion: ReceiveGoodsRequest["lines"] = input.lines.map((l, i) => ({
    product_id: l.product_id,
    quantity: l.quantity,
    unit_price: unitarios[i]!,
    ...(l.purchase_order_line_id === undefined
      ? {}
      : { purchase_order_line_id: l.purchase_order_line_id }),
    ...(l.lot_code === undefined ? {} : { lot_code: l.lot_code }),
    ...(l.lot_expires_at === undefined ? {} : { lot_expires_at: l.lot_expires_at }),
    capture_currency: costos[i]!.captureCurrency,
    capture_mode: costos[i]!.captureMode,
  }));
  const recepcion = await receiveGoods(uow, {
    company_id: input.company_id,
    supplier_id: input.supplier_id,
    warehouse_id: input.warehouse_id,
    currency: input.currency,
    received_at: `${fecha}T12:00:00.000Z`,
    ...(input.purchase_order_id === undefined
      ? {}
      : { purchase_order_id: input.purchase_order_id }),
    ...(input.reference === undefined ? {} : { delivery_note_ref: input.reference }),
    lines: lineasRecepcion,
  });
  if (!recepcion.ok) return err(recepcion.error);

  // «Todavía no me la dan»: la recepción es todo. La deuda vive en «mercancía recibida por
  // facturar» hasta que llegue la factura, y la pestaña «Falta la factura» la vigila.
  if (input.invoice === "pending") {
    return ok({
      kind: "receipt",
      receipt: recepcion.value,
      invoice: null,
      payment: null,
      moves: [],
    });
  }

  // Con factura, o sin que vaya a haberla: en los dos casos hay documento de compra, y la
  // diferencia es si va al libro (ADR-0066 §2).
  const lineasRecibidas = await sql<{ id: string; product_id: string }[]>`
    select id, product_id from public.goods_receipt_lines
     where goods_receipt_id = ${recepcion.value.id} order by line_number`;
  const lineasFactura: RegisterSupplierInvoiceRequest["lines"] = input.lines.map((l, i) => {
    const rl = lineasRecibidas[i];
    return {
      product_id: l.product_id,
      quantity: l.quantity,
      unit_price: unitarios[i]!,
      capture_currency: costos[i]!.captureCurrency,
      capture_mode: costos[i]!.captureMode,
      ...(rl === undefined ? {} : { goods_receipt_line_id: rl.id }),
    };
  });
  const factura = await registerSupplierInvoice(uow, {
    company_id: input.company_id,
    supplier_id: input.supplier_id,
    invoice_date: fecha,
    currency: input.currency,
    lines: lineasFactura,
    fiscal_support: input.invoice === "present",
    ...(input.purchase_order_id === undefined
      ? {}
      : { purchase_order_id: input.purchase_order_id }),
    ...(input.supplier_document_number === undefined
      ? {}
      : { supplier_document_number: input.supplier_document_number }),
    ...(input.supplier_control_number === undefined
      ? {}
      : { supplier_control_number: input.supplier_control_number }),
    ...(input.supplier_document_ref === undefined
      ? {}
      : { supplier_document_ref: input.supplier_document_ref }),
    ...(input.retention_concepts === undefined
      ? {}
      : { retention_concepts: input.retention_concepts }),
  });
  if (!factura.ok) return err(factura.error);

  // El pago, si ya se pagó. Parcial admitido: lo que no se paga queda debiendo.
  /**
   * EL TRANSPORTE, si lo hubo. No es un gasto del mes: es costo de ESTA mercancía, y por eso se
   * reparte entre las líneas de la recepción y revaloriza el inventario (ADR-0040 §6). Se aplica
   * después de la factura porque el reparto necesita la recepción ya cerrada, y va por VALOR:
   * repartir un flete por unidades cobraría lo mismo llevar un saco que un tornillo.
   */
  if (input.freight !== undefined) {
    const flete = await applyLandedCost(uow, {
      company_id: input.company_id,
      goods_receipt_id: recepcion.value.id,
      concept: input.freight.concept ?? "Transporte de la llegada",
      allocation_method: "by_value",
      amount: input.freight.amount,
      currency: input.currency,
      incurred_on: fecha,
      supplier_id: input.supplier_id,
    });
    if (!flete.ok) return err(flete.error);
  }

  let pago: SupplierPaymentResponse | null = null;
  if (input.payment !== undefined) {
    const [saldo] = await sql<{ s: string }[]>`
      select platform.supplier_invoice_balance(${input.company_id},
             ${factura.value.id})::text as s`;
    const bruto = input.payment.amount ?? saldo?.s ?? "0";
    const monto = parseDecimal(bruto);
    if (!monto.ok || monto.value.isZero() || monto.value.isNegative()) {
      return err({
        code: "VALIDATION_FAILED",
        message: "El importe pagado no es interpretable o no es positivo.",
      });
    }
    const pagado = await registerSupplierPayment(uow, {
      company_id: input.company_id,
      supplier_invoice_id: factura.value.id,
      gross_amount: monto.value.toFixed(8),
      currency: input.currency,
      instrument: input.payment.instrument,
      paid_at: `${fecha}T12:00:00.000Z`,
      ...(input.payment.account_id === undefined ? {} : { account_id: input.payment.account_id }),
      ...(input.payment.reference === undefined ? {} : { reference: input.payment.reference }),
      ...(input.payment.allow_negative_balance === undefined
        ? {}
        : { allow_negative_balance: input.payment.allow_negative_balance }),
    });
    if (!pagado.ok) return err(pagado.error);
    pago = pagado.value;
  }

  return ok({
    kind: input.invoice === "present" ? "invoiced" : "unsupported",
    receipt: recepcion.value,
    invoice: factura.value,
    payment: pago,
    moves: [],
  });
}
