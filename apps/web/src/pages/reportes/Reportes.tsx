import { Link, useSearchParams } from "react-router";
import { BookOpenCheck, Calculator } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { EmptyState } from "../../components/EmptyState.js";
import { DateRangePicker } from "../../components/forms.js";
import { ReporteDelServidor } from "../../components/TablaDeReporte.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { cn } from "../../ui/cn.js";
import { mesLocal } from "../../fechas.js";
import { useConFacturas } from "../../app/modo-venta.js";
import { reportesVisibles } from "./reporte.js";

/**
 * REPORTES (P-07). El catálogo de lo que el sistema responde, en el orden que fijó el dueño:
 * ventas, margen, IVA del período, inventario valorizado, quién me debe y qué debo, cierres de
 * caja e IGTF. Cada uno es UNA consulta del servidor: aquí se elige el reporte, el rango y cómo
 * agruparlo, y se pinta lo que llega. Lo que el rol no puede abrir no aparece en la lista.
 *
 * El reporte, su agrupación y su rango viven en la URL (`?r=sales&g=product&desde=…&hasta=…`):
 * una vista se puede compartir.
 */
const DIA = /^\d{4}-\d{2}-\d{2}$/;

export function Reportes(): React.JSX.Element {
  const { puede } = useSesion();
  const conFacturas = useConFacturas();
  const [params, setParams] = useSearchParams();
  const visibles = reportesVisibles(puede, conFacturas);
  const elegido = visibles.find((r) => r.clave === params.get("r")) ?? visibles[0];
  const mes = mesLocal();
  const desde = DIA.test(params.get("desde") ?? "") ? (params.get("desde") as string) : mes.desde;
  const hasta = DIA.test(params.get("hasta") ?? "") ? (params.get("hasta") as string) : mes.hasta;
  const grupo =
    elegido?.grupos?.find((g) => g.clave === params.get("g"))?.clave ??
    elegido?.grupos?.[0]?.clave ??
    null;

  function poner(cambios: Record<string, string | null>): void {
    setParams(
      (antes) => {
        const q = new URLSearchParams(antes);
        for (const [k, v] of Object.entries(cambios)) {
          if (v === null) q.delete(k);
          else q.set(k, v);
        }
        return q;
      },
      { replace: true },
    );
  }

  const OTROS = [
    ...(puede("accounting.read")
      ? [
          {
            to: "/admin/contabilidad",
            icono: <Calculator className="size-4" />,
            titulo: "Comprobación y estados financieros",
          },
        ]
      : []),
    // Los libros fiscales existen solo para quien tiene RIF.
    ...(conFacturas && puede("fiscal_book.read")
      ? [
          {
            to: "/admin/libros",
            icono: <BookOpenCheck className="size-4" />,
            titulo: "Libros fiscales",
          },
        ]
      : []),
  ];

  return (
    <div>
      <PageHeader
        title="Reportes"
        description="Cada cifra la calcula el servidor, con su rango de fechas: lo que ves es lo que se descarga."
      />

      {elegido === undefined ? (
        <EmptyState
          icon={Calculator}
          title="Tu rol no abre ningún reporte"
          description="Pídele a quien administra la empresa el permiso del reporte que necesitas."
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
          <nav aria-label="Reportes" className="space-y-1.5">
            {visibles.map((r) => (
              <button
                key={r.clave}
                type="button"
                aria-current={r.clave === elegido.clave ? "page" : undefined}
                onClick={() => poner({ r: r.clave, g: null })}
                className={cn(
                  "block w-full rounded-md border border-border p-2.5 text-left transition-colors hover:border-accent",
                  r.clave === elegido.clave && "border-accent bg-accent-soft/40",
                )}
              >
                <span className="block text-[0.92rem] font-medium">{r.titulo}</span>
                <span className="block text-[0.8rem] text-muted-foreground">{r.detalle}</span>
              </button>
            ))}
            {OTROS.map((o) => (
              <Link
                key={o.to}
                to={o.to}
                className="flex items-center gap-2 rounded-md p-2.5 text-[0.88rem] text-accent-soft-foreground hover:underline"
              >
                {o.icono} {o.titulo}
              </Link>
            ))}
          </nav>

          <Card>
            <CardHeader>
              <CardTitle>{elegido.titulo}</CardTitle>
              <div className="flex flex-wrap items-center gap-2">
                {elegido.conRango && (
                  <DateRangePicker
                    from={desde}
                    to={hasta}
                    onChange={(r) => poner({ desde: r.from, hasta: r.to })}
                  />
                )}
                {elegido.grupos !== undefined && (
                  <div className="flex flex-wrap gap-1" role="group" aria-label="Agrupar">
                    {elegido.grupos.map((g) => (
                      <button
                        key={g.clave}
                        type="button"
                        aria-pressed={g.clave === grupo}
                        onClick={() => poner({ g: g.clave })}
                        className={cn(
                          "rounded-full border border-border px-2.5 py-1 text-[0.8rem] hover:border-accent",
                          g.clave === grupo && "border-accent bg-accent-soft/50 font-medium",
                        )}
                      >
                        {g.etiqueta}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {elegido.conRango && desde > hasta ? (
                <p role="alert" className="text-[0.88rem] text-destructive-soft-foreground">
                  El «desde» no puede ser posterior al «hasta».
                </p>
              ) : (
                <ReporteDelServidor
                  // Otro reporte u otra agrupación empiezan en su primera página.
                  key={`${elegido.clave}-${grupo ?? ""}-${desde}-${hasta}`}
                  reporte={elegido}
                  from={desde}
                  to={hasta}
                  group={grupo}
                  {...(elegido.clave === "receivables"
                    ? {
                        enlaceDeFila: (f: Record<string, string | null>) =>
                          f["id"] ? `/admin/cuentas?cliente=${f["id"]}` : null,
                      }
                    : {})}
                />
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
