import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, LlamadaApiError, type PriceList, type PriceItem, type Product } from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Listas de precios: gestión de listas y carga de precios por vigencia.
 * El importe se ESCRIBE como string decimal y viaja como string: el cliente
 * jamás lo convierte a number ni calcula nada con él. Un precio no se edita:
 * cargar uno nuevo cierra el anterior (el esquema lo garantiza), y así se
 * cuenta en la propia pantalla.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

const AMOUNT_RE = /^\d{1,16}(\.\d{1,8})?$/;

interface Props {
  session: Session;
  companyId: string;
}

export function PricingView({ session, companyId }: Props) {
  const [listas, setListas] = useState<PriceList[] | null>(null);
  const [seleccionada, setSeleccionada] = useState<PriceList | null>(null);
  const [error, setError] = useState("");
  const [nombre, setNombre] = useState("");
  const [moneda, setMoneda] = useState("VES");

  const cargar = useCallback(async () => {
    setError("");
    try {
      setListas(await api<PriceList[]>(session, "/v1/price-lists", { companyId }));
    } catch (e) {
      setError(mensajeDe(e));
    }
  }, [session, companyId]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  async function crearLista() {
    if (!window.confirm(`¿Crear la lista «${nombre}» en ${moneda}?`)) return;
    setError("");
    try {
      await api(session, "/v1/price-lists", {
        method: "POST",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: companyId, name: nombre, currency_code: moneda }),
      });
      setNombre("");
      await cargar();
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  return (
    <section>
      <h2>Listas de precios</h2>
      {error && <p role="alert">{error}</p>}
      {listas === null ? (
        <p>cargando…</p>
      ) : (
        <ul>
          {listas.map((l) => (
            <li key={l.id}>
              <button onClick={() => setSeleccionada(l)}>
                {seleccionada?.id === l.id ? "▶ " : ""}
                {l.name}
              </button>{" "}
              — {l.currency_code} · {l.status}
            </li>
          ))}
        </ul>
      )}
      <p>
        <input
          placeholder="nombre de la lista"
          value={nombre}
          onChange={(e) => setNombre(e.target.value)}
        />{" "}
        <select value={moneda} onChange={(e) => setMoneda(e.target.value)}>
          <option value="VES">VES</option>
          <option value="USD">USD</option>
        </select>{" "}
        <button disabled={nombre.trim() === ""} onClick={() => void crearLista()}>
          + Crear lista
        </button>
      </p>
      {seleccionada && (
        <PreciosDeLista session={session} companyId={companyId} lista={seleccionada} />
      )}
    </section>
  );
}

function PreciosDeLista({ session, companyId, lista }: Props & { lista: PriceList }) {
  const [items, setItems] = useState<PriceItem[] | null>(null);
  const [productos, setProductos] = useState<Product[]>([]);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ product_id: "", amount: "", effective_from: "" });

  const cargar = useCallback(async () => {
    setError("");
    try {
      const r = await api<{ items: PriceItem[] }>(session, `/v1/price-lists/${lista.id}/prices`, {
        companyId,
      });
      setItems(r.items);
      const pagina = await api<{ items: Product[] }>(session, "/v1/products?per_page=100", {
        companyId,
      });
      setProductos(pagina.items);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }, [session, companyId, lista.id]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const skuDe = (id: string) => productos.find((p) => p.id === id)?.sku ?? id.slice(0, 8);

  async function cargarPrecio() {
    if (!AMOUNT_RE.test(form.amount)) {
      setError(
        "El importe debe ser un decimal con hasta 16 enteros y 8 decimales (punto como separador).",
      );
      return;
    }
    const desde =
      form.effective_from === ""
        ? new Date().toISOString()
        : new Date(form.effective_from).toISOString();
    if (
      !window.confirm(
        `¿Cargar ${form.amount} ${lista.currency_code} para ${skuDe(form.product_id)} desde ${desde}?\n` +
          `Si hay un precio abierto anterior, su vigencia se cierra en ese instante.`,
      )
    )
      return;
    setError("");
    try {
      await api(session, `/v1/price-lists/${lista.id}/prices`, {
        method: "POST",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          product_id: form.product_id,
          amount: form.amount,
          effective_from: desde,
        }),
      });
      setForm({ product_id: form.product_id, amount: "", effective_from: "" });
      await cargar();
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  return (
    <fieldset>
      <legend>
        Precios de {lista.name} ({lista.currency_code})
      </legend>
      {error && <p role="alert">{error}</p>}
      {items === null ? (
        <p>cargando…</p>
      ) : items.length === 0 ? (
        <p>Sin precios cargados.</p>
      ) : (
        <table border={1} cellPadding={4}>
          <thead>
            <tr>
              <th>Producto</th>
              <th>Importe</th>
              <th>Desde</th>
              <th>Hasta</th>
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={i.id}>
                <td>{skuDe(i.product_id)}</td>
                <td>{mostrarImporte({ amount: i.amount, currency: i.currency })}</td>
                <td>{i.effective_from}</td>
                <td>{i.effective_to ?? "(vigente)"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p>
        <select
          value={form.product_id}
          onChange={(e) => setForm({ ...form, product_id: e.target.value })}
        >
          <option value="">— producto —</option>
          {productos.map((p) => (
            <option key={p.id} value={p.id}>
              {p.sku} · {p.name}
            </option>
          ))}
        </select>{" "}
        <input
          placeholder={`importe en ${lista.currency_code} (ej. 199.99)`}
          value={form.amount}
          onChange={(e) => setForm({ ...form, amount: e.target.value })}
        />{" "}
        <input
          type="datetime-local"
          value={form.effective_from}
          onChange={(e) => setForm({ ...form, effective_from: e.target.value })}
        />{" "}
        <button
          disabled={form.product_id === "" || form.amount === ""}
          onClick={() => void cargarPrecio()}
        >
          Cargar precio
        </button>
      </p>
      <small>
        Un precio no se edita ni se borra: corregir es cargar una vigencia nueva (el anterior se
        cierra solo). El historial de arriba es la prueba.
      </small>
    </fieldset>
  );
}
