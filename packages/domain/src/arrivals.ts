import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql } from "@ladino/db";
import { parseDecimal } from "@ladino/money";
import type {
  RegisterArrivalRequest,
  ArrivalResponse,
  ArrivalPreviewResponse,
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

/**
 * EL INSTANTE DEL HECHO (D-08 y D-10, familia F1 de CLAUDE.md §3). La llegada se fecha por DÍA de
 * Caracas; el kardex y el pago necesitan un INSTANTE. Antes era `${fecha}T12:00:00.000Z`, las
 * 08:00 de Caracas: antes de esa hora quedaba después de `created_at` y el CHECK
 * `occurred_at <= created_at` lo rechazaba, y después de esa hora colocaba lo de hoy ANTES de lo
 * ya registrado hoy (el kardex leído por `occurred_at` daba saldos incoherentes).
 *
 * La granularidad, declarada: se comparan dos `date` de Caracas. Si el día es HOY, el instante
 * es `now()` —el inicio de la transacción, el mismo reloj que `created_at`—; si es un día
 * anterior, el último milisegundo de ese día en Caracas: después de todo lo de ese día y antes
 * de todo lo de hoy, sin una hora que nadie eligió.
 */
async function instanteDelHecho(sql: TransactionSql, fecha: string): Promise<string> {
  const [fila] = await sql<{ t: string }[]>`
    select to_char(
             (case when ${fecha}::date = (now() at time zone 'America/Caracas')::date then now()
                   else ((${fecha}::date + 1)::timestamp at time zone 'America/Caracas')
                        - interval '1 millisecond'
              end) at time zone 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as t`;
  return fila!.t;
}

/**
 * LA TASA DE UNA LLEGADA EN DIVISA (D-09; ADR-0066 nota de la ola 3 §6). «La tasa del día» es la
 * oficial VIGENTE a la fecha del hecho: la más reciente no posterior (`platform.rate_for`) — el
 * BCV no publica sábados, domingos ni feriados, y esos días rige la última publicada —, y NO más
 * antigua que el margen de plataforma (`platform.parameters.closing_rate_max_age_days`, el mismo
 * dato que acota la tasa de cierre: `platform.closing_rate`). Fuera del margen no hay tasa que
 * usar: `EXCHANGE_RATE_MISSING`, antes de escribir nada.
 *
 * Antes `rate_for` a secas admitía una tasa de CUALQUIER antigüedad: mientras existiera una
 * vieja, la llegada en dólares nunca fallaba y se valoraba con ella.
 *
 * Solo se mira cuando la llegada cruza monedas: el documento o algún costo en una moneda que no
 * es la funcional. Devuelve la tasa y su fecha para que la vista previa las diga.
 */
export async function tasaVigenteDeLaLlegada(
  sql: TransactionSql,
  input: RegisterArrivalRequest,
  fecha: string,
): Promise<Result<{ rate: string; rate_date: string } | null, ArrivalError>> {
  const [empresa] = await sql<{ funcional: string }[]>`
    select functional_currency_code as funcional from public.companies
     where id = ${input.company_id}`;
  if (!empresa) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const monedas = new Set<string>([empresa.funcional, input.currency]);
  for (const l of input.lines)
    if (l.capture_currency !== undefined) monedas.add(l.capture_currency);
  if (monedas.size === 1) return ok(null);
  // Dos monedas que no son el ancla no cruzan: lo rechaza `costoDeLinea` con su motivo (422),
  // no este control con un «falta la tasa» que no es verdad.
  if ([...monedas].filter((m) => m !== ANCLA).length > 1) return ok(null);
  let usada: { rate: string; rate_date: string } | null = null;
  for (const moneda of monedas) {
    if (moneda === ANCLA) continue;
    const [t] = await sql<{ rate: string | null; rate_date: string | null }[]>`
      select platform.closing_rate(${input.company_id}, ${ANCLA}, ${moneda}, ${fecha}::date)::text
               as rate,
             (select f.rate_date::text
                from platform.rate_for(${input.company_id}, ${ANCLA}, ${moneda}, ${fecha}::date) f)
               as rate_date`;
    if (!t || t.rate === null || t.rate_date === null) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message:
          "No hay tasa del BCV vigente para ese día: la última publicada es demasiado vieja o no existe. Tráela en Mi dinero y vuelve a registrar la llegada.",
      });
    }
    usada = { rate: t.rate, rate_date: t.rate_date };
  }
  return ok(usada);
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
  const vigente = await tasaVigenteDeLaLlegada(sql, input, fecha);
  if (!vigente.ok) return vigente;

  // Cada línea con su costo unitario resuelto por el SERVIDOR: la pantalla manda lo que la
  // persona escribió —por unidad o el total, en la moneda que tenga a mano— y nunca el
  // resultado de dividirlo ni de convertirlo.
  const costos: CostoDeLinea[] = [];
  for (const l of input.lines) {
    const u = await costoDeLinea(sql, input.company_id, fecha, input.currency, l);
    if (!u.ok) return u;
    costos.push(u.value);
  }
  // D-05: «el precio ya incluye IVA». Lo escrito es el precio con IVA del papel; el SERVIDOR le
  // quita el IVA con la misma alícuota de compra que usará la factura, y lo que sigue —recepción,
  // factura, kardex— trabaja con la base, como siempre. Solo cuando hay IVA que quitar: con
  // proveedor y con factura (presente o por llegar). Sin factura, lo pagado ES el costo.
  if (
    input.prices_include_tax === true &&
    input.supplier_id !== undefined &&
    input.invoice !== "none"
  ) {
    const netos = await quitarIva(sql, input, fecha, costos);
    if (!netos.ok) return netos;
    for (const [i, n] of netos.value.entries()) costos[i] = n;
  }
  const unitarios = costos.map((c) => c.unitario);
  const instante = await instanteDelHecho(sql, fecha);

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
        occurred_at: instante,
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
    received_at: instante,
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
    // ADR-0072 §3: la exclusión y el 100 % viajan igual que en la factura de proveedor; la
    // retención automática del agente no necesita nada del cuerpo.
    ...(input.retention_exclusion === undefined
      ? {}
      : { retention_exclusion: input.retention_exclusion }),
    ...(input.iva_retention_full_reason === undefined
      ? {}
      : { iva_retention_full_reason: input.iva_retention_full_reason }),
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
      paid_at: instante,
      ...(input.payment.account_id === undefined ? {} : { account_id: input.payment.account_id }),
      ...(input.payment.reference === undefined ? {} : { reference: input.payment.reference }),
      ...(input.payment.allow_negative_balance === undefined
        ? {}
        : { allow_negative_balance: input.payment.allow_negative_balance }),
      ...(input.payment.overdraft_reason === undefined
        ? {}
        : { overdraft_reason: input.payment.overdraft_reason }),
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
/**
 * D-05: el IVA que se quita a un precio escrito CON IVA. La alícuota sale del mismo motor que la
 * factura (`platform.resolve_tax`: compra, tipo del proveedor, categoría del producto, día del
 * hecho) y el neto se guarda con 8 decimales: base × (1 + alícuota) reproduce lo escrito salvo en
 * la octava cifra. Un proveedor extranjero no lleva IVA venezolano: se deja como está.
 */
async function quitarIva(
  sql: TransactionSql,
  input: RegisterArrivalRequest,
  fecha: string,
  costos: readonly CostoDeLinea[],
): Promise<Result<CostoDeLinea[], ArrivalError>> {
  const [prov] = await sql<{ kind: string; tipo: string | null }[]>`
    select supplier_kind as kind, taxpayer_type_code as tipo from public.suppliers
     where id = ${input.supplier_id ?? null} and company_id = ${input.company_id}`;
  if (!prov) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (prov.kind !== "nacional") return ok([...costos]);
  const netos: CostoDeLinea[] = [];
  for (const [i, l] of input.lines.entries()) {
    const c = costos[i]!;
    // La línea que viene de un pedido trae el precio ACORDADO, no uno escrito del papel.
    if (l.unit_amount === undefined && l.amount === undefined) {
      netos.push(c);
      continue;
    }
    let alicuota: string;
    try {
      const filas = await sql.savepoint(
        (sp) => sp<{ rate: string }[]>`
          select r.rate::text as rate
            from public.products p
            cross join lateral platform.resolve_tax(${input.company_id}, ${fecha}::date, 'VE',
                                                    'iva', ${prov.tipo}, p.tax_category_code,
                                                    'purchase') r
           where p.id = ${l.product_id} and p.company_id = ${input.company_id}`,
      );
      const regla = filas[0];
      if (!regla) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
      alicuota = regla.rate;
    } catch (e) {
      if ((e as { code?: string }).code === "LAD50") {
        return err({
          code: "TAX_RULE_MISSING",
          message:
            "No hay alícuota de IVA de compra vigente para ese producto ese día: sin ella no se puede quitar el IVA del precio. Escribe el precio sin IVA, como viene en la factura.",
        });
      }
      throw e;
    }
    const bruto = parseDecimal(c.unitario);
    const tasa = parseDecimal(alicuota);
    if (!bruto.ok || !tasa.ok) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Importe o alícuota no interpretables.",
      });
    }
    const neto = bruto.value.dividedBy(tasa.value.plus(1)).toDecimalPlaces(8, 4);
    netos.push({ ...c, unitario: neto.toFixed(8) });
  }
  return ok(netos);
}

/**
 * LA VISTA PREVIA DE LA LLEGADA (D-05, y D-09 de paso): base, IVA y total ANTES de confirmar,
 * calculados por el MISMO caso de uso que registra, no por una copia que pueda divergir. Corre
 * `registerArrival` dentro de un savepoint que SIEMPRE se deshace: nada queda escrito (recepción,
 * factura, kardex, actas, outbox). El pago no se previsualiza: lo que se enseña es el documento,
 * y el saldo de la cuenta se pregunta al confirmar (ADR-0062 §4).
 *
 * Lo que falla al registrar falla aquí con el mismo código —la tasa del día que no existe, el
 * proveedor sin RIF con factura—, y la pantalla lo enseña antes de «Sí, registrar».
 */
export async function previewArrival(
  uow: UnitOfWork,
  input: RegisterArrivalRequest,
): Promise<Result<ArrivalPreviewResponse, ArrivalError>> {
  const sinPago: RegisterArrivalRequest = { ...input };
  delete sinPago.payment;
  // D-09: qué tasa se va a usar y de qué fecha es, para decirlo antes de confirmar.
  const [dia] = await uow.sql<{ d: string }[]>`
    select (now() at time zone 'America/Caracas')::date::text as d`;
  const tasa = await tasaVigenteDeLaLlegada(uow.sql, input, input.arrived_on ?? dia!.d);
  const cambio = {
    fx_rate: tasa.ok && tasa.value !== null ? tasa.value.rate : null,
    fx_rate_date: tasa.ok && tasa.value !== null ? tasa.value.rate_date : null,
  };
  const DESHACER = new Error("vista previa: se deshace siempre");
  let vista: Result<ArrivalPreviewResponse, ArrivalError> | null = null;
  try {
    await uow.sql.savepoint(async (sp) => {
      const r = await registerArrival({ ...uow, sql: sp }, sinPago);
      if (!r.ok) {
        vista = r;
      } else if (r.value.invoice !== null) {
        vista = ok({
          kind: r.value.kind,
          currency: input.currency,
          ...cambio,
          subtotal: r.value.invoice.subtotal_amount,
          tax_amount: r.value.invoice.tax_amount,
          total_amount: r.value.invoice.total_amount,
        });
      } else if (r.value.receipt !== null) {
        const [t] = await sp<{ s: string }[]>`
          select coalesce(sum(amount_transaction_currency), 0)::numeric(24,8)::text as s
            from public.goods_receipt_lines where goods_receipt_id = ${r.value.receipt.id}`;
        // El IVA lo dirá la factura cuando llegue: aquí no se adivina.
        vista = ok({
          kind: r.value.kind,
          currency: input.currency,
          ...cambio,
          subtotal: t!.s,
          tax_amount: null,
          total_amount: null,
        });
      } else {
        vista = ok({
          kind: r.value.kind,
          currency: input.currency,
          ...cambio,
          subtotal: null,
          tax_amount: null,
          total_amount: null,
        });
      }
      throw DESHACER;
    });
  } catch (e) {
    if (e !== DESHACER) throw e;
  }
  return (
    vista ??
    err({
      code: "VALIDATION_FAILED",
      message: "No se pudo calcular la vista previa.",
    })
  );
}
