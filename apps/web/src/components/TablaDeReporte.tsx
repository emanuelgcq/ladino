import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { useSesion } from "../app/session.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, Skeleton } from "../ui/card.js";
import { Table, TBody, TD, TH, THead, TR } from "../ui/table.js";
import { cn } from "../ui/cn.js";
import { errorDePersona } from "../lib.js";
import { descargarReporte } from "../pages/reportes/descargar.js";
import {
  esCifra,
  rutaDeReporte,
  textoDeCelda,
  textoDeResumen,
  type ReporteDelCatalogo,
  type ReportTable,
} from "../pages/reportes/reporte.js";

/**
 * UN REPORTE DEL SERVIDOR, PINTADO (P-07, F-13, H-11).
 *
 * La tabla, sus totales y su resumen llegan hechos de `/v1/reports/…`; este componente no suma,
 * no ordena dinero y no redondea: viste cada texto y lo coloca. La descarga también es del
 * servidor (el mismo reporte con `format=csv|xlsx`).
 */
const POR_PAGINA = 100;

export function ReporteDelServidor({
  reporte,
  from,
  to,
  group,
  sort,
  enlaceDeFila,
  alElegirFila,
  soloResumen = false,
  className,
}: {
  reporte: Pick<ReporteDelCatalogo, "clave" | "conRango">;
  from?: string;
  to?: string;
  group?: string | null;
  sort?: string | null;
  /** A dónde lleva el nombre de cada fila (la cuenta del cliente). */
  enlaceDeFila?: (fila: Record<string, string | null>) => string | null;
  /** O qué pasa al elegirla, cuando el detalle vive en la misma pantalla. */
  alElegirFila?: (fila: Record<string, string | null>) => void;
  /** Solo las cifras del resumen (la tabla vive en otra pantalla). */
  soloResumen?: boolean;
  className?: string;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  const [pagina, setPagina] = useState(1);
  const [aviso, setAviso] = useState<string | null>(null);
  const [bajando, setBajando] = useState<"csv" | "xlsx" | null>(null);
  const consulta = {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    group: group ?? null,
    sort: sort ?? null,
  };
  const q = useQuery({
    queryKey: ["reporte", empresa.id, reporte.clave, from, to, group, sort, pagina, soloResumen],
    queryFn: () =>
      llamar<ReportTable>(
        rutaDeReporte(reporte, {
          ...consulta,
          page: pagina,
          perPage: soloResumen ? 1 : POR_PAGINA,
        }),
      ),
  });

  async function bajar(formato: "csv" | "xlsx"): Promise<void> {
    setAviso(null);
    setBajando(formato);
    const error = await descargarReporte(
      rutaDeReporte(reporte, { ...consulta, format: formato }),
      empresa.id,
      `${reporte.clave}.${formato}`,
    );
    setBajando(null);
    setAviso(error);
  }

  if (q.isError) {
    return (
      <div
        role="alert"
        className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/40 bg-destructive-soft px-3 py-2 text-[0.88rem] text-destructive-soft-foreground"
      >
        <span>{errorDePersona(q.error)}</span>
        <Button variant="secondary" size="sm" onClick={() => void q.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }
  const t = q.data;
  if (t === undefined) return <Skeleton className="h-48 w-full" />;
  const hayTotales = Object.keys(t.totals).length > 0;
  const paginas = Math.max(1, Math.ceil(t.row_count / t.per_page));

  return (
    <div className={cn("space-y-3", className)} data-reporte={t.report}>
      {t.summary.length > 0 && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {t.summary.map((s) => (
            <Card key={s.key}>
              <CardContent className="py-3">
                <p className="text-[0.8rem] text-muted-foreground">{s.label}</p>
                <p
                  className={cn(
                    "font-mono text-[1.05rem] font-semibold",
                    s.value === null && "font-sans text-[0.9rem] font-medium text-muted-foreground",
                  )}
                  data-resumen={s.key}
                >
                  {textoDeResumen(s, t)}
                </p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {!soloResumen && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-[0.82rem] text-muted-foreground">
              {t.row_count === 0
                ? "Sin filas en este reporte."
                : `${t.row_count} fila${t.row_count === 1 ? "" : "s"} · calculado el ${textoDeCelda(t.as_of, { kind: "date" }, t)}`}
            </p>
            {/* Ver no es llevarse el archivo: la descarga exige report.export, aquí y en el servidor. */}
            {puede("report.export") && (
              <div className="flex gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bajando !== null}
                  onClick={() => void bajar("xlsx")}
                >
                  <Download /> Excel
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={bajando !== null}
                  onClick={() => void bajar("csv")}
                >
                  <Download /> CSV
                </Button>
              </div>
            )}
          </div>
          {aviso !== null && (
            <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
              {aviso}
            </p>
          )}

          {t.row_count > 0 && (
            <Card>
              <Table>
                <THead>
                  <TR>
                    {t.columns.map((c) => (
                      <TH key={c.key} className={cn(esCifra(c) && "text-right")}>
                        {c.label}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {t.rows.map((fila, i) => (
                    <TR key={fila["id"] ?? `${i}-${fila[t.columns[0]?.key ?? ""] ?? ""}`}>
                      {t.columns.map((c, j) => {
                        const texto = textoDeCelda(fila[c.key], c, t);
                        const destino = j === 0 ? (enlaceDeFila?.(fila) ?? null) : null;
                        return (
                          <TD
                            key={c.key}
                            className={cn(
                              esCifra(c) && "text-right font-mono",
                              fila[c.key] === null && "font-sans text-muted-foreground",
                            )}
                          >
                            {destino !== null ? (
                              <Link
                                to={destino}
                                className="text-accent-soft-foreground hover:underline"
                              >
                                {texto}
                              </Link>
                            ) : j === 0 && alElegirFila !== undefined ? (
                              <button
                                type="button"
                                className="text-left text-accent-soft-foreground hover:underline"
                                onClick={() => alElegirFila(fila)}
                              >
                                {texto}
                              </button>
                            ) : (
                              texto
                            )}
                          </TD>
                        );
                      })}
                    </TR>
                  ))}
                  {hayTotales && (
                    <TR className="font-semibold">
                      {t.columns.map((c, j) => (
                        <TD key={c.key} className={cn(esCifra(c) && "text-right font-mono")}>
                          {c.key in t.totals
                            ? textoDeCelda(t.totals[c.key], c, t)
                            : j === 0
                              ? "Total"
                              : ""}
                        </TD>
                      ))}
                    </TR>
                  )}
                </TBody>
              </Table>
            </Card>
          )}

          {paginas > 1 && (
            <div className="flex items-center justify-end gap-2 text-[0.85rem]">
              <Button
                variant="ghost"
                size="sm"
                disabled={pagina <= 1}
                onClick={() => setPagina(pagina - 1)}
              >
                Anterior
              </Button>
              <span>
                Página {pagina} de {paginas}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={pagina >= paginas}
                onClick={() => setPagina(pagina + 1)}
              >
                Siguiente
              </Button>
            </div>
          )}

          {t.notes.length > 0 && (
            <ul className="space-y-1 text-[0.8rem] text-muted-foreground">
              {t.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
