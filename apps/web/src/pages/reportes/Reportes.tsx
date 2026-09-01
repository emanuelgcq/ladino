import { useState } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, ResponsiveContainer, Cell } from "recharts";
import { ArrowLeftRight, BookOpenCheck, Calculator, Scale } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { DateRangePicker } from "../../components/forms.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { mostrarImporte } from "../../money.js";

/**
 * Reportes — el índice de las respuestas que el sistema ya sabe dar, y el
 * reporte de diferencial cambiario en detalle. Todos los importes vienen
 * calculados del servidor; las barras usan los valores SOLO como geometría.
 */
interface ReporteDiferencial {
  ganancia: string;
  perdida: string;
  neto: string;
  currency: string;
  by_month: { month: string; amount: string }[];
}

function inicioDeAnio(): string {
  return `${new Date().getFullYear()}-01-01`;
}

export function Reportes(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const [rango, setRango] = useState({
    from: inicioDeAnio(),
    to: new Date().toISOString().slice(0, 10),
  });

  const diferencial = useQuery({
    queryKey: ["reporte-dif", empresa.id, rango.from, rango.to],
    queryFn: () =>
      llamar<ReporteDiferencial>(
        `/v1/reports/exchange-difference?from=${rango.from}&to=${rango.to}`,
      ),
  });

  const d = diferencial.data;
  const barras = (d?.by_month ?? []).map((p) => ({
    mes: p.month,
    // SOLO altura de barra; la cifra visible es el string del servidor.
    v: Number(p.amount),
    negativo: p.amount.startsWith("-"),
  }));

  const OTROS = [
    {
      to: "/contabilidad",
      icono: <Calculator className="size-4" />,
      titulo: "Comprobación y estados financieros",
      detalle:
        "Balance de comprobación, estado de resultados y balance general — pestañas de Contabilidad.",
    },
    {
      to: "/libros",
      icono: <BookOpenCheck className="size-4" />,
      titulo: "Libros fiscales",
      detalle: "Ventas, compras y retenciones con exportación auditable (hash por generación).",
    },
    {
      to: "/cuentas",
      icono: <Scale className="size-4" />,
      titulo: "Antigüedad de cuentas por cobrar",
      detalle: "Aging por cliente, con cada documento y su saldo.",
    },
  ];

  return (
    <div>
      <PageHeader
        title="Reportes"
        description="Cada cifra la calcula el servidor con fecha explícita: un reporte que no se puede reproducir mañana no es un reporte."
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ArrowLeftRight className="size-4 text-muted-foreground" />
              <CardTitle>Diferencial cambiario</CardTitle>
            </div>
            <DateRangePicker from={rango.from} to={rango.to} onChange={setRango} />
          </CardHeader>
          <CardContent>
            {d === undefined ? (
              <Skeleton className="h-40 w-full" />
            ) : (
              <>
                <div className="mb-3 grid grid-cols-3 gap-3">
                  <div>
                    <p className="text-[0.8rem] text-muted-foreground">Ganancia</p>
                    <p className="font-mono text-[1.1rem] font-semibold text-accent-soft-foreground">
                      {mostrarImporte({ amount: d.ganancia, currency: d.currency })}
                    </p>
                  </div>
                  <div>
                    <p className="text-[0.8rem] text-muted-foreground">Pérdida</p>
                    <p className="font-mono text-[1.1rem] font-semibold text-warning-soft-foreground">
                      {mostrarImporte({ amount: d.perdida, currency: d.currency })}
                    </p>
                  </div>
                  <div>
                    <p className="text-[0.8rem] text-muted-foreground">Neto</p>
                    <DualMoney variant="inline" amount={d.neto} currency={d.currency} />
                  </div>
                </div>
                {barras.length > 0 && (
                  <div className="h-40">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={barras} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                        <XAxis
                          dataKey="mes"
                          tickLine={false}
                          axisLine={false}
                          tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                        />
                        <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                          {barras.map((b) => (
                            <Cell
                              key={b.mes}
                              fill={b.negativo ? "var(--warning)" : "var(--accent)"}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
                <CardDescription className="mt-2">
                  Cada barra es el neto del mes (esmeralda ganancia, ámbar pérdida), tal como lo
                  suma `exchange_gain_loss` en el servidor. El detalle por documento vive en cada
                  factura.
                </CardDescription>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Los demás reportes</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {OTROS.map((r) => (
              <Link
                key={r.to}
                to={r.to}
                className="block rounded-md border border-border p-3 transition-colors hover:border-accent hover:bg-accent-soft/30"
              >
                <p className="flex items-center gap-2 font-medium">
                  {r.icono} {r.titulo}
                </p>
                <p className="mt-0.5 text-[0.82rem] text-muted-foreground">{r.detalle}</p>
              </Link>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
