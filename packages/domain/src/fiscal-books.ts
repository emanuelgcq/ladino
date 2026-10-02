import { err, ok, type Result } from "@ladino/core";
import { parseDecimal } from "@ladino/money";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import type { ExportFiscalBookRequest } from "@ladino/schemas";
import { BookKind, formatearDocumento } from "@ladino/schemas";
import { RULES_VERSION } from "./create-company.js";
import { companyScope, type CompanyScopeError } from "./company-scope.js";

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
  | { code: "BOOK_FORMAT_UNAVAILABLE"; message: string };

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
export const BOOK_GENERATOR_VERSION = "fiscal-books/1.3.0";

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
    fn: "platform.sales_book_by_rate",
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
           iva_sin_clasificar::text as iva_sin_clasificar`,
  },
  compras: {
    // H6 (RLIVA arts. 72 y 75, P-59): el renglón de purchases_book más su base e IVA por alícuota.
    fn: "platform.purchases_book_by_rate",
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
           iva_sin_clasificar::text as iva_sin_clasificar`,
  },
  retenciones_iva: {
    fn: "platform.iva_retention_book",
    cols: `retention_id, receipt_number::int as receipt_number, receipt_series, fiscal_period,
           issued_on::text as issued_on, @@RIF(supplier_tax_id)@@, supplier_name,
           supplier_document_number, supplier_control_number,
           invoice_date::text as invoice_date, base_amount::text as base_amount,
           rate::text as rate, retained_amount::text as retained_amount,
           legal_source, receipt_status`,
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
 * (adaptador `txt_retenciones_iva`, migración 46 — is_official = FALSE).
 *
 * El layout sigue la guía pública del archivo TXT del SENIAT: una línea por
 * retención, campos separados por TABULADOR, sin cabecera. VALIDAR-SENIAT:
 * no está validado contra una carga real del portal, y lo dice el catálogo.
 *
 * TRES campos son DERIVADOS, no leídos, y uno es un supuesto declarado:
 *   · IVA de la factura = retenido ÷ porción (el libro guarda la porción
 *     retenida, 0.75 o 1.00, no el IVA entero);
 *   · alícuota = IVA ÷ base × 100, a 2 decimales;
 *   · monto total = base + IVA — SUPONE monto exento cero, porque el libro
 *     no separa la porción exenta de la factura del proveedor. Está en
 *     PENDIENTES_ASESOR.md; hasta validarlo, el campo «exento» va en 0.
 * Si la aritmética no es interpretable (porción cero, base cero), la línea
 * sale con los derivados VACÍOS en vez de con un número inventado.
 */
export function aTxtRetencionesIva(
  rows: Record<string, unknown>[],
  rifAgente: string,
  periodoDesde: string,
): string {
  // Período YYYYMM, del parámetro del run: el período ES la quincena o el mes
  // que el agente declara, no la fecha de cada comprobante.
  const periodo = periodoDesde.slice(0, 7).replace("-", "");
  const texto = (v: unknown): string =>
    typeof v === "string"
      ? // Texto libre (nombres, documentos) neutralizado contra fórmulas; el
        // separador es el tabulador, así que uno dentro del campo se quita.
        neutralizarCelda(v.replace(/[\t\r\n]/g, " "))
      : typeof v === "number"
        ? String(v)
        : "";
  const ddmmyyyy = (iso: string): string => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
  };
  const lineas: string[] = [];
  for (const r of rows) {
    const base = parseDecimal(texto(r["base_amount"]) || "0");
    const porcion = parseDecimal(texto(r["rate"]) || "0");
    const retenido = parseDecimal(texto(r["retained_amount"]) || "0");
    let alicuota = "";
    let montoTotal = "";
    if (base.ok && porcion.ok && retenido.ok && !porcion.value.isZero() && !base.value.isZero()) {
      const iva = retenido.value.dividedBy(porcion.value).toDecimalPlaces(2, 4);
      alicuota = iva.dividedBy(base.value).times(100).toDecimalPlaces(2, 4).toFixed(2);
      montoTotal = base.value.plus(iva).toDecimalPlaces(2, 4).toFixed(2);
    }
    // El nº de comprobante con la máscara de PA 102: período + correlativo a
    // 8 dígitos. Solo si el comprobante ya está emitido; si no, vacío.
    const numero = texto(r["receipt_number"]);
    const comprobante =
      numero === ""
        ? ""
        : `${(texto(r["fiscal_period"]) || periodo).replace("-", "")}${numero.padStart(8, "0")}`;
    lineas.push(
      [
        rifAgente,
        periodo,
        ddmmyyyy(texto(r["invoice_date"])),
        texto(r["supplier_document_number"]),
        "C",
        "01",
        texto(r["supplier_tax_id"]),
        texto(r["supplier_document_number"]),
        texto(r["supplier_control_number"]),
        montoTotal,
        base.ok ? base.value.toDecimalPlaces(2, 4).toFixed(2) : "",
        retenido.ok ? retenido.value.toDecimalPlaces(2, 4).toFixed(2) : "",
        "0",
        comprobante,
        "0.00",
        alicuota,
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
    const [empresa] = await sql<{ tax_id: string | null }[]>`
      select tax_id from public.companies where id = ${input.company_id}`;
    if (empresa?.tax_id == null || empresa.tax_id.trim() === "") {
      return err({
        code: "VALIDATION_FAILED",
        message:
          "El TXT de retenciones lleva el RIF del agente en cada línea y la empresa no tiene RIF cargado.",
      });
    }
    return ok({
      run: run!,
      book: libro,
      content: aTxtRetencionesIva(libro.rows, empresa.tax_id, input.period_from),
      content_type: "text/plain; charset=utf-8",
      filename: `retenciones-iva-${input.period_from}_${input.period_to}.txt`,
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
