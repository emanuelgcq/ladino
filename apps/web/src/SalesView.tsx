import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type Customer,
  type ExchangeDifferenceReport,
  type FiscalRange,
  type PriceList,
  type Product,
  type SalesDocument,
  type SalesDocumentDetail,
  type CustomerStatement,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Ventas. La pantalla NO calcula NADA de dinero: ni el subtotal de una línea
 * mientras se teclea, ni el saldo de una factura, ni el diferencial. Todo eso
 * lo devuelve la API ya calculado, con su moneda y su tasa.
 *
 * La tentación aquí es enorme —«total provisional» mientras el usuario
 * escribe— y por eso está dicho: una previsualización calculada en el cliente
 * es una segunda implementación de la regla tributaria, en el sitio donde
 * CLAUDE.md §7 prohíbe que exista. Lo que se muestra antes de emitir es la
 * cotización real, que la crea el servidor.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

interface LineaBorrador {
  product_id: string;
  quantity: string;
}

const INSTRUMENTOS = [
  "efectivo_bs",
  "efectivo_usd",
  "zelle",
  "usdt",
  "transferencia",
  "punto_venta",
  "saldo_a_favor",
  "otro",
] as const;

function idem(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

export function SalesView({ session, companyId }: Props) {
  const [panel, setPanel] = useState<"documentos" | "nueva" | "cxc" | "fiscal">("documentos");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  return (
    <section>
      <h2>Ventas</h2>
      <nav>
        <button disabled={panel === "documentos"} onClick={() => setPanel("documentos")}>
          Documentos
        </button>{" "}
        <button disabled={panel === "nueva"} onClick={() => setPanel("nueva")}>
          Nueva venta
        </button>{" "}
        <button disabled={panel === "cxc"} onClick={() => setPanel("cxc")}>
          Cuentas por cobrar
        </button>{" "}
        <button disabled={panel === "fiscal"} onClick={() => setPanel("fiscal")}>
          Numeración y tasas
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {aviso && <p role="status">{aviso}</p>}

      {panel === "documentos" ? (
        <Documentos session={session} companyId={companyId} onError={setError} />
      ) : panel === "nueva" ? (
        <NuevaVenta
          session={session}
          companyId={companyId}
          onError={setError}
          onHecho={(m) => {
            setAviso(m);
            setPanel("documentos");
          }}
        />
      ) : panel === "cxc" ? (
        <CuentasPorCobrar session={session} companyId={companyId} onError={setError} />
      ) : (
        <Fiscal session={session} companyId={companyId} onError={setError} onAviso={setAviso} />
      )}
    </section>
  );
}

// ── Documentos: lista, filtros y detalle ─────────────────────────────────────

function Documentos({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [docs, setDocs] = useState<SalesDocument[] | null>(null);
  const [total, setTotal] = useState(0);
  const [kind, setKind] = useState("invoice");
  const [status, setStatus] = useState("");
  const [desde, setDesde] = useState("");
  const [hasta, setHasta] = useState("");
  const [abierto, setAbierto] = useState<SalesDocumentDetail | null>(null);

  const cargar = useCallback(async () => {
    try {
      const q = new URLSearchParams();
      if (kind) q.set("kind", kind);
      if (status) q.set("status", status);
      if (desde) q.set("from", desde);
      if (hasta) q.set("to", hasta);
      const r = await api<{ items: SalesDocument[]; total: number }>(
        session,
        `/v1/documents?${q.toString()}`,
        { companyId },
      );
      setDocs(r.items);
      setTotal(r.total);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, kind, status, desde, hasta, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function abrir(id: string) {
    try {
      setAbierto(await api<SalesDocumentDetail>(session, `/v1/documents/${id}`, { companyId }));
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function anular(id: string) {
    const motivo = window.prompt("Motivo de la anulación (queda en el documento y en auditoría):");
    if (motivo === null || motivo.trim().length < 3) return;
    if (
      !window.confirm(
        "Anular NO borra la factura ni libera su correlativo: el número queda ocupado para siempre. ¿Seguir?",
      )
    ) {
      return;
    }
    try {
      await api(session, `/v1/invoices/${id}/annul`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({ company_id: companyId, reason: motivo.trim() }),
      });
      await cargar();
      await abrir(id);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Documentos ({total})</h3>
      <label>
        Tipo{" "}
        <select value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">todos</option>
          <option value="quote">cotizaciones</option>
          <option value="order">pedidos</option>
          <option value="invoice">facturas</option>
          <option value="credit_note">notas de crédito</option>
        </select>
      </label>{" "}
      <label>
        Estado{" "}
        <select value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">todos</option>
          <option value="draft">borrador</option>
          <option value="confirmed">confirmado</option>
          <option value="issued">emitido</option>
          <option value="paid">pagado</option>
          <option value="annulled">anulado</option>
        </select>
      </label>{" "}
      <label>
        Desde <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)} />
      </label>{" "}
      <label>
        Hasta <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} />
      </label>
      {docs === null ? (
        <p>cargando…</p>
      ) : docs.length === 0 ? (
        <p>No hay documentos con esos filtros.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nº</th>
              <th>Control</th>
              <th>Tipo</th>
              <th>Estado</th>
              <th>Emitido</th>
              <th>Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <tr key={d.id}>
                <td>
                  {d.series}-{d.document_number ?? "—"}
                </td>
                {/* Un guion, no un cero: el régimen puede no usar número de control. */}
                <td>{d.control_number ?? "—"}</td>
                <td>{d.kind}</td>
                <td>{d.status}</td>
                <td>{d.issued_at?.slice(0, 10) ?? "—"}</td>
                <td>
                  {mostrarImporte({ amount: d.total_amount, currency: d.functional_currency })}
                </td>
                <td>
                  <button onClick={() => void abrir(d.id)}>ver</button>{" "}
                  {d.kind === "invoice" && d.status === "issued" && (
                    <button onClick={() => void anular(d.id)}>anular</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {abierto && (
        <Detalle
          session={session}
          companyId={companyId}
          detalle={abierto}
          onError={onError}
          onRefrescar={() => void abrir(abierto.document.id)}
          onCerrar={() => setAbierto(null)}
        />
      )}
    </>
  );
}

function Detalle({
  session,
  companyId,
  detalle,
  onError,
  onRefrescar,
  onCerrar,
}: Props & {
  detalle: SalesDocumentDetail;
  onError: (m: string) => void;
  onRefrescar: () => void;
  onCerrar: () => void;
}): React.JSX.Element {
  const d = detalle.document;
  const [cobro, setCobro] = useState({
    currency: d.transaction_currency,
    amount: "",
    instrument: "transferencia",
    reference: "",
  });

  async function registrarCobro() {
    try {
      await api(session, "/v1/payments", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          document_id: d.id,
          currency: cobro.currency,
          amount: cobro.amount,
          instrument: cobro.instrument,
          ...(cobro.reference ? { reference: cobro.reference } : {}),
        }),
      });
      setCobro({ ...cobro, amount: "", reference: "" });
      onRefrescar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <article>
      <h3>
        {d.kind} {d.series}-{d.document_number ?? "borrador"}{" "}
        <button onClick={onCerrar}>cerrar</button>
      </h3>
      <p>
        Estado: <strong>{d.status}</strong>
        {d.annulled_at && ` · anulada el ${d.annulled_at.slice(0, 10)}: ${d.annul_reason ?? ""}`}
        <br />
        Moneda del documento: {d.transaction_currency} · tasa {d.fx_rate} ({d.rate_source})
        {/* La tasa y su FUENTE, visibles: un importe convertido sin decir con
            qué tasa no es auditable. */}
        <br />
        Número de control: {d.control_number ?? "no aplica en este régimen"}
      </p>

      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Descripción</th>
            <th>Cant.</th>
            <th>P. unit.</th>
            <th>Alícuota</th>
            <th>Impuesto</th>
            <th>Total línea</th>
          </tr>
        </thead>
        <tbody>
          {detalle.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.line_number}</td>
              <td>{l.description}</td>
              <td>{l.quantity}</td>
              <td>
                {mostrarImporte({
                  amount: l.unit_price_transaction,
                  currency: l.transaction_currency,
                })}
              </td>
              <td>{l.tax_rate_snapshot}</td>
              <td>{mostrarImporte({ amount: l.tax_amount, currency: l.transaction_currency })}</td>
              <td>
                {mostrarImporte({
                  amount: l.line_total_transaction,
                  currency: l.transaction_currency,
                })}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p>
        Subtotal: {mostrarImporte({ amount: d.subtotal_amount, currency: d.functional_currency })} ·
        Impuesto: {mostrarImporte({ amount: d.tax_amount, currency: d.functional_currency })} ·{" "}
        <strong>
          Total: {mostrarImporte({ amount: d.total_amount, currency: d.functional_currency })}
        </strong>
        <br />
        {/* El saldo viene del servidor (`platform.document_balance`). No se
            resta aquí: dos restas del mismo saldo acaban difiriendo. */}
        Saldo pendiente:{" "}
        <strong>
          {mostrarImporte({ amount: detalle.balance, currency: d.functional_currency })}
        </strong>
      </p>

      <h4>Cobros</h4>
      {detalle.payments.length === 0 ? (
        <p>Sin cobros registrados.</p>
      ) : (
        <ul>
          {detalle.payments.map((p) => (
            <li key={p.id}>
              {p.paid_at.slice(0, 10)} ·{" "}
              {mostrarImporte({ amount: p.amount, currency: p.currency })} ({p.instrument}) · tasa{" "}
              {p.fx_rate} ={" "}
              {mostrarImporte({ amount: p.functional_amount, currency: d.functional_currency })}
              {p.reference && ` · ref ${p.reference}`}
            </li>
          ))}
        </ul>
      )}

      {detalle.exchange_differences.length > 0 && (
        <>
          <h4>Diferencial cambiario</h4>
          <ul>
            {detalle.exchange_differences.map((x) => (
              <li key={x.id}>
                {x.occurred_on}: emitido a {x.fx_rate_issue}, cobrado a {x.fx_rate_payment} →{" "}
                <strong>
                  {mostrarImporte({ amount: x.difference, currency: d.functional_currency })}
                </strong>{" "}
                {x.difference.startsWith("-") ? "(pérdida)" : "(ganancia)"}
              </li>
            ))}
          </ul>
        </>
      )}

      {d.status === "issued" && (
        <fieldset>
          <legend>Registrar cobro</legend>
          <input
            placeholder="moneda"
            value={cobro.currency}
            onChange={(e) => setCobro({ ...cobro, currency: e.target.value.toUpperCase() })}
            size={4}
          />{" "}
          <input
            placeholder="importe"
            value={cobro.amount}
            onChange={(e) => setCobro({ ...cobro, amount: e.target.value })}
          />{" "}
          <select
            value={cobro.instrument}
            onChange={(e) => setCobro({ ...cobro, instrument: e.target.value })}
          >
            {INSTRUMENTOS.map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>{" "}
          <input
            placeholder="referencia"
            value={cobro.reference}
            onChange={(e) => setCobro({ ...cobro, reference: e.target.value })}
          />{" "}
          <button onClick={() => void registrarCobro()}>Registrar</button>
        </fieldset>
      )}

      {d.kind === "invoice" && (d.status === "issued" || d.status === "paid") && (
        <Devolucion
          session={session}
          companyId={companyId}
          detalle={detalle}
          onError={onError}
          onHecho={onRefrescar}
        />
      )}
    </article>
  );
}

function Devolucion({
  session,
  companyId,
  detalle,
  onError,
  onHecho,
}: Props & {
  detalle: SalesDocumentDetail;
  onError: (m: string) => void;
  onHecho: () => void;
}): React.JSX.Element {
  const [almacen, setAlmacen] = useState("");
  const [motivo, setMotivo] = useState("");
  const [cantidades, setCantidades] = useState<Record<string, string>>({});

  async function crear() {
    const lines = detalle.lines
      .filter((l) => (cantidades[l.id] ?? "").trim() !== "")
      .map((l) => ({ source_line_id: l.id, quantity: cantidades[l.id]! }));
    if (lines.length === 0) return;
    try {
      const dev = await api<{ id: string }>(session, "/v1/returns", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          source_document_id: detalle.document.id,
          warehouse_id: almacen,
          reason: motivo,
          lines,
        }),
      });
      if (
        window.confirm(
          "Confirmar la devolución reingresa la mercancía AL COSTO ORIGINAL y emite la nota de crédito. ¿Confirmar ahora?",
        )
      ) {
        await api(session, `/v1/returns/${dev.id}/confirm`, {
          method: "POST",
          companyId,
          headers: idem(),
        });
      }
      setCantidades({});
      setMotivo("");
      onHecho();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <fieldset>
      <legend>Devolución contra esta factura</legend>
      <input
        placeholder="almacén (uuid) donde reingresa"
        value={almacen}
        onChange={(e) => setAlmacen(e.target.value)}
        size={38}
      />{" "}
      <input
        placeholder="motivo"
        value={motivo}
        onChange={(e) => setMotivo(e.target.value)}
        size={30}
      />
      <ul>
        {detalle.lines.map((l) => (
          <li key={l.id}>
            {l.description} (vendidas {l.quantity}){" "}
            <input
              placeholder="devolver"
              value={cantidades[l.id] ?? ""}
              onChange={(e) => setCantidades({ ...cantidades, [l.id]: e.target.value })}
              size={8}
            />
          </li>
        ))}
      </ul>
      <button onClick={() => void crear()}>Registrar devolución</button>
    </fieldset>
  );
}

// ── Nueva venta ──────────────────────────────────────────────────────────────

function NuevaVenta({
  session,
  companyId,
  onError,
  onHecho,
}: Props & { onError: (m: string) => void; onHecho: (m: string) => void }): React.JSX.Element {
  const [clientes, setClientes] = useState<Customer[]>([]);
  const [productos, setProductos] = useState<Product[]>([]);
  const [listas, setListas] = useState<PriceList[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [listaId, setListaId] = useState("");
  const [almacen, setAlmacen] = useState("");
  const [serie, setSerie] = useState("A");
  const [lineas, setLineas] = useState<LineaBorrador[]>([{ product_id: "", quantity: "" }]);

  useEffect(() => {
    async function cargar() {
      try {
        const [cs, ps, ls] = await Promise.all([
          api<{ items: Customer[] }>(session, "/v1/customers?per_page=100", { companyId }),
          api<{ items: Product[] }>(session, "/v1/products?per_page=100", { companyId }),
          api<PriceList[]>(session, "/v1/price-lists", { companyId }),
        ]);
        setClientes(cs.items);
        setProductos(ps.items);
        setListas(ls);
      } catch (e) {
        onError(mensajeDe(e));
      }
    }
    void cargar();
  }, [session, companyId, onError]);

  const cliente = clientes.find((c) => c.id === clienteId);
  // Cambiar la lista es una ATRIBUCIÓN (`sales.price_list.override`), no una
  // preferencia: la pantalla lo dice, y el servidor lo comprueba igual. Que la
  // UI oculte el control no es control de acceso.
  const listaDistinta = listaId !== "" && cliente?.default_price_list_id !== listaId;

  function cuerpo(): Record<string, unknown> {
    return {
      company_id: companyId,
      customer_id: clienteId,
      series: serie,
      ...(listaId ? { price_list_id: listaId } : {}),
      lines: lineas
        .filter((l) => l.product_id !== "" && l.quantity.trim() !== "")
        .map((l) => ({ product_id: l.product_id, quantity: l.quantity.trim() })),
    };
  }

  async function emitir(destino: "quotes" | "orders" | "invoices") {
    try {
      const body =
        destino === "invoices" ? { ...cuerpo(), warehouse_id: almacen } : { ...cuerpo() };
      const doc = await api<SalesDocument>(session, `/v1/${destino}`, {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify(body),
      });
      onHecho(
        destino === "invoices"
          ? `Factura ${doc.series}-${doc.document_number ?? ""} emitida (control ${doc.control_number ?? "no aplica"}).`
          : `Documento ${doc.kind} creado.`,
      );
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Nueva venta</h3>
      <p>
        {/* Dicho aquí porque es lo que más desconcierta al usar la pantalla la
            primera vez: no hay «total provisional». */}
        Los importes los calcula el servidor con la alícuota vigente y la tasa del día. Esta
        pantalla no previsualiza totales: el primero que verás es el del documento real.
      </p>
      <label>
        Cliente{" "}
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
          <option value="">elige…</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.legal_name} {c.status === "blocked" ? "(bloqueado)" : ""}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Lista de precios{" "}
        <select value={listaId} onChange={(e) => setListaId(e.target.value)}>
          <option value="">la preferida del cliente</option>
          {listas.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.currency_code})
            </option>
          ))}
        </select>
      </label>
      {listaDistinta && <p role="status">Exige el permiso sales.price_list.override.</p>}{" "}
      <label>
        Serie <input value={serie} onChange={(e) => setSerie(e.target.value)} size={4} />
      </label>{" "}
      <label>
        Almacén (uuid, solo para facturar){" "}
        <input value={almacen} onChange={(e) => setAlmacen(e.target.value)} size={38} />
      </label>
      <ul>
        {lineas.map((l, i) => (
          <li key={i}>
            <select
              value={l.product_id}
              onChange={(e) => {
                const cp = [...lineas];
                cp[i] = { ...l, product_id: e.target.value };
                setLineas(cp);
              }}
            >
              <option value="">producto…</option>
              {productos.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.sku} — {p.name}
                </option>
              ))}
            </select>{" "}
            <input
              placeholder="cantidad"
              value={l.quantity}
              onChange={(e) => {
                const cp = [...lineas];
                cp[i] = { ...l, quantity: e.target.value };
                setLineas(cp);
              }}
              size={8}
            />{" "}
            <button onClick={() => setLineas(lineas.filter((_, j) => j !== i))}>quitar</button>
          </li>
        ))}
      </ul>
      <button onClick={() => setLineas([...lineas, { product_id: "", quantity: "" }])}>
        Añadir línea
      </button>
      <p>
        <button onClick={() => void emitir("quotes")}>Cotizar</button>{" "}
        <button onClick={() => void emitir("orders")}>Crear pedido</button>{" "}
        <button
          onClick={() => {
            if (
              window.confirm(
                "Emitir una factura consume el correlativo fiscal y descarga el inventario. Una vez emitida NO se edita ni se borra: se corrige con nota de crédito. ¿Emitir?",
              )
            ) {
              void emitir("invoices");
            }
          }}
        >
          Emitir factura
        </button>
      </p>
    </>
  );
}

// ── Cuentas por cobrar ───────────────────────────────────────────────────────

function CuentasPorCobrar({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [clientes, setClientes] = useState<Customer[]>([]);
  const [clienteId, setClienteId] = useState("");
  const [estado, setEstado] = useState<CustomerStatement | null>(null);

  useEffect(() => {
    api<{ items: Customer[] }>(session, "/v1/customers?per_page=100", { companyId })
      .then((r) => setClientes(r.items))
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, onError]);

  useEffect(() => {
    if (clienteId === "") {
      setEstado(null);
      return;
    }
    api<CustomerStatement>(session, `/v1/customers/${clienteId}/statement`, {
      companyId,
    })
      .then(setEstado)
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, clienteId, onError]);

  return (
    <>
      <h3>Estado de cuenta y antigüedad</h3>
      <label>
        Cliente{" "}
        <select value={clienteId} onChange={(e) => setClienteId(e.target.value)}>
          <option value="">elige…</option>
          {clientes.map((c) => (
            <option key={c.id} value={c.id}>
              {c.legal_name}
            </option>
          ))}
        </select>
      </label>
      {estado && (
        <>
          <p>
            Pendiente:{" "}
            <strong>
              {mostrarImporte({ amount: estado.total_outstanding, currency: estado.currency })}
            </strong>{" "}
            · Saldo a favor disponible:{" "}
            {mostrarImporte({ amount: estado.total_credit_available, currency: estado.currency })}
          </p>
          <h4>Antigüedad al {estado.aging.reference_date}</h4>
          <table>
            <thead>
              <tr>
                <th>Tramo</th>
                <th>Documentos</th>
                <th>Importe</th>
              </tr>
            </thead>
            <tbody>
              {estado.aging.buckets.map((b) => (
                <tr key={b.bucket}>
                  <td>{b.bucket} días</td>
                  <td>{b.document_count}</td>
                  <td>{mostrarImporte({ amount: b.amount, currency: estado.currency })}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <h4>Documentos</h4>
          <table>
            <thead>
              <tr>
                <th>Nº</th>
                <th>Emitido</th>
                <th>Estado</th>
                <th>Total</th>
                <th>Cobrado</th>
                <th>Saldo</th>
                <th>Días</th>
              </tr>
            </thead>
            <tbody>
              {estado.documents.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.series}-{d.document_number ?? "—"}
                  </td>
                  <td>{d.issued_at?.slice(0, 10) ?? "—"}</td>
                  <td>{d.status}</td>
                  <td>{mostrarImporte({ amount: d.total_amount, currency: estado.currency })}</td>
                  <td>{mostrarImporte({ amount: d.paid_amount, currency: estado.currency })}</td>
                  <td>{mostrarImporte({ amount: d.balance, currency: estado.currency })}</td>
                  <td>{d.days_outstanding}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {estado.credits.length > 0 && (
            <>
              <h4>Saldos a favor</h4>
              <ul>
                {estado.credits.map((c) => (
                  <li key={c.id}>
                    {mostrarImporte({ amount: c.amount, currency: estado.currency })} · aplicado{" "}
                    {mostrarImporte({ amount: c.applied_amount, currency: estado.currency })} ·{" "}
                    {c.status}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </>
  );
}

// ── Numeración fiscal y tasas ────────────────────────────────────────────────

function Fiscal({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [rangos, setRangos] = useState<FiscalRange[] | null>(null);
  const [porAgotarse, setPorAgotarse] = useState<{ range_id: string; remaining: number }[]>([]);
  const [tasa, setTasa] = useState({
    from_currency: "USD",
    to_currency: "VES",
    rate: "",
    source: "",
    rate_date: new Date().toISOString().slice(0, 10),
  });

  const cargar = useCallback(async () => {
    try {
      const [rs, ex] = await Promise.all([
        api<FiscalRange[]>(session, "/v1/fiscal-number-ranges", { companyId }),
        api<{ range_id: string; remaining: number }[]>(
          session,
          "/v1/fiscal-number-ranges/exhaustion",
          { companyId },
        ),
      ]);
      setRangos(rs);
      setPorAgotarse(ex);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cargarTasa() {
    try {
      await api(session, "/v1/exchange-rates", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify(tasa),
      });
      onAviso(`Tasa ${tasa.from_currency}→${tasa.to_currency} cargada para ${tasa.rate_date}.`);
      setTasa({ ...tasa, rate: "" });
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Rangos de número de control</h3>
      {porAgotarse.length > 0 && (
        <p role="alert">
          {porAgotarse.length} rango(s) por agotarse. Pide otro a la imprenta antes de que la caja
          se pare: sin número de control disponible, la emisión se detiene.
        </p>
      )}
      {rangos === null ? (
        <p>cargando…</p>
      ) : rangos.length === 0 ? (
        <p>Sin rangos cargados. Si el régimen los exige, no se puede emitir.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tipo</th>
              <th>Serie</th>
              <th>Desde</th>
              <th>Hasta</th>
              <th>Próximo</th>
              <th>Quedan</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {rangos.map((r) => (
              <tr key={r.id}>
                <td>{r.kind}</td>
                <td>{r.series}</td>
                <td>{r.range_from}</td>
                <td>{r.range_to}</td>
                <td>{r.next_available}</td>
                <td>{r.remaining}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <h3>Cargar tasa de cambio</h3>
      <p>
        {/* El adaptador BCV todavía no trae nada (ADR-0028): esta es la vía. */}
        Carga manual. Sin fuente no se guarda, y la fuente viaja en cada documento que use la tasa.
      </p>
      <input
        value={tasa.from_currency}
        onChange={(e) => setTasa({ ...tasa, from_currency: e.target.value.toUpperCase() })}
        size={4}
      />{" "}
      →{" "}
      <input
        value={tasa.to_currency}
        onChange={(e) => setTasa({ ...tasa, to_currency: e.target.value.toUpperCase() })}
        size={4}
      />{" "}
      <input
        placeholder="tasa"
        value={tasa.rate}
        onChange={(e) => setTasa({ ...tasa, rate: e.target.value })}
      />{" "}
      <input
        placeholder="fuente (obligatoria)"
        value={tasa.source}
        onChange={(e) => setTasa({ ...tasa, source: e.target.value })}
        size={30}
      />{" "}
      <input
        type="date"
        value={tasa.rate_date}
        onChange={(e) => setTasa({ ...tasa, rate_date: e.target.value })}
      />{" "}
      <button onClick={() => void cargarTasa()}>Cargar</button>
    </>
  );
}

/**
 * KPI del panel: diferencial cambiario acumulado. Va aparte porque lo consume
 * el tablero, no la pantalla de ventas: es un número de dirección, no de caja.
 */
export function ExchangeDifferenceKPI({ session, companyId }: Props): React.JSX.Element {
  const [datos, setDatos] = useState<ExchangeDifferenceReport | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<ExchangeDifferenceReport>(session, "/v1/reports/exchange-difference", { companyId })
      .then(setDatos)
      .catch((e: unknown) => setError(mensajeDe(e)));
  }, [session, companyId]);

  if (error) return <p role="alert">{error}</p>;
  if (!datos) return <p>cargando…</p>;
  // El SIGNO se lee del string, no se calcula: `neto` es un decimal de hasta 8
  // decimales y pasarlo por Number para compararlo con cero ya sería aritmética
  // monetaria en el cliente. Mirar si empieza por `-` no lo es.
  const esPerdida = datos.neto.trimStart().startsWith("-");
  const importe = (a: string): string => mostrarImporte({ amount: a, currency: datos.currency });
  return (
    <section>
      <h3>Diferencial cambiario acumulado</h3>
      <p>
        <strong>{importe(datos.neto)}</strong> neto {esPerdida ? "(pérdida)" : "(ganancia)"} ·
        ganancias {importe(datos.ganancia)} · pérdidas {importe(datos.perdida)}
      </p>
      {datos.by_month.length > 0 && (
        <ul>
          {datos.by_month.map((m) => (
            <li key={m.month}>
              {m.month}: {importe(m.amount)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
