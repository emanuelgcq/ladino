import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import {
  api,
  LlamadaApiError,
  type Product,
  type PriceList,
  type PriceItem,
  type Unit,
  type TaxCategory,
} from "./lib.js";
import { mostrarImporte } from "./money.js";

/**
 * Productos: listado con búsqueda y paginación EN SERVIDOR, alta/edición, y
 * detalle con el precio vigente. Usable sin pretensión de diseño: estados de
 * carga, errores con el MENSAJE del dominio (nunca «algo salió mal»), y
 * confirmación en lo que cambia datos. Los importes llegan {amount, currency}
 * y solo se FORMATEAN (money.ts): cero aritmética en el cliente.
 */
const POR_PAGINA = 10;

function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

interface Props {
  session: Session;
  companyId: string;
}

export function ProductsView({ session, companyId }: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<{ items: Product[]; total: number } | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [detalle, setDetalle] = useState<Product | null>(null);
  const [editando, setEditando] = useState<Product | null>(null);
  const [creando, setCreando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const q = new URLSearchParams({ page: String(pagina), per_page: String(POR_PAGINA) });
      if (busqueda.trim() !== "") q.set("search", busqueda.trim());
      setDatos(
        await api<{ items: Product[]; total: number }>(session, `/v1/products?${q}`, { companyId }),
      );
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setCargando(false);
    }
  }, [session, companyId, busqueda, pagina]);

  useEffect(() => {
    void cargar();
  }, [cargar]);

  const paginas = datos ? Math.max(1, Math.ceil(datos.total / POR_PAGINA)) : 1;

  return (
    <section>
      <h2>Productos</h2>
      <p>
        <input
          placeholder="buscar por SKU o nombre"
          value={busqueda}
          onChange={(e) => {
            setPagina(1);
            setBusqueda(e.target.value);
          }}
        />{" "}
        <button onClick={() => setCreando(true)}>+ Nuevo producto</button>
      </p>
      {error && <p role="alert">{error}</p>}
      {cargando ? (
        <p>cargando…</p>
      ) : datos === null ? null : datos.items.length === 0 ? (
        <p>Sin productos{busqueda ? " para esa búsqueda" : ""}.</p>
      ) : (
        <>
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>SKU</th>
                <th>Nombre</th>
                <th>Tipo</th>
                <th>Estado</th>
                <th>Clasif. fiscal</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {datos.items.map((p) => (
                <tr key={p.id}>
                  <td>{p.sku}</td>
                  <td>{p.name}</td>
                  <td>{p.kind === "good" ? "bien" : "servicio"}</td>
                  <td>{p.status}</td>
                  <td>{p.tax_category_code}</td>
                  <td>
                    <button onClick={() => setDetalle(p)}>detalle</button>{" "}
                    <button onClick={() => setEditando(p)}>editar</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p>
            página {pagina} de {paginas} ({datos.total} en total){" "}
            <button disabled={pagina <= 1} onClick={() => setPagina(pagina - 1)}>
              ←
            </button>{" "}
            <button disabled={pagina >= paginas} onClick={() => setPagina(pagina + 1)}>
              →
            </button>
          </p>
        </>
      )}

      {creando && (
        <FormularioProducto
          session={session}
          companyId={companyId}
          alCerrar={(recargar) => {
            setCreando(false);
            if (recargar) void cargar();
          }}
        />
      )}
      {editando && (
        <FormularioEdicion
          session={session}
          companyId={companyId}
          producto={editando}
          alCerrar={(recargar) => {
            setEditando(null);
            if (recargar) void cargar();
          }}
        />
      )}
      {detalle && (
        <DetalleProducto
          session={session}
          companyId={companyId}
          producto={detalle}
          alCerrar={() => setDetalle(null)}
        />
      )}
    </section>
  );
}

function FormularioProducto({
  session,
  companyId,
  alCerrar,
}: Props & { alCerrar: (recargar: boolean) => void }) {
  const [unidades, setUnidades] = useState<Unit[]>([]);
  const [clasifs, setClasifs] = useState<TaxCategory[]>([]);
  const [form, setForm] = useState({
    sku: "",
    name: "",
    kind: "good" as "good" | "service",
    unit_code: "unidad",
    tax_category_code: "gravado_general",
    barcode: "",
  });
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    void api<Unit[]>(session, "/v1/units")
      .then(setUnidades)
      .catch((e: unknown) => setError(mensajeDe(e)));
    void api<TaxCategory[]>(session, "/v1/tax-categories")
      .then(setClasifs)
      .catch((e: unknown) => setError(mensajeDe(e)));
  }, [session]);

  async function guardar() {
    if (!window.confirm(`¿Crear el producto ${form.sku}?`)) return;
    setGuardando(true);
    setError("");
    try {
      await api(session, "/v1/products", {
        method: "POST",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          sku: form.sku,
          name: form.name,
          kind: form.kind,
          unit_code: form.unit_code,
          tax_category_code: form.tax_category_code,
          ...(form.barcode.trim() !== "" ? { barcode: form.barcode.trim() } : {}),
        }),
      });
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <fieldset>
      <legend>Nuevo producto</legend>
      <p>
        <input
          placeholder="SKU"
          value={form.sku}
          onChange={(e) => setForm({ ...form, sku: e.target.value })}
        />{" "}
        <input
          placeholder="nombre"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
        />
      </p>
      <p>
        <select
          value={form.kind}
          onChange={(e) => setForm({ ...form, kind: e.target.value as "good" | "service" })}
        >
          <option value="good">bien</option>
          <option value="service">servicio</option>
        </select>{" "}
        <select
          value={form.unit_code}
          onChange={(e) => setForm({ ...form, unit_code: e.target.value })}
        >
          {unidades.map((u) => (
            <option key={u.code} value={u.code}>
              {u.name}
            </option>
          ))}
        </select>{" "}
        <select
          value={form.tax_category_code}
          onChange={(e) => setForm({ ...form, tax_category_code: e.target.value })}
        >
          {clasifs.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>{" "}
        <input
          placeholder="código de barras (opcional)"
          value={form.barcode}
          onChange={(e) => setForm({ ...form, barcode: e.target.value })}
        />
      </p>
      <p>
        <button disabled={guardando} onClick={() => void guardar()}>
          {guardando ? "guardando…" : "Crear"}
        </button>{" "}
        <button onClick={() => alCerrar(false)}>Cancelar</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <small>El tipo (bien/servicio) no podrá cambiarse una vez activado el producto.</small>
    </fieldset>
  );
}

function FormularioEdicion({
  session,
  companyId,
  producto,
  alCerrar,
}: Props & { producto: Product; alCerrar: (recargar: boolean) => void }) {
  const [form, setForm] = useState({
    name: producto.name,
    status: producto.status,
    barcode: producto.barcode ?? "",
  });
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  async function guardar() {
    if (!window.confirm(`¿Guardar los cambios de ${producto.sku}?`)) return;
    setGuardando(true);
    setError("");
    try {
      await api(session, `/v1/products/${producto.id}`, {
        method: "PATCH",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          name: form.name,
          status: form.status,
          barcode: form.barcode.trim() === "" ? null : form.barcode.trim(),
        }),
      });
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setGuardando(false);
    }
  }

  return (
    <fieldset>
      <legend>Editar {producto.sku}</legend>
      <p>
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />{" "}
        <select
          value={form.status}
          onChange={(e) => setForm({ ...form, status: e.target.value as Product["status"] })}
        >
          <option value="draft">draft</option>
          <option value="active">active</option>
          <option value="inactive">inactive</option>
        </select>{" "}
        <input
          placeholder="código de barras"
          value={form.barcode}
          onChange={(e) => setForm({ ...form, barcode: e.target.value })}
        />
      </p>
      <p>
        <button disabled={guardando} onClick={() => void guardar()}>
          Guardar
        </button>{" "}
        <button onClick={() => alCerrar(false)}>Cancelar</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <small>La clasificación tributaria se cambia aparte (permiso propio del contador).</small>
    </fieldset>
  );
}

function DetalleProducto({
  session,
  companyId,
  producto,
  alCerrar,
}: Props & { producto: Product; alCerrar: () => void }) {
  const [listas, setListas] = useState<PriceList[]>([]);
  const [precios, setPrecios] = useState<
    {
      lista: PriceList;
      vigente: { amount: string; currency: string } | null;
      historial: PriceItem[];
    }[]
  >([]);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const ls = await api<PriceList[]>(session, "/v1/price-lists", { companyId });
        setListas(ls);
        // La fecha del «vigente» es EXPLÍCITA (ADR-0032): la elige el cliente
        // como parámetro — aquí, hoy. Un documento con otra fecha pedirá otra.
        const hoy = new Date().toISOString();
        const porLista = await Promise.all(
          ls.map(async (lista) => {
            const r = await api<{
              items: PriceItem[];
              vigente: { amount: string; currency: string } | null;
            }>(
              session,
              `/v1/price-lists/${lista.id}/prices?product_id=${producto.id}&at=${encodeURIComponent(hoy)}`,
              { companyId },
            );
            return { lista, vigente: r.vigente, historial: r.items };
          }),
        );
        setPrecios(porLista);
      } catch (e) {
        setError(mensajeDe(e));
      } finally {
        setCargando(false);
      }
    })();
  }, [session, companyId, producto.id]);

  return (
    <fieldset>
      <legend>
        {producto.sku} — {producto.name} <button onClick={alCerrar}>cerrar</button>
      </legend>
      <p>
        {producto.kind === "good" ? "Bien" : "Servicio"} · unidad: {producto.unit_code} · estado:{" "}
        {producto.status} · clasif. fiscal: {producto.tax_category_code}
        {producto.barcode ? ` · barcode: ${producto.barcode}` : ""}
      </p>
      {error && <p role="alert">{error}</p>}
      {cargando ? (
        <p>cargando precios…</p>
      ) : listas.length === 0 ? (
        <p>La empresa no tiene listas de precios todavía.</p>
      ) : (
        precios.map(({ lista, vigente, historial }) => (
          <p key={lista.id}>
            <strong>{lista.name}</strong> ({lista.currency_code}): vigente hoy ={" "}
            {vigente ? mostrarImporte(vigente) : "sin precio"} · {historial.length} vigencia(s) en
            el historial
          </p>
        ))
      )}
    </fieldset>
  );
}
