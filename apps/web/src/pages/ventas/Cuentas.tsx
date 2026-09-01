import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { BarChart, Bar, XAxis, ResponsiveContainer, Cell } from "recharts";
import { Banknote } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { EmptyState } from "../../components/EmptyState.js";
import { EntityPicker, type EntityOption } from "../../components/forms.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { mostrarImporte } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { numeroDe, KIND_LABEL } from "./comunes.js";

/**
 * Estado de cuenta del cliente con su AGING visual. Todas las cifras —saldos,
 * buckets, totales— las calcula `platform.ar_aging` y compañía en el servidor;
 * el gráfico usa los valores solo como geometría de barras y cada número
 * visible es el string que llegó.
 */
interface DocumentoStatement {
  id: string;
  kind: string;
  series: string;
  document_number: number | null;
  issued_at: string | null;
  status: string;
  total_amount: string;
  paid_amount: string;
  balance: string | null;
  days_outstanding: number;
}
interface Statement {
  customer_id: string;
  currency: string;
  documents: DocumentoStatement[];
  credits: { id: string; amount: string; applied_amount: string; status: string }[];
  total_outstanding: string;
  total_credit_available: string;
  aging: {
    reference_date: string;
    buckets: { bucket: string; document_count: number; amount: string }[];
    total: string;
  };
}

export function Cuentas(): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [cliente, setCliente] = useState<EntityOption | null>(null);

  // ?cliente=<id> — la paleta y otros módulos llegan aquí con el cliente puesto.
  const clienteParam = params.get("cliente");
  const precargado = useQuery({
    queryKey: ["cliente", empresa.id, clienteParam],
    enabled: clienteParam !== null && cliente === null,
    queryFn: () =>
      llamar<{ id: string; legal_name: string; tax_id: string | null }>(
        `/v1/customers/${clienteParam}`,
      ),
  });
  useEffect(() => {
    const c = precargado.data;
    if (c !== undefined && cliente === null) {
      setCliente({
        id: c.id,
        label: c.legal_name,
        ...(c.tax_id === null ? {} : { detalle: c.tax_id }),
      });
    }
  }, [precargado.data, cliente]);

  const statement = useQuery({
    queryKey: ["statement", empresa.id, cliente?.id],
    enabled: cliente !== null,
    queryFn: () => llamar<Statement>(`/v1/customers/${cliente?.id}/statement`),
  });

  return (
    <div>
      <PageHeader
        title="Cuentas por cobrar"
        description="Estado de cuenta por cliente: saldo, antigüedad y cada documento con su historia."
      />
      <div className="mb-4 max-w-md">
        <EntityPicker
          placeholder="Elige un cliente para ver su cuenta…"
          value={cliente}
          onChange={(v) => {
            setCliente(v);
            if (v === null) setParams({});
            else setParams({ cliente: v.id });
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

      {cliente === null ? (
        <EmptyState
          icon={Banknote}
          title="Elige un cliente"
          description="Su estado de cuenta aparece aquí: saldo pendiente, aging y documentos."
        />
      ) : statement.isPending || statement.data === undefined ? (
        <div className="space-y-3">
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <EstadoDeCuenta
          data={statement.data}
          onAbrirDocumento={(id) => void navigate(`/admin/ventas/${id}`)}
        />
      )}
    </div>
  );
}

const ETIQUETA_BUCKET: Record<string, string> = {
  current: "Al día",
  "1_30": "1–30 días",
  "31_60": "31–60",
  "61_90": "61–90",
  over_90: "+90 días",
};

function EstadoDeCuenta({
  data,
  onAbrirDocumento,
}: {
  data: Statement;
  onAbrirDocumento: (id: string) => void;
}): React.JSX.Element {
  const barras = data.aging.buckets.map((b) => ({
    nombre: ETIQUETA_BUCKET[b.bucket] ?? b.bucket,
    // SOLO altura de barra; la cifra visible es el string del servidor.
    v: Number(b.amount),
    etiqueta: mostrarImporte({ amount: b.amount, currency: data.currency }),
    tardio: b.bucket === "61_90" || b.bucket === "over_90",
  }));

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <Card>
        <CardHeader>
          <CardTitle>Saldo pendiente</CardTitle>
        </CardHeader>
        <CardContent>
          <DualMoney variant="kpi" amount={data.total_outstanding} currency={data.currency} />
          {!esCero(data.total_credit_available) && (
            <p className="mt-2 text-[0.85rem] text-muted-foreground">
              Saldo a favor disponible:{" "}
              <span className="font-mono text-accent-soft-foreground">
                {mostrarImporte({ amount: data.total_credit_available, currency: data.currency })}
              </span>
            </p>
          )}
        </CardContent>
      </Card>

      <Card className="lg:col-span-2">
        <CardHeader>
          <CardTitle>Antigüedad de saldos</CardTitle>
          <span className="text-[0.8rem] text-muted-foreground">
            al {data.aging.reference_date}
          </span>
        </CardHeader>
        <CardContent>
          {barras.length === 0 || esCero(data.aging.total) ? (
            <p className="text-[0.88rem] text-muted-foreground">Nada vencido ni por vencer.</p>
          ) : (
            <div className="h-36">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={barras} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
                  <XAxis
                    dataKey="nombre"
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
                  />
                  <Bar dataKey="v" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                    {barras.map((b) => (
                      <Cell key={b.nombre} fill={b.tardio ? "var(--warning)" : "var(--accent)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[0.8rem] text-muted-foreground">
            {data.aging.buckets.map((b) => (
              <span key={b.bucket} className="font-mono">
                {ETIQUETA_BUCKET[b.bucket] ?? b.bucket}:{" "}
                {mostrarImporte({ amount: b.amount, currency: data.currency })} ({b.document_count})
              </span>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="lg:col-span-3">
        <CardHeader>
          <CardTitle>Documentos</CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-1">
          <Table>
            <THead>
              <TR>
                <TH>Fecha</TH>
                <TH>Documento</TH>
                <TH>Estado</TH>
                <TH className="text-right">Total</TH>
                <TH className="text-right">Cobrado</TH>
                <TH className="text-right">Saldo</TH>
                <TH className="text-right">Días</TH>
              </TR>
            </THead>
            <TBody>
              {data.documents.map((d) => (
                <TR
                  key={d.id}
                  data-clickable
                  onClick={() => onAbrirDocumento(d.id)}
                  className="cursor-pointer"
                >
                  <TD>{d.issued_at?.slice(0, 10) ?? "—"}</TD>
                  <TD>
                    <span className="font-mono text-[0.84rem]">
                      {KIND_LABEL[d.kind] ?? d.kind} {numeroDe(d)}
                    </span>
                  </TD>
                  <TD>
                    <FiscalStatusBadge estado={d.status} />
                  </TD>
                  <TDNum>
                    {mostrarImporte({ amount: d.total_amount, currency: data.currency })}
                  </TDNum>
                  <TDNum>
                    {mostrarImporte({ amount: d.paid_amount, currency: data.currency })}
                  </TDNum>
                  {/* Una ANULADA llega con saldo NULL del servidor: no hay
                      deuda que mostrar, y pintarla como 0 diría «pagada». */}
                  <TDNum
                    className={
                      d.balance === null || esCero(d.balance)
                        ? "text-faint-foreground"
                        : "text-warning-soft-foreground"
                    }
                  >
                    {d.balance === null
                      ? "—"
                      : mostrarImporte({ amount: d.balance, currency: data.currency })}
                  </TDNum>
                  <TDNum className={d.days_outstanding > 60 ? "text-warning-soft-foreground" : ""}>
                    {d.days_outstanding}
                  </TDNum>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
