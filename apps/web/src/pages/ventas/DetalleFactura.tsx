import { useEffect, useRef, useState } from "react";
import { formatearDocumento } from "@ladino/schemas";
import { Link, useNavigate, useParams } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, BookOpenCheck, FileMinus2, FilePlus2, HandCoins, Undo2 } from "lucide-react";
import { useSesion } from "../../app/session.js";
import { abrirPdf as abrirPdfApi } from "../../pdf.js";
import { useContabilidadConfigurada } from "../../app/shell.js";
import { PageHeader } from "../../components/PageHeader.js";
import { DualMoney } from "../../components/DualMoney.js";
import { FiscalStatusBadge } from "../../components/FiscalStatusBadge.js";
import { ExchangeDiffIndicator } from "../../components/ExchangeDiffIndicator.js";
import { ConfirmDialog } from "../../components/ConfirmDialog.js";
import { ImprimirFormaLibre } from "../../components/ImprimirFormaLibre.js";
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
import { decisionDeCobro, textoDeDeuda } from "../../components/deuda.js";
import {
  EntityPicker,
  MotivoDeLectura,
  leerCantidad,
  leerImporte,
  motivoDeCantidad,
  motivoDeImporte,
  type EntityOption,
} from "../../components/forms.js";
import { ConfirmarSobregiro, esSinSaldo } from "../../components/sobregiro.js";
import { useConFacturas } from "../../app/modo-venta.js";
import { KIND_LABEL, MensajeError, numeroDe } from "./comunes.js";
import { CobrarDocumento } from "../../components/CobrarDocumento.js";
import { CargarRetencion } from "../libros/Declaraciones.js";
import {
  nombreDeInstrumento,
  type FormaDePago as FormaConfigurada,
} from "../../components/formas-de-pago.js";
import { numeroDocumento } from "../../components/documento.js";
import { errorDePersona } from "../../lib.js";
import { conLlaveDeIntento, intentoAnteriorPudoQuedar } from "../../llave-intento.js";
import { RevisaIntentoAnterior } from "../../components/RevisaIntentoAnterior.js";
import { fechaLocal } from "../../fechas.js";
import {
  ANULACION,
  CORREGIR_RETIRO,
  PEDIDO_COMPUESTO_NO_RESERVA,
  TIPOS_FISCALES,
} from "../../components/capa-fiscal/textos.js";
import { ReversarCobro } from "../../components/ReversarCobro.js";

/**
 * «CORREGIR ESTE RETIRO» (ADR-0082, AF3-06). Un solo botón y dos caminos, y cuál toca lo decide el
 * SERVIDOR (`annulment.allowed`): si la factura de retiro todavía se puede anular (mismo día,
 * caja abierta, papel en la mano) se anula; si no, la nota de crédito que deja sin efecto el
 * retiro entero. Lo que va a pasar se dice antes de confirmar; la pantalla no calcula nada.
 */
function CorregirRetiro({
  documentoId,
  numero,
  empresaId,
  seAnula,
  llamar,
  onHecho,
}: {
  documentoId: string;
  numero: string;
  empresaId: string;
  seAnula: boolean;
  llamar: <T>(ruta: string, init?: RequestInit) => Promise<T>;
  onHecho: () => void;
}): React.JSX.Element {
  const toast = useToast();
  const [abierto, setAbierto] = useState(false);
  const [motivo, setMotivo] = useState("");
  const [papel, setPapel] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const abrir = (v: boolean): void => {
    setPapel(false);
    setError(null);
    setAbierto(v);
  };
  async function corregir(): Promise<void> {
    setError(null);
    try {
      await llamar(
        seAnula
          ? `/v1/invoices/${documentoId}/annul`
          : `/v1/invoices/${documentoId}/withdrawal-credit-note`,
        {
          method: "POST",
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            company_id: empresaId,
            reason: motivo.trim(),
            ...(seAnula ? { originals_in_hand: papel } : {}),
          }),
        },
      );
      toast.success(CORREGIR_RETIRO.hecho);
      setAbierto(false);
      onHecho();
    } catch (e) {
      setError(e);
      toast.error("No se pudo corregir el retiro", errorDePersona(e));
    }
  }
  return (
    <>
      <Button variant="ghost" onClick={() => abrir(true)}>
        <Undo2 /> {CORREGIR_RETIRO.boton}
      </Button>
      <ConfirmDialog
        open={abierto}
        onOpenChange={abrir}
        title={`${CORREGIR_RETIRO.boton}: factura ${numero}`}
        confirmLabel={seAnula ? "Anular la factura de retiro" : "Emitir la nota de crédito"}
        destructive
        confirmDisabled={motivo.trim().length < 3 || (seAnula && !papel)}
        onConfirm={corregir}
      >
        <div className="space-y-2">
          <p>{seAnula ? CORREGIR_RETIRO.anular : CORREGIR_RETIRO.nota}</p>
          {seAnula && (
            <label className="flex items-start gap-2 text-[0.9rem]">
              <input
                type="checkbox"
                className="mt-1"
                checked={papel}
                onChange={(e) => setPapel(e.target.checked)}
              />
              <span>{ANULACION.papelEnMano}</span>
            </label>
          )}
          <Textarea
            aria-label={CORREGIR_RETIRO.motivo}
            placeholder={`${CORREGIR_RETIRO.motivo} (obligatorio, mínimo 3 caracteres)…`}
            value={motivo}
            onChange={(e) => setMotivo(e.target.value)}
          />
          {error !== null && <MensajeError error={error} />}
        </div>
      </ConfirmDialog>
    </>
  );
}

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
  /** El control ya vestido por el servidor, `00-00001234` (ADR-0071 §4). */
  control_display: string | null;
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
  /** El comprobante de retención soportada que este abono aplicó, si lo es. */
  supported_retention_id?: string | null;
  /** H4 (ADR-0075 §8): si el cobro está reversado, cuándo, por quién y por qué. */
  reversal?: { reversed_at: string; reversed_by_name: string | null; reason: string } | null;
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
  /** ADR-0076 (O-02): quién armó la cuenta del POS que esta venta cerró. */
  pos_cart?: { author_id: string | null; author_name: string | null } | null;
  /**
   * G-10 / G-14: si se puede anular AHORA y, si no, por qué y cuál es el camino. Lo decide el
   * servidor (día de Caracas, cierre de caja, período, cobros); la pantalla solo lo muestra.
   */
  annulment?: { allowed: boolean; reason: string | null; message: string | null } | null;
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
  // Sin RIF: recibos y lenguaje sencillo — nada de correlativos, asientos ni versión de reglas.
  const conFacturas = useConFacturas();
  // «¿Hay contabilidad configurada que yo pueda leer?» — no la sonda del MENÚ (A-04), que solo se
  // enciende con el primer asiento posteado: con ella, la primera factura decía «Contabilidad no
  // configurada» con su asiento ya escrito, y la consulta del asiento ni se lanzaba.
  const contabilidad = useContabilidadConfigurada();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [anulando, setAnulando] = useState(false);
  const [imprimiendo, setImprimiendo] = useState(false);
  const [motivo, setMotivo] = useState("");
  /** G-10 (PA 00071 art. 36): la persona confirma que el original y las copias no salieron. */
  const [papelEnMano, setPapelEnMano] = useState(false);
  // La confirmación del papel vale para UN intento sobre UN documento: se reinicia al abrir y al
  // cerrar el diálogo, y al cambiar de `:id` (el componente no se desmonta entre documentos).
  const abrirAnulacion = (abierto: boolean): void => {
    setPapelEnMano(false);
    setAnulando(abierto);
  };
  useEffect(() => {
    setPapelEnMano(false);
    setAnulando(false);
  }, [id]);
  const [pagando, setPagando] = useState(false);
  // La reversa de un cobro o de una retención soportada (ADR-0075 §8): el cobro elegido.
  const [reversando, setReversando] = useState<Pago | null>(null);
  const [devolviendo, setDevolviendo] = useState(false);
  const [notaCredito, setNotaCredito] = useState(false);
  const [notaDebito, setNotaDebito] = useState(false);
  const [confirmandoPedido, setConfirmandoPedido] = useState(false);
  const [almacenPedido, setAlmacenPedido] = useState<string | null>(null);
  const depositosPedido = useQuery({
    queryKey: ["depositos", empresa.id],
    // Solo los activos: un depósito apagado no recibe ni despacha (migración 60).
    queryFn: () =>
      llamar<({ id: string; code: string; name: string } & { status?: string })[]>(
        "/v1/warehouses",
      ).then((ws) => ws.filter((w) => w.status !== "inactive")),
  });
  const [errorAccion, setErrorAccion] = useState<unknown>(null);
  // Las formas configuradas: para llamar a cada cobro por su nombre, no por el código del
  // instrumento (QA de pantalla 2026-09-15, h. 39).
  const formasPago = useQuery({
    queryKey: ["formas-pago", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: () => llamar<{ methods: FormaConfigurada[] }>("/v1/payment-methods"),
  });
  const nombreDeForma = (i: string): string => nombreDeInstrumento(i, formasPago.data?.methods);

  const detalle = useQuery({
    queryKey: ["documento", empresa.id, id],
    enabled: id !== undefined,
    queryFn: () => llamar<Detalle>(`/v1/documents/${id}`),
  });

  const cliente = useQuery({
    queryKey: ["cliente", empresa.id, detalle.data?.document.customer_id],
    enabled: detalle.data !== undefined,
    queryFn: () =>
      llamar<{ legal_name: string; tax_id: string | null; is_system?: boolean }>(
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
      contabilidad.configurada &&
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
        <Skeleton className="h-8 w-72 max-w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }
  const { document: doc, lines, payments, exchange_differences, balance, annulment } = detalle.data;
  const difPorPago = new Map(exchange_differences.map((d) => [d.payment_id, d]));
  const dual = doc.transaction_currency !== doc.functional_currency;
  const pagable = doc.kind === "invoice" && (doc.status === "issued" || doc.status === "paid");
  // Un recibo FIADO también se cobra: el servidor siempre lo aceptó (registerPayment no mira el
  // kind), pero el botón exigía factura y el diálogo de fiar mandaba a cobrar «desde Clientes o
  // Mi dinero», donde no había cómo (QA de pantalla 2026-09-15, h. 26).
  const cobrable = (doc.kind === "invoice" || doc.kind === "receipt") && doc.status === "issued";
  // ADR-0061: un recibo también se devuelve (con recibo de devolución), y
  // factura y recibo se anulan solo mientras NO tengan cobros — con cobros, el
  // camino es la devolución.
  const devolvible =
    (doc.kind === "invoice" || doc.kind === "receipt") &&
    (doc.status === "issued" || doc.status === "paid");
  // G-10 / G-14: si se anula lo dice el SERVIDOR (`annulment`); la pantalla no rehace la regla.
  const anulable =
    (doc.kind === "invoice" || doc.kind === "receipt") &&
    doc.status === "issued" &&
    annulment?.allowed === true;
  /** Por qué «Anular» no está, en palabras del servidor: se dice, no se esconde (G-14). */
  const porQueNoSeAnula = annulment != null && !annulment.allowed ? annulment.message : null;
  const nombreDoc = doc.kind === "receipt" ? "recibo" : "factura";
  // Solo la factura, la NC y la ND —y la factura de retiro y su nota (ADR-0082)— son fiscales:
  // la cotización y el pedido imprimen «PDF» a secas (H2).
  const esFiscal = TIPOS_FISCALES.includes(doc.kind);

  /**
   * Los destinos del PDF (ADR-0071 §4): sin destino, la COPIA DE CORTESÍA (lo que se descarga o
   * se envía; no es la factura); `papel`, para imprimir SOBRE la forma libre, con lo preimpreso en
   * blanco; `vista`, la vista previa con lo preimpreso sombreado. La COPIA impresa lleva «SIN
   * DERECHO A CRÉDITO FISCAL» (PA 00071 art. 13.13). La web solo pide: el servidor arma el papel.
   */
  function abrirPdf(destino: "cortesia" | "papel" | "vista", copia = false): void {
    const params = new URLSearchParams();
    if (destino !== "cortesia") params.set("destino", destino);
    if (copia) params.set("copia", "1");
    const q = params.toString();
    void abrirPdfApi(`/v1/documents/${doc.id}/pdf${q === "" ? "" : `?${q}`}`, empresa.id, (m) =>
      toast.error("No se pudo abrir el PDF", m),
    );
  }

  async function anular(): Promise<void> {
    setErrorAccion(null);
    try {
      await llamar(`/v1/invoices/${doc.id}/annul`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: empresa.id,
          reason: motivo,
          // G-10: solo la factura lleva la confirmación del papel (el recibo no es papel fiscal).
          ...(doc.kind === "invoice" ? { originals_in_hand: papelEnMano } : {}),
        }),
      });
      toast.success(
        doc.kind === "receipt" ? "Recibo anulado" : "Factura anulada",
        conFacturas
          ? "El correlativo se conserva, la mercancía volvió al inventario y el asiento se reversó."
          : "La mercancía volvió al inventario.",
      );
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
            ? `${cliente.data.legal_name}${cliente.data.tax_id === null ? "" : ` · ${formatearDocumento(cliente.data.tax_id)}`}${
                // O-02 (ADR-0076): el vendedor es quien cobró; quién armó la cuenta, aquí.
                detalle.data?.pos_cart != null
                  ? ` · Armó la cuenta: ${detalle.data.pos_cart.author_name ?? "otra persona"}`
                  : ""
              }`
            : undefined
        }
        actions={
          <>
            {/* Los permisos son cortesía de UX (ADR-0048): el servidor los exige igual. */}
            {anulable && puede("sales.invoice.annul") && (
              <Button variant="ghost" onClick={() => abrirAnulacion(true)}>
                <Ban /> Anular
              </Button>
            )}
            {/* ADR-0082 (AF3-06): un retiro facturado por error se corrige desde aquí. Si el
                servidor deja anular (mismo día, papel en la mano), se anula; si no, la nota de
                crédito que deja sin efecto el retiro entero. */}
            {doc.kind === "withdrawal_invoice" &&
              doc.status === "issued" &&
              puede("sales.invoice.annul") && (
                <CorregirRetiro
                  documentoId={doc.id}
                  numero={numeroDe(doc)}
                  empresaId={empresa.id}
                  seAnula={annulment?.allowed === true}
                  llamar={llamar}
                  onHecho={invalidarTrasCambio}
                />
              )}
            {doc.document_number !== null && (
              <>
                <Button variant="ghost" onClick={() => void abrirPdf("cortesia")}>
                  {esFiscal ? "PDF de cortesía" : "PDF"}
                </Button>
                {/* El recibo y el recibo de devolución no son fiscales: ni forma libre ni copia
                    fiscal (A-06). */}
                {esFiscal && doc.control_display !== null && (
                  <Button variant="ghost" onClick={() => setImprimiendo(true)}>
                    Imprimir en la forma libre
                  </Button>
                )}
              </>
            )}
            {/* F-11 (ADR-0072 §5): quien cobra carga aquí el comprobante de retención que el
                cliente entrega al pagar. El propio componente exige ar.retention.register. */}
            {doc.kind === "invoice" && doc.status === "issued" && esFiscal && (
              <CargarRetencion
                inicial={{
                  cliente: { id: doc.customer_id, label: "El cliente de esta factura" },
                  factura: {
                    id: doc.id,
                    label: numeroDocumento(doc.series, doc.document_number),
                  },
                }}
                onCargado={() => invalidarTrasCambio()}
              />
            )}
            {/* La misma conducta que la ficha del cliente (components/deuda.ts): con el saldo
                sin valorar el botón se enseña APAGADO y dice por qué; antes se ocultaba. */}
            {cobrable && decisionDeCobro(balance).visible && puede("sales.payment.register") && (
              <>
                <Button
                  variant="primary"
                  disabled={decisionDeCobro(balance).apagado}
                  title={decisionDeCobro(balance).motivo ?? undefined}
                  onClick={() => setPagando(true)}
                >
                  <HandCoins /> Registrar cobro
                </Button>
                {decisionDeCobro(balance).motivo !== null && (
                  <span className="text-[0.82rem] text-muted-foreground">
                    {decisionDeCobro(balance).motivo}
                  </span>
                )}
              </>
            )}
            {devolvible && puede("sales.return.manage") && (
              <Button variant="secondary" onClick={() => setDevolviendo(true)}>
                <Undo2 /> Devolución
              </Button>
            )}
            {/* G-07: la nota DIRECTA tiene su permiso; el cajero devuelve, no acredita sin mercancía. */}
            {pagable && puede("sales.credit_note.direct") && (
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

      {/* G-14: donde «Anular» no aplica, la pantalla dice por qué y ofrece el camino. El texto
          es del servidor. Solo a quien podría anular o devolver: a los demás no les falta nada. */}
      {porQueNoSeAnula !== null &&
        (puede("sales.invoice.annul") || puede("sales.return.manage")) && (
          <div
            role="note"
            aria-label={ANULACION.noSeAnula}
            className="mb-3 flex flex-wrap items-center gap-3 rounded-md border border-border bg-muted/40 px-3 py-2 text-[0.88rem]"
          >
            <span className="min-w-0 flex-1">{porQueNoSeAnula}</span>
            {devolvible && puede("sales.return.manage") && (
              <Button variant="secondary" onClick={() => setDevolviendo(true)}>
                <Undo2 /> Devolución
              </Button>
            )}
          </div>
        )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Líneas</CardTitle>
              <FiscalStatusBadge
                estado={
                  doc.status === "issued" && payments.length > 0 ? "partially_paid" : doc.status
                }
              />
            </CardHeader>
            <CardContent className="px-0 pb-1">
              <Table>
                <THead>
                  <TR>
                    <TH>#</TH>
                    <TH>Descripción</TH>
                    <TH className="text-right">Cantidad</TH>
                    <TH className="text-right">Precio</TH>
                    {doc.kind !== "receipt" && <TH className="text-right">IVA</TH>}
                    <TH className="text-right">Total</TH>
                  </TR>
                </THead>
                <TBody>
                  {lines.map((l) => (
                    <TR key={l.id}>
                      <TD className="text-faint-foreground">{l.line_number}</TD>
                      <TD className="min-w-40 max-w-64 whitespace-normal">{l.description}</TD>
                      <TDNum>{mostrarCantidad(l.quantity)}</TDNum>
                      <TDNum>
                        {mostrarImporte({
                          amount: l.unit_price_transaction,
                          currency: l.transaction_currency,
                        })}
                      </TDNum>
                      {/* Un recibo no repercute impuesto: ni columna ni cero (A4). Se decide
                          por el TIPO del documento, no por el modo de hoy: un recibo viejo
                          sigue sin IVA y una factura vieja lo sigue enseñando. */}
                      {doc.kind !== "receipt" && (
                        <TDNum>
                          {mostrarImporte({
                            amount: l.tax_amount,
                            currency: l.transaction_currency,
                          })}
                        </TDNum>
                      )}
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
                      <TH>Forma de pago</TH>
                      <TH>Referencia</TH>
                      <TH className="text-right">Importe</TH>
                      <TH className="text-right">Diferencial</TH>
                      <TH>
                        <span className="sr-only">Reversa</span>
                      </TH>
                    </TR>
                  </THead>
                  <TBody>
                    {payments.map((p) => {
                      const dif = difPorPago.get(p.id);
                      return (
                        <TR key={p.id}>
                          <TD>{fechaLocal(p.paid_at)}</TD>
                          <TD>{nombreDeForma(p.instrument)}</TD>
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
                          <TD className="whitespace-normal text-right">
                            {p.reversal != null ? (
                              <span className="text-[0.82rem] text-muted-foreground">
                                Reversado el {fechaLocal(p.reversal.reversed_at)}
                                {p.reversal.reversed_by_name != null &&
                                  ` por ${p.reversal.reversed_by_name}`}
                                : {p.reversal.reason}
                              </span>
                            ) : p.instrument === "saldo_a_favor" ||
                              (p.supported_retention_id != null
                                ? !puede("ar.retention.correct")
                                : !puede("ar.payment.reverse")) ? null : (
                              // Solo a quien el servidor se lo permite: el contador corrige la
                              // retención (ar.retention.correct); la reversa de cobros tiene su
                              // permiso (ar.payment.reverse).
                              <Button variant="ghost" size="sm" onClick={() => setReversando(p)}>
                                Reversar
                              </Button>
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

          {reversando !== null && (
            <ReversarCobro
              tipo={reversando.supported_retention_id != null ? "retencion" : "cobro"}
              id={reversando.supported_retention_id ?? reversando.id}
              importe={{ amount: reversando.amount, currency: reversando.currency }}
              onCerrar={() => setReversando(null)}
              onReversado={() => {
                setReversando(null);
                void qc.invalidateQueries({ queryKey: ["documento", empresa.id, id] });
              }}
            />
          )}

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
                <CardTitle>
                  {doc.kind === "receipt"
                    ? "Devoluciones sobre este recibo"
                    : "Notas y devoluciones sobre esta factura"}
                </CardTitle>
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
                    {conFacturas
                      ? "Ninguna nota emitida sobre este documento."
                      : "Ninguna devolución sobre este recibo."}
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
              {doc.kind !== "receipt" && (
                <>
                  <Fila etiqueta="Subtotal">
                    {mostrarImporte({
                      amount: doc.subtotal_amount,
                      currency: doc.functional_currency,
                    })}
                  </Fila>
                  <Fila etiqueta="IVA">
                    {mostrarImporte({ amount: doc.tax_amount, currency: doc.functional_currency })}
                  </Fila>
                  <div className="my-2 h-px bg-border" />
                </>
              )}
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
                          source: doc.rate_source,
                        }
                      : null
                  }
                />
              </Fila>
              <Fila etiqueta="Saldo" destacada>
                <span
                  className={
                    balance !== null && (esCero(balance) || balance.startsWith("-"))
                      ? "font-mono text-accent-soft-foreground"
                      : "font-mono text-warning-soft-foreground"
                  }
                >
                  {/* null = documento en divisa sin tasa de hoy: debe, y se dice (una anulada o
                      un borrador llegan con «0»). */}
                  {/* ADR-0082: la factura de retiro y su nota no cargan cartera. */}
                  {doc.kind === "withdrawal_invoice" || doc.kind === "withdrawal_credit_note"
                    ? "Sin cuenta por cobrar"
                    : textoDeDeuda(balance, doc.functional_currency)}
                </span>
              </Fila>
            </CardContent>
          </Card>

          {(conFacturas || doc.annul_reason !== null) && (
            <Card>
              <CardHeader>
                <CardTitle>{conFacturas ? "Trazabilidad" : "Anulación"}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-[0.85rem]">
                {doc.control_number !== null && (
                  <Fila etiqueta="N.º de control">
                    <span className="font-mono">{doc.control_display ?? doc.control_number}</span>
                  </Fila>
                )}
                {conFacturas && (
                  <Fila etiqueta="Versión de reglas">
                    <span className="font-mono text-[0.8rem]">{doc.rules_version ?? "—"}</span>
                  </Fila>
                )}
                {doc.annul_reason !== null && (
                  <Fila etiqueta="Motivo de anulación">{doc.annul_reason}</Fila>
                )}
                {conFacturas && (
                  <div className="pt-1">
                    {contabilidad.cargando ? (
                      <Skeleton className="h-6 w-40" />
                    ) : !contabilidad.configurada ? (
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
                )}
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {imprimiendo && (
        <ImprimirFormaLibre
          documentId={doc.id}
          controlDisplay={doc.control_display}
          onClose={() => setImprimiendo(false)}
        />
      )}

      <ConfirmDialog
        open={anulando}
        onOpenChange={abrirAnulacion}
        title={`Anular${doc.kind === "receipt" ? "el recibo" : "la factura"} ${numeroDe(doc)}`}
        confirmLabel={doc.kind === "receipt" ? "Anular el recibo" : "Anular la factura"}
        destructive
        confirmDisabled={motivo.trim().length < 3 || (doc.kind === "invoice" && !papelEnMano)}
        onConfirm={anular}
      >
        <div className="space-y-2">
          {conFacturas ? (
            <p>
              {doc.kind === "receipt" ? "El recibo quedará " : "La factura quedará "}
              <Badge tone="destructive">{doc.kind === "receipt" ? "Anulado" : "Anulada"}</Badge>, su
              correlativo <strong>se conserva</strong> (nunca se reutiliza), la mercancía que salió{" "}
              <strong>vuelve al inventario</strong> al mismo costo con que salió, y su asiento
              contable se <strong>reversa</strong> con un contra-asiento. Esto no se puede deshacer.
            </p>
          ) : (
            <p>
              El recibo quedará <Badge tone="destructive">Anulado</Badge> y la mercancía que salió{" "}
              <strong>vuelve al inventario</strong>. Esto no se puede deshacer.
            </p>
          )}
          <p className="text-[0.88rem] text-muted-foreground">
            Solo se anula un {nombreDoc} sin cobros. Si ya se cobró, no se anula: registra una
            devolución, que repone la mercancía y devuelve el dinero como saldo a favor o reembolso.
          </p>
          {doc.kind === "invoice" && (
            <>
              <p className="text-[0.88rem] text-muted-foreground">{ANULACION.ayudaPapel}</p>
              <label className="flex items-start gap-2 text-[0.9rem]">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={papelEnMano}
                  onChange={(e) => setPapelEnMano(e.target.checked)}
                />
                <span>{ANULACION.papelEnMano}</span>
              </label>
            </>
          )}
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
          <p className="text-[0.85rem] text-muted-foreground">{PEDIDO_COMPUESTO_NO_RESERVA}</p>
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
          mostrador={cliente.data?.is_system === true}
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
  mostrador,
  onClose,
}: {
  documento: Documento;
  lineas: Linea[];
  /**
   * Venta al Consumidor final de sistema: un saldo a favor a su nombre no lo puede usar nadie.
   * Se devuelve el dinero, siempre (QA de pantalla 2026-09-15, h. 35).
   */
  mostrador: boolean;
  onClose: (hecho: boolean) => void;
}): React.JSX.Element {
  const { empresa, llamar, puede } = useSesion();
  /**
   * G-07 (RESPUESTA §2.8): la devolución la inicia quien tiene `sales.return.manage`; sacar el
   * dinero de la caja exige `sales.refund`. Sin él, la devolución deja saldo a favor y la pantalla
   * lo dice: no ofrece una caja que el servidor va a negar.
   */
  const reembolsa = puede("sales.refund");
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
  const llaveReembolso = useRef(crypto.randomUUID());
  const esRecibo = documento.kind === "receipt";
  /** La caja de la que sale el dinero, si se reembolsa en el acto (ADR-0061 §8). */
  const [cajaReembolso, setCajaReembolso] = useState<string | null>(null);
  /**
   * El reembolso que el servidor rechazó por falta de saldo (ADR-0062 §4). La devolución YA
   * quedó confirmada —son dos operaciones—, así que lo que se reintenta es solo el pago: o se
   * confirma el sobregiro, o el cliente se queda con el saldo a favor (QA 2026-09-15, h. 33).
   */
  const [sinSaldo, setSinSaldo] = useState<{
    mensaje: string;
    creditId: string;
    monto: string;
  } | null>(null);
  const cuentas = useQuery({
    queryKey: ["cuentas-reembolso", empresa.id],
    enabled: reembolsa,
    queryFn: () =>
      llamar<{
        accounts: {
          id: string;
          name: string;
          currency: string;
          is_active: boolean;
          is_system?: boolean;
        }[];
      }>("/v1/treasury/accounts"),
  });

  const depositos = useQuery({
    queryKey: ["depositos", empresa.id],
    // Solo los activos: un depósito apagado no recibe ni despacha (migración 60).
    queryFn: () =>
      llamar<({ id: string; name: string } & { status?: string })[]>("/v1/warehouses").then((ws) =>
        ws.filter((w) => w.status !== "inactive"),
      ),
  });
  // El primer depósito por omisión, en un efecto: un setState durante el
  // render es un bucle en potencia.
  useEffect(() => {
    const primero = depositos.data?.[0]?.id;
    if (primero !== undefined) setDeposito((actual) => actual ?? primero);
  }, [depositos.data]);

  // F-06: la cantidad la lee el lector único. Lo que rechaza no se descarta en silencio: se dice
  // junto a la lista y no se envía hasta corregirlo.
  const elegidas = lineas.flatMap((l) => {
    const leida = leerCantidad(cantidades[l.id] ?? "");
    return leida.ok && !esCero(leida.cantidad) ? [{ linea: l, cantidad: leida.cantidad }] : [];
  });
  const sinLeer = lineas.some((l) => motivoDeCantidad(cantidades[l.id] ?? "") !== null);
  const listo =
    creada !== null ||
    (elegidas.length > 0 &&
      !sinLeer &&
      motivo.trim().length >= 3 &&
      deposito !== null &&
      (!mostrador || !reembolsa || cajaReembolso !== null));

  /**
   * Cancelar con un borrador ya creado lo CANCELA en el servidor: antes quedaba huérfano, sin
   * forma de retomarlo ni descartarlo (QA de pantalla 2026-09-15, h. 55).
   */
  async function cancelar(): Promise<void> {
    if (creada === null) {
      onClose(false);
      return;
    }
    setOcupado(true);
    try {
      await llamar(`/v1/returns/${creada}/cancel`, {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
      });
      toast.success("Devolución descartada", "El borrador quedó cancelado; nada se movió.");
      onClose(true);
    } catch (e) {
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  /**
   * El pago del saldo a favor, en su propio paso. La llave es por INTENTO (ADR-0076, F-08): el
   * 409 de saldo la estrena, así «confirmar el sobregiro» —otro cuerpo— viaja con la suya.
   */
  async function reembolsar(
    creditId: string,
    // El total de la nota, que el diálogo enseña. Ya no viaja: el servidor reembolsa todo.
    _monto: string,
    forzar: string | null,
  ): Promise<void> {
    await conLlaveDeIntento(llaveReembolso, (k) =>
      llamar(`/v1/customer-credits/${creditId}/refunds`, {
        method: "POST",
        headers: { "Idempotency-Key": k },
        body: JSON.stringify({
          company_id: empresa.id,
          account_id: cajaReembolso,
          // G-05/G-15: el saldo a favor queda en la moneda del documento; la devolución
          // reembolsa TODO lo que dejó y el servidor decide cuánto es y a qué tasa sale. No se
          // manda importe: el cuerpo lleva `whole` o `amount`, nunca los dos.
          whole: true,
          reason: `Reembolso de la devolución: ${motivo.trim()}`,
          ...(forzar !== null ? { allow_negative_balance: true, overdraft_reason: forzar } : {}),
        }),
      }),
    );
  }

  async function devolver(): Promise<void> {
    setError(null);
    setOcupado(true);
    try {
      let id = creada;
      if (id === null) {
        const r = await conLlaveDeIntento(llaveCrear, (k) =>
          llamar<{ id: string }>("/v1/returns", {
            method: "POST",
            headers: { "Idempotency-Key": k },
            body: JSON.stringify({
              company_id: empresa.id,
              source_document_id: documento.id,
              warehouse_id: deposito,
              reason: motivo.trim(),
              lines: elegidas.map((x) => ({ source_line_id: x.linea.id, quantity: x.cantidad })),
            }),
          }),
        );
        id = r.id;
        setCreada(id);
      }
      const confirmada = await conLlaveDeIntento(llaveConfirmar, (k) =>
        llamar<{
          credit_note_id: string | null;
          customer_credit_id: string | null;
          igtf_not_refunded?: { notice: string } | null;
        }>(`/v1/returns/${id}/confirm`, {
          method: "POST",
          headers: { "Idempotency-Key": k },
        }),
      );
      if (
        cajaReembolso !== null &&
        confirmada.customer_credit_id !== null &&
        confirmada.credit_note_id !== null
      ) {
        // El importe del reembolso es el del documento que dejó el saldo: lo dice
        // el servidor, la pantalla no suma.
        const nota = await llamar<{ document: { total_amount: string } }>(
          `/v1/documents/${confirmada.credit_note_id}`,
        );
        try {
          await reembolsar(confirmada.customer_credit_id, nota.document.total_amount, null);
        } catch (e) {
          const falta = esSinSaldo(e);
          if (falta === null) throw e;
          setSinSaldo({
            mensaje: falta,
            creditId: confirmada.customer_credit_id,
            monto: nota.document.total_amount,
          });
          setOcupado(false);
          return;
        }
      }
      toast.success(
        "Devolución confirmada",
        cajaReembolso !== null
          ? "La mercancía reingresó al costo con que salió y el dinero salió de la caja elegida."
          : `La mercancía reingresó al costo con que salió y ${esRecibo ? "el recibo de devolución" : "la nota de crédito"} dejó saldo a favor.`,
      );
      // G-06: el IGTF de la venta queda percibido y no se devuelve; el texto lo da el servidor.
      if (confirmada.igtf_not_refunded) {
        toast.warning("El IGTF no se devuelve", confirmada.igtf_not_refunded.notice);
      }
      onClose(true);
    } catch (e) {
      // G-16: el diálogo ya enseña el aviso (MensajeError); un toast encima era el segundo.
      setError(e);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <>
      <Dialog open onOpenChange={(v) => !v && onClose(false)}>
        <DialogContent className="max-w-lg">
          <DialogTitle>Devolución de {numeroDe(documento)}</DialogTitle>
          <DialogDescription>
            La mercancía reingresa <strong>al costo y lote con los que salió</strong> —no al de
            hoy—, y se emite{" "}
            {esRecibo
              ? "un recibo de devolución"
              : "una nota de crédito (exige su propio rango de numeración)"}{" "}
            que deja el saldo a favor del cliente. Si el cliente quiere su dinero, elige de qué caja
            sale.
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
            {lineas.map((l) => (
              <MotivoDeLectura key={l.id} motivo={motivoDeCantidad(cantidades[l.id] ?? "")} />
            ))}
            {(depositos.data?.length ?? 0) > 1 && (
              <div className="w-full sm:w-56">
                <SimpleSelect
                  ariaLabel="Depósito al que reingresa"
                  value={deposito}
                  onValueChange={setDeposito}
                  disabled={creada !== null}
                  options={(depositos.data ?? []).map((d) => ({ value: d.id, label: d.name }))}
                />
              </div>
            )}
            {!reembolsa && (
              <p className="text-[0.88rem] text-muted-foreground">
                {mostrador ? ANULACION.sinReembolsoMostrador : ANULACION.sinReembolso}
              </p>
            )}
            <div className={reembolsa ? "w-full sm:w-72" : "hidden"}>
              <SimpleSelect
                ariaLabel="Devolver el dinero desde"
                value={cajaReembolso ?? (mostrador ? null : "saldo")}
                onValueChange={(v) => setCajaReembolso(v === "saldo" ? null : v)}
                disabled={creada !== null}
                placeholder="¿De qué caja sale el dinero?"
                options={[
                  ...(mostrador
                    ? []
                    : [{ value: "saldo", label: "Dejar saldo a favor del cliente" }]),
                  ...(cuentas.data?.accounts ?? [])
                    // «Sin asignar» es de sistema: de ahí no sale un reembolso (QA 2026-09-15, h. 36).
                    .filter(
                      (c) =>
                        c.is_active &&
                        c.is_system !== true &&
                        c.currency === documento.functional_currency,
                    )
                    .map((c) => ({ value: c.id, label: `Devolver el dinero desde «${c.name}»` })),
                ]}
              />
            </div>
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
                El borrador de la devolución ya existe; falta confirmarlo. Reintenta la confirmación
                — no se crea otro borrador.
              </p>
            )}
            {/* ADR-0076 §9: la devolución (o su reembolso) pudo quedar hecha con la llave anterior.
                No se reintenta a ciegas: se cierra y el documento se vuelve a leer. */}
            {error !== null &&
              (intentoAnteriorPudoQuedar(error) ? (
                <RevisaIntentoAnterior
                  error={error}
                  etiqueta="Cerrar y revisar la factura"
                  onIr={() => onClose(true)}
                />
              ) : (
                <MensajeError error={error} />
              ))}
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="ghost" onClick={() => void cancelar()} disabled={ocupado}>
              {creada !== null ? "Descartar el borrador" : "Cancelar"}
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
      {sinSaldo !== null && (
        <ConfirmarSobregiro
          mensaje={sinSaldo.mensaje}
          onCancelar={() => {
            // La devolución ya está confirmada: sin el pago, el cliente queda con saldo a favor.
            setSinSaldo(null);
            toast.success(
              "Devolución confirmada",
              "La mercancía reingresó y el saldo quedó a favor del cliente: no salió dinero de la caja.",
            );
            onClose(true);
          }}
          onConfirmar={async (porQue) => {
            try {
              await reembolsar(sinSaldo.creditId, sinSaldo.monto, porQue);
            } catch (e) {
              // ADR-0076 §9: el reembolso pudo quedar hecho — el aviso va al diálogo de la
              // devolución, con su camino a revisar, no al error genérico de la confirmación.
              if (!intentoAnteriorPudoQuedar(e)) throw e;
              setSinSaldo(null);
              setError(e);
              return;
            }
            setSinSaldo(null);
            toast.success(
              "Devolución confirmada",
              "La mercancía reingresó y el dinero salió de la caja elegida, que quedó en negativo.",
            );
            onClose(true);
          }}
        />
      )}
    </>
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

  // F-06: la cantidad la lee el lector único; lo que rechaza se dice y no se envía.
  const elegidas = lineas.flatMap((l) => {
    const leida = leerCantidad(cantidades[l.id] ?? "");
    return leida.ok && !esCero(leida.cantidad) ? [{ linea: l, cantidad: leida.cantidad }] : [];
  });
  const sinLeer = lineas.some((l) => motivoDeCantidad(cantidades[l.id] ?? "") !== null);
  const listo = elegidas.length > 0 && !sinLeer && motivo.trim().length >= 3;

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
      // G-16: el diálogo ya enseña el aviso (MensajeError); un toast encima era el segundo.
      setError(e);
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
          {lineas.map((l) => (
            <MotivoDeLectura key={l.id} motivo={motivoDeCantidad(cantidades[l.id] ?? "")} />
          ))}
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

  // F-06: cantidad y precio los leen los lectores únicos. «1.500» ya no se vuelve 1,5: lo que
  // no se puede leer se dice junto a su fila y la nota no se emite hasta corregirlo.
  const completas = filas.flatMap((f) => {
    const cantidad = leerCantidad(f.cantidad);
    const precio = leerImporte(f.precio);
    return f.producto !== null &&
      cantidad.ok &&
      !esCero(cantidad.cantidad) &&
      precio.ok &&
      !esCero(precio.importe)
      ? [{ producto: f.producto, cantidad: cantidad.cantidad, precio: precio.importe }]
      : [];
  });
  const sinLeer = filas.some(
    (f) => motivoDeCantidad(f.cantidad) !== null || motivoDeImporte(f.precio) !== null,
  );
  const listo = completas.length > 0 && !sinLeer && motivo.trim().length >= 3;

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
            product_id: f.producto.id,
            quantity: f.cantidad,
            unit_price: f.precio,
          })),
        }),
      });
      toast.success(
        "Nota de débito emitida",
        "El cliente debe también la nota — ya aparece en su cuenta.",
      );
      onClose(true);
    } catch (e) {
      // G-16: el diálogo ya enseña el aviso (MensajeError); un toast encima era el segundo.
      setError(e);
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
          {filas.map((f) => (
            <MotivoDeLectura key={`cantidad-${f.id}`} motivo={motivoDeCantidad(f.cantidad)} />
          ))}
          {filas.map((f) => (
            <MotivoDeLectura key={`precio-${f.id}`} motivo={motivoDeImporte(f.precio)} />
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
