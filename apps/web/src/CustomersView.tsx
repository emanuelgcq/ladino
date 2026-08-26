import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, LlamadaApiError, type Customer, type CodeCatalog, type PriceList } from "./lib.js";

/**
 * Clientes: listado con búsqueda (RIF o razón social) y paginación en servidor,
 * alta/edición, detalle, cambio de RIF (endpoint y permiso propios: el error
 * de permiso se muestra tal cual llega del dominio) y bloqueo/desbloqueo.
 * Confirmación en todo lo que cambia datos. Sin diseño.
 */
const POR_PAGINA = 10;
const mensajeDe = (e: unknown) =>
  e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);

interface Props {
  session: Session;
  companyId: string;
}

export function CustomersView({ session, companyId }: Props) {
  const [busqueda, setBusqueda] = useState("");
  const [pagina, setPagina] = useState(1);
  const [datos, setDatos] = useState<{ items: Customer[]; total: number } | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState("");
  const [detalle, setDetalle] = useState<Customer | null>(null);
  const [editando, setEditando] = useState<Customer | null>(null);
  const [creando, setCreando] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError("");
    try {
      const q = new URLSearchParams({ page: String(pagina), per_page: String(POR_PAGINA) });
      if (busqueda.trim() !== "") q.set("search", busqueda.trim());
      setDatos(
        await api<{ items: Customer[]; total: number }>(session, `/v1/customers?${q}`, {
          companyId,
        }),
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
  const cerrar = (recargar: boolean) => {
    setCreando(false);
    setEditando(null);
    setDetalle(null);
    if (recargar) void cargar();
  };

  return (
    <section>
      <h2>Clientes</h2>
      <p>
        <input
          placeholder="buscar por RIF o razón social"
          value={busqueda}
          onChange={(e) => {
            setPagina(1);
            setBusqueda(e.target.value);
          }}
        />{" "}
        <button onClick={() => setCreando(true)}>+ Nuevo cliente</button>
      </p>
      {error && <p role="alert">{error}</p>}
      {cargando ? (
        <p>cargando…</p>
      ) : datos === null ? null : datos.items.length === 0 ? (
        <p>Sin clientes{busqueda ? " para esa búsqueda" : ""}.</p>
      ) : (
        <>
          <table border={1} cellPadding={4}>
            <thead>
              <tr>
                <th>RIF</th>
                <th>Razón social</th>
                <th>Persona</th>
                <th>Clasif. fiscal</th>
                <th>Estado</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {datos.items.map((cl) => (
                <tr key={cl.id}>
                  <td>{cl.tax_id ?? "—"}</td>
                  <td>{cl.legal_name}</td>
                  <td>{cl.person_type_code}</td>
                  <td>{cl.taxpayer_type_code}</td>
                  <td>{cl.status}</td>
                  <td>
                    <button onClick={() => setDetalle(cl)}>detalle</button>{" "}
                    <button onClick={() => setEditando(cl)}>editar</button>
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
      {creando && <FormularioCliente session={session} companyId={companyId} alCerrar={cerrar} />}
      {editando && (
        <FormularioEdicion
          session={session}
          companyId={companyId}
          cliente={editando}
          alCerrar={cerrar}
        />
      )}
      {detalle && (
        <DetalleCliente
          session={session}
          companyId={companyId}
          cliente={detalle}
          alCerrar={cerrar}
        />
      )}
    </section>
  );
}

function FormularioCliente({
  session,
  companyId,
  alCerrar,
}: Props & { alCerrar: (recargar: boolean) => void }) {
  const [personas, setPersonas] = useState<CodeCatalog[]>([]);
  const [fiscales, setFiscales] = useState<CodeCatalog[]>([]);
  const [listas, setListas] = useState<PriceList[]>([]);
  const [form, setForm] = useState({
    tax_id: "",
    legal_name: "",
    person_type_code: "juridica",
    taxpayer_type_code: "ordinario",
    fiscal_address: "",
    email: "",
    phone: "",
    default_price_list_id: "",
  });
  const [error, setError] = useState("");
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    void api<CodeCatalog[]>(session, "/v1/person-types")
      .then(setPersonas)
      .catch((e: unknown) => setError(mensajeDe(e)));
    void api<CodeCatalog[]>(session, "/v1/taxpayer-types")
      .then(setFiscales)
      .catch((e: unknown) => setError(mensajeDe(e)));
    void api<PriceList[]>(session, "/v1/price-lists", { companyId })
      .then(setListas)
      .catch(() => setListas([]));
  }, [session, companyId]);

  async function guardar() {
    if (
      !window.confirm(
        `¿Crear el cliente ${form.legal_name}${form.tax_id ? ` (${form.tax_id})` : " (sin RIF)"}?`,
      )
    )
      return;
    setGuardando(true);
    setError("");
    try {
      const opcional = (v: string) => (v.trim() === "" ? undefined : v.trim());
      await api(session, "/v1/customers", {
        method: "POST",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          tax_id: form.tax_id.trim() === "" ? null : form.tax_id.trim(),
          legal_name: form.legal_name,
          person_type_code: form.person_type_code,
          taxpayer_type_code: form.taxpayer_type_code,
          fiscal_address: opcional(form.fiscal_address),
          email: opcional(form.email),
          phone: opcional(form.phone),
          default_price_list_id: opcional(form.default_price_list_id),
        }),
      });
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    } finally {
      setGuardando(false);
    }
  }

  const campo = (k: keyof typeof form, placeholder: string) => (
    <input
      placeholder={placeholder}
      value={form[k]}
      onChange={(e) => setForm({ ...form, [k]: e.target.value })}
    />
  );

  return (
    <fieldset>
      <legend>Nuevo cliente</legend>
      <p>
        {campo("tax_id", "RIF (vacío solo para persona natural)")}{" "}
        {campo("legal_name", "razón social / nombre")}
      </p>
      <p>
        <select
          value={form.person_type_code}
          onChange={(e) => setForm({ ...form, person_type_code: e.target.value })}
        >
          {personas.map((p) => (
            <option key={p.code} value={p.code}>
              {p.name}
            </option>
          ))}
        </select>{" "}
        <select
          value={form.taxpayer_type_code}
          onChange={(e) => setForm({ ...form, taxpayer_type_code: e.target.value })}
        >
          {fiscales.map((t) => (
            <option key={t.code} value={t.code}>
              {t.name}
            </option>
          ))}
        </select>{" "}
        <select
          value={form.default_price_list_id}
          onChange={(e) => setForm({ ...form, default_price_list_id: e.target.value })}
        >
          <option value="">— lista de precios preferida —</option>
          {listas.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name} ({l.currency_code})
            </option>
          ))}
        </select>
      </p>
      <p>
        {campo("fiscal_address", "dirección fiscal")} {campo("email", "email")}{" "}
        {campo("phone", "teléfono")}
      </p>
      <p>
        <button
          disabled={guardando || form.legal_name.trim() === ""}
          onClick={() => void guardar()}
        >
          {guardando ? "guardando…" : "Crear"}
        </button>{" "}
        <button onClick={() => alCerrar(false)}>Cancelar</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <small>
        La clasificación fiscal es provisional (VALIDAR-TRIBUTARIO): hoy no tiene consecuencia.
      </small>
    </fieldset>
  );
}

function FormularioEdicion({
  session,
  companyId,
  cliente,
  alCerrar,
}: Props & { cliente: Customer; alCerrar: (recargar: boolean) => void }) {
  const [form, setForm] = useState({
    legal_name: cliente.legal_name,
    trade_name: cliente.trade_name ?? "",
    fiscal_address: cliente.fiscal_address ?? "",
    email: cliente.email ?? "",
    phone: cliente.phone ?? "",
    status: cliente.status,
  });
  const [error, setError] = useState("");

  async function guardar() {
    if (!window.confirm(`¿Guardar los cambios de ${cliente.legal_name}?`)) return;
    setError("");
    const oNull = (v: string) => (v.trim() === "" ? null : v.trim());
    try {
      await api(session, `/v1/customers/${cliente.id}`, {
        method: "PATCH",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          legal_name: form.legal_name,
          trade_name: oNull(form.trade_name),
          fiscal_address: oNull(form.fiscal_address),
          email: oNull(form.email),
          phone: oNull(form.phone),
          ...(cliente.status !== "blocked" && form.status !== "blocked"
            ? { status: form.status }
            : {}),
        }),
      });
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  return (
    <fieldset>
      <legend>Editar {cliente.legal_name}</legend>
      <p>
        <input
          value={form.legal_name}
          onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
        />{" "}
        <input
          placeholder="nombre comercial"
          value={form.trade_name}
          onChange={(e) => setForm({ ...form, trade_name: e.target.value })}
        />{" "}
        <select
          value={form.status}
          disabled={cliente.status === "blocked"}
          onChange={(e) => setForm({ ...form, status: e.target.value as Customer["status"] })}
        >
          <option value="lead">lead</option>
          <option value="active">active</option>
          <option value="inactive">inactive</option>
          {cliente.status === "blocked" && <option value="blocked">blocked</option>}
        </select>
      </p>
      <p>
        <input
          placeholder="dirección fiscal"
          value={form.fiscal_address}
          onChange={(e) => setForm({ ...form, fiscal_address: e.target.value })}
        />{" "}
        <input
          placeholder="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />{" "}
        <input
          placeholder="teléfono"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </p>
      <p>
        <button onClick={() => void guardar()}>Guardar</button>{" "}
        <button onClick={() => alCerrar(false)}>Cancelar</button>
      </p>
      {error && <p role="alert">{error}</p>}
      <small>El RIF y el bloqueo se cambian desde el detalle: tienen permisos propios.</small>
    </fieldset>
  );
}

function DetalleCliente({
  session,
  companyId,
  cliente,
  alCerrar,
}: Props & { cliente: Customer; alCerrar: (recargar: boolean) => void }) {
  const [rif, setRif] = useState(cliente.tax_id ?? "");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState("");
  const [aviso, setAviso] = useState("");

  async function cambiarRif() {
    const nuevo = rif.trim() === "" ? null : rif.trim();
    if (
      !window.confirm(
        `¿Cambiar el RIF de ${cliente.legal_name} de «${cliente.tax_id ?? "—"}» a «${nuevo ?? "—"}»?\nQuedará auditado con el valor anterior.`,
      )
    )
      return;
    setError("");
    try {
      await api(session, `/v1/customers/${cliente.id}/tax-id`, {
        method: "PUT",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ company_id: companyId, tax_id: nuevo }),
      });
      setAviso("RIF cambiado y auditado.");
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  async function bloquear(blocked: boolean) {
    if (!window.confirm(`¿${blocked ? "Bloquear" : "Desbloquear"} a ${cliente.legal_name}?`))
      return;
    setError("");
    try {
      await api(session, `/v1/customers/${cliente.id}/blocked`, {
        method: "PUT",
        companyId,
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          company_id: companyId,
          blocked,
          ...(motivo.trim() ? { reason: motivo.trim() } : {}),
        }),
      });
      alCerrar(true);
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  return (
    <fieldset>
      <legend>
        {cliente.legal_name} <button onClick={() => alCerrar(false)}>cerrar</button>
      </legend>
      <p>
        RIF: {cliente.tax_id ?? "—"} · {cliente.person_type_code} · {cliente.taxpayer_type_code} ·
        estado: {cliente.status}
        {cliente.fiscal_address ? ` · ${cliente.fiscal_address}` : ""}
        {cliente.email ? ` · ${cliente.email}` : ""}
        {cliente.phone ? ` · ${cliente.phone}` : ""}
      </p>
      <p>
        <input
          placeholder="nuevo RIF (vacío = sin RIF, solo persona natural)"
          value={rif}
          onChange={(e) => setRif(e.target.value)}
        />{" "}
        <button onClick={() => void cambiarRif()}>Cambiar RIF (permiso propio)</button>
      </p>
      <p>
        <input
          placeholder="motivo (opcional)"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
        />{" "}
        {cliente.status === "blocked" ? (
          <button onClick={() => void bloquear(false)}>Desbloquear (cobranzas)</button>
        ) : (
          <button onClick={() => void bloquear(true)}>Bloquear (cobranzas)</button>
        )}
      </p>
      {aviso && <p>{aviso}</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
