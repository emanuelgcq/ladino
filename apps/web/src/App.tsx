import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, supabase, LlamadaApiError, type Company } from "./lib.js";
import { ProductsView } from "./ProductsView.js";
import { PricingView } from "./PricingView.js";
import { CustomersView } from "./CustomersView.js";

/**
 * La webapp de Ladino, aún sin pretensión de diseño: sesión (supabase-js SOLO
 * para auth), selector de empresa (GET /v1/companies), y los módulos del
 * catálogo de productos sobre esa selección. Todos los datos van por la API
 * con Bearer + X-Company-Id; los errores se muestran con el MENSAJE del
 * dominio. Router y TanStack Query llegan con las pantallas definitivas.
 */
function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [empresa, setEmpresa] = useState<Company | null>(null);
  const [modulo, setModulo] = useState<"productos" | "precios" | "clientes">("productos");
  const [error, setError] = useState("");
  const [alta, setAlta] = useState({ tenant_id: "", legal_name: "", tax_id: "" });

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setCompanies(null);
      setEmpresa(null);
      return;
    }
    api<Company[]>(session, "/v1/companies")
      .then(setCompanies)
      .catch((e: unknown) => setError(mensajeDe(e)));
  }, [session]);

  async function entrar(modo: "login" | "signup") {
    setError("");
    const r =
      modo === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (r.error) setError(r.error.message);
  }

  async function crearEmpresa() {
    if (!session) return;
    if (!window.confirm(`¿Crear la empresa ${alta.legal_name} (${alta.tax_id})?`)) return;
    setError("");
    try {
      await api(session, "/v1/companies", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(alta),
      });
      setCompanies(await api<Company[]>(session, "/v1/companies"));
    } catch (e) {
      setError(mensajeDe(e));
    }
  }

  if (!session) {
    return (
      <main>
        <h1>Ladino</h1>
        <p>Sesión contra Supabase Auth (local o remoto según VITE_SUPABASE_URL).</p>
        <input placeholder="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input
          placeholder="contraseña"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button onClick={() => void entrar("login")}>Entrar</button>
        <button onClick={() => void entrar("signup")}>Crear cuenta</button>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  }

  return (
    <main>
      <h1>Ladino</h1>
      <p>
        {session.user.email}
        {empresa && (
          <>
            {" · "}
            <strong>{empresa.legal_name}</strong>{" "}
            <button onClick={() => setEmpresa(null)}>cambiar empresa</button>
          </>
        )}
        {" · "}
        <button onClick={() => void supabase.auth.signOut()}>Salir</button>
      </p>
      {error && <p role="alert">{error}</p>}

      {!empresa ? (
        <>
          <h2>Elige empresa</h2>
          {companies === null ? (
            <p>cargando…</p>
          ) : companies.length === 0 ? (
            <p>
              No tienes empresas visibles. Crea la primera (necesitas el tenant y company.manage).
            </p>
          ) : (
            <ul>
              {companies.map((co) => (
                <li key={co.id}>
                  <button onClick={() => setEmpresa(co)}>{co.legal_name}</button> — {co.tax_id} ·{" "}
                  {co.status}
                </li>
              ))}
            </ul>
          )}
          <fieldset>
            <legend>Crear empresa</legend>
            <input
              placeholder="tenant_id (uuid)"
              value={alta.tenant_id}
              onChange={(e) => setAlta({ ...alta, tenant_id: e.target.value })}
            />{" "}
            <input
              placeholder="razón social"
              value={alta.legal_name}
              onChange={(e) => setAlta({ ...alta, legal_name: e.target.value })}
            />{" "}
            <input
              placeholder="RIF"
              value={alta.tax_id}
              onChange={(e) => setAlta({ ...alta, tax_id: e.target.value })}
            />{" "}
            <button onClick={() => void crearEmpresa()}>Crear</button>
          </fieldset>
        </>
      ) : (
        <>
          <nav>
            <button disabled={modulo === "productos"} onClick={() => setModulo("productos")}>
              Productos
            </button>{" "}
            <button disabled={modulo === "precios"} onClick={() => setModulo("precios")}>
              Listas de precios
            </button>{" "}
            <button disabled={modulo === "clientes"} onClick={() => setModulo("clientes")}>
              Clientes
            </button>
          </nav>
          {modulo === "productos" ? (
            <ProductsView session={session} companyId={empresa.id} />
          ) : modulo === "precios" ? (
            <PricingView session={session} companyId={empresa.id} />
          ) : (
            <CustomersView session={session} companyId={empresa.id} />
          )}
        </>
      )}
    </main>
  );
}
