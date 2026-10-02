import { err, ok, type Result } from "@ladino/core";
import type { TransactionSql, JSONValue } from "@ladino/db";
import type {
  CancelFiscalRangeRequest,
  CompleteFiscalRangePrinterRequest,
  CorrectFiscalRangePrinterRequest,
  CreateFiscalRangeRequest,
  FiscalRangeResponse,
} from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { validarRif, type DocumentoLeido } from "./documento-identidad.js";

/**
 * EL TALONARIO DE LA IMPRENTA (ADR-0071, enmienda ADR-0037; hallazgos G-01, E-01, B-03, E-17).
 *
 * PA 00071 art. 44: el número de control es consecutivo y ÚNICO por emisor, con un identificador
 * de 2 dígitos y un secuencial de hasta 8. Art. 31: en forma libre la imprenta no preimprime la
 * clase del documento, así que UN talonario sirve para factura, nota de crédito y nota de débito.
 *
 * - El talonario se registra una vez, con los datos de la imprenta. Sin ellos no hay rango (422).
 * - Ningún solape: lo garantiza la exclusión `fiscal_number_ranges_no_overlap`; aquí se comprueba
 *   antes, bajo un advisory lock por empresa, para responder un 409 que diga CUÁL pisa.
 * - La serie la dicta el talonario, nunca el servidor (`serieDelTalonario`); '' = sin serie.
 * - Cada paso deja su acta en audit_events (H4): registrado, imprenta completada, imprenta
 *   corregida (con lo anterior y lo nuevo) y anulado.
 */

export type TalonarioError =
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "DUPLICATE"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "FISCAL_NUMBERING_INVALID"; message: string; details?: { reason: "no_range" } };

/** Las columnas de la respuesta (FiscalRangeResponse). `r` es fiscal_number_ranges. */
export const TALONARIO_COLUMNS = `r.id, r.kind, r.series, r.printer_identifier,
  r.range_from::int as range_from, r.range_to::int as range_to,
  r.next_available::int as next_available, r.status, r.printer_source,
  r.printer_legal_name, r.printer_tax_id, r.printer_authorization,
  r.printer_authorization_date::text as printer_authorization_date,
  r.printed_on::text as printed_on, r.printer_data_complete,
  exists (select 1 from public.contingency_ranges cr where cr.fiscal_number_range_id = r.id)
    as is_contingency,
  (r.range_to - r.next_available + 1)::int as remaining`;

/** Art. 44: el secuencial del control tiene hasta 8 dígitos. */
const MAXIMO_CONTROL = 99_999_999n;

const NOMBRE_CLASE: Record<string, string> = {
  invoice: "facturas",
  credit_note: "notas de crédito",
  debit_note: "notas de débito",
  delivery_note: "guías de despacho",
};

const nombreSerie = (s: string): string => (s === "" ? "sin serie" : `serie ${s}`);

type DatosImprenta = {
  printer_legal_name?: string | undefined;
  printer_tax_id?: string | undefined;
  printer_authorization?: string | undefined;
  printer_authorization_date?: string | undefined;
  printed_on?: string | undefined;
};

/** Qué falta de la imprenta, en palabras de persona. Vacío = completo. */
function faltaDeImprenta(d: DatosImprenta): string[] {
  const falta: string[] = [];
  if (d.printer_legal_name === undefined) falta.push("la razón social de la imprenta");
  if (d.printer_tax_id === undefined) falta.push("el RIF de la imprenta");
  if (d.printer_authorization === undefined) falta.push("el número de su providencia");
  if (d.printer_authorization_date === undefined) falta.push("la fecha de su providencia");
  if (d.printed_on === undefined) falta.push("la fecha de elaboración del talonario");
  return falta;
}

/**
 * El RIF de la imprenta con LA función de todos los RIF (`leerRif` vía `validarRif`, P-49): la
 * estructura bloquea; el dígito verificador que no cuadra solo avisa y deja acta.
 */
function validarImprenta(d: DatosImprenta): Result<DocumentoLeido, TalonarioError> {
  const falta = faltaDeImprenta(d);
  if (falta.length > 0) {
    return err({
      code: "VALIDATION_FAILED",
      message: `Sin los datos de la imprenta no se registra el talonario (PA 00071 art. 31). Falta: ${falta.join(", ")}.`,
    });
  }
  const rif = validarRif(d.printer_tax_id!);
  if (!rif.ok) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El RIF de la imprenta no tiene la forma de un RIF: una letra (V, E, J, G, P o C) y nueve dígitos, con o sin guiones, como J-12345678-9.",
    });
  }
  return ok(rif.value);
}

async function tenantDe(sql: TransactionSql, companyId: string): Promise<string> {
  const [e] = await sql<{ tenant_id: string }[]>`
    select tenant_id from public.companies where id = ${companyId}`;
  return e!.tenant_id;
}

/** El acta (H4). Devuelve su id: la corrección de la imprenta lo necesita para el trigger. */
async function acta(
  sql: TransactionSql,
  d: {
    tenantId: string;
    companyId: string;
    rangeId: string;
    eventType: string;
    payload: Record<string, JSONValue>;
  },
): Promise<string> {
  const [a] = await sql<{ id: string }[]>`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${d.tenantId}, ${d.companyId}, 'fiscal_number_range', ${d.rangeId}, ${d.eventType},
            'user', now(), ${RULES_VERSION}, ${sql.json(d.payload)})
    returning id`;
  return a!.id;
}

/** El dígito verificador que no cuadra deja constancia, como en clientes y empresas (P-49). */
async function actaDigitoDudoso(
  sql: TransactionSql,
  d: { tenantId: string; companyId: string; rangeId: string; rif: DocumentoLeido },
): Promise<void> {
  if (d.rif.digito !== "incorrecto") return;
  await acta(sql, {
    tenantId: d.tenantId,
    companyId: d.companyId,
    rangeId: d.rangeId,
    eventType: "fiscal_number_range.tax_id_check_digit_mismatch",
    payload: {
      tax_id: d.rif.normalizado,
      check_digit_ok: false,
      digito_recibido: Number(d.rif.normalizado[9]),
      digito_esperado: d.rif.esperado,
      regla: "modulo11-seniat",
    },
  });
}

/** ¿El tramo pisa otro talonario vivo del mismo identificador? (sin contar `excepto`). */
async function pisa(
  sql: TransactionSql,
  companyId: string,
  identificador: string,
  desde: string,
  hasta: string,
  excepto: string | null,
): Promise<TalonarioError | null> {
  await sql`select pg_advisory_xact_lock(hashtext('ladino-talonario:' || ${companyId}::text))`;
  const [p] = await sql<{ series: string; range_from: string; range_to: string }[]>`
    select r.series, r.range_from::text as range_from, r.range_to::text as range_to
      from public.fiscal_number_ranges r
     where r.company_id = ${companyId} and r.printer_identifier = ${identificador}
       and r.status <> 'cancelled' and r.kind is distinct from 'retention_receipt'
       and lower(r.series) not like 'contingencia%'
       and r.id is distinct from ${excepto}::uuid
       and int8range(r.range_from, r.range_to, '[]')
           && int8range(${desde}::bigint, ${hasta}::bigint, '[]')
     order by r.range_from limit 1`;
  if (!p) return null;
  return {
    code: "DUPLICATE",
    message:
      `El rango ${desde}–${hasta} (identificador ${identificador}) pisa el talonario ` +
      `${nombreSerie(p.series)} ${p.range_from}–${p.range_to} ya registrado. Un número de control ` +
      `no se repite en la empresa, sea factura, nota de crédito o nota de débito (PA 00071 art. 44).`,
  };
}

/** Registrar un talonario. El permiso y «es de quien factura» los comprueba quien llama. */
export async function registrarTalonario(
  sql: TransactionSql,
  tenantId: string,
  companyId: string,
  d: CreateFiscalRangeRequest,
): Promise<Result<FiscalRangeResponse, TalonarioError>> {
  // H1: la serie «contingencia…» es del talonario de contingencia (PA 102), que tiene su camino.
  if (/^contingencia/i.test(d.series)) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "Una serie «contingencia…» es del talonario de contingencia (PA 102): regístralo en Contingencia, con el motivo de la falla.",
    });
  }
  const rif = validarImprenta(d);
  if (!rif.ok) return rif;
  const desde = BigInt(d.range_from);
  const hasta = BigInt(d.range_to);
  if (desde < 1n || hasta < desde || hasta > MAXIMO_CONTROL) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El número de control va del 1 al 99.999.999 (8 dígitos, PA 00071 art. 44), y el «hasta» no puede ser menor que el «desde».",
    });
  }
  const identificador = d.printer_identifier ?? "00";
  const choque = await pisa(sql, companyId, identificador, d.range_from, d.range_to, null);
  if (choque) return err(choque);

  const [fila] = await sql<FiscalRangeResponse[]>`
    with nuevo as (
      insert into public.fiscal_number_ranges
        (tenant_id, company_id, kind, series, printer_identifier, range_from, range_to,
         next_available, printer_source, printer_legal_name, printer_tax_id,
         printer_authorization, printer_authorization_date, printed_on, alert_threshold_pct)
      values (${tenantId}, ${companyId}, null, ${d.series}, ${identificador}, ${d.range_from},
              ${d.range_to}, ${d.range_from}, ${d.printer_source ?? d.printer_legal_name!},
              ${d.printer_legal_name!}, ${rif.value.normalizado}, ${d.printer_authorization!},
              ${d.printer_authorization_date!}::date, ${d.printed_on!}::date,
              ${d.alert_threshold_pct ?? 10})
      returning *
    )
    select ${sql.unsafe(TALONARIO_COLUMNS)} from nuevo r`;
  await acta(sql, {
    tenantId,
    companyId,
    rangeId: fila!.id,
    eventType: "fiscal.range.registered",
    payload: {
      series: d.series,
      printer_identifier: identificador,
      range_from: d.range_from,
      range_to: d.range_to,
      printer_legal_name: d.printer_legal_name!,
      printer_tax_id: rif.value.normalizado,
      printer_authorization: d.printer_authorization!,
      printer_authorization_date: d.printer_authorization_date!,
      printed_on: d.printed_on!,
    },
  });
  await actaDigitoDudoso(sql, { tenantId, companyId, rangeId: fila!.id, rif: rif.value });
  return ok(fila!);
}

type Actual = {
  completo: boolean;
  emitio: boolean;
  printer_identifier: string;
  range_from: string;
  range_to: string;
  printer_legal_name: string | null;
  printer_tax_id: string | null;
  printer_authorization: string | null;
  printer_authorization_date: string | null;
  printed_on: string | null;
  status: string;
};

async function cargar(
  sql: TransactionSql,
  companyId: string,
  rangeId: string,
): Promise<Actual | undefined> {
  const [a] = await sql<Actual[]>`
    select printer_data_complete as completo, next_available > range_from as emitio,
           printer_identifier, range_from::text as range_from, range_to::text as range_to,
           printer_legal_name, printer_tax_id, printer_authorization,
           printer_authorization_date::text as printer_authorization_date,
           printed_on::text as printed_on, status
      from public.fiscal_number_ranges
     where id = ${rangeId} and company_id = ${companyId}
       and lower(series) not like 'contingencia%'
     for update`;
  return a;
}

/** El identificador nuevo: solo si el talonario no emitió, y sin pisar otro (H3). */
async function identificadorNuevo(
  sql: TransactionSql,
  companyId: string,
  rangeId: string,
  actual: Actual,
  pedido: string | undefined,
): Promise<Result<string, TalonarioError>> {
  if (pedido === undefined || pedido === actual.printer_identifier) {
    return ok(actual.printer_identifier);
  }
  if (actual.emitio) {
    return err({
      code: "DUPLICATE",
      message:
        "El identificador de un talonario que ya emitió no cambia: está impreso en sus documentos. Si el papel dice otro, anula lo que falte y registra el talonario correcto.",
    });
  }
  const choque = await pisa(sql, companyId, pedido, actual.range_from, actual.range_to, rangeId);
  return choque ? err(choque) : ok(pedido);
}

/** Completar, UNA vez, los datos de la imprenta de un talonario anterior a ADR-0071. */
export async function completarImprenta(
  sql: TransactionSql,
  companyId: string,
  rangeId: string,
  d: CompleteFiscalRangePrinterRequest,
): Promise<Result<FiscalRangeResponse, TalonarioError>> {
  const rif = validarImprenta(d);
  if (!rif.ok) return rif;
  const actual = await cargar(sql, companyId, rangeId);
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (actual.completo) {
    return err({
      code: "DUPLICATE",
      message:
        "Ese talonario ya tiene los datos de la imprenta. Si algo está mal, corrígelo con motivo (queda en el acta).",
    });
  }
  const ident = await identificadorNuevo(sql, companyId, rangeId, actual, d.printer_identifier);
  if (!ident.ok) return ident;
  const [fila] = await sql<FiscalRangeResponse[]>`
    with hecho as (
      update public.fiscal_number_ranges
         set printer_legal_name = ${d.printer_legal_name}, printer_tax_id = ${rif.value.normalizado},
             printer_authorization = ${d.printer_authorization},
             printer_authorization_date = ${d.printer_authorization_date}::date,
             printed_on = ${d.printed_on}::date, printer_identifier = ${ident.value}
       where id = ${rangeId} and company_id = ${companyId}
      returning *
    )
    select ${sql.unsafe(TALONARIO_COLUMNS)} from hecho r`;
  const tenantId = await tenantDe(sql, companyId);
  await acta(sql, {
    tenantId,
    companyId,
    rangeId,
    eventType: "fiscal.range.printer_completed",
    payload: {
      printer_identifier: ident.value,
      printer_legal_name: d.printer_legal_name,
      printer_tax_id: rif.value.normalizado,
      printer_authorization: d.printer_authorization,
      printer_authorization_date: d.printer_authorization_date,
      printed_on: d.printed_on,
    },
  });
  await actaDigitoDudoso(sql, { tenantId, companyId, rangeId, rif: rif.value });
  return ok(fila!);
}

/**
 * Corregir los datos de la imprenta (H3, decidido por criterio): con motivo y un acta que guarda
 * lo anterior y lo nuevo. Permitido siempre, porque no cambia nada de lo emitido — cada documento
 * lleva impreso lo que la imprenta preimprimió. El trigger `assert_range_printer_frozen` solo lo
 * admite con el id de ESTA acta en el GUC `ladino.range_printer_correction`.
 */
export async function corregirImprenta(
  sql: TransactionSql,
  companyId: string,
  rangeId: string,
  d: CorrectFiscalRangePrinterRequest,
): Promise<Result<FiscalRangeResponse, TalonarioError>> {
  const rif = validarImprenta(d);
  if (!rif.ok) return rif;
  const actual = await cargar(sql, companyId, rangeId);
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (!actual.completo) {
    return err({
      code: "VALIDATION_FAILED",
      message: "Ese talonario todavía no tiene los datos de la imprenta: complétalos primero.",
    });
  }
  const ident = await identificadorNuevo(sql, companyId, rangeId, actual, d.printer_identifier);
  if (!ident.ok) return ident;
  const tenantId = await tenantDe(sql, companyId);
  // CONTRATO con assert_range_printer_frozen (migración 20260928160400): el acta lleva el txid de
  // la transacción de nivel superior y su «después» es exactamente lo que se escribe.
  const [tx] = await sql<{ txid: string }[]>`select pg_current_xact_id()::text as txid`;
  const idActa = await acta(sql, {
    tenantId,
    companyId,
    rangeId,
    eventType: "fiscal.range.printer_corrected",
    payload: {
      reason: d.reason,
      txid: tx!.txid,
      antes: {
        printer_identifier: actual.printer_identifier,
        printer_legal_name: actual.printer_legal_name,
        printer_tax_id: actual.printer_tax_id,
        printer_authorization: actual.printer_authorization,
        printer_authorization_date: actual.printer_authorization_date,
        printed_on: actual.printed_on,
      },
      despues: {
        printer_identifier: ident.value,
        printer_legal_name: d.printer_legal_name,
        printer_tax_id: rif.value.normalizado,
        printer_authorization: d.printer_authorization,
        printer_authorization_date: d.printer_authorization_date,
        printed_on: d.printed_on,
      },
    },
  });
  await sql`select set_config('ladino.range_printer_correction', ${idActa}, true)`;
  const [fila] = await sql<FiscalRangeResponse[]>`
    with hecho as (
      update public.fiscal_number_ranges
         set printer_legal_name = ${d.printer_legal_name}, printer_tax_id = ${rif.value.normalizado},
             printer_authorization = ${d.printer_authorization},
             printer_authorization_date = ${d.printer_authorization_date}::date,
             printed_on = ${d.printed_on}::date, printer_identifier = ${ident.value}
       where id = ${rangeId} and company_id = ${companyId}
      returning *
    )
    select ${sql.unsafe(TALONARIO_COLUMNS)} from hecho r`;
  await sql`select set_config('ladino.range_printer_correction', '', true)`;
  await actaDigitoDudoso(sql, { tenantId, companyId, rangeId, rif: rif.value });
  return ok(fila!);
}

/** Anular un talonario que no emitió nada (H3), con motivo y acta. */
export async function anularTalonario(
  sql: TransactionSql,
  companyId: string,
  rangeId: string,
  d: CancelFiscalRangeRequest,
): Promise<Result<FiscalRangeResponse, TalonarioError>> {
  const actual = await cargar(sql, companyId, rangeId);
  if (!actual) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  if (actual.status === "cancelled") {
    return err({ code: "DUPLICATE", message: "Ese talonario ya está anulado." });
  }
  if (actual.emitio) {
    return err({
      code: "DUPLICATE",
      message:
        "Ese talonario ya emitió documentos: no se anula, porque sus números de control están impresos en ellos. Si el papel restante no sirve, deja que se agote o corrige los datos de la imprenta con motivo.",
    });
  }
  const tenantId = await tenantDe(sql, companyId);
  await acta(sql, {
    tenantId,
    companyId,
    rangeId,
    eventType: "fiscal.range.cancelled",
    payload: {
      reason: d.reason,
      printer_identifier: actual.printer_identifier,
      range_from: actual.range_from,
      range_to: actual.range_to,
    },
  });
  const [fila] = await sql<FiscalRangeResponse[]>`
    with hecho as (
      update public.fiscal_number_ranges set status = 'cancelled'
       where id = ${rangeId} and company_id = ${companyId}
      returning *
    )
    select ${sql.unsafe(TALONARIO_COLUMNS)} from hecho r`;
  return ok(fila!);
}

/**
 * La serie con la que se emite un documento que consume control (E-01): la dicta el TALONARIO,
 * nunca el servidor.
 *
 * - `pedida` (la caja eligió, o la contingencia registra su papel): se usa tal cual; si no tiene
 *   talonario, el claim responde el 409 de E-17.
 * - si no, `preferida` (la serie de la factura que corrige una nota), si tiene papel;
 * - si no, el único talonario activo con papel; con varios, el primero por su «desde» — la caja
 *   manda siempre el suyo cuando hay más de uno.
 * - sin ninguno, el 409 de E-17 en palabras de persona.
 *
 * Los talonarios de contingencia (PA 102) no son papel de la caja: solo se usan si se piden.
 */
export async function serieDelTalonario(
  sql: TransactionSql,
  companyId: string,
  kind: string,
  pedida: string | null,
  preferida: string | null,
): Promise<Result<string, TalonarioError>> {
  if (pedida !== null) return ok(pedida);
  const disponibles = await sql<{ series: string }[]>`
    select r.series
      from public.fiscal_number_ranges r
     where r.company_id = ${companyId} and r.status = 'active'
       and r.next_available <= r.range_to
       and r.kind is distinct from 'retention_receipt'
       and not exists (select 1 from public.contingency_ranges cr
                        where cr.fiscal_number_range_id = r.id)
     group by r.series
     order by min(r.range_from)`;
  if (preferida !== null && disponibles.some((r) => r.series === preferida)) return ok(preferida);
  if (disponibles.length > 0) return ok(disponibles[0]!.series);
  const [ultimo] = await sql<{ printer_identifier: string }[]>`
    select printer_identifier from public.fiscal_number_ranges
     where company_id = ${companyId} and kind is distinct from 'retention_receipt'
     order by created_at desc limit 1`;
  return err({
    code: "FISCAL_NUMBERING_INVALID",
    details: { reason: "no_range" },
    message: `No quedan números de control para ${NOMBRE_CLASE[kind] ?? "documentos fiscales"} (identificador ${ultimo?.printer_identifier ?? "00"}). Carga el talonario nuevo.`,
  });
}

/**
 * EL ORDEN GLOBAL DE BLOQUEO DE LA EMISIÓN (ADR-0071, H2 y A1). Todo camino que emite un documento
 * con control toma, en este orden y nunca en otro:
 *
 *   1. el advisory de CLASE Y SERIE de `claim_document_number`
 *      (`hashtextextended(company|kind|series)`), que serializa el correlativo del documento;
 *   2. la fila del TALONARIO (`claim_fiscal_control`, FOR UPDATE);
 *   3. las EXISTENCIAS (kardex), si el documento mueve mercancía.
 *
 * Quién lo cumple:
 * - la venta POS y la factura de administración (`emitirVenta`): claim_document_number →
 *   claim_fiscal_control → issueStockBatchForSale;
 * - la NC directa y la ND (`createInvoiceLike`): claim_document_number → claim_fiscal_control, sin
 *   kardex;
 * - la devolución (`confirmReturn`): reingresa mercancía ANTES de emitir su NC, así que pide aquí 1 y
 *   2 por adelantado, antes del kardex; después `createInvoiceLike` los vuelve a pedir en la misma
 *   transacción, sin esperar (los dos son reentrantes).
 *
 * Sin el paso 1 aquí, la devolución (talonario → advisory) y una NC directa simultánea (advisory →
 * talonario) se esperarían en cruz (40P01). Sin talonario no se bloquea nada: el claim de después
 * responderá el 409 de E-17.
 */
export async function bloquearTalonario(
  sql: TransactionSql,
  companyId: string,
  kind: string,
  preferida: string | null,
): Promise<void> {
  const serie = await serieDelTalonario(sql, companyId, kind, null, preferida);
  if (!serie.ok) return;
  // 1. El MISMO advisory que claim_document_number para (empresa, clase, serie).
  await sql`
    select pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(${companyId}::text || '|' || ${kind} || '|' || ${serie.value}, 0))`;
  // 2. La fila del talonario que el claim va a consumir (mismo filtro, mismo orden).
  await sql`
    select r.id from public.fiscal_number_ranges r
     where r.company_id = ${companyId} and r.series = ${serie.value}
       and r.kind is distinct from 'retention_receipt'
       and r.status = 'active' and r.next_available <= r.range_to
     order by r.printer_identifier, r.range_from
     for update
     limit 1`;
}
