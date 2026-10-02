import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, JSONValue } from "@ladino/db";
import type {
  GenerateIvaPeriodRequest,
  IvaPeriodResultResponse,
  LoadFiscalDeadlinesRequest,
  FiscalDeadlineResponse,
  RegisterSupportedRetentionRequest,
  RegisterSupportedRetentionResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { registerPayment, type SalesError } from "./sales.js";
import { parseDecimal, type Decimal } from "@ladino/money";

/**
 * DECLARACIONES DE IVA (migración 46) — RIGOR MÁXIMO.
 *
 * Tres casos de uso:
 *   · registrar una retención SOPORTADA (el comprobante que un cliente-agente
 *     nos entregó) y abonar la factura afectada en el MISMO acto;
 *   · generar el RESULTADO de un período con su arrastre ENCADENADO — el
 *     excedente anterior sale de la última generación del período contiguo,
 *     nunca de un número tecleado (por eso los períodos en cero también se
 *     generan: mantienen viva la cadena);
 *   · cargar el CALENDARIO de vencimientos como dato con fuente citada (H-4:
 *     las fechas por dígito de RIF no se inventan).
 *
 * Nada de lo que este módulo produce es una declaración oficial: la fila del
 * período es la planilla DEMOSTRATIVA, reproducible por su hash, con la que
 * el contribuyente (o su contador) llena el portal del SENIAT a mano.
 */
export type DeclarationsError =
  | CompanyScopeError
  | SalesError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string };

/** La versión del generador, persistida en cada fila del período. */
export const IVA_PERIOD_GENERATOR_VERSION = "iva-declarations/1.1.0";

/**
 * La versión que MEZCLABA los dos arrastres (L-05): su `excedente_siguiente` puede llevar
 * retenciones no absorbidas sumadas al crédito fiscal. Una fila suya con excedente no se encadena:
 * hay que regenerar ese período con la versión actual.
 */
const GENERADOR_ARRASTRE_MEZCLADO = "iva-declarations/1.0.0";

const MESES = [
  "enero",
  "febrero",
  "marzo",
  "abril",
  "mayo",
  "junio",
  "julio",
  "agosto",
  "septiembre",
  "octubre",
  "noviembre",
  "diciembre",
];
/** `AAAA-MM-DD` → `DD-MM-AAAA`, para los mensajes de persona. Solo formato, sin aritmética. */
const dmy = (f: string): string => f.split("-").reverse().join("-");
const nombreMes = (f: string): string =>
  `${MESES[Number(f.slice(5, 7)) - 1] ?? f.slice(5, 7)} de ${f.slice(0, 4)}`;
const esCero = (v: string): boolean => /^-?0*(?:\.0*)?$/.test(v);

/**
 * L-04 (ADR-0072 §7; PA SNAT/2025/000091): el especial declara por QUINCENA (1–15 y 16–último) y
 * el ordinario por MES. La quincena la da el servidor (`platform.fiscal_fortnight`), nunca la
 * pantalla. Devuelve el mensaje de persona si el período no es el que corresponde, o null.
 *
 * Periodicidad mensual del ordinario: LIVA (artículo del período mensual, VALIDAR-TRIBUTARIO P-73);
 * NO viene de la PA SNAT/2025/000091, que es de los especiales (auditoría fiscal 2.ª ronda, H13).
 * Decisión por criterio (H5, texto del dueño §2.6: «el ordinario declara por mes»): el ordinario
 * declara el MES calendario completo, del 1 al último día; todo otro rango da 422. Un tipo sin
 * declarar o no_contribuyente no se valida aquí.
 */
async function periodoNoCorresponde(
  sql: UnitOfWork["sql"],
  companyId: string,
  desde: string,
  hasta: string,
): Promise<string | null> {
  const [f] = await sql<
    {
      tipo_desde: string | null;
      tipo_hasta: string | null;
      q1_desde: string;
      q1_hasta: string;
      q2_desde: string;
      q2_hasta: string;
    }[]
  >`
    with m as (
      select make_date(extract(year from ${desde}::date)::int,
                       extract(month from ${desde}::date)::int, 1) as d)
    select platform.taxpayer_type_at(${companyId}, ${desde}::date) as tipo_desde,
           platform.taxpayer_type_at(${companyId}, ${hasta}::date) as tipo_hasta,
           q1.period_from::text as q1_desde, q1.period_to::text as q1_hasta,
           q2.period_from::text as q2_desde, q2.period_to::text as q2_hasta
      from m, platform.fiscal_fortnight(m.d) q1, platform.fiscal_fortnight(m.d + 15) q2`;
  if (!f) return null;
  if (f.tipo_desde !== f.tipo_hasta) {
    return (
      `Tu tipo de contribuyente cambia dentro de ese rango (${f.tipo_desde ?? "sin declarar"} el ` +
      `${dmy(desde)}, ${f.tipo_hasta ?? "sin declarar"} el ${dmy(hasta)}): genera por separado el ` +
      `período de cada tipo y consulta a tu asesor cómo se declara el de la transición.`
    );
  }
  const esQuincena =
    (desde === f.q1_desde && hasta === f.q1_hasta) ||
    (desde === f.q2_desde && hasta === f.q2_hasta);
  if (f.tipo_desde === "especial" && !esQuincena) {
    return (
      `Eres contribuyente especial: declaras el IVA por quincena (PA SNAT/2025/000091). En ` +
      `${nombreMes(f.q1_desde)} tus dos períodos van del ${dmy(f.q1_desde)} al ${dmy(f.q1_hasta)} ` +
      `y del ${dmy(f.q2_desde)} al ${dmy(f.q2_hasta)}.`
    );
  }
  const esMes = desde === f.q1_desde && hasta === f.q2_hasta;
  if (f.tipo_desde === "ordinario" && !esMes) {
    return (
      `Declaras el IVA por mes (eres contribuyente ordinario): el período de ` +
      `${nombreMes(f.q1_desde)} va del ${dmy(f.q1_desde)} al ${dmy(f.q2_hasta)}, completo.` +
      (esQuincena ? " La quincena es de los contribuyentes especiales." : "")
    );
  }
  return null;
}

/**
 * Registra el comprobante de retención soportada Y abona la factura afectada
 * con el instrumento `retencion_iva` — un solo acto, una sola transacción.
 * Todo se TRANSCRIBE del papel del agente: base, porción y monto. La única
 * aritmética que se exige es la del propio comprobante (monto ≈ base × 0.16 ×
 * porción NO se comprueba aquí: la alícuota de la factura vive en sus líneas
 * y el comprobante puede agrupar varias; lo que sí es innegociable es que el
 * abono sea EXACTAMENTE el monto retenido, y eso lo exige registerPayment).
 */
export async function registerSupportedRetention(
  uow: UnitOfWork,
  input: RegisterSupportedRetentionRequest,
): Promise<Result<RegisterSupportedRetentionResponse, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Registrar una retención soportada exige un usuario real.",
    });
  }
  // F-11 (ADR-0072 §5): la carga quien COBRA — el cliente entrega el comprobante al pagar —, con
  // su permiso propio. Ya no basta `sales.payment.register`.
  const scope = await companyScope(sql, actor.userId, input.company_id, "ar.retention.register");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }

  // La factura afectada: nuestra, del agente que retiene, y viva. El estado
  // `issued` lo re-exige registerPayment; aquí se valida lo que él no mira —
  // que el CLIENTE del comprobante sea el de la factura.
  const [doc] = await sql<
    { customer_id: string; kind: string; functional_currency: string; tax_amount: string }[]
  >`
    select customer_id, kind, functional_currency, tax_amount::text as tax_amount
      from public.documents
     where id = ${input.document_id} and company_id = ${input.company_id}`;
  if (!doc) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (doc.customer_id !== input.customer_id) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El agente del comprobante no es el cliente de esa factura.",
    });
  }
  // H4 (PA SNAT/2025/000054 art. 7): el comprobante se entrega el día de la retención o después.
  if (input.received_on !== undefined && input.received_on < input.retained_on) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        `La fecha de entrega del comprobante (${dmy(input.received_on)}) no puede ser anterior a ` +
        `la de la retención (${dmy(input.retained_on)}).`,
    });
  }
  // B-2: y no después de hoy (día de Caracas): un comprobante que aún no llegó no se carga.
  if (input.received_on !== undefined) {
    const [hoy] = await sql<{ dia: string }[]>`select platform.caracas_day(now())::text as dia`;
    if (hoy !== undefined && input.received_on > hoy.dia) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          `La fecha de entrega del comprobante (${dmy(input.received_on)}) no puede ser posterior a ` +
          `hoy (${dmy(hoy.dia)}): se carga cuando el agente lo entrega.`,
      });
    }
  }
  if (doc.kind !== "invoice" && doc.kind !== "debit_note") {
    return err({
      code: "VALIDATION_FAILED",
      message: "Una retención de IVA afecta a una factura o nota de débito, no a otro documento.",
    });
  }

  /**
   * EL MONTO ES UNA FRACCIÓN DEL IVA DE LA FACTURA (ADR-0072 §5; PA SNAT/2025/000054): el 75 %
   * o el 100 % del IVA en bolívares del documento, con ± Bs 0,01 de tolerancia por el redondeo
   * del agente. Lo que no es ninguno de los dos no es una retención de IVA de esta factura.
   */
  const iva = parseDecimal(doc.tax_amount);
  const monto = parseDecimal(input.amount);
  const porcionDada = parseDecimal(input.rate);
  // ± Bs 0,01: el redondeo del agente (respuesta del dueño, §2.6). No es una norma.
  const tolerancia = parseDecimal("0.01");
  if (!iva.ok || !monto.ok || !porcionDada.ok || !tolerancia.ok) {
    return err({ code: "VALIDATION_FAILED", message: "Importes no interpretables." });
  }
  // Las porciones admisibles son DATO con norma y vigencia (regla 8, hallazgo 5): las vigentes a la
  // fecha del comprobante, del catálogo de plataforma.
  const filas = await sql<{ portion: string; legal_norm: string; legal_article: string }[]>`
    select portion::text as portion, legal_norm, legal_article
      from public.iva_retention_portions
     where effective_from <= ${input.retained_on}::date
       and (effective_to is null or effective_to > ${input.retained_on}::date)
     order by portion`;
  const porciones: Decimal[] = [];
  for (const f of filas) {
    const p = parseDecimal(f.portion);
    if (p.ok) porciones.push(p.value);
  }
  if (porciones.length === 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `No hay porciones de retención de IVA con norma vigente al ${input.retained_on}: revisa la fecha del comprobante.`,
    });
  }
  const cabe = (p: Decimal) =>
    monto.value.minus(iva.value.times(p)).abs().lessThanOrEqualTo(tolerancia.value);
  // B4: con un IVA diminuto (≤ Bs 0,02) varias porciones caben en la tolerancia. Manda primero la
  // que dice el comprobante, si cabe; después, las demás del catálogo.
  const indicada = porciones.find((p) => p.equals(porcionDada.value));
  const porcion = indicada !== undefined && cabe(indicada) ? indicada : porciones.find(cabe);
  const bs = (d: Decimal) => d.toDecimalPlaces(2, 4).toFixed(2).replace(".", ",");
  if (porcion === undefined) {
    const opciones = porciones
      .map((p) => `el ${p.times(100).toFixed(0)} % (Bs ${bs(iva.value.times(p))})`)
      .join(" o ");
    const fuente = filas[0] === undefined ? "" : ` (${filas[0].legal_norm})`;
    return err({
      code: "VALIDATION_FAILED",
      message:
        `El monto retenido debe ser ${opciones} del IVA de la factura${fuente}, y el comprobante ` +
        `dice Bs ${bs(monto.value)}. Revisa el monto o la factura elegida.`,
    });
  }
  if (!porcionDada.value.equals(porcion)) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El monto es el ${porcion.times(100).toFixed(0)} % del IVA de la factura y la porción indicada no coincide.`,
    });
  }
  // Con qué tasa abona: la de la factura, salvo el parámetro P-30 de la empresa (apagado).
  const [ajuste] = await sql<{ voucher: boolean }[]>`
    select coalesce((select retention_received_voucher_rate from public.company_settings
                      where company_id = ${input.company_id}), false) as voucher`;
  const valoracion = ajuste?.voucher === true ? "voucher_rate" : "invoice_rate";

  await sql`select set_config('ladino.rules_version', ${RULES_VERSION}, true)`;

  let comprobante;
  try {
    comprobante = await sql.savepoint(async (sp) => {
      const [fila] = await sp<Record<string, unknown>[]>`
        insert into public.supported_retention_receipts
          (tenant_id, company_id, customer_id, document_id, receipt_number, retained_on,
           received_on, base, rate, amount, functional_currency, ar_valuation)
        values (${scope.value.tenantId}, ${input.company_id}, ${input.customer_id},
                ${input.document_id}, ${input.receipt_number}, ${input.retained_on}::date,
                ${input.received_on ?? null}::date, ${input.base}, ${input.rate}, ${input.amount}, ${doc.functional_currency},
                ${valoracion})
        returning id, customer_id, document_id, receipt_number, retained_on::text as retained_on,
                  received_on::text as received_on,
                  base::text as base, rate::text as rate, amount::text as amount,
                  functional_currency, status, annul_reason,
                  to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                    as created_at`;
      return fila!;
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "23505") {
      return err({
        code: "DUPLICATE",
        message: `El comprobante ${input.receipt_number} de ese cliente ya está cargado contra esa factura. Un comprobante quincenal se carga una vez por cada factura que cubre.`,
      });
    }
    if (code === "23514") {
      return err({
        code: "VALIDATION_FAILED",
        message: "El comprobante no pasa las reglas de forma (base, porción y monto positivos).",
      });
    }
    throw e;
  }

  // El abono, por el MISMO camino que cualquier cobro: registerPayment valida
  // el estado de la factura, exige el monto exacto del comprobante, registra
  // el diferencial cambiario si la factura vive en divisa, audita con
  // 'ar.retention_applied' y genera su asiento (Dr IVA retenido por cobrar /
  // Cr cuentas por cobrar). Un segundo camino que escribiera payments a mano
  // acabaría divergiendo de este.
  const pago = await registerPayment(
    uow,
    {
      company_id: input.company_id,
      document_id: input.document_id,
      currency: doc.functional_currency,
      amount: input.amount,
      instrument: "retencion_iva",
      reference: input.receipt_number,
      supported_retention_id: comprobante["id"] as string,
    },
    "ar.retention.register",
  );
  if (!pago.ok) return pago;

  return ok({
    retention: comprobante as never,
    payment: pago.value,
  });
}

/**
 * Genera el resultado de UN período de IVA y lo deja como fila insert-only
 * con su hash (patrón fiscal_book_runs: la sustitutiva es OTRA generación).
 *
 * EL ARRASTRE ES UNA CADENA: el excedente anterior sale de la última
 * generación del período que termina EXACTAMENTE el día antes. Si hay
 * historia previa sin generar, se exige generarla primero — un excedente
 * anterior puesto a cero en silencio produce una cuota falsa sin avisar,
 * que es exactamente la clase de error que este módulo existe para impedir.
 */
export async function generateIvaPeriod(
  uow: UnitOfWork,
  input: GenerateIvaPeriodRequest,
): Promise<Result<IvaPeriodResultResponse, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Generar el período exige un usuario real: la generación se firma con nombre.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "fiscal_book.export");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  if (input.period_to < input.period_from) {
    return err({ code: "VALIDATION_FAILED", message: "El período termina antes de empezar." });
  }
  const noCorresponde = await periodoNoCorresponde(
    sql,
    input.company_id,
    input.period_from,
    input.period_to,
  );
  if (noCorresponde !== null) return err({ code: "VALIDATION_FAILED", message: noCorresponde });

  // El eslabón anterior de la cadena: DOS arrastres, cada uno por su lado (L-05).
  const [anterior] = await sql<
    { excedente: string; retenciones: string; soportadas: string; version: string }[]
  >`
    select excedente_siguiente::text as excedente,
           retenciones_acumuladas_por_descontar::text as retenciones,
           retenciones_soportadas::text as soportadas,
           generator_version as version
      from public.iva_period_results
     where company_id = ${input.company_id}
       and period_to = (${input.period_from}::date - 1)
     order by created_at desc, id desc limit 1`;
  let excedenteAnterior = "0";
  let retencionesAnteriores = "0";
  if (anterior) {
    // Una fila 1.0.0 con excedente lo trae mezclado; y una con retenciones del período puede
    // haberse generado con la API vieja contra la función nueva (ventana de deploy), que no
    // guardaba el arrastre de retenciones: en los dos casos, regenerar. Ruidoso a propósito.
    if (
      anterior.version === GENERADOR_ARRASTRE_MEZCLADO &&
      (!esCero(anterior.excedente) || !esCero(anterior.soportadas))
    ) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          `El período que termina el día antes del ${dmy(input.period_from)} se generó con la ` +
          `versión que sumaba en una sola cifra el excedente de crédito fiscal y las retenciones ` +
          `no descontadas. Vuelve a generarlo (y los anteriores que tengan excedente) para que ` +
          `cada arrastre pase por su lado.`,
      });
    }
    excedenteAnterior = anterior.excedente;
    retencionesAnteriores = anterior.retenciones;
  } else {
    // ¿Hay historia ANTES de este período? Ventas, compras, retenciones o un
    // resultado ya generado que no empalma: cualquiera de las cuatro obliga a
    // generar primero el período anterior. La zona horaria de la emisión es
    // la misma que usa el cálculo (America/Caracas, migración 46).
    const [historia] = await sql<{ hay: boolean }[]>`
      select exists (
        select 1 from public.documents d
         where d.company_id = ${input.company_id}
           and d.kind in ('invoice', 'credit_note', 'debit_note')
           and d.status in ('issued', 'paid')
           and (d.issued_at at time zone 'America/Caracas')::date < ${input.period_from}::date
      ) or exists (
        select 1 from public.supplier_invoices i
         where i.company_id = ${input.company_id}
           and i.status in ('posted', 'paid')
           and i.invoice_date < ${input.period_from}::date
      ) or exists (
        select 1 from public.supported_retention_receipts r
         where r.company_id = ${input.company_id}
           and r.retained_on < ${input.period_from}::date
      ) or exists (
        select 1 from public.iva_period_results p
         where p.company_id = ${input.company_id}
           and p.period_to < ${input.period_from}::date
      ) as hay`;
    if (historia?.hay) {
      return err({
        code: "VALIDATION_FAILED",
        message:
          `El arrastre viene encadenado: genera primero el período que termina el día antes ` +
          `de ${input.period_from} (los períodos sin actividad también se generan — en cero).`,
      });
    }
  }

  const [r] = await sql<
    {
      debitos: string;
      creditos: string;
      creditos_deducibles: string;
      prorrata_pct: string | null;
      retenciones_soportadas: string;
      cuota_a_pagar: string;
      excedente_siguiente: string;
      detalle: unknown;
      ajuste_creditos_anteriores: string;
      retenciones_acumuladas_por_descontar: string;
    }[]
  >`select debitos::text as debitos, creditos::text as creditos,
           creditos_deducibles::text as creditos_deducibles,
           prorrata_pct::text as prorrata_pct,
           retenciones_soportadas::text as retenciones_soportadas,
           cuota_a_pagar::text as cuota_a_pagar,
           excedente_siguiente::text as excedente_siguiente, detalle,
           ajuste_creditos_anteriores::text as ajuste_creditos_anteriores,
           retenciones_acumuladas_por_descontar::text as retenciones_acumuladas_por_descontar
      from platform.recompute_iva_period(
             ${input.company_id}, ${input.period_from}::date, ${input.period_to}::date,
             ${excedenteAnterior}, ${retencionesAnteriores})`;
  if (!r) {
    return err({ code: "VALIDATION_FAILED", message: "El cálculo del período no devolvió filas." });
  }

  // El hash firma EXACTAMENTE lo que se persiste, con las claves en orden
  // fijo: dos generaciones del mismo período con los mismos datos dan el
  // mismo hash, y una distinta dice que algo cambió entre medias.
  const canonico = JSON.stringify({
    period_from: input.period_from,
    period_to: input.period_to,
    excedente_anterior: excedenteAnterior,
    debitos: r.debitos,
    creditos: r.creditos,
    creditos_deducibles: r.creditos_deducibles,
    prorrata_pct: r.prorrata_pct,
    retenciones_soportadas: r.retenciones_soportadas,
    cuota_a_pagar: r.cuota_a_pagar,
    excedente_siguiente: r.excedente_siguiente,
    detalle: r.detalle,
    // La casilla de ajustes de créditos de períodos anteriores (R-2 ampliada, migración
    // 20260928120000) entra en el hash SOLO cuando no es cero: toda planilla generada antes
    // —y toda la que no tiene ajuste— sigue reproduciendo su mismo hash, y la que lo tiene lo
    // firma. Se compara el STRING, no un número (regla 7).
    ...(/^-?0*(?:\.0*)?$/.test(r.ajuste_creditos_anteriores)
      ? {}
      : { ajuste_creditos_anteriores: r.ajuste_creditos_anteriores }),
    // L-05 (generador 1.1.0): los dos arrastres de retenciones, con el mismo criterio — solo
    // cuando no son cero. El de crédito fiscal es `excedente_siguiente`, que ya no las incluye.
    ...(esCero(retencionesAnteriores)
      ? {}
      : { retenciones_acumuladas_anteriores: retencionesAnteriores }),
    ...(esCero(r.retenciones_acumuladas_por_descontar)
      ? {}
      : { retenciones_acumuladas_por_descontar: r.retenciones_acumuladas_por_descontar }),
    generator_version: IVA_PERIOD_GENERATOR_VERSION,
  });
  const [h] = await sql<{ hash: string }[]>`
    select encode(sha256(convert_to(${canonico}, 'utf8')), 'hex') as hash`;

  const [fila] = await sql<Record<string, unknown>[]>`
    insert into public.iva_period_results
      (tenant_id, company_id, period_from, period_to, debitos, creditos, creditos_deducibles,
       prorrata_pct, retenciones_soportadas, excedente_anterior, cuota_a_pagar,
       excedente_siguiente, detalle, generator_version, dataset_hash,
       ajuste_creditos_anteriores, retenciones_acumuladas_anteriores,
       retenciones_acumuladas_por_descontar)
    values (${scope.value.tenantId}, ${input.company_id}, ${input.period_from}::date,
            ${input.period_to}::date, ${r.debitos}, ${r.creditos}, ${r.creditos_deducibles},
            ${r.prorrata_pct}, ${r.retenciones_soportadas}, ${excedenteAnterior},
            ${r.cuota_a_pagar}, ${r.excedente_siguiente},
            ${sql.json(r.detalle as JSONValue)}, ${IVA_PERIOD_GENERATOR_VERSION},
            ${h!.hash}, ${r.ajuste_creditos_anteriores}, ${retencionesAnteriores},
            ${r.retenciones_acumuladas_por_descontar})
    returning id, period_from::text as period_from, period_to::text as period_to,
              debitos::text as debitos, creditos::text as creditos,
              creditos_deducibles::text as creditos_deducibles,
              prorrata_pct::text as prorrata_pct,
              retenciones_soportadas::text as retenciones_soportadas,
              excedente_anterior::text as excedente_anterior,
              cuota_a_pagar::text as cuota_a_pagar,
              excedente_siguiente::text as excedente_siguiente,
              detalle,
              ajuste_creditos_anteriores::text as ajuste_creditos_anteriores,
              retenciones_acumuladas_anteriores::text as retenciones_acumuladas_anteriores,
              retenciones_acumuladas_por_descontar::text
                as retenciones_acumuladas_por_descontar,
              (select c.functional_currency_code from public.companies c
                where c.id = ${input.company_id}) as functional_currency,
              generator_version, dataset_hash, created_by,
              to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
                as created_at`;

  const parametros: Record<string, JSONValue> = {
    period_from: input.period_from,
    period_to: input.period_to,
    excedente_anterior: excedenteAnterior,
    cuota_a_pagar: r.cuota_a_pagar,
    excedente_siguiente: r.excedente_siguiente,
    retenciones_acumuladas_anteriores: retencionesAnteriores,
    retenciones_acumuladas_por_descontar: r.retenciones_acumuladas_por_descontar,
    dataset_hash: h!.hash,
  };
  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'iva_period_result',
            ${fila!["id"] as string}, 'fiscal.iva_period.generated', 'user', now(),
            ${RULES_VERSION}, ${sql.json(parametros)})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'iva_period_result',
            ${fila!["id"] as string}, 'fiscal.iva_period.generated', 1,
            ${sql.json({ id: fila!["id"] as string, ...parametros })})`;

  return ok(fila as never);
}

/**
 * Carga (o corrige) el calendario de vencimientos. REEMPLAZO por
 * (obligación, período): la tabla no admite UPDATE — se borra la fila vieja
 * y se inserta la nueva, con su fuente. Es configuración de la empresa, no
 * un hecho fiscal: permiso de settings, sin outbox.
 */
export async function loadFiscalDeadlines(
  uow: UnitOfWork,
  input: LoadFiscalDeadlinesRequest,
): Promise<Result<{ items: FiscalDeadlineResponse[]; total: number }, DeclarationsError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Cargar el calendario fiscal exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "company.settings.manage");
  if (!scope.ok) return scope;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  for (const d of input.deadlines) {
    if (d.period_to < d.period_from) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El período de ${d.obligation} termina antes de empezar (${d.period_from} → ${d.period_to}).`,
      });
    }
  }

  const items: FiscalDeadlineResponse[] = [];
  for (const d of input.deadlines) {
    await sql`
      delete from public.company_fiscal_deadlines
       where company_id = ${input.company_id} and obligation = ${d.obligation}
         and period_from = ${d.period_from}::date and period_to = ${d.period_to}::date`;
    const [fila] = await sql<FiscalDeadlineResponse[]>`
      insert into public.company_fiscal_deadlines
        (tenant_id, company_id, obligation, period_from, period_to, due_date, legal_source)
      values (${scope.value.tenantId}, ${input.company_id}, ${d.obligation},
              ${d.period_from}::date, ${d.period_to}::date, ${d.due_date}::date,
              ${d.legal_source})
      returning id, obligation, period_from::text as period_from, period_to::text as period_to,
                due_date::text as due_date, legal_source`;
    items.push(fila!);
  }
  // `total` es lo que se acaba de cargar: aquí no hay paginación que valga,
  // pero el contrato de la lista es uno solo y esta respuesta lo cumple.
  return ok({ items, total: items.length });
}

/** La periodicidad del IVA que el servidor propone (L-04). */
export interface IvaPeriodProposal {
  taxpayer_type: string | null;
  periodicity: "quincenal" | "mensual" | null;
  period_from: string;
  period_to: string;
  due_date: string | null;
  due_date_status: string | null;
  legal_source: string | null;
}

/**
 * L-04: el período que la pantalla PROPONE, según el tipo vigente y el calendario — la última
 * quincena cerrada para el especial, el último mes cerrado para el ordinario —, con su vencimiento
 * por terminal del RIF si la celda de la providencia está ofrecida. El «hoy» es el día de Caracas
 * del servidor. La web lo muestra y no calcula ninguna quincena.
 */
export async function proposeIvaPeriod(
  sql: UnitOfWork["sql"],
  companyId: string,
): Promise<IvaPeriodProposal> {
  const [p] = await sql<IvaPeriodProposal[]>`
    select taxpayer_type, periodicity, period_from::text as period_from,
           period_to::text as period_to, due_date::text as due_date,
           due_date_status, legal_source
      from platform.iva_period_proposal(${companyId}, platform.caracas_day(now()))`;
  return p!;
}

/** Una fecha del calendario de la providencia, para el terminal de la empresa. */
export interface TaxCalendarEntry {
  obligation: string;
  period_from: string;
  period_to: string;
  due_date: string;
  legal_source: string;
}

/**
 * L-09 (ADR-0072 §8): el calendario sembrado de la providencia para el terminal del RIF de la
 * empresa, entre dos fechas de VENCIMIENTO. Solo las celdas ofrecidas: las pendientes de cotejo
 * se cuentan pero no se muestran. Solo para el especial (la providencia es de los SPE).
 */
export async function listTaxCalendar(
  sql: UnitOfWork["sql"],
  companyId: string,
  desde: string,
  hasta: string,
): Promise<{
  rif_terminal: number | null;
  /** H6: si la providencia de especiales aplica a la empresa (especial hoy y con terminal). */
  applies: boolean;
  items: TaxCalendarEntry[];
  total: number;
  pending_review: number;
}> {
  const [cab] = await sql<{ terminal: number | null; especial: boolean }[]>`
    select platform.rif_terminal(c.tax_id)::int as terminal,
           coalesce(platform.taxpayer_type_at(c.id, platform.caracas_day(now())) = 'especial',
                    false) as especial
      from public.companies c where c.id = ${companyId}`;
  const terminal = cab?.terminal ?? null;
  if (terminal === null || cab?.especial !== true) {
    return { rif_terminal: terminal, applies: false, items: [], total: 0, pending_review: 0 };
  }
  const filas = await sql<(TaxCalendarEntry & { review_status: string })[]>`
    select obligation, period_from::text as period_from, period_to::text as period_to,
           due_date::text as due_date, review_status,
           legal_norm || ', ' || gazette || '. Transcrita de: ' || secondary_source as legal_source
      from public.tax_calendar_entries
     where rif_terminal = ${terminal}
       and due_date between ${desde}::date and ${hasta}::date
     order by due_date, obligation`;
  const items = filas
    .filter((f) => f.review_status === "secondary_source")
    .map(({ review_status: _r, ...f }) => f);
  return {
    rif_terminal: terminal,
    applies: true,
    items,
    total: items.length,
    pending_review: filas.length - items.length,
  };
}
