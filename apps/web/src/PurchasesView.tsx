import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type GoodsReceiptDetail,
  type LandedCostResult,
  type MatchingRow,
  type Product,
  type PurchaseOrder,
  type PurchaseOrderDetail,
  type RetentionConcept,
  type RetentionRule,
  type Supplier,
  type SupplierInvoice,
  type SupplierStatement,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Compras. Como en ventas, la pantalla NO calcula dinero: ni el prorrateo del
 * landed cost, ni la retención, ni el saldo. Todo llega calculado, con su
 * moneda y su tasa.
 *
 * Y hay una cosa que esta pantalla dice en voz alta porque si no parece
 * avería: **sin regla de retención cargada no se puede retener**, y el catálogo
 * nace vacío a propósito. El panel de reglas está aquí para que cargarla sea un
 * acto visible, con su norma, no un ajuste escondido en una migración.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

function idem(): Record<string, string> {
  return { "Idempotency-Key": crypto.randomUUID() };
}

export function PurchasesView({ session, companyId }: Props) {
  const [panel, setPanel] = useState<"ordenes" | "nueva" | "cxp" | "retenciones">("ordenes");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  return (
    <section>
      <h2>Compras</h2>
      <nav>
        <button disabled={panel === "ordenes"} onClick={() => setPanel("ordenes")}>
          Órdenes
        </button>{" "}
        <button disabled={panel === "nueva"} onClick={() => setPanel("nueva")}>
          Nueva orden
        </button>{" "}
        <button disabled={panel === "cxp"} onClick={() => setPanel("cxp")}>
          Cuentas por pagar
        </button>{" "}
        <button disabled={panel === "retenciones"} onClick={() => setPanel("retenciones")}>
          Retenciones
        </button>
      </nav>
      {error && <p role="alert">{error}</p>}
      {aviso && <p role="status">{aviso}</p>}

      {panel === "ordenes" ? (
        <Ordenes session={session} companyId={companyId} onError={setError} onAviso={setAviso} />
      ) : panel === "nueva" ? (
        <NuevaOrden
          session={session}
          companyId={companyId}
          onError={setError}
          onHecho={(m) => {
            setAviso(m);
            setPanel("ordenes");
          }}
        />
      ) : panel === "cxp" ? (
        <CuentasPorPagar session={session} companyId={companyId} onError={setError} />
      ) : (
        <Retenciones
          session={session}
          companyId={companyId}
          onError={setError}
          onAviso={setAviso}
        />
      )}
    </section>
  );
}

// ── Órdenes: listado, detalle, recepción, factura y landed cost ─────────────

function Ordenes({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [ordenes, setOrdenes] = useState<PurchaseOrder[] | null>(null);
  const [abierta, setAbierta] = useState<PurchaseOrderDetail | null>(null);

  const cargar = useCallback(async () => {
    try {
      const r = await api<{ items: PurchaseOrder[] }>(session, "/v1/purchase-orders", {
        companyId,
      });
      setOrdenes(r.items);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const abrir = useCallback(
    async (id: string) => {
      try {
        setAbierta(
          await api<PurchaseOrderDetail>(session, `/v1/purchase-orders/${id}`, { companyId }),
        );
      } catch (e) {
        onError(mensajeDe(e));
      }
    },
    [session, companyId, onError],
  );

  return (
    <>
      <h3>Órdenes de compra</h3>
      {ordenes === null ? (
        <p>cargando…</p>
      ) : ordenes.length === 0 ? (
        <p>Todavía no hay órdenes.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Nº</th>
              <th>Estado</th>
              <th>Fecha</th>
              <th>Moneda</th>
              <th>Total</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ordenes.map((o) => (
              <tr key={o.id}>
                <td>{o.order_number ?? "—"}</td>
                {/* El estado DERIVADO de lo recibido, no la columna. */}
                <td>{o.derived_status ?? o.status}</td>
                <td>{o.ordered_at?.slice(0, 10) ?? "—"}</td>
                <td>{o.transaction_currency}</td>
                <td>
                  {mostrarImporte({
                    amount: o.amount_transaction_currency,
                    currency: o.transaction_currency,
                  })}
                </td>
                <td>
                  <button onClick={() => void abrir(o.id)}>ver</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {abierta && (
        <DetalleOrden
          session={session}
          companyId={companyId}
          detalle={abierta}
          onError={onError}
          onAviso={onAviso}
          onRefrescar={() => void abrir(abierta.order.id)}
          onCerrar={() => setAbierta(null)}
        />
      )}
    </>
  );
}

function DetalleOrden({
  session,
  companyId,
  detalle,
  onError,
  onAviso,
  onRefrescar,
  onCerrar,
}: Props & {
  detalle: PurchaseOrderDetail;
  onError: (m: string) => void;
  onAviso: (m: string) => void;
  onRefrescar: () => void;
  onCerrar: () => void;
}): React.JSX.Element {
  const o = detalle.order;
  const [cantidades, setCantidades] = useState<Record<string, string>>({});
  const [recepcion, setRecepcion] = useState<GoodsReceiptDetail | null>(null);

  async function recibir() {
    const lines = detalle.lines
      .filter((l) => (cantidades[l.id] ?? "").trim() !== "")
      .map((l) => ({
        purchase_order_line_id: l.id,
        product_id: l.product_id,
        quantity: cantidades[l.id]!.trim(),
        unit_price: l.unit_price_transaction,
        ...(l.unit_weight !== null ? { unit_weight: l.unit_weight } : {}),
      }));
    if (lines.length === 0) return;
    if (
      !window.confirm(
        "Confirmar la recepción MUEVE EL INVENTARIO y fija el costo con la tasa de hoy. Una vez confirmada no se edita. ¿Recibir?",
      )
    ) {
      return;
    }
    try {
      await api(session, "/v1/goods-receipts", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          supplier_id: o.supplier_id,
          purchase_order_id: o.id,
          warehouse_id: o.warehouse_id,
          currency: o.transaction_currency,
          lines,
        }),
      });
      setCantidades({});
      onAviso("Recepción confirmada: el inventario ya la refleja.");
      onRefrescar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  async function verRecepcion(id: string) {
    try {
      setRecepcion(
        await api<GoodsReceiptDetail>(session, `/v1/goods-receipts/${id}`, { companyId }),
      );
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <article>
      <h3>
        Orden {o.order_number ?? "borrador"} <button onClick={onCerrar}>cerrar</button>
      </h3>
      <p>
        Estado: <strong>{detalle.derived_status}</strong> · moneda {o.transaction_currency} · tasa{" "}
        {o.fx_rate} ({o.rate_source})
      </p>

      <h4>Avance por línea</h4>
      <table>
        <thead>
          <tr>
            <th>Descripción</th>
            <th>Pedido</th>
            <th>Recibido</th>
            <th>Pendiente</th>
            <th>P. unit.</th>
            <th>Recibir ahora</th>
          </tr>
        </thead>
        <tbody>
          {detalle.lines.map((l) => {
            const p = detalle.progress.find((x) => x.order_line_id === l.id);
            const pendiente = p?.quantity_pending ?? l.quantity;
            return (
              <tr key={l.id}>
                <td>{l.description}</td>
                <td>{l.quantity}</td>
                <td>{p?.quantity_received ?? "0"}</td>
                <td>{pendiente}</td>
                <td>
                  {mostrarImporte({
                    amount: l.unit_price_transaction,
                    currency: o.transaction_currency,
                  })}
                </td>
                <td>
                  {Number(pendiente) > 0 ? (
                    <input
                      value={cantidades[l.id] ?? ""}
                      onChange={(e) => setCantidades({ ...cantidades, [l.id]: e.target.value })}
                      size={8}
                      placeholder={`hasta ${pendiente}`}
                    />
                  ) : (
                    "completa"
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <button onClick={() => void recibir()}>Registrar recepción</button>

      <h4>Recepciones</h4>
      {detalle.receipts.length === 0 ? (
        <p>Todavía no ha llegado nada.</p>
      ) : (
        <ul>
          {detalle.receipts.map((r) => (
            <li key={r.id}>
              Nº {r.receipt_number ?? "—"} · {r.received_at?.slice(0, 10) ?? "—"} ·{" "}
              {mostrarImporte({ amount: r.functional_amount, currency: o.functional_currency })}{" "}
              <button onClick={() => void verRecepcion(r.id)}>costear</button>
            </li>
          ))}
        </ul>
      )}

      <h4>Facturas del proveedor</h4>
      {detalle.invoices.length === 0 ? (
        <p>
          Ninguna todavía. La factura puede llegar días después de la mercancía: el inventario no la
          espera.
        </p>
      ) : (
        <ul>
          {detalle.invoices.map((i) => (
            <li key={i.id}>
              {i.supplier_document_number} · {i.invoice_date} · {i.status} ·{" "}
              {mostrarImporte({ amount: i.total_amount, currency: o.functional_currency })}
            </li>
          ))}
        </ul>
      )}

      {recepcion && (
        <LandedCost
          session={session}
          companyId={companyId}
          recepcion={recepcion}
          onError={onError}
          onAviso={onAviso}
          onCerrar={() => setRecepcion(null)}
          onHecho={() => void verRecepcion(recepcion.receipt.id)}
        />
      )}
    </article>
  );
}

function LandedCost({
  session,
  companyId,
  recepcion,
  onError,
  onAviso,
  onCerrar,
  onHecho,
}: Props & {
  recepcion: GoodsReceiptDetail;
  onError: (m: string) => void;
  onAviso: (m: string) => void;
  onCerrar: () => void;
  onHecho: () => void;
}): React.JSX.Element {
  const [gasto, setGasto] = useState({
    concept: "",
    allocation_method: "by_value",
    amount: "",
    currency: recepcion.receipt.functional_currency,
    incurred_on: new Date().toISOString().slice(0, 10),
  });
  const [ultimo, setUltimo] = useState<LandedCostResult | null>(null);

  async function aplicar() {
    if (
      !window.confirm(
        "El gasto se reparte y se CONGELA. La parte de la mercancía ya vendida no encarece lo que queda: se registra como variación de costo del período. ¿Aplicar?",
      )
    ) {
      return;
    }
    try {
      const r = await api<LandedCostResult>(session, "/v1/landed-costs", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          goods_receipt_id: recepcion.receipt.id,
          ...gasto,
        }),
      });
      setUltimo(r);
      setGasto({ ...gasto, concept: "", amount: "" });
      onAviso("Gasto aplicado.");
      onHecho();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <fieldset>
      <legend>
        Costear la recepción Nº {recepcion.receipt.receipt_number ?? "—"}{" "}
        <button onClick={onCerrar}>cerrar</button>
      </legend>
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Cantidad</th>
            <th>Costo unit.</th>
            <th>Landed acumulado</th>
            <th>Peso unit.</th>
          </tr>
        </thead>
        <tbody>
          {recepcion.lines.map((l) => (
            <tr key={l.id}>
              <td>{l.line_number}</td>
              <td>{l.quantity}</td>
              <td>
                {mostrarImporte({
                  amount: l.unit_cost_functional,
                  currency: recepcion.receipt.functional_currency,
                })}
              </td>
              <td>
                {mostrarImporte({
                  amount: l.landed_cost_functional,
                  currency: recepcion.receipt.functional_currency,
                })}
              </td>
              {/* Sin peso, el prorrateo por peso FALLA. Se dice aquí para que no
                  sorprenda cuando el gasto se rechaza. */}
              <td>{l.unit_weight ?? "— (bloquea el reparto por peso)"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <input
        placeholder="concepto (flete, aduana…)"
        value={gasto.concept}
        onChange={(e) => setGasto({ ...gasto, concept: e.target.value })}
        size={28}
      />{" "}
      <select
        value={gasto.allocation_method}
        onChange={(e) => setGasto({ ...gasto, allocation_method: e.target.value })}
      >
        <option value="by_value">por valor</option>
        <option value="by_weight">por peso</option>
        <option value="by_units">por unidades</option>
      </select>{" "}
      <input
        placeholder="importe"
        value={gasto.amount}
        onChange={(e) => setGasto({ ...gasto, amount: e.target.value })}
      />{" "}
      <input
        value={gasto.currency}
        onChange={(e) => setGasto({ ...gasto, currency: e.target.value.toUpperCase() })}
        size={4}
      />{" "}
      <input
        type="date"
        value={gasto.incurred_on}
        onChange={(e) => setGasto({ ...gasto, incurred_on: e.target.value })}
      />{" "}
      <button onClick={() => void aplicar()}>Aplicar al costo</button>
      {ultimo && (
        <p>
          Repartido:{" "}
          {mostrarImporte({
            amount: ultimo.functional_amount,
            currency: ultimo.functional_currency,
          })}{" "}
          · a inventario{" "}
          {ultimo.allocations
            .reduce((acc, a) => acc + Number(a.to_inventory_functional), 0)
            .toFixed(2)}{" "}
          · <strong>a variación {ultimo.total_variance}</strong>{" "}
          {Number(ultimo.total_variance) > 0 &&
            "— corresponde a unidades que ya habían salido, y por eso no encarece las que quedan."}
        </p>
      )}
      {recepcion.landed_costs.length > 0 && (
        <ul>
          {recepcion.landed_costs.map((c) => (
            <li key={c.id}>
              {c.concept} ({c.allocation_method}) ·{" "}
              {mostrarImporte({
                amount: c.functional_amount,
                currency: recepcion.receipt.functional_currency,
              })}{" "}
              · {c.incurred_on} · {c.status}
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}

// ── Nueva orden ─────────────────────────────────────────────────────────────

function NuevaOrden({
  session,
  companyId,
  onError,
  onHecho,
}: Props & { onError: (m: string) => void; onHecho: (m: string) => void }): React.JSX.Element {
  const [proveedores, setProveedores] = useState<Supplier[]>([]);
  const [productos, setProductos] = useState<Product[]>([]);
  const [cabecera, setCabecera] = useState({
    supplier_id: "",
    warehouse_id: "",
    currency: "USD",
    expected_at: "",
  });
  const [lineas, setLineas] = useState([
    { product_id: "", quantity: "", unit_price: "", unit_weight: "" },
  ]);

  useEffect(() => {
    async function cargar() {
      try {
        const [ss, ps] = await Promise.all([
          api<{ items: Supplier[] }>(session, "/v1/suppliers?per_page=100", { companyId }),
          api<{ items: Product[] }>(session, "/v1/products?per_page=100", { companyId }),
        ]);
        setProveedores(ss.items);
        setProductos(ps.items);
      } catch (e) {
        onError(mensajeDe(e));
      }
    }
    void cargar();
  }, [session, companyId, onError]);

  async function crear() {
    try {
      const r = await api<PurchaseOrder>(session, "/v1/purchase-orders", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          company_id: companyId,
          supplier_id: cabecera.supplier_id,
          warehouse_id: cabecera.warehouse_id,
          currency: cabecera.currency,
          ...(cabecera.expected_at ? { expected_at: cabecera.expected_at } : {}),
          lines: lineas
            .filter((l) => l.product_id !== "" && l.quantity.trim() !== "")
            .map((l) => ({
              product_id: l.product_id,
              quantity: l.quantity.trim(),
              unit_price: l.unit_price.trim(),
              ...(l.unit_weight.trim() !== "" ? { unit_weight: l.unit_weight.trim() } : {}),
            })),
        }),
      });
      onHecho(`Orden ${r.order_number ?? ""} creada.`);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Nueva orden de compra</h3>
      <p>
        La orden COMPROMETE, no mueve nada. El inventario y el costo se fijan al recibir, con la
        tasa de ese día.
      </p>
      <label>
        Proveedor{" "}
        <select
          value={cabecera.supplier_id}
          onChange={(e) => setCabecera({ ...cabecera, supplier_id: e.target.value })}
        >
          <option value="">elige…</option>
          {proveedores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.legal_name} {s.supplier_kind === "extranjero" ? "(extranjero)" : ""}
            </option>
          ))}
        </select>
      </label>{" "}
      <label>
        Almacén (uuid){" "}
        <input
          value={cabecera.warehouse_id}
          onChange={(e) => setCabecera({ ...cabecera, warehouse_id: e.target.value })}
          size={38}
        />
      </label>{" "}
      <label>
        Moneda{" "}
        <input
          value={cabecera.currency}
          onChange={(e) => setCabecera({ ...cabecera, currency: e.target.value.toUpperCase() })}
          size={4}
        />
      </label>{" "}
      <label>
        Esperada{" "}
        <input
          type="date"
          value={cabecera.expected_at}
          onChange={(e) => setCabecera({ ...cabecera, expected_at: e.target.value })}
        />
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
            <input
              placeholder="precio unit."
              value={l.unit_price}
              onChange={(e) => {
                const cp = [...lineas];
                cp[i] = { ...l, unit_price: e.target.value };
                setLineas(cp);
              }}
              size={10}
            />{" "}
            <input
              placeholder="peso unit."
              value={l.unit_weight}
              onChange={(e) => {
                const cp = [...lineas];
                cp[i] = { ...l, unit_weight: e.target.value };
                setLineas(cp);
              }}
              size={8}
            />{" "}
            <button onClick={() => setLineas(lineas.filter((_, j) => j !== i))}>quitar</button>
          </li>
        ))}
      </ul>
      <button
        onClick={() =>
          setLineas([...lineas, { product_id: "", quantity: "", unit_price: "", unit_weight: "" }])
        }
      >
        Añadir línea
      </button>{" "}
      <button onClick={() => void crear()}>Crear orden</button>
    </>
  );
}

// ── Cuentas por pagar ───────────────────────────────────────────────────────

function CuentasPorPagar({
  session,
  companyId,
  onError,
}: Props & { onError: (m: string) => void }): React.JSX.Element {
  const [proveedores, setProveedores] = useState<Supplier[]>([]);
  const [proveedorId, setProveedorId] = useState("");
  const [estado, setEstado] = useState<SupplierStatement | null>(null);
  const [facturas, setFacturas] = useState<SupplierInvoice[]>([]);
  const [matching, setMatching] = useState<{ rows: MatchingRow[]; tol: string } | null>(null);

  useEffect(() => {
    api<{ items: Supplier[] }>(session, "/v1/suppliers?per_page=100", { companyId })
      .then((r) => setProveedores(r.items))
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, onError]);

  useEffect(() => {
    if (proveedorId === "") {
      setEstado(null);
      setFacturas([]);
      return;
    }
    Promise.all([
      api<SupplierStatement>(session, `/v1/suppliers/${proveedorId}/statement`, { companyId }),
      api<{ items: SupplierInvoice[] }>(
        session,
        `/v1/supplier-invoices?supplier_id=${proveedorId}`,
        { companyId },
      ),
    ])
      .then(([e, f]) => {
        setEstado(e);
        setFacturas(f.items);
      })
      .catch((e: unknown) => onError(mensajeDe(e)));
  }, [session, companyId, proveedorId, onError]);

  async function verMatching(invoiceId: string) {
    try {
      const r = await api<{ rows: MatchingRow[]; price_tolerance_pct: string }>(
        session,
        `/v1/purchases/matching?supplier_invoice_id=${invoiceId}`,
        { companyId },
      );
      setMatching({ rows: r.rows, tol: r.price_tolerance_pct });
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Estado de cuenta y antigüedad</h3>
      <label>
        Proveedor{" "}
        <select value={proveedorId} onChange={(e) => setProveedorId(e.target.value)}>
          <option value="">elige…</option>
          {proveedores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.legal_name}
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
            · retenido acumulado:{" "}
            {mostrarImporte({ amount: estado.total_retained, currency: estado.currency })}
          </p>
          <h4>Antigüedad al {estado.aging.reference_date}</h4>
          <table>
            <thead>
              <tr>
                <th>Tramo</th>
                <th>Facturas</th>
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
          <h4>Facturas</h4>
          <table>
            <thead>
              <tr>
                <th>Documento</th>
                <th>Control</th>
                <th>Fecha</th>
                <th>Estado</th>
                <th>Total</th>
                <th>Retenido</th>
                <th>Saldo</th>
                <th>IVA</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {facturas.map((f) => (
                <tr key={f.id}>
                  <td>{f.supplier_document_number}</td>
                  {/* Del proveedor. Un guion cuando es extranjero. */}
                  <td>{f.supplier_control_number ?? f.supplier_document_ref ?? "—"}</td>
                  <td>{f.invoice_date}</td>
                  <td>{f.status}</td>
                  <td>
                    {mostrarImporte({
                      amount: f.total_amount,
                      currency: f.transaction_currency,
                    })}
                  </td>
                  <td>
                    {mostrarImporte({
                      amount: f.retention_total,
                      currency: f.functional_currency,
                    })}
                  </td>
                  <td>
                    {f.balance === undefined
                      ? "—"
                      : mostrarImporte({ amount: f.balance, currency: f.functional_currency })}
                  </td>
                  {/* Derivado del régimen de la empresa, no de una preferencia. */}
                  <td>{f.tax_is_recoverable ? "crédito" : "costo"}</td>
                  <td>
                    <button onClick={() => void verMatching(f.id)}>matching</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {matching && (
        <fieldset>
          <legend>Matching de tres vías (umbral de precio: {matching.tol} %)</legend>
          <table>
            <thead>
              <tr>
                <th>Pedido</th>
                <th>Recibido</th>
                <th>Facturado</th>
                <th>P. orden</th>
                <th>P. factura</th>
                <th>Δ precio</th>
              </tr>
            </thead>
            <tbody>
              {matching.rows.map((r) => (
                <tr key={r.invoice_line_id}>
                  <td>{r.qty_ordered ?? "sin orden"}</td>
                  <td>{r.qty_received ?? "sin recepción"}</td>
                  <td>{r.qty_invoiced}</td>
                  <td>{r.price_ordered ?? "—"}</td>
                  <td>{r.price_invoiced}</td>
                  <td>
                    {r.price_diff_pct ?? "—"}
                    {r.price_diff_pct !== null &&
                      Number(r.price_diff_pct) > Number(matching.tol) &&
                      " ⚠ fuera de umbral"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            {/* Dicho aquí porque es la asimetría que más confunde. */}
            El precio admite el umbral acordado; la cantidad no admite ninguno — una diferencia de
            cantidad es una recepción que falta o un error, no un redondeo.
          </p>
          <button onClick={() => setMatching(null)}>cerrar</button>
        </fieldset>
      )}
    </>
  );
}

// ── Retenciones: el catálogo que nace vacío ─────────────────────────────────

function Retenciones({
  session,
  companyId,
  onError,
  onAviso,
}: Props & { onError: (m: string) => void; onAviso: (m: string) => void }): React.JSX.Element {
  const [conceptos, setConceptos] = useState<RetentionConcept[]>([]);
  const [reglas, setReglas] = useState<RetentionRule[] | null>(null);
  const [nueva, setNueva] = useState({
    jurisdiction: "VE",
    retention_code: "iva",
    concept_code: "",
    formula_kind: "rate",
    rate: "",
    subtrahend: "",
    minimum_exempt: "",
    effective_from: new Date().toISOString().slice(0, 10),
    legal_source: "",
  });

  const cargar = useCallback(async () => {
    try {
      const [cs, rs] = await Promise.all([
        api<RetentionConcept[]>(session, "/v1/retention-concepts", { companyId }),
        api<RetentionRule[]>(session, "/v1/retention-rules", { companyId }),
      ]);
      setConceptos(cs);
      setReglas(rs);
    } catch (e) {
      onError(mensajeDe(e));
    }
  }, [session, companyId, onError]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function cargarRegla() {
    try {
      await api(session, "/v1/retention-rules", {
        method: "POST",
        companyId,
        headers: idem(),
        body: JSON.stringify({
          jurisdiction: nueva.jurisdiction,
          retention_code: nueva.retention_code,
          concept_code: nueva.concept_code,
          formula_kind: nueva.formula_kind,
          rate: nueva.rate,
          ...(nueva.formula_kind === "rate_minus_subtrahend"
            ? {
                subtrahend: nueva.subtrahend,
                ...(nueva.minimum_exempt !== "" ? { minimum_exempt: nueva.minimum_exempt } : {}),
              }
            : {}),
          effective_from: nueva.effective_from,
          legal_source: nueva.legal_source,
        }),
      });
      onAviso("Regla cargada. A partir de su fecha de vigencia, la empresa puede retener.");
      setNueva({ ...nueva, rate: "", subtrahend: "", minimum_exempt: "", legal_source: "" });
      await cargar();
    } catch (e) {
      onError(mensajeDe(e));
    }
  }

  return (
    <>
      <h3>Reglas de retención</h3>
      <p>
        {/* Lo primero que hay que entender de esta pantalla. */}
        El catálogo <strong>nace vacío a propósito</strong>: Ladino no trae ningún porcentaje de
        retención escrito. Sin una regla vigente no se retiene, y una factura con retención se
        detiene con un error que dice exactamente qué falta. Cargar una regla es un acto
        administrativo: exige citar la norma.
      </p>
      {reglas === null ? (
        <p>cargando…</p>
      ) : reglas.length === 0 ? (
        <p>Sin reglas cargadas. La empresa todavía no puede practicar retenciones.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tributo</th>
              <th>Concepto</th>
              <th>Fórmula</th>
              <th>Tasa</th>
              <th>Sustraendo</th>
              <th>Mínimo</th>
              <th>Desde</th>
              <th>Norma</th>
              <th>Estado</th>
            </tr>
          </thead>
          <tbody>
            {reglas.map((r) => (
              <tr key={r.id}>
                <td>{r.retention_code}</td>
                <td>{r.concept_code}</td>
                <td>{r.formula_kind}</td>
                <td>{r.rate}</td>
                <td>{r.subtrahend ?? "—"}</td>
                <td>{r.minimum_exempt ?? "—"}</td>
                <td>{r.effective_from}</td>
                <td>{r.legal_source}</td>
                <td>{r.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <fieldset>
        <legend>Cargar regla</legend>
        <select
          value={nueva.retention_code}
          onChange={(e) => setNueva({ ...nueva, retention_code: e.target.value })}
        >
          <option value="iva">IVA</option>
          <option value="islr">ISLR</option>
        </select>{" "}
        <select
          value={nueva.concept_code}
          onChange={(e) => setNueva({ ...nueva, concept_code: e.target.value })}
        >
          <option value="">concepto…</option>
          {conceptos
            .filter((c) => c.retention_code === nueva.retention_code)
            .map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
        </select>{" "}
        <select
          value={nueva.formula_kind}
          onChange={(e) => setNueva({ ...nueva, formula_kind: e.target.value })}
        >
          <option value="rate">base × tasa</option>
          <option value="rate_minus_subtrahend">base × tasa − sustraendo</option>
        </select>{" "}
        <input
          placeholder="tasa (0,75 = 75 %)"
          value={nueva.rate}
          onChange={(e) => setNueva({ ...nueva, rate: e.target.value })}
          size={14}
        />{" "}
        {nueva.formula_kind === "rate_minus_subtrahend" && (
          <>
            <input
              placeholder="sustraendo"
              value={nueva.subtrahend}
              onChange={(e) => setNueva({ ...nueva, subtrahend: e.target.value })}
              size={12}
            />{" "}
            <input
              placeholder="mínimo exento"
              value={nueva.minimum_exempt}
              onChange={(e) => setNueva({ ...nueva, minimum_exempt: e.target.value })}
              size={14}
            />{" "}
          </>
        )}
        <input
          type="date"
          value={nueva.effective_from}
          onChange={(e) => setNueva({ ...nueva, effective_from: e.target.value })}
        />{" "}
        <input
          placeholder="norma (Gaceta, providencia…) — obligatoria"
          value={nueva.legal_source}
          onChange={(e) => setNueva({ ...nueva, legal_source: e.target.value })}
          size={44}
        />{" "}
        <button onClick={() => void cargarRegla()}>Cargar</button>
      </fieldset>
    </>
  );
}
