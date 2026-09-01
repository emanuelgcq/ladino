import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BookOpenCheck, HandCoins } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { useModulosActivos } from "../../app/shell.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { ExchangeDiffIndicator } from "../../components/ExchangeDiffIndicator.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { Textarea } from "../../ui/input.js";
import { Badge } from "../../ui/badge.js";
import { useToast } from "../../ui/toast.js";
import { mostrarImporte } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { KIND_LABEL, MensajeError, numeroDe } from "./comunes.js";
import { RegistrarPago } from "./RegistrarPago.js";

/**
 * Detalle del documento: líneas, cobros con su diferencial POR PAGO, saldo del
 * servidor, y la trazabilidad al asiento contable. Timeline 360°: quién, qué y
 * con qué versión de reglas — todo del servidor, nada recalculado.
 */
interface Documento {
  id: string;
  kind: string;
  series: string;
  document_number: number | null;
  control_number: number | null;
  status: string;
  issued_at: string | null;
  annulled_at: string | null;
  annul_reason: string | null;
  customer_id: string;
  transaction_currency: string;
  functional_currency: string;
  fx_rate: string;
  rate_source: string;
  subtotal_amount: string;
  tax_amount: string;
  total_amount: string;
  amount_transaction_currency: string;
  rules_version: string | null;
}
interface Linea {
  id: string;
  line_number: number;
  description: string;
  quantity: string;
  unit_price_transaction: string;
  tax_rate_snapshot: string;
  tax_amount: string;
  line_subtotal_transaction: string;
  line_total_transaction: string;
  transaction_currency: string;
}
interface Pago {
  id: string;
  paid_at: string;
  currency: string;
  amount: string;
  fx_rate: string;
  rate_source: string;
  functional_amount: string;
  instrument: string;
  reference: string | null;
}
interface Diferencia {
  id: string;
  payment_id: string | null;
  difference: string;
  fx_rate_issue: string;
  fx_rate_payment: string;
}
interface Detalle {
  document: Documento;
  lines: Linea[];
  payments: Pago[];
  exchange_differences: Diferencia[];
  balance: string;
}

export function DetalleFactura(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { empresa, llamar } = useSesion();
  const activos = useModulosActivos();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [pagando, setPagando] = useState(false);
  const [errorAccion, setErrorAccion] = useState<unknown>(null);

  const detalle = useQuery({
    queryKey: ["documento", empresa.id, id],
    enabled: id !== undefined,
    queryFn: () => llamar<Detalle>(`/v1/documents/${id}`),
  });

  const cliente = useQuery({
    queryKey: ["cliente", empresa.id, detalle.data?.document.customer_id],
    enabled: detalle.data !== undefined,
    queryFn: () =>
      llamar<{ legal_name: string; tax_id: string | null }>(
        `/v1/customers/${detalle.data?.document.customer_id}`,
      ),
  });

  /**
   * Trazabilidad al asiento SIN endpoint nuevo: la lista de asientos filtra
   * por source_kind y aquí se localiza el del documento. Si no aparece y la
   * cola lo tiene, es «en cola»; si no está en ninguna parte con contabilidad
   * activa, es el estado que coverage-gaps vigila.
   */
  const asiento = useQuery({
    queryKey: ["asiento-de", empresa.id, id],
    enabled: detalle.data !== undefined && activos.contabilidad,
    queryFn: async () => {
      const kind =
        detalle.data?.document.kind === "invoice" ? "sales_invoice" : "sales_credit_note";
      const [entradas, cola] = await Promise.all([
        llamar<{ items: { id: string; entry_number: number | null; source_id: string }[] }>(
          `/v1/journal-entries?source_kind=${kind}&per_page=100`,
        ),
        llamar<{ items: { source_id: string }[] }>(`/v1/accounting/pending`).catch(() => ({
          items: [],
        })),
      ]);
      const entrada = entradas.items.find((e) => e.source_id === id);
      if (entrada !== undefined) return { estado: "posted" as const, entrada };
      if (cola.items.some((f) => f.source_id === id)) return { estado: "queued" as const };
      return { estado: "pending" as const };
    },
  });

  if (detalle.isPending || detalle.data === undefined) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const { document: doc, lines, payments, exchange_differences, balance } = detalle.data;
  const difPorPago = new Map(exchange_differences.map((d) => [d.payment_id, d]));
  const dual = doc.transaction_currency !== doc.functional_currency;
  const pagable = doc.kind === "invoice" && (doc.status === "issued" || doc.status === "paid");

  async function anular(): Promise<void> {
    setErrorAccion(null);
    try {
      await llamar(`/v1/invoices/${doc.id}/annul`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: motivo }),
      });
      toast.success("Factura anulada", "El correlativo se conserva; el asiento se reversó.");
      await qc.invalidateQueries({ queryKey: ["documento", empresa.id, id] });
    } catch (e) {
      setErrorAccion(e);
      toast.error("No se pudo anular");
    }
  }

  return (
    <div>
      <PageHeader
        title={`${KIND_LABEL[doc.kind] ?? doc.kind} ${numeroDe(doc)}`}
        description={
          cliente.data !== undefined
            ? `${cliente.data.legal_name}${cliente.data.tax_id === null ? "" : ` · ${cliente.data.tax_id}`}`
            : undefined
        }
        actions={
          <>
            {doc.status === "issued" && doc.kind === "invoice" && (
              <Button variant="ghost" onClick={() => setAnulando(true)}>
                <Ban /> Anular
              </Button>
            )}
            {pagable && !esCero(balance) && (
              <Button variant="primary" onClick={() => setPagando(true)}>
                <HandCoins /> Registrar cobro
              </Button>
            )}
          </>
        }
      />

      {errorAccion !== null && (
        <div className="mb-3">
          <MensajeError error={errorAccion} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Líneas</CardTitle>
              <FiscalStatusBadge estado={doc.status} />
            </CardHeader>
            <CardContent className="px-0 pb-1">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Descripción</TH>
                    <TH className="text-right">Cantidad</TH>
                    <TH className="text-right">Precio</TH>
                    <TH className="text-right">IVA</TH>
                    <TH className="text-right">Total</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => (
                    <TR key={l.id}>
                      <TD className="text-faint-foreground">{l.line_number}</TD>
                      <TD className="max-w-64 truncate whitespace-normal">{l.description}</TD>
                      <TDNum>{l.quantity}</TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: l.unit_price_transaction,
                          currency: l.transaction_currency,
                        })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({ amount: l.tax_amount, currency: l.transaction_currency })}
                      </TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: l.line_total_transaction,
                          currency: l.transaction_currency,
                        })}
                      </TDNum>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cobros aplicados</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-1">
              {payments.length === 0 ? (
                <p className="px-4 pb-3 text-[0.88rem] text-muted-foreground">
                  Sin cobros todavía.
                </p>
              ) : (
                <Table>
                  <THead>
                    <TR>
                      <TH>Fecha</TH>
                      <TH>Instrumento</TH>
                      <TH>Referencia</TH>
                      <TH className="text-right">Importe</TH>
                      <TH className="text-right">Diferencial</TH>
                    </TR>
                  </THead>
                  <TBody>
                    {payments.map((p) => {
                      const dif = difPorPago.get(p.id);
                      return (
                        <TR key={p.id}>
                          <TD>{p.paid_at.slice(0, 10)}</TD>
                          <TD>{p.instrument.replace(/_/g, " ")}</TD>
                          <TD className="text-muted-foreground">{p.reference ?? "—"}</TD>
                          <TD>
                            <DualMoney
                              variant="cell"
                              amount={p.amount}
                              currency={p.currency}
                              secondary={
                                p.currency === doc.functional_currency
                                  ? null
                                  : {
                                      amount: p.functional_amount,
                                      currency: doc.functional_currency,
                                    }
                              }
                              rate={{ rate: p.fx_rate, source: p.rate_source }}
                            />
                          </TD>
                          <TD className="text-right">
                            {dif === undefined ? (
                              <span className="text-faint-foreground">—</span>
                            ) : (
                              <ExchangeDiffIndicator
                                difference={dif.difference}
                                currency={doc.functional_currency}
                              />
                            )}
                          </TD>
                        </TR>
                      );
                    })}
                  </TBody>
                </Table>
              )}
            </CardContent>
          </Card>

          {exchange_differences.length > 0 && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {exchange_differences.map((d) => (
                <ExchangeDiffIndicator
                  key={d.id}
                  variant="detail"
                  difference={d.difference}
                  currency={doc.functional_currency}
                  rateIssue={d.fx_rate_issue}
                  ratePayment={d.fx_rate_payment}
                />
              ))}
            </div>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Totales</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5 text-[0.9rem]">
              <Fila etiqueta="Subtotal">
                {mostrarImporte({ amount: doc.subtotal_amount, currency: doc.functional_currency })}
              </Fila>
              <Fila etiqueta="IVA">
                {mostrarImporte({ amount: doc.tax_amount, currency: doc.functional_currency })}
              </Fila>
              <div className="my-2 h-px bg-border" />
              <Fila etiqueta="Total" destacada>
                <DualMoney
                  amount={doc.amount_transaction_currency}
                  currency={doc.transaction_currency}
                  secondary={
                    dual ? { amount: doc.total_amount, currency: doc.functional_currency } : null
                  }
                  rate={{ rate: doc.fx_rate, source: doc.rate_source }}
                />
              </Fila>
              <Fila etiqueta="Saldo" destacada>
                <span
                  className={
                    esCero(balance)
                      ? "font-mono text-accent-soft-foreground"
                      : "font-mono text-warning-soft-foreground"
                  }
                >
                  {mostrarImporte({ amount: balance, currency: doc.functional_currency })}
                </span>
              </Fila>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Trazabilidad</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-[0.85rem]">
              {doc.control_number !== null && (
                <Fila etiqueta="N.º de control">
                  <span className="font-mono">{doc.control_number}</span>
                </Fila>
              )}
              <Fila etiqueta="Versión de reglas">
                <span className="font-mono text-[0.8rem]">{doc.rules_version ?? "—"}</span>
              </Fila>
              {doc.annul_reason !== null && (
                <Fila etiqueta="Motivo de anulación">{doc.annul_reason}</Fila>
              )}
              <div className="pt-1">
                {!activos.contabilidad ? (
                  <p className="text-muted-foreground">Contabilidad no configurada.</p>
                ) : asiento.isPending ? (
                  <Skeleton className="h-6 w-40" />
                ) : asiento.data?.estado === "posted" ? (
                  <Link
                    to="/contabilidad"
                    className="inline-flex items-center gap-1.5 font-medium text-accent-soft-foreground hover:underline"
                  >
                    <BookOpenCheck className="size-4" /> Asiento n.º{" "}
                    {asiento.data.entrada.entry_number ?? "—"} en el diario
                  </Link>
                ) : asiento.data?.estado === "queued" ? (
                  <FiscalStatusBadge estado="queued" />
                ) : (
                  <FiscalStatusBadge estado="pending_accounting" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      <ConfirmDialog
        open={anulando}
        onOpenChange={setAnulando}
        title={`Anular la factura ${numeroDe(doc)}`}
        confirmLabel="Anular la factura"
        destructive
        onConfirm={anular}
      >
        <div className="space-y-2">
          <p>
            La factura quedará <Badge tone="destructive">Anulada</Badge>, su correlativo{" "}
            <strong>se conserva</strong> (nunca se reutiliza), el inventario que descargó se repone
            y su asiento contable se <strong>reversa</strong> con un contra-asiento. Esto no se
            puede deshacer: lo que corrige una factura emitida es una nota de crédito.
          </p>
          <Textarea
            aria-label="Motivo de anulación"
            placeholder="Motivo (obligatorio, mínimo 3 caracteres)…"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
        </div>
      </ConfirmDialog>

      {pagando && (
        <RegistrarPago
          documento={doc}
          balance={balance}
          onClose={(hecho) => {
            setPagando(false);
            if (hecho) {
              void qc.invalidateQueries({ queryKey: ["documento", empresa.id, id] });
            }
          }}
        />
      )}

      <div className="mt-4">
        <Button variant="ghost" size="sm" onClick={() => void navigate(-1)}>
          ← Volver
        </Button>
      </div>
    </div>
  );
}

function Fila({
  etiqueta,
  children,
  destacada = false,
}: {
  etiqueta: string;
  children: React.ReactNode;
  destacada?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-muted-foreground">{etiqueta}</span>
      <span className={destacada ? "font-medium" : undefined}>{children}</span>
    </div>
  );
}
