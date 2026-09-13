import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BookOpenCheck, FileMinus2, FilePlus2, HandCoins, Undo2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { abrirPdf as abrirPdfApi } from "../../pdf.js";
import { useModulosActivos } from "../../app/shell.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { ExchangeDiffIndicator } from "../../components/ExchangeDiffIndicator.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { Button } from "../../ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../../ui/dialog.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card.js";
import { Skeleton } from "../../ui/card.js";
import { Table, TBody, TD, TDNum, TH, THead, TR } from "../../ui/table.js";
import { Input, Textarea } from "../../ui/input.js";
import { Badge } from "../../ui/badge.js";
import { SimpleSelect } from "../../ui/select.js";
import { useToast } from "../../ui/toast.js";
import { mostrarCantidad, mostrarImporte } from "../../money.js";
import { esCero } from "../../components/decimal-compare.js";
import { EntityPicker, type EntityOption } from "../../components/forms.js";
import { KIND_LABEL, MensajeError, numeroDe } from "./comunes.js";
import { CobrarDocumento } from "../../components/CobrarDocumento.js";
import { numeroDocumento } from "../../components/documento.js";
import { errorDePersona } from "../../lib.js";
import { fechaLocal } from "../../fechas.js";

/** El `source_kind` con el que cada tipo de documento genera su asiento. */
const SOURCE_KIND: Record<string, string> = {
  invoice: "sales_invoice",
  receipt: "sales_receipt",
  credit_note: "sales_credit_note",
  debit_note: "sales_debit_note",
};

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
  /** NULL en una anulada: no hay deuda, que no es lo mismo que deuda cero. */
  balance: string | null;
}
/** Un documento emitido SOBRE este (nota de crédito, de débito…), del listado. */
interface DocumentoRelacionado {
  id: string;
  kind: string;
  series: string;
  document_number: number | null;
  status: string;
  issued_at: string | null;
  functional_currency: string;
  total_amount: string;
}

export function DetalleFactura(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  const { empresa, llamar, puede } = useSesion();
  const activos = useModulosActivos();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [anulando, setAnulando] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [pagando, setPagando] = useState(false);
  const [devolviendo, setDevolviendo] = useState(false);
  const [notaCredito, setNotaCredito] = useState(false);
  const [notaDebito, setNotaDebito] = useState(false);
  const [confirmandoPedido, setConfirmandoPedido] = useState(false);
  const [almacenPedido, setAlmacenPedido] = useState<string | null>(null);
  const depositosPedido = useQuery({
    queryKey: ["depositos", empresa.id],
    queryFn: () => llamar<{ id: string; code: string; name: string }[]>("/v1/warehouses"),
  });
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
   * Trazabilidad al asiento: la lista de asientos filtra por el documento
   * ORIGEN (source_id + source_kind), sin barrer cien filas. Si no hay asiento
   * y la cola lo tiene, es «en cola»; si no está en ninguna parte con
   * contabilidad activa, es el estado que coverage-gaps vigila.
   */
  const kindDocumento = detalle.data?.document.kind;
  const asiento = useQuery({
    queryKey: ["asiento-de", empresa.id, id, kindDocumento],
    enabled:
      detalle.data !== undefined &&
      activos.contabilidad &&
      kindDocumento !== undefined &&
      SOURCE_KIND[kindDocumento] !== undefined,
    queryFn: async () => {
      const kind = SOURCE_KIND[kindDocumento ?? ""] ?? "sales_invoice";
      const [entradas, cola] = await Promise.all([
        llamar<{ items: { id: string; entry_number: number | null; source_id: string }[] }>(
          `/v1/journal-entries?source_id=${id}&source_kind=${kind}&per_page=5`,
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

  /**
   * Lo emitido SOBRE este documento: notas de crédito (devoluciones y NC
   * directas), notas de débito. Es la otra mitad de la historia de la
   * factura, y antes había que buscarla a mano en el listado.
   */
  const notas = useQuery({
    queryKey: ["notas-sobre", empresa.id, id],
    enabled: detalle.data !== undefined,
    queryFn: () =>
      llamar<{ items: DocumentoRelacionado[]; total: number }>(
        `/v1/documents?source_document_id=${id}&per_page=50`,
      ),
  });

  /**
   * Tras cualquier cambio de estado del documento (cobro, anulación, nota,
   * devolución) caducan también el listado de ventas y las tarjetas del
   * panel: la factura cambió de estado y el panel la cuenta.
   */
  function invalidarTrasCambio(): void {
    void qc.invalidateQueries({ queryKey: ["documento", empresa.id, id] });
    void qc.invalidateQueries({ queryKey: ["notas-sobre", empresa.id, id] });
    void qc.invalidateQueries({ queryKey: ["documentos", empresa.id] });
    void qc.invalidateQueries({
      predicate: (q) => typeof q.queryKey[0] === "string" && q.queryKey[0].startsWith("dash-"),
    });
  }

  if (detalle.isError) {
    // Un fallo al cargar no es un esqueleto eterno: se dice y se reintenta.
    return (
      <div className="space-y-3">
        <PageHeader title="Documento" />
        <MensajeError error={detalle.error} />
        <Button variant="secondary" onClick={() => void detalle.refetch()}>
          Reintentar
        </Button>
      </div>
    );
  }
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

  /**
   * La COPIA imprime «SIN DERECHO A CRÉDITO FISCAL» (PA 00071 art. 13.13):
   * existía en el generador sin ningún botón (Nivel C de la auditoría).
   */
  function abrirPdf(copia: boolean): void {
    void abrirPdfApi(`/v1/documents/${doc.id}/pdf${copia ? "?copia=1" : ""}`, empresa.id, (m) =>
      toast.error("No se pudo abrir el PDF", m),
    );
  }

  async function anular(): Promise<void> {
    setErrorAccion(null);
    try {
      await llamar(`/v1/invoices/${doc.id}/annul`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: empresa.id, reason: motivo }),
      });
      toast.success("Factura anulada", "El correlativo se conserva; el asiento se reversó.");
      invalidarTrasCambio();
    } catch (e) {
      setErrorAccion(e);
      toast.error("No se pudo anular", errorDePersona(e));
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
            {/* Los permisos son cortesía de UX (ADR-0048): el servidor los exige igual. */}
            {doc.status === "issued" && doc.kind === "invoice" && puede("sales.invoice.annul") && (
              <Button variant="ghost" onClick={() => setAnulando(true)}>
                <Ban /> Anular
              </Button>
            )}
            {doc.document_number !== null && (
              <>
                <Button variant="ghost" onClick={() => void abrirPdf(false)}>
                  PDF
                </Button>
                {doc.kind !== "receipt" && (
                  <Button variant="ghost" onClick={() => void abrirPdf(true)}>
                    PDF copia
                  </Button>
                )}
              </>
            )}
            {pagable &&
              balance !== null &&
              !esCero(balance) &&
              !balance.startsWith("-") &&
              puede("sales.payment.register") && (
                <Button variant="primary" onClick={() => setPagando(true)}>
                  <HandCoins /> Registrar cobro
                </Button>
              )}
            {pagable && puede("sales.return.manage") && (
              <Button variant="secondary" onClick={() => setDevolviendo(true)}>
                <Undo2 /> Devolución
              </Button>
            )}
            {pagable && puede("sales.return.manage") && (
              <Button variant="ghost" onClick={() => setNotaCredito(true)}>
                <FileMinus2 /> Nota de crédito…
              </Button>
            )}
            {pagable && puede("sales.invoice.issue") && (
              <Button variant="ghost" onClick={() => setNotaDebito(true)}>
                <FilePlus2 /> Nota de débito…
              </Button>
            )}
            {doc.kind === "order" && doc.status === "draft" && puede("sales.order.manage") && (
              <Button variant="primary" onClick={() => setConfirmandoPedido(true)}>
                Confirmar pedido…
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
                      <TDNum>{mostrarCantidad(l.quantity)}</TDNum>
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
                          <TD>{fechaLocal(p.paid_at)}</TD>
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

          {(doc.kind === "invoice" || doc.kind === "receipt") && (
            <Card>
              <CardHeader>
                <CardTitle>Notas y devoluciones sobre esta factura</CardTitle>
              </CardHeader>
              <CardContent className="px-0 pb-1">
                {notas.isError ? (
                  <div className="space-y-2 px-4 pb-3">
                    <MensajeError error={notas.error} />
                    <Button variant="ghost" size="sm" onClick={() => void notas.refetch()}>
                      Reintentar
                    </Button>
                  </div>
                ) : notas.isPending ? (
                  <div className="px-4 pb-3">
                    <Skeleton className="h-6 w-56" />
                  </div>
                ) : notas.data.items.length === 0 ? (
                  <p className="px-4 pb-3 text-[0.88rem] text-muted-foreground">
                    Ninguna nota emitida sobre este documento.
                  </p>
                ) : (
                  <Table>
                    <THead>
                      <TR>
                        <TH>Tipo</TH>
                        <TH>Número</TH>
                        <TH>Fecha</TH>
                        <TH>Estado</TH>
                        <TH className="text-right">Total</TH>
                      </TR>
                    </THead>
                    <TBody>
                      {notas.data.items.map((n) => (
                        <TR key={n.id}>
                          <TD>{KIND_LABEL[n.kind] ?? n.kind}</TD>
                          <TD>
                            <Link
                              to={`/admin/ventas/${n.id}`}
                              className="font-mono text-[0.84rem] text-accent-soft-foreground hover:underline"
                            >
                              {numeroDocumento(n.series, n.document_number)}
                            </Link>
                          </TD>
                          <TD>{fechaLocal(n.issued_at)}</TD>
                          <TD>
                            <FiscalStatusBadge estado={n.status} />
                          </TD>
                          <TDNum>
                            {mostrarImporte({
                              amount: n.total_amount,
                              currency: n.functional_currency,
                            })}
                          </TDNum>
                        </TR>
                      ))}
                    </TBody>
                  </Table>
                )}
              </CardContent>
            </Card>
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
                {/* El contrato del documento trae los totales FUNCIONALES; el
                    total en divisa vive en las LÍNEAS y no se suma aquí
                    (apps/web/CLAUDE.md). La tasa y la moneda del documento van
                    en el tooltip. */}
                <DualMoney
                  amount={doc.total_amount}
                  currency={doc.functional_currency}
                  rate={
                    dual
                      ? {
                          rate: doc.fx_rate,
                          source: `${doc.rate_source} · doc. en ${doc.transaction_currency}`,
                        }
                      : null
                  }
                />
              </Fila>
              <Fila etiqueta="Saldo" destacada>
                <span
                  className={
                    balance === null || esCero(balance) || balance.startsWith("-")
                      ? "font-mono text-accent-soft-foreground"
                      : "font-mono text-warning-soft-foreground"
                  }
                >
                  {balance === null
                    ? "—"
                    : mostrarImporte({ amount: balance, currency: doc.functional_currency })}
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
                    to={`/admin/contabilidad?asiento=${asiento.data.entrada.id}`}
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
        confirmDisabled={motivo.trim().length < 3}
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

      <ConfirmDialog
        open={confirmandoPedido}
        onOpenChange={setConfirmandoPedido}
        title="Confirmar el pedido"
        confirmLabel="Confirmar y reservar"
        onConfirm={async () => {
          setErrorAccion(null);
          // Sin depósito no hay reserva posible: se para aquí, con la razón
          // dicha, en vez de mandar un `null` al servidor.
          if (almacenPedido === null) {
            const e = new Error("Elige el depósito en el que se reserva.");
            setErrorAccion(e);
            throw e;
          }
          try {
            await llamar("/v1/orders/" + doc.id + "/confirm", {
              method: "POST",
              headers: { "Idempotency-Key": crypto.randomUUID() },
              body: JSON.stringify({ company_id: empresa.id, warehouse_id: almacenPedido }),
            });
            toast.success("Pedido confirmado", "La existencia quedó reservada; nada se movió.");
            invalidarTrasCambio();
          } catch (e) {
            setErrorAccion(e);
            toast.error("No se pudo confirmar el pedido", errorDePersona(e));
            throw e;
          }
        }}
      >
        <div className="space-y-2">
          <p>
            Confirmar <strong>reserva</strong> las cantidades en el depósito elegido: el disponible
            baja sin que la mercancía se mueva. La factura, cuando se emita, descargará de verdad.
          </p>
          {almacenPedido === null && (
            <p className="text-[0.85rem] text-warning-soft-foreground">
              Elige el depósito para poder confirmar.
            </p>
          )}
          <SimpleSelect
            ariaLabel="Depósito de la reserva"
            value={almacenPedido}
            onValueChange={setAlmacenPedido}
            placeholder="¿En qué depósito se reserva?"
            options={(depositosPedido.data ?? []).map((w) => ({
              value: w.id,
              label: w.code + " · " + w.name,
            }))}
          />
        </div>
      </ConfirmDialog>

      {devolviendo && (
        <Devolucion
          documento={doc}
          lineas={lines}
          onClose={(hecho) => {
            setDevolviendo(false);
            if (hecho) invalidarTrasCambio();
          }}
        />
      )}

      {notaCredito && (
        <NotaCreditoDirecta
          documento={doc}
          lineas={lines}
          onClose={(hecho) => {
            setNotaCredito(false);
            if (hecho) invalidarTrasCambio();
          }}
        />
      )}
      {notaDebito && (
        <NotaDebito
          documento={doc}
          onClose={(hecho) => {
            setNotaDebito(false);
            if (hecho) invalidarTrasCambio();
          }}
        />
      )}

      {pagando && (
        <CobrarDocumento
          documentId={doc.id}
          customerId={doc.customer_id}
          saldo={{ amount: balance ?? "0", currency: doc.functional_currency }}
          documentCurrency={doc.transaction_currency}
          etiqueta={numeroDocumento(doc.series, doc.document_number)}
          tasaEmision={dual ? { rate: doc.fx_rate, source: doc.rate_source } : null}
          onCerrar={() => setPagando(false)}
          onCobrado={() => {
            setPagando(false);
            invalidarTrasCambio();
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

/**
 * DEVOLUCIÓN (Nivel B de la auditoría de superficie): el backend completo
 * existía —reingreso AL COSTO ORIGINAL, nota de crédito con su propio rango,
 * saldo a favor— sin ninguna puerta. Dos pasos del contrato (crear y
 * confirmar) en un solo flujo con la consecuencia dicha.
 */
function Devolucion({
  documento,
  lineas,
  onClose,
}: {
  documento: Documento;
  lineas: Linea[];
  onClose: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [motivo, setMotivo] = useState("");
  const [deposito, setDeposito] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);
  /**
   * El borrador YA creado cuando el segundo paso (confirmar) falló: desde
   * este diálogo no se crea otro — se reintenta SOLO el confirm, con la misma
   * llave. Sin esto, cada reintento dejaba un borrador huérfano.
   */
  const [creada, setCreada] = useState<string | null>(null);
  const llaveCrear = useRef(crypto.randomUUID());
  const llaveConfirmar = useRef(crypto.randomUUID());

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    queryFn: () => llamar<{ id: string; name: string }[]>("/v1/warehouses"),
  });
  // El primer depósito por omisión, en un efecto: un setState durante el
  // render es un bucle en potencia.
  useEffect(() => {
    const primero = depositos.data?.[0]?.id;
    if (primero !== undefined) setDeposito((actual) => actual ?? primero);
  }, [depositos.data]);

  const elegidas = lineas
    .map((l) => ({ linea: l, cantidad: (cantidades[l.id] ?? "").trim().replace(",", ".") }))
    .filter((x) => x.cantidad !== "" && Number(x.cantidad) > 0);
  const listo =
    creada !== null || (elegidas.length > 0 && motivo.trim().length >= 3 && deposito !== null);

  async function devolver(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      let id = creada;
      if (id === null) {
        const r = await llamar<{ id: string }>("/v1/returns", {
          method: "POST",
          headers: { "Idempotency-Key": llaveCrear.current },
          body: JSON.stringify({
            company_id: empresa.id,
            source_document_id: documento.id,
            warehouse_id: deposito,
            reason: motivo.trim(),
            lines: elegidas.map((x) => ({ source_line_id: x.linea.id, quantity: x.cantidad })),
          }),
        });
        id = r.id;
        setCreada(id);
      }
      await llamar(`/v1/returns/${id}/confirm`, {
        method: "POST",
        headers: { "Idempotency-Key": llaveConfirmar.current },
      });
      toast.success(
        "Devolución confirmada",
        "La mercancía reingresó a su costo original y la nota de crédito dejó saldo a favor.",
      );
      onClose(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo devolver", errorDePersona(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Devolución de {numeroDe(documento)}</DialogTitle>
        <DialogDescription>
          La mercancía reingresa <strong>al costo con el que salió</strong> —no al de hoy—, y se
          emite una nota de crédito (exige su propio rango de numeración) que deja el saldo a favor
          del cliente.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <div className="divide-y divide-border rounded-md border border-border">
            {lineas.map((l) => (
              <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-[0.9rem]">
                <span className="min-w-0 flex-1 truncate">{l.description}</span>
                <span className="text-[0.8rem] text-muted-foreground tabular-nums">
                  vendidos {mostrarCantidad(l.quantity)}
                </span>
                <Input
                  aria-label={`Cantidad a devolver de ${l.description}`}
                  inputMode="decimal"
                  placeholder="0"
                  className="w-20 text-right font-mono"
                  value={cantidades[l.id] ?? ""}
                  disabled={creada !== null}
                  onChange={(e) => setCantidades({ ...cantidades, [l.id]: e.target.value })}
                />
              </div>
            ))}
          </div>
          {(depositos.data?.length ?? 0) > 1 && (
            <div className="w-56">
              <SimpleSelect
                ariaLabel="Depósito al que reingresa"
                value={deposito}
                onValueChange={setDeposito}
                disabled={creada !== null}
                options={(depositos.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
              />
            </div>
          )}
          <Textarea
            aria-label="Motivo de la devolución"
            rows={2}
            placeholder="Motivo (obligatorio): qué devolvió y por qué"
            value={motivo}
            disabled={creada !== null}
            onChange={(e) => setMotivo(e.target.value)}
          />
          {creada !== null && (
            <p className="text-[0.85rem] text-warning-soft-foreground">
              El borrador de la devolución ya existe; falta confirmarlo. Reintenta la confirmación —
              no se crea otro borrador.
            </p>
          )}
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onClose(false)} disabled={ocupado}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void devolver()}>
            {ocupado
              ? "Devolviendo…"
              : creada !== null
                ? "Reintentar la confirmación"
                : "Confirmar la devolución"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * NOTA DE CRÉDITO DIRECTA (ADR-0051): corrige la factura SIN devolución de
 * mercancía — descuento o corrección de precio. Líneas del origen a su precio
 * original, motivo obligatorio, y el saldo a favor queda aplicable como cobro.
 */
function NotaCreditoDirecta({
  documento,
  lineas,
  onClose,
}: {
  documento: Documento;
  lineas: Linea[];
  onClose: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const elegidas = lineas
    .map((l) => ({ linea: l, cantidad: (cantidades[l.id] ?? "").trim().replace(",", ".") }))
    .filter((x) => x.cantidad !== "" && Number(x.cantidad) > 0);
  const listo = elegidas.length > 0 && motivo.trim().length >= 3;

  async function emitir(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/credit-notes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          source_document_id: documento.id,
          reason: motivo.trim(),
          lines: elegidas.map((x) => ({ source_line_id: x.linea.id, quantity: x.cantidad })),
        }),
      });
      toast.success(
        "Nota de crédito emitida",
        "El saldo a favor quedó disponible para aplicarse a cualquier factura del cliente.",
      );
      onClose(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo emitir la nota de crédito", errorDePersona(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Nota de crédito de {numeroDe(documento)}</DialogTitle>
        <DialogDescription>
          Para descuentos o correcciones de precio <strong>sin mercancía que vuelve</strong> — si el
          cliente devuelve producto, usa Devolución. Las líneas van al precio del origen y el total
          queda como saldo a favor.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          <div className="divide-y divide-border rounded-md border border-border">
            {lineas.map((l) => (
              <div key={l.id} className="flex items-center gap-2 px-3 py-2 text-[0.9rem]">
                <span className="min-w-0 flex-1 truncate">{l.description}</span>
                <span className="text-[0.8rem] text-muted-foreground tabular-nums">
                  facturados {mostrarCantidad(l.quantity)}
                </span>
                <Input
                  aria-label={`Cantidad a acreditar de ${l.description}`}
                  inputMode="decimal"
                  placeholder="0"
                  className="w-20 text-right font-mono"
                  value={cantidades[l.id] ?? ""}
                  onChange={(e) => setCantidades({ ...cantidades, [l.id]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <Textarea
            aria-label="Motivo de la nota de crédito"
            rows={2}
            placeholder="Motivo (obligatorio): qué se corrige y por qué"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void emitir()}>
            {ocupado ? "Emitiendo…" : "Emitir la nota de crédito"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface FilaNotaDebito {
  id: string;
  producto: EntityOption | null;
  cantidad: string;
  precio: string;
}

/**
 * NOTA DE DÉBITO (ADR-0051): el espejo de la factura — intereses de mora,
 * fletes, diferencias de precio. Producto + cantidad + precio EXPLÍCITO en la
 * moneda del origen; motivo obligatorio; sin kardex. ES deuda del cliente.
 */
function NotaDebito({
  documento,
  onClose,
}: {
  documento: Documento;
  onClose: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar } = useSesion();
  const toast = useToast();
  // Cada fila con id ESTABLE: con el índice como key, quitar o reordenar
  // filas hacía que el picker de una heredara el estado de otra.
  const filaNueva = (): FilaNotaDebito => ({
    id: crypto.randomUUID(),
    producto: null,
    cantidad: "1",
    precio: "",
  });
  const [filas, setFilas] = useState<FilaNotaDebito[]>(() => [filaNueva()]);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<unknown>(null);
  const [ocupado, setOcupado] = useState(false);

  const buscarProducto = async (q: string): Promise<EntityOption[]> => {
    const r = await llamar<{ items: { id: string; name: string; sku: string }[] }>(
      `/v1/products?search=${encodeURIComponent(q)}&per_page=8`,
    );
    return r.items.map((p) => ({ id: p.id, label: p.name, detalle: p.sku }));
  };

  const completas = filas.filter(
    (f) =>
      f.producto !== null &&
      Number(f.cantidad.trim().replace(",", ".")) > 0 &&
      Number(f.precio.trim().replace(",", ".")) > 0,
  );
  const listo = completas.length > 0 && motivo.trim().length >= 3;

  async function emitir(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      await llamar("/v1/debit-notes", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          source_document_id: documento.id,
          reason: motivo.trim(),
          lines: completas.map((f) => ({
            product_id: f.producto!.id,
            quantity: f.cantidad.trim().replace(",", "."),
            unit_price: f.precio.trim().replace(",", "."),
          })),
        }),
      });
      toast.success(
        "Nota de débito emitida",
        "El cliente debe también la nota — ya aparece en su cuenta.",
      );
      onClose(true);
    } catch (e) {
      setError(e);
      toast.error("No se pudo emitir la nota de débito", errorDePersona(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose(false)}>
      <DialogContent className="max-w-lg">
        <DialogTitle>Nota de débito de {numeroDe(documento)}</DialogTitle>
        <DialogDescription>
          Cobra lo que la factura no incluyó: intereses de mora, fletes, diferencias de precio. El
          precio va en la moneda de la factura ({documento.transaction_currency}); el impuesto lo
          resuelve el servidor a la fecha de hoy. Exige su propio rango de numeración.
        </DialogDescription>
        <div className="space-y-3 pt-2">
          {filas.map((f, i) => (
            <div key={f.id} className="flex items-end gap-2">
              <div className="min-w-0 flex-1">
                <EntityPicker
                  placeholder="Producto o servicio…"
                  value={f.producto}
                  onChange={(v) =>
                    setFilas((prev) => prev.map((x, j) => (j === i ? { ...x, producto: v } : x)))
                  }
                  buscar={buscarProducto}
                />
              </div>
              <Input
                aria-label="Cantidad"
                inputMode="decimal"
                className="w-16 text-right font-mono"
                value={f.cantidad}
                onChange={(e) =>
                  setFilas((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, cantidad: e.target.value } : x)),
                  )
                }
              />
              <Input
                aria-label={`Precio unitario en ${documento.transaction_currency}`}
                inputMode="decimal"
                placeholder="Precio"
                className="w-24 text-right font-mono"
                value={f.precio}
                onChange={(e) =>
                  setFilas((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, precio: e.target.value } : x)),
                  )
                }
              />
            </div>
          ))}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilas((prev) => [...prev, filaNueva()])}
          >
            Otra línea
          </Button>
          <Textarea
            aria-label="Motivo de la nota de débito"
            rows={2}
            placeholder="Motivo (obligatorio): qué se cobra y por qué"
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
          {error !== null && <MensajeError error={error} />}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="ghost" onClick={() => onClose(false)}>
            Cancelar
          </Button>
          <Button variant="primary" disabled={!listo || ocupado} onClick={() => void emitir()}>
            {ocupado ? "Emitiendo…" : "Emitir la nota de débito"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
