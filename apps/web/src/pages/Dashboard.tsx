import { useMemo } from "react";
import { Link, useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowLeftRight, Banknote, PackageSearch, Receipt, Scale, Wallet } from "lucide-react";
import { useSesion } from "../app/session.js";
import { useModulosActivos } from "../app/shell.js";
import { PageHeader } from "../components/PageHeader.js";
import { KpiCard, type KpiDelta } from "../components/KpiCard.js";
import { DataTable } from "../components/DataTable.js";
import { DualMoney } from "../components/DualMoney.js";
import { FiscalStatusBadge } from "../components/FiscalStatusBadge.js";
import { compararImportes, esCero } from "../components/decimal-compare.js";
import { Button } from "../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card.js";
import { mostrarImporte } from "../money.js";

/**
 * El dashboard: las CINCO respuestas del dueño, consumibles en 30 segundos.
 *
 * Cada cifra la calculó el servidor (estado de resultados, reporte de
 * diferencial, low-stock). Donde el backend aún no expone un agregado —cobros
 * pendientes globales— se enseña lo que sí es verdad sin aritmética: cuántas
 * facturas están emitidas sin pagar, con el detalle a un clic en Cuentas.
 */
interface DocumentoFila {
  id: string;
  kind: string;
  series: string;
  document_number: number | null;
  status: string;
  issued_at: string | null;
  customer_id: string;
  transaction_currency: string;
  functional_currency: string;
  total_amount: string;

  fx_rate: string;
  rate_source: string;
}

interface EstadoResultados {
  currency: string;
  total_income: string;
  total_expenses: string;
  result: string;
}

const mesDe = (d: Date): { from: string; to: string } => {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const primero = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const ultimo = new Date(Date.UTC(y, m + 1, 0)).toISOString().slice(0, 10);
  return { from: primero, to: ultimo };
};

export function Dashboard(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const activos = useModulosActivos();
  const navigate = useNavigate();

  const hoy = new Date();
  const mes = mesDe(hoy);
  const mesAnterior = mesDe(new Date(Date.UTC(hoy.getUTCFullYear(), hoy.getUTCMonth() - 1, 15)));

  const resultados = useQuery({
    queryKey: ["dash-resultados", empresa.id, mes.from],
    enabled: activos.contabilidad,
    queryFn: () =>
      Promise.all([
        llamar<EstadoResultados>(
          `/v1/accounting/reports/income-statement?from=${mes.from}&to=${mes.to}`,
        ),
        llamar<EstadoResultados>(
          `/v1/accounting/reports/income-statement?from=${mesAnterior.from}&to=${mesAnterior.to}`,
        ),
      ]),
  });

  const facturasMes = useQuery({
    queryKey: ["dash-facturas", empresa.id, mes.from],
    queryFn: () =>
      llamar<{ total: number }>(
        `/v1/documents?kind=invoice&from=${mes.from}&to=${mes.to}&per_page=1`,
      ),
  });

  const porCobrar = useQuery({
    queryKey: ["dash-cobrar", empresa.id],
    queryFn: () => llamar<{ total: number }>(`/v1/documents?kind=invoice&status=issued&per_page=1`),
  });

  const diferencial = useQuery({
    queryKey: ["dash-dif", empresa.id, mes.from],
    queryFn: () =>
      llamar<{
        ganancia: string;
        perdida: string;
        neto: string;
        currency: string;
        by_month: { month: string; amount: string }[];
      }>(`/v1/reports/exchange-difference?from=${mes.from}&to=${mes.to}`),
  });

  const porAgotarse = useQuery({
    queryKey: ["dash-lowstock", empresa.id],
    queryFn: () =>
      llamar<{ items: { product_sku: string; product_name: string; missing: string }[] }>(
        "/v1/inventory/low-stock",
      ),
  });

  const ultimos = useQuery({
    queryKey: ["dash-docs", empresa.id],
    queryFn: () => llamar<{ items: DocumentoFila[] }>(`/v1/documents?per_page=8`),
  });

  const clientes = useQuery({
    queryKey: ["clientes-mapa", empresa.id],
    staleTime: 60_000,
    queryFn: () =>
      llamar<{ items: { id: string; legal_name: string }[] }>(`/v1/customers?per_page=100`),
  });
  const nombreCliente = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of clientes.data?.items ?? []) m.set(c.id, c.legal_name);
    return m;
  }, [clientes.data]);

  // Delta ventas: dirección por comparación de strings decimales (sin float),
  // y la etiqueta enseña el valor del mes anterior TAL CUAL — no un porcentaje
  // calculado en cliente.
  const deltaVentas = useMemo<KpiDelta | null>(() => {
    const par = resultados.data;
    if (par === undefined) return null;
    const [actual, anterior] = par;
    const dir = compararImportes(actual.total_income, anterior.total_income);
    return {
      direction: dir > 0 ? "up" : dir < 0 ? "down" : "flat",
      label: `mes anterior: ${mostrarImporte({ amount: anterior.total_income, currency: anterior.currency })}`,
      positiveIsGood: true,
    };
  }, [resultados.data]);

  const columnas = useMemo<ColumnDef<DocumentoFila, unknown>[]>(
    () => [
      {
        id: "fecha",
        header: "Fecha",
        accessorFn: (d) => d.issued_at?.slice(0, 10) ?? "—",
      },
      {
        id: "numero",
        header: "Número",
        accessorFn: (d) =>
          d.document_number === null ? "—" : `${d.series}-${String(d.document_number)}`,
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      {
        id: "cliente",
        header: "Cliente",
        accessorFn: (d) => nombreCliente.get(d.customer_id) ?? "—",
      },
      {
        id: "estado",
        header: "Estado",
        accessorKey: "status",
        cell: (c) => <FiscalStatusBadge estado={c.getValue<string>()} />,
        enableSorting: false,
      },
      {
        id: "total",
        header: () => <span className="block text-right">Total</span>,
        accessorKey: "total_amount",
        cell: (c) => {
          // El contrato del documento expone los totales FUNCIONALES (Bs) más
          // moneda y tasa de la transacción — no el importe en divisa. Se
          // enseña lo que el contrato dice, con la tasa en el tooltip; añadir
          // el otro lado es un cambio de contrato que decide el usuario.
          const d = c.row.original;
          return (
            <DualMoney
              variant="cell"
              amount={d.total_amount}
              currency={d.functional_currency}
              rate={
                d.transaction_currency === d.functional_currency
                  ? null
                  : {
                      rate: d.fx_rate,
                      source: `${d.rate_source} · doc. en ${d.transaction_currency}`,
                    }
              }
            />
          );
        },
        enableSorting: false,
      },
    ],
    [nombreCliente],
  );

  const neto = diferencial.data?.neto ?? "0";
  const netoNegativo = neto.startsWith("-");
  const agotandose = porAgotarse.data?.items ?? [];

  return (
    <div>
      <PageHeader
        title={`Hola — ${empresa.legal_name}`}
        description="Las cinco respuestas del dueño, con cada cifra calculada por el servidor."
        actions={
          <Button variant="primary" onClick={() => void navigate("/admin/ventas/nueva")}>
            <Receipt /> Nueva factura
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard
          title="Ventas del mes"
          icon={Wallet}
          loading={activos.contabilidad ? resultados.isPending : facturasMes.isPending}
          value={
            activos.contabilidad && resultados.data !== undefined ? (
              <DualMoney
                variant="kpi"
                amount={resultados.data[0].total_income}
                currency={resultados.data[0].currency}
              />
            ) : (
              <span className="font-mono text-[1.55rem] font-semibold">
                {facturasMes.data?.total ?? 0}
                <span className="ml-1 text-[0.85rem] font-normal text-muted-foreground">
                  facturas
                </span>
              </span>
            )
          }
          delta={activos.contabilidad ? deltaVentas : null}
          footer={activos.contabilidad ? null : "Importe al activar contabilidad"}
        />
        <KpiCard
          title="Utilidad estimada"
          icon={Scale}
          loading={activos.contabilidad && resultados.isPending}
          value={
            activos.contabilidad && resultados.data !== undefined ? (
              <DualMoney
                variant="kpi"
                amount={resultados.data[0].result}
                currency={resultados.data[0].currency}
              />
            ) : (
              <span className="text-[1rem] text-muted-foreground">Requiere contabilidad</span>
            )
          }
          footer={activos.contabilidad ? "Estado de resultados del mes" : null}
        />
        <KpiCard
          title="Cobros pendientes"
          icon={Banknote}
          loading={porCobrar.isPending}
          value={
            <span className="font-mono text-[1.55rem] font-semibold">
              {porCobrar.data?.total ?? 0}
              <span className="ml-1 text-[0.85rem] font-normal text-muted-foreground">
                facturas emitidas
              </span>
            </span>
          }
          footer={
            <Link to="/admin/cuentas" className="text-accent-soft-foreground hover:underline">
              Ver aging por cliente →
            </Link>
          }
        />
        <KpiCard
          title="Diferencial cambiario"
          icon={ArrowLeftRight}
          loading={diferencial.isPending}
          value={
            diferencial.data !== undefined ? (
              <DualMoney variant="kpi" amount={neto} currency={diferencial.data.currency} />
            ) : null
          }
          delta={
            diferencial.data === undefined || esCero(neto)
              ? null
              : {
                  direction: netoNegativo ? "down" : "up",
                  label: netoNegativo ? "pérdida del período" : "ganancia del período",
                  positiveIsGood: true,
                }
          }
          spark={(diferencial.data?.by_month ?? []).map((p) => ({
            // SOLO geometría del trazo: la cifra visible es el string del servidor.
            v: Number(p.amount),
          }))}
        />
        <KpiCard
          title="Por agotarse"
          icon={PackageSearch}
          loading={porAgotarse.isPending}
          value={
            <span className="font-mono text-[1.55rem] font-semibold">
              {agotandose.length}
              <span className="ml-1 text-[0.85rem] font-normal text-muted-foreground">
                productos
              </span>
            </span>
          }
          footer={
            agotandose.length > 0 ? (
              <span className="truncate">
                {agotandose
                  .slice(0, 2)
                  .map((i) => i.product_sku)
                  .join(", ")}
                {agotandose.length > 2 && "…"}
              </span>
            ) : (
              "Todo por encima del mínimo"
            )
          }
        />
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Últimos documentos</CardTitle>
            <Link
              to="/admin/ventas"
              className="text-[0.85rem] text-accent-soft-foreground hover:underline"
            >
              Ver todos →
            </Link>
          </CardHeader>
          <CardContent className="px-0 pb-0">
            <DataTable
              columns={columnas}
              data={ultimos.data?.items}
              error={ultimos.error instanceof Error ? ultimos.error.message : null}
              onRetry={() => void ultimos.refetch()}
              density="compact"
              onRowClick={(d) => void navigate(`/admin/ventas/${d.id}`)}
              empty={{
                title: "Todavía no hay documentos",
                description: "La primera factura aparecerá aquí en cuanto se emita.",
                action: (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() => void navigate("/admin/ventas/nueva")}
                  >
                    Emitir la primera
                  </Button>
                ),
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
