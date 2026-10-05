import { err, ok, type Result } from "@ladino/core";
import { diaNegocio } from "./dia-negocio.js";
import { mensajeFaltaTasa } from "./tasa-oficial.js";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import {
  currencyDefinition,
  minorUnitsOf,
  Money,
  parseCurrency,
  parseDecimal,
  roundForTax,
  type CurrencyCode,
  type Decimal,
  type RoundingMode,
  type RoundingPolicy,
  type Scale,
} from "@ladino/money";
import { listedPriceOf, resolvePrice } from "@ladino/pricing";
import {
  calculateLine,
  calculateTotals,
  exchangeDifference,
  type CalculatedLine,
} from "@ladino/sales";
import type {
  CreateQuoteRequest,
  CreateOrderRequest,
  ConfirmOrderRequest,
  CreateInvoiceRequest,
  AnnulInvoiceRequest,
  RegisterPaymentRequest,
  RegisterPaymentResponse,
  CreateReturnRequest,
  DocumentResponse,
  ReturnResponse,
  PosQuoteRequest,
  PosQuoteResponse,
  QuickSaleRequest,
  QuickSaleResponse,
  PosTenderRequest,
  PosTenderResponse,
  CreateDirectCreditNoteRequest,
  DirectCreditNoteResponse,
  CreateDebitNoteRequest,
  SalesMode,
  RefundCustomerCreditRequest,
  CustomerRefundResponse,
} from "@ladino/schemas";
import { RULES_VERSION, sembrarProductoIgtf } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import {
  issueStockBatchForSale,
  receiveStockFor,
  reingresarRetiro,
  reponerSalidasDeDocumento,
} from "./inventory.js";
import {
  explotarCompuestos,
  movimientosPorLinea,
  registrarSalidasDeCompuestos,
  reingresarCompuesto,
} from "./compuestos.js";
import { exigeSaldo, resolverCuentaEfectivo } from "./treasury.js";
import { generateJournalFromDocument } from "./journal-generator.js";
import { reverseJournalEntryForAnnulment } from "./accounting.js";
import { exigeTipoParaFacturar, type TaxpayerTypeRequiredError } from "./tipo-contribuyente.js";
import { modoDeVenta } from "./modo-venta.js";
import { bloquearTalonario, serieDelTalonario } from "./talonario.js";
import { serieYNumero } from "@ladino/schemas";
import { exigeFormaLibre, filasDeLineas } from "./forma-libre.js";
import {
  cuentaAjena,
  cuentaVendida,
  puedeCuentasAjenas,
  type PosCartSoldError,
} from "./pos-carts.js";

/**
 * Casos de uso de VENTAS — RIGOR MÁXIMO. Aquí convergen dinero, fiscal,
 * inventario y auditoría, y es la plantilla que copiarán compras, tesorería y
 * devoluciones.
 *
 * Lo que este módulo NO decide, y por eso no aparece escrito en ningún número:
 *   · la alícuota la resuelve `platform.resolve_tax()` (ADR-0038) y la línea la
 *     COPIA. Sin regla vigente, no hay emisión;
 *   · el correlativo y el número de control los asignan funciones del esquema
 *     (ADR-0037), atómicas, y el trigger vuelve a comprobarlas al emitir;
 *   · la tasa sale de `exchange_rates` con su fuente. Sin tasa, no hay emisión.
 *
 * El orden de la emisión importa y está elegido: se construye el documento en
 * `draft`, se calculan las líneas, y solo al final se pasa a `issued` — que es
 * cuando el trigger valida numeración y régimen. Emitir primero y calcular
 * después dejaría un documento fiscal a medio hacer si algo falla.
 */
export type SalesError =
  | CompanyScopeError
  | { code: "DUPLICATE"; message: string }
  | { code: "VALIDATION_FAILED"; message: string }
  | {
      code: "FISCAL_NUMBERING_INVALID";
      message: string;
      /** H10 (ADR-0071): por qué, para que la pantalla dé la salida que toca. Aditivo. */
      details?: { reason: MotivoNumeracion };
    }
  | { code: "TAX_RULE_MISSING"; message: string }
  | { code: "EXCHANGE_RATE_MISSING"; message: string }
  | { code: "NEGATIVE_STOCK"; message: string }
  | { code: "APPEND_ONLY_VIOLATION"; message: string }
  | { code: "REGIME_KIND_NOT_ALLOWED"; message: string }
  | { code: "DOCUMENT_HAS_PAYMENTS"; message: string }
  // G-10 (PA 00071 arts. 22 y 36): la factura ya no se anula; se corrige con nota de crédito.
  | { code: "ANNULMENT_NOT_ALLOWED"; message: string; details: { reason: AnnulmentBlocker } }
  | { code: "INSUFFICIENT_FUNDS"; message: string }
  // ADR-0075 §4 (regla 4): el cobro que cierra dejaría un diferencial fuera del redondeo.
  | { code: "SETTLEMENT_MISMATCH"; message: string }
  // ADR-0076: la cuenta del POS que esta venta cerraría ya se cobró.
  | PosCartSoldError
  // E-09: fiar esta venta dejaría al cliente por encima de su límite de fiado.
  | { code: "CREDIT_LIMIT_EXCEEDED"; message: string }
  | TaxpayerTypeRequiredError;

/** El candado del fiado de UN cliente (E-09): dos fiados simultáneos se ponen en fila. */
function candadoDeFiado(customerId: string): string {
  return "customer_credit:" + customerId;
}

/** Un importe en USD como lo lee la persona: al céntimo. */
function usd(v: string): string {
  const d = parseDecimal(v);
  return d.ok ? d.value.toFixed(2) : v;
}

/**
 * E-09 · EL CRÉDITO DE UN CLIENTE, en USD: límite, deuda y disponible. La deuda es la de LA
 * función de deuda (`platform.customer_debt_today` → `platform.document_debt`), convertida a
 * USD por `platform.customer_credit`. `debt`/`available` en null = no se puede decir (sin
 * tasa de hoy): quien decide con esto RECHAZA el fiado.
 */
async function creditoDelCliente(
  sql: TransactionSql,
  companyId: string,
  customerId: string,
): Promise<{ limit: string; debt: string | null; available: string | null } | null> {
  const [c] = await sql<{ limit: string; debt: string | null; available: string | null }[]>`
    select k.limit_usd::text as limit, k.debt_usd::text as debt,
           k.available_usd::text as available
      from platform.customer_credit(${companyId}, ${customerId}) k`;
  return c ?? null;
}

/**
 * LA ÚNICA PUERTA DEL FIADO (E-09, R-82.1). Todo camino que emite una venta que DEJA SALDO a un
 * cliente pasa por aquí: la caja (`quickSale`, tras sus cobros) y la factura de administración
 * (`emitirVenta` con bloqueo «rechazar», que nace sin cobro). Mismo código y mismo mensaje.
 *
 * Se llama con el documento YA emitido dentro de la transacción (y con el candado
 * `candadoDeFiado` tomado antes de emitir): la deuda que se lee es la de LA función de deuda e
 * incluye esta venta. Con el err, `withTransaction` revierte la venta entera — ni factura, ni
 * número gastado, ni kardex.
 */
async function exigirFiado(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  customerId: string,
): Promise<Result<true, SalesError>> {
  const [cliente] = await sql<{ is_system: boolean; bloqueado: boolean }[]>`
    select is_system, status = 'blocked' as bloqueado from public.customers
     where id = ${customerId} and company_id = ${companyId}`;
  if (!cliente) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // FIAR exige un cliente con nombre (orden del dueño, 2026-09-08): una deuda del «Consumidor
  // final» de sistema no se puede cobrar después — no hay a quién.
  if (cliente.is_system) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una venta de mostrador se cobra completa. Para fiar, identifica al cliente.",
    });
  }
  // BLOQUEO DE COBRANZAS: se le vende de contado, no se le fía (QA de pantalla 2026-09-15, h. 79).
  if (cliente.bloqueado) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El cliente está bloqueado por cobranzas: no se le fía. Cóbrale la venta completa.",
    });
  }
  // E-09 · FIAR EXIGE LAS DOS COSAS (RESPUESTA §2.8): el permiso `sales.credit` de quien vende
  // y un límite de fiado del cliente que alcance.
  const [permiso] = await sql<{ ok: boolean }[]>`
    select platform.ladino_user_has_permission(${userId}, 'sales.credit',
                                               ${companyId}) as ok`;
  if (permiso?.ok !== true) {
    return err({
      code: "PERMISSION_REQUIRED",
      message:
        "Necesitas el permiso para fiar (sales.credit). Pídeselo a quien administra el " +
        "negocio, o cobra la venta completa.",
    });
  }
  const credito = await creditoDelCliente(sql, companyId, customerId);
  if (credito === null) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const limite = parseDecimal(credito.limit);
  if (!limite.ok) return err({ code: "VALIDATION_FAILED", message: "Límite no interpretable." });
  if (limite.value.isZero()) {
    return err({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        "A este cliente todavía no se le fía: su límite de fiado es 0. Lo fija quien " +
        "administra el negocio (permiso customers.credit.set). Cóbrale la venta completa.",
    });
  }
  if (credito.debt === null) {
    // Modo de fallo ruidoso: sin poder decir cuánto debe, no se le fía más.
    return err({
      code: "EXCHANGE_RATE_MISSING",
      message:
        "No se puede calcular cuánto debe este cliente (falta la tasa de hoy), así que no se " +
        "le puede fiar ahora. Cóbrale la venta completa o carga la tasa del día.",
    });
  }
  const deuda = parseDecimal(credito.debt);
  if (!deuda.ok) return err({ code: "VALIDATION_FAILED", message: "Deuda no interpretable." });
  if (deuda.value.greaterThan(limite.value)) {
    return err({
      code: "CREDIT_LIMIT_EXCEEDED",
      message:
        `El límite de fiado de este cliente es USD ${usd(credito.limit)} y con esta venta ` +
        `quedaría debiendo USD ${usd(credito.debt)}. Cobra la diferencia, o pide a quien ` +
        "administra que le suba el límite.",
    });
  }
  return ok(true);
}

/**
 * Redondeo de la VALORACIÓN de un cobro y de su diferencial: las UNIDADES MÍNIMAS de la moneda
 * de la empresa (ADR-0063 §3), no la escala de `numeric(24,8)`. La escala se arma en el sitio
 * porque depende de la moneda funcional de cada empresa; el id la lleva dentro para que quede
 * en el asiento cuál se aplicó.
 */
function politicaDeValoracion(escala: Scale): RoundingPolicy {
  return { id: `sales:fx_diff:${escala}:HALF_UP`, scale: escala, mode: "HALF_UP" };
}

/**
 * El precio unitario NO se redondea a la moneda: un precio de lista puede
 * llevar tres decimales (combustible, granel) y es la base × cantidad lo que
 * se cobra. Esta política solo interviene si la lista está en otra moneda que
 * el documento (hoy nunca: identidad).
 */
const PRECIO_POLICY: RoundingPolicy = { id: "sales:price:8:HALF_UP", scale: 8, mode: "HALF_UP" };

/**
 * Modo de redondeo del documento de venta (ADR-0058). Con nombre propio, como
 * `MODO_IGTF`: el día que el contador confirme el modo, el cambio es UNA línea,
 * y viaja en el `rounding_policy_id` de cada documento y cada línea.
 *
 * VALIDAR-TRIBUTARIO: `HALF_UP` es el modo que ya usaba todo el pipeline;
 * MONEY_AND_ROUNDING_SPEC §6.3 deja el modo al asesor. La ESCALA no está en
 * duda: son las minor units ISO-4217 de la moneda del documento.
 */
const MODO_DOCUMENTO: RoundingMode = "HALF_UP";

/**
 * La política del documento EN su moneda: base y impuesto de cada línea, y por
 * suma el pie, a lo que esa moneda sabe cobrar (`sales:document:2:HALF_UP` para
 * VES y USD). Se persiste en `documents` y en `document_lines` (ADR-0024).
 */
function politicaDelDocumento(currency: string): RoundingPolicy {
  const escala = minorUnitsOf(currency);
  return {
    id: `sales:document:${String(escala)}:${MODO_DOCUMENTO}`,
    scale: escala,
    mode: MODO_DOCUMENTO,
  };
}

/**
 * Modo de redondeo de la percepción de IGTF (ADR-0053).
 *
 * Tiene nombre propio —como `ISO_PRESENTATION_MODE` en `packages/money`— para
 * que el día que el contador confirme el modo el cambio sea UNA línea que se
 * encuentra con `grep`, y porque viaja dentro del `rounding_policy_id` de cada
 * fila: ninguna percepción queda redondeada por un criterio que no se pueda
 * leer después.
 *
 * VALIDAR-SENIAT: `HALF_UP` es el mismo modo que usa el resto del cobro
 * (`sales:document:8:HALF_UP`); que sea el que corresponde a la percepción lo
 * confirma el contador.
 */
const MODO_IGTF: RoundingMode = "HALF_UP";

/**
 * La percepción, redondeada a lo que esa moneda sabe cobrar (ADR-0053).
 *
 * La escala NO se elige aquí: son las minor units ISO-4217 de la moneda, que
 * son metadato de la moneda y no interpretación fiscal
 * (MONEY_AND_ROUNDING_SPEC §6.1). Antes se redondeaba a ocho decimales y salía
 * a cobrar USD 1,0635 — un importe que nadie puede pagar.
 *
 * Vive en el dominio y NO en la ruta a propósito: el aviso que la caja enseña
 * antes de cobrar (`/v1/pos/igtf`) usa esta misma función. Dos redondeos
 * separados es la manera segura de que la pantalla diga un número y el cobro
 * escriba otro.
 */
export function percibirIgtf(
  base: Decimal,
  factor: Decimal,
  moneda: string,
): Result<{ monto: Decimal; policy: RoundingPolicy }, { code: "MONEY_ERROR"; message: string }> {
  const regla = politicaIgtfDe(moneda);
  if (regla === null) {
    return err({ code: "MONEY_ERROR", message: `Moneda no registrada: ${moneda}.` });
  }
  const redondeado = roundForTax(
    { amount: base.times(factor), currency: regla.code },
    regla.policy,
  );
  if (!redondeado.ok) {
    return err({ code: "MONEY_ERROR", message: redondeado.error.message });
  }
  return ok({ monto: redondeado.value.value.amount, policy: regla.policy });
}

/**
 * El aviso de caja (`/v1/pos/igtf`): la MISMA regla, con los importes como
 * viajan por la API. Devuelve el string canónico de 8 decimales.
 */
export function avisoIgtf(
  base: string,
  tasa: string,
  moneda: string,
): Result<string, { code: "MONEY_ERROR"; message: string }> {
  const b = parseDecimal(base);
  const t = parseDecimal(tasa);
  if (!b.ok || !t.ok) {
    return err({ code: "MONEY_ERROR", message: "Importe o tasa de IGTF no interpretables." });
  }
  const r = percibirIgtf(b.value, t.value, moneda);
  return r.ok ? ok(r.value.monto.toFixed(8)) : r;
}

// ── LA CAJA: un solo cálculo de cobro (orden del dueño, 2026-09-13, ADR-0059) ─
//
// Lo que la cajera teclea es lo ENTREGADO por el cliente. Si esa forma de pago
// causa IGTF, el IGTF va DENTRO de lo entregado: de 23,37 USD por una cuenta
// de 22,69, la venta recibe 22,69 y el fisco 0,68 — y el vuelto sale de lo
// que sobre DESPUÉS de los dos. La vista previa del diálogo (`/v1/pos/tender`)
// y la venta (`quickSale`) llaman a `pasoDeCobro`: la pantalla no puede
// decir un número y el cobro escribir otro.

/** Formas de pago que dan vuelto: solo el efectivo. Una tarjeta no da cambio. */
const CON_VUELTO = new Set(["efectivo_bs", "efectivo_usd"]);

/** Las condiciones de UN pago: la tasa a funcional y, si lo causa, el IGTF. */
export interface CondicionDePago {
  /** Moneda del pago → funcional, la del día de la empresa (1 en funcional). */
  readonly tasa: Decimal;
  /** Tasa del IGTF (p. ej. 0,03) si ESTE pago lo causa; null si no. */
  readonly igtf: Decimal | null;
  readonly igtfFuente: string | null;
}

export interface PasoDeCobro {
  /** Lo que abona al documento, en la moneda del pago (8 decimales). */
  readonly aplicado: Decimal;
  /** Lo que baja la deuda, en moneda funcional. */
  readonly aplicadoFuncional: Decimal;
  /** El IGTF que se percibe ADEMÁS, en la moneda del pago. */
  readonly igtf: Decimal;
  /** El vuelto entregable, en la moneda del pago. */
  readonly vuelto: Decimal;
  /** true = con este pago la venta queda pagada. */
  readonly cubre: boolean;
}

function decimalDe(v: string): Decimal {
  const d = parseDecimal(v);
  if (!d.ok) throw new Error(`decimal inválido: ${v}`);
  return d.value;
}

/** Una unidad mínima de la moneda (0,01 en VES y USD): la tolerancia de caja. */
function unidadMinima(moneda: string): Decimal {
  const escala = minorUnitsOf(moneda);
  return escala === 0 ? decimalDe("1") : decimalDe(`0.${"0".repeat(escala - 1)}1`);
}

function igtfSobre(base: Decimal, cond: CondicionDePago, moneda: string): Decimal {
  if (cond.igtf === null || base.lessThanOrEqualTo(0)) return decimalDe("0");
  const r = percibirIgtf(base, cond.igtf, moneda);
  if (!r.ok) throw new Error(r.error.message);
  return r.value.monto;
}

/**
 * UN pago aplicado a lo pendiente. Reglas de caja:
 *
 *   1. Lo necesario para cerrar = pendiente en la moneda del pago + su IGTF.
 *   2. Si lo entregado llega a lo necesario (con tolerancia de UNA unidad
 *      mínima: 22,68 cierra una cuenta de 22,6848 USD, porque no existe
 *      moneda de medio céntimo), el documento queda pagado y lo que sobre es
 *      vuelto — solo en efectivo, redondeado HACIA ABAJO: la caja jamás
 *      devuelve más de lo que recibió. Sin efectivo, sobrar es un error.
 *   3. Si no llega, abona: lo entregado se reparte en base + IGTF de modo que
 *      base + IGTF(base) = entregado.
 */
export function pasoDeCobro(p: {
  pendienteFuncional: Decimal;
  entregado: Decimal;
  moneda: string;
  /** La moneda de la empresa: decide a cuántos céntimos se valora un abono parcial. */
  monedaFuncional: string;
  instrumento: string;
  cond: CondicionDePago;
}): Result<PasoDeCobro, SalesError> {
  const cero = decimalDe("0");
  if (!p.entregado.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El monto de cada forma de pago tiene que ser mayor que cero.",
    });
  }
  const u = unidadMinima(p.moneda);
  const escala = minorUnitsOf(p.moneda);
  /**
   * EL CÉNTIMO DE LA CAJA (ADR-0063 §2). Lo que hace falta para cerrar se expresa en las
   * unidades mínimas de la moneda del pago: no existe el medio céntimo, ni el billete de
   * 0,00000147 dólares. Antes se guardaba el pendiente ÷ tasa con ocho decimales y la caja en
   * dólares quedaba con «USD 7,02529438» y el arqueo pedía contar eso (QA 2026-09-15, h. 17,
   * 28); y el vuelto de 5 sobre 2,80 salía «2,19», un céntimo de menos (h. 16).
   */
  const pendMon = p.pendienteFuncional.dividedBy(p.cond.tasa).toDecimalPlaces(escala, 4);
  const igtfTotal = igtfSobre(pendMon, p.cond, p.moneda);
  const necesario = pendMon.plus(igtfTotal);
  const dif = p.entregado.minus(necesario);

  if (dif.greaterThan(u.negated())) {
    let vuelto = cero;
    if (dif.greaterThanOrEqualTo(u)) {
      if (!CON_VUELTO.has(p.instrumento)) {
        return err({
          code: "VALIDATION_FAILED",
          message: `Lo recibido (${p.entregado.toDecimalPlaces(escala, 4).toFixed(escala)} ${p.moneda}) supera lo que falta (${necesario.toDecimalPlaces(escala, 2).toFixed(escala)} ${p.moneda}${p.cond.igtf === null ? "" : " con IGTF"}) y esta forma de pago no da vuelto. Ajusta el monto.`,
        });
      }
      vuelto = dif.toDecimalPlaces(escala, 1);
    }
    return ok({
      aplicado: pendMon,
      aplicadoFuncional: p.pendienteFuncional,
      igtf: igtfTotal,
      vuelto,
      cubre: true,
    });
  }

  let aplicado = p.entregado;
  let igtf = cero;
  if (p.cond.igtf !== null) {
    const r = p.cond.igtf;
    const parte = p.entregado.times(r).dividedBy(r.plus(1)).toDecimalPlaces(escala, 4);
    let hallado = false;
    for (const ajuste of ["0", "-1", "1"]) {
      const candidato = parte.plus(u.times(decimalDe(ajuste)));
      const base = p.entregado.minus(candidato);
      if (base.greaterThan(0) && igtfSobre(base, p.cond, p.moneda).equals(candidato)) {
        aplicado = base;
        igtf = candidato;
        hallado = true;
        break;
      }
    }
    if (!hallado) {
      aplicado = p.entregado.minus(parte);
      igtf = igtfSobre(aplicado, p.cond, p.moneda);
    }
  }
  if (!aplicado.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El monto no alcanza ni para el IGTF de esa forma de pago.",
    });
  }
  return ok({
    aplicado,
    // El abono parcial se guarda tal como se entregó, y su valor funcional a las unidades
    // mínimas de la moneda de la empresa (ADR-0063 §2): un saldo con seis decimales no lo
    // paga nadie (h. 32, 37, 56).
    aplicadoFuncional: aplicado
      .times(p.cond.tasa)
      .toDecimalPlaces(minorUnitsOf(p.monedaFuncional), 4),
    igtf,
    vuelto: cero,
    cubre: false,
  });
}

/** Cuánto pedir en esa forma de pago para cerrar lo pendiente, IGTF incluido,
 *  redondeado al céntimo más cercano: queda siempre dentro de la tolerancia
 *  de una unidad mínima, así que pagar lo sugerido cierra la venta. */
function montoParaCerrar(
  pendienteFuncional: Decimal,
  moneda: string,
  cond: CondicionDePago,
): { monto: Decimal; igtf: Decimal } {
  const escala = minorUnitsOf(moneda);
  // La MISMA base que pasoDeCobro (ADR-0063 §2): lo que el botón sugiere es exactamente lo
  // que se guarda al cobrarlo. Antes el botón decía «USD 4,23» y se guardaba 4,22529291.
  const pendMon = pendienteFuncional.dividedBy(cond.tasa).toDecimalPlaces(escala, 4);
  const igtf = igtfSobre(pendMon, cond, moneda);
  return { monto: pendMon.plus(igtf).toDecimalPlaces(escala, 4), igtf };
}

/**
 * Las condiciones de UN pago con los datos de la base: la tasa del día de la
 * empresa y la regla de IGTF (activa, en divisa, instrumento que causa, regla
 * vigente). La MISMA consulta que usa `registerPayment` para percibir.
 */
async function condicionDePago(
  sql: TransactionSql,
  companyId: string,
  instrumento: string,
  moneda: string,
  funcional: string,
  fecha: string,
): Promise<Result<CondicionDePago, SalesError>> {
  let tasa = decimalDe("1");
  if (moneda !== funcional) {
    const [t] = await sql<{ rate: string | null }[]>`
      select f.rate::text as rate
        from platform.rate_for(${companyId}, ${moneda}, ${funcional}, ${diaNegocio(fecha)}::date) f`;
    if (!t?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: mensajeFaltaTasa(diaNegocio(fecha), diaNegocio(new Date())),
      });
    }
    tasa = decimalDe(t.rate);
  }
  const reglaR = await reglaIgtf(sql, companyId, instrumento, moneda, funcional, fecha);
  if (!reglaR.ok) return reglaR;
  const regla = reglaR.value;
  // F-05: si la empresa ABSORBE el IGTF, la caja no se lo pide al cliente — el documento se paga
  // justo y la percepción la asume la empresa (registerPayment la asienta como gasto).
  const cobra = regla !== null && !regla.absorbe;
  return ok({
    tasa,
    igtf: cobra ? regla.tasa : null,
    igtfFuente: cobra ? regla.fuente : null,
  });
}

/**
 * El IGTF que se le PIDE al cliente en este instrumento y moneda (el aviso `/v1/pos/igtf`): la
 * tasa si causa y la empresa no lo absorbe, null si no. La misma regla que el cobro.
 */
export async function igtfQueSePide(
  sql: TransactionSql,
  companyId: string,
  instrumento: string,
  moneda: string,
): Promise<Result<string | null, SalesError>> {
  const [c] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!c) return ok(null);
  const r = await reglaIgtf(
    sql,
    companyId,
    instrumento,
    moneda,
    c.moneda,
    new Date().toISOString(),
  );
  if (!r.ok) return r;
  return ok(r.value === null || r.value.absorbe ? null : r.value.tasaTexto);
}

/** La regla de IGTF que causa ESTE pago, o null. Una sola definición. */
async function reglaIgtf(
  sql: TransactionSql,
  companyId: string,
  instrumento: string,
  moneda: string,
  funcional: string,
  fecha: string,
): Promise<
  Result<
    { tasa: Decimal; tasaTexto: string; fuente: string | null; absorbe: boolean } | null,
    SalesError
  >
> {
  if (moneda === funcional || instrumento === "saldo_a_favor" || instrumento === "retencion_iva") {
    return ok(null);
  }
  const [gate] = await sql<
    {
      enabled: boolean;
      causes: boolean | null;
      absorbe: boolean;
      rate: string | null;
      source: string | null;
    }[]
  >`select -- E-02 (RESPUESTA §2.6; ADR-0072 §1-2): agente de percepción es quien ES especial el
           -- día del cobro, por la vigencia de su tipo. El acta de activación (igtf_enabled_at) ya
           -- no la apaga: un SPE que cobra en divisas percibe siempre (LIGTF art. 4.6).
           platform.taxpayer_type_at(c.id, ${diaNegocio(fecha)}::date) is not distinct from
             'especial' as enabled,
           -- Qué instrumento causa es DATA de plataforma con su fuente (PA SNAT/2022/000013 art. 1:
           -- «sin mediación de instituciones financieras»; 20261002100100). La empresa no lo cambia.
           -- Sin coalesce: un instrumento sin clasificar es un error legible, no un «no causa»
           -- silencioso (re-revisión 5; el pgTAP 099 exige la fila para todo instrumento).
           (select k.causes from public.igtf_instrument_classes k
             where k.instrument = ${instrumento}) as causes,
           coalesce(cs.absorb_igtf, false) as absorbe,
           r.rate::text as rate, r.legal_source as source
      from public.companies c
      left join public.company_settings cs on cs.company_id = c.id
      left join lateral (
        select rate, legal_source from public.igtf_rules
         where effective_from <= ${diaNegocio(fecha)}::date
         order by effective_from desc limit 1
      ) r on true
     where c.id = ${companyId}`;
  if (gate?.enabled !== true) return ok(null);
  // Re-revisión 6, decidido por criterio: un especial que cobra en divisa con «otro» no tiene vía
  // silenciosa para no percibir — que diga con qué le pagaron.
  if (instrumento === "otro") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Un sujeto pasivo especial no registra un cobro en divisas como «otro»: regístralo con su " +
        "instrumento verdadero (efectivo en divisas, Zelle, USDT, transferencia, tarjeta o punto de " +
        "venta). De eso depende si causa IGTF (PA SNAT/2022/000013 art. 1).",
    });
  }
  if (gate.causes === null) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La forma de pago «${instrumento}» no está clasificada para el IGTF: no se sabe si causa. Avisa a soporte; no se registra un cobro en divisas sin saberlo.`,
    });
  }
  if (!gate.causes || gate.rate === null) return ok(null);
  return ok({
    tasa: decimalDe(gate.rate),
    tasaTexto: gate.rate,
    fuente: gate.source,
    absorbe: gate.absorbe,
  });
}

/**
 * La VISTA PREVIA del cobro (`POST /v1/pos/tender`): sin escribir nada, lo que
 * haría la venta con estas formas de pago — cuánto abona cada una, su IGTF,
 * el vuelto, lo que falta y cuánto pedir en cada forma para cerrar.
 */
export async function previsualizarCobro(
  uow: UnitOfWork,
  input: PosTenderRequest,
): Promise<Result<PosTenderResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cobrar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.payment.register", fecha);
  if (!ctx.ok) return ctx;
  const funcional = ctx.value.functionalCurrency;
  const total = parseDecimal(input.total);
  if (!total.ok) return err({ code: "VALIDATION_FAILED", message: "Total no interpretable." });

  const cache = new Map<string, Result<CondicionDePago, SalesError>>();
  const cond = async (instrumento: string, moneda: string) => {
    const k = `${instrumento}|${moneda}`;
    let c = cache.get(k);
    if (c === undefined) {
      c = await condicionDePago(sql, input.company_id, instrumento, moneda, funcional, fecha);
      cache.set(k, c);
    }
    return c;
  };
  const texto = (d: Decimal) => d.toFixed(8);

  let pendiente = total.value;
  let vuelto: { amount: string; currency: string } | null = null;
  const rows: PosTenderResponse["rows"] = [];
  for (const p of input.payments) {
    const base = { instrument: p.instrument, currency: p.currency, tendered: p.amount };
    const entregado = parseDecimal(p.amount);
    if (!entregado.ok) {
      rows.push({
        ...base,
        applied: null,
        applied_functional: null,
        igtf: null,
        change: null,
        covers: false,
        error: "Monto no interpretable.",
      });
      continue;
    }
    if (!pendiente.greaterThan(0)) {
      rows.push({
        ...base,
        applied: null,
        applied_functional: null,
        igtf: null,
        change: null,
        covers: false,
        error: "La venta ya queda pagada con las formas anteriores: sobra esta.",
      });
      continue;
    }
    const c = await cond(p.instrument, p.currency);
    if (!c.ok) {
      rows.push({
        ...base,
        applied: null,
        applied_functional: null,
        igtf: null,
        change: null,
        covers: false,
        error: c.error.message,
      });
      continue;
    }
    const paso = pasoDeCobro({
      pendienteFuncional: pendiente,
      entregado: entregado.value,
      moneda: p.currency,
      monedaFuncional: ctx.value.functionalCurrency,
      instrumento: p.instrument,
      cond: c.value,
    });
    if (!paso.ok) {
      rows.push({
        ...base,
        applied: null,
        applied_functional: null,
        igtf: null,
        change: null,
        covers: false,
        error: paso.error.message,
      });
      continue;
    }
    const v = paso.value;
    rows.push({
      ...base,
      applied: texto(v.aplicado),
      applied_functional: texto(v.aplicadoFuncional),
      igtf: v.igtf.isZero() ? null : texto(v.igtf),
      change: v.vuelto.isZero() ? null : texto(v.vuelto),
      covers: v.cubre,
      error: null,
    });
    if (!v.vuelto.isZero()) vuelto = { amount: texto(v.vuelto), currency: p.currency };
    pendiente = v.cubre ? decimalDe("0") : pendiente.minus(v.aplicadoFuncional);
  }
  if (pendiente.isNegative()) pendiente = decimalDe("0");

  const suggestions: PosTenderResponse["suggestions"] = [];
  for (const o of input.offer) {
    if (!pendiente.greaterThan(0)) {
      suggestions.push({
        instrument: o.instrument,
        currency: o.currency,
        amount: null,
        igtf: null,
        error: null,
      });
      continue;
    }
    const c = await cond(o.instrument, o.currency);
    if (!c.ok) {
      suggestions.push({
        instrument: o.instrument,
        currency: o.currency,
        amount: null,
        igtf: null,
        error: c.error.message,
      });
      continue;
    }
    const m = montoParaCerrar(pendiente, o.currency, c.value);
    suggestions.push({
      instrument: o.instrument,
      currency: o.currency,
      amount: texto(m.monto),
      igtf: m.igtf.isZero() ? null : texto(m.igtf),
      error: null,
    });
  }

  return ok({
    functional_currency: funcional,
    total: texto(total.value),
    paid_functional: texto(total.value.minus(pendiente)),
    remaining_functional: texto(pendiente),
    complete: !pendiente.greaterThan(0),
    change: vuelto,
    rows,
    suggestions,
  });
}

/** La política de la percepción EN esa moneda: la escala la manda ISO-4217. */
function politicaIgtfDe(moneda: string): { code: CurrencyCode; policy: RoundingPolicy } | null {
  const code = parseCurrency(moneda);
  if (!code.ok) return null;
  const escala = currencyDefinition(code.value).minorUnits;
  return {
    code: code.value,
    policy: {
      id: `igtf:perception:${String(escala)}:${MODO_IGTF}`,
      scale: escala,
      mode: MODO_IGTF,
    },
  };
}
const JURISDICTION = "VE";
const TAX_CODE = "iva";

const DOC_COLUMNS = `id, company_id, kind, series,
  document_number::int as document_number, control_number::int as control_number, control_identifier,
  case when control_number is null then null
       else control_identifier || '-' || lpad(control_number::text, 8, '0') end as control_display,
  status,
  to_char(issued_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as issued_at,
  to_char(annulled_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as annulled_at,
  annul_reason, customer_id, vendor_id, price_list_id, source_document_id,
  transaction_currency, functional_currency, fx_rate::text as fx_rate, rate_source,
  subtotal_amount::text as subtotal_amount, tax_amount::text as tax_amount,
  total_amount::text as total_amount, regime_version_id, rules_version,
  due_date::text as due_date`;

/**
 * P-05 · EL VENCIMIENTO NO ES ANTERIOR AL DÍA DE LA VENTA. Dos días de calendario de Caracas
 * (`AAAA-MM-DD` contra `diaNegocio(fecha)`), comparados como texto ISO: ningún instante entra en
 * la comparación. El CHECK `documents_due_date_chk` dice lo mismo en el esquema; esto lo dice
 * antes y con palabras.
 */
function vencimientoValido(
  dueDate: string | undefined,
  fecha: string,
): Result<string | null, SalesError> {
  if (dueDate === undefined) return ok(null);
  const dia = diaNegocio(fecha);
  // Un día que existe en el calendario: «2026-02-31» pasa la forma y no es una fecha.
  const real = new Date(`${dueDate}T00:00:00Z`);
  if (Number.isNaN(real.getTime()) || real.toISOString().slice(0, 10) !== dueDate) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La fecha en que paga el cliente no es un día del calendario.",
      details: { reason: "due_date_invalid" },
    });
  }
  if (dueDate < dia) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "La fecha en que paga el cliente no puede ser anterior al día de la venta " +
        `(${dia.slice(8, 10)}/${dia.slice(5, 7)}/${dia.slice(0, 4)}).`,
      details: { reason: "due_date_before_sale", sale_day: dia },
    });
  }
  return ok(dueDate);
}

interface Contexto {
  readonly tenantId: string;
  readonly functionalCurrency: string;
  readonly regimeVersionId: string;
  readonly numberingMode: string;
  /** Los kinds que el régimen vigente permite emitir (migración 37). */
  readonly allowedKinds: readonly string[];
  /** El modo de venta vigente (migración 54): la ÚNICA definición. */
  readonly salesMode: SalesMode;
}

export { modoDeVenta } from "./modo-venta.js";

/**
 * H10 (ADR-0071, decidido por criterio): el code sigue siendo FISCAL_NUMBERING_INVALID (lo
 * asevera e2e-sales:343) y `details.reason` dice cuál es la salida. Alternativa: un code propio.
 */
export type MotivoNumeracion = "regime_missing" | "no_range" | "printer_data_incomplete";

/** El LAD49 de claim_fiscal_control y de la emisión, con su motivo leído del mensaje. */
function errorDeNumeracion(message: string): SalesError {
  const reason: MotivoNumeracion | null = message.startsWith("No quedan números de control")
    ? "no_range"
    : message.includes("le faltan los datos de la imprenta")
      ? "printer_data_incomplete"
      : message.includes("no tiene régimen fiscal vigente")
        ? "regime_missing"
        : null;
  return reason === null
    ? { code: "FISCAL_NUMBERING_INVALID", message }
    : { code: "FISCAL_NUMBERING_INVALID", message, details: { reason } };
}

function traducir(e: unknown): SalesError | null {
  const code = (e as { code?: string }).code;
  const message = (e as { message?: string }).message ?? "";
  if (code === "LAD49") return errorDeNumeracion(message);
  if (code === "LAD50") {
    // El mensaje de la función se PROPAGA tal cual: dice qué jurisdicción, qué
    // fecha y qué categoría no tienen regla, y eso es lo que hace falta para
    // cargarla. Un «no se pudo resolver el impuesto» genérico no lo dice.
    return { code: "TAX_RULE_MISSING", message };
  }
  if (code === "LAD06") return { code: "APPEND_ONLY_VIOLATION", message };
  if (code === "LAD67") return { code: "VALIDATION_FAILED", message };
  // Las guardas de la factura de retiro y de su nota (20261005100800): su mensaje es de persona.
  if (code === "LAD72") return { code: "VALIDATION_FAILED", message };
  if (code === "LAD39") return { code: "NEGATIVE_STOCK", message };
  if (code === "23505") {
    return { code: "DUPLICATE", message: "Ya existe un documento con ese número en esa serie." };
  }
  if (code === "23503") return { code: "NOT_FOUND", message: "Recurso no encontrado." };
  return null;
}

/** Autorización + el contexto fiscal de la empresa a la fecha del documento. */
async function autorizar(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  permiso: string,
  fecha: string,
): Promise<Result<Contexto, SalesError>> {
  const scope = await companyScope(sql, userId, companyId, permiso);
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  const [cfg] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;
  if (!cfg) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // El régimen y el modo en UNA consulta: el modo no añade un viaje a la base.
  const [regimen] = await sql<
    {
      regime_version_id: string | null;
      numbering_mode: string | null;
      allowed_kinds: string[] | null;
      sales_mode: SalesMode;
    }[]
  >`
    select r.regime_version_id, r.numbering_mode, r.allowed_kinds,
           platform.sales_mode_at(${companyId}, ${fecha}) as sales_mode
      from (select 1) as ancla
      left join platform.regime_at(${companyId}, ${fecha}) r on true`;
  return ok({
    tenantId: scope.value.tenantId,
    functionalCurrency: cfg.moneda,
    regimeVersionId: regimen?.regime_version_id ?? "",
    numberingMode: regimen?.numbering_mode ?? "",
    allowedKinds: regimen?.allowed_kinds ?? [],
    salesMode: regimen?.sales_mode ?? "ninguno",
  });
}

interface LineaCalculada {
  readonly calc: CalculatedLine;
  readonly productId: string;
  readonly description: string;
  readonly priceListId: string;
  readonly unitPriceList: Money;
  readonly taxRuleId: string | null;
  readonly costSnapshot: string | null;
  /**
   * I-04: la línea es de un producto COMPUESTO. No lleva existencia propia (`esInventariable` es
   * falso), pero venderla saca sus ingredientes (`compuestos.ts`). `productName` es el nombre del
   * catálogo, para decir de qué compuesto es el ingrediente que falta.
   */
  readonly esCompuesto?: boolean;
  readonly productName?: string;
  /**
   * ADR-0044 §1: la categoría tributaria del producto AL EMITIR. Se congela en
   * la línea porque el libro de ventas separa exento, exonerado y no sujeto en
   * columnas legalmente distintas, y la alícuota —que sí se guardaba— vale `0`
   * en las tres. Leer la categoría del producto al generar el libro sería
   * reinterpretar el pasado con el catálogo de hoy.
   */
  readonly taxCategory: string;
  /**
   * `interna` | `exportacion` | `importacion`, o NULL si no se sabe.
   *
   * VALIDAR-SENIAT: Ladino no implementa el régimen de exportación, y una venta
   * a un cliente NO DOMICILIADO puede serlo. Antes que escribir «interna» sobre
   * una operación que quizá no lo es —en un libro que se entrega al fisco—, se
   * deja sin clasificar y el libro lo dice.
   */
  readonly operationType: string | null;
  /**
   * Si esta línea descuenta existencia: un BIEN que no sea compuesto. Sale del
   * producto que este mismo lote ya trajo, así que la emisión no vuelve a
   * preguntarlo línea por línea (2026-09-10). Mismo criterio de siempre.
   */
  readonly esInventariable: boolean;
}

/**
 * A funcional: importe × tasa, redondeado a las minor units de la moneda
 * FUNCIONAL (ADR-0058): el bolívar contable tiene dos decimales, igual que el
 * del documento. El pie funcional es la suma de líneas ya redondeadas y el
 * impuesto funcional se deriva por resta, así que `documents_amounts_chk`
 * cuadra por construcción.
 *
 * La conversión se hace UNA vez por importe y se persiste; no se recalcula al
 * leer. Un documento que se reinterpreta con la tasa de hoy cada vez que se
 * abre no es un documento, es una estimación.
 */
function aFuncional(m: Money, tasa: Decimal, funcional: string): Result<Money, SalesError> {
  const escala = minorUnitsOf(funcional);
  const convertido = Money.of(
    m.multiply(tasa).amount.toDecimalPlaces(escala, 4).toFixed(escala),
    funcional,
  );
  if (!convertido.ok) return err({ code: "VALIDATION_FAILED", message: convertido.error.message });
  return ok(convertido.value);
}

/**
 * Precia y calcula las líneas. Es lo que comparten cotización, pedido y factura,
 * y por eso vive en un sitio: tres copias divergirían en el tercer cambio de
 * regla, y la que divergiera sería la que factura.
 */
async function calcularLineas(
  sql: TransactionSql,
  input: {
    companyId: string;
    customerId: string;
    priceListId: string;
    warehouseId: string | null;
    lines: readonly { product_id: string; quantity: string; description?: string | undefined }[];
    fecha: string;
    functionalCurrency: string;
    conImpuesto: boolean;
    /**
     * ADR-0082: en la factura de retiro el adquirente es la propia empresa, y su tipo de
     * contribuyente es el de la HISTORIA a la fecha (AF3-07), no el de una ficha de cliente.
     */
    adquirenteTipo?: string;
    /** ADR-0078 §7: inactivo es «no se vende»; la mercancía sí se retira. Solo el retiro lo pide. */
    aunInactivos?: boolean;
  },
): Promise<
  Result<
    { lineas: LineaCalculada[]; fxRate: Decimal; rateSource: string; transactionCurrency: string },
    SalesError
  >
> {
  const [lista] = await sql<{ currency_code: string; name: string }[]>`
    select currency_code, name from public.price_lists
     where id = ${input.priceListId} and company_id = ${input.companyId} and status = 'active'`;
  if (!lista) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La lista de precios no existe en esta empresa o está inactiva.",
    });
  }

  // La tasa. Si la lista ya está en moneda funcional, la identidad; si no, la
  // que `rate_for` resuelve para la fecha del documento, con su fuente. Sin
  // ninguna tasa NO se emite: no se inventa una.
  //
  // OJO (corregido 2026-09-14, B12): este comentario decía «ni se usa la de otro
  // día», y era falso. `rate_for` devuelve la ÚLTIMA tasa con fecha menor o igual,
  // SIN límite de antigüedad: si la fuente falla días, se vende con la tasa del
  // último día que la hubo. El documento congela esa tasa y su fuente (se sabe
  // cuál se usó), y el resumen del negocio expone su antigüedad para que la
  // pantalla lo diga. La regla dura de tasa vieja está fuera de alcance.
  let fxRate = parseDecimal("1");
  let rateSource = "identidad";
  if (lista.currency_code !== input.functionalCurrency) {
    const [tasa] = await sql<{ rate: string | null; source: string | null }[]>`
      select f.rate::text as rate, f.source
        from platform.rate_for(${input.companyId}, ${lista.currency_code},
                               ${input.functionalCurrency}, ${diaNegocio(input.fecha)}::date) f`;
    if (!tasa?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa de ${lista.currency_code} a ${input.functionalCurrency} vigente para esa fecha. Cárgala con su fuente antes de emitir.`,
      });
    }
    fxRate = parseDecimal(tasa.rate);
    rateSource = tasa.source ?? "manual";
  }
  // La política del documento EN su moneda (ADR-0058): base e impuesto de cada
  // línea a las minor units; el pie, por suma.
  const politica = politicaDelDocumento(lista.currency_code);
  if (!fxRate.ok) return err({ code: "VALIDATION_FAILED", message: fxRate.error.message });
  const tasaDecimal = fxRate.value;

  const [contraparte] =
    input.adquirenteTipo !== undefined
      ? [{ taxpayer_type_code: input.adquirenteTipo }]
      : await sql<{ taxpayer_type_code: string }[]>`
    select taxpayer_type_code from public.customers
     where id = ${input.customerId} and company_id = ${input.companyId}`;
  if (!contraparte) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  // TODO EN LOTES (2026-09-08): este bucle hacía ~6 consultas POR LÍNEA y en
  // producción cada consulta paga el viaje VPS↔base completo — una venta de
  // varias líneas se comía el timeout. Ahora son CUATRO consultas fijas
  // (productos, precios, alícuotas por categoría, costos) y el bucle trabaja
  // sobre mapas en memoria. La semántica no cambia: mismos errores, mismos
  // mensajes; solo el orden de detección entre líneas puede variar.
  const productIds = [...new Set(input.lines.map((l) => l.product_id))];
  const deSistema = await rechazaProductoDeSistema(sql, input.companyId, productIds);
  if (!deSistema.ok) return deSistema;

  const productosFilas = await sql<
    { id: string; name: string; tax_category_code: string; kind: string; is_composed: boolean }[]
  >`select id, name, tax_category_code, kind, is_composed from public.products
     where id = any(${productIds}::uuid[]) and company_id = ${input.companyId}
       and (status = 'active' or ${input.aunInactivos === true}::boolean)
       and system_code is null`;
  const productos = new Map(productosFilas.map((p) => [p.id, p]));
  if (productos.size !== productIds.length) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Un producto de la venta no existe en esta empresa o no está activo.",
    });
  }

  const preciosFilas = await sql<{ pid: string; amount: string | null }[]>`
    select u.pid, platform.price_at(${input.priceListId}, u.pid, ${input.fecha})::text as amount
      from unnest(${productIds}::uuid[]) as u(pid)`;
  const precios = new Map(preciosFilas.map((p) => [p.pid, p.amount]));

  // La alícuota por CATEGORÍA (el contribuyente es uno solo): resolve_tax
  // levanta excepción sin regla, y un error de Postgres condena la
  // transacción — el savepoint sigue siendo obligatorio (lección de S0.5).
  const alicuotas = new Map<string, { tax_rule_id: string; rate: string }>();
  if (input.conImpuesto) {
    const categorias = [...new Set(productosFilas.map((p) => p.tax_category_code))];
    try {
      const reglas = await sql.savepoint(
        (sp) => sp<{ cat: string; tax_rule_id: string; rate: string }[]>`
          select u.cat, t.tax_rule_id, t.rate::text as rate
            from unnest(${categorias}::text[]) as u(cat),
                 lateral platform.resolve_tax(${input.companyId}, ${diaNegocio(input.fecha)}::date,
                                              ${JURISDICTION}, ${TAX_CODE},
                                              ${contraparte.taxpayer_type_code}, u.cat) t`,
      );
      for (const r of reglas) alicuotas.set(r.cat, r);
    } catch (e) {
      const conocido = traducir(e);
      if (conocido) return err(conocido);
      throw e;
    }
  }

  const costos = new Map<string, string>();
  if (input.warehouseId !== null) {
    const filasCosto = await sql<{ product_id: string; last_unit_cost: string }[]>`
      select product_id, last_unit_cost::text as last_unit_cost
        from public.stock_balances
       where company_id = ${input.companyId} and warehouse_id = ${input.warehouseId}
         and product_id = any(${productIds}::uuid[]) and lot_id is null`;
    for (const f of filasCosto) costos.set(f.product_id, f.last_unit_cost);
  }

  const salida: LineaCalculada[] = [];
  for (const l of input.lines) {
    const producto = productos.get(l.product_id)!;

    const listado = listedPriceOf(
      input.priceListId,
      precios.get(l.product_id) ?? null,
      lista.currency_code,
    );
    if (!listado.ok) return err({ code: "VALIDATION_FAILED", message: listado.error.message });

    const cantidad = parseDecimal(l.quantity);
    if (!cantidad.ok) return err({ code: "VALIDATION_FAILED", message: cantidad.error.message });

    // El documento se calcula EN LA MONEDA DE LA LISTA, no en la funcional. Es
    // la diferencia entre tener diferencial cambiario y no tenerlo: si la
    // factura naciera ya convertida a bolívares, la tasa quedaría cocida dentro
    // del total y el cobro posterior no tendría contra qué compararse. Por eso
    // la conversión va en los siete campos de ADR-0020, no en el importe.
    const identidad = parseDecimal("1");
    if (!identidad.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    const resuelto = resolvePrice({
      listed: listado.value,
      quantity: cantidad.value,
      documentCurrency: lista.currency_code,
      fxRate: identidad.value,
      roundingPolicy: PRECIO_POLICY,
    });
    if (!resuelto.ok) {
      // C-06: un producto sin precio en la lista que aplica NO se vende por ella, y no cae en
      // silencio a la de mostrador (cobraría otro precio sin que nadie lo eligiera). Se dice
      // cuál producto y cuál lista, que es lo que la persona necesita para arreglarlo.
      const sinPrecio = resuelto.error.code === "NO_PRICE_FOR_PRODUCT";
      return err({
        code: sinPrecio ? "VALIDATION_FAILED" : "MONEY_ERROR",
        message: sinPrecio
          ? `«${producto.name}» no tiene precio en la lista «${lista.name}». Ponle su precio en esa lista o vende con otra.`
          : resuelto.error.message,
      } as SalesError);
    }

    // La alícuota: del catálogo, o no hay línea (ADR-0038) — ya resuelta por
    // categoría en el lote de arriba.
    let taxRuleId: string | null = null;
    let taxRate = parseDecimal("0");
    if (input.conImpuesto) {
      const regla = alicuotas.get(producto.tax_category_code);
      if (!regla) {
        return err({
          code: "TAX_RULE_MISSING",
          message: "No hay regla tributaria vigente para un producto de la venta.",
        });
      }
      taxRuleId = regla.tax_rule_id;
      taxRate = parseDecimal(regla.rate);
    }
    if (!taxRate.ok) return err({ code: "VALIDATION_FAILED", message: taxRate.error.message });

    const calc = calculateLine({
      quantity: cantidad.value,
      unitPrice: resuelto.value.unitPriceDocumentCurrency,
      taxRate: taxRate.value,
      basePolicy: politica,
      taxPolicy: politica,
    });
    if (!calc.ok) return err({ code: "VALIDATION_FAILED", message: calc.error.message });

    // Costo del kardex AL EMITIR, para margen. Snapshot: el costo de hoy no
    // reinterpreta el margen de una venta de hace tres meses.
    let costSnapshot: string | null = null;
    if (input.warehouseId !== null && producto.kind === "good" && !producto.is_composed) {
      costSnapshot = costos.get(l.product_id) ?? null;
    }

    salida.push({
      calc: calc.value,
      productId: l.product_id,
      description: l.description ?? producto.name,
      priceListId: resuelto.value.priceListApplied,
      unitPriceList: resuelto.value.unitPriceListCurrency,
      taxRuleId,
      costSnapshot,
      taxCategory: producto.tax_category_code,
      operationType: contraparte.taxpayer_type_code === "no_domiciliado" ? null : "interna",
      esInventariable: producto.kind === "good" && !producto.is_composed,
      esCompuesto: producto.kind === "good" && producto.is_composed,
      productName: producto.name,
    });
  }
  return ok({
    lineas: salida,
    fxRate: tasaDecimal,
    rateSource,
    transactionCurrency: lista.currency_code,
  });
}

/** La lista que aplica: la del cuerpo si se mandó, si no la preferida del cliente. */
async function resolverLista(
  sql: TransactionSql,
  userId: string,
  companyId: string,
  customerId: string,
  pedida: string | undefined,
  /**
   * `de_contado`: la caja cotiza y cobra en el acto — el bloqueo de cobranzas NO impide
   * venderle; lo que impide es FIARLE, y eso lo comprueba quickSale con el cobro en la mano.
   */
  bloqueo: "rechazar" | "de_contado" = "rechazar",
): Promise<Result<string, SalesError>> {
  const [cliente] = await sql<
    {
      default_price_list_id: string | null;
      status: string;
      is_system: boolean;
      own_company: boolean;
    }[]
  >`
    select default_price_list_id, status, is_system, own_company from public.customers
     where id = ${customerId} and company_id = ${companyId}`;
  if (!cliente) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // ADR-0082: la ficha de la propia empresa existe solo como adquirente de sus facturas de
  // retiro. No es un cliente: no se le vende ni se le fía.
  if (cliente.own_company) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Esta ficha es la del propio negocio (el adquirente de sus facturas de retiro): no se le vende. Elige al cliente de la venta.",
    });
  }
  if (cliente.status === "blocked" && bloqueo === "rechazar") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El cliente está bloqueado por cobranzas: no se le vende a crédito. En la caja se le vende de contado.",
    });
  }

  // Sin lista preferida, la del mostrador la decide el DUEÑO
  // (company_settings.default_price_list_id, migración 36) — para el
  // Consumidor final (congelado, no puede tener preferida) y para el cliente
  // recién creado con su cédula en el POS: el cajero no elige lista, así que
  // no hay atribución que vigilar. Sin el dato, la heurística de siempre
  // («detal» por nombre, o la más vieja). Pedir otra distinta sigue
  // exigiendo el override.
  const defaultEfectiva =
    cliente.default_price_list_id !== null && !cliente.is_system
      ? cliente.default_price_list_id
      : ((
          await sql<{ id: string }[]>`
            select l.id from public.price_lists l
             where l.company_id = ${companyId} and l.status = 'active'
             order by (l.id = (select cs.default_price_list_id from public.company_settings cs
                                where cs.company_id = ${companyId})) desc,
                      (l.name = 'detal') desc, (l.name like 'detal%') desc, l.created_at
             limit 1`
        )[0]?.id ?? null);

  if (pedida === undefined) {
    if (defaultEfectiva === null) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "El cliente no tiene lista de precios preferida y no se indicó ninguna: elige una explícitamente.",
      });
    }
    return ok(defaultEfectiva);
  }
  // Cambiar la lista de una venta es una ATRIBUCIÓN, no una preferencia de
  // pantalla: exige permiso propio, y solo cuando de verdad cambia.
  if (pedida !== defaultEfectiva) {
    const [permiso] = await sql<{ autorizado: boolean }[]>`
      select platform.ladino_user_has_permission(${userId}, 'sales.price_list.override', ${companyId})
             as autorizado`;
    if (!permiso?.autorizado) {
      return err({
        code: "PERMISSION_REQUIRED",
        message:
          "Cambiar la lista de precios de una venta exige el permiso sales.price_list.override.",
      });
    }
    // C-06: el ajuste «Vendo al mayor» gobierna LA CAJA (`quotePos` y `quickSale`, las dos
    // puertas que entran con `de_contado`), y no solo su pantalla: con el ajuste apagado, la
    // caja no cobra con otra lista que la que toca, tampoco a quien tiene el permiso. El permiso
    // va PRIMERO (quien no lo tiene recibe su 403 de siempre). La factura de administración
    // (`rechazar`) y la lista asignada al cliente no pasan por aquí: quedan como estaban. Una
    // lectura más, solo cuando la caja pide otra lista: el cobro normal no la paga.
    if (bloqueo === "de_contado" && defaultEfectiva !== null) {
      const [ajuste] = await sql<{ al_mayor: boolean }[]>`
        select coalesce((select cs.sells_wholesale from public.company_settings cs
                          where cs.company_id = ${companyId}), false) as al_mayor`;
      if (ajuste?.al_mayor !== true) {
        return err({
          code: "VALIDATION_FAILED",
          message:
            "Tu negocio no tiene activado vender al mayor. Actívalo en Configuración para cobrar con otra lista.",
        });
      }
    }
  }
  return ok(pedida);
}

/** El recibo y su devolución no son documentos fiscales: sin IVA ni clasificación de libro. */
/**
 * EL FISCAL EN MONEDA FUNCIONAL DE UNA LÍNEA (ADR-0075 §1, E-05). UNA sola función: la usan
 * `insertarDocumento` (lo que la factura guarda e imprime) y `quotePos` (lo que la caja anuncia
 * y cobra). Antes eran dos reglas y la caja enseñaba 9.518,73 donde la factura decía 9.515,31.
 *   base_bs = round(base_divisa × tasa, 2) · iva_bs = round(base_bs × alícuota, 2) · total = suma.
 * Un documento que ya nace en la moneda funcional no convierte nada.
 */
export function fiscalDeLinea(
  calc: Pick<LineaCalculada["calc"], "subtotal" | "total" | "taxRate">,
  tasa: Decimal,
  monedaDocumento: string,
  funcional: string,
): { sub: Result<Money, SalesError>; tot: Result<Money, SalesError> } {
  const sub = aFuncional(calc.subtotal, tasa, funcional);
  if (monedaDocumento === funcional || !sub.ok) {
    return { sub, tot: aFuncional(calc.total, tasa, funcional) };
  }
  const escala = minorUnitsOf(funcional);
  const iva = sub.value.amount.times(calc.taxRate).toDecimalPlaces(escala, 4);
  const tot = Money.of(sub.value.amount.plus(iva).toFixed(escala), funcional);
  return {
    sub,
    tot: tot.ok ? tot : err({ code: "VALIDATION_FAILED" as const, message: tot.error.message }),
  };
}

function esNoFiscal(kind: string): boolean {
  return kind === "receipt" || kind === "receipt_return";
}

async function insertarDocumento(
  sql: TransactionSql,
  ctx: Contexto,
  d: {
    companyId: string;
    kind: string;
    series: string;
    customerId: string;
    vendorId: string | null;
    branchId: string | null;
    priceListId: string;
    sourceDocumentId: string | null;
    lineas: LineaCalculada[];
    fxRate: Decimal;
    rateSource: string;
    transactionCurrency: string;
    notes: string | null;
    /** P-05: el vencimiento acordado al vender (`AAAA-MM-DD`). Solo la venta lo trae. */
    dueDate?: string | null;
    /** ADR-0082: la factura de retiro congela como adquirente a la PROPIA empresa. */
    adquirente?: {
      name: string;
      tax_id: string | null;
      address: string | null;
      taxpayer_type: string;
    };
  },
): Promise<Result<DocumentResponse, SalesError>> {
  const totales = calculateTotals(d.lineas.map((l) => l.calc));
  if (!totales.ok) return err({ code: "VALIDATION_FAILED", message: totales.error.message });

  /**
   * Los totales del PIE van en moneda funcional, porque es contra ellos que
   * `platform.document_balance` resta los cobros —también funcionales— y una
   * comparación entre monedas distintas es un saldo inventado. El total en
   * moneda de transacción vive en `amount_transaction_currency`, que es
   * exactamente para lo que ADR-0020 lo puso ahí.
   *
   * El impuesto funcional se DERIVA como total − subtotal en vez de convertirse
   * aparte: convertir los tres por separado produce redondeos que no cuadran, y
   * `documents_amounts_chk` exige que cuadren. Restar no puede desbalancear.
   */
  /**
   * E-05 (ADR-0075 §1): EL FISCAL EN Bs SALE DE LA BASE EN Bs, POR LÍNEA. Antes el total
   * funcional de la línea era el total en divisa —con su IVA ya redondeado en divisa— por la
   * tasa, y el IVA en Bs de la factura no era la alícuota de su base en Bs (1.315,87 contra
   * 1.312,46 en una línea de 9,60 USD). Ahora:
   *   base_bs = round(base_divisa × tasa, 2) · iva_bs = round(base_bs × alícuota, 2) · total = suma.
   * La contraprestación —y la deuda del cliente— sigue siendo el total EN LA MONEDA DEL
   * DOCUMENTO (`amount_transaction_currency`). Un documento que ya nace en la moneda funcional
   * no convierte nada y queda como estaba.
   */
  const funcionales = d.lineas.map((l) =>
    fiscalDeLinea(l.calc, d.fxRate, d.transactionCurrency, ctx.functionalCurrency),
  );
  const fallo = funcionales.find((f) => !f.sub.ok || !f.tot.ok);
  if (fallo !== undefined) {
    if (!fallo.sub.ok) return fallo.sub;
    if (!fallo.tot.ok) return fallo.tot;
  }
  const cero = parseDecimal("0");
  if (!cero.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
  let subFunc = cero.value;
  let totFunc = cero.value;
  for (const f of funcionales) {
    if (!f.sub.ok || !f.tot.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    subFunc = subFunc.plus(f.sub.value.amount);
    totFunc = totFunc.plus(f.tot.value.amount);
  }
  const taxFunc = totFunc.minus(subFunc);

  // R-05, lado cliente (ADR-0033, migración 33): el documento COPIA razón
  // social, RIF/cédula y domicilio del cliente al nacer; nunca los referencia.
  // El RIF va NORMALIZADO — la misma forma que la clave natural de customers;
  // los guiones son presentación y se ponen al enseñarlo.
  // A-4/A-6 (decidido por criterio): la NC y la ND identifican al adquirente EXACTAMENTE como la
  // factura que corrigen — su identificación CONGELADA (lo vivo solo si el origen es anterior a la
  // migración 33). Así, una factura vieja al «Consumidor final» tiene su nota.
  const esNotaConOrigen =
    (d.kind === "credit_note" ||
      d.kind === "debit_note" ||
      // ADR-0082: la nota de crédito de un retiro identifica al adquirente como su factura.
      d.kind === "withdrawal_credit_note") &&
    d.sourceDocumentId !== null;
  const [contraparte] =
    d.adquirente !== undefined
      ? [d.adquirente]
      : esNotaConOrigen
        ? await sql<
            { name: string; tax_id: string | null; address: string | null; taxpayer_type: string }[]
          >`
        select coalesce(o.customer_name_snapshot, cu.legal_name) as name,
               coalesce(o.customer_tax_id_snapshot,
                        upper(regexp_replace(cu.tax_id, '[^a-zA-Z0-9]', '', 'g'))) as tax_id,
               coalesce(o.customer_address_snapshot, cu.fiscal_address) as address,
               coalesce(o.customer_taxpayer_type_snapshot, cu.taxpayer_type_code) as taxpayer_type
          from public.documents o
          join public.customers cu on cu.id = o.customer_id
         where o.id = ${d.sourceDocumentId} and o.company_id = ${d.companyId}
           and o.customer_id = ${d.customerId}`
        : await sql<
            { name: string; tax_id: string | null; address: string | null; taxpayer_type: string }[]
          >`
    select legal_name as name,
           upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as tax_id,
           fiscal_address as address,
           -- B3 (migración 20260928170200): el tipo de contribuyente del día de la emisión,
           -- que el libro de ventas reproduce en vez de leer el maestro vivo.
           taxpayer_type_code as taxpayer_type
      from public.customers
     where id = ${d.customerId} and company_id = ${d.companyId}`;
  if (!contraparte) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });

  // Y el EMISOR igual (PA 00071 art. 13.5, migración 34): razón social, RIF
  // normalizado y domicilio fiscal — más el de la sucursal, si el documento
  // tiene una. El domicilio puede ser NULL (la empresa aún no lo cargó): el
  // PDF lo omite honesto; inventarlo aquí sería peor.
  const [emisor] = await sql<{ name: string; tax_id: string; address: string | null }[]>`
    select legal_name as name,
           upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) as tax_id,
           fiscal_address as address
      from public.companies where id = ${d.companyId}`;
  const [sucursal] =
    d.branchId === null
      ? [undefined]
      : await sql<{ address: string | null }[]>`
          select fiscal_address as address from public.branches
           where id = ${d.branchId} and company_id = ${d.companyId}`;

  const [doc] = await sql<DocumentResponse[]>`
    insert into public.documents
      (tenant_id, company_id, branch_id, kind, series, customer_id, vendor_id, price_list_id,
       source_document_id, transaction_currency, functional_currency, fx_rate, rate_source,
       rate_timestamp, rounding_policy_id, amount_transaction_currency, functional_amount,
       subtotal_amount, tax_amount, total_amount, notes,
       customer_name_snapshot, customer_tax_id_snapshot, customer_address_snapshot,
       customer_taxpayer_type_snapshot,
       issuer_name_snapshot, issuer_tax_id_snapshot, issuer_address_snapshot,
       issuer_branch_address_snapshot, due_date)
    values (${ctx.tenantId}, ${d.companyId}, ${d.branchId}, ${d.kind}, ${d.series},
            ${d.customerId}, ${d.vendorId}, ${d.priceListId === "" ? null : d.priceListId},
            ${d.sourceDocumentId},
            ${d.transactionCurrency}, ${ctx.functionalCurrency}, ${d.fxRate.toFixed()},
            ${d.rateSource}, now(),
            ${politicaDelDocumento(d.transactionCurrency).id},
            ${totales.value.total.toAmountString()}, ${totFunc.toFixed(8)},
            ${subFunc.toFixed(8)}, ${taxFunc.toFixed(8)}, ${totFunc.toFixed(8)}, ${d.notes},
            ${contraparte.name}, ${contraparte.tax_id}, ${contraparte.address},
            ${contraparte.taxpayer_type},
            ${emisor!.name}, ${emisor!.tax_id}, ${emisor!.address},
            ${sucursal?.address ?? null}, ${d.dueDate ?? null}::date)
    returning ${sql.unsafe(DOC_COLUMNS)}`;

  /**
   * LAS LÍNEAS, EN UNA SOLA SENTENCIA (2026-09-10).
   *
   * Antes se insertaban de una en una, y **cada insert es una espera de red
   * completa** — el driver serializa dentro de la transacción, así que un
   * carrito de diez renglones eran diez viajes. Ahora van todas juntas.
   *
   * Los importes viajan como TEXTO dentro del JSON y `jsonb_to_recordset` los
   * convierte a `numeric` en el servidor: nunca pasan por un `double`, que es
   * la regla 7. Cada valor es exactamente el mismo string que producía el
   * bucle — aquí no se recalcula nada.
   *
   * La preparación (las conversiones a funcional) sigue ANTES del insert y en
   * el mismo orden, así que una línea imposible se rechaza igual que antes.
   */
  const filas: Record<string, string | number | null>[] = [];
  let n = 0;
  for (const l of d.lineas) {
    const f = funcionales[n]!;
    if (!f.sub.ok || !f.tot.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
    const precioFunc = aFuncional(l.calc.unitPrice, d.fxRate, ctx.functionalCurrency);
    if (!precioFunc.ok) return precioFunc;
    n += 1;
    filas.push({
      line_number: n,
      product_id: l.productId,
      description: l.description,
      quantity: l.calc.quantity.toFixed(),
      unit_price_transaction: l.calc.unitPrice.toAmountString(),
      unit_price_functional: precioFunc.value.toAmountString(),
      price_list_applied_id: l.priceListId === "" ? null : l.priceListId,
      tax_rule_id: l.taxRuleId,
      tax_rate_snapshot: l.calc.taxRate.toFixed(),
      tax_amount: l.calc.taxAmount.toAmountString(),
      line_subtotal_transaction: l.calc.subtotal.toAmountString(),
      line_subtotal_functional: f.sub.value.toAmountString(),
      line_total_transaction: l.calc.total.toAmountString(),
      line_total_functional: f.tot.value.toAmountString(),
      amount_transaction_currency: l.calc.total.toAmountString(),
      functional_amount: f.tot.value.toAmountString(),
      cost_snapshot: l.costSnapshot,
      // EL RECIBO NO TIENE CLASIFICACIÓN FISCAL (plan «Ladino sin RIF», A5): se
      // congela 'no_fiscal' explícito —no NULL, que ya significa «anterior a la
      // migración 27»— y sin tipo de operación. Antes quedaba la categoría del
      // producto (p. ej. gravado_general) y 'interna', que un libro podría leer.
      tax_category_snapshot: esNoFiscal(d.kind) ? "no_fiscal" : l.taxCategory,
      operation_type: esNoFiscal(d.kind) ? null : l.operationType,
    });
  }

  await sql`
    insert into public.document_lines
      (tenant_id, company_id, document_id, line_number, product_id, description, quantity,
       unit_price_transaction, unit_price_functional, price_list_applied_id,
       tax_rule_id, tax_rate_snapshot, tax_amount,
       line_subtotal_transaction, line_subtotal_functional,
       line_total_transaction, line_total_functional,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, rate_timestamp, rounding_policy_id, cost_snapshot,
       tax_category_snapshot, tax_treatment, operation_type)
    select ${ctx.tenantId}, ${d.companyId}, ${doc!.id}, x.line_number, x.product_id,
           x.description, x.quantity,
           x.unit_price_transaction, x.unit_price_functional, x.price_list_applied_id,
           x.tax_rule_id, x.tax_rate_snapshot, x.tax_amount,
           x.line_subtotal_transaction, x.line_subtotal_functional,
           x.line_total_transaction, x.line_total_functional,
           x.amount_transaction_currency, ${d.transactionCurrency}, ${d.fxRate.toFixed()},
           x.functional_amount,
           ${ctx.functionalCurrency}, ${d.rateSource}, now(),
           ${politicaDelDocumento(d.transactionCurrency).id}, x.cost_snapshot,
           -- El tratamiento se deriva con la función de la base y NO aquí
           -- (una segunda definición en TypeScript es cómo dos libros
           -- clasifican distinto la misma línea) — salvo el RECIBO
           -- (migración 37): su línea no lleva regla y el snapshot lo DICE
           -- con 'no_fiscal', en vez de fingir una clasificación de libro.
           x.tax_category_snapshot,
           ${
             esNoFiscal(d.kind)
               ? sql`'no_fiscal'`
               : sql`platform.tax_treatment_of(x.tax_category_snapshot)`
           },
           x.operation_type
      from jsonb_to_recordset(${sql.json(filas)}::jsonb) as x(
        line_number integer, product_id uuid, description text, quantity numeric,
        unit_price_transaction numeric, unit_price_functional numeric,
        price_list_applied_id uuid, tax_rule_id uuid, tax_rate_snapshot numeric,
        tax_amount numeric, line_subtotal_transaction numeric,
        line_subtotal_functional numeric, line_total_transaction numeric,
        line_total_functional numeric, amount_transaction_currency numeric,
        functional_amount numeric, cost_snapshot numeric,
        tax_category_snapshot text, operation_type text)
     order by x.line_number`;
  return ok(doc!);
}

async function auditar(
  sql: TransactionSql,
  tenantId: string,
  doc: DocumentResponse,
  evento: string,
  extra: Record<string, JSONValue> = {},
): Promise<void> {
  const payload: Record<string, JSONValue> = {
    kind: doc.kind,
    series: doc.series,
    document_number: doc.document_number,
    control_number: doc.control_number,
    control_identifier: doc.control_identifier,
    customer_id: doc.customer_id,
    total_amount: doc.total_amount,
    functional_currency: doc.functional_currency,
    fx_rate: doc.fx_rate,
    rate_source: doc.rate_source,
    regime_version_id: doc.regime_version_id,
    ...extra,
  };
  /**
   * ACTA Y EVENTO EN UNA SOLA SENTENCIA (2026-09-10).
   *
   * Siempre van juntos y siempre en este orden: primero el acta, después el
   * evento. Un CTE los escribe de una vez — misma transacción, mismas filas,
   * mismos payloads, mismo orden — y ahorra una espera de red cada vez, que en
   * una venta cobrada son cuatro (emisión, cobro, y sus dos del IGTF).
   *
   * `data` va primero en el CTE porque el orden de escritura importa para
   * quien lea la traza: el acta es el hecho, el evento es su notificación.
   */
  await sql`
    with acta as (
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      values (${tenantId}, ${doc.company_id}, 'document', ${doc.id}, ${evento},
              'user', now(), ${RULES_VERSION}, ${sql.json(payload)})
      returning 1
    )
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    select ${tenantId}, ${doc.company_id}, 'document', ${doc.id}, ${evento}, 1,
           ${sql.json({ document_id: doc.id, ...payload })}
      from acta`;
}

function ahora(fecha: string | undefined): string {
  return fecha ?? new Date().toISOString();
}

// ── Cotización y pedido ────────────────────────────────────────────────────

async function crearBorrador(
  uow: UnitOfWork,
  input: CreateQuoteRequest | CreateOrderRequest,
  kind: "quote" | "order",
  permiso: string,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso, fecha);
  if (!ctx.ok) return ctx;

  const lista = await resolverLista(
    sql,
    actor.userId,
    input.company_id,
    input.customer_id,
    input.price_list_id,
  );
  if (!lista.ok) return lista;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const calculadas = await calcularLineas(sql, {
    companyId: input.company_id,
    customerId: input.customer_id,
    priceListId: lista.value,
    warehouseId: null,
    lines: input.lines,
    fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    // En modo recibos no existe el IVA (plan «Ladino sin RIF», A3): la
    // cotización y el pedido salen como la caja, sin buscar regla alguna.
    // Antes era `true` fijo y daba 409 TAX_RULE_MISSING a quien no tiene IVA.
    conImpuesto: !esModoRecibos(ctx.value),
  });
  if (!calculadas.ok) return calculadas;

  try {
    const doc = await sql.savepoint((sp) =>
      insertarDocumento(sp, ctx.value, {
        companyId: input.company_id,
        kind,
        series: input.series ?? "A",
        customerId: input.customer_id,
        vendorId: input.vendor_id ?? null,
        branchId: input.branch_id ?? null,
        priceListId: lista.value,
        sourceDocumentId: "source_document_id" in input ? (input.source_document_id ?? null) : null,
        lineas: calculadas.value.lineas,
        fxRate: calculadas.value.fxRate,
        rateSource: calculadas.value.rateSource,
        transactionCurrency: calculadas.value.transactionCurrency,
        notes: input.notes ?? null,
      }),
    );
    if (!doc.ok) return doc;
    await auditar(sql, ctx.value.tenantId, doc.value, `sales.${kind}.created`);
    return ok(doc.value);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

export const createQuote = (uow: UnitOfWork, input: CreateQuoteRequest) =>
  crearBorrador(uow, input, "quote", "sales.quote.manage");

export const createOrder = (uow: UnitOfWork, input: CreateOrderRequest) =>
  crearBorrador(uow, input, "order", "sales.order.manage");

/**
 * Confirma un pedido y RESERVA existencias. La reserva no es un movimiento de
 * kardex (ADR-0034 §Alcance y la decisión del encargo): es un compromiso, y el
 * kardex sigue diciendo «lo que hay». Caduca según `reservation_ttl_days`.
 */
export async function confirmOrder(
  uow: UnitOfWork,
  documentId: string,
  input: ConfirmOrderRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Confirmar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.order.manage", fecha);
  if (!ctx.ok) return ctx;

  const [doc] = await sql<{ id: string; status: string; kind: string }[]>`
    select id, status, kind from public.documents
     where id = ${documentId} and company_id = ${input.company_id}
     for update`;
  // `for update`: dos confirmaciones simultáneas del mismo pedido reservaban
  // dos veces (auditoría 2026-09-11, M-16). La segunda espera y ve 'confirmed'.
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.kind !== "order") {
    return err({ code: "VALIDATION_FAILED", message: "Solo un pedido se confirma." });
  }
  if (doc.status !== "draft") {
    return err({
      code: "VALIDATION_FAILED",
      message: `El pedido está en estado ${doc.status}: solo se confirma un borrador.`,
    });
  }

  const [cfg] = await sql<{ ttl: number }[]>`
    select coalesce(s.reservation_ttl_days, 30) as ttl
      from public.companies c
      left join public.inventory_settings s on s.company_id = c.id
     where c.id = ${input.company_id}`;
  const ttl = cfg?.ttl ?? 30;

  // I-04 (ADR-0084, tercera ronda): la línea de un COMPUESTO no reserva. Un compuesto no lleva
  // existencia propia —su disponible es siempre 0 y el pedido no se podía confirmar nunca—; la de
  // sus ingredientes se comprueba al FACTURAR, con la receta de ese momento.
  const lineas = await sql<{ product_id: string; quantity: string; is_composed: boolean }[]>`
    select dl.product_id, dl.quantity::text as quantity, coalesce(p.is_composed, false) as is_composed
      from public.document_lines dl
      left join public.products p on p.id = dl.product_id
     where dl.document_id = ${documentId} order by dl.line_number`;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  for (const l of lineas) {
    if (l.is_composed) continue;
    // El disponible descuenta lo YA reservado por otros pedidos: reservar dos
    // veces la misma unidad es exactamente lo que esta tabla evita. Y la
    // posición se BLOQUEA antes de leerla: dos pedidos distintos sobre el mismo
    // producto se serializan, y el segundo calcula sobre lo que reservó el
    // primero (M-16).
    await sql`
      select 1 from platform.lock_stock_position(
        ${input.company_id}, ${input.warehouse_id}, ${l.product_id}, null)`;
    const [disp] = await sql<{ available: string }[]>`
      select available::text from platform.available_stock(
        ${input.company_id}, ${input.warehouse_id}, ${l.product_id}, null)`;
    const disponible = parseDecimal(disp?.available ?? "0");
    const pedida = parseDecimal(l.quantity);
    if (!disponible.ok || !pedida.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad no interpretable." });
    }
    if (pedida.value.greaterThan(disponible.value)) {
      return err({
        code: "NEGATIVE_STOCK",
        message: `No hay disponible suficiente para reservar: quedan ${disponible.value.toFixed()} y el pedido exige ${pedida.value.toFixed()}.`,
      });
    }
    await sql`
      insert into public.stock_reservations
        (tenant_id, company_id, document_id, warehouse_id, product_id, quantity, expires_at)
      values (${ctx.value.tenantId}, ${input.company_id}, ${documentId}, ${input.warehouse_id},
              ${l.product_id}, ${l.quantity}, now() + (${ttl} || ' days')::interval)`;
  }

  const [actualizado] = await sql<DocumentResponse[]>`
    update public.documents set status = 'confirmed'
     where id = ${documentId} and company_id = ${input.company_id}
    returning ${sql.unsafe(DOC_COLUMNS)}`;
  await auditar(sql, ctx.value.tenantId, actualizado!, "sales.order.confirmed", {
    warehouse_id: input.warehouse_id,
    reservation_ttl_days: ttl,
  });
  return ok(actualizado!);
}

/**
 * EMITE una factura. Es el caso de uso más cargado del sistema y el orden está
 * elegido: primero se calcula todo en `draft`, y solo al final se pasa a
 * `issued` — que es cuando el trigger valida numeración y régimen. Al revés
 * quedaría un documento fiscal a medio hacer si algo falla después.
 */
export async function createInvoice(
  uow: UnitOfWork,
  input: CreateInvoiceRequest,
  bloqueo: "rechazar" | "de_contado" = "rechazar",
  /**
   * A-3 (decidido por criterio): el registro a posteriori de una factura de CONTINGENCIA refleja un
   * papel que ya existe — ni el tope de la forma libre ni la exigencia del adquirente aplican.
   */
  registroDeContingencia = false,
): Promise<Result<DocumentResponse, SalesError>> {
  return emitirVenta(uow, input, "invoice", bloqueo, registroDeContingencia);
}

/**
 * El RECIBO (migración 37): la venta del negocio SIN RIF. Misma emisión que la
 * factura — correlativo gapless, kardex, cobros, asiento por ADR-0042 — pero
 * SIN número de control, SIN resolve_tax (un no-inscrito no repercute IVA) y
 * con tratamiento `no_fiscal` en el snapshot. Jamás pisa un libro fiscal.
 */
export async function createReceipt(
  uow: UnitOfWork,
  input: CreateInvoiceRequest,
  bloqueo: "rechazar" | "de_contado" = "rechazar",
): Promise<Result<DocumentResponse, SalesError>> {
  return emitirVenta(uow, input, "receipt", bloqueo);
}

async function emitirVenta(
  uow: UnitOfWork,
  input: CreateInvoiceRequest,
  kind: "invoice" | "receipt",
  bloqueo: "rechazar" | "de_contado" = "rechazar",
  registroDeContingencia = false,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Emitir exige un usuario real." });
  }
  const fecha = ahora(input.issued_at);
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.issue", fecha);
  if (!ctx.ok) return ctx;
  if (ctx.value.regimeVersionId === "") {
    return err({
      code: "FISCAL_NUMBERING_INVALID",
      message:
        "La empresa no tiene régimen fiscal vigente a esa fecha: asígnalo antes de emitir (ADR-0029).",
      details: { reason: "regime_missing" },
    });
  }
  // P-05: el vencimiento, si viene, no es anterior al día de la venta. Antes de gastar número.
  const vence = vencimientoValido(input.due_date, fecha);
  if (!vence.ok) return vence;
  // EL GATE DE KIND (migración 37), dicho con palabras antes de que lo diga el
  // trigger: sin RIF no existe factura (PA 00071 art. 13.5), y con datos
  // fiscales no se vende por recibo — la puerta al uso evasor queda cerrada
  // en el esquema Y aquí, con el mensaje que cada caso merece.
  if (!ctx.value.allowedKinds.includes(kind)) {
    return err({
      code: "REGIME_KIND_NOT_ALLOWED",
      message:
        kind === "invoice"
          ? "Para emitir facturas necesitas completar tus datos fiscales (el régimen actual solo emite recibos). Actívalo en Empezar."
          : "El régimen fiscal de esta empresa no emite recibos: un negocio con datos fiscales factura.",
    });
  }
  // A-03 (ADR-0072 §1): una empresa con RIF no factura sin tipo de contribuyente vigente en la
  // fecha del documento. Nunca «ordinario por omisión». El recibo (sin RIF) no lo pide.
  if (kind === "invoice") {
    const tipo = await exigeTipoParaFacturar(sql, actor.userId, input.company_id, fecha);
    if (!tipo.ok) return tipo;
  }
  // PA 00071 arts. 33 y 13.7 (auditoría fiscal 2026-10-02): sobre forma libre, la factura cabe en
  // una forma (tope de FILAS impresas, A-2) y lleva al adquirente identificado. La contingencia
  // refleja un papel que ya existe (A-3).
  if (kind === "invoice" && ctx.value.numberingMode === "range" && !registroDeContingencia) {
    const forma = await exigeFormaLibre(sql, input.company_id, {
      clase: "factura",
      customerId: input.customer_id,
      filas: await filasDeLineas(
        sql,
        input.company_id,
        input.lines.map((l) => l.product_id),
      ),
    });
    if (!forma.ok) return forma;
  }

  const lista = await resolverLista(
    sql,
    actor.userId,
    input.company_id,
    input.customer_id,
    input.price_list_id,
    bloqueo,
  );
  if (!lista.ok) return lista;

  // R-82.1 · UNA SOLA PUERTA DEL FIADO. Emitida por administración (bloqueo «rechazar»), la
  // venta nace SIN cobro: es crédito por definición, y pasa por la misma regla que la caja. La
  // caja («de_contado») cobra después y decide ella, con el cobro en la mano. El registro de
  // una factura de CONTINGENCIA no pasa: refleja un papel que ya se entregó (A-3).
  // El candado del cliente va ANTES de emitir, en el orden de siempre (cliente → talonario →
  // kardex): dos facturas simultáneas al mismo cliente se ponen en fila.
  const naceFiada = bloqueo === "rechazar" && !registroDeContingencia;
  if (naceFiada) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${candadoDeFiado(input.customer_id)}, 0))`;
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const calculadas = await calcularLineas(sql, {
    companyId: input.company_id,
    customerId: input.customer_id,
    priceListId: lista.value,
    warehouseId: input.warehouse_id,
    lines: input.lines,
    fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    // El recibo NO resuelve impuesto: un no-inscrito no puede repercutir IVA.
    conImpuesto: kind === "invoice",
  });
  if (!calculadas.ok) return calculadas;

  // E-01 (ADR-0071): con número de control, la serie la dicta el TALONARIO, nunca el servidor.
  // El recibo (sin RIF) no tiene control y conserva su serie propia.
  const serieDada =
    kind === "invoice" && ctx.value.numberingMode === "range"
      ? await serieDelTalonario(sql, input.company_id, "invoice", input.series ?? null, null)
      : ok(input.series ?? (kind === "receipt" ? "R" : "A"));
  if (!serieDada.ok) return serieDada;
  const serie = serieDada.value;
  try {
    const doc = await sql.savepoint(async (sp) => {
      const creado = await insertarDocumento(sp, ctx.value, {
        companyId: input.company_id,
        kind,
        series: serie,
        customerId: input.customer_id,
        vendorId: input.vendor_id ?? null,
        branchId: input.branch_id ?? null,
        priceListId: lista.value,
        sourceDocumentId: input.source_document_id ?? null,
        lineas: calculadas.value.lineas,
        fxRate: calculadas.value.fxRate,
        rateSource: calculadas.value.rateSource,
        transactionCurrency: calculadas.value.transactionCurrency,
        notes: input.notes ?? null,
        dueDate: vence.value,
      });
      if (!creado.ok) return creado;

      // Los DOS números, cada uno por su función atómica (ADR-0037). El de
      // control solo cuando el régimen lo usa: pedirlo cuando no toca sería
      // consumir un número autorizado para nada.
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_document_number(${input.company_id}, ${kind}, ${serie})::text as n`;
      // ADR-0071: el control sale del talonario de la serie, sea de la clase que sea, con su
      // identificador de 2 dígitos (PA 00071 art. 44).
      let control: string | null = null;
      let identificador: string | null = null;
      if (kind === "invoice" && ctx.value.numberingMode === "range") {
        const [c] = await sp<{ n: string; i: string }[]>`
          select control_number::text as n, control_identifier as i
            from platform.claim_fiscal_control(${input.company_id}, 'invoice', ${serie})`;
        control = c!.n;
        identificador = c!.i;
      }

      const [emitido] = await sp<DocumentResponse[]>`
        update public.documents
           set status = 'issued', issued_at = ${fecha},
               document_number = ${num!.n}::bigint,
               control_number = ${control}::bigint,
               control_identifier = ${identificador},
               regime_version_id = ${ctx.value.regimeVersionId},
               rules_version = ${RULES_VERSION}
         where id = ${creado.value.id}
        returning ${sp.unsafe(DOC_COLUMNS)}`;
      return ok(emitido!);
    });
    if (!doc.ok) return doc;

    // R-82.1: con el documento emitido (la deuda leída lo incluye) y antes de mover nada más.
    // Una factura de total cero no deja saldo: no es fiado.
    const totalEmitido = parseDecimal(doc.value.total_amount);
    if (naceFiada && !(totalEmitido.ok && totalEmitido.value.isZero())) {
      const fiado = await exigirFiado(sql, actor.userId, input.company_id, input.customer_id);
      if (!fiado.ok) return fiado;
    }

    // El kardex, DESPUÉS de emitir y en la misma transacción: si el stock no
    // alcanza, la factura entera no ocurrió. Cada salida lleva el documento como
    // origen, así que el kardex y la factura se pueden cruzar.
    // Qué líneas descuentan existencia. `calcularLineas` ya trajo el producto
    // en su lote, así que aquí no se vuelve a preguntar por cada una: es el
    // mismo criterio de antes (bien, no compuesto) leído del dato que ya está.
    const conKardex = calculadas.value.lineas.filter((l) => l.esInventariable);
    // I-04: la línea de un COMPUESTO no saca el compuesto (no lleva existencia): saca sus
    // ingredientes, con la receta de este momento. Van en la MISMA salida en lote que las líneas
    // sueltas —un solo bloqueo en orden determinista—, detrás de ellas.
    const componentes = await explotarCompuestos(
      sql,
      input.company_id,
      calculadas.value.lineas.flatMap((l, i) =>
        l.esCompuesto === true
          ? [
              {
                lineNumber: i + 1,
                productId: l.productId,
                nombre: l.productName ?? l.description,
                quantity: l.calc.quantity,
              },
            ]
          : [],
      ),
    );
    if (!componentes.ok) return err(componentes.error);
    if (conKardex.length > 0 || componentes.value.length > 0) {
      const pedidas = [
        ...conKardex.map((l) => ({
          product_id: l.productId,
          quantity: l.calc.quantity.toFixed(),
        })),
        ...componentes.value.map((c) => ({ product_id: c.childProductId, quantity: c.quantity })),
      ];
      // La salida la autoriza LA VENTA (`sales.invoice.issue` + alcance del almacén), no
      // `inventory.move`: el cajero vende sin poder mover mercancía suelta (ADR-0068, N-01).
      const mov = await issueStockBatchForSale(uow, {
        company_id: input.company_id,
        warehouse_id: input.warehouse_id,
        lines: pedidas,
        sourceDocumentId: doc.value.id,
      });
      if (!mov.ok) {
        // Un permiso que falta es un 403, no un «dato inválido»: con el 422 la caja le decía al
        // dueño que sus datos estaban mal cuando lo que faltaba era el alcance sobre el
        // depósito (QA de pantalla 2026-09-15, h. 46).
        if (mov.error.code === "NEGATIVE_STOCK") {
          // I-04: si lo que falta es ingrediente de un compuesto de esta venta, se dice de cuál.
          const faltante = mov.error.productId;
          const de = [
            ...new Set(
              componentes.value
                .filter((c) => c.childProductId === faltante)
                .map((c) => `«${c.parentName}»`),
            ),
          ];
          return err({
            code: "NEGATIVE_STOCK",
            message:
              de.length === 0
                ? mov.error.message
                : `${mov.error.message} Es ingrediente de ${de.join(" y ")}: sin él no se puede vender.`,
          });
        }
        return err(
          mov.error.code === "PERMISSION_REQUIRED"
            ? { code: "PERMISSION_REQUIRED", message: mov.error.message }
            : { code: "VALIDATION_FAILED", message: mov.error.message },
        );
      }

      // I-04: qué movimiento produjo cada línea de compuesto, escrito en la misma transacción.
      if (componentes.value.length > 0) {
        const porLinea = movimientosPorLinea(pedidas, mov.value);
        if (porLinea === null) {
          return err({
            code: "VALIDATION_FAILED",
            message:
              "No se pudo ligar cada ingrediente con su línea de venta: la venta no se registra.",
          });
        }
        const rastro = await registrarSalidasDeCompuestos(sql, {
          tenantId: ctx.value.tenantId,
          companyId: input.company_id,
          documentId: doc.value.id,
          componentes: componentes.value,
          movimientos: porLinea.slice(conKardex.length),
        });
        if (!rastro.ok) return err(rastro.error);
      }

      /**
       * EL COSTO DE LO VENDIDO (ADR-0060 §1). Es EXACTAMENTE lo que el kardex
       * registró al sacar la mercancía —la suma de las salidas de este
       * documento, lote por lote—, no un costo recalculado. Un hecho propio,
       * aparte del asiento de la venta: el importador lo lleva a las empresas
       * existentes y la cobertura de movimientos lo exige por separado.
       */
      let costo = parseDecimal("0");
      for (const m of mov.value) {
        const v = parseDecimal(m.functional_amount);
        if (!costo.ok || !v.ok) break;
        costo = { ok: true, value: costo.value.minus(v.value) };
      }
      if (!costo.ok) return err({ code: "VALIDATION_FAILED", message: costo.error.message });
      if (costo.value.greaterThan(0)) {
        const costoVentas = await generateJournalFromDocument(sql, {
          tenantId: ctx.value.tenantId,
          companyId: input.company_id,
          sourceKind: "sales_cost",
          sourceEvent: "stock.shipped",
          sourceId: doc.value.id,
          postingDate: diaNegocio(fecha),
          postedBy: actor.userId,
          description: `Costo de lo vendido — ${kind === "receipt" ? "Recibo" : "Factura"} ${serieYNumero(doc.value.series, doc.value.document_number ?? "")}`,
          functionalCurrency: ctx.value.functionalCurrency,
          amounts: { cost_amount: costo.value.toFixed(8) },
        });
        if (!costoVentas.ok) {
          return err({ code: "VALIDATION_FAILED", message: costoVentas.error.message });
        }
      }
    }

    await auditar(
      sql,
      ctx.value.tenantId,
      doc.value,
      kind === "receipt" ? "sales.receipt.issued" : "fiscal.invoice.issued",
      {
        warehouse_id: input.warehouse_id,
        line_count: calculadas.value.lineas.length,
      },
    );

    // EL ASIENTO, en la misma transacción (ADR-0042). Los importes que van son
    // los FUNCIONALES del pie: es la moneda en la que se lleva la contabilidad
    // y en la que se comprueba la partida doble. Sin plantilla configurada, el
    // generador encola y la venta se emite igual. El recibo asienta por SU
    // plantilla (sales_receipt, sin línea de IVA — migración 37).
    const contable = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId: input.company_id,
      sourceKind: kind === "receipt" ? "sales_receipt" : "sales_invoice",
      sourceEvent: kind === "receipt" ? "sales.receipt.issued" : "fiscal.invoice.issued",
      sourceId: doc.value.id,
      postingDate: diaNegocio(fecha),
      postedBy: actor.userId,
      description: `${kind === "receipt" ? "Recibo" : "Factura"} ${serieYNumero(doc.value.series, doc.value.document_number ?? "")}`,
      functionalCurrency: ctx.value.functionalCurrency,
      // Al recibo NO se le pasa impuesto (A5): no existe en su mundo, y su
      // plantilla (sales_receipt) no lo usa. El cero que el esquema obliga en la
      // fila no viaja a la contabilidad.
      amounts:
        kind === "receipt"
          ? { subtotal: doc.value.subtotal_amount, total: doc.value.total_amount }
          : {
              subtotal: doc.value.subtotal_amount,
              tax_amount: doc.value.tax_amount,
              total: doc.value.total_amount,
            },
      backlink: { table: "documents", id: doc.value.id },
    });
    if (!contable.ok) {
      return err({ code: "VALIDATION_FAILED", message: contable.error.message });
    }
    return ok(doc.value);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * LO QUE UN USO BAJA DEL PASIVO (ADR-0075 decisión 5, tercera ronda). Un saldo a favor carga en el
 * mayor lo que cargó al nacer (`functional_amount`: el total en Bs de la nota, o el sobrante a la
 * tasa de su cobro), que NO es importe × tasa cuando la nota lleva IVA (E-05). Cada uso —aplicarlo
 * o reembolsarlo— baja la PARTE PROPORCIONAL, al céntimo, y el uso que AGOTA el saldo se lleva
 * lo que el mayor todavía carga (`carried`, platform.customer_credit_carried): el pasivo de cada
 * saldo a favor termina en 0,00, se use en las partes que se use.
 */
function pasivoDeUnUso(
  credito: {
    readonly amount: string;
    readonly applied_amount: string;
    readonly functional_amount: string | null;
    readonly fx_rate: string | null;
    readonly carried: string | null;
  },
  pedido: Decimal,
  escalaFuncional: number,
): Decimal {
  const total = decimalDe(credito.amount);
  const resto = total.minus(decimalDe(credito.applied_amount));
  const nacio =
    credito.functional_amount !== null
      ? decimalDe(credito.functional_amount)
      : total.times(decimalDe(credito.fx_rate ?? "1")).toDecimalPlaces(escalaFuncional, 4);
  const carga = credito.carried !== null ? decimalDe(credito.carried) : nacio;
  if (pedido.greaterThanOrEqualTo(resto)) return carga;
  const parte = pedido.times(nacio).dividedBy(total).toDecimalPlaces(escalaFuncional, 4);
  return parte.greaterThan(carga) ? carga : parte;
}

/**
 * REEMBOLSA un saldo a favor desde una caja (ADR-0061 §8). Consume el saldo como
 * lo consume aplicarlo a una factura (`applied_amount`), registra la salida de
 * dinero —que baja el saldo de la cuenta por trigger— y la asienta contra la caja
 * REAL (`customer_refund` / `ar.credit_refunded`, cuenta por treasury_account).
 * G-15 / G-05 (ADR-0075 §4): sale de la caja en la moneda en que se pague, a la tasa del día;
 * el pasivo baja a la tasa con que nació el saldo a favor y la diferencia va al diferencial.
 */
export async function refundCustomerCredit(
  uow: UnitOfWork,
  creditId: string,
  input: RefundCustomerCreditRequest,
): Promise<Result<CustomerRefundResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Reembolsar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  // G-07 (RESPUESTA §2.8): la devolución la inicia quien tiene `sales.return.manage` (también el
  // cajero); SACAR EL DINERO de la caja exige `sales.refund` (ADR-0068 §8).
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.refund", fecha);
  if (!ctx.ok) return ctx;

  const [credito] = await sql<
    {
      id: string;
      amount: string;
      applied_amount: string;
      status: string;
      currency: string;
      fx_rate: string | null;
      functional_amount: string | null;
      carried: string | null;
    }[]
  >`select id, amount::text as amount, applied_amount::text as applied_amount, status, currency,
           fx_rate::text as fx_rate, functional_amount::text as functional_amount,
           platform.customer_credit_carried(${input.company_id}, id)::text as carried
      from public.customer_credits
     where id = ${creditId} and company_id = ${input.company_id}
     for update`;
  if (!credito) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const [cuenta] = await sql<{ currency: string; name: string; is_active: boolean }[]>`
    select currency, name, is_active from public.company_accounts
     where id = ${input.account_id} and company_id = ${input.company_id}`;
  if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!cuenta.is_active) {
    return err({
      code: "VALIDATION_FAILED",
      message: `La cuenta «${cuenta.name}» está desactivada.`,
    });
  }
  // Punto 1: solo se reembolsa un saldo DISPONIBLE. Uno retirado ya devolvió su dinero con la
  // reversa del cobro que lo creó.
  if (credito.status === "expired") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Ese saldo a favor se retiró al reversar el cobro que lo creó: ya no se aplica ni se reembolsa.",
    });
  }
  if (credito.status !== "available") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Ese saldo a favor ya se usó entero: no queda nada que reembolsar.",
    });
  }
  const total = parseDecimal(credito.amount);
  const aplicado = parseDecimal(credito.applied_amount);
  // El esquema garantiza EXACTAMENTE uno de `amount` o `whole`; aquí se vuelve a exigir, porque
  // el caso de uso no depende de quién lo llame.
  if ((input.amount === undefined) === (input.whole === undefined)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Di cuánto se devuelve: un importe, o todo lo que queda disponible. Una de las dos cosas, no las dos.",
    });
  }
  const pedidoLeido = input.amount === undefined ? null : parseDecimal(input.amount);
  if (!total.ok || !aplicado.ok || (pedidoLeido !== null && !pedidoLeido.ok)) {
    return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
  }
  const disponible = total.value.minus(aplicado.value);
  // G-15: «todo lo disponible» lo decide el servidor, en la moneda del saldo a favor.
  const pedido = {
    value: pedidoLeido === null || !pedidoLeido.ok ? disponible : pedidoLeido.value,
  };
  if (!pedido.value.greaterThan(0) || pedido.value.greaterThan(disponible)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El saldo a favor disponible es ${disponible.toFixed()} y se intentó reembolsar ${pedido.value.toFixed()}.`,
    });
  }

  /**
   * G-15 + G-05 (ADR-0075 §4): el reembolso sale de la caja EN LA MONEDA EN QUE SE PAGUE, a la
   * tasa del día; el pasivo con el cliente baja por lo que llevaba en el mayor (la tasa con que
   * nació el saldo a favor) y la diferencia va al diferencial cambiario.
   *   · `pedido`: lo que se consume del saldo a favor, en SU moneda;
   *   · `sale`: el dinero que sale, en la moneda de la cuenta; `saleFuncional`, en libros;
   *   · `pasivo`: lo que deja de deberse en libros.
   * Con saldo, cuenta y moneda funcional iguales (todo saldo a favor anterior a 20261004150000
   * reembolsado desde una cuenta en bolívares) las tres cifras son la misma y no hay diferencial.
   */
  const funcional = ctx.value.functionalCurrency;
  const dia = diaNegocio(fecha);
  const tasaDe = async (moneda: string): Promise<{ rate: Decimal; source: string } | null> => {
    if (moneda === funcional) return { rate: decimalDe("1"), source: "identidad" };
    const [t] = await sql<{ rate: string | null; source: string | null }[]>`
      select f.rate::text as rate, f.source
        from platform.rate_for(${input.company_id}, ${moneda}, ${funcional}, ${dia}::date) f`;
    if (!t?.rate) return null;
    return { rate: decimalDe(t.rate), source: t.source ?? "manual" };
  };
  const faltaTasa = (moneda: string): Result<never, SalesError> =>
    err({
      code: "EXCHANGE_RATE_MISSING",
      message: `No hay tasa de ${moneda} a ${funcional} para hoy: sin ella no se puede reembolsar en otra moneda.`,
    });
  // La tasa con que nació el saldo a favor. Sin tasa guardada, nació en moneda funcional.
  if (credito.fx_rate === null && credito.currency !== funcional) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Este saldo a favor no guarda la tasa con que nació: no se puede reembolsar.",
    });
  }
  const escalaF = minorUnitsOf(funcional);
  // ADR-0075 decisión 5 (tercera ronda): la parte proporcional de lo que el saldo cargó al nacer,
  // y el resto exacto si este reembolso lo agota. El pasivo de cada saldo a favor termina en 0,00.
  const pasivo = pasivoDeUnUso(credito, pedido.value, escalaF);
  const tasaCuenta = await tasaDe(cuenta.currency);
  if (tasaCuenta === null) return faltaTasa(cuenta.currency);
  let sale = pedido.value;
  // La tasa del día de la moneda DEL SALDO A FAVOR: la que decide cuánto sale. Se guarda con el
  // reembolso (regla 8) y es la que imprime su comprobante.
  let tasaDelSaldoHoy = tasaCuenta.rate;
  if (cuenta.currency !== credito.currency) {
    // A la tasa del día: el saldo a favor vale hoy `pedido × tasa de su moneda`, y eso, en la
    // moneda de la cuenta, es lo que sale.
    const tasaSaldo = await tasaDe(credito.currency);
    if (tasaSaldo === null) return faltaTasa(credito.currency);
    tasaDelSaldoHoy = tasaSaldo.rate;
    sale = pedido.value
      .times(tasaSaldo.rate)
      .dividedBy(tasaCuenta.rate)
      .toDecimalPlaces(minorUnitsOf(cuenta.currency), 4);
  }
  if (!sale.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El importe a reembolsar es menor que un céntimo de la cuenta de la que sale.",
    });
  }
  const saleFuncional = sale.times(tasaCuenta.rate).toDecimalPlaces(escalaF, 4);
  const diferencial = pasivo.minus(saleFuncional);

  // El reembolso sale de una caja real: sin saldo, se confirma o no se registra (ADR-0062 §4;
  // QA de pantalla 2026-09-15, h. 33 — un reembolso dejó «Caja del local» en −4.716,36).
  const alcanzaCaja = await exigeSaldo(
    sql,
    input.account_id,
    sale.toFixed(8),
    // D-11: sobregirar exige el permiso, el motivo y deja acta (lo hace `exigeSaldo`).
    {
      permitir: input.allow_negative_balance,
      motivo: input.overdraft_reason,
      operacion: "refund",
    },
  );
  if (!alcanzaCaja.ok) return err(alcanzaCaja.error);

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const nuevo = aplicado.value.plus(pedido.value);
  await sql`
    update public.customer_credits
       set applied_amount = ${nuevo.toFixed()},
           status = case when ${nuevo.equals(total.value)} then 'applied' else status end
     where id = ${creditId}`;

  // Los importes de siempre son EL DINERO QUE SALIÓ (moneda de la cuenta, tasa del día); lo
  // consumido del saldo a favor y su diferencial van en sus columnas (20261004150000).
  const [reembolso] = await sql<{ id: string; refunded_at: string }[]>`
    insert into public.customer_refunds
      (tenant_id, company_id, customer_credit_id, account_id, reason,
       amount_transaction_currency, transaction_currency, fx_rate, functional_amount,
       functional_currency, rate_source, credit_amount, credit_currency,
       credit_functional_amount, exchange_difference, credit_fx_rate)
    values (${ctx.value.tenantId}, ${input.company_id}, ${creditId}, ${input.account_id},
            ${input.reason}, ${sale.toFixed(8)}, ${cuenta.currency}, ${tasaCuenta.rate.toFixed(8)},
            ${saleFuncional.toFixed(8)}, ${funcional}, ${tasaCuenta.source},
            ${pedido.value.toFixed(8)}, ${credito.currency}, ${pasivo.toFixed(8)},
            ${diferencial.toFixed(8)}, ${tasaDelSaldoHoy.toFixed(8)})
    returning id,
              to_char(refunded_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as refunded_at`;

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${ctx.value.tenantId}, ${input.company_id}, 'customer_credit', ${creditId},
            'ar.credit_refunded', 'user', now(), ${RULES_VERSION},
            ${sql.json({ refund_id: reembolso!.id, account_id: input.account_id, amount: pedido.value.toFixed(8), currency: credito.currency, paid_amount: sale.toFixed(8), paid_currency: cuenta.currency, fx_rate: tasaCuenta.rate.toFixed(8), exchange_difference: diferencial.toFixed(8), reason: input.reason })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${ctx.value.tenantId}, ${input.company_id}, 'customer_credit', ${creditId},
            'ar.credit_refunded', 1,
            ${sql.json({ refund_id: reembolso!.id, account_id: input.account_id, amount: pedido.value.toFixed(8) })})`;

  const generado = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "customer_refund",
    sourceEvent: "ar.credit_refunded",
    sourceId: reembolso!.id,
    postingDate: diaNegocio(fecha),
    postedBy: actor.userId,
    description: `Reembolso de saldo a favor: ${input.reason}`,
    functionalCurrency: ctx.value.functionalCurrency,
    // Dr pasivo (total, a la tasa con que nació) / Cr caja (functional_amount, a la de hoy) /
    // la diferencia, a ganancia o pérdida en diferencial cambiario.
    amounts: {
      functional_amount: saleFuncional.toFixed(8),
      total: pasivo.toFixed(8),
      exchange_difference: diferencial.toFixed(8),
    },
    backlink: { table: "customer_refunds", id: reembolso!.id },
  });
  if (!generado.ok) return err({ code: "VALIDATION_FAILED", message: generado.error.message });

  return ok({
    id: reembolso!.id,
    customer_credit_id: creditId,
    account_id: input.account_id,
    amount: pedido.value.toFixed(8),
    currency: credito.currency,
    refunded_at: reembolso!.refunded_at,
    accounting: generado.value.kind === "queued" ? "queued" : "posted",
    journal_entry_id: generado.value.kind === "queued" ? null : generado.value.entryId,
    credit_remaining: total.value.minus(nuevo).toFixed(8),
    paid_amount: sale.toFixed(8),
    paid_currency: cuenta.currency,
    fx_rate: tasaCuenta.rate.toFixed(8),
    exchange_difference: diferencial.toFixed(8),
    credit_fx_rate: tasaDelSaldoHoy.toFixed(8),
  });
}

/**
 * Por qué una factura o un recibo no se puede anular (G-10, G-14). `has_payments` es del dinero
 * (ADR-0061 §1); los demás son del PAPEL (PA 00071 arts. 22 y 36) y solo juzgan facturas.
 */
export type AnnulmentBlocker =
  "has_payments" | "not_same_day" | "period_declared" | "cash_closed" | "originals_not_confirmed";

const SALIDA_NOTA =
  "Se corrige con una nota de crédito (o con una devolución, si el cliente devuelve la mercancía).";

/** El texto de persona de cada motivo. Vive en el servidor: la pantalla solo lo muestra. */
function mensajeDeAnulacion(motivo: AnnulmentBlocker, nombre: string): string {
  switch (motivo) {
    case "has_payments":
      return `Este ${nombre} ya tiene cobros y no se anula. Para deshacer la venta usa «Devolución»: repone la mercancía y devuelve el dinero como saldo a favor o reembolso.`;
    case "not_same_day":
      return `Esta factura es de otro día y ya no se anula: solo se anula el mismo día, si el papel no salió del negocio. ${SALIDA_NOTA}`;
    case "period_declared":
      return `El período de esta factura ya se declaró y ya no se anula. ${SALIDA_NOTA}`;
    case "cash_closed":
      return `La caja ya se cerró después de emitir esta factura y ya no se anula. ${SALIDA_NOTA}`;
    case "originals_not_confirmed":
      return `Para anular esta factura confirma que tienes en la mano el original y todas las copias. Si ya se entregó al cliente, no se anula. ${SALIDA_NOTA}`;
  }
}

/**
 * El primer motivo de PAPEL que impide anular una factura, o null (G-10). La regla vive en
 * `platform.invoice_annulment_blockers` (migración 20261004160000) y declara su granularidad: día
 * de Caracas contra día de Caracas, y el cierre de caja instante contra instante. El instante es
 * el `now()` de la transacción, y lo decide quien llama: aquí.
 */
async function bloqueoDePapel(
  sql: TransactionSql,
  companyId: string,
  documentId: string,
): Promise<AnnulmentBlocker | null> {
  const [b] = await sql<{ reason: AnnulmentBlocker | "not_found" }[]>`
    select reason from platform.invoice_annulment_blockers(${companyId}, ${documentId}, now())
     order by priority limit 1`;
  // La función falla cerrada (20261004160100). Quien llama ya cargó el documento, así que esto no
  // debe ocurrir: si ocurre, no se responde «se puede anular».
  if (b?.reason === "not_found") {
    throw new Error(
      "invoice_annulment_blockers: el documento dejó de verse dentro de la transacción",
    );
  }
  return b?.reason ?? null;
}

/**
 * Lo que la pantalla necesita para decir la verdad sobre «Anular» (G-14): si este documento se
 * puede anular AHORA y, si no, por qué y cuál es el camino. null = el documento no es de los que
 * se anulan (ni factura ni recibo, o no está emitido). Son las MISMAS preguntas que hace
 * `annulInvoice`; la confirmación del papel la pide la pantalla al anular.
 */
export async function annulmentStatus(
  sql: TransactionSql,
  companyId: string,
  documentId: string,
): Promise<{ allowed: boolean; reason: AnnulmentBlocker | null; message: string | null } | null> {
  const [doc] = await sql<{ status: string; kind: string; cobros: number }[]>`
    select d.status, d.kind,
           (select count(*)::int from public.payments p
             where p.document_id = d.id
               and not exists (select 1 from public.payment_reversals pr
                                where pr.payment_id = p.id)) as cobros
      from public.documents d
     where d.id = ${documentId} and d.company_id = ${companyId}`;
  if (
    !doc ||
    (doc.kind !== "invoice" && doc.kind !== "receipt" && doc.kind !== "withdrawal_invoice")
  ) {
    return null;
  }
  const nombre = nombreDeAnulable(doc.kind);
  const no = (reason: AnnulmentBlocker) => ({
    allowed: false,
    reason,
    message: mensajeDeAnulacion(reason, nombre),
  });
  if (doc.status === "paid" || (doc.status === "issued" && doc.cobros > 0)) {
    return no("has_payments");
  }
  if (doc.status !== "issued") return null;
  if (doc.kind === "invoice" || doc.kind === "withdrawal_invoice") {
    const papel = await bloqueoDePapel(sql, companyId, documentId);
    if (papel !== null) return no(papel);
  }
  return { allowed: true, reason: null, message: null };
}

function nombreDeAnulable(kind: string): string {
  if (kind === "receipt") return "recibo";
  return kind === "withdrawal_invoice" ? "factura de retiro" : "factura";
}

/** Lo que `issueStock` le pasa a la emisión de la factura de retiro (ADR-0082). */
export interface FacturaDeRetiroInput {
  readonly companyId: string;
  readonly warehouseId: string;
  readonly productId: string;
  readonly quantity: string;
  /** El id que llevará la salida del kardex: la factura lo guarda y la salida entra después. */
  readonly moveId: string;
  /** El motivo en palabras, para la leyenda del papel. */
  readonly motivo: string;
  /** El instante del hecho (el del movimiento): fecha de emisión, tasa, precio y régimen. */
  readonly fecha: string;
}

/**
 * LA FACTURA DE RETIRO (ADR-0082; RLIVA art. 31). El retiro de inventario —consumo propio, regalo,
 * donación, muestra— es un hecho imponible (LIVA art. 4.3) y se FACTURA: mismo camino que la
 * venta (`insertarDocumento`, correlativo de la serie de facturas, número de control del
 * talonario, `assert_document_issuance`), con tres diferencias que son la decisión:
 *   · el adquirente es la PROPIA empresa: su razón social y su RIF congelados, y su tipo de
 *     contribuyente leído de la historia a la fecha (AF3-07), nunca «ordinario por omisión»;
 *   · la base es el precio de venta de la lista principal (RLIVA art. 43; AF3-05): sin precio, o
 *     con precio cero, no se retira. El piso de mercado es VALIDAR-TRIBUTARIO P-75;
 *   · NO nace cuenta por cobrar: su kind (`withdrawal_invoice`) no está en ninguna lectura de
 *     cartera, no pasa por la puerta del fiado y la base rechaza cobrarla. Su asiento es el de la
 *     salida del kardex, que escribe `issueStock`.
 * Se emite ANTES de mover el kardex (el mismo orden de candados que la venta: talonario →
 * existencia). La autoriza el retiro (`inventory.move`), no `sales.invoice.issue`: es la
 * consecuencia fiscal de sacar la mercancía, no una venta que alguien decide hacer.
 */
export async function emitirFacturaDeRetiro(
  uow: UnitOfWork,
  input: FacturaDeRetiroInput,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Emitir exige un usuario real." });
  }
  const ctx = await autorizar(sql, actor.userId, input.companyId, "inventory.move", input.fecha);
  if (!ctx.ok) return ctx;
  if (ctx.value.regimeVersionId === "" || !ctx.value.allowedKinds.includes("invoice")) {
    return err({
      code: "REGIME_KIND_NOT_ALLOWED",
      message:
        "El régimen fiscal de la empresa a esa fecha no emite facturas: el retiro no puede facturarse.",
    });
  }
  const tipo = await exigeTipoParaFacturar(sql, actor.userId, input.companyId, input.fecha);
  if (!tipo.ok) return tipo;

  const [emp] = await sql<
    {
      name: string;
      tax_id: string | null;
      rif: string | null;
      address: string | null;
      lista: string | null;
      precio: string | null;
    }[]
  >`
    select c.legal_name as name,
           upper(regexp_replace(c.tax_id, '[^a-zA-Z0-9]', '', 'g')) as tax_id,
           c.tax_id as rif, c.fiscal_address as address,
           cs.default_price_list_id as lista,
           case when cs.default_price_list_id is null then null
                else platform.price_at(cs.default_price_list_id, ${input.productId},
                                       ${input.fecha}::timestamptz)::text
           end as precio
      from public.companies c
      left join public.company_settings cs on cs.company_id = c.id
     where c.id = ${input.companyId}`;
  if (!emp || emp.tax_id === null || emp.tax_id === "") {
    return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  }
  const precio = emp.precio === null ? null : parseDecimal(emp.precio);
  if (emp.lista === null || precio === null || !precio.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El retiro se valora al precio de venta (RLIVA art. 43) y este producto no tiene precio en tu lista de precios principal. Ponle precio y vuelve a registrar la salida.",
    });
  }
  // AF3-05 (RLIVA art. 43): la base del retiro es el precio de venta, nunca cero.
  if (!precio.value.greaterThan(0)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El retiro se factura al precio de venta y este producto tiene precio cero en tu lista de precios principal. Ponle su precio de venta y vuelve a registrar la salida.",
    });
  }

  // El adquirente necesita una ficha (el documento la referencia): la que ya tenga el RIF de la
  // empresa, o una nueva con sus datos. Lo que el papel dice sale del CONGELADO de abajo, no de
  // esta ficha.
  // UNA ficha, aunque dos primeros retiros lleguen a la vez: el candado es por empresa y vive
  // hasta el fin de la transacción; el segundo espera y ENCUENTRA la del primero. Va antes que el
  // talonario y que la existencia, como el candado del fiado en la venta (mismo orden).
  await sql`select pg_advisory_xact_lock(hashtextextended(${`ladino-adquirente-propio|${input.companyId}`}, 0))`;
  let [yo] = await sql<{ id: string }[]>`
    select id from public.customers
     where company_id = ${input.companyId}
       and (own_company
            or upper(regexp_replace(tax_id, '[^a-zA-Z0-9]', '', 'g')) = ${emp.tax_id})
     order by own_company desc
     limit 1`;
  if (yo === undefined) {
    const letra = emp.tax_id.charAt(0);
    const persona =
      letra === "V" || letra === "E" || letra === "P"
        ? "natural"
        : letra === "G"
          ? "gobierno"
          : "juridica";
    [yo] = await sql<{ id: string }[]>`
      insert into public.customers
        (tenant_id, company_id, tax_id, legal_name, person_type_code, taxpayer_type_code,
         fiscal_address, status, own_company)
      -- No es un cliente (20261005100600): nace marcada como la ficha de la PROPIA empresa —no
      -- sale en la lista ni en el buscador de clientes, y resolverLista no le vende— e inactiva.
      values (${ctx.value.tenantId}, ${input.companyId}, ${emp.rif}, ${emp.name}, ${persona},
              ${tipo.value}, ${emp.address}, 'inactive', true)
      returning id`;
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  const calculadas = await calcularLineas(sql, {
    companyId: input.companyId,
    customerId: yo!.id,
    priceListId: emp.lista,
    warehouseId: input.warehouseId,
    lines: [{ product_id: input.productId, quantity: input.quantity }],
    fecha: input.fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    conImpuesto: true,
    adquirenteTipo: tipo.value,
    aunInactivos: true,
  });
  if (!calculadas.ok) return calculadas;

  const conControl = ctx.value.numberingMode === "range";
  const serieDada = conControl
    ? await serieDelTalonario(sql, input.companyId, "invoice", null, null)
    : ok("A");
  if (!serieDada.ok) return serieDada;
  const serie = serieDada.value;
  try {
    const doc = await sql.savepoint(async (sp) => {
      const creado = await insertarDocumento(sp, ctx.value, {
        companyId: input.companyId,
        kind: "withdrawal_invoice",
        series: serie,
        customerId: yo!.id,
        vendorId: null,
        branchId: null,
        priceListId: emp.lista!,
        sourceDocumentId: null,
        lineas: calculadas.value.lineas,
        fxRate: calculadas.value.fxRate,
        rateSource: calculadas.value.rateSource,
        transactionCurrency: calculadas.value.transactionCurrency,
        notes: `Factura por retiro de inventario (${input.motivo}). Adquirente: la propia empresa. No genera cuenta por cobrar.`,
        adquirente: {
          name: emp.name,
          tax_id: emp.tax_id,
          address: emp.address,
          taxpayer_type: tipo.value,
        },
      });
      if (!creado.ok) return creado;
      // El correlativo es el de la serie de FACTURAS, y el control sale de su talonario
      // (ADR-0071): la factura de retiro es una factura más de ese papel.
      const [num] = await sp<{ n: string }[]>`
        select platform.claim_document_number(${input.companyId}, 'invoice', ${serie})::text as n`;
      let control: string | null = null;
      let identificador: string | null = null;
      if (conControl) {
        const [c] = await sp<{ n: string; i: string }[]>`
          select control_number::text as n, control_identifier as i
            from platform.claim_fiscal_control(${input.companyId}, 'invoice', ${serie})`;
        control = c!.n;
        identificador = c!.i;
      }
      const [emitido] = await sp<DocumentResponse[]>`
        update public.documents
           set status = 'issued', issued_at = ${input.fecha},
               document_number = ${num!.n}::bigint,
               control_number = ${control}::bigint,
               control_identifier = ${identificador},
               regime_version_id = ${ctx.value.regimeVersionId},
               rules_version = ${RULES_VERSION},
               withdrawal_move_id = ${input.moveId}
         where id = ${creado.value.id}
        returning ${sp.unsafe(DOC_COLUMNS)}`;
      return ok(emitido!);
    });
    if (!doc.ok) return doc;
    await auditar(sql, ctx.value.tenantId, doc.value, "fiscal.invoice.issued", {
      warehouse_id: input.warehouseId,
      line_count: 1,
      withdrawal_move_id: input.moveId,
      withdrawal_reason: input.motivo,
    });
    return ok(doc.value);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * LA NOTA DE CRÉDITO DE UN RETIRO (ADR-0082, AF3-06; PA 00071 arts. 22 y 23). Un retiro facturado
 * por error que ya no se puede anular (pasó el día, cerró la caja, se declaró el período) se
 * corrige con SU nota de crédito, que deja sin efecto el retiro ENTERO:
 *   · es total: las mismas líneas, cantidades, precios y alícuotas congeladas de su factura (una
 *     parte no se corrige: se deja sin efecto el retiro y se registra de nuevo);
 *   · se emite como toda nota de crédito (`createInvoiceLike`: `insertarDocumento`, correlativo de
 *     la serie de notas de crédito, control del talonario, `assert_document_issuance`), a la tasa
 *     de su factura, con el MISMO adquirente congelado (la propia empresa);
 *   · NO toca cartera ni crea saldo a favor: su kind no está en ninguna lectura de deuda ni de
 *     venta, y la base rechaza cobrarla, devolverla o darle un saldo a favor;
 *   · la mercancía vuelve al kardex al costo con que salió y su asiento es el contra-asiento del
 *     retiro (`reingresarRetiro`).
 * Permisos: el de corregir un documento emitido (`sales.invoice.annul`, el mismo de la anulación
 * del mismo día) Y el de mover mercancía (`inventory.move`) sobre el depósito del retiro.
 * Clave natural: una factura de retiro, una nota (índice único).
 */
export async function creditWithdrawalInvoice(
  uow: UnitOfWork,
  documentId: string,
  input: { readonly company_id: string; readonly reason: string },
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Corregir exige un usuario real." });
  }
  // UN instante, el de la base: fecha de la nota, del reingreso y de su asiento (el libro y el
  // mayor se comparan por día).
  const [inst] = await sql<{ t: string }[]>`
    select to_char(now() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as t`;
  const fecha = inst!.t;
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.annul", fecha);
  if (!ctx.ok) return ctx;

  const [doc] = await sql<
    {
      status: string;
      kind: string;
      customer_id: string;
      price_list_id: string | null;
      series: string;
      document_number: string | null;
    }[]
  >`
    select status, kind, customer_id, price_list_id, series,
           document_number::text as document_number
      from public.documents
     where id = ${documentId} and company_id = ${input.company_id}
     for update`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.kind !== "withdrawal_invoice") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Solo una factura de retiro se corrige así. Una venta se corrige con su nota de crédito o su devolución.",
    });
  }
  if (doc.status !== "issued") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Esta factura de retiro está anulada: no hay retiro que corregir.",
    });
  }
  const [previa] = await sql<{ series: string; n: string | null }[]>`
    select series, document_number::text as n from public.documents
     where company_id = ${input.company_id} and source_document_id = ${documentId}
       and kind = 'withdrawal_credit_note' and status = 'issued'`;
  if (previa !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Este retiro ya se corrigió con la nota de crédito ${serieYNumero(previa.series, previa.n ?? "")}.`,
    });
  }
  const lineas = await sql<
    { id: string; product_id: string; quantity: string; unit_price_transaction: string }[]
  >`
    select id, product_id, quantity::text as quantity,
           unit_price_transaction::text as unit_price_transaction
      from public.document_lines
     where document_id = ${documentId} and company_id = ${input.company_id}
     order by line_number`;

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  let nc: Result<DocumentResponse, SalesError>;
  try {
    nc = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx.value, {
        companyId: input.company_id,
        customerId: doc.customer_id,
        priceListId: doc.price_list_id,
        sourceDocumentId: documentId,
        kind: "withdrawal_credit_note",
        lineas: lineas.map((l) => ({
          product_id: l.product_id,
          quantity: l.quantity,
          unit_price_transaction: l.unit_price_transaction,
          source_line_id: l.id,
        })),
        fecha,
        notes: input.reason,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nc.ok) return nc;

  const numeroNota = serieYNumero(nc.value.series, nc.value.document_number ?? "");
  const numeroFactura = serieYNumero(doc.series, doc.document_number ?? "");
  const reingreso = await reingresarRetiro(uow, {
    companyId: input.company_id,
    facturaId: documentId,
    notaId: nc.value.id,
    impuesto: nc.value.tax_amount,
    descripcion: `Nota de crédito ${numeroNota}: deja sin efecto el retiro de la factura ${numeroFactura} — ${input.reason}`,
  });
  if (!reingreso.ok) {
    return err(
      reingreso.error.code === "PERMISSION_REQUIRED"
        ? { code: "PERMISSION_REQUIRED", message: reingreso.error.message }
        : reingreso.error.code === "NOT_FOUND"
          ? { code: "NOT_FOUND", message: reingreso.error.message }
          : { code: "VALIDATION_FAILED", message: reingreso.error.message },
    );
  }
  await auditar(sql, ctx.value.tenantId, nc.value, "fiscal.credit_note.issued", {
    reason: input.reason,
    withdrawal_invoice_id: documentId,
    withdrawal_reentry_move_id: reingreso.value.id,
  });
  return ok(nc.value);
}

/** Anula una factura emitida. El correlativo SE CONSERVA (ADR-0037). */
export async function annulInvoice(
  uow: UnitOfWork,
  documentId: string,
  input: AnnulInvoiceRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Anular exige un usuario real." });
  }
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    "sales.invoice.annul",
    new Date().toISOString(),
  );
  if (!ctx.ok) return ctx;

  // El documento BLOQUEADO: un cobro concurrente no puede colarse entre la
  // comprobación de «sin cobros» y la anulación (ADR-0061 §1).
  const [doc] = await sql<{ status: string; kind: string; withdrawal_move_id: string | null }[]>`
    select status, kind, withdrawal_move_id from public.documents
     where id = ${documentId} and company_id = ${input.company_id}
     for update`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // ADR-0082: la factura de retiro es papel fiscal como la factura; la anula la misma regla.
  const esFactura = doc.kind === "invoice" || doc.kind === "withdrawal_invoice";
  if (!esFactura && doc.kind !== "receipt") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Solo se anula una factura o un recibo. Una nota no se anula: se corrige con la nota contraria.",
    });
  }
  const nombre = nombreDeAnulable(doc.kind);
  // ADR-0082: una factura de retiro ya corregida con su nota de crédito no se anula (se
  // corregiría dos veces). La base también lo rechaza.
  if (doc.kind === "withdrawal_invoice") {
    const [corregida] = await sql<{ n: number }[]>`
      select count(*)::int as n from public.documents
       where company_id = ${input.company_id} and source_document_id = ${documentId}
         and kind = 'withdrawal_credit_note' and status = 'issued'`;
    if ((corregida?.n ?? 0) > 0) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Esta factura de retiro ya se corrigió con su nota de crédito: no se anula.",
      });
    }
  }

  // UNA VENTA COBRADA NO SE ANULA: SE DEVUELVE (ADR-0061 §8). El cobro es un
  // hecho de caja que ocurrió; anular fingiría que el dinero nunca entró. El
  // camino es la devolución: repone la mercancía y devuelve el dinero como
  // saldo a favor o reembolso.
  // H4 (ADR-0075 §8, decidido por criterio): un cobro REVERSADO no es un cobro. Solo cuentan los
  // vivos: una venta cuyo único cobro se reversó no tiene dinero dentro y se puede anular.
  const [cobros] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.payments p
     where p.document_id = ${documentId}
       and not exists (select 1 from public.payment_reversals pr where pr.payment_id = p.id)`;
  if (doc.status === "paid" || (cobros?.n ?? 0) > 0) {
    return err({
      code: "DOCUMENT_HAS_PAYMENTS",
      message: `Este ${nombre} ya tiene cobros y no se puede anular. Para deshacer la venta, registra una devolución: repone la mercancía y devuelve el dinero como saldo a favor o reembolso.`,
    });
  }
  if (doc.status !== "issued") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se anula un ${nombre} emitido; este está en ${doc.status}.`,
    });
  }
  // UNA VENTA CON DEVOLUCIÓN CONFIRMADA NO SE ANULA (ola 5, I-04; destapado por el caso «anular
  // después de una devolución parcial»). La anulación repone TODAS las salidas del documento y
  // reversa su asiento entero: sobre una venta de la que ya volvió parte, la mercancía devuelta
  // entraba dos veces (y `annulled_stock_gaps` no lo veía: los reingresos de la devolución cuelgan
  // de la devolución, no de la venta). Lo que falta por deshacer se devuelve.
  const [devoluciones] = await sql<{ n: number }[]>`
    select count(*)::int as n from public.returns r
     where r.company_id = ${input.company_id} and r.source_document_id = ${documentId}
       and r.status = 'confirmed'`;
  if ((devoluciones?.n ?? 0) > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Este ${nombre} ya tiene una devolución registrada y no se anula: la mercancía devuelta entraría dos veces. Lo que falte por deshacer regístralo con otra devolución.`,
    });
  }

  // G-10 (PA 00071 arts. 22 y 36): una FACTURA se anula solo si el papel no salió del negocio y
  // la operación no ocurrió —mismo día de Caracas, antes del cierre de su caja, período sin
  // declarar—, y la persona confirma que tiene el original y las copias. Lo demás es nota de
  // crédito. La regla pregunta por SUS condiciones: no mira si hubo cobros reversados (P-91). El
  // recibo no es papel fiscal y conserva la regla de ADR-0061 §1.
  if (esFactura) {
    const papel =
      (await bloqueoDePapel(sql, input.company_id, documentId)) ??
      (input.originals_in_hand === true ? null : ("originals_not_confirmed" as const));
    if (papel !== null) {
      return err({
        code: "ANNULMENT_NOT_ALLOWED",
        message: mensajeDeAnulacion(papel, nombre),
        details: { reason: papel },
      });
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  try {
    const [anulada] = await sql<DocumentResponse[]>`
      update public.documents
         set status = 'annulled', annulled_at = now(), annul_reason = ${input.reason}
       where id = ${documentId} and company_id = ${input.company_id}
      returning ${sql.unsafe(DOC_COLUMNS)}`;
    await auditar(
      sql,
      ctx.value.tenantId,
      anulada!,
      doc.kind === "receipt" ? "sales.receipt.annulled" : "fiscal.invoice.annulled",
      // G-10: el acta guarda que la persona respondió por el original y las copias (art. 36).
      esFactura ? { reason: input.reason, originals_in_hand: true } : { reason: input.reason },
    );

    /**
     * ANULAR REPONE (ADR-0061 §2): cada salida vuelve al mismo depósito y lote, al
     * valor exacto con que salió. Y el mayor la acompaña según lo que pasó con el
     * costo de ventas: si llegó a asentarse, un hecho propio lo revierte
     * (inventario contra costo de ventas); si seguía en la cola, se descarta con
     * la venta y no hay nada que revertir — kardex y mayor quedan igual de netos.
     */
    const repuesto = await reponerSalidasDeDocumento(uow, input.company_id, documentId);
    if (!repuesto.ok) {
      return err(
        repuesto.error.code === "NEGATIVE_STOCK"
          ? { code: "NEGATIVE_STOCK", message: repuesto.error.message }
          : repuesto.error.code === "PERMISSION_REQUIRED"
            ? { code: "PERMISSION_REQUIRED", message: repuesto.error.message }
            : { code: "VALIDATION_FAILED", message: repuesto.error.message },
      );
    }
    const [costoAsentado] = await sql<{ id: string }[]>`
      select id from public.journal_entries
       where company_id = ${input.company_id} and source_kind = 'sales_cost'
         and source_event = 'stock.shipped' and source_id = ${documentId}
         and status = 'posted'`;
    const valorRepuesto = parseDecimal(repuesto.value.repuesto);
    if (costoAsentado !== undefined && valorRepuesto.ok && !valorRepuesto.value.isZero()) {
      const reversoCosto = await generateJournalFromDocument(sql, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        sourceKind: "sales_cost",
        sourceEvent: "stock.received",
        sourceId: documentId,
        postingDate: diaNegocio(new Date().toISOString()),
        postedBy: actor.userId,
        description: `Anulación del ${nombre} ${serieYNumero(anulada!.series, anulada!.document_number ?? "")}: la mercancía vuelve al inventario`,
        functionalCurrency: ctx.value.functionalCurrency,
        amounts: { functional_amount: repuesto.value.repuesto },
      });
      if (!reversoCosto.ok) {
        return err({ code: "VALIDATION_FAILED", message: reversoCosto.error.message });
      }
    }

    // La anulación NO genera un asiento nuevo desde plantilla: REVERSA el que
    // la emisión creó. Reutiliza el caso de uso que ya está probado, deja los
    // dos asientos visibles y el neto por cuenta en cero, que es lo que hace
    // auditable la corrección. Si la factura estaba en la cola sin asentar, no
    // hay nada que reversar y la cola se descarta.
    const [conAsiento] = await sql<{ journal_entry_id: string | null }[]>`
      select journal_entry_id from public.documents where id = ${documentId}`;
    if (conAsiento?.journal_entry_id != null) {
      // La reversa la autoriza LA ANULACIÓN (`sales.invoice.annul`), no
      // `accounting.entry.reverse` (ADR-0068 §1, N-04).
      const reverso = await reverseJournalEntryForAnnulment(uow, conAsiento.journal_entry_id, {
        company_id: input.company_id,
        reason: `Anulación del ${nombre}: ${input.reason}`,
      });
      if (!reverso.ok) {
        // Un permiso que falta es un 403 legible, no un «dato inválido» con el nombre técnico
        // del permiso en la pantalla (N-04; la rama hermana del kardex ya lo hacía).
        return err(
          reverso.error.code === "PERMISSION_REQUIRED"
            ? { code: "PERMISSION_REQUIRED", message: reverso.error.message }
            : { code: "VALIDATION_FAILED", message: reverso.error.message },
        );
      }
    } else {
      await sql`
        update public.journal_generation_queue
           set status = 'discarded', processed_at = now()
         where company_id = ${input.company_id} and source_id = ${documentId}
           and source_kind in ('sales_invoice', 'sales_receipt')
           and status = 'pending'`;
    }
    // ADR-0082 · LA FACTURA DE RETIRO: su asiento es el de su salida del kardex (gasto por retiro
    // + débito fiscal contra inventario). Anularla lo REVERSA entero —la mercancía ya volvió
    // arriba, al valor con que salió—; si el hecho seguía en la cola, se descarta.
    if (doc.kind === "withdrawal_invoice" && doc.withdrawal_move_id !== null) {
      const [asientoRetiro] = await sql<{ id: string }[]>`
        select id from public.journal_entries
         where company_id = ${input.company_id} and source_kind = 'inventory_move'
           and source_event = 'stock.withdrawn' and source_id = ${doc.withdrawal_move_id}
           and status = 'posted'`;
      if (asientoRetiro !== undefined) {
        const reverso = await reverseJournalEntryForAnnulment(uow, asientoRetiro.id, {
          company_id: input.company_id,
          reason: `Anulación de la factura de retiro: ${input.reason}`,
        });
        if (!reverso.ok) {
          return err(
            reverso.error.code === "PERMISSION_REQUIRED"
              ? { code: "PERMISSION_REQUIRED", message: reverso.error.message }
              : { code: "VALIDATION_FAILED", message: reverso.error.message },
          );
        }
      } else {
        await sql`
          update public.journal_generation_queue
             set status = 'discarded', processed_at = now()
           where company_id = ${input.company_id} and source_id = ${doc.withdrawal_move_id}
             and source_kind = 'inventory_move' and source_event = 'stock.withdrawn'
             and status = 'pending'`;
      }
    }
    // El costo de ventas que seguía en la cola se descarta con la venta: nunca
    // llegó al mayor, y la reposición tampoco lo toca.
    if (costoAsentado === undefined) {
      await sql`
        update public.journal_generation_queue
           set status = 'discarded', processed_at = now()
         where company_id = ${input.company_id} and source_id = ${documentId}
           and source_kind = 'sales_cost' and source_event = 'stock.shipped'
           and status = 'pending'`;
    }

    // EL BORDE DE LA ANULACIÓN (migración 46, H-7): lo percibido de IGTF
    // nunca se resta solo. Hoy esta rama no se alcanza con IGTF percibido: el IGTF
    // solo existe si hubo cobro, y una factura con cobros no se anula (ADR-0061).
    // Se conserva como defensa; la restitución con la venta viva es de la ola 3
    // (R-61, junto con la reversa de cobros; VALIDAR-TRIBUTARIO P-67).
    const reintegros = await sql<{ id: string }[]>`
      update public.igtf_perceptions
         set status = 'pendiente_reintegro',
             status_reason = ${`Anulación de la factura: ${input.reason}`}
       where company_id = ${input.company_id} and document_id = ${documentId}
         and status = 'percibido'
      returning id`;
    if (reintegros.length > 0) {
      await auditar(sql, ctx.value.tenantId, anulada!, "igtf.perception_pending_refund", {
        reason: input.reason,
        perception_ids: reintegros.map((r) => r.id),
      });
    }
    return ok(anulada!);
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
}

/**
 * Registra un cobro y, si la tasa del día difiere de la de emisión, el
 * DIFERENCIAL CAMBIARIO. No es «cobró de más»: el cliente entregó lo pactado en
 * su moneda, y lo que cambió es cuántos bolívares vale eso.
 */
export async function registerPayment(
  uow: UnitOfWork,
  input: RegisterPaymentRequest,
  /** F-11: la retención soportada la carga quien tiene `ar.retention.register`, no quien cobra. */
  permiso: "sales.payment.register" | "ar.retention.register" = "sales.payment.register",
  /**
   * `enEmision`: el cobro es el de la PROPIA venta (la caja, quickSale) — su IGTF se imprime en
   * la factura. Sin él, el cobro es POSTERIOR (fiado o abono, E-03) y el IGTF se documenta con
   * una Nota de Débito por IGTF.
   */
  opciones: { readonly enEmision?: boolean } = {},
): Promise<Result<RegisterPaymentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cobrar exige un usuario real." });
  }
  if (permiso === "ar.retention.register" && input.instrument !== "retencion_iva") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "El permiso de retenciones solo abona comprobantes de retención.",
    });
  }
  const fecha = ahora(input.paid_at);
  const ctx = await autorizar(sql, actor.userId, input.company_id, permiso, fecha);
  if (!ctx.ok) return ctx;

  const [doc] = await sql<
    {
      id: string;
      status: string;
      total_amount: string;
      total_transaction: string | null;
      transaction_currency: string;
      fx_rate: string;
      functional_currency: string;
      customer_id: string;
      kind: string;
      source_document_id: string | null;
      price_list_id: string | null;
    }[]
  >`select id, status, total_amount::text as total_amount,
           amount_transaction_currency::text as total_transaction, transaction_currency,
           fx_rate::text as fx_rate, functional_currency, customer_id, kind,
           source_document_id, price_list_id
      from public.documents where id = ${input.document_id} and company_id = ${input.company_id}
      for update`;
  // `for update`: dos cobros simultáneos del mismo total pasaban ambos el
  // tope (auditoría 2026-09-11, A-26). El segundo espera y ve el saldo real.
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // ADR-0082: una factura de retiro no tiene cuenta por cobrar (el adquirente es la propia
  // empresa). La base también lo rechaza (trigger payments_05_no_withdrawal_invoice).
  if (doc.kind === "withdrawal_invoice" || doc.kind === "withdrawal_credit_note") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Una factura de retiro no se cobra: el adquirente es tu propio negocio y no hay nada que cobrar.",
    });
  }
  if (doc.status !== "issued") {
    return err({
      code: "VALIDATION_FAILED",
      message: `Solo se cobra una factura emitida; esta está en ${doc.status}.`,
    });
  }

  /**
   * F-05 (RESPUESTA §2.6; revisión 11, decidido por criterio «nunca se registra dinero que no
   * entró»): POR OMISIÓN `amount` es lo ENTREGADO, IGTF incluido. Solo `igtf_included: false`
   * —la caja, que ya repartió lo entregado con el mismo cálculo— lo trata como lo que abona. Así,
   * se reparte EXACTAMENTE como en la caja (pasoDeCobro, ADR-0059): base + IGTF(base) =
   * entregado, y lo que no alcance queda pendiente en el documento. Antes la ficha abonaba los
   * 10 USD enteros y percibía 0,30 ADEMÁS: la cuenta registraba 10,30 cuando entraron 10.
   */
  if (input.igtf_included !== false) {
    const resto = { ...input, igtf_included: false as const };
    if (input.currency === ctx.value.functionalCurrency || input.instrument === "saldo_a_favor") {
      return registerPayment(uow, resto, permiso, opciones);
    }
    const cond = await condicionDePago(
      sql,
      input.company_id,
      input.instrument,
      input.currency,
      ctx.value.functionalCurrency,
      fecha,
    );
    if (!cond.ok) return cond;
    if (cond.value.igtf === null) return registerPayment(uow, resto, permiso, opciones);
    /**
     * Re-revisión F1: lo pendiente se valora el DÍA DEL COBRO (`diaNegocio(fecha)`), no a la tasa
     * de hoy — un cobro con `paid_at` de ayer usa la tasa de ayer, la misma que `condicionDePago`.
     *   · documento en la moneda funcional: su saldo funcional (`document_balance`);
     *   · pago en la moneda del documento: el saldo EN ESA MONEDA × la tasa del pago;
     *   · dos divisas distintas: el saldo en la del documento × su tasa a funcional del día.
     * Una factura de 100 USD cobrada en USD son 100 USD, a la tasa que sea.
     */
    let pendienteTexto: string | null;
    if (doc.transaction_currency === ctx.value.functionalCurrency) {
      const [b] = await sql<{ saldo: string | null }[]>`
        select platform.document_balance(${input.company_id}, ${input.document_id})::text
                 as saldo`;
      pendienteTexto = b?.saldo ?? null;
    } else {
      const [tx] = await sql<{ saldo: string | null; tasa: string | null }[]>`
        select platform.document_balance_transaction(${input.company_id}, ${input.document_id})::text
                 as saldo,
               platform.rate_at(${input.company_id}, ${doc.transaction_currency},
                                ${ctx.value.functionalCurrency}, ${diaNegocio(fecha)}::date)::text
                 as tasa`;
      const saldoTx = parseDecimal(tx?.saldo ?? "0");
      const tasaDoc =
        input.currency === doc.transaction_currency
          ? ok(cond.value.tasa)
          : tx?.tasa != null
            ? parseDecimal(tx.tasa)
            : err({ code: "EXCHANGE_RATE_MISSING" as const, message: "" });
      if (!saldoTx.ok || !tasaDoc.ok) {
        return err({
          code: "EXCHANGE_RATE_MISSING",
          message: `No hay tasa de ${doc.transaction_currency} a ${ctx.value.functionalCurrency} para la fecha del cobro.`,
        });
      }
      pendienteTexto = saldoTx.value.times(tasaDoc.value).toFixed(8);
    }
    const pendiente = parseDecimal(pendienteTexto ?? "0");
    const entregado = parseDecimal(input.amount);
    if (!pendiente.ok || !entregado.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    const paso = pasoDeCobro({
      pendienteFuncional: pendiente.value,
      entregado: entregado.value,
      moneda: input.currency,
      monedaFuncional: ctx.value.functionalCurrency,
      instrumento: input.instrument,
      cond: cond.value,
    });
    if (!paso.ok) return paso;
    if (!paso.value.vuelto.isZero()) {
      return err({
        code: "VALIDATION_FAILED",
        message: `Lo recibido supera lo que falta con IGTF: sobran ${paso.value.vuelto.toFixed(minorUnitsOf(input.currency))} ${input.currency}. Registra lo que queda en caja y entrega el vuelto.`,
      });
    }
    return registerPayment(
      uow,
      { ...resto, amount: paso.value.aplicado.toFixed(8) },
      permiso,
      opciones,
    );
  }

  /**
   * G-05 (ADR-0075 §4): el saldo a favor conserva la MONEDA del documento que lo originó y la
   * tasa con que nació. Aplicarlo:
   *   · a un documento de la MISMA moneda: nominal contra nominal. El «cobro» vale lo que el
   *     pasivo lleva en el mayor (la tasa con que nació), no la tasa de hoy: la diferencia con lo
   *     que el documento cargó a cuentas por cobrar es el diferencial de siempre;
   *   · a un documento de OTRA moneda: a la BCV del día de la aplicación (el camino de cualquier
   *     pago cruzado), y el pasivo baja por lo que llevaba; la diferencia va al diferencial.
   * Un saldo a favor en moneda funcional (todos los anteriores a 20261004150000) no pasa por aquí.
   */
  let tasaDelSaldoAFavor: { rate: string; source: string } | null = null;
  // Lo que ESTE uso baja del pasivo en el mayor (ADR-0075 decisión 5, tercera ronda): la parte
  // proporcional de lo que el saldo a favor cargó al nacer, y el resto exacto si lo agota. Se lee
  // con el saldo BLOQUEADO: dos usos simultáneos no calculan el mismo resto.
  let pasivoDelUso: Decimal | null = null;
  if (
    input.instrument === "saldo_a_favor" &&
    input.customer_credit_id !== undefined &&
    input.currency !== ctx.value.functionalCurrency
  ) {
    const [cr] = await sql<
      {
        currency: string;
        fx_rate: string | null;
        rate_source: string | null;
        amount: string;
        applied_amount: string;
        functional_amount: string | null;
        carried: string | null;
      }[]
    >`select currency, fx_rate::text as fx_rate, rate_source, amount::text as amount,
             applied_amount::text as applied_amount, functional_amount::text as functional_amount,
             platform.customer_credit_carried(${input.company_id}, id)::text as carried
        from public.customer_credits
       where id = ${input.customer_credit_id} and company_id = ${input.company_id}
         for update`;
    if (cr && cr.currency === input.currency && cr.fx_rate !== null) {
      tasaDelSaldoAFavor = { rate: cr.fx_rate, source: cr.rate_source ?? "manual" };
      const pedidoDelSaldo = parseDecimal(input.amount);
      if (pedidoDelSaldo.ok) {
        pasivoDelUso = pasivoDeUnUso(
          cr,
          pedidoDelSaldo.value,
          minorUnitsOf(ctx.value.functionalCurrency),
        );
      }
    }
  }

  // La tasa del DÍA DEL COBRO. Si el cobro es en moneda funcional, la identidad.
  let tasaCobro = "1";
  let fuenteCobro = "identidad";
  if (tasaDelSaldoAFavor !== null && input.currency === doc.transaction_currency) {
    tasaCobro = tasaDelSaldoAFavor.rate;
    fuenteCobro = tasaDelSaldoAFavor.source;
  } else if (input.currency !== ctx.value.functionalCurrency) {
    const [t] = await sql<{ rate: string | null; source: string | null }[]>`
      select f.rate::text as rate, f.source
        from platform.rate_for(${input.company_id}, ${input.currency},
                               ${ctx.value.functionalCurrency}, ${diaNegocio(fecha)}::date) f`;
    if (!t?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa de ${input.currency} a ${ctx.value.functionalCurrency} para la fecha del cobro.`,
      });
    }
    tasaCobro = t.rate;
    fuenteCobro = t.source ?? "manual";
  }
  const tasaCobroDec = parseDecimal(tasaCobro);
  const importe = Money.of(input.amount, input.currency);
  if (!tasaCobroDec.ok || !importe.ok) {
    return err({ code: "VALIDATION_FAILED", message: "Importe o tasa no interpretables." });
  }
  const funcionalCobro = importe.value.multiply(tasaCobroDec.value);
  const escalaFuncional = minorUnitsOf(ctx.value.functionalCurrency);
  let funcionalRedondeado = Money.of(
    funcionalCobro.amount.toDecimalPlaces(escalaFuncional, 4).toFixed(8),
    ctx.value.functionalCurrency,
  );
  if (!funcionalRedondeado.ok) {
    return err({ code: "VALIDATION_FAILED", message: funcionalRedondeado.error.message });
  }

  // G-05: el saldo a favor en divisa aplicado a un documento de OTRA moneda. El documento baja
  // por lo que vale hoy (`funcionalRedondeado`); el pasivo, por lo que llevaba en el mayor.
  let pasivoAplicado: Decimal | null = null;
  let tasaDeNacimiento: Decimal | null = null;
  if (tasaDelSaldoAFavor !== null && input.currency !== doc.transaction_currency) {
    // Solo a un documento en moneda FUNCIONAL. Un saldo a favor en una divisa aplicado a un
    // documento en OTRA divisa tendría dos diferenciales (el del documento y el del pasivo) y la
    // tabla guarda uno por cobro: en vez de asentar uno que el reporte no vería, se rechaza.
    if (doc.transaction_currency !== doc.functional_currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El saldo a favor está en ${input.currency} y el documento en ${doc.transaction_currency}: entre dos divisas distintas no se aplica. Devuélvelo en dinero y cobra el documento.`,
      });
    }
    const tasaNacimiento = parseDecimal(tasaDelSaldoAFavor.rate);
    if (!tasaNacimiento.ok) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Tasa del saldo a favor no interpretable.",
      });
    }
    tasaDeNacimiento = tasaNacimiento.value;
    pasivoAplicado =
      pasivoDelUso ??
      importe.value.amount.times(tasaNacimiento.value).toDecimalPlaces(escalaFuncional, 4);
  }

  // ADR-0072 §5: el comprobante de retención soportada abona la divisa de la factura a la tasa
  // DE LA FACTURA (es una fracción fija de su IVA), salvo que el comprobante diga otra cosa
  // (`voucher_rate`, el parámetro P-30). Se lee una vez y decide el tope y el diferencial.
  let retencionATasaFactura = false;
  if (input.instrument === "retencion_iva" && input.supported_retention_id !== undefined) {
    const [v] = await sql<{ ar_valuation: string }[]>`
      select ar_valuation from public.supported_retention_receipts
       where id = ${input.supported_retention_id} and company_id = ${input.company_id}`;
    retencionATasaFactura = v?.ar_valuation === "invoice_rate";
  }

  // El saldo se CALCULA, nunca se lee de una columna.
  const [saldoAntes] = await sql<{ saldo: string }[]>`
    select platform.document_balance(${input.company_id}, ${input.document_id})::text as saldo`;

  /**
   * EL COBRO QUE CIERRA (ADR-0063 §2). El dinero real solo viene en unidades mínimas: quien
   * paga en dólares una cuenta de Bs 2.358,1788 entrega 2,80 y con eso la cuenta queda
   * saldada. El importe guardado es esos 2,80 —lo que de verdad entró en la caja— y su valor
   * funcional es EXACTAMENTE lo pendiente, para que el documento quede en cero y no en
   * «Saldo Bs. 0,0000758» (QA de pantalla 2026-09-15, h. 32, 37, 56).
   *
   * La tolerancia es media unidad mínima de la MONEDA DEL COBRO valorada en funcional: es lo
   * que el redondeo de caja puede desviar como máximo. La diferencia queda absorbida en la
   * conversión de este cobro y no se asienta aparte (VALIDAR-CONTABLE, ADR-0058 §6.4).
   */
  const toleranciaCaja = unidadMinima(input.currency).dividedBy(2).times(tasaCobroDec.value);
  const pendienteFuncional = parseDecimal(saldoAntes?.saldo ?? "0");
  if (
    pendienteFuncional.ok &&
    pendienteFuncional.value.greaterThan(0) &&
    pendienteFuncional.value
      .minus(funcionalRedondeado.value.amount)
      .abs()
      .lessThanOrEqualTo(toleranciaCaja)
  ) {
    const exacto = Money.of(pendienteFuncional.value.toFixed(8), ctx.value.functionalCurrency);
    if (!exacto.ok) return err({ code: "VALIDATION_FAILED", message: exacto.error.message });
    funcionalRedondeado = exacto;
  }

  /**
   * ADR-0075 decisión 5 (tercera ronda): un saldo a favor en divisa aplicado a un documento de SU
   * moneda «vale» lo que baja del pasivo —la parte proporcional de lo que cargó al nacer, o el
   * resto exacto si se agota—, no importe × tasa: una NC con IVA nace por su total en Bs (E-05),
   * y a importe × tasa el pasivo de un saldo agotado no volvía a cero (2,78 USD a 854,4637 son
   * 2.375,41 y la nota cargó 2.378,82). `ajustePasivo` es lo que esa regla se aparta de importe ×
   * tasa: NO es deuda del documento. La cuenta por cobrar baja como siempre y el ajuste va con la
   * diferencia del cobro (redondeo a la tasa del documento; diferencial a otra).
   */
  let ajustePasivo = decimalDe("0");
  if (
    pasivoDelUso !== null &&
    input.currency === doc.transaction_currency &&
    pasivoDelUso.greaterThan(0)
  ) {
    const delPasivo = Money.of(pasivoDelUso.toFixed(8), ctx.value.functionalCurrency);
    if (!delPasivo.ok) return err({ code: "VALIDATION_FAILED", message: delPasivo.error.message });
    ajustePasivo = pasivoDelUso.minus(funcionalRedondeado.value.amount);
    funcionalRedondeado = delPasivo;
  }

  /**
   * LO SALDADO, CONGELADO, Y EL COBRO QUE CIERRA (ADR-0075 §4; F-02, F-15, G-12).
   *   · `saldadoTx`: lo que este cobro salda EN LA MONEDA DEL DOCUMENTO, con la tasa que vale
   *     AHORA. Se guarda en el cobro (`settled_transaction_amount`): una tasa cargada después no
   *     lo cambia.
   *   · `cierra`: tras este cobro queda menos de medio céntimo de la moneda del documento. El
   *     cobro que cierra salda exactamente lo que faltaba, y abajo cancela de cuentas por cobrar
   *     exactamente lo que el mayor todavía le cargaba al documento: la diferencia va al
   *     diferencial (o a redondeo, en la retención), nunca se queda en la cartera.
   *
   * UN SOLO TOTAL (ADR-0063 §1; ADR-0075, nota «el cobro y el cierre», reglas 2 y 3). A LA TASA
   * DEL DOCUMENTO, la deuda en moneda funcional de un documento en divisa es su total en Bs —o
   * la parte proporcional de lo que quede—, no «saldo en divisa × tasa»: esas dos cifras se
   * apartan por el redondeo del IVA al céntimo de la divisa (E-05; 10,25 Bs en una factura de
   * tres líneas). Un cobro en moneda funcional a esa tasa salda la divisa en PROPORCIÓN:
   * saldo en divisa × pagado ÷ saldo en Bs. Así pagar el total en Bs que la caja anuncia y la
   * factura imprime salda el total en divisa EXACTO, sin diferencial. A otra tasa (otro día) no
   * hay total impreso que respetar: pagado ÷ tasa del día.
   *
   * El «saldo en Bs» es lo que el MAYOR todavía le carga al documento, que es lo que la caja
   * pide tras un abono (el saldo funcional) y coincide con la parte proporcional del total
   * siempre que los abonos anteriores fueron en Bs a esta tasa. Si el mayor se aparta de esa
   * parte proporcional más que el redondeo (la cota de la regla 4), NO se le cree: se usa la
   * parte proporcional, y el cierre de abajo falla diciéndolo.
   */
  /**
   * F-10 (RESPUESTA §3): un pago de más SE ACEPTA. Lo que entra en la caja es lo que la persona
   * dijo que recibió; el documento se salda por lo que debía y el sobrante nace como SALDO A FAVOR
   * del cliente (un anticipo), en la moneda del documento y a la tasa de este cobro (G-05). Nunca
   * se manda a hacer una nota de crédito: una NC es un documento fiscal que reduce la venta.
   */
  let sobrante: { importe: Decimal; moneda: string; tasa: Decimal; funcional: Decimal } | null =
    null;
  let tasaDocDelDia: Decimal | null = null;
  const docEnDivisa = doc.transaction_currency !== doc.functional_currency;
  let saldadoTx = funcionalRedondeado.value.amount;
  let cierra = false;
  let abiertoEnMayor: Decimal | null = null;
  let saldoTxAntes: Decimal | null = null;
  /**
   * AF-M03 (ADR-0075 §4): el cobro ocurre a la MISMA tasa del documento. Entonces no hay
   * diferencial cambiario posible: lo que el cierre deje de más o de menos es el redondeo del
   * IVA al céntimo de la divisa (E-05), va a «Diferencias por redondeo» y no deja fila en
   * `exchange_gain_loss`. La retención soportada ya iba así (abona a la tasa de la factura).
   */
  let aLaTasaDelDoc = false;
  if (docEnDivisa) {
    const [antes] = await sql<
      {
        saldo: string | null;
        tasa: string | null;
        mayor: string | null;
        calculado: string;
        base: string | null;
        lineas: number;
        cobros: number;
      }[]
    >`
      select platform.document_balance_transaction(
               ${input.company_id}, ${input.document_id})::text as saldo,
             platform.rate_at(${input.company_id}, ${doc.transaction_currency},
                              ${doc.functional_currency}, ${diaNegocio(fecha)}::date)::text as tasa,
             platform.settlement_ledger_open(
               ${input.company_id}, 'ar', ${input.document_id})::text as mayor,
             -- LA BASE DEL CIERRE a la tasa del documento: UNA sola regla, la de la base
             -- (20261003210100). Es la misma cifra que platform.document_debt enseña como deuda:
             -- lo mostrado es lo que cierra.
             platform.document_settlement_base(
               ${input.company_id}, ${input.document_id})::text as base,
             -- El respaldo, cuando alguna pieza está en la cola: total − Σ lo ya cancelado por
             -- los cobros VIVOS. Un cobro reversado no canceló nada (el mismo «not exists» de
             -- platform.document_balance): contarlo inventaba un diferencial en el cierre.
             (select d.total_amount
                     - coalesce(sum(p.functional_amount - coalesce(g.difference, 0)), 0)
                from public.documents d
                left join public.payments p
                  on p.document_id = d.id
                 and not exists (select 1 from public.payment_reversals pr
                                  where pr.payment_id = p.id)
                left join public.exchange_gain_loss g on g.payment_id = p.id
               where d.id = ${input.document_id}
               group by d.total_amount)::text as calculado,
             (select count(*)::int from public.document_lines l
               where l.document_id = ${input.document_id}) as lineas,
             (select count(*)::int from public.payments p
               where p.document_id = ${input.document_id}) as cobros`;
    const tasaFactura = parseDecimal(doc.fx_rate);
    // El mayor responde si todas las piezas del documento tienen asiento; si alguna está en la
    // cola, lo mismo se calcula desde los cobros. Vale con cualquier signo: con el mayor ya en
    // cero o sobre-abonado, el último cobro lo devuelve a cero igual (antes solo si era > 0, y
    // la cuenta por cobrar quedaba negativa en un documento pagado).
    const abierto = parseDecimal(antes?.mayor ?? antes?.calculado ?? "");
    if (abierto.ok) abiertoEnMayor = abierto.value;
    const saldoLeido = parseDecimal(antes?.saldo ?? "");
    if (saldoLeido.ok) saldoTxAntes = saldoLeido.value;
    // La cota del redondeo (regla 4), a una tasa: por línea, media unidad mínima de la divisa ×
    // tasa + un céntimo; más la media unidad con la que un cobro «cierra» sin llegar al céntimo,
    // y un céntimo por cada cobro (cada uno redondea lo que cancela).
    const cota = (tasaMayor: Decimal): Decimal => {
      const media = unidadMinima(doc.transaction_currency).dividedBy(2).times(tasaMayor);
      const centimo = unidadMinima(doc.functional_currency);
      return media
        .plus(centimo)
        .times(Math.max(antes?.lineas ?? 1, 1))
        .plus(media)
        .plus(centimo.times((antes?.cobros ?? 0) + 1));
    };
    // La tasa documento → funcional del día del cobro: la del propio cobro si viene en la moneda
    // del documento; la de la factura en la retención; la del día en lo demás.
    let tasaDocHoy: Decimal | null = null;
    if (input.currency === doc.transaction_currency) {
      saldadoTx = importe.value.amount;
      tasaDocHoy = tasaCobroDec.value;
    } else if (retencionATasaFactura && tasaFactura.ok) {
      saldadoTx = funcionalRedondeado.value.amount
        .dividedBy(tasaFactura.value)
        .toDecimalPlaces(8, 4);
      tasaDocHoy = tasaFactura.value;
    } else {
      const tasaDia = antes?.tasa != null ? parseDecimal(antes.tasa) : null;
      if (tasaDia === null || !tasaDia.ok) {
        return err({
          code: "EXCHANGE_RATE_MISSING",
          message: `No hay tasa de ${doc.transaction_currency} a ${doc.functional_currency} para valorar este cobro.`,
        });
      }
      tasaDocHoy = tasaDia.value;
      const aLaTasaDelDocumento =
        input.currency === doc.functional_currency &&
        tasaFactura.ok &&
        tasaDia.value.equals(tasaFactura.value);
      // El «saldo en Bs» a la tasa del documento NO se calcula aquí: lo dice
      // platform.document_settlement_base (lo que el mayor carga si cuadra con la parte
      // proporcional del total dentro de la cota; si no, la parte proporcional).
      let saldoBs: Decimal | null = null;
      if (aLaTasaDelDocumento && saldoTxAntes !== null && saldoTxAntes.greaterThan(0)) {
        const base = parseDecimal(antes?.base ?? "");
        if (base.ok && base.value.greaterThan(0)) saldoBs = base.value;
      }
      saldadoTx =
        saldoBs !== null && saldoTxAntes !== null && saldoBs.greaterThan(0)
          ? saldoTxAntes
              .times(funcionalRedondeado.value.amount)
              .dividedBy(saldoBs)
              .toDecimalPlaces(8, 4)
          : funcionalRedondeado.value.amount.dividedBy(tasaDia.value).toDecimalPlaces(8, 4);
    }

    aLaTasaDelDoc =
      !retencionATasaFactura &&
      tasaFactura.ok &&
      tasaDocHoy !== null &&
      tasaDocHoy.equals(tasaFactura.value);

    // TOPE: un cobro no supera lo pendiente (A-26). El documento vive en divisa: se compara el
    // saldo EN LA DIVISA contra lo que este cobro salda en ella (lo mismo que se va a guardar).
    // El exceso no se guarda como cobro: para eso está el saldo a favor (nota de crédito) — y la
    // caja (quickSale) da vuelto, no pasa por aquí. Tolerancia: medio céntimo (R-02).
    tasaDocDelDia = tasaDocHoy;
    if (saldoTxAntes !== null) {
      const holgura = decimalDe("0.005");
      if (saldadoTx.minus(saldoTxAntes).greaterThan(holgura)) {
        // Punto 14: un saldo a favor no se aplica por más de lo que el documento debe. Lo que
        // sobra NO se consume (ni nace otro saldo a favor de un saldo a favor): se rechaza, y el
        // saldo conserva su resto.
        if (input.instrument === "saldo_a_favor") {
          return err({
            code: "VALIDATION_FAILED",
            message: `El saldo a favor que se aplica supera lo pendiente: quedan ${saldoTxAntes.toDecimalPlaces(2, 4).toFixed(2)} ${doc.transaction_currency} por cobrar. Aplica hasta ese importe: lo demás sigue a favor del cliente.`,
          });
        }
        // Una retención no deja sobrante (se aplica entera a SU factura), y a un documento que ya
        // no debe nada no se le cobra: eso no es un pago de más, es un cobro equivocado.
        if (
          input.instrument === "retencion_iva" ||
          !saldoTxAntes.greaterThan(0) ||
          tasaDocHoy === null
        ) {
          return err({
            code: "VALIDATION_FAILED",
            message: `El abono supera lo pendiente: quedan ${saldoTxAntes.toDecimalPlaces(2, 4).toFixed(2)} ${doc.transaction_currency} por cobrar. Ajusta el importe.`,
          });
        }
        const deMas = saldadoTx
          .minus(saldoTxAntes)
          .toDecimalPlaces(minorUnitsOf(doc.transaction_currency), 4);
        sobrante = {
          importe: deMas,
          moneda: doc.transaction_currency,
          tasa: tasaDocHoy,
          funcional: deMas.times(tasaDocHoy).toDecimalPlaces(escalaFuncional, 4),
        };
        saldadoTx = saldoTxAntes;
      }
    }

    if (saldoTxAntes !== null && saldoTxAntes.minus(saldadoTx).lessThan("0.005")) {
      cierra = true;
      if (saldoTxAntes.greaterThan(0)) saldadoTx = saldoTxAntes;
    }

    /**
     * EL TOPE DEL DIFERENCIAL (ADR-0075, nota «el cobro y el cierre», regla 4). El cobro que
     * cierra lleva al diferencial (o a redondeo, la retención) lo que entró − lo que el mayor
     * todavía carga. Eso tiene que parecerse al diferencial ESPERADO —lo saldado × (tasa del
     * cobro − tasa del documento); cero en la retención, que abona a la tasa de la factura—
     * dentro del redondeo: por línea del documento, media unidad mínima de la divisa × tasa +
     * 0,01; más la media unidad con la que un cobro «cierra» sin llegar al céntimo, y un céntimo
     * por cada cobro (cada uno redondea lo que cancela). Fuera de esa cota NO se asienta: un
     * descuadre real entre el saldo del documento y su mayor no se esconde en «Ganancia en
     * diferencial cambiario» ni en «Diferencias por redondeo».
     */
    if (cierra && abiertoEnMayor !== null && tasaDocHoy !== null && tasaFactura.ok) {
      // Sin `ajustePasivo`: la cota mide el documento contra su mayor, no la historia del saldo
      // a favor con que se paga.
      const real = funcionalRedondeado.value.amount
        .minus(ajustePasivo)
        .minus(sobrante?.funcional ?? 0)
        .minus(abiertoEnMayor);
      const esperado = retencionATasaFactura
        ? decimalDe("0")
        : saldadoTx.times(tasaDocHoy.minus(tasaFactura.value));
      const tasaMayor = tasaDocHoy.greaterThan(tasaFactura.value) ? tasaDocHoy : tasaFactura.value;
      if (real.minus(esperado).abs().greaterThan(cota(tasaMayor))) {
        return err({
          code: "SETTLEMENT_MISMATCH",
          message:
            "Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.",
        });
      }
    }
  } else {
    // TOPE, documento en la moneda funcional: el saldo funcional contra el cobro funcional.
    // Punto 14: vale también para el saldo a favor (antes no tenía tope).
    /**
     * La tolerancia del tope es la del redondeo de caja: media unidad mínima de la moneda del
     * cobro, expresada en la moneda que decide. Con medio céntimo fijo, pagar en dólares lo
     * que el botón sugiere se leía como «cobro de más» por unos bolívares (ADR-0063 §2).
     */
    const pend = saldoAntes?.saldo === undefined ? null : parseDecimal(saldoAntes.saldo);
    const media = unidadMinima(input.currency).dividedBy(2);
    const enLaQueDecide =
      input.currency !== ctx.value.functionalCurrency ? media.times(tasaCobroDec.value) : media;
    const minimo = decimalDe("0.005");
    const holgura = enLaQueDecide.greaterThan(minimo) ? enLaQueDecide : minimo;
    if (pend?.ok && funcionalRedondeado.value.amount.minus(pend.value).greaterThan(holgura)) {
      if (input.instrument === "saldo_a_favor") {
        return err({
          code: "VALIDATION_FAILED",
          message: `El saldo a favor que se aplica supera lo pendiente: quedan ${pend.value.toDecimalPlaces(2, 4).toFixed(2)} ${ctx.value.functionalCurrency} por cobrar. Aplica hasta ese importe: lo demás sigue a favor del cliente.`,
        });
      }
      if (input.instrument === "retencion_iva" || !pend.value.greaterThan(0)) {
        return err({
          code: "VALIDATION_FAILED",
          message: `El abono supera lo pendiente: quedan ${pend.value.toDecimalPlaces(2, 4).toFixed(2)} ${ctx.value.functionalCurrency} por cobrar. Ajusta el importe.`,
        });
      }
      // F-10: el sobrante, en la moneda del documento (la funcional): tasa identidad.
      const deMas = funcionalRedondeado.value.amount
        .minus(pend.value)
        .toDecimalPlaces(escalaFuncional, 4);
      sobrante = {
        importe: deMas,
        moneda: ctx.value.functionalCurrency,
        tasa: decimalDe("1"),
        funcional: deMas,
      };
      saldadoTx = pend.value;
    }
  }

  // F-10 + IGTF: un pago de más en divisa que CAUSA IGTF no se registra como anticipo. Si el
  // anticipo causa el impuesto al recibirse o al aplicarse no está en docs/02_COMPLIANCE
  // (VALIDAR-TRIBUTARIO, PENDIENTES_ASESOR): hasta que el asesor lo diga, se cobra lo que falta y
  // se entrega el vuelto, como en la caja.
  if (sobrante !== null && input.currency !== ctx.value.functionalCurrency) {
    const reglaDelSobrante = await reglaIgtf(
      sql,
      input.company_id,
      input.instrument,
      input.currency,
      ctx.value.functionalCurrency,
      fecha,
    );
    if (!reglaDelSobrante.ok) return reglaDelSobrante;
    if (reglaDelSobrante.value !== null) {
      // El vuelto se entrega en la moneda en que se PAGÓ: el mensaje habla en esa moneda, no en
      // la del documento (una factura en Bs pagada de más con dólares no devuelve bolívares).
      const escalaPago = minorUnitsOf(input.currency);
      const sobraEnLaDelPago =
        sobrante.moneda === input.currency
          ? sobrante.importe
          : sobrante.funcional.dividedBy(tasaCobroDec.value).toDecimalPlaces(escalaPago, 4);
      return err({
        code: "VALIDATION_FAILED",
        message: `Lo recibido supera lo que falta y este pago causa IGTF: sobran ${sobraEnLaDelPago.toFixed(escalaPago)} ${input.currency}. Registra lo que queda y entrega el vuelto.`,
      });
    }
  }

  /**
   * F-12: lo que este cobro CANCELA de cuentas por cobrar, calculado ANTES de escribirlo (el cobro
   * no se actualiza después). Es la misma cifra que más abajo se asienta —`cancelado`— y se
   * comprueba contra ella: si las dos reglas se apartan, el cobro no se registra.
   */
  const aplicadoFuncional = funcionalRedondeado.value.amount.minus(sobrante?.funcional ?? 0);
  let canceladoPrevio = aplicadoFuncional;
  if (docEnDivisa) {
    const tasaEmisionPrevia = parseDecimal(doc.fx_rate);
    if (retencionATasaFactura || aLaTasaDelDoc) {
      if (cierra && abiertoEnMayor !== null) canceladoPrevio = abiertoEnMayor;
      // El ajuste del pasivo de un saldo a favor no cancela cuenta por cobrar: va a redondeo.
      else canceladoPrevio = aplicadoFuncional.minus(ajustePasivo);
    } else if (tasaEmisionPrevia.ok) {
      if (cierra && abiertoEnMayor !== null) {
        canceladoPrevio = abiertoEnMayor;
      } else if (input.currency === doc.transaction_currency) {
        const difPrevia = exchangeDifference({
          amountTransaction: importe.value,
          functionalCurrency: ctx.value.functionalCurrency,
          rateAtIssue: tasaEmisionPrevia.value,
          rateAtPayment: tasaCobroDec.value,
          policy: politicaDeValoracion(escalaFuncional),
        });
        if (!difPrevia.ok) {
          return err({ code: "VALIDATION_FAILED", message: difPrevia.error.message });
        }
        canceladoPrevio = aplicadoFuncional
          .minus(difPrevia.value.difference.amount)
          .minus(ajustePasivo);
      } else if (tasaDocDelDia !== null) {
        canceladoPrevio = aplicadoFuncional.minus(
          aplicadoFuncional
            .times(decimalDe("1").minus(tasaEmisionPrevia.value.dividedBy(tasaDocDelDia)))
            .toDecimalPlaces(escalaFuncional, 4),
        );
      }
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  if (input.instrument === "saldo_a_favor") {
    if (input.customer_credit_id === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Pagar con saldo a favor exige indicar cuál.",
      });
    }
    const [credito] = await sql<
      { amount: string; applied_amount: string; status: string; currency: string }[]
    >`select amount::text as amount, applied_amount::text as applied_amount, status, currency
        from public.customer_credits
       where id = ${input.customer_credit_id} and company_id = ${input.company_id}
         and customer_id = ${doc.customer_id} for update`;
    if (!credito) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    // Punto 1: solo se aplica un saldo DISPONIBLE. Uno retirado (`expired`: se reversó el cobro
    // que lo creó, el dinero salió y el contra-asiento deshizo el pasivo) ya no existe como
    // deuda con el cliente; aplicarlo era el primer paso para reembolsarlo en efectivo.
    if (credito.status === "expired") {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Ese saldo a favor se retiró al reversar el cobro que lo creó: ya no se aplica ni se reembolsa.",
      });
    }
    if (credito.status !== "available") {
      return err({
        code: "VALIDATION_FAILED",
        message: "Ese saldo a favor ya se usó entero: no queda nada que aplicar.",
      });
    }
    // Un saldo a favor se aplica EN SU MONEDA. Comparar 100 USD contra un
    // crédito de 100 Bs porque los dos «son 100» es exactamente el error que
    // esta comprobación existe para impedir.
    if (credito.currency !== input.currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El saldo a favor está en ${credito.currency} y el cobro se registró en ${input.currency}.`,
      });
    }
    const disponible = parseDecimal(credito.amount);
    const aplicado = parseDecimal(credito.applied_amount);
    const pedido = parseDecimal(input.amount);
    if (!disponible.ok || !aplicado.ok || !pedido.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    const resto = disponible.value.minus(aplicado.value);
    if (pedido.value.greaterThan(resto)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El saldo a favor disponible es ${resto.toFixed()} y se intentó aplicar ${pedido.value.toFixed()}.`,
      });
    }
    const nuevo = aplicado.value.plus(pedido.value);
    await sql`
      update public.customer_credits
         set applied_amount = ${nuevo.toFixed()},
             status = case when ${nuevo.equals(disponible.value)} then 'applied' else status end
       where id = ${input.customer_credit_id}`;
  }

  // El abono por RETENCIÓN SOPORTADA (migración 46): el comprobante que el
  // cliente-agente nos entregó abona la factura afectada sin mover efectivo.
  // Se aplica ENTERO y UNA sola vez: un comprobante no es un monedero.
  if (input.instrument === "retencion_iva") {
    if (input.supported_retention_id === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Abonar una retención de IVA exige indicar el comprobante.",
      });
    }
    const [comprobante] = await sql<
      { document_id: string; amount: string; functional_currency: string; status: string }[]
    >`select document_id, amount::text as amount, functional_currency, status
        from public.supported_retention_receipts
       where id = ${input.supported_retention_id} and company_id = ${input.company_id}
         for update`;
    if (!comprobante) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    if (comprobante.status !== "registered") {
      return err({
        code: "VALIDATION_FAILED",
        message: "El comprobante de retención está anulado y no abona nada.",
      });
    }
    if (comprobante.document_id !== input.document_id) {
      return err({
        code: "VALIDATION_FAILED",
        message: "El comprobante de retención afecta a OTRA factura: se abona la suya.",
      });
    }
    if (comprobante.functional_currency !== input.currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La retención vive en ${comprobante.functional_currency} y el abono se registró en ${input.currency}.`,
      });
    }
    const retenido = parseDecimal(comprobante.amount);
    const pedido = parseDecimal(input.amount);
    if (!retenido.ok || !pedido.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    if (!retenido.value.equals(pedido.value)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El comprobante retiene ${retenido.value.toFixed()} y se intentó abonar ${pedido.value.toFixed()}: una retención se aplica entera.`,
      });
    }
    const [usado] = await sql<{ id: string }[]>`
      select id from public.payments
       where company_id = ${input.company_id}
         and supported_retention_id = ${input.supported_retention_id} limit 1`;
    if (usado) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Ese comprobante de retención ya abonó su factura: no se aplica dos veces.",
      });
    }
  } else if (input.supported_retention_id !== undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El comprobante de retención solo acompaña al instrumento retencion_iva.",
    });
  }

  // La cuenta a la que ENTRA el efectivo (migración 29): la explícita si el
  // llamante la eligió, si no la forma de pago configurada → «Sin asignar».
  // Un saldo a favor o una retención no mueven efectivo y van sin cuenta,
  // que es lo que el CHECK de la tabla exige.
  let cuentaId: string | null;
  if (input.account_id !== undefined) {
    if (input.instrument === "saldo_a_favor" || input.instrument === "retencion_iva") {
      return err({
        code: "VALIDATION_FAILED",
        message: "Aplicar un abono sin efectivo no mete dinero en ninguna cuenta: quita la cuenta.",
      });
    }
    const [cuenta] = await sql<{ currency: string; name: string; is_active: boolean }[]>`
      select currency, name, is_active from public.company_accounts
       where id = ${input.account_id} and company_id = ${input.company_id}`;
    if (!cuenta) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
    if (!cuenta.is_active) {
      return err({
        code: "VALIDATION_FAILED",
        message: `La cuenta «${cuenta.name}» está desactivada.`,
      });
    }
    if (cuenta.currency !== input.currency) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El cobro es en ${input.currency} y la cuenta «${cuenta.name}» vive en ${cuenta.currency}.`,
      });
    }
    cuentaId = input.account_id;
  } else {
    cuentaId = await resolverCuentaEfectivo(
      sql,
      ctx.value.tenantId,
      input.company_id,
      input.instrument,
      input.currency,
    );
  }

  let pago;
  try {
    pago = await sql.savepoint(async (sp) => {
      const [p] = await sp<Record<string, unknown>[]>`
        insert into public.payments
          (tenant_id, company_id, document_id, paid_at, currency, amount, fx_rate, rate_source,
           rate_timestamp, functional_amount, instrument, reference, customer_credit_id,
           supported_retention_id, account_id, settled_transaction_amount,
           credited_functional_amount, cancelled_functional_amount, credit_functional_amount)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id}, ${fecha},
                ${input.currency}, ${input.amount}, ${tasaCobro}, ${fuenteCobro}, now(),
                ${funcionalRedondeado.value.toAmountString()}, ${input.instrument},
                ${input.reference ?? null}, ${input.customer_credit_id ?? null},
                ${input.supported_retention_id ?? null}, ${cuentaId}, ${saldadoTx.toFixed(8)},
                ${sobrante === null ? null : sobrante.funcional.toFixed(8)},
                ${canceladoPrevio.toFixed(8)},
                ${
                  // Lo que esta aplicación baja del pasivo: lo mismo que su asiento debita.
                  input.instrument === "saldo_a_favor"
                    ? (pasivoAplicado ?? funcionalRedondeado.value.amount).toFixed(8)
                    : null
                })
        returning id, document_id,
                  to_char(paid_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as paid_at,
                  currency, amount::text as amount, fx_rate::text as fx_rate, rate_source,
                  functional_amount::text as functional_amount, instrument, reference,
                  customer_credit_id, supported_retention_id`;
      return p!;
    });
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }

  // F-10: el sobrante nace como saldo a favor del cliente, con la moneda del documento, la tasa
  // de este cobro y su fuente. El único (source_payment_id) es su clave natural.
  let saldoAFavorNuevo: { id: string; amount: string; currency: string } | null = null;
  if (sobrante !== null) {
    let fuenteDelSobrante = "identidad";
    if (sobrante.moneda !== ctx.value.functionalCurrency) {
      const [f] = await sql<{ source: string | null }[]>`
        select f.source from platform.rate_for(${input.company_id}, ${sobrante.moneda},
                                               ${ctx.value.functionalCurrency},
                                               ${diaNegocio(fecha)}::date) f`;
      fuenteDelSobrante = f?.source ?? "manual";
    }
    const [nuevo] = await sql<{ id: string; amount: string; currency: string }[]>`
      insert into public.customer_credits
        (tenant_id, company_id, customer_id, source_document_id, source_payment_id, amount,
         currency, fx_rate, rate_source, functional_amount)
      values (${ctx.value.tenantId}, ${input.company_id}, ${doc.customer_id}, ${input.document_id},
              ${pago["id"] as string}, ${sobrante.importe.toFixed(8)}, ${sobrante.moneda},
              ${sobrante.tasa.toFixed(8)}, ${fuenteDelSobrante}, ${sobrante.funcional.toFixed(8)})
      returning id, amount::text as amount, currency`;
    saldoAFavorNuevo = nuevo!;
  }

  // El DIFERENCIAL, para TODO cobro de un documento emitido en otra moneda
  // (ADR-0047): la deuda está anclada en la moneda del documento, así que
  // cada cobro salda una porción EN ESA MONEDA y la diferencia entre lo que
  // esa porción valía al emitir y lo que entró hoy es ganancia o pérdida
  // cambiaria — venga el pago en dólares o en bolívares. Si no hay
  // diferencia, no se escribe una fila de cero: un hecho que no ocurrió no
  // se registra.
  let diferencial: Record<string, unknown> | null = null;
  // A la tasa del documento no hay diferencial que registrar (AF-M03): el residuo es redondeo.
  if (doc.transaction_currency !== doc.functional_currency && !aLaTasaDelDoc) {
    const tasaEmision = parseDecimal(doc.fx_rate);
    if (tasaEmision.ok && input.currency === doc.transaction_currency) {
      const dif = exchangeDifference({
        amountTransaction: importe.value,
        functionalCurrency: ctx.value.functionalCurrency,
        rateAtIssue: tasaEmision.value,
        rateAtPayment: tasaCobroDec.value,
        // El diferencial se reconoce a las unidades mínimas de la moneda de la empresa
        // (ADR-0063 §3): un resultado financiero de 0,00000302 no existe.
        policy: politicaDeValoracion(escalaFuncional),
      });
      if (!dif.ok) return err({ code: "VALIDATION_FAILED", message: dif.error.message });
      // F-15: el cobro que cierra cancela EXACTAMENTE lo que el mayor todavía carga.
      const difMismaMoneda =
        cierra && abiertoEnMayor !== null
          ? funcionalRedondeado.value.amount.minus(sobrante?.funcional ?? 0).minus(abiertoEnMayor)
          : // Con un saldo a favor en divisa, lo que su pasivo se aparta de importe × tasa va
            // con el diferencial (cero en cualquier otro cobro).
            dif.value.difference.amount.plus(ajustePasivo);
      if (!difMismaMoneda.isZero()) {
        const [eg] = await sql<Record<string, unknown>[]>`
          insert into public.exchange_gain_loss
            (tenant_id, company_id, document_id, payment_id, amount_transaction,
             transaction_currency, functional_at_issue, functional_at_payment, difference,
             fx_rate_issue, fx_rate_payment, occurred_on)
          values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id},
                  ${pago["id"] as string},
                  ${sobrante === null ? importe.value.toAmountString() : saldadoTx.toFixed(8)},
                  ${input.currency},
                  ${aplicadoFuncional.minus(difMismaMoneda).toFixed(8)},
                  ${aplicadoFuncional.toFixed(8)},
                  ${difMismaMoneda.toFixed(8)},
                  ${tasaEmision.value.toFixed()}, ${tasaCobroDec.value.toFixed()}, ${diaNegocio(fecha)}::date)
          returning id, document_id, payment_id, amount_transaction::text as amount_transaction,
                    transaction_currency, functional_at_issue::text as functional_at_issue,
                    functional_at_payment::text as functional_at_payment,
                    difference::text as difference, fx_rate_issue::text as fx_rate_issue,
                    fx_rate_payment::text as fx_rate_payment, occurred_on::text as occurred_on`;
        diferencial = eg!;
      }
    } else if (tasaEmision.ok && !retencionATasaFactura) {
      // El cobro vino en OTRA moneda (típicamente Bs contra deuda en USD): la
      // porción saldada se valora con la tasa doc→funcional del día del pago,
      // y el «funcional al pago» es lo que DE VERDAD entró — no un producto
      // recalculado, para que el asiento (caja = deuda saldada + diferencial)
      // cuadre al céntimo con lo cobrado.
      const [tasaDocHoy] = await sql<{ rate: string | null }[]>`
        select platform.rate_at(${input.company_id}, ${doc.transaction_currency},
                                          ${doc.functional_currency},
                                ${diaNegocio(fecha)}::date)::text as rate`;
      if (!tasaDocHoy?.rate) {
        return err({
          code: "EXCHANGE_RATE_MISSING",
          message: `No hay tasa de ${doc.transaction_currency} a ${doc.functional_currency} para valorar este cobro.`,
        });
      }
      const tasaDoc = parseDecimal(tasaDocHoy.rate);
      if (!tasaDoc.ok) {
        return err({ code: "VALIDATION_FAILED", message: "Tasa no interpretable." });
      }
      /**
       * EL DIFERENCIAL SIN POLVO (ADR-0063 §3). Antes se hacía el viaje de ida y vuelta
       * —funcional ÷ tasa × tasa, a ocho decimales— y con LA MISMA tasa salía «Ganancia
       * cambiaria 0,00000302» en cada venta (QA de pantalla 2026-09-15, h. 18 y 29). Ahora la
       * diferencia se calcula por PROPORCIÓN: lo que entró, por lo que la tasa se movió. Con
       * tasas iguales el factor es cero exacto, sin resta de dos redondeos.
       */
      const alPago = aplicadoFuncional;
      const factor = decimalDe("1").minus(tasaEmision.value.dividedBy(tasaDoc.value));
      // F-15: el cobro que cierra cancela EXACTAMENTE lo que el mayor todavía carga.
      const diferencia =
        cierra && abiertoEnMayor !== null
          ? alPago.minus(abiertoEnMayor)
          : alPago.times(factor).toDecimalPlaces(escalaFuncional, 4);
      const alEmitir = alPago.minus(diferencia);
      // Menos de una unidad mínima no es un hecho contable: es el redondeo de la caja.
      if (!diferencia.isZero()) {
        const [eg] = await sql<Record<string, unknown>[]>`
          insert into public.exchange_gain_loss
            (tenant_id, company_id, document_id, payment_id, amount_transaction,
             transaction_currency, functional_at_issue, functional_at_payment, difference,
             fx_rate_issue, fx_rate_payment, occurred_on)
          values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id},
                  ${pago["id"] as string}, ${saldadoTx.toFixed(8)}, ${doc.transaction_currency},
                  ${alEmitir.toFixed(8)}, ${alPago.toFixed(8)}, ${diferencia.toFixed(8)},
                  ${tasaEmision.value.toFixed()}, ${tasaDoc.value.toFixed()}, ${diaNegocio(fecha)}::date)
          returning id, document_id, payment_id, amount_transaction::text as amount_transaction,
                    transaction_currency, functional_at_issue::text as functional_at_issue,
                    functional_at_payment::text as functional_at_payment,
                    difference::text as difference, fx_rate_issue::text as fx_rate_issue,
                    fx_rate_payment::text as fx_rate_payment, occurred_on::text as occurred_on`;
        diferencial = eg!;
      }
    }
  }

  /**
   * G-05: el saldo a favor en divisa aplicado a un documento en moneda funcional. El documento
   * bajó por lo que el saldo a favor vale HOY (`aplicadoFuncional`) y el pasivo, por lo que
   * llevaba (`pasivoAplicado`): la diferencia es resultado cambiario y deja su fila, para que el
   * reporte de diferencial cuente lo mismo que el asiento. «Al emitir» es aquí lo cancelado al
   * documento y «al pago», lo que el pasivo llevaba; el signo es el de siempre (positivo =
   * ganancia): la base debe menos de lo que entregó.
   */
  if (pasivoAplicado !== null && tasaDeNacimiento !== null && diferencial === null) {
    const difPasivo = pasivoAplicado.minus(aplicadoFuncional);
    if (!difPasivo.isZero()) {
      const [eg] = await sql<Record<string, unknown>[]>`
        insert into public.exchange_gain_loss
          (tenant_id, company_id, document_id, payment_id, amount_transaction,
           transaction_currency, functional_at_issue, functional_at_payment, difference,
           fx_rate_issue, fx_rate_payment, occurred_on)
        values (${ctx.value.tenantId}, ${input.company_id}, ${input.document_id},
                ${pago["id"] as string}, ${importe.value.toAmountString()}, ${input.currency},
                ${aplicadoFuncional.toFixed(8)}, ${pasivoAplicado.toFixed(8)},
                ${difPasivo.toFixed(8)}, ${tasaCobroDec.value.toFixed()},
                ${tasaDeNacimiento.toFixed()}, ${diaNegocio(fecha)}::date)
        returning id, document_id, payment_id, amount_transaction::text as amount_transaction,
                  transaction_currency, functional_at_issue::text as functional_at_issue,
                  functional_at_payment::text as functional_at_payment,
                  difference::text as difference, fx_rate_issue::text as fx_rate_issue,
                  fx_rate_payment::text as fx_rate_payment, occurred_on::text as occurred_on`;
      diferencial = eg!;
    }
  }

  // Quién decide `paid` (ADR-0047): para un documento en divisa, el saldo EN
  // SU MONEDA — pagar los USD completos salda, suba o baje la tasa. Para el
  // resto, el funcional de siempre. El `balance` del contrato sigue siendo el
  // funcional, que es contra el que cuadra la contabilidad.
  const [saldoDespues] = await sql<{ saldo: string }[]>`
    select platform.document_balance(${input.company_id}, ${input.document_id})::text as saldo`;
  const saldoQueDecide =
    doc.transaction_currency === doc.functional_currency
      ? saldoDespues?.saldo
      : (
          await sql<{ saldo: string }[]>`
            select platform.document_balance_transaction(
                     ${input.company_id}, ${input.document_id})::text as saldo`
        )[0]?.saldo;
  const saldo = parseDecimal(saldoQueDecide ?? "0");
  let estado = doc.status;
  // LA REGLA DEL ÚLTIMO CENTAVO (2026-09-08, provisional — VALIDAR-TRIBUTARIO):
  // la deuda se ENSEÑA redondeada a 2 decimales, así que quien paga lo que la
  // pantalla pide pagó todo lo que se le pidió. Un residuo menor a MEDIO
  // CENTAVO (< 0.005) de la moneda que decide es impagable con dinero real y
  // no mantiene viva una factura. El residuo NO se borra de los libros: sigue
  // en el saldo de 8 decimales (que en pantalla redondea a 0.00) — castigar o
  // asignar ese residuo es política tributaria pendiente (R-02,
  // ResidualAllocation); esta regla decide SOLO el estado del documento.
  if (saldo.ok && saldo.value.lessThan("0.005")) {
    await sql`update public.documents set status = 'paid' where id = ${input.document_id}`;
    estado = "paid";
  }

  const [docActual] = await sql<DocumentResponse[]>`
    select ${sql.unsafe(DOC_COLUMNS)} from public.documents where id = ${input.document_id}`;
  // ADR-0051: aplicar un saldo a favor NO es un cobro de efectivo — su evento
  // es propio ('ar.credit_applied') y su plantilla baja el pasivo con el
  // cliente en vez de debitar caja. La retención soportada igual: su asiento
  // debita el IVA retenido por cobrar, no una caja (migración 46).
  const eventoCobro =
    input.instrument === "saldo_a_favor"
      ? "ar.credit_applied"
      : input.instrument === "retencion_iva"
        ? "ar.retention_applied"
        : "ar.payment_applied";
  await auditar(sql, ctx.value.tenantId, docActual!, eventoCobro, {
    payment_id: pago["id"] as string,
    amount: input.amount,
    currency: input.currency,
    instrument: input.instrument,
    balance_before: saldoAntes?.saldo ?? null,
    balance_after: saldoDespues?.saldo ?? null,
    exchange_difference: diferencial === null ? null : (diferencial["difference"] as string),
    ...(saldoAFavorNuevo === null
      ? {}
      : {
          credit_surplus: saldoAFavorNuevo.amount,
          credit_surplus_currency: saldoAFavorNuevo.currency,
          customer_credit_id: saldoAFavorNuevo.id,
        }),
  });

  /**
   * El asiento del cobro. Los tres importes que necesita la plantilla son
   * DISTINTOS y esa es toda la gracia:
   *   · lo que entra en caja, a la tasa DEL COBRO;
   *   · lo que deja de deberse, a la tasa DE LA EMISIÓN;
   *   · la diferencia, que es el diferencial cambiario y se reconoce aparte.
   * Cuando no hay diferencial —misma moneda, o la funcional— los dos primeros
   * coinciden y la tercera línea no se genera por su condición de signo.
   */
  const entrado = funcionalRedondeado.value.toAmountString();
  // F-01 + F-15: la retención soportada abona a la tasa de la factura, SIN diferencial. Si es el
  // abono que cierra, lo que cancela es lo que el mayor carga, y el céntimo que sobre o falte va a
  // «Diferencias por redondeo» (la plantilla ar.retention_applied lo lleva ahí): no es cambiario.
  const redondeoDeCierre =
    docEnDivisa && (retencionATasaFactura || aLaTasaDelDoc) && cierra && abiertoEnMayor !== null
      ? funcionalRedondeado.value.amount.minus(sobrante?.funcional ?? 0).minus(abiertoEnMayor)
      : null;
  // Un saldo a favor en divisa aplicado a la tasa del documento sin cerrarlo: lo que su pasivo
  // se aparta de importe × tasa (el redondeo del IVA de la nota que lo creó, E-05) va a
  // «Diferencias por redondeo», y la cuenta por cobrar baja a la tasa del documento.
  const ajusteARedondeo =
    redondeoDeCierre === null &&
    diferencial === null &&
    docEnDivisa &&
    aLaTasaDelDoc &&
    !ajustePasivo.isZero()
      ? ajustePasivo
      : null;
  const diferencia =
    redondeoDeCierre !== null
      ? redondeoDeCierre.toFixed(8)
      : ajusteARedondeo !== null
        ? ajusteARedondeo.toFixed(8)
        : diferencial === null
          ? "0"
          : (diferencial["difference"] as string);
  // Lo que deja de deberse = lo que entró − el diferencial. Se DERIVA en vez de leerse de la
  // fila: así el asiento cuadra por construcción aunque el cobro se haya ajustado al céntimo
  // (ADR-0063 §§2-3).
  const cancelado =
    redondeoDeCierre !== null && abiertoEnMayor !== null
      ? abiertoEnMayor.toFixed(8)
      : ajusteARedondeo !== null
        ? aplicadoFuncional.minus(ajusteARedondeo).toFixed(8)
        : diferencial === null
          ? aplicadoFuncional.toFixed(8)
          : (diferencial["functional_at_issue"] as string);
  // F-12: lo que el cobro guardó como cancelado es lo que se asienta. Si no, no se registra.
  if (!canceladoPrevio.equals(decimalDe(cancelado))) {
    return err({
      code: "SETTLEMENT_MISMATCH",
      message:
        "Este cobro no cuadra con lo que el documento todavía debe. No se registró: revisa el documento.",
    });
  }
  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "payment_received",
    sourceEvent: eventoCobro,
    sourceId: pago["id"] as string,
    postingDate: diaNegocio(fecha),
    postedBy: actor.userId,
    description: `Cobro de la factura ${serieYNumero(docActual!.series, docActual!.document_number ?? "")}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      // G-05: un saldo a favor en divisa aplicado a otra moneda baja el pasivo por lo que llevaba
      // (la tasa con que nació) y la diferencia con lo cancelado va al diferencial.
      functional_amount: pasivoAplicado === null ? entrado : pasivoAplicado.toFixed(8),
      total: cancelado,
      exchange_difference:
        pasivoAplicado === null ? diferencia : pasivoAplicado.minus(cancelado).toFixed(8),
      // F-10: lo que el cliente pagó de más, al pasivo «saldos a favor de clientes».
      ...(sobrante === null ? {} : { credit_surplus: sobrante.funcional.toFixed(8) }),
    },
    ...(aLaTasaDelDoc ? { differenceIsRounding: true } : {}),
    backlink: { table: "payments", id: pago["id"] as string },
  });
  if (!contable.ok) {
    return err({ code: "VALIDATION_FAILED", message: contable.error.message });
  }

  /**
   * LA PERCEPCIÓN DE IGTF (migración 46): 3 % sobre ESTE pago si la empresa
   * la activó (SPE con acta), el pago es en divisa y su instrumento causa.
   * POR PAGO a propósito (H-7): en un cobro mixto Bs + Zelle, solo la porción
   * en divisa causa — cada pago decide por separado. Las exenciones concretas
   * del decreto están VACÍAS en el catálogo y sin regla de exención SE
   * PERCIBE (H-8, conservador); cuando el asesor las cargue, se consultarán
   * aquí. La percepción es UNA por pago (unique) y nunca se resta sola: la
   * anulación la manda a `pendiente_reintegro`, no la borra.
   */
  let percepcion: Record<string, unknown> | null = null;
  let notaIgtf: RegisterPaymentResponse["igtf_debit_note"] = null;
  if (
    input.currency !== ctx.value.functionalCurrency &&
    input.instrument !== "saldo_a_favor" &&
    input.instrument !== "retencion_iva"
  ) {
    const reglaR = await reglaIgtf(
      sql,
      input.company_id,
      input.instrument,
      input.currency,
      ctx.value.functionalCurrency,
      fecha,
    );
    if (!reglaR.ok) return reglaR;
    const regla = reglaR.value;
    const gate =
      regla === null
        ? null
        : { rate: regla.tasaTexto, source: regla.fuente, absorbe: regla.absorbe };
    if (gate !== null) {
      const tasaIgtf = parseDecimal(gate.rate);
      if (!tasaIgtf.ok) {
        return err({ code: "VALIDATION_FAILED", message: "Tasa de IGTF no interpretable." });
      }
      // ADR-0053: se redondea a lo que la moneda sabe cobrar. El funcional se
      // calcula desde el importe YA redondeado —lo que entra en caja es lo que
      // se le cobró al cliente, no el exacto que nadie pagó.
      const percibido = percibirIgtf(importe.value.amount, tasaIgtf.value, input.currency);
      if (!percibido.ok) {
        return err({ code: "VALIDATION_FAILED", message: percibido.error.message });
      }
      const monto = percibido.value.monto;
      const enLibros = percibirIgtf(monto, tasaCobroDec.value, ctx.value.functionalCurrency);
      if (!enLibros.ok) {
        return err({ code: "VALIDATION_FAILED", message: enLibros.error.message });
      }
      const funcional = enLibros.value.monto;
      /**
       * E-03 (RESPUESTA §2.6): el cobro POSTERIOR a la factura (fiado o abono) documenta su IGTF
       * con una NOTA DE DÉBITO POR IGTF que referencia la factura — una línea, no sujeta, que
       * consume control como cualquier ND y va al libro con base 0 e IVA 0. El cobro de la
       * propia venta (`enEmision`) no: su IGTF se imprime en la factura. Lo absorbido tampoco: no
       * se le cobró al cliente (VALIDAR-TRIBUTARIO P-40).
       */
      const facturaDeLaNd =
        gate.absorbe || opciones.enEmision === true
          ? null
          : doc.kind === "invoice"
            ? doc.id
            : doc.kind === "debit_note"
              ? doc.source_document_id
              : null;
      let ndIgtf: DocumentResponse | null = null;
      if (facturaDeLaNd !== null) {
        const nd = await emitirNdIgtf(uow, ctx.value, {
          companyId: input.company_id,
          facturaId: facturaDeLaNd,
          customerId: doc.customer_id,
          priceListId: doc.price_list_id,
          fecha,
          montoFuncional: funcional,
          tasaIgtf: gate.rate,
          base: importe.value.amount,
          moneda: input.currency,
          montoDivisa: monto,
        });
        if (!nd.ok) return nd;
        ndIgtf = nd.value;
      }
      const [fila] = await sql<Record<string, unknown>[]>`
        insert into public.igtf_perceptions
          (tenant_id, company_id, payment_id, document_id, base_amount, currency, rate,
           amount, functional_amount, fx_rate, rate_source, rounding_policy_id, occurred_at,
           absorbed, debit_note_id)
        values (${ctx.value.tenantId}, ${input.company_id}, ${pago["id"] as string},
                ${input.document_id}, ${input.amount}, ${input.currency}, ${gate.rate},
                ${monto.toFixed(8)}, ${funcional.toFixed(8)}, ${tasaCobro}, ${fuenteCobro},
                ${enLibros.value.policy.id}, ${fecha}, ${gate.absorbe}, ${ndIgtf?.id ?? null})
        returning id, base_amount::text as base_amount, currency, rate::text as rate,
                  amount::text as amount, functional_amount::text as functional_amount,
                  absorbed`;
      percepcion = fila!;
      if (ndIgtf !== null) {
        // La ND la paga su percepción en el mismo acto (platform.document_balance la descuenta):
        // nace pagada, nunca como deuda del cliente por un dinero que ya entró.
        const [pagada] = await sql<DocumentResponse[]>`
          update public.documents set status = 'paid'
           where id = ${ndIgtf.id} and company_id = ${input.company_id}
          returning ${sql.unsafe(DOC_COLUMNS)}`;
        ndIgtf = pagada ?? ndIgtf;
        notaIgtf = {
          id: ndIgtf.id,
          series: ndIgtf.series,
          document_number: ndIgtf.document_number ?? null,
          control_display: ndIgtf.control_display ?? null,
        };
      }
      // Revisión 7: lo absorbido es otro hecho, con su nombre (EVENT_CATALOG): el audit dice el mismo
      // evento que la plantilla.
      await auditar(
        sql,
        ctx.value.tenantId,
        docActual!,
        gate.absorbe ? "igtf.perception_absorbed" : "igtf.perception_recorded",
        {
          perception_id: percepcion["id"] as string,
          payment_id: pago["id"] as string,
          base_amount: input.amount,
          currency: input.currency,
          rate: gate.rate,
          amount: monto.toFixed(8),
          functional_amount: funcional.toFixed(8),
          rounding_policy_id: enLibros.value.policy.id,
          legal_source: gate.source,
          absorbed: gate.absorbe,
          debit_note_id: ndIgtf?.id ?? null,
        },
      );
      // Su asiento propio: Dr caja (lo percibido ENTRA, además del cobro) /
      // Cr «IGTF percibido por enterar» — un pasivo con el fisco, no ingreso. Si la empresa lo
      // ABSORBE (F-05), no entra efectivo: Dr gasto / Cr IGTF por enterar. Con ND por IGTF, este
      // MISMO asiento es el de la ND (backlink): la ND se cobra en el acto, su CxC nace y muere
      // a la vez, y lo que queda es exactamente caja contra el pasivo con el fisco.
      const asientoIgtf = await generateJournalFromDocument(sql, {
        tenantId: ctx.value.tenantId,
        companyId: input.company_id,
        sourceKind: "igtf_perception",
        sourceEvent: gate.absorbe ? "igtf.perception_absorbed" : "igtf.perception_recorded",
        ...(ndIgtf === null ? {} : { backlink: { table: "documents", id: ndIgtf.id } }),
        sourceId: percepcion["id"] as string,
        postingDate: diaNegocio(fecha),
        postedBy: actor.userId,
        description: `IGTF percibido en el cobro de ${serieYNumero(docActual!.series, docActual!.document_number ?? "")}`,
        functionalCurrency: ctx.value.functionalCurrency,
        amounts: { functional_amount: funcional.toFixed(8) },
        // `igtf_perceptions` no lleva `journal_entry_id`: el vínculo va por
        // `journal_entries.source_id` = id de la percepción, que es el eje de la idempotencia
        // del generador. El único backlink es el de la ND por IGTF (arriba).
      });
      if (!asientoIgtf.ok) {
        return err({ code: "VALIDATION_FAILED", message: asientoIgtf.error.message });
      }
    }
  }

  return ok({
    payment: pago as never,
    exchange_difference: diferencial as never,
    balance: saldoDespues?.saldo ?? "0",
    document_status: estado as never,
    igtf: percepcion as never,
    igtf_debit_note: notaIgtf,
    customer_credit: saldoAFavorNuevo,
  });
}

/**
 * Devolución referida a su documento origen. Al confirmarla: reingreso al
 * inventario **al costo ORIGINAL** —el `cost_snapshot` de la línea de origen, no
 * el costo de hoy— y nota de crédito con saldo a favor.
 */
export async function createReturn(
  uow: UnitOfWork,
  input: CreateReturnRequest,
): Promise<Result<ReturnResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Devolver exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.return.manage", fecha);
  if (!ctx.ok) return ctx;

  const [origen] = await sql<
    {
      id: string;
      status: string;
      kind: string;
      customer_id: string;
      price_list_id: string | null;
    }[]
  >`select id, status, kind, customer_id, price_list_id from public.documents
     where id = ${input.source_document_id} and company_id = ${input.company_id}`;
  if (!origen) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  // ADR-0061 §5: un RECIBO también se devuelve (con recibo de devolución).
  if (
    !["invoice", "receipt"].includes(origen.kind) ||
    !["issued", "paid"].includes(origen.status)
  ) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo se devuelve contra una factura o un recibo emitidos.",
    });
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  const [dev] = await sql<{ id: string }[]>`
    insert into public.returns
      (tenant_id, company_id, source_document_id, warehouse_id, reason)
    values (${ctx.value.tenantId}, ${input.company_id}, ${input.source_document_id},
            ${input.warehouse_id}, ${input.reason})
    returning id`;

  const lineas: ReturnResponse["lines"] = [];
  for (const l of input.lines) {
    const [origenLinea] = await sql<
      {
        id: string;
        product_id: string;
        quantity: string;
        cost_snapshot: string | null;
        unit_price_transaction: string;
      }[]
    >`select id, product_id, quantity::text as quantity, cost_snapshot::text as cost_snapshot,
             unit_price_transaction::text as unit_price_transaction
        from public.document_lines
       where id = ${l.source_line_id} and document_id = ${input.source_document_id}`;
    if (!origenLinea) {
      return err({
        code: "VALIDATION_FAILED",
        message: "Una línea devuelta no pertenece al documento origen.",
      });
    }
    const pedida = parseDecimal(l.quantity);
    const vendida = parseDecimal(origenLinea.quantity);
    if (!pedida.ok || !vendida.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidad no interpretable." });
    }
    // EL TOPE ES ACUMULADO (ADR-0061 §4): lo ya devuelto en devoluciones
    // confirmadas cuenta. Antes se comparaba cada devolución sola, y dos
    // devoluciones podían devolver más de lo vendido.
    const [yaDevuelta] = await sql<{ q: string }[]>`
      select coalesce(sum(rl.quantity), 0)::text as q
        from public.return_lines rl
        join public.returns r on r.id = rl.return_id
       where rl.source_line_id = ${l.source_line_id} and r.status = 'confirmed'`;
    const devuelta = parseDecimal(yaDevuelta?.q ?? "0");
    if (!devuelta.ok) return err({ code: "VALIDATION_FAILED", message: devuelta.error.message });
    const disponible = vendida.value.minus(devuelta.value);
    if (pedida.value.greaterThan(disponible)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `No se puede devolver más de lo vendido: la línea tiene ${vendida.value.toFixed()} y ya se devolvieron ${devuelta.value.toFixed()}.`,
      });
    }
    // EL COSTO ORIGINAL, copiado. Si la línea no lo tenía (servicio, o venta sin
    // almacén), se devuelve a cero y se dice: inventar uno sería peor.
    const costo = origenLinea.cost_snapshot ?? "0";
    await sql`
      insert into public.return_lines
        (tenant_id, company_id, return_id, source_line_id, product_id, quantity,
         unit_cost_original, unit_price_transaction)
      values (${ctx.value.tenantId}, ${input.company_id}, ${dev!.id}, ${l.source_line_id},
              ${origenLinea.product_id}, ${l.quantity}, ${costo},
              ${origenLinea.unit_price_transaction})`;
    lineas.push({
      source_line_id: l.source_line_id,
      product_id: origenLinea.product_id,
      quantity: l.quantity,
      unit_cost_original: costo,
      unit_price_transaction: origenLinea.unit_price_transaction,
    });
  }

  return ok({
    id: dev!.id,
    source_document_id: input.source_document_id,
    credit_note_id: null,
    status: "draft",
    reason: input.reason,
    warehouse_id: input.warehouse_id,
    lines: lineas,
    customer_credit_id: null,
  });
}

/** El origen que una NOTA puede corregir: factura de la empresa, emitida o pagada. */
async function origenParaNota(
  sql: TransactionSql,
  companyId: string,
  sourceDocumentId: string,
): Promise<
  Result<{ customer_id: string; price_list_id: string | null; total_amount: string }, SalesError>
> {
  const [origen] = await sql<
    {
      customer_id: string;
      price_list_id: string | null;
      total_amount: string;
      kind: string;
      status: string;
    }[]
  >`
    select customer_id, price_list_id, total_amount::text as total_amount, kind, status
      from public.documents where id = ${sourceDocumentId} and company_id = ${companyId}
      for update`;
  // `for update` sobre el origen: dos notas simultáneas contra la misma
  // factura pasaban ambas el tope de dinero (auditoría 2026-09-11, M-16).
  if (!origen) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (origen.kind !== "invoice" || !["issued", "paid"].includes(origen.status)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una nota corrige una FACTURA emitida o pagada, nada más.",
    });
  }
  return ok(origen);
}

/**
 * NOTA DE CRÉDITO DIRECTA (ADR-0051): corrige la factura SIN devolución de
 * mercancía — descuento o corrección de precio. Las líneas son un subconjunto
 * de las del origen al precio DEL ORIGEN, y el kardex NO se toca (mercancía
 * que vuelve = devolución, otro caso de uso). Genera saldo a favor, igual que
 * la NC de devolución: una sola semántica de NC en todo el sistema.
 *
 * El tope es de DINERO, no de líneas: lo acreditado acumulado contra una
 * factura (todas sus NC, directas o por devolución) no puede exceder su
 * total. La referencia obligatoria al origen vive AQUÍ, en el dominio, como
 * la política de RIF (ADR-0050): un CHECK retroactivo no puede distinguir la
 * historia legítima.
 */
export async function createDirectCreditNote(
  uow: UnitOfWork,
  input: CreateDirectCreditNoteRequest,
): Promise<Result<DirectCreditNoteResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Emitir una nota exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  // G-07 (20261004160300): la nota DIRECTA —sin mercancía de vuelta— tiene su permiso. El cajero
  // inicia devoluciones (`sales.return.manage`), no acredita una factura sin que vuelva nada.
  const ctx = await autorizar(
    sql,
    actor.userId,
    input.company_id,
    "sales.credit_note.direct",
    fecha,
  );
  if (!ctx.ok) return ctx;

  const origen = await origenParaNota(sql, input.company_id, input.source_document_id);
  if (!origen.ok) return origen;

  // Las líneas del origen que se acreditan, al precio DEL ORIGEN.
  const lineas: {
    product_id: string;
    quantity: string;
    unit_price_transaction: string;
    source_line_id: string;
  }[] = [];
  for (const l of input.lines) {
    const [ol] = await sql<
      { product_id: string; quantity: string; unit_price_transaction: string }[]
    >`
      select product_id, quantity::text as quantity,
             unit_price_transaction::text as unit_price_transaction
        from public.document_lines
       where id = ${l.source_line_id} and document_id = ${input.source_document_id}`;
    if (!ol) {
      return err({ code: "VALIDATION_FAILED", message: "Una línea no es del documento origen." });
    }
    const pedida = parseDecimal(l.quantity);
    const vendida = parseDecimal(ol.quantity);
    if (!pedida.ok || !vendida.ok || pedida.value.greaterThan(vendida.value)) {
      return err({
        code: "VALIDATION_FAILED",
        message: "No se puede acreditar más cantidad de la facturada en esa línea.",
      });
    }
    lineas.push({
      product_id: ol.product_id,
      quantity: l.quantity,
      unit_price_transaction: ol.unit_price_transaction,
      source_line_id: l.source_line_id,
    });
  }

  let nc: Result<DocumentResponse, SalesError>;
  try {
    nc = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx.value, {
        companyId: input.company_id,
        customerId: origen.value.customer_id,
        priceListId: origen.value.price_list_id,
        sourceDocumentId: input.source_document_id,
        kind: "credit_note",
        lineas,
        fecha,
        notes: input.reason,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nc.ok) return nc;

  // El tope de dinero: lo acreditado acumulado (esta NC incluida) no excede
  // el total del origen. Se comprueba DESPUÉS de emitir y dentro de la misma
  // transacción: si excede, el err revierte todo (RollbackPorError).
  const [acreditado] = await sql<{ t: string }[]>`
    select coalesce(sum(total_amount), 0)::text as t
      from public.documents
     where company_id = ${input.company_id}
       and source_document_id = ${input.source_document_id}
       and kind = 'credit_note' and status in ('issued', 'paid')`;
  const suma = parseDecimal(acreditado!.t);
  const topeOrigen = parseDecimal(origen.value.total_amount);
  if (!suma.ok || !topeOrigen.ok || suma.value.greaterThan(topeOrigen.value)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Lo acreditado contra esa factura excedería su total. Revisa las notas anteriores.",
    });
  }

  const [credito] = await sql<{ id: string }[]>`
    insert into public.customer_credits
      (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate,
       rate_source, functional_amount)
    -- G-05 (ADR-0075 §4): en la moneda de la nota, con su tasa (la de la factura que corrige).
    select ${ctx.value.tenantId}, ${input.company_id}, ${origen.value.customer_id}, d.id,
           coalesce(d.amount_transaction_currency, d.total_amount), d.transaction_currency,
           d.fx_rate, d.rate_source, d.total_amount
      from public.documents d
     where d.id = ${nc.value.id} and d.company_id = ${input.company_id}
    returning id`;

  await auditar(sql, ctx.value.tenantId, nc.value, "fiscal.credit_note.issued", {
    reason: input.reason,
    customer_credit_id: credito!.id,
    direct: true,
  });

  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "sales_credit_note",
    sourceEvent: "fiscal.credit_note.issued",
    sourceId: nc.value.id,
    postingDate: diaNegocio(fecha),
    postedBy: actor.userId,
    description: `Nota de crédito ${serieYNumero(nc.value.series, nc.value.document_number ?? "")}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      subtotal: nc.value.subtotal_amount,
      tax_amount: nc.value.tax_amount,
      total: nc.value.total_amount,
    },
    backlink: { table: "documents", id: nc.value.id },
  });
  if (!contable.ok) {
    return err({ code: "VALIDATION_FAILED", message: contable.error.message });
  }

  return ok({ document: nc.value, customer_credit_id: credito!.id });
}

/**
 * NOTA DE DÉBITO (ADR-0051): el espejo de la factura — intereses de mora,
 * fletes, diferencias de precio. Líneas con precio EXPLÍCITO en la moneda del
 * origen; sin kardex; ES deuda (el aging y el saldo la ven desde la migración
 * 45). Permiso `sales.invoice.issue`: emitir deuda nueva es facturar.
 */
export async function createDebitNote(
  uow: UnitOfWork,
  input: CreateDebitNoteRequest,
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Emitir una nota exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.issue", fecha);
  if (!ctx.ok) return ctx;

  const origen = await origenParaNota(sql, input.company_id, input.source_document_id);
  if (!origen.ok) return origen;

  let nd: Result<DocumentResponse, SalesError>;
  try {
    nd = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx.value, {
        companyId: input.company_id,
        customerId: origen.value.customer_id,
        priceListId: origen.value.price_list_id,
        sourceDocumentId: input.source_document_id,
        kind: "debit_note",
        lineas: input.lines.map((l) => ({
          product_id: l.product_id,
          quantity: l.quantity,
          unit_price_transaction: l.unit_price,
          ...(l.source_line_id === undefined ? {} : { source_line_id: l.source_line_id }),
        })),
        fecha,
        notes: input.reason,
        rateBasis: input.basis === "new_concept" ? "own_day" : "origin",
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nd.ok) return nd;

  await auditar(sql, ctx.value.tenantId, nd.value, "fiscal.debit_note.issued", {
    reason: input.reason,
  });

  const contable = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId: input.company_id,
    sourceKind: "sales_debit_note",
    sourceEvent: "fiscal.debit_note.issued",
    sourceId: nd.value.id,
    postingDate: diaNegocio(fecha),
    postedBy: actor.userId,
    description: `Nota de débito ${serieYNumero(nd.value.series, nd.value.document_number ?? "")}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: {
      subtotal: nd.value.subtotal_amount,
      tax_amount: nd.value.tax_amount,
      total: nd.value.total_amount,
    },
    backlink: { table: "documents", id: nd.value.id },
  });
  if (!contable.ok) {
    return err({ code: "VALIDATION_FAILED", message: contable.error.message });
  }

  return ok(nd.value);
}

/**
 * Confirma la devolución: reingresa al COSTO ORIGINAL, emite la nota de crédito
 * y crea el saldo a favor. Los tres en la misma transacción — una devolución a
 * medias dejaría mercancía en el almacén sin nota de crédito, o al revés.
 */
/**
 * Cancela una devolución que quedó en BORRADOR (QA de pantalla 2026-09-15, h. 55): si la
 * confirmación falla (p. ej. falta el rango de notas de crédito), el borrador quedaba vivo sin
 * forma de retomarlo ni descartarlo. Un borrador no movió inventario, dinero ni asiento:
 * cancelarlo solo cambia su estado, y queda en la auditoría.
 */
export async function cancelReturn(
  uow: UnitOfWork,
  returnId: string,
  companyId: string,
): Promise<Result<{ id: string; status: string }, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Cancelar exige un usuario real." });
  }
  const ctx = await autorizar(
    sql,
    actor.userId,
    companyId,
    "sales.return.manage",
    new Date().toISOString(),
  );
  if (!ctx.ok) return ctx;
  const [dev] = await sql<{ id: string; status: string }[]>`
    select id, status from public.returns
     where id = ${returnId} and company_id = ${companyId}
     for update`;
  if (!dev) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (dev.status !== "draft") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Solo se cancela una devolución en borrador; esta ya está " +
        (dev.status === "confirmed" ? "confirmada." : "cancelada."),
    });
  }
  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;
  await sql`update public.returns set status = 'cancelled' where id = ${returnId} and company_id = ${companyId}`;
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${ctx.value.tenantId}, ${companyId}, 'return', ${returnId}, 'sales.return.cancelled',
            'user', now(), ${RULES_VERSION}, ${sql.json({ id: returnId })})`;
  return ok({ id: returnId, status: "cancelled" });
}

export async function confirmReturn(
  uow: UnitOfWork,
  returnId: string,
  companyId: string,
): Promise<Result<ReturnResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Confirmar exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, companyId, "sales.return.manage", fecha);
  if (!ctx.ok) return ctx;

  const [dev] = await sql<
    {
      id: string;
      status: string;
      source_document_id: string;
      warehouse_id: string;
      reason: string;
    }[]
  >`select id, status, source_document_id, warehouse_id, reason from public.returns
     where id = ${returnId} and company_id = ${companyId}`;
  if (!dev) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (dev.status !== "draft") {
    return err({ code: "VALIDATION_FAILED", message: "La devolución ya no está en borrador." });
  }

  // EL ORIGEN, BLOQUEADO Y VIVO (ola 5, tercera ronda). `createReturn` ya exige una venta emitida
  // al crear el borrador; entre el borrador y la confirmación la venta puede ANULARSE, y la
  // anulación repone todo lo que salió: confirmar después reingresaba otra vez (la mercancía
  // dentro dos veces). El `for update` es el mismo candado que toma `annulInvoice` sobre el mismo
  // documento, y es el primero que toman las dos: anular y confirmar a la vez se serializan, y la
  // segunda ve lo que hizo la primera.
  const [origen] = await sql<
    {
      customer_id: string;
      price_list_id: string | null;
      kind: string;
      series: string;
      status: string;
    }[]
  >`
    select customer_id, price_list_id, kind, series, status from public.documents
     where id = ${dev.source_document_id} and company_id = ${companyId}
     for update`;
  if (origen === undefined) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (origen.status === "annulled") {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Esa venta se anuló: la devolución ya no se puede confirmar. La mercancía ya volvió al anularla.",
    });
  }
  if (!["issued", "paid"].includes(origen.status)) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Solo se confirma una devolución contra una factura o un recibo emitidos.",
    });
  }
  const lineas = await sql<
    {
      source_line_id: string;
      product_id: string;
      quantity: string;
      unit_cost_original: string;
      unit_price_transaction: string;
    }[]
  >`select source_line_id, product_id, quantity::text as quantity,
           unit_cost_original::text as unit_cost_original,
           unit_price_transaction::text as unit_price_transaction
      from public.return_lines where return_id = ${returnId}`;

  // El tope acumulado, otra vez al confirmar: entre el borrador y la
  // confirmación pudo confirmarse otra devolución de la misma línea.
  for (const l of lineas) {
    const [tope] = await sql<{ vendida: string; devuelta: string }[]>`
      select dl.quantity::text as vendida,
             coalesce((select sum(rl.quantity) from public.return_lines rl
                        join public.returns r on r.id = rl.return_id
                       where rl.source_line_id = dl.id and r.status = 'confirmed'), 0)::text
               as devuelta
        from public.document_lines dl where dl.id = ${l.source_line_id}`;
    const vendida = parseDecimal(tope?.vendida ?? "0");
    const devuelta = parseDecimal(tope?.devuelta ?? "0");
    const pedida = parseDecimal(l.quantity);
    if (!vendida.ok || !devuelta.ok || !pedida.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Cantidades no interpretables." });
    }
    if (devuelta.value.plus(pedida.value).greaterThan(vendida.value)) {
      return err({
        code: "VALIDATION_FAILED",
        message: `No se puede devolver más de lo vendido: la línea tiene ${vendida.value.toFixed()} y ya se devolvieron ${devuelta.value.toFixed()}.`,
      });
    }
  }

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  // H2 (ADR-0071): el MISMO orden de bloqueo que la venta — talonario antes que existencias. La
  // venta toma el talonario y después descarga el kardex; si aquí se reingresara primero y se
  // pidiera el control después, una venta y una devolución simultáneas se esperarían en cruz.
  if (origen.kind !== "receipt" && ctx.value.numberingMode === "range") {
    await bloquearTalonario(sql, companyId, "credit_note", origen.series);
  }

  // 1. Reingreso al COSTO ORIGINAL. `receiveStock` recibe el costo TOTAL, así
  //    que se multiplica cantidad × costo unitario original — nunca el vigente.
  //    El asiento va UNA vez por devolución, con la suma (ADR-0060 §2).
  //    AL COSTO Y LOTE CON QUE SALIÓ (ADR-0061 §5): se reparte lo devuelto entre
  //    las salidas de la venta —lote por lote, a su valor—, descontando lo que
  //    devoluciones anteriores ya reingresaron. Antes se reingresaba al
  //    cost_snapshot de la línea (el último costo del lote nulo, no el que salió)
  //    y sin lote: un producto con lotes no se podía devolver.
  let reingresado = parseDecimal("0");
  for (const l of lineas) {
    // I-04: la línea de un COMPUESTO devuelve sus ingredientes, en proporción y al costo con que
    // salieron (`compuestos.ts`). `null` = no es de un compuesto: sigue el camino de siempre.
    const pedidaCompuesto = parseDecimal(l.quantity);
    if (!pedidaCompuesto.ok) {
      return err({ code: "VALIDATION_FAILED", message: pedidaCompuesto.error.message });
    }
    const deCompuesto = await reingresarCompuesto(uow, {
      tenantId: ctx.value.tenantId,
      companyId,
      functionalCurrency: ctx.value.functionalCurrency,
      returnId,
      sourceDocumentId: dev.source_document_id,
      sourceLineId: l.source_line_id,
      warehouseId: dev.warehouse_id,
      pedida: pedidaCompuesto.value,
    });
    if (!deCompuesto.ok) return err(deCompuesto.error);
    if (deCompuesto.value !== null) {
      if (reingresado.ok) {
        reingresado = { ok: true, value: reingresado.value.plus(deCompuesto.value) };
      }
      continue;
    }
    const tramos = await sql<
      {
        lot_id: string | null;
        salio: string;
        valor: string;
        volvio: string;
        valor_volvio: string;
      }[]
    >`
      with salidas as (
        select m.lot_id, sum(-m.quantity) as salio, sum(-m.functional_amount) as valor
          from public.inventory_moves m
         where m.company_id = ${companyId} and m.source_document_id = ${dev.source_document_id}
           and m.product_id = ${l.product_id} and m.kind = 'salida'
           -- I-04: lo que salió como ingrediente de un compuesto de la misma venta es de OTRA
           -- línea; no cuenta como salida de esta.
           and not exists (select 1 from public.sale_line_components c where c.move_id = m.id)
         group by m.lot_id
      ),
      vueltas as (
        select m.lot_id, sum(m.quantity) as volvio, sum(m.functional_amount) as valor_volvio
          from public.inventory_moves m
          join public.returns r on r.id = m.source_document_id
         where m.company_id = ${companyId} and r.source_document_id = ${dev.source_document_id}
           and r.status = 'confirmed' and m.product_id = ${l.product_id} and m.kind = 'entrada'
           and not exists (select 1 from public.sale_line_components c where c.move_id = m.id)
         group by m.lot_id
      )
      select s.lot_id, s.salio::text, s.valor::text,
             coalesce(v.volvio, 0)::text as volvio, coalesce(v.valor_volvio, 0)::text as valor_volvio
        from salidas s left join vueltas v on v.lot_id is not distinct from s.lot_id
        left join public.lots lo on lo.id = s.lot_id
       -- En el mismo orden en que salió (FEFO): primero el lote que vence antes.
       order by lo.expires_at nulls last, s.lot_id nulls first`;
    // Un servicio o un compuesto no salieron del kardex: no hay nada que reingresar.
    if (tramos.length === 0) continue;
    const pedida = parseDecimal(l.quantity);
    if (!pedida.ok) return err({ code: "VALIDATION_FAILED", message: pedida.error.message });
    let falta = pedida.value;
    for (const t of tramos) {
      if (falta.isZero()) break;
      const salio = parseDecimal(t.salio);
      const valor = parseDecimal(t.valor);
      const volvio = parseDecimal(t.volvio);
      const valorVolvio = parseDecimal(t.valor_volvio);
      if (!salio.ok || !valor.ok || !volvio.ok || !valorVolvio.ok) {
        return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
      }
      const queda = salio.value.minus(volvio.value);
      if (!queda.greaterThan(0)) continue;
      const toma = queda.lessThan(falta) ? queda : falta;
      // Si vuelve TODO lo que queda del tramo, el valor es exactamente el que
      // falta: así el tramo netea a cero sin un residuo de redondeo.
      const importe = toma.equals(queda)
        ? valor.value.minus(valorVolvio.value)
        : valor.value.times(toma).dividedBy(salio.value).toDecimalPlaces(8, 4);
      // El reingreso lo autoriza LA DEVOLUCIÓN (`sales.return.manage`), no `inventory.move`
      // (ADR-0068 §1).
      const mov = await receiveStockFor(
        uow,
        {
          company_id: companyId,
          warehouse_id: dev.warehouse_id,
          product_id: l.product_id,
          ...(t.lot_id === null ? {} : { lot_id: t.lot_id }),
          quantity: toma.toFixed(),
          amount: importe.toFixed(8),
          currency: ctx.value.functionalCurrency,
          sourceDocumentId: returnId,
          accounting: "document",
        },
        "sales.return.manage",
      );
      if (!mov.ok) {
        return err(
          mov.error.code === "PERMISSION_REQUIRED"
            ? { code: "PERMISSION_REQUIRED", message: mov.error.message }
            : { code: "VALIDATION_FAILED", message: mov.error.message },
        );
      }
      const v = parseDecimal(mov.value.functional_amount);
      if (reingresado.ok && v.ok)
        reingresado = { ok: true, value: reingresado.value.plus(v.value) };
      falta = falta.minus(toma);
    }
    if (!falta.isZero()) {
      return err({
        code: "VALIDATION_FAILED",
        message: "No se puede devolver más de lo que salió del inventario con esta venta.",
      });
    }
  }
  if (!reingresado.ok) {
    return err({ code: "VALIDATION_FAILED", message: reingresado.error.message });
  }
  if (!reingresado.value.isZero()) {
    const contableReingreso = await generateJournalFromDocument(sql, {
      tenantId: ctx.value.tenantId,
      companyId,
      sourceKind: "sales_return",
      sourceEvent: "stock.received",
      sourceId: returnId,
      postingDate: diaNegocio(new Date().toISOString()),
      postedBy: actor.userId,
      description: "Devolución de venta: la mercancía vuelve al inventario",
      functionalCurrency: ctx.value.functionalCurrency,
      amounts: { functional_amount: reingresado.value.toFixed(8) },
    });
    if (!contableReingreso.ok) {
      return err({ code: "VALIDATION_FAILED", message: contableReingreso.error.message });
    }
  }

  // 2. La nota de crédito, emitida como cualquier documento fiscal — y por eso
  //    exige SU PROPIO rango autorizado: una NC no se numera con los números de
  //    control de las facturas. Va en savepoint porque la numeración levanta
  //    excepciones de Postgres, y sin él la transacción quedaría condenada y el
  //    409 lo produciría la tabla de SQLSTATE con un mensaje genérico.
  let nc: Result<DocumentResponse, SalesError>;
  try {
    nc = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx.value, {
        companyId,
        customerId: origen.customer_id,
        priceListId: origen.price_list_id,
        sourceDocumentId: dev.source_document_id,
        // Un recibo se corrige con RECIBO DE DEVOLUCIÓN, no con nota de crédito:
        // la nota entraría al libro de ventas de una empresa que no factura.
        kind: origen.kind === "receipt" ? "receipt_return" : "credit_note",
        lineas,
        fecha,
        // El motivo de la devolución, guardado en la nota: el PDF lo imprime y el tope de la forma
        // libre lo cuenta (A-2) con el mismo texto.
        notes: dev.reason,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nc.ok) return nc;

  // 3. El saldo a favor.
  const [credito] = await sql<{ id: string }[]>`
    insert into public.customer_credits
      (tenant_id, company_id, customer_id, source_document_id, amount, currency, fx_rate,
       rate_source, functional_amount)
    -- G-05 (ADR-0075 §4): en la moneda de la nota, con su tasa (la del documento que corrige).
    select ${ctx.value.tenantId}, ${companyId}, ${origen.customer_id}, d.id,
           coalesce(d.amount_transaction_currency, d.total_amount), d.transaction_currency,
           d.fx_rate, d.rate_source, d.total_amount
      from public.documents d
     where d.id = ${nc.value.id} and d.company_id = ${companyId}
    returning id`;

  await sql`
    update public.returns set status = 'confirmed', confirmed_at = now(), credit_note_id = ${nc.value.id}
     where id = ${returnId}`;
  const esRecibo = nc.value.kind === "receipt_return";
  await auditar(
    sql,
    ctx.value.tenantId,
    nc.value,
    esRecibo ? "sales.receipt_return.issued" : "fiscal.credit_note.issued",
    { return_id: returnId, customer_credit_id: credito!.id },
  );

  // EL ASIENTO de la NC (cierre de R-20, ADR-0051): menos ingreso y menos IVA
  // débito, contra el saldo a favor del cliente. Sin plantilla, encola — la
  // devolución se confirma igual y el hueco queda a la vista en pendientes.
  const contableNc = await generateJournalFromDocument(sql, {
    tenantId: ctx.value.tenantId,
    companyId,
    sourceKind: esRecibo ? "sales_receipt_return" : "sales_credit_note",
    sourceEvent: esRecibo ? "sales.receipt_return.issued" : "fiscal.credit_note.issued",
    sourceId: nc.value.id,
    postingDate: diaNegocio(fecha),
    postedBy: actor.userId,
    description: `${esRecibo ? "Recibo de devolución" : "Nota de crédito"} ${serieYNumero(nc.value.series, nc.value.document_number ?? "")}`,
    functionalCurrency: ctx.value.functionalCurrency,
    amounts: esRecibo
      ? { subtotal: nc.value.subtotal_amount, total: nc.value.total_amount }
      : {
          subtotal: nc.value.subtotal_amount,
          tax_amount: nc.value.tax_amount,
          total: nc.value.total_amount,
        },
    backlink: { table: "documents", id: nc.value.id },
  });
  if (!contableNc.ok) {
    return err({ code: "VALIDATION_FAILED", message: contableNc.error.message });
  }

  /**
   * G-06 (RESPUESTA §2.6): la devolución NO toca el IGTF. El pago ocurrió y la percepción fue
   * debida: queda percibida y se entera. La NC no lo lleva (sus líneas son las de la factura) y
   * el saldo a favor —lo que se reembolsa— es el total de la NC, sin IGTF. La pantalla lo dice
   * con el texto de aquí. La restitución de un IGTF indebido con la venta viva NO existe todavía:
   * `annulInvoice` rechaza todo documento con cobros, así que su rama `pendiente_reintegro` no
   * se alcanza con IGTF percibido. Decidido por criterio: la restitución va a la ola 3, junto con
   * la reversa de cobros (R-61). VALIDAR-TRIBUTARIO P-31 (devolución total del mismo día) y P-67.
   */
  const [igtfDevuelta] = await sql<
    { amount: string | null; currency: string | null; functional_amount: string | null }[]
  >`
    select sum(amount)::text as amount, min(currency) as currency,
           sum(functional_amount)::text as functional_amount
      from public.igtf_perceptions
     where company_id = ${companyId} and document_id = ${dev.source_document_id}
       and status = 'percibido' and not absorbed`;
  let igtfNoDevuelto: ReturnResponse["igtf_not_refunded"] = null;
  if (igtfDevuelta?.amount != null && igtfDevuelta.currency != null) {
    const enDivisa = decimalDe(igtfDevuelta.amount);
    const escala = minorUnitsOf(igtfDevuelta.currency);
    const vestido = enDivisa.toDecimalPlaces(escala, 4).toFixed(escala).replace(".", ",");
    const simbolo = igtfDevuelta.currency === "USD" ? "$" : igtfDevuelta.currency;
    igtfNoDevuelto = {
      amount: enDivisa.toFixed(8),
      currency: igtfDevuelta.currency,
      functional_amount: decimalDe(igtfDevuelta.functional_amount ?? "0").toFixed(8),
      notice: `El IGTF de ${vestido} ${simbolo} ya fue enterado al SENIAT y no se devuelve.`,
    };
  }

  return ok({
    id: returnId,
    source_document_id: dev.source_document_id,
    credit_note_id: nc.value.id,
    status: "confirmed",
    reason: dev.reason,
    warehouse_id: dev.warehouse_id,
    lines: lineas.map((l) => ({
      source_line_id: l.source_line_id,
      product_id: l.product_id,
      quantity: l.quantity,
      unit_cost_original: l.unit_cost_original,
      unit_price_transaction: l.unit_price_transaction,
    })),
    customer_credit_id: credito!.id,
    igtf_not_refunded: igtfNoDevuelto,
  });
}

/** La nota de crédito: mismo camino fiscal que una factura, otro `kind`. */
/**
 * Re-revisión 2: un producto de SISTEMA (`system_code`) no entra en una factura ni en una nota
 * que alguien teclea. Solo la ND por IGTF lo usa, y la emite el sistema (`emitirNdIgtf`).
 */
async function rechazaProductoDeSistema(
  sql: TransactionSql,
  companyId: string,
  ids: readonly string[],
): Promise<Result<void, SalesError>> {
  const [p] = await sql<{ name: string }[]>`
    select name from public.products
     where company_id = ${companyId} and id = any(${ids as string[]}::uuid[])
       and system_code is not null
     limit 1`;
  if (p) {
    return err({
      code: "VALIDATION_FAILED",
      message: `«${p.name}» es un producto de sistema: solo lo usa la Nota de Débito por IGTF, que el sistema emite sola al cobrar. No se factura ni va en una nota.`,
    });
  }
  return ok(undefined);
}

/** «0.03000000» → «3»; «0.025» → «2,5»: el porcentaje de una tasa, para leerlo en un papel. */
function porcentajeDe(tasa: string): string {
  return decimalDe(tasa).times(100).toDecimalPlaces(4).toFixed().replace(".", ",");
}

/**
 * LA NOTA DE DÉBITO POR IGTF (E-03; RESPUESTA §2.6; PA SNAT/2022/000013 art. 6). El cobro
 * posterior a la factura (fiado o abono) en divisas a un SPE documenta su percepción con una ND
 * que referencia la factura: UNA línea «IGTF 3 % sobre pago en divisas» —el porcentaje sale de la
 * regla vigente, nunca de un literal—, no sujeta al IVA, en bolívares a la tasa del día del cobro.
 * Consume control como cualquier ND (forma libre o imprenta digital) y va al libro de ventas con
 * base 0 e IVA 0, en la columna de lo no sujeto.
 *
 * El producto de la línea es uno de SISTEMA por empresa (`system_code = 'igtf'`, inactivo): la línea de
 * un documento exige producto, y el IGTF no es nada que la empresa venda.
 *
 * Su asiento es el de la percepción (backlink, en registerPayment) y la paga su percepción
 * (`platform.document_balance`): nace pagada.
 */
async function emitirNdIgtf(
  uow: UnitOfWork,
  ctx: Contexto,
  d: {
    companyId: string;
    facturaId: string;
    customerId: string;
    priceListId: string | null;
    fecha: string;
    montoFuncional: Decimal;
    tasaIgtf: string;
    base: Decimal;
    moneda: string;
    montoDivisa: Decimal;
  },
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql } = uow;
  // El producto de SISTEMA, por su marca (`system_code`), nunca por el sku tecleable (revisión 4).
  // Lo siembran la migración 20261002100100 y createCompany; si faltara, se crea con un sku propio.
  await sembrarProductoIgtf(sql, ctx.tenantId, d.companyId);
  const [producto] = await sql<{ id: string }[]>`
    select id from public.products where company_id = ${d.companyId} and system_code = 'igtf'`;
  if (!producto)
    return err({ code: "NOT_FOUND", message: "Falta el producto de sistema del IGTF." });
  const pct = porcentajeDe(d.tasaIgtf);
  const escala = minorUnitsOf(d.moneda);
  const vestir = (x: Decimal, e: number) => x.toDecimalPlaces(e, 4).toFixed(e).replace(".", ",");
  const motivo =
    `IGTF ${pct} % percibido sobre el pago en divisas de ${d.moneda} ${vestir(d.base, escala)}: ` +
    `${d.moneda} ${vestir(d.montoDivisa, escala)} (LIGTF art. 4.6; PA SNAT/2022/000013 art. 6)`;
  let nd: Result<DocumentResponse, SalesError>;
  try {
    nd = await sql.savepoint((sp) =>
      createInvoiceLike({ ...uow, sql: sp }, ctx, {
        companyId: d.companyId,
        customerId: d.customerId,
        priceListId: d.priceListId,
        sourceDocumentId: d.facturaId,
        kind: "debit_note",
        lineas: [
          {
            product_id: producto.id,
            quantity: "1",
            unit_price_transaction: d.montoFuncional.toFixed(8),
            descripcion: `IGTF ${pct} % sobre pago en divisas`,
            noSujeta: true,
          },
        ],
        fecha: d.fecha,
        notes: motivo,
        rateBasis: "own_day",
        enFuncional: true,
        permiteProductoDeSistema: true,
      }),
    );
  } catch (e) {
    const conocido = traducir(e);
    if (conocido) return err(conocido);
    throw e;
  }
  if (!nd.ok) return nd;
  await auditar(sql, ctx.tenantId, nd.value, "fiscal.debit_note.issued", {
    reason: motivo,
    igtf: true,
  });
  return nd;
}

async function createInvoiceLike(
  uow: UnitOfWork,
  ctx: Contexto,
  d: {
    companyId: string;
    customerId: string;
    priceListId: string | null;
    sourceDocumentId: string;
    /** ADR-0051: el mismo camino emite la NC y la ND — cambia solo el kind. ADR-0061: y el recibo de devolución. */
    /**
     * `withdrawal_credit_note` (ADR-0082): la nota de crédito de una factura de retiro. Se emite
     * como una nota de crédito —mismo régimen, misma serie y talonario, mismo correlativo— y se
     * guarda con su kind propio, que ninguna lectura de venta ni de cartera enumera.
     */
    kind: "credit_note" | "debit_note" | "receipt_return" | "withdrawal_credit_note";
    /**
     * `source_line_id` (hallazgo 3): la línea de la factura que la nota acredita. Con ella, la NC
     * revierte el débito de ESA línea — su tasa, su categoría, su regla y su descripción
     * congeladas —, no la condición de hoy.
     */
    lineas: readonly {
      product_id: string;
      quantity: string;
      unit_price_transaction: string;
      source_line_id?: string;
      /** E-03: la ND por IGTF describe su línea con el dato de la regla, no con el producto. */
      descripcion?: string;
      /** E-03: la línea no sujeta al IVA (el IGTF), sin regla: base 0 e IVA 0 en el libro. */
      noSujeta?: boolean;
    }[];
    fecha: string;
    notes: string | null;
    /** E-03: la ND por IGTF va en la moneda funcional (Bs), sin tasa: su importe ya es Bs. */
    enFuncional?: boolean;
    /** Re-revisión 2: solo `emitirNdIgtf` usa el producto de sistema. */
    permiteProductoDeSistema?: boolean;
    /**
     * Hallazgo 13 (§2.7, G-11): 'origin' (por omisión) = la tasa de la factura que corrige;
     * 'own_day' = la tasa BCV del día de la nota, para una ND por un concepto nuevo.
     */
    rateBasis?: "origin" | "own_day";
  },
): Promise<Result<DocumentResponse, SalesError>> {
  const { sql } = uow;
  if (ctx.regimeVersionId === "") {
    return err({
      code: "FISCAL_NUMBERING_INVALID",
      message: "La empresa no tiene régimen fiscal vigente: no puede emitir la nota.",
      details: { reason: "regime_missing" },
    });
  }
  // M-12: un recibo se devuelve con recibo de devolución aunque la empresa ya facture (el régimen
  // de facturas no lo lista entre lo que VENDE). Que el origen sea un recibo lo decide quien llama
  // y lo defiende el esquema (LAD84 y el gate de emisión, migración 20261004110000).
  // La clase con la que NUMERA y con la que el régimen la permite.
  const clase = d.kind === "withdrawal_credit_note" ? "credit_note" : d.kind;
  if (d.kind !== "receipt_return" && !ctx.allowedKinds.includes(clase)) {
    return err({
      code: "REGIME_KIND_NOT_ALLOWED",
      message: "El régimen fiscal vigente no permite emitir esta nota.",
    });
  }
  if (d.permiteProductoDeSistema !== true) {
    const deSistema = await rechazaProductoDeSistema(
      sql,
      d.companyId,
      d.lineas.map((l) => l.product_id),
    );
    if (!deSistema.ok) return deSistema;
  }
  // A-03: la NC y la ND son documentos fiscales; el recibo de devolución no.
  if (d.kind !== "receipt_return") {
    const tipo = await exigeTipoParaFacturar(
      sql,
      uow.actor.kind === "user" ? uow.actor.userId : null,
      d.companyId,
      d.fecha,
    );
    if (!tipo.ok) return tipo;
  }
  // PA 00071 arts. 33 y 13.7: la nota sobre forma libre también cabe en una forma y lleva al
  // adquirente identificado (el de la factura que corrige).
  if (d.kind !== "receipt_return" && ctx.numberingMode === "range") {
    const forma = await exigeFormaLibre(sql, d.companyId, {
      clase: "nota",
      customerId: d.customerId,
      origenId: d.sourceDocumentId,
      filasLineas: await filasDeLineas(
        sql,
        d.companyId,
        d.lineas.map((l) => l.product_id),
      ),
      motivo: d.notes,
    });
    if (!forma.ok) return forma;
  }
  // La NOTA hereda la MONEDA Y LA TASA del documento origen, no las de hoy. Si
  // tomara la tasa de hoy, no corregiría la deuda que dice corregir:
  // quedaría un resto en bolívares que nadie debe y que nadie cobra.
  const [origen] = await sql<
    { transaction_currency: string; fx_rate: string; rate_source: string; series: string }[]
  >`
    select transaction_currency, fx_rate::text as fx_rate, rate_source, series
      from public.documents where id = ${d.sourceDocumentId}`;
  if (!origen) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const rateBasis = d.rateBasis ?? "origin";
  let tasaNota = origen.fx_rate;
  let fuenteNota = origen.rate_source;
  if (d.enFuncional === true) {
    origen.transaction_currency = ctx.functionalCurrency;
    tasaNota = "1";
    fuenteNota = "identidad";
  } else if (rateBasis === "own_day" && origen.transaction_currency !== ctx.functionalCurrency) {
    // Hallazgo 13: el concepto nuevo es un hecho de HOY; su tasa es la BCV de su día.
    const [hoy] = await sql<{ rate: string | null; source: string | null }[]>`
      select f.rate::text as rate, f.source
        from platform.rate_for(${d.companyId}, ${origen.transaction_currency},
                               ${ctx.functionalCurrency}, ${diaNegocio(d.fecha)}::date) f`;
    if (!hoy?.rate) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message: `No hay tasa de ${origen.transaction_currency} a ${ctx.functionalCurrency} vigente para esa fecha. Cárgala con su fuente antes de emitir.`,
      });
    }
    if (!hoy.source) {
      return err({
        code: "EXCHANGE_RATE_MISSING",
        message:
          "La tasa del día de la nota no dice de dónde salió: la nota de un concepto nuevo va a la tasa BCV de su día, con su fuente. Cárgala desde el BCV y vuelve a intentar.",
      });
    }
    tasaNota = hoy.rate;
    fuenteNota = hoy.source;
  }
  const tasaOrigen = parseDecimal(tasaNota);
  if (!tasaOrigen.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message: "La tasa del documento origen no es legible.",
    });
  }

  const calculadas: LineaCalculada[] = [];
  for (const l of d.lineas) {
    const cantidad = parseDecimal(l.quantity);
    const precio = Money.of(l.unit_price_transaction, origen.transaction_currency);
    if (!cantidad.ok || !precio.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    // La nota hereda el precio que le mandan (el del origen en la NC, el
    // explícito en la ND); el impuesto se recalcula con la regla vigente a SU
    // fecha, que es lo correcto: es un documento nuevo.
    const [producto] = await sql<{ name: string; tax_category_code: string }[]>`
      select name, tax_category_code from public.products where id = ${l.product_id}`;
    const [cliente] = await sql<{ taxpayer_type_code: string }[]>`
      select taxpayer_type_code from public.customers where id = ${d.customerId}`;
    // Hallazgo 3: la NC que acredita una línea de la factura revierte SU débito, con la tasa, la
    // categoría, la regla y la descripción congeladas en esa línea — no las de hoy. Si entre la
    // factura y la nota cambió la alícuota o la condición del bien, la nota sigue a la factura
    // (VALIDAR-TRIBUTARIO P-58).
    // B-5 (decidido por criterio): la ND que CORRIGE una línea de la factura también; la ND de un
    // concepto nuevo, o un ajuste global sin línea, va a la condición de hoy (P-58).
    const acreditaLinea =
      l.source_line_id !== undefined &&
      (clase === "credit_note" || (d.kind === "debit_note" && rateBasis === "origin"));
    const [deLaFactura] = acreditaLinea
      ? await sql<
          {
            description: string;
            tax_rule_id: string | null;
            tax_rate_snapshot: string | null;
            tax_category_snapshot: string | null;
            operation_type: string | null;
          }[]
        >`
            select description, tax_rule_id, tax_rate_snapshot::text as tax_rate_snapshot,
                   tax_category_snapshot, operation_type
              from public.document_lines
             where id = ${l.source_line_id!} and document_id = ${d.sourceDocumentId}`
      : [];
    if (acreditaLinea && deLaFactura === undefined) {
      return err({ code: "VALIDATION_FAILED", message: "Una línea no es del documento origen." });
    }
    const congelada =
      deLaFactura !== undefined &&
      deLaFactura.tax_rate_snapshot !== null &&
      deLaFactura.tax_category_snapshot !== null
        ? deLaFactura
        : null;
    let taxRuleId: string | null = null;
    let tasa = parseDecimal("0");
    // El recibo de devolución, como el recibo, no repercute impuesto: no se
    // busca regla (sin reglas cargadas sería un 409 que no le toca).
    if (congelada !== null) {
      taxRuleId = congelada.tax_rule_id;
      tasa = parseDecimal(congelada.tax_rate_snapshot!);
    } else if (l.noSujeta === true) {
      // El IGTF no es venta de bien ni servicio: no sujeto al IVA, sin regla que buscar.
      taxRuleId = null;
    } else if (d.kind !== "receipt_return") {
      try {
        const [regla] = await sql<{ tax_rule_id: string; rate: string }[]>`
          select tax_rule_id, rate::text as rate
            from platform.resolve_tax(${d.companyId}, ${diaNegocio(d.fecha)}::date,
                                      ${JURISDICTION}, ${TAX_CODE},
                                      ${cliente!.taxpayer_type_code}, ${producto!.tax_category_code})`;
        taxRuleId = regla!.tax_rule_id;
        tasa = parseDecimal(regla!.rate);
      } catch (e) {
        const conocido = traducir(e);
        if (conocido) return err(conocido);
        throw e;
      }
    }
    if (!tasa.ok) return err({ code: "VALIDATION_FAILED", message: tasa.error.message });
    const calc = calculateLine({
      quantity: cantidad.value,
      unitPrice: precio.value,
      taxRate: tasa.value,
      basePolicy: politicaDelDocumento(origen.transaction_currency),
      taxPolicy: politicaDelDocumento(origen.transaction_currency),
    });
    if (!calc.ok) return err({ code: "VALIDATION_FAILED", message: calc.error.message });
    calculadas.push({
      calc: calc.value,
      productId: l.product_id,
      description: l.descripcion ?? congelada?.description ?? producto!.name,
      priceListId: d.priceListId ?? "",
      unitPriceList: precio.value,
      taxRuleId,
      costSnapshot: null,
      taxCategory:
        l.noSujeta === true
          ? "no_sujeto"
          : (congelada?.tax_category_snapshot ?? producto!.tax_category_code),
      operationType:
        congelada !== null
          ? congelada.operation_type
          : d.kind === "receipt_return" || cliente!.taxpayer_type_code === "no_domiciliado"
            ? null
            : "interna",
      // Una NOTA no mueve mercancia (ADR-0051: la NC directa corrige precio,
      // no devuelve): este camino nunca genera kardex, ni antes ni ahora.
      esInventariable: false,
    });
  }

  // ADR-0071: la NC y la ND consumen el control del talonario, como la factura; su serie es la
  // del talonario (la de la factura que corrigen, si ese talonario tiene papel). El recibo de
  // devolución no tiene control y conserva su «D».
  const serieDada =
    d.kind !== "receipt_return" && ctx.numberingMode === "range"
      ? await serieDelTalonario(sql, d.companyId, clase, null, origen.series)
      : ok(d.kind === "receipt_return" ? "D" : "A");
  if (!serieDada.ok) return serieDada;
  const serie = serieDada.value;
  const creado = await insertarDocumento(sql, ctx, {
    companyId: d.companyId,
    kind: d.kind,
    series: serie,
    customerId: d.customerId,
    vendorId: null,
    branchId: null,
    priceListId: d.priceListId ?? "",
    sourceDocumentId: d.sourceDocumentId,
    lineas: calculadas,
    fxRate: tasaOrigen.value,
    rateSource: fuenteNota,
    transactionCurrency: origen.transaction_currency,
    notes: d.notes,
  });
  if (!creado.ok) return creado;

  const [num] = await sql<{ n: string }[]>`
    select platform.claim_document_number(${d.companyId}, ${clase}, ${serie})::text as n`;
  let control: string | null = null;
  let identificador: string | null = null;
  if (ctx.numberingMode === "range" && d.kind !== "receipt_return") {
    const [c] = await sql<{ n: string; i: string }[]>`
      select control_number::text as n, control_identifier as i
        from platform.claim_fiscal_control(${d.companyId}, ${clase}, ${serie})`;
    control = c!.n;
    identificador = c!.i;
  }
  const [emitida] = await sql<DocumentResponse[]>`
    update public.documents
       set status = 'issued', issued_at = ${d.fecha}, document_number = ${num!.n}::bigint,
           control_number = ${control}::bigint, control_identifier = ${identificador},
           rate_basis = ${d.kind === "receipt_return" ? null : rateBasis},
           regime_version_id = ${ctx.regimeVersionId},
           rules_version = ${RULES_VERSION}
     where id = ${creado.value.id}
    returning ${sql.unsafe(DOC_COLUMNS)}`;
  return ok(emitida!);
}

// ── EL PUNTO DE VENTA (Fase C) ──────────────────────────────────────────────

/** El cliente de mostrador de la empresa (migración 32), o el que vino. */
async function clienteEfectivo(
  sql: TransactionSql,
  companyId: string,
  customerId: string | undefined,
): Promise<Result<string, SalesError>> {
  if (customerId !== undefined) return ok(customerId);
  const [cf] = await sql<{ id: string }[]>`
    select id from public.customers where company_id = ${companyId} and is_system`;
  if (!cf) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Esta empresa no tiene su «Consumidor final» de sistema: créalo (o indica el cliente).",
    });
  }
  return ok(cf.id);
}

/**
 * COTIZA el carrito sin escribir nada: mismos precios, misma regla tributaria
 * y misma tasa que usaría la factura — es literalmente `calcularLineas`, el
 * corazón compartido de cotización, pedido y factura. La pantalla de Vender
 * pregunta con debounce; el cliente jamás suma dinero.
 */
/** Modo recibos: lo dice la definición única (migración 54), no una fórmula local. */
function esModoRecibos(ctx: Contexto): boolean {
  return ctx.salesMode === "recibos";
}

export async function quotePos(
  uow: UnitOfWork,
  input: PosQuoteRequest,
): Promise<Result<PosQuoteResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }
  const fecha = new Date().toISOString();
  const ctx = await autorizar(sql, actor.userId, input.company_id, "sales.invoice.issue", fecha);
  if (!ctx.ok) return ctx;

  const cliente = await clienteEfectivo(sql, input.company_id, input.customer_id);
  if (!cliente.ok) return cliente;
  const lista = await resolverLista(
    sql,
    actor.userId,
    input.company_id,
    cliente.value,
    input.price_list_id,
    "de_contado",
  );
  if (!lista.ok) return lista;

  const calculadas = await calcularLineas(sql, {
    companyId: input.company_id,
    customerId: cliente.value,
    priceListId: lista.value,
    warehouseId: null,
    lines: input.lines,
    fecha,
    functionalCurrency: ctx.value.functionalCurrency,
    // En modo recibos (migración 37) la cotización tampoco lleva IVA: el
    // total que enseña el carrito es el total que cobrará el recibo.
    conImpuesto: !esModoRecibos(ctx.value),
  });
  if (!calculadas.ok) return calculadas;
  const totales = calculateTotals(calculadas.value.lineas.map((l) => l.calc));
  if (!totales.ok) return err({ code: "VALIDATION_FAILED", message: totales.error.message });

  // ADR-0047: el carrito enseña LOS DOS LADOS y los dos los calcula el servidor. El funcional de
  // cada línea sale de `fiscalDeLinea`, LA MISMA función con la que `insertarDocumento` congela
  // el documento (ADR-0075 §1): la caja anuncia y cobra el total que la factura va a decir.
  const porLinea = calculadas.value.lineas.map((l) => {
    const fiscal = fiscalDeLinea(
      l.calc,
      calculadas.value.fxRate,
      calculadas.value.transactionCurrency,
      ctx.value.functionalCurrency,
    );
    return {
      linea: l,
      unitFunc: aFuncional(l.calc.unitPrice, calculadas.value.fxRate, ctx.value.functionalCurrency),
      subFunc: fiscal.sub,
      totFunc: fiscal.tot,
    };
  });
  const roto = porLinea.find((f) => !f.unitFunc.ok || !f.totFunc.ok);
  if (roto !== undefined) {
    if (!roto.unitFunc.ok) return roto.unitFunc;
    if (!roto.totFunc.ok) return roto.totFunc;
  }

  /**
   * UN SOLO TOTAL (ADR-0063 §1). El funcional del carrito se SUMA por renglón, con la misma
   * conversión que congelará `insertarDocumento` (PER_LINE, ADR-0058). Antes se convertía el
   * total una sola vez y la caja anunciaba Bs 5.558,56 mientras el recibo decía 5.558,57: dos
   * reglas de redondeo para el mismo importe (QA de pantalla 2026-09-15, h. 19 y 57).
   */
  const subLineas = porLinea.map((f) => f.subFunc);
  const rotoSub = subLineas.find((r) => !r.ok);
  if (rotoSub !== undefined && !rotoSub.ok) return rotoSub;
  const ceroFunc = parseDecimal("0");
  if (!ceroFunc.ok) return err({ code: "VALIDATION_FAILED", message: "imposible" });
  let sumaSub = ceroFunc.value;
  let sumaTot = ceroFunc.value;
  for (const r of subLineas) {
    if (!r.ok) return r;
    sumaSub = sumaSub.plus(r.value.amount);
  }
  for (const f of porLinea) {
    if (!f.totFunc.ok) return f.totFunc;
    sumaTot = sumaTot.plus(f.totFunc.value.amount);
  }
  const totalFuncional = Money.of(sumaTot.toFixed(), ctx.value.functionalCurrency);
  const subtotalFuncional = Money.of(sumaSub.toFixed(), ctx.value.functionalCurrency);
  if (!totalFuncional.ok) {
    return err({ code: "VALIDATION_FAILED", message: totalFuncional.error.message });
  }
  if (!subtotalFuncional.ok) {
    return err({ code: "VALIDATION_FAILED", message: subtotalFuncional.error.message });
  }
  const impuestoFuncional = sumaTot.minus(sumaSub);

  // ADR-0047: el carrito enseña también el ANCLA (USD) aunque la lista esté en
  // Bs; la factura, en cambio, habla en bolívares. Lo calcula el servidor con
  // la tasa del día de la empresa (ADR-0057) y a lo que el dólar sabe cobrar:
  // es presentación, no se persiste. Sin tasa: null, y la pantalla lo dice.
  const ANCLA = "USD";
  let anchorTotal: string | null = null;
  let anchorRate: string | null = null;
  if (calculadas.value.transactionCurrency === ANCLA) {
    anchorTotal = totales.value.total.toAmountString();
    anchorRate = calculadas.value.fxRate.toFixed(8);
  } else if (ctx.value.functionalCurrency === ANCLA) {
    anchorTotal = totalFuncional.value.toAmountString();
    anchorRate = "1.00000000";
  } else {
    const [t] = await sql<{ v: string | null; rate: string | null }[]>`
      select round(${totalFuncional.value.toAmountString()}::numeric / f.rate,
                   ${minorUnitsOf(ANCLA)})::numeric(24,8)::text as v,
             f.rate::text as rate
        from platform.rate_for(${input.company_id}, ${ANCLA}, ${ctx.value.functionalCurrency},
                               ${diaNegocio(fecha)}::date) f`;
    anchorTotal = t?.v ?? null;
    anchorRate = t?.rate ?? null;
  }
  // El mismo ancla por línea (presentación): funcional ÷ tasa, a lo que el
  // dólar sabe cobrar. Con la lista en USD, es el propio precio de lista.
  const tasaAncla = anchorRate === null ? null : parseDecimal(anchorRate);
  const enAncla = (m: Money, funcional: Money): string | null => {
    if (calculadas.value.transactionCurrency === ANCLA) return m.toAmountString();
    if (ctx.value.functionalCurrency === ANCLA) return funcional.toAmountString();
    if (tasaAncla === null || !tasaAncla.ok || tasaAncla.value.isZero()) return null;
    return funcional.amount
      .dividedBy(tasaAncla.value)
      .toDecimalPlaces(minorUnitsOf(ANCLA), 4)
      .toFixed(8);
  };

  // E-09 · EL FIADO, DICHO ANTES: lo que la caja necesita para ofrecer (o no) «Fiar» sin sumar
  // dinero. Solo con cliente identificado. La comparación la hace el servidor; el que DECIDE es
  // quickSale, con la venta emitida.
  let credit: PosQuoteResponse["credit"] = null;
  if (input.customer_id !== undefined) {
    const [permiso] = await sql<{ ok: boolean }[]>`
      select platform.ladino_user_has_permission(${actor.userId}, 'sales.credit',
                                                 ${input.company_id}) as ok`;
    const c = await creditoDelCliente(sql, input.company_id, cliente.value);
    if (c !== null) {
      const disponible = c.available === null ? null : parseDecimal(c.available);
      const total = anchorTotal === null ? null : parseDecimal(anchorTotal);
      credit = {
        permitted: permiso?.ok === true,
        limit_usd: usd(c.limit),
        debt_usd: c.debt === null ? null : usd(c.debt),
        available_usd: c.available === null ? null : usd(c.available),
        covers_total:
          disponible !== null &&
          disponible.ok &&
          total !== null &&
          total.ok &&
          total.value.lessThanOrEqualTo(disponible.value),
      };
    }
  }

  return ok({
    customer_id: cliente.value,
    price_list_id: lista.value,
    currency: calculadas.value.transactionCurrency,
    fx_rate: calculadas.value.fxRate.toFixed(8),
    rate_source: calculadas.value.rateSource,
    lines: porLinea.map(({ linea: l, unitFunc, totFunc }) => ({
      product_id: l.productId,
      description: l.description,
      quantity: l.calc.quantity.toFixed(),
      unit_price: l.calc.unitPrice.toAmountString(),
      subtotal: l.calc.subtotal.toAmountString(),
      tax_rate: l.calc.taxRate.toFixed(),
      tax_amount: l.calc.taxAmount.toAmountString(),
      total: l.calc.total.toAmountString(),
      functional_unit_price: unitFunc.ok ? unitFunc.value.toAmountString() : "0",
      functional_total: totFunc.ok ? totFunc.value.toAmountString() : "0",
      anchor_unit_price: unitFunc.ok ? enAncla(l.calc.unitPrice, unitFunc.value) : null,
      anchor_total: totFunc.ok ? enAncla(l.calc.total, totFunc.value) : null,
    })),
    subtotal: totales.value.subtotal.toAmountString(),
    tax_amount: totales.value.taxAmount.toAmountString(),
    total: totales.value.total.toAmountString(),
    functional_subtotal: subtotalFuncional.value.toAmountString(),
    functional_tax_amount: impuestoFuncional.toFixed(8),
    functional_total: totalFuncional.value.toAmountString(),
    functional_currency: ctx.value.functionalCurrency,
    anchor_currency: ANCLA,
    anchor_total: anchorTotal,
    anchor_rate: anchorRate,
    credit,
    // P-05: fiar por la caja exige el vencimiento; el primer día admitido es el de la venta.
    credit_due_date: credit === null ? null : { required: true, min: diaNegocio(fecha) },
  });
}

/**
 * La VENTA RÁPIDA: emite la factura (numeración, kardex, asiento — todo el
 * camino real de `createInvoice`) y registra los cobros, con el vuelto
 * calculado en el servidor. Una transacción: si el segundo cobro falla, no
 * queda ni factura ni primer cobro. La idempotencia viene del middleware: la
 * clave es el INTENTO de cobro (ADR-0076), así que el reintento de ese intento devuelve esta
 * misma respuesta; un cobro nuevo de una cuenta ya vendida lo para la cuenta (POS_CART_SOLD),
 * nunca una segunda factura.
 */
export async function quickSale(
  uow: UnitOfWork,
  input: QuickSaleRequest,
): Promise<Result<QuickSaleResponse, SalesError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({ code: "PERMISSION_REQUIRED", message: "Vender exige un usuario real." });
  }

  // LA CUENTA QUE SE CIERRA, PRIMERO Y BLOQUEADA (ADR-0076, M-01/M-02/E-08): antes de gastar
  // numeración. Vendida ⇒ 409 POS_CART_SOLD, venga con la llave que venga — un cobro nuevo de
  // la misma cuenta nunca es otra venta ni el replay de la vieja. Ajena ⇒ la cobra su autor o
  // quien tenga pos.carts.manage. Sin fila (la cuenta nunca llegó a la nube): la lápida se
  // escribe al final igual, para que una subida en vuelo no la cree después.
  //
  // PRIMERO SE AUTORIZA (vender), antes de bloquear nada: quien no puede vender no toma el
  // candado de una cuenta ajena. createInvoice lo vuelve a exigir; esto es el orden.
  const autorizado = await companyScope(sql, actor.userId, input.company_id, "sales.invoice.issue");
  if (!autorizado.ok) return autorizado;
  //
  // Y el candado de LA CUENTA, antes de leerla (y antes del de clase, el del talonario y el del
  // kardex): dos cobros simultáneos de una cuenta que nunca llegó a la nube no tienen fila que
  // bloquear con FOR UPDATE, y los dos la leían vacía. Con el advisory, el segundo espera al
  // primero y lee la lápida.
  let autorCuenta: string | null = actor.userId;
  if (input.cart_id !== undefined) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${"pos_cart:" + input.cart_id}, 0))`;
    const [cuenta] = await sql<
      {
        company_id: string;
        created_by: string | null;
        sold_at: string | null;
        sale_id: string | null;
      }[]
    >`
      select company_id, created_by, sold_at, sale_id from public.pos_carts
       where id = ${input.cart_id} for update`;
    if (cuenta && cuenta.company_id !== input.company_id) {
      return err({ code: "VALIDATION_FAILED", message: "Esa cuenta no es de esta empresa." });
    }
    if (cuenta && cuenta.sold_at !== null) {
      return err(await cuentaVendida(sql, input.company_id, cuenta.sale_id));
    }
    if (
      cuenta &&
      cuenta.created_by !== actor.userId &&
      !(await puedeCuentasAjenas(sql, actor.userId, input.company_id))
    ) {
      return err(cuentaAjena());
    }
    if (cuenta) autorCuenta = cuenta.created_by;
  }

  const cliente = await clienteEfectivo(sql, input.company_id, input.customer_id);
  if (!cliente.ok) return cliente;

  // E-09 · EL CANDADO DEL FIADO, antes de emitir y siempre en este orden (cuenta → cliente →
  // talonario → kardex): dos ventas simultáneas al mismo cliente se ponen en fila, y la segunda
  // lee la deuda que dejó la primera. Sin él, dos fiados que por separado caben podrían pasar
  // juntos el límite. Se toma en toda venta a un cliente identificado: que quede fiada o no solo
  // se sabe después de los cobros.
  if (input.customer_id !== undefined) {
    await sql`select pg_advisory_xact_lock(hashtextextended(${candadoDeFiado(cliente.value)}, 0))`;
  }

  // El interruptor del dueño (migración 33): con las ventas sin identificar
  // apagadas, el «Consumidor final» de sistema no puede recibir una venta de
  // mostrador. La UI esconde el enlace; ESTA comprobación es la que vale —
  // la app móvil no es una vía para saltarse los controles del backend.
  const [mostrador] = await sql<{ is_system: boolean; permitido: boolean }[]>`
    select cu.is_system,
           coalesce((select cs.allow_unidentified_sales from public.company_settings cs
                      where cs.company_id = ${input.company_id}), true) as permitido
      from public.customers cu
     where cu.id = ${cliente.value} and cu.company_id = ${input.company_id}`;
  if (mostrador?.is_system && !mostrador.permitido) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Este negocio exige identificar al cliente: pide la cédula o el RIF antes de cobrar " +
        "(ajuste «Permitir ventas sin identificar», apagado por el dueño).",
    });
  }

  // EL KIND LO DECIDE EL RÉGIMEN, no la pantalla (migración 37): en modo
  // recibos la misma venta del POS emite un recibo; con datos fiscales, una
  // factura. El gate de kind del trigger y de emitirVenta respalda esto.
  // El modo con la definición única (migración 54) y con EL MISMO RELOJ que usa
  // la emisión (el de Node): antes se leía con el now() de Postgres y en el
  // instante de un cambio de régimen los dos relojes podían discrepar.
  const modoRecibos =
    (await modoDeVenta(sql, input.company_id, new Date().toISOString())) === "recibos";

  const emitida = await (modoRecibos ? createReceipt : createInvoice)(
    uow,
    {
      company_id: input.company_id,
      customer_id: cliente.value,
      warehouse_id: input.warehouse_id,
      branch_id: input.branch_id ?? null,
      // O-02 (ADR-0076): el vendedor de la venta del POS es QUIEN COBRA. Quién armó la cuenta
      // queda en la cuenta vendida (`pos_carts.created_by` + `sale_id`) y en el acta.
      vendor_id: actor.userId,
      lines: input.lines,
      ...(input.series === undefined ? {} : { series: input.series }),
      ...(input.price_list_id === undefined ? {} : { price_list_id: input.price_list_id }),
      // P-05: el vencimiento viaja con la emisión y queda congelado en el documento. Si la venta
      // termina pagada no significa nada; si deja saldo y no vino, se rechaza más abajo.
      ...(input.due_date === undefined ? {} : { due_date: input.due_date }),
    },
    "de_contado",
  );
  if (!emitida.ok) return emitida;
  let documento = emitida.value;

  const cobros: RegisterPaymentResponse[] = [];
  let vuelto: { amount: string; currency: string } | null = null;
  let balance = documento.total_amount;
  let estado = documento.status;

  for (const p of input.payments ?? []) {
    // Lo PENDIENTE, en moneda funcional (document_balance) y convertido a la
    // moneda del pago con la tasa de HOY: es la misma conversión que hará
    // registerPayment, hecha antes para decidir cuánto aplicar.
    const [pend] = await sql<{ saldo: string }[]>`
      select platform.document_balance(${input.company_id}, ${documento.id})::text as saldo`;
    const pendiente = parseDecimal(pend?.saldo ?? "0");
    const entregado = parseDecimal(p.amount);
    if (!pendiente.ok || !entregado.ok) {
      return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
    }
    if (pendiente.value.lessThanOrEqualTo(0)) {
      return err({
        code: "VALIDATION_FAILED",
        message: "La venta ya quedó pagada con el cobro anterior: sobra una forma de pago.",
      });
    }

    // EL MISMO cálculo que la vista previa (ADR-0059): IGTF dentro de lo
    // entregado, tolerancia de una unidad mínima, vuelto hacia abajo.
    const condicion = await condicionDePago(
      sql,
      input.company_id,
      p.instrument,
      p.currency,
      documento.functional_currency,
      new Date().toISOString(),
    );
    if (!condicion.ok) return condicion;
    const paso = pasoDeCobro({
      pendienteFuncional: pendiente.value,
      entregado: entregado.value,
      moneda: p.currency,
      monedaFuncional: documento.functional_currency,
      instrumento: p.instrument,
      cond: condicion.value,
    });
    if (!paso.ok) return paso;
    if (!paso.value.vuelto.isZero()) {
      // El residuo (< 1 unidad mínima) queda en caja: MONEY_AND_ROUNDING_SPEC
      // §6.4, pendiente de su asiento propio (VALIDAR-CONTABLE, ADR-0058).
      vuelto = { amount: paso.value.vuelto.toFixed(8), currency: p.currency };
    }

    const cobrado = await registerPayment(
      uow,
      {
        company_id: input.company_id,
        document_id: documento.id,
        currency: p.currency,
        amount: paso.value.aplicado.toFixed(8),
        instrument: p.instrument,
        // La caja ya repartió lo entregado (pasoDeCobro): esto es lo que ABONA.
        igtf_included: false,
        ...(p.reference === undefined ? {} : { reference: p.reference }),
        ...(p.account_id === undefined ? {} : { account_id: p.account_id }),
      },
      "sales.payment.register",
      // E-03: el cobro de la propia venta — su IGTF va impreso en la factura, no en una ND.
      { enEmision: true },
    );
    if (!cobrado.ok) return cobrado;
    cobros.push(cobrado.value);
    balance = cobrado.value.balance;
    estado = cobrado.value.document_status;
  }

  // FIAR (la venta no quedó pagada): LA puerta única del fiado, con la venta ya emitida y sus
  // cobros aplicados. Cubre al «Consumidor final» (no se le fía), el bloqueo de cobranzas, el
  // permiso `sales.credit` y el límite del cliente, también en el pago parcial que se queda
  // corto. La caja lo dice antes (`quotePos.credit`); ESTA comprobación es la que vale.
  if (estado !== "paid") {
    const fiado = await exigirFiado(sql, actor.userId, input.company_id, cliente.value);
    if (!fiado.ok) return fiado;
    // P-05 · UNA VENTA FIADA POR LA CAJA DICE CUÁNDO SE PAGA. Después de la puerta del fiado:
    // a quien no se le puede fiar se le dice eso, no que falta una fecha. Con el err,
    // `withTransaction` deshace la venta entera — ni documento, ni número, ni kardex.
    if (input.due_date === undefined) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "Di cuándo paga el cliente: una venta fiada lleva su fecha de vencimiento. " +
          "Elige la fecha en «¿Cuándo paga?» o cobra la venta completa.",
        details: { reason: "due_date_required" },
      });
    }
  }

  if (cobros.length > 0) {
    const [doc] = await sql<DocumentResponse[]>`
      select ${sql.unsafe(DOC_COLUMNS)} from public.documents
       where id = ${documento.id} and company_id = ${input.company_id}`;
    documento = doc ?? documento;
  }

  // La cuenta abierta que esta venta cierra: se MARCA vendida aquí, en la misma transacción
  // (ADR-0076) — si la venta no commitea, la cuenta sigue abierta. Antes se borraba, y la
  // subida diferida que ya estaba en vuelo la volvía a crear con lo vendido (M-01). Si la
  // cuenta nunca llegó a la nube, nace ya vendida: la lápida es la que cierra la puerta.
  if (input.cart_id !== undefined) {
    const marcada = await sql`
      insert into public.pos_carts as pc
        (id, tenant_id, company_id, label, lines, updated_at, updated_by, sold_at, sale_id)
      select ${input.cart_id}, c.tenant_id, c.id, 'Cuenta cobrada', '[]'::jsonb,
             clock_timestamp(), ${actor.userId}, clock_timestamp(), ${documento.id}
        from public.companies c where c.id = ${input.company_id}
      on conflict (id) do update
        set sold_at = excluded.sold_at, sale_id = excluded.sale_id,
            updated_at = excluded.updated_at, updated_by = excluded.updated_by
        where pc.company_id = excluded.company_id and pc.sold_at is null
      returning pc.id`;
    if (marcada.length === 0) {
      // Con el candado de arriba no debería pasar. Si pasa, la fila ya existía y no se dejó
      // marcar: se relee y se responde con el `err` del dominio. `withTransaction` REVIERTE ante
      // cualquier `err` (packages/db/src/transaction.ts): la factura recién emitida y su número
      // se van con el rollback, y la respuesta lleva en `details` la venta que SÍ cerró la cuenta.
      const [ahora] = await sql<{ company_id: string; sale_id: string | null }[]>`
        select company_id, sale_id from public.pos_carts where id = ${input.cart_id}`;
      if (ahora && ahora.company_id !== input.company_id) {
        return err({ code: "VALIDATION_FAILED", message: "Esa cuenta no es de esta empresa." });
      }
      return err(await cuentaVendida(sql, input.company_id, ahora?.sale_id ?? null));
    }
    // El acta de la cuenta: quién la armó, quién cobró, con qué edición y en qué intento.
    await sql`
      insert into public.audit_events
        (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
         actor_type, occurred_at, rules_version, payload)
      select c.tenant_id, c.id, 'document', ${documento.id}, 'pos.cart.sold',
             'user', now(), ${RULES_VERSION},
             ${sql.json({
               cart_id: input.cart_id,
               cart_author_id: autorCuenta,
               cashier_id: actor.userId,
               cart_version: input.cart_version ?? null,
               attempt_id: input.attempt_id ?? null,
             })}
        from public.companies c where c.id = ${input.company_id}`;
  }

  // El IGTF total de la venta, en funcional: la suma de lo que causó cada
  // pago (el cálculo vive en registerPayment; aquí solo se agrega).
  let igtfTotal: Decimal | null = null;
  for (const c of cobros) {
    // F-05: lo absorbido no se le cobró al cliente — no es parte de «lo que pagó con IGTF».
    if (c.igtf === null || c.igtf.absorbed) continue;
    const f = parseDecimal(c.igtf.functional_amount);
    if (!f.ok) return err({ code: "VALIDATION_FAILED", message: "IGTF no interpretable." });
    igtfTotal = igtfTotal === null ? f.value : igtfTotal.plus(f.value);
  }

  return ok({
    document: documento,
    payments: cobros,
    change: vuelto,
    balance,
    document_status: estado,
    igtf:
      igtfTotal === null
        ? null
        : { functional_amount: igtfTotal.toFixed(8), currency: documento.functional_currency },
  });
}
