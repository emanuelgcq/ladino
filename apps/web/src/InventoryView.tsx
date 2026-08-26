import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type InventoryMove,
  type Product,
  type StockBalance,
  type Warehouse,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Inventario: existencias, kardex de un producto y los cuatro formularios que
 * mueven stock.
 *
 * CERO aritmética aquí: las cantidades y los importes llegan como string, se
 * muestran como string y se envían como string. El saldo y el costo acumulado
 * que se ven en el kardex NO los calcula esta pantalla — los trae cada
 * movimiento (`quantity_after`, `value_after`, `unit_cost`), que es lo que el
 * esquema calculó y persistió. Recalcularlos en el cliente sería inventar una
 * segunda verdad (apps/web/CLAUDE.md).
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

const CANTIDAD_RE = /^\d{1,16}(\.\d{1,8})?$/;
const DELTA_RE = /^-?\d{1,16}(\.\d{1,8})?$/;
const IMPORTE_RE = /^\d{1,16}(\.\d{1,8})?$/;

interface Props {
  session: Session;
  companyId: string;
}

type Operacion = "entrada" | "salida" | "ajuste" | "transferencia";

export function InventoryView({ session, companyId }: Props) {
  const [almacenes, setAlmacenes] = useState<Warehouse[]>([]);
  const [productos, setProductos] = useState<Product[]>([]);
  const [stock, setStock] = useState<StockBalance[] | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [almacen, setAlmacen] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");
  const [kardexDe, setKardexDe] = useState<StockBalance | null>(null);
  const [operacion, setOperacion] = useState<Operacion | null>(null);

  const cargar = useCallback(async () => {
    setError("");
    try {
      const [w, p] = await Promise.all([
        api<Warehouse[]>(session, "/v1/warehouses", { companyId }),
        api<{ items: Product[] }>(session, "/v1/products?per_page=200", { companyId }),
      ]);
      setAlmacenes(w);
      setProductos(p.items.filter((x) => x.kind === "good"));
      const params = new URLSearchParams();
      if (busqueda.trim() !== "") params.set("search", busqueda.trim());
      if (almacen !== "") params.set("warehouse_id", almacen);
      const s = await api<{ items: StockBalance[] }>(
        session,
        `/v1/inventory/stock?${params.toString()}`,
        { companyId },
      );
      setStock(s.items);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }, [session, companyId, busqueda, almacen]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const nombreAlmacen = (id: string) => almacenes.find((w) => w.id === id)?.code ?? id.slice(0, 8);
  const nombreProducto = (id: string) => productos.find((p) => p.id === id)?.sku ?? id.slice(0, 8);

  return (
    <section>
      <h2>Inventario</h2>
      {error && <p role="alert">{error}</p>}
      {aviso && <p role="status">{aviso}</p>}

      <p>
        <input
          placeholder="buscar por SKU o nombre"
          value={busqueda}
          onChange={(e) => setBusqueda(e.target.value)}
        />{" "}
        <select value={almacen} onChange={(e) => setAlmacen(e.target.value)}>
          <option value="">— todos los almacenes —</option>
          {almacenes.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </select>{" "}
        <button onClick={() => void cargar()}>Actualizar</button>
      </p>

      <nav>
        {(["entrada", "salida", "ajuste", "transferencia"] as const).map((op) => (
          <button
            key={op}
            disabled={operacion === op}
            onClick={() => {
              setOperacion(op);
              setAviso("");
            }}
          >
            {op === "entrada"
              ? "+ Entrada"
              : op === "salida"
                ? "− Salida"
                : op === "ajuste"
                  ? "± Ajuste"
                  : "→ Transferencia"}
          </button>
        ))}{" "}
        {operacion && <button onClick={() => setOperacion(null)}>cerrar</button>}
      </nav>

      {operacion && (
        <MovimientoForm
          session={session}
          companyId={companyId}
          operacion={operacion}
          almacenes={almacenes}
          productos={productos}
          onHecho={(mensaje) => {
            setAviso(mensaje);
            setOperacion(null);
            void cargar();
          }}
        />
      )}

      <h3>Existencias</h3>
      {stock === null ? (
        <p>cargando…</p>
      ) : stock.length === 0 ? (
        <p>Sin existencias registradas con ese filtro.</p>
      ) : (
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>Almacén</th>
              <th>SKU</th>
              <th>Producto</th>
              <th>Lote</th>
              <th>Cantidad</th>
              <th>Valor</th>
              <th>Costo unitario</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {stock.map((b) => (
              <tr key={`${b.warehouse_id}-${b.product_id}-${b.lot_id ?? "sin"}`}>
                <td>{b.warehouse_code}</td>
                <td>{b.product_sku}</td>
                <td>{b.product_name}</td>
                <td>{b.lot_code ?? "—"}</td>
                <td>{b.quantity}</td>
                <td>{mostrarImporte({ amount: b.value, currency: b.currency })}</td>
                <td>{mostrarImporte({ amount: b.last_unit_cost, currency: b.currency })}</td>
                <td>
                  <button onClick={() => setKardexDe(b)}>Kardex</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {kardexDe && (
        <Kardex
          session={session}
          companyId={companyId}
          balance={kardexDe}
          onCerrar={() => setKardexDe(null)}
          nombreAlmacen={nombreAlmacen}
          nombreProducto={nombreProducto}
        />
      )}
    </section>
  );
}

function Kardex({
  session,
  companyId,
  balance,
  onCerrar,
  nombreAlmacen,
}: Props & {
  balance: StockBalance;
  onCerrar: () => void;
  nombreAlmacen: (id: string) => string;
  nombreProducto: (id: string) => string;
}) {
  const [movimientos, setMovimientos] = useState<InventoryMove[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    setError("");
    api<{ items: InventoryMove[] }>(
      session,
      `/v1/inventory/moves?product_id=${balance.product_id}&per_page=100`,
      { companyId },
    )
      .then((r) => setMovimientos(r.items))
      .catch((e: unknown) => setError(mensajeDe(e)));
  }, [session, companyId, balance.product_id]);

  return (
    <fieldset>
      <legend>
        Kardex de {balance.product_sku} — {balance.product_name}{" "}
        <button onClick={onCerrar}>cerrar</button>
      </legend>
      {error && <p role="alert">{error}</p>}
      {movimientos === null ? (
        <p>cargando…</p>
      ) : movimientos.length === 0 ? (
        <p>Sin movimientos.</p>
      ) : (
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>Fecha</th>
              <th>Tipo</th>
              <th>Almacén</th>
              <th>Cantidad</th>
              <th>Importe</th>
              <th>Saldo</th>
              <th>Valor acumulado</th>
              <th>Costo unitario</th>
              <th>Referencia</th>
            </tr>
          </thead>
          <tbody>
            {movimientos.map((m) => (
              <tr key={m.id}>
                <td>{m.occurred_at}</td>
                <td>{m.kind}</td>
                <td>{nombreAlmacen(m.warehouse_id)}</td>
                <td>{m.quantity}</td>
                <td>
                  {mostrarImporte({
                    amount: m.functional_amount,
                    currency: m.functional_currency,
                  })}
                  {m.transaction_currency !== m.functional_currency && (
                    <>
                      {" "}
                      <small>
                        ({m.amount_transaction_currency} {m.transaction_currency} @ {m.fx_rate},{" "}
                        {m.rate_source})
                      </small>
                    </>
                  )}
                </td>
                <td>{m.quantity_after}</td>
                <td>
                  {mostrarImporte({ amount: m.value_after, currency: m.functional_currency })}
                </td>
                <td>{mostrarImporte({ amount: m.unit_cost, currency: m.functional_currency })}</td>
                <td>
                  {m.reference ?? "—"}
                  {m.reason && <small> · {m.reason}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <small>
        El saldo y el costo de cada línea vienen del servidor: son los que el kardex calculó y
        guardó al registrar el movimiento. Un movimiento no se edita ni se borra; se corrige con un
        ajuste nuevo.
      </small>
    </fieldset>
  );
}

function MovimientoForm({
  session,
  companyId,
  operacion,
  almacenes,
  productos,
  onHecho,
}: Props & {
  operacion: Operacion;
  almacenes: Warehouse[];
  productos: Product[];
  onHecho: (mensaje: string) => void;
}) {
  const [form, setForm] = useState({
    warehouse_id: "",
    to_warehouse_id: "",
    product_id: "",
    quantity: "",
    amount: "",
    currency: "VES",
    fx_rate: "",
    fx_source: "",
    reason: "",
    reference: "",
  });
  const [error, setError] = useState("");
  const [enviando, setEnviando] = useState(false);

  const cambiar = (campo: string, valor: string) => setForm({ ...form, [campo]: valor });
  const sku = (id: string) => productos.find((p) => p.id === id)?.sku ?? "";
  const codigo = (id: string) => almacenes.find((w) => w.id === id)?.code ?? "";

  const cantidadValida =
    operacion === "ajuste" ? DELTA_RE.test(form.quantity) : CANTIDAD_RE.test(form.quantity);
  const listo =
    form.product_id !== "" &&
    form.warehouse_id !== "" &&
    cantidadValida &&
    (operacion !== "entrada" || IMPORTE_RE.test(form.amount)) &&
    (operacion !== "ajuste" || form.reason.trim().length >= 3) &&
    (operacion !== "transferencia" ||
      (form.to_warehouse_id !== "" && form.to_warehouse_id !== form.warehouse_id));

  function resumen(): string {
    switch (operacion) {
      case "entrada":
        return (
          `¿Registrar la ENTRADA de ${form.quantity} unidades de ${sku(form.product_id)} ` +
          `en ${codigo(form.warehouse_id)} por ${form.amount} ${form.currency}?\n\n` +
          `El costo promedio del producto en ese almacén se recalculará. ` +
          `El movimiento NO se puede editar ni borrar después.`
        );
      case "salida":
        return (
          `¿Registrar la SALIDA de ${form.quantity} unidades de ${sku(form.product_id)} ` +
          `de ${codigo(form.warehouse_id)}?\n\n` +
          `Se valorará al costo promedio vigente, que calcula el servidor. ` +
          `El movimiento NO se puede editar ni borrar después.`
        );
      case "ajuste":
        return (
          `¿Registrar un AJUSTE de ${form.quantity} unidades de ${sku(form.product_id)} ` +
          `en ${codigo(form.warehouse_id)}?\n\nMotivo: ${form.reason}\n\n` +
          `Queda en la auditoría con tu nombre. NO se puede editar ni borrar después.`
        );
      case "transferencia":
        return (
          `¿TRANSFERIR ${form.quantity} unidades de ${sku(form.product_id)} ` +
          `de ${codigo(form.warehouse_id)} a ${codigo(form.to_warehouse_id)}?\n\n` +
          `Sale y entra en el mismo instante, al costo de origen: no hay estado ` +
          `«en tránsito». NO se puede editar ni borrar después.`
        );
    }
  }

  async function enviar() {
    if (!window.confirm(resumen())) return;
    setError("");
    setEnviando(true);
    const comun = {
      company_id: companyId,
      product_id: form.product_id,
      ...(form.reference.trim() !== "" ? { reference: form.reference.trim() } : {}),
    };
    try {
      if (operacion === "entrada") {
        await api(session, "/v1/inventory/receipts", {
          method: "POST",
          companyId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            quantity: form.quantity,
            amount: form.amount,
            currency: form.currency,
            ...(form.currency !== "VES"
              ? {
                  fx: {
                    rate: form.fx_rate,
                    source: form.fx_source,
                    at: new Date().toISOString(),
                  },
                }
              : {}),
          }),
        });
      } else if (operacion === "salida") {
        await api(session, "/v1/inventory/issues", {
          method: "POST",
          companyId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            quantity: form.quantity,
          }),
        });
      } else if (operacion === "ajuste") {
        await api(session, "/v1/inventory/adjustments", {
          method: "POST",
          companyId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            warehouse_id: form.warehouse_id,
            delta: form.quantity,
            reason: form.reason.trim(),
          }),
        });
      } else {
        await api(session, "/v1/inventory/transfers", {
          method: "POST",
          companyId,
          headers: { "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            ...comun,
            from_warehouse_id: form.warehouse_id,
            to_warehouse_id: form.to_warehouse_id,
            quantity: form.quantity,
          }),
        });
      }
      onHecho(`Movimiento registrado: ${operacion} de ${form.quantity} · ${sku(form.product_id)}`);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setEnviando(false);
    }
  }

  return (
    <fieldset>
      <legend>
        {operacion === "entrada"
          ? "Entrada de existencias"
          : operacion === "salida"
            ? "Salida de existencias"
            : operacion === "ajuste"
              ? "Ajuste de existencias"
              : "Transferencia entre almacenes"}
      </legend>
      {error && <p role="alert">{error}</p>}
      <p>
        <select
          value={form.product_id}
          onChange={(e) => cambiar("product_id", e.target.value)}
          aria-label="producto"
        >
          <option value="">— producto —</option>
          {productos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} · {p.name}
            </option>
          ))}
        </select>{" "}
        <select
          value={form.warehouse_id}
          onChange={(e) => cambiar("warehouse_id", e.target.value)}
          aria-label={operacion === "transferencia" ? "almacén de origen" : "almacén"}
        >
          <option value="">— {operacion === "transferencia" ? "origen" : "almacén"} —</option>
          {almacenes.map((w) => (
            <option key={w.id} value={w.id}>
              {w.code} · {w.name}
            </option>
          ))}
        </select>{" "}
        {operacion === "transferencia" && (
          <select
            value={form.to_warehouse_id}
            onChange={(e) => cambiar("to_warehouse_id", e.target.value)}
            aria-label="almacén de destino"
          >
            <option value="">— destino —</option>
            {almacenes
              .filter((w) => w.id !== form.warehouse_id)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.code} · {w.name}
                </option>
              ))}
          </select>
        )}
      </p>
      <p>
        <input
          placeholder={operacion === "ajuste" ? "delta con signo (ej. -3)" : "cantidad"}
          value={form.quantity}
          onChange={(e) => cambiar("quantity", e.target.value)}
          aria-label="cantidad"
        />{" "}
        {operacion === "entrada" && (
          <>
            <input
              placeholder="costo TOTAL de la recepción"
              value={form.amount}
              onChange={(e) => cambiar("amount", e.target.value)}
              aria-label="importe"
            />{" "}
            <select value={form.currency} onChange={(e) => cambiar("currency", e.target.value)}>
              <option value="VES">VES</option>
              <option value="USD">USD</option>
            </select>{" "}
            {form.currency !== "VES" && (
              <>
                <input
                  placeholder="tasa a VES"
                  value={form.fx_rate}
                  onChange={(e) => cambiar("fx_rate", e.target.value)}
                  aria-label="tasa"
                />{" "}
                <input
                  placeholder="fuente de la tasa (ej. BCV)"
                  value={form.fx_source}
                  onChange={(e) => cambiar("fx_source", e.target.value)}
                  aria-label="fuente de la tasa"
                />
              </>
            )}
          </>
        )}
        {operacion === "ajuste" && (
          <input
            placeholder="motivo (obligatorio)"
            value={form.reason}
            onChange={(e) => cambiar("reason", e.target.value)}
            aria-label="motivo"
            size={40}
          />
        )}{" "}
        <input
          placeholder="referencia (opcional)"
          value={form.reference}
          onChange={(e) => cambiar("reference", e.target.value)}
          aria-label="referencia"
        />
      </p>
      <p>
        <button disabled={!listo || enviando} onClick={() => void enviar()}>
          {enviando ? "registrando…" : "Registrar movimiento"}
        </button>
      </p>
      <small>
        {operacion === "entrada"
          ? "El importe es el costo TOTAL de lo recibido, no el unitario. En moneda distinta al bolívar hace falta la tasa y su fuente: sin fuente no se guarda."
          : operacion === "salida"
            ? "El costo lo pone el promedio ponderado del servidor. Si la salida dejara la existencia en negativo, se rechaza salvo que la empresa lo permita y tengas el permiso."
            : operacion === "ajuste"
              ? "Un ajuste sin motivo no es un ajuste. El motivo queda en la auditoría."
              : "Salida y entrada ocurren en el mismo instante y al costo de origen. Necesitas permiso sobre los dos almacenes."}
      </small>
    </fieldset>
  );
}
