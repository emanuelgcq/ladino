import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { Receipt } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DataTable } from "../../components/DataTable.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { DateRangePicker, EntityPicker, type EntityOption } from "../../components/forms.js";
import { Button } from "../../ui/button.js";
import { SimpleSelect } from "../../ui/select.js";
import { KIND_LABEL, numeroDe } from "./comunes.js";

/**
 * Listado de ventas: DataTable con los filtros DEL SERVIDOR (estado, fechas,
 * cliente — los del endpoint /v1/documents) y paginación de servidor. La
 * búsqueda libre de documentos no existe en la API y por eso aquí tampoco:
 * un buscador que filtra solo la página visible miente.
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
  fx_rate: string;
  rate_source: string;

  subtotal_amount: string;
  tax_amount: string;
  total_amount: string;
}

const PER_PAGE = 25;

export function Ventas(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const navigate = useNavigate();
  const [pagina, setPagina] = useState(1);
  const [estado, setEstado] = useState("");
  const [kind, setKind] = useState("invoice");
  const [rango, setRango] = useState({ from: "", to: "" });
  const [cliente, setCliente] = useState<EntityOption | null>(null);

  const consulta = useMemo(() => {
    const p = new URLSearchParams();
    p.set("page", String(pagina));
    p.set("per_page", String(PER_PAGE));
    if (kind !== "") p.set("kind", kind);
    if (estado !== "") p.set("status", estado);
    if (cliente !== null) p.set("customer_id", cliente.id);
    if (rango.from !== "") p.set("from", rango.from);
    if (rango.to !== "") p.set("to", rango.to);
    return p.toString();
  }, [pagina, kind, estado, cliente, rango]);

  const documentos = useQuery({
    queryKey: ["documentos", empresa.id, consulta],
    queryFn: () => llamar<{ items: DocumentoFila[]; total: number }>(`/v1/documents?${consulta}`),
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

  const columnas = useMemo<ColumnDef<DocumentoFila, unknown>[]>(
    () => [
      { id: "fecha", header: "Fecha", accessorFn: (d) => d.issued_at?.slice(0, 10) ?? "—" },
      {
        id: "numero",
        header: "Número",
        accessorFn: (d) => numeroDe(d),
        cell: (c) => <span className="font-mono text-[0.84rem]">{c.getValue<string>()}</span>,
      },
      {
        id: "tipo",
        header: "Tipo",
        accessorFn: (d) => KIND_LABEL[d.kind] ?? d.kind,
        enableSorting: false,
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
        enableSorting: false,
        cell: (c) => {
          // El contrato expone los totales FUNCIONALES; el importe en divisa
          // del documento no viaja en la lista. Se enseña el Bs con la moneda
          // y tasa de la transacción en el tooltip — nunca una conversión
          // hecha aquí (apps/web/CLAUDE.md).
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
      },
    ],
    [nombreCliente],
  );

  return (
    <div>
      <PageHeader
        title="Ventas"
        description="Cotizaciones, pedidos, facturas y notas — con su estado fiscal a la vista."
        actions={
          <Button variant="primary" onClick={() => void navigate("/admin/ventas/nueva")}>
            <Receipt /> Nueva factura
          </Button>
        }
      />
      <DataTable
        columns={columnas}
        data={documentos.data?.items}
        error={documentos.error instanceof Error ? documentos.error.message : null}
        onRetry={() => void documentos.refetch()}
        onRowClick={(d) => void navigate(`/admin/ventas/${d.id}`)}
        getRowId={(d) => d.id}
        exportCsv={{ filename: `ventas-${empresa.tax_id}.csv` }}
        pagination={{
          total: documentos.data?.total ?? 0,
          page: pagina,
          perPage: PER_PAGE,
          onPageChange: setPagina,
        }}
        toolbar={
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-36">
              <SimpleSelect
                ariaLabel="Tipo de documento"
                value={kind}
                onValueChange={(v) => {
                  setKind(v === "todos" ? "" : v);
                  setPagina(1);
                }}
                options={[
                  { value: "todos", label: "Todos los tipos" },
                  { value: "invoice", label: "Facturas" },
                  { value: "credit_note", label: "Notas de crédito" },
                  { value: "debit_note", label: "Notas de débito" },
                  { value: "quote", label: "Cotizaciones" },
                  { value: "order", label: "Pedidos" },
                ]}
              />
            </div>
            <div className="w-36">
              <SimpleSelect
                ariaLabel="Estado"
                value={estado === "" ? "todos" : estado}
                onValueChange={(v) => {
                  setEstado(v === "todos" ? "" : v);
                  setPagina(1);
                }}
                options={[
                  { value: "todos", label: "Todos los estados" },
                  { value: "draft", label: "Borrador" },
                  { value: "issued", label: "Emitida" },
                  { value: "paid", label: "Pagada" },
                  { value: "annulled", label: "Anulada" },
                ]}
              />
            </div>
            <DateRangePicker
              from={rango.from}
              to={rango.to}
              onChange={(r) => {
                setRango(r);
                setPagina(1);
              }}
            />
            <div className="w-56">
              <EntityPicker
                placeholder="Filtrar por cliente…"
                value={cliente}
                onChange={(v) => {
                  setCliente(v);
                  setPagina(1);
                }}
                buscar={async (q) => {
                  const r = await llamar<{
                    items: { id: string; legal_name: string; tax_id: string | null }[];
                  }>(`/v1/customers?search=${encodeURIComponent(q)}&per_page=8`);
                  return r.items.map((c) => ({
                    id: c.id,
                    label: c.legal_name,
                    ...(c.tax_id === null ? {} : { detalle: c.tax_id }),
                  }));
                }}
              />
            </div>
          </div>
        }
        empty={{
          icon: Receipt,
          title: "Sin documentos con estos filtros",
          description:
            "Cambia el filtro o emite la primera factura — aparecerá aquí con su estado fiscal.",
          action: (
            <Button
              variant="primary"
              size="sm"
              onClick={() => void navigate("/admin/ventas/nueva")}
            >
              Nueva factura
            </Button>
          ),
        }}
      />
    </div>
  );
}
