import { err, ok, type Result } from "@ladino/core";
import { parseDecimal } from "@ladino/money";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import type { ExportFiscalBookRequest } from "@ladino/schemas";
import { BookKind, formatearDocumento } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";
import { exigeEmpresaConRif } from "./modo-venta.js";

/**
 * LIBROS FISCALES (ADR-0044) — RIGOR MÁXIMO.
 *
 * Un libro es un documento que el contribuyente entrega al SENIAT y que en una
 * fiscalización se compara **contra las facturas individuales**. Si no cuadra
 * con la suma de sus documentos origen es una infracción formal aunque sea por
 * error, y por eso el libro NO se escribe: se calcula desde los documentos cada
 * vez. Un libro que se escribe puede divergir de ellos, y la única forma de
 * saberlo sería… calcularlo.
 *
 * LO QUE ESTE MÓDULO NO DECIDE:
 *   · qué tratamiento tiene una línea lo dijo `platform.tax_treatment_of()` AL
 *     EMITIR, y está congelado en la línea. Aquí no se reinterpreta nada;
 *   · qué columnas lleva cada libro lo dicen las funciones de la migración 27;
 *   · el formato del fichero oficial NO EXISTE en el repositorio y no se
 *     inventa. Ver `ADAPTADORES_IMPLEMENTADOS`.
 *
 * Consultar no deja rastro. EXPORTAR sí, con los siete campos y el hash.
 */
export type FiscalBookError =
  | CompanyScopeError
  | { code: "VALIDATION_FAILED"; message: string }
  | { code: "BOOK_FORMAT_UNAVAILABLE"; message: string }
  | { code: "REGIME_KIND_NOT_ALLOWED"; message: string };

/**
 * La versión del generador, persistida en cada exportación.
 *
 * 1.1.0 (migración 20260928120000, L-01/L-07/R-2 ampliada): la NC de venta va en negativo, la
 * anulada en cero y el libro de compras trae el «ajuste de período anterior». El libro cambió
 * de significado: una reexportación de un período ya exportado da otro hash, y la versión dice
 * por qué (R-54).
 *
 * 1.2.0 (2026-09-28, P-02): el RIF de cliente y proveedor del CSV pasa por el formateador
 * compartido (`J-40888777-6`). Corrección (revisión 2026-09-28, hallazgo 1): hasta la
 * migración 20260928170100 el libro NO leía el snapshot del documento sino el maestro vivo;
 * desde ella, ventas lee el snapshot del documento y compras el de la factura. La proyección
 * trae el RIF NORMALIZADO, así que el hash no depende de la grafía; la pantalla y el CSV lo
 * formatean. Sin versión propia: 1.2.0 no llegó a publicarse y 1.3.0 (abajo) lo cubre.
 */
// 1.3.0 (ADR-0073, L-08 y hallazgo 6): los libros de ventas y de compras traen la base y el IVA
// por alícuota y el resumen del art. 72 del RLIVA, firmado en el hash; ventas trae además el
// identificador del control; y los dos hashes firman solo lo legal (B1: sin asiento ni estado de
// pago). Un libro de ventas o de compras regenerado de un período ya exportado cambia de hash.
// 1.4.0 (ADR-0072 §4 y §6, migración 20261002110000; H-04, H-12, L-03): el libro de compras trae el
// comprobante de retención emitido en el período (número, fecha, IVA retenido) y, si se emitió en
// otro período que su factura, un renglón propio «comprobante_retencion»; el libro de retenciones
// de IVA lee del comprobante-documento (identidad congelada, número de 14 dígitos, importes del
// documento) y el TXT sigue los 16 campos del instructivo (P-7). Cambian los dos hashes.
// 1.5.0 (auditoría fiscal 2.ª ronda, migración 20261002120200; H1 y H5): el libro de ventas saca
// la ND por IGTF de las bases y del resumen del art. 72 y la lleva aparte en `igtf_percibido`
// (PA SNAT/2022/000013 arts. 5-6, P-70), y registra el comprobante de retención SOPORTADO en el
// período de su entrega (número, fecha de entrega, IVA retenido; PA SNAT/2025/000054 art. 16 in
// fine), con renglón propio si la factura es de otro período. Cambia el hash del libro de ventas.
export const BOOK_GENERATOR_VERSION = "fiscal-books/1.5.0";

/**
 * Los adaptadores que este release SABE serializar.
 *
 * Esta lista y la tabla `book_format_adapters` son cosas distintas a propósito:
 * la tabla es el CATÁLOGO —qué formatos existen en el mundo— y esta lista es
 * qué sabe escribir el código de hoy. El día que se cargue el layout oficial del
 * SENIAT, su fila entrará en la tabla antes de que exista la implementación, y
 * pedir esa exportación tiene que fallar diciendo por qué en vez de devolver un
 * CSV con nombre de fichero oficial.
 *
 * Es el mismo principio de ADR-0038 y ADR-0039 aplicado al formato: la ausencia
 * se declara, no se rellena con lo más parecido.
 */
const ADAPTADORES_IMPLEMENTADOS = new Set<string>(["csv_columnas_legales", "txt_retenciones_iva"]);

/**
 * La proyección de cada libro, con TODO importe casteado a `text`.
 *
 * El casteo no es cosmético: sin él, `to_jsonb` convertiría los `numeric` en
 * números JSON y el importe pasaría por un double al llegar a JavaScript. Es la
 * regla 7 en el único punto del módulo donde podría romperse.
 *
 * Y el hash se calcula sobre ESTA misma proyección, no sobre la consulta cruda:
 * así lo que se firma es exactamente lo que se sirve.
 */
/**
 * El RIF de la contraparte, NORMALIZADO en la proyección (revisión 2026-09-28, hallazgo 1): la
 * misma expresión que `normalizarDocumento` y que los únicos del esquema. Así el hash del libro
 * no cambia si un snapshot viejo trae guiones y otro no.
 */
const rifNormalizado = (col: string): string =>
  `upper(regexp_replace(${col}, '[^a-zA-Z0-9]', '', 'g')) as ${col}`;

const PROYECCION_CRUDA: Record<BookKind, { fn: string; cols: string }> = {
  ventas: {
    // L-08 (RLIVA arts. 72 y 76): el renglón de sales_book más la base y el IVA POR ALÍCUOTA.
    // H1/H5 (1.5.0): más el IGTF percibido aparte y el comprobante soportado del período.
    fn: "platform.sales_book_with_receipts",
    cols: `document_id, issued_on::text as issued_on, kind, series,
           document_number::int as document_number, control_identifier,
           control_number::int as control_number,
           status, @@RIF(customer_tax_id)@@, customer_name, customer_taxpayer_type,
           transaction_currency, fx_rate::text as fx_rate,
           base_gravada::text as base_gravada, iva_debito::text as iva_debito,
           base_exenta::text as base_exenta, base_exonerada::text as base_exonerada,
           base_no_sujeta::text as base_no_sujeta,
           base_sin_clasificar::text as base_sin_clasificar,
           total_amount::text as total_amount, journal_entry_id,
           base_alicuota_general::text as base_alicuota_general,
           iva_alicuota_general::text as iva_alicuota_general,
           alicuota_general::text as alicuota_general,
           base_alicuota_adicional::text as base_alicuota_adicional,
           iva_alicuota_adicional::text as iva_alicuota_adicional,
           alicuota_adicional::text as alicuota_adicional,
           base_alicuota_reducida::text as base_alicuota_reducida,
           iva_alicuota_reducida::text as iva_alicuota_reducida,
           alicuota_reducida::text as alicuota_reducida,
           base_gravada_sin_alicuota::text as base_gravada_sin_alicuota,
           iva_sin_clasificar::text as iva_sin_clasificar,
           igtf_percibido::text as igtf_percibido,
           retention_receipt_number, retention_received_on::text as retention_received_on,
           retention_iva::text as retention_iva`,
  },
  compras: {
    // H6 (RLIVA arts. 72 y 75, P-59): el renglón de purchases_book más su base e IVA por alícuota.
    // H-12 (ADR-0072 §4): el renglón de purchases_book_by_rate más el comprobante de retención.
    fn: "platform.purchases_book_with_vouchers",
    cols: `invoice_id, invoice_date::text as invoice_date, @@RIF(supplier_tax_id)@@, supplier_name,
           supplier_kind, supplier_document_number, supplier_control_number,
           supplier_document_ref, status,
           transaction_currency, fx_rate::text as fx_rate,
           base_gravada::text as base_gravada, iva_credito::text as iva_credito,
           iva_al_costo::text as iva_al_costo, tax_is_recoverable,
           base_exenta::text as base_exenta, base_exonerada::text as base_exonerada,
           base_no_sujeta::text as base_no_sujeta,
           base_sin_clasificar::text as base_sin_clasificar,
           retenido_iva::text as retenido_iva, retenido_islr::text as retenido_islr,
           total_amount::text as total_amount, journal_entry_id,
           booked_on::text as booked_on, received_late,
           base_alicuota_general::text as base_alicuota_general,
           iva_alicuota_general::text as iva_alicuota_general,
           alicuota_general::text as alicuota_general,
           base_alicuota_adicional::text as base_alicuota_adicional,
           iva_alicuota_adicional::text as iva_alicuota_adicional,
           alicuota_adicional::text as alicuota_adicional,
           base_alicuota_reducida::text as base_alicuota_reducida,
           iva_alicuota_reducida::text as iva_alicuota_reducida,
           alicuota_reducida::text as alicuota_reducida,
           base_gravada_sin_alicuota::text as base_gravada_sin_alicuota,
           iva_sin_clasificar::text as iva_sin_clasificar,
           retention_voucher_number, retention_voucher_date::text as retention_voucher_date,
           retention_voucher_iva::text as retention_voucher_iva`,
  },
  retenciones_iva: {
    // ADR-0072 §4 y §6: del comprobante-documento, con la identidad congelada al emitir.
    fn: "platform.iva_retention_book",
    cols: `retention_id, voucher_id, voucher_number, version_no,
           receipt_number::int as receipt_number, receipt_series, fiscal_period,
           issued_on::text as issued_on, delivered_on::text as delivered_on,
           delivery_due_on::text as delivery_due_on, @@RIF(supplier_tax_id)@@, supplier_name,
           supplier_address, document_type, supplier_document_number, supplier_control_number,
           affected_document, invoice_date::text as invoice_date,
           total_amount::text as total_amount, base_amount::text as base_amount,
           exempt_amount::text as exempt_amount, iva_amount::text as iva_amount,
           tax_rate::text as tax_rate, rate::text as rate,
           retained_amount::text as retained_amount, legal_source, receipt_status,
           original_issued_on::text as original_issued_on, declared_before`,
  },
  retenciones_islr: {
    fn: "platform.islr_retention_book",
    cols: `retention_id, receipt_number::int as receipt_number, receipt_series, fiscal_period,
           issued_on::text as issued_on, @@RIF(supplier_tax_id)@@, supplier_name, concept_code,
           concept_name, formula_kind, supplier_document_number,
           invoice_date::text as invoice_date, base_amount::text as base_amount,
           rate::text as rate, subtrahend::text as subtrahend,
           retained_amount::text as retained_amount, legal_source, receipt_status`,
  },
};

/** La proyección que se sirve y se firma: la cruda con el RIF de la contraparte normalizado. */
const PROYECCION: Record<BookKind, { fn: string; cols: string }> = Object.fromEntries(
  Object.entries(PROYECCION_CRUDA).map(([k, p]) => [
    k,
    {
      fn: p.fn,
      cols: p.cols.replace(/@@RIF\((\w+)\)@@/g, (_m, col: string) => rifNormalizado(col)),
    },
  ]),
) as Record<BookKind, { fn: string; cols: string }>;

/**
 * El resumen del art. 72 del RLIVA (L-08, H6, hallazgo 6): la MISMA proyección para la pantalla,
 * el fichero del resumen y el hash. Existe para los libros de ventas y de compras.
 */
const RESUMEN_COLS = `concept, rate::text as rate, base::text as base, tax::text as tax,
  adjustments_base::text as adjustments_base, adjustments_tax::text as adjustments_tax,
  documents::int as documents`;
const RESUMEN_CABECERAS = [
  "concept",
  "rate",
  "base",
  "tax",
  "adjustments_base",
  "adjustments_tax",
  "documents",
];
/** Los libros con resumen del art. 72 (ventas; compras por la lectura conservadora de P-59). */
const FUNCION_RESUMEN: Partial<Record<BookKind, string>> = {
  ventas: "platform.sales_book_summary",
  compras: "platform.purchases_book_summary",
};
/** El nombre del fichero del resumen de cada libro. */
function nombreDelResumen(kind: BookKind): string {
  return kind === "ventas" ? "resumen-art72.csv" : `resumen-art72-${kind}.csv`;
}
/** El rótulo del resumen: en el dataset firmado y en la primera línea de `resumen-art72*.csv`. */
export const ROTULO_RESUMEN_CSV = "RESUMEN (RLIVA art. 72)";

export interface LibroLeido {
  readonly book_kind: BookKind;
  readonly period_from: string;
  readonly period_to: string;
  readonly currency: string;
  readonly rows: Record<string, unknown>[];
  readonly row_count: number;
  readonly unclassified_rows: number;
  /** Solo en los libros de ventas y de compras: el resumen del art. 72 del RLIVA (L-08, hallazgo 6). */
  readonly summary?: Record<string, unknown>[];
}

/**
 * Lee un libro. Es una CONSULTA: no escribe, no audita, no deja rastro.
 *
 * Se exporta porque la pantalla y la exportación tienen que leer exactamente lo
 * mismo. Dos caminos que construyen el libro por su cuenta acaban dando dos
 * libros, y el que se presenta es el que nadie miró.
 */
export async function readFiscalBook(
  sql: TransactionSql,
  companyId: string,
  kind: BookKind,
  from: string,
  to: string,
): Promise<LibroLeido> {
  const p = PROYECCION[kind];
  const rows = await sql<Record<string, unknown>[]>`
    select ${sql.unsafe(p.cols)}
      from ${sql.unsafe(p.fn)}(${companyId}, ${from}::date, ${to}::date)`;
  const [empresa] = await sql<{ moneda: string }[]>`
    select functional_currency_code as moneda from public.companies where id = ${companyId}`;

  // Sin clasificar: lo emitido antes de la migración 27. Se cuenta y se sube a
  // la cabecera para que la pantalla avise sin recorrer las filas.
  // El «distinto de cero» se comprueba sobre el STRING, no con parseFloat: la
  // regla 7 no tiene excepción para comparaciones, y una que hoy solo mira si
  // es cero es la que mañana alguien reutiliza para sumar.
  const esCero = (v: unknown): boolean => typeof v === "string" && /^-?0*(?:\.0*)?$/.test(v);
  // F6: también lo gravado que ninguna alícuota explica y el IVA sin clasificar (libros por
  // alícuota): un renglón con cualquiera de los tres distinto de cero es un renglón sin clasificar.
  const distintoDeCero = (v: unknown): boolean => typeof v === "string" && v !== "" && !esCero(v);
  const sinClasificar = rows.filter(
    (r) =>
      distintoDeCero(r["base_sin_clasificar"]) ||
      distintoDeCero(r["base_gravada_sin_alicuota"]) ||
      distintoDeCero(r["iva_sin_clasificar"]),
  ).length;

  // El RESUMEN del art. 72 del RLIVA (L-08): base e IVA por alícuota, exentas, exoneradas, no
  // sujetas y ajustes por notas. Se calcula en la base, con el mismo signo que el libro.
  const fnResumen = FUNCION_RESUMEN[kind];
  const resumen =
    fnResumen !== undefined
      ? await sql<Record<string, unknown>[]>`
          select ${sql.unsafe(RESUMEN_COLS)}
            from ${sql.unsafe(fnResumen)}(${companyId}, ${from}::date, ${to}::date)`
      : undefined;

  return {
    book_kind: kind,
    period_from: from,
    period_to: to,
    currency: empresa?.moneda ?? "",
    rows,
    row_count: rows.length,
    unclassified_rows: sinClasificar,
    ...(resumen === undefined ? {} : { summary: resumen }),
  };
}

/**
 * El hash del dataset, calculado EN POSTGRES sobre la misma proyección que se
 * sirve. Se ordena por el texto de la fila y no por el orden de la consulta:
 * dos exportaciones del mismo período tienen que dar el mismo hash aunque el
 * plan cambie de orden entre ellas.
 */
async function hashDelDataset(
  sql: TransactionSql,
  companyId: string,
  kind: BookKind,
  from: string,
  to: string,
): Promise<{ hash: string; n: number }> {
  const p = PROYECCION[kind];
  // H6 (RLIVA art. 72, decidido por criterio): en ventas, lo que se firma son los renglones Y el
  // resumen, separados por su rótulo. Un resumen que cambia cambia el hash.
  const fnResumen = FUNCION_RESUMEN[kind];
  const resumen =
    fnResumen !== undefined
      ? sql`(select chr(10) || ${ROTULO_RESUMEN_CSV} || chr(10)
               || coalesce(string_agg(to_jsonb(s)::text, chr(10) order by to_jsonb(s)::text), '')
               from (select ${sql.unsafe(RESUMEN_COLS)}
                       from ${sql.unsafe(fnResumen)}(${companyId}, ${from}::date,
                                                     ${to}::date)) s)`
      : sql`''`;
  // B1 (decidido por criterio): en ventas, el hash firma el LIBRO LEGAL. Fuera `journal_entry_id`
  // (contabilidad, no libro) y el `status` operativo: entra solo el estado legal, «anulada» o
  // «vigente». Cobrar una factura (issued → paid) o asentarla no cambia el hash. Alternativa:
  // guardar aparte el hash del resumen en la generación.
  // Compras, igual (re-revisión, 2026-10-02): pagar una factura de proveedor (posted → paid) no
  // cambia el hash. El «ajuste de período anterior» SÍ es un estado legal del libro y se conserva.
  // Los libros de retenciones no firman ni asiento ni estado de pago (su `receipt_status` es el
  // del comprobante: borrador, emitido, anulado) y quedan como estaban.
  const fila =
    kind === "ventas"
      ? sql`(to_jsonb(f) - 'journal_entry_id' - 'status')
              || jsonb_build_object('estado_legal',
                   case when f.status = 'annulled' then 'anulada' else 'vigente' end)`
      : kind === "compras"
        ? sql`(to_jsonb(f) - 'journal_entry_id' - 'status')
              || jsonb_build_object('estado_legal',
                   case f.status when 'annulled' then 'anulada'
                                 when 'ajuste_periodo_anterior' then 'ajuste_periodo_anterior'
                                 when 'comprobante_retencion' then 'comprobante_retencion'
                                 else 'vigente' end)`
        : sql`to_jsonb(f)`;
  const [r] = await sql<{ h: string; n: number }[]>`
    with filas as (
      select ${sql.unsafe(p.cols)}
        from ${sql.unsafe(p.fn)}(${companyId}, ${from}::date, ${to}::date)
    ),
    firmadas as (select (${fila})::text as t from filas f)
    select count(*)::int as n,
           encode(sha256(convert_to(
             coalesce(string_agg(t, chr(10) order by t), '')
               || ${resumen},
             'utf8')), 'hex') as h
      from firmadas`;
  return { hash: r?.h ?? "", n: r?.n ?? 0 };
}

/**
 * Serializa a CSV.
 *
 * Las cabeceras son los NOMBRES DE COLUMNA del libro, no rótulos en prosa
 * parecidos a los de un formulario oficial. Es deliberado: este adaptador está
 * marcado `is_official = false`, y ponerle cabeceras con aspecto oficial haría
 * que un fichero que el SENIAT rechazaría pareciera el que espera.
 */
/**
 * Una celda que empieza por `=`, `+`, `-`, `@`, tabulador o retorno la
 * interpreta Excel/LibreOffice como FÓRMULA al abrir el fichero. Los nombres
 * de cliente y de proveedor los escribe un usuario (o vienen de la factura
 * del proveedor): un cliente llamado `=HYPERLINK(...)` ejecutaría en la
 * máquina del contador (auditoría 2026-09-11, M-21). Se antepone un
 * apóstrofo, que es la neutralización estándar (OWASP CSV injection); los
 * números de la proyección nunca empiezan así salvo los negativos, que
 * también se protegen y siguen leyéndose.
 */
export function neutralizarCelda(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

function aCsv(rows: Record<string, unknown>[], cabeceras: string[]): string {
  const escapar = (v: unknown): string => {
    // Solo lo que la proyección puede producir: string, number, boolean o null.
    // Un `String(v)` genérico escribiría `[object Object]` en una celda de un
    // libro fiscal, y una celda ilegible es peor que una vacía declarada.
    if (v === null || v === undefined) return "";
    const s =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    // Los importes (number o string numérico) no se tocan: solo el texto libre.
    const protegido = typeof v === "string" && !/^-?\d+(\.\d+)?$/.test(s) ? neutralizarCelda(s) : s;
    return /[",\n\r]/.test(protegido) ? `"${protegido.replace(/"/g, '""')}"` : protegido;
  };
  const lineas = [cabeceras.join(",")];
  // El RIF de la contraparte llega NORMALIZADO de la proyección (el hash no depende de la
  // grafía) y sale con la función compartida (P-02, M-05), `J-40888777-6`, igual que en la
  // pantalla de Libros.
  const celda = (r: Record<string, unknown>, c: string): unknown => {
    const v = r[c];
    return c.endsWith("_tax_id") && typeof v === "string" ? formatearDocumento(v) : v;
  };
  for (const r of rows) lineas.push(cabeceras.map((c) => escapar(celda(r, c))).join(","));
  return lineas.join("\r\n");
}

/**
 * Serializa el TXT de retenciones de IVA PRACTICADAS para la carga del agente
 * (adaptador `txt_retenciones_iva` — is_official = FALSE).
 *
 * EL LAYOUT ES EL DE P-7 (PENDIENTES_ASESOR.md, L-03; ADR-0072 §6), leído del instructivo SENIAT
 * «Declaración retenciones de IVA», versión 3_0_0 (septiembre 2020): 16 campos separados por
 * TABULADOR, una línea por renglón de comprobante, sin cabecera, decimales con punto:
 *
 *    1 RIF del agente, sin guiones      9 monto del documento
 *    2 período AAAAMM                  10 base imponible
 *    3 fecha del documento AAAA-MM-DD  11 IVA retenido
 *    4 C (compra)                      12 documento afectado («0» si no aplica)
 *    5 tipo: 01 factura, 02 ND, 03 NC  13 comprobante (14 dígitos, PA SNAT/2025/000054 art. 16)
 *    6 RIF de la contraparte           14 monto exento
 *    7 número del documento            15 alícuota
 *    8 número de control               16 expediente («0»)
 *
 * Hasta el 2026-10-02 salían 17 campos (un número de documento de más en la 4.ª posición), la
 * fecha en DD/MM/AAAA, el RIF con guiones, el tipo «01» fijo y tres importes DERIVADOS de la
 * porción. Ahora todo se LEE del comprobante (migración 20261002110000): nada se deriva.
 *
 * El período es el MES del parámetro: la quincena la elige la declaración, no el archivo
 * (respuesta del dueño, L-03); el libro ya trae solo los comprobantes emitidos en el rango pedido.
 * Una versión ANULADA (reemplazada por una corrección) no se declara. Un dato que falta sale
 * VACÍO, nunca inventado. VALIDAR-SENIAT (P-7): carga real en el portal; los importes y la
 * alícuota salen con 2 decimales, que P-7 no fija.
 */
/**
 * H4 (decidido por criterio, evitar el doble enteramiento): una versión >= 2 de un comprobante cuya
 * versión 1 se emitió ANTES del período ya se declaró en el suyo. No vuelve a salir en el TXT; la
 * exportación lo avisa. VALIDAR-SENIAT P-65 (¿se declara la línea corregida en la quincena
 * siguiente, y cómo se trata la errónea para no enterar dos veces?). Alternativa: declararla en la
 * quincena siguiente.
 */
function yaDeclarada(r: Record<string, unknown>, _periodoDesde: string): boolean {
  // A-1 (re-revisión): por RENGLÓN, no por versión. `declared_before` lo calcula el libro con su
  // `p_from`: la misma retención ya figuraba en otra versión de su cadena emitida antes del período.
  // Una retención nueva en una corrección no lo tiene, y sale.
  return r["declared_before"] === true;
}

/**
 * H9 de la auditoría fiscal (instructivo, campo 15; decidido por criterio: no emitir lo que el portal
 * probablemente rechaza). Los documentos con IVA y SIN alícuota única (varias alícuotas) que irían
 * en el TXT. Con alguno, la exportación da 422 con la lista. VALIDAR-SENIAT P-69.
 * Alternativa: una línea por alícuota, o el campo vacío.
 */
export function documentosConVariasAlicuotas(
  rows: Record<string, unknown>[],
  periodoDesde: string,
): string[] {
  const conIva = (v: unknown): boolean =>
    typeof v === "string" && v !== "" && !/^-?0*(?:\.0*)?$/.test(v);
  return rows
    .filter(
      (r) =>
        r["receipt_status"] !== "annulled" &&
        !yaDeclarada(r, periodoDesde) &&
        (r["tax_rate"] === null || r["tax_rate"] === undefined || r["tax_rate"] === "") &&
        conIva(r["iva_amount"]),
    )
    .map((r) => `${comoTexto(r["supplier_document_number"])} (${comoTexto(r["supplier_tax_id"])})`);
}

/** Un campo de la fila como texto: lo que no es texto ni número sale vacío, nunca «[object Object]». */
function comoTexto(v: unknown): string {
  return typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
}

/** Las correcciones de comprobantes de períodos anteriores que el TXT deja fuera (H4). */
export function correccionesYaDeclaradas(
  rows: Record<string, unknown>[],
  periodoDesde: string,
): string[] {
  return rows
    .filter((r) => r["receipt_status"] !== "annulled" && yaDeclarada(r, periodoDesde))
    .map((r) => comoTexto(r["voucher_number"]));
}

export function aTxtRetencionesIva(
  rows: Record<string, unknown>[],
  rifAgente: string,
  periodoDesde: string,
): string {
  const periodo = periodoDesde.slice(0, 7).replace("-", "");
  const texto = (v: unknown): string =>
    typeof v === "string"
      ? // Texto libre neutralizado contra fórmulas; el separador es el tabulador, así que uno
        // dentro del campo se quita.
        neutralizarCelda(v.replace(/[\t\r\n]/g, " "))
      : typeof v === "number"
        ? String(v)
        : "";
  // RIF sin guiones ni espacios, en mayúsculas: J999999999 (P-7, campo 1 y 6).
  const rif = (v: unknown): string =>
    typeof v === "string" ? v.replace(/[^a-zA-Z0-9]/g, "").toUpperCase() : "";
  // Fecha AAAA-MM-DD (P-7, campo 3): la del documento tal cual, sin hora.
  const fecha = (v: unknown): string => {
    const m = typeof v === "string" ? /^(\d{4}-\d{2}-\d{2})/.exec(v) : null;
    return m ? m[1]! : "";
  };
  // Importe con punto decimal y 2 decimales; vacío si no hay dato.
  const importe = (v: unknown): string => {
    const t = typeof v === "string" ? v : "";
    if (t === "") return "";
    const d = parseDecimal(t);
    return d.ok ? d.value.toDecimalPlaces(2, 4).toFixed(2) : "";
  };
  const lineas: string[] = [];
  for (const r of rows) {
    if (r["receipt_status"] === "annulled") continue;
    if (yaDeclarada(r, periodoDesde)) continue;
    // El comprobante de 14 dígitos (art. 16). Las retenciones anteriores al comprobante-documento
    // conservan su correlativo viejo con el período delante; sin número, el campo va vacío.
    const voucher = texto(r["voucher_number"]);
    const numeroViejo = texto(r["receipt_number"]);
    const comprobante = /^\d{14}$/.test(voucher)
      ? voucher
      : numeroViejo === ""
        ? ""
        : `${(texto(r["fiscal_period"]) || periodo).replace("-", "")}${numeroViejo.padStart(8, "0")}`;
    const tipo = texto(r["document_type"]);
    const afectado = texto(r["affected_document"]);
    lineas.push(
      [
        rif(rifAgente),
        periodo,
        fecha(r["invoice_date"]),
        "C",
        /^0[1-6]$/.test(tipo) ? tipo : "",
        rif(r["supplier_tax_id"]),
        texto(r["supplier_document_number"]),
        texto(r["supplier_control_number"]),
        importe(r["total_amount"]),
        importe(r["base_amount"]),
        importe(r["retained_amount"]),
        afectado === "" ? "0" : afectado,
        comprobante,
        importe(r["exempt_amount"]),
        importe(r["tax_rate"]),
        "0",
      ].join("\t"),
    );
  }
  return lineas.join("\r\n");
}

/**
 * Las cabeceras salen de la proyección CRUDA (B4, re-revisión 2026-09-28): el token
 * `@@RIF(col)@@` no lleva comas, así que el `split(",")` de siempre vale; la expandida sí las
 * lleva dentro de su `regexp_replace`. Exportada solo para el test que fija las cuatro listas.
 */
export function cabecerasDe(kind: BookKind): string[] {
  return PROYECCION_CRUDA[kind].cols
    .replace(/@@RIF\((\w+)\)@@/g, "$1")
    .split(",")
    .map((c) => {
      const t = c.trim().replace(/\s+/g, " ");
      const alias = / as (\w+)$/i.exec(t);
      return alias ? alias[1]! : t;
    })
    .filter((c) => c.length > 0);
}

export interface ExportacionHecha {
  readonly run: Record<string, unknown>;
  readonly book: LibroLeido;
  readonly content: string;
  readonly content_type: string;
  readonly filename: string;
  /** Solo en ventas y compras: el resumen del art. 72 de ESTA generación (B1), en la misma respuesta. */
  readonly summary_content?: string;
  readonly summary_filename?: string;
  /** Avisos de la exportación (H4: correcciones ya declaradas que el TXT deja fuera). */
  readonly warnings?: string[];
}

/**
 * EXPORTA un libro y deja su rastro reproducible.
 *
 * El orden importa: primero se lee el libro y se calcula el hash, y solo
 * después se inserta la fila. Al revés, un fallo de la consulta dejaría una
 * generación registrada de un libro que nunca se produjo.
 */
export async function exportFiscalBook(
  uow: UnitOfWork,
  input: ExportFiscalBookRequest,
): Promise<Result<ExportacionHecha, FiscalBookError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Exportar un libro fiscal exige un usuario real: la generación se firma con nombre.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "fiscal_book.export");
  if (!scope.ok) return scope;
  // AF3-13: una empresa sin RIF no genera libros (ni el de compras con su IVA al costo).
  const conRif = await exigeEmpresaConRif(sql, input.company_id);
  if (!conRif.ok) return conRif;
  if (scope.value.companyStatus === "suspended") {
    return err({ code: "COMPANY_SUSPENDED", message: "La empresa está suspendida." });
  }
  if (input.period_to < input.period_from) {
    return err({
      code: "VALIDATION_FAILED",
      message: "El período termina antes de empezar.",
    });
  }

  const [adaptador] = await sql<{ is_official: boolean; status: string; book_kind: string }[]>`
    select is_official, status, book_kind from public.book_format_adapters
     where code = ${input.format_code}`;
  if (!adaptador) {
    return err({
      code: "BOOK_FORMAT_UNAVAILABLE",
      message: `El formato «${input.format_code}» no está en el catálogo de adaptadores.`,
    });
  }
  if (adaptador.status !== "active") {
    return err({
      code: "BOOK_FORMAT_UNAVAILABLE",
      message: `El formato «${input.format_code}» está inactivo.`,
    });
  }
  if (adaptador.book_kind !== "todos" && adaptador.book_kind !== input.book_kind) {
    return err({
      code: "VALIDATION_FAILED",
      message: `El formato «${input.format_code}» no sirve para el libro de ${input.book_kind}.`,
    });
  }
  // LAD65. Una fila en el catálogo NO es una implementación: el layout oficial
  // se cargará como dato antes de que exista el código que lo escribe, y
  // devolver un CSV cuando piden el fichero oficial sería peor que fallar.
  if (!ADAPTADORES_IMPLEMENTADOS.has(input.format_code)) {
    return err({
      code: "BOOK_FORMAT_UNAVAILABLE",
      message: `LAD65: el adaptador «${input.format_code}» está en el catálogo pero no tiene implementación cargada en este release. No se exporta un fichero que aparente ser el que no es.`,
    });
  }

  const libro = await readFiscalBook(
    sql,
    input.company_id,
    input.book_kind,
    input.period_from,
    input.period_to,
  );
  const { hash, n } = await hashDelDataset(
    sql,
    input.company_id,
    input.book_kind,
    input.period_from,
    input.period_to,
  );

  // A-4: lo que impide el TXT se comprueba ANTES de registrar la generación. `withTransaction`
  // commitea aunque el caso de uso devuelva `err`: un 422 después del INSERT dejaba una fila en
  // `fiscal_book_runs` de un fichero que nunca se entregó.
  let rifAgente = "";
  if (input.format_code === "txt_retenciones_iva") {
    const [empresa] = await sql<{ tax_id: string | null }[]>`
      select tax_id from public.companies where id = ${input.company_id}`;
    if (empresa?.tax_id == null || empresa.tax_id.trim() === "") {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "El TXT de retenciones lleva el RIF del agente en cada línea y la empresa no tiene RIF cargado.",
      });
    }
    rifAgente = empresa.tax_id;
    const mixtos = documentosConVariasAlicuotas(libro.rows, input.period_from);
    if (mixtos.length > 0) {
      return err({
        code: "VALIDATION_FAILED",
        message: `El TXT no se genera: ${mixtos.length} documento(s) llevan más de una alícuota y el instructivo pide una sola en el campo 15 (${mixtos.join(", ")}). Está consultado con el asesor (P-69); mientras, declara esos documentos a mano en el portal.`,
      });
    }
  }

  const parametros: Record<string, JSONValue> = {
    book_kind: input.book_kind,
    period_from: input.period_from,
    period_to: input.period_to,
    format_code: input.format_code,
    timezone: input.timezone,
    // Cuántos renglones no se pudieron clasificar, DENTRO de los parámetros
    // firmados: si mañana ese número cambia para el mismo período, el hash lo
    // delata junto con el resto.
    unclassified_rows: libro.unclassified_rows,
  };

  const [run] = await sql<Record<string, unknown>[]>`
    insert into public.fiscal_book_runs
      (tenant_id, company_id, book_kind, period_from, period_to, parameters, timezone,
       generator_version, dataset_hash, row_count, format_code)
    values (${scope.value.tenantId}, ${input.company_id}, ${input.book_kind},
            ${input.period_from}::date, ${input.period_to}::date, ${sql.json(parametros)},
            ${input.timezone}, ${BOOK_GENERATOR_VERSION}, ${hash}, ${n}, ${input.format_code})
    returning id, company_id, book_kind, period_from::text as period_from,
              period_to::text as period_to, parameters, timezone, generator_version,
              dataset_hash, row_count, format_code, created_by,
              to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at`;

  await sql`
    insert into public.audit_events
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type,
       actor_type, occurred_at, rules_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'fiscal_book_run',
            ${run!["id"] as string}, 'fiscal.book.exported', 'user', now(), ${RULES_VERSION},
            ${sql.json({ ...parametros, dataset_hash: hash, row_count: n })})`;
  await sql`
    insert into public.outbox
      (tenant_id, company_id, aggregate_type, aggregate_id, event_type, schema_version, payload)
    values (${scope.value.tenantId}, ${input.company_id}, 'fiscal_book_run',
            ${run!["id"] as string}, 'fiscal.book.exported', 1,
            ${sql.json({ id: run!["id"] as string, ...parametros, dataset_hash: hash })})`;

  // La serialización, según el adaptador pedido. La rama vive DESPUÉS del run:
  // lo que se firma es el dataset, y el fichero es una vista de él.
  if (input.format_code === "txt_retenciones_iva") {
    const fuera = correccionesYaDeclaradas(libro.rows, input.period_from);
    return ok({
      run: run!,
      book: libro,
      content: aTxtRetencionesIva(libro.rows, rifAgente, input.period_from),
      content_type: "text/plain; charset=utf-8",
      filename: `retenciones-iva-${input.period_from}_${input.period_to}.txt`,
      ...(fuera.length === 0
        ? {}
        : {
            warnings: [
              `${fuera.length} corrección(es) de comprobantes declarados en un período anterior no van en este TXT (${fuera.join(", ")}): ya se declararon. Consulta con tu asesor si hace falta una declaración sustitutiva (P-65).`,
            ],
          }),
    });
  }

  const cabeceras = cabecerasDe(input.book_kind);
  return ok({
    run: run!,
    book: libro,
    // H6 (decidido por criterio): el CSV «columnas legales» es solo cabecera + renglones, legible
    // por máquina. El resumen del art. 72 va firmado en el hash y se descarga como fichero propio
    // de esta misma generación (exportSalesBookSummary). Alternativa: bloque al final de este CSV.
    content: aCsv(libro.rows, cabeceras),
    content_type: "text/csv; charset=utf-8",
    filename: `libro-${input.book_kind}-${input.period_from}_${input.period_to}.csv`,
    // B1: en ventas, el resumen del art. 72 de esta misma generación, leído en la MISMA
    // transacción que el libro y el hash. La ruta hermana queda para volver a descargarlo.
    ...(libro.summary === undefined
      ? {}
      : {
          summary_content: serializarResumen(libro.summary),
          summary_filename: nombreDelResumen(input.book_kind),
        }),
  });
}

/** `resumen-art72.csv`: el rótulo, las cabeceras y las filas del resumen. */
function serializarResumen(filas: Record<string, unknown>[]): string {
  return ROTULO_RESUMEN_CSV + "\r\n" + aCsv(filas, RESUMEN_CABECERAS);
}

export interface ResumenExportado {
  readonly run_id: string;
  readonly dataset_hash: string;
  readonly content: string;
  readonly content_type: string;
  readonly filename: string;
}

/**
 * El resumen del art. 72 del RLIVA (L-08, H6) como fichero PROPIO de una generación ya exportada
 * del libro de ventas o de compras (`resumen-art72.csv`, `resumen-art72-compras.csv`). No crea otra
 * generación ni toca la firmada. Antes de
 * servirlo recalcula el hash del período y lo compara con el del run: si el libro cambió desde
 * entonces, el resumen ya no es el de esa generación y no se sirve (hay que volver a exportar).
 */
export async function exportSalesBookSummary(
  uow: UnitOfWork,
  input: { company_id: string; run_id: string },
): Promise<Result<ResumenExportado, FiscalBookError>> {
  const { sql, actor } = uow;
  if (actor.kind !== "user") {
    return err({
      code: "PERMISSION_REQUIRED",
      message: "Descargar el resumen de un libro fiscal exige un usuario real.",
    });
  }
  const scope = await companyScope(sql, actor.userId, input.company_id, "fiscal_book.export");
  if (!scope.ok) return scope;
  const [run] = await sql<
    {
      id: string;
      book_kind: string;
      period_from: string;
      period_to: string;
      dataset_hash: string;
      generator_version: string;
    }[]
  >`
    select id, book_kind, period_from::text as period_from, period_to::text as period_to,
           dataset_hash, generator_version
      from public.fiscal_book_runs
     where id = ${input.run_id} and company_id = ${input.company_id}`;
  if (!run) return err({ code: "NOT_FOUND", message: "Recurso no encontrado." });
  const kind = BookKind.safeParse(run.book_kind);
  const fnResumen = kind.success ? FUNCION_RESUMEN[kind.data] : undefined;
  if (!kind.success || fnResumen === undefined) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        "El resumen del art. 72 es de los libros de ventas y de compras: esta generación es de " +
        "otro libro.",
    });
  }
  // B1 (c): con otra versión del generador el hash no es comparable; se dice eso, no «cambió».
  if (run.generator_version !== BOOK_GENERATOR_VERSION) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        `Esa generación es de otra versión del generador (${run.generator_version}): exporta de ` +
        "nuevo el libro y descarga su resumen.",
    });
  }
  const { hash } = await hashDelDataset(
    sql,
    input.company_id,
    kind.data,
    run.period_from,
    run.period_to,
  );
  if (hash !== run.dataset_hash) {
    return err({
      code: "VALIDATION_FAILED",
      message:
        `El libro de ${kind.data} cambió desde esa generación: vuelve a exportarlo y descarga el ` +
        "resumen " +
        "de la nueva.",
    });
  }
  const resumen = await sql<Record<string, unknown>[]>`
    select ${sql.unsafe(RESUMEN_COLS)}
      from ${sql.unsafe(fnResumen)}(${input.company_id}, ${run.period_from}::date,
                                    ${run.period_to}::date)`;
  return ok({
    run_id: run.id,
    dataset_hash: run.dataset_hash,
    content: serializarResumen(resumen),
    content_type: "text/csv; charset=utf-8",
    filename: nombreDelResumen(kind.data),
  });
}
