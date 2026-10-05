import { useState } from "react";
import { cn } from "../ui/cn.js";
import { ReporteDelServidor } from "./TablaDeReporte.js";

/**
 * LA CARTERA (F-13 «Quién me debe», H-11 «Qué debo»): todos los que deben —o a quienes se debe—
 * sin elegir a nadie antes, con el total, lo vencido y los tramos. Es el reporte del servidor
 * (`/v1/reports/receivables` y `/v1/reports/payables`); aquí solo se elige el orden, y ordena el
 * servidor.
 */
const ORDENES = {
  receivables: [
    { clave: "debt_desc", etiqueta: "Mayor deuda" },
    { clave: "overdue_desc", etiqueta: "Más vencido" },
    { clave: "oldest", etiqueta: "Vencimiento más antiguo" },
    { clave: "name", etiqueta: "Por nombre" },
  ],
  payables: [
    { clave: "debt_desc", etiqueta: "Mayor deuda" },
    { clave: "overdue_desc", etiqueta: "Más vencido" },
    { clave: "due", etiqueta: "Vence antes" },
    { clave: "name", etiqueta: "Por nombre" },
  ],
} as const;

type Fila = Record<string, string | null>;

export function Cartera({
  tipo,
  ordenInicial,
  enlaceDeFila,
  alElegirFila,
  soloResumen = false,
}: {
  tipo: "receivables" | "payables";
  ordenInicial?: string | null;
  enlaceDeFila?: (fila: Fila) => string | null;
  alElegirFila?: (fila: Fila) => void;
  soloResumen?: boolean;
}): React.JSX.Element {
  const ordenes = ORDENES[tipo];
  const [orden, setOrden] = useState<string>(
    ordenes.find((o) => o.clave === ordenInicial)?.clave ?? "debt_desc",
  );
  return (
    <div className="space-y-3" data-cartera={tipo}>
      {!soloResumen && (
        <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Ordenar">
          {ordenes.map((o) => (
            <button
              key={o.clave}
              type="button"
              aria-pressed={o.clave === orden}
              onClick={() => setOrden(o.clave)}
              className={cn(
                "rounded-full border border-border px-2.5 py-1 text-[0.8rem] hover:border-accent",
                o.clave === orden && "border-accent bg-accent-soft/50 font-medium",
              )}
            >
              {o.etiqueta}
            </button>
          ))}
        </div>
      )}
      <ReporteDelServidor
        key={orden}
        reporte={{ clave: tipo, conRango: false }}
        sort={orden}
        soloResumen={soloResumen}
        {...(enlaceDeFila === undefined ? {} : { enlaceDeFila })}
        {...(alElegirFila === undefined ? {} : { alElegirFila })}
      />
    </div>
  );
}
