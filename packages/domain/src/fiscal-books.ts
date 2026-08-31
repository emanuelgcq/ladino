import { err, ok, type Result } from "@ladino/core";
import type { UnitOfWork, TransactionSql, JSONValue } from "@ladino/db";
import type { ExportFiscalBookRequest, BookKind } from "@ladino/schemas";
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

/** La versión del generador, persistida en cada exportación. */
export const BOOK_GENERATOR_VERSION = "fiscal-books/1.0.0";

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
const ADAPTADORES_IMPLEMENTADOS = new Set<string>(["csv_columnas_legales"]);

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
const PROYECCION: Record<BookKind, { fn: string; cols: string }> = {
  ventas: {
    fn: "platform.sales_book",
    cols: `document_id, issued_on::text as issued_on, kind, series,
           document_number::int as document_number, control_number::int as control_number,
           status, customer_tax_id, customer_name, customer_taxpayer_type,
           transaction_currency, fx_rate::text as fx_rate,
           base_gravada::text as base_gravada, iva_debito::text as iva_debito,
           base_exenta::text as base_exenta, base_exonerada::text as base_exonerada,
           base_no_sujeta::text as base_no_sujeta,
           base_sin_clasificar::text as base_sin_clasificar,
           total_amount::text as total_amount, journal_entry_id`,
  },
  compras: {
    fn: "platform.purchases_book",
    cols: `invoice_id, invoice_date::text as invoice_date, supplier_tax_id, supplier_name,
           supplier_kind, supplier_document_number, supplier_control_number,
           supplier_document_ref, status,
           base_gravada::text as base_gravada, iva_credito::text as iva_credito,
           iva_al_costo::text as iva_al_costo, tax_is_recoverable,
           base_exenta::text as base_exenta, base_exonerada::text as base_exonerada,
           base_no_sujeta::text as base_no_sujeta,
           base_sin_clasificar::text as base_sin_clasificar,
           retenido_iva::text as retenido_iva, retenido_islr::text as retenido_islr,
           total_amount::text as total_amount, journal_entry_id`,
  },
  retenciones_iva: {
    fn: "platform.iva_retention_book",
    cols: `retention_id, receipt_number::int as receipt_number, receipt_series, fiscal_period,
           issued_on::text as issued_on, supplier_tax_id, supplier_name,
           supplier_document_number, supplier_control_number,
           invoice_date::text as invoice_date, base_amount::text as base_amount,
           rate::text as rate, retained_amount::text as retained_amount,
           legal_source, receipt_status`,
  },
  retenciones_islr: {
    fn: "platform.islr_retention_book",
    cols: `retention_id, receipt_number::int as receipt_number, receipt_series, fiscal_period,
           issued_on::text as issued_on, supplier_tax_id, supplier_name, concept_code,
           concept_name, formula_kind, supplier_document_number,
           invoice_date::text as invoice_date, base_amount::text as base_amount,
           rate::text as rate, subtrahend::text as subtrahend,
           retained_amount::text as retained_amount, legal_source, receipt_status`,
  },
};

export interface LibroLeido {
  readonly book_kind: BookKind;
  readonly period_from: string;
  readonly period_to: string;
  readonly currency: string;
  readonly rows: Record<string, unknown>[];
  readonly row_count: number;
  readonly unclassified_rows: number;
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
  const sinClasificar = rows.filter((r) => {
    const v = r["base_sin_clasificar"];
    return typeof v === "string" && v !== "" && !esCero(v);
  }).length;

  return {
    book_kind: kind,
    period_from: from,
    period_to: to,
    currency: empresa?.moneda ?? "",
    rows,
    row_count: rows.length,
    unclassified_rows: sinClasificar,
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
  const [r] = await sql<{ h: string; n: number }[]>`
    with filas as (
      select ${sql.unsafe(p.cols)}
        from ${sql.unsafe(p.fn)}(${companyId}, ${from}::date, ${to}::date)
    )
    select count(*)::int as n,
           encode(sha256(convert_to(
             coalesce(string_agg(to_jsonb(f)::text, chr(10) order by to_jsonb(f)::text), ''),
             'utf8')), 'hex') as h
      from filas f`;
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
function aCsv(rows: Record<string, unknown>[], cabeceras: string[]): string {
  const escapar = (v: unknown): string => {
    // Solo lo que la proyección puede producir: string, number, boolean o null.
    // Un `String(v)` genérico escribiría `[object Object]` en una celda de un
    // libro fiscal, y una celda ilegible es peor que una vacía declarada.
    if (v === null || v === undefined) return "";
    const s =
      typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : "";
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lineas = [cabeceras.join(",")];
  for (const r of rows) lineas.push(cabeceras.map((c) => escapar(r[c])).join(","));
  return lineas.join("\r\n");
}

/** Las cabeceras salen de la proyección, así que no pueden desincronizarse. */
function cabecerasDe(kind: BookKind): string[] {
  return PROYECCION[kind].cols
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

  const cabeceras = cabecerasDe(input.book_kind);
  return ok({
    run: run!,
    book: libro,
    content: aCsv(libro.rows, cabeceras),
    content_type: "text/csv; charset=utf-8",
    filename: `libro-${input.book_kind}-${input.period_from}_${input.period_to}.csv`,
  });
}
