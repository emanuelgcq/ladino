import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type BookFormatAdapter,
  type BookReconciliation,
  type FiscalBook,
  type FiscalBookRun,
  type BookKind,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * LIBROS FISCALES. La pantalla NO calcula NADA: ni una base, ni un total, ni si
 * el libro cuadra con el mayor. Todo llega calculado desde los documentos, que
 * es lo que garantiza que el libro cuadre con ellos (ADR-0044).
 *
 * Dos cosas que esta pantalla hace a propósito y hay que decir:
 *
 *   · **el período es siempre explícito.** No hay «mes en curso» por omisión.
 *     Un libro con período implícito no se puede volver a generar igual, y
 *     volver a generarlo igual es lo que exige la reproducibilidad;
 *   · **«sin clasificar» se enseña en rojo, no se reparte.** Son los documentos
 *     emitidos antes de la migración 27, que no tienen el tratamiento
 *     congelado. Un libro que reparte en silencio lo que no sabe clasificar
 *     produce una declaración falsa sin avisar a nadie.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

const LIBROS: readonly (readonly [BookKind, string])[] = [
  ["ventas", "Libro de ventas"],
  ["compras", "Libro de compras"],
  ["retenciones_iva", "Retenciones de IVA"],
  ["retenciones_islr", "Retenciones de ISLR"],
] as const;

/** El primer y el último día del mes ANTERIOR: el período que de verdad se declara. */
function mesAnterior(): { desde: string; hasta: string } {
  const hoy = new Date();
  const primeroDeEste = new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth(), 1));
  const ultimoDelAnterior = new Date(primeroDeEste.getTime() - 86_400_000);
  const primeroDelAnterior = new Date(
    Date.UTC(ultimoDelAnterior.getUTCFullYear(), ultimoDelAnterior.getUTCMonth(), 1),
  );
  return {
    desde: primeroDelAnterior.toISOString().slice(0, 10),
    hasta: ultimoDelAnterior.toISOString().slice(0, 10),
  };
}

export function FiscalBooksView({ session, companyId }: Props) {
  const [panel, setPanel] = useState<"libro" | "conciliacion" | "generaciones">("libro");
  const [kind, setKind] = useState<BookKind>("ventas");
  const inicial = mesAnterior();
  const [desde, setDesde] = useState(inicial.desde);
  const [hasta, setHasta] = useState(inicial.hasta);
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  return (
    <section>
      <h2>Libros fiscales</h2>
      <p>
        Obligación de PA 071 y PA 102 para contribuyentes ordinarios y especiales. El libro se
        calcula desde los documentos cada vez: por eso cuadra con ellos.
      </p>

      <nav>
        {(
          [
            ["libro", "El libro"],
            ["conciliacion", "Conciliación con el mayor"],
            ["generaciones", "Generaciones"],
          ] as const
        ).map(([k, etiqueta]) => (
          <span key={k}>
            <button disabled={panel === k} onClick={() => setPanel(k)}>
              {etiqueta}
            </button>{" "}
          </span>
        ))}
      </nav>

      <fieldset>
        <legend>Período — explícito, siempre</legend>
        <label>
          Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
        </label>{" "}
        <label>
          Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
        </label>
        {panel === "libro" && (
          <>
            {" "}
            <label>
              Libro{" "}
              <select value={kind} onChange={(e) => setKind(e.target.value as BookKind)}>
                {LIBROS.map(([k, etiqueta]) => (
                  <option key={k} value={k}>
                    {etiqueta}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
      </fieldset>

      {error && <p role="alert">{error}</p>}
      {aviso && <p role="status">{aviso}</p>}

      {panel === "libro" ? (
        <Libro
          session={session}
          companyId={companyId}
          kind={kind}
          desde={desde}
          hasta={hasta}
          onError={setError}
          onAviso={setAviso}
        />
      ) : panel === "conciliacion" ? (
        <Conciliacion
          session={session}
          companyId={companyId}
          desde={desde}
          hasta={hasta}
          onError={setError}
        />
      ) : (
        <Generaciones session={session} companyId={companyId} onError={setError} />
      )}
    </section>
  );
}

// ── El libro ────────────────────────────────────────────────────────────────

function Libro({
  session,
  companyId,
  kind,
  desde,
  hasta,
  onError,
  onAviso,
}: Props & {
  kind: BookKind;
  desde: string;
  hasta: string;
  onError: (m: string) => void;
  onAviso: (m: string) => void;
}): React.JSX.Element {
  const [libro, setLibro] = useState<FiscalBook | null>(null);
  const [formatos, setFormatos] = useState<BookFormatAdapter[]>([]);
  const [formato, setFormato] = useState("csv_columnas_legales");
  const [exportando, setExportando] = useState(false);

  const cargar = useCallback(async () => {
    try {
      const [b, f] = await Promise.all([
        api<FiscalBook>(session, `/v1/fiscal-books/${kind}?from=${desde}&to=${hasta}`, {
          companyId,
        }),
        api<BookFormatAdapter[]>(session, "/v1/fiscal-books/formats", { companyId }),
      ]);
      setLibro(b);
      setFormatos(f);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, kind, desde, hasta, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function exportar() {
    if (
      !window.confirm(
        `¿Exportar el libro de ${kind} de ${desde} a ${hasta}?\n\n` +
          "Queda registrada la generación con su hash: es lo que permite demostrar después qué se presentó.",
      )
    ) {
      return;
    }
    setExportando(true);
    try {
      const r = await api<{ content: string; filename: string; run: FiscalBookRun }>(
        session,
        "/v1/fiscal-books/export",
        {
          companyId,
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: companyId,
            book_kind: kind,
            period_from: desde,
            period_to: hasta,
            format_code: formato,
            // La zona con la que se interpretó el período, persistida entre los
            // siete campos: «el libro de agosto» no significa lo mismo desde
            // dos husos distintos.
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          }),
        },
      );
      const blob = new Blob([r.content], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = r.filename;
      a.click();
      URL.revokeObjectURL(url);
      onAviso(`Generación registrada. Hash del dataset: ${r.run.dataset_hash.slice(0, 16)}…`);
    } catch (e) {
      onError(mensajeDe(e));
    } finally {
      setExportando(false);
    }
  }

  if (!libro) return <p>Cargando…</p>;
  const columnas = libro.rows.length > 0 ? Object.keys(libro.rows[0]!) : [];
  const elegido = formatos.find((f) => f.code === formato);

  return (
    <div>
      <p>
        {libro.row_count} renglones · moneda funcional {libro.currency}
      </p>

      {libro.unclassified_rows > 0 && (
        <p role="alert">
          <strong>{libro.unclassified_rows}</strong> renglones traen base SIN CLASIFICAR: son
          documentos emitidos antes de que el tratamiento se congelara en la línea. Aparecen en su
          propia columna y NO se reparten entre gravado, exento y exonerado — adivinarlos sería
          declarar algo que nadie registró.
        </p>
      )}

      <fieldset>
        <legend>Exportar</legend>
        <label>
          Formato{" "}
          <select value={formato} onChange={(e) => setFormato(e.target.value)}>
            {formatos.map((f) => (
              <option key={f.code} value={f.code} disabled={!f.implemented}>
                {f.name}
                {f.is_official ? " (oficial)" : ""}
                {f.implemented ? "" : " — sin implementación"}
              </option>
            ))}
          </select>
        </label>{" "}
        <button onClick={() => void exportar()} disabled={exportando || !elegido?.implemented}>
          {exportando ? "Exportando…" : "Exportar y registrar"}
        </button>
        {elegido && !elegido.is_official && (
          <p>
            <strong>No es el formato oficial de presentación.</strong> {elegido.description}
          </p>
        )}
      </fieldset>

      {libro.rows.length === 0 ? (
        <p>Sin movimientos en el período.</p>
      ) : (
        <table>
          <thead>
            <tr>
              {columnas.map((c) => (
                <th key={c}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {libro.rows.map((fila, i) => (
              <tr key={i}>
                {columnas.map((c) => (
                  <td key={c}>{celda(c, fila[c], libro.currency)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Las columnas de IMPORTE se formatean con el helper de money; el resto se
 * enseña tal cual. Formatear no redondea, y si el importe trae más decimales de
 * los que la moneda muestra, `mostrarImporte` cae a enseñar el string exacto —
 * enseñar el dato, nunca inventarle un redondeo en el cliente.
 */
const IMPORTES = /^(base_|iva_|retenido_|total_|retained_|subtrahend$)/;

function celda(columna: string, valor: unknown, moneda: string): string {
  if (valor === null || valor === undefined) return "—";
  if (typeof valor === "boolean") return valor ? "sí" : "no";
  if (typeof valor === "string" && IMPORTES.test(columna)) {
    return mostrarImporte({ amount: valor, currency: moneda });
  }
  // `string` y `number` explícitos, y nada más. Un `String(valor)` genérico
  // sobre lo que venga acabaría enseñando `[object Object]` en una celda de un
  // libro fiscal — un dato ilegible es peor que un hueco declarado.
  if (typeof valor === "string" || typeof valor === "number") return String(valor);
  return "—";
}

// ── Conciliación con el mayor ───────────────────────────────────────────────

function Conciliacion({
  session,
  companyId,
  desde,
  hasta,
  onError,
}: Props & { desde: string; hasta: string; onError: (m: string) => void }): React.JSX.Element {
  const [rec, setRec] = useState<BookReconciliation | null>(null);

  const cargar = useCallback(async () => {
    try {
      setRec(
        await api<BookReconciliation>(
          session,
          `/v1/fiscal-books/reports/reconciliation?from=${desde}&to=${hasta}`,
          { companyId },
        ),
      );
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, desde, hasta, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!rec) return <p>Cargando…</p>;
  return (
    <div>
      <p>
        <code>libro = mayor + pendientes en cola</code>. Las tres cifras a la vista: mientras un
        documento correcto pueda estar sin contabilizar, una diferencia no es un error — es la cola.
        Lo que sí es un error es que no cuadre <em>ni contando la cola</em>.
      </p>
      <p role={rec.balanced ? "status" : "alert"}>
        {rec.balanced ? "Cuadra." : "NO CUADRA: hay un asiento que no respalda ningún documento."}
      </p>
      <table>
        <thead>
          <tr>
            <th>Concepto</th>
            <th>Libro</th>
            <th>Mayor</th>
            <th>En cola</th>
            <th>Diferencia</th>
          </tr>
        </thead>
        <tbody>
          {rec.rows.map((f) => (
            <tr key={f.concepto}>
              <td>{f.concepto}</td>
              <td>{mostrarImporte({ amount: f.libro, currency: rec.currency })}</td>
              <td>{mostrarImporte({ amount: f.mayor, currency: rec.currency })}</td>
              <td>{mostrarImporte({ amount: f.en_cola, currency: rec.currency })}</td>
              <td>{f.cuadra ? "0" : f.diferencia}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Generaciones ────────────────────────────────────────────────────────────

function Generaciones({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [runs, setRuns] = useState<FiscalBookRun[] | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ runs: FiscalBookRun[] }>(session, "/v1/fiscal-books/runs", {
        companyId,
      });
      setRuns(r.runs);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  if (!runs) return <p>Cargando…</p>;
  return (
    <div>
      <p>
        Una fila por EXPORTACIÓN. Consultar en pantalla no deja rastro —es una lectura—; exportar
        para presentar, sí. Dos generaciones del mismo período con el mismo hash dijeron lo mismo;
        con hash distinto, algo cambió entre medias.
      </p>
      {runs.length === 0 ? (
        <p>Todavía no se ha exportado ningún libro.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Libro</th>
              <th>Período</th>
              <th>Renglones</th>
              <th>Formato</th>
              <th>Huso</th>
              <th>Generador</th>
              <th>Hash</th>
              <th>Cuándo</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <td>{r.book_kind}</td>
                <td>
                  {r.period_from} → {r.period_to}
                </td>
                <td>{r.row_count}</td>
                <td>{r.format_code}</td>
                <td>{r.timezone}</td>
                <td>{r.generator_version}</td>
                <td>
                  <code title={r.dataset_hash}>{r.dataset_hash.slice(0, 16)}…</code>
                </td>
                <td>{r.created_at}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
