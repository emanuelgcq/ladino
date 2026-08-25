import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api, supabase, LlamadaApiError } from "./lib.js";

/**
 * LA VERTICAL DELGADA. Login → empresas del usuario (GET /v1/companies) →
 * seleccionar una (X-Company-Id validado por el middleware de scope) → crear
 * empresa (POST con Idempotency-Key). Una pantalla, sin pretensiones de
 * diseño: existe para ejercer la cadena Supabase → API → navegador de extremo
 * a extremo y descubrir los problemas de contrato ANTES de las veinte
 * pantallas — token, CORS, cuerpos de error, headers propios.
 */

interface Company {
  id: string;
  tenant_id: string;
  legal_name: string;
  trade_name: string | null;
  tax_id: string;
  status: string;
  created_at: string;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [seleccionada, setSeleccionada] = useState<Company | null>(null);
  const [alcance, setAlcance] = useState<string>("");
  const [error, setError] = useState<string>("");
  const [form, setForm] = useState({ tenant_id: "", legal_name: "", tax_id: "" });

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) {
      setCompanies(null);
      return;
    }
    api<Company[]>(session, "/v1/companies")
      .then(setCompanies)
      .catch((e: unknown) => setError(String((e as Error).message)));
  }, [session]);

  async function entrar(modo: "login" | "signup") {
    setError("");
    const r =
      modo === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    if (r.error) setError(r.error.message);
  }

  async function seleccionar(co: Company) {
    if (!session) return;
    setSeleccionada(co);
    setAlcance("comprobando…");
    try {
      // La misma lista, PERO con X-Company-Id: si el middleware de scope no
      // acepta la company, esto es un 404 — el contrato que la vertical ejerce.
      await api<Company[]>(session, "/v1/companies", { companyId: co.id });
      setAlcance(`X-Company-Id aceptado para ${co.legal_name}`);
    } catch (e) {
      setAlcance(e instanceof LlamadaApiError ? `${e.status} ${e.body.code}` : String(e));
    }
  }

  async function crear() {
    if (!session) return;
    setError("");
    try {
      await api<Company>(session, "/v1/companies", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(form),
      });
      setCompanies(await api<Company[]>(session, "/v1/companies"));
    } catch (e) {
      setError(
        e instanceof LlamadaApiError ? `${e.status} ${e.body.code}: ${e.body.message}` : String(e),
      );
    }
  }

  if (!session) {
    return (
      <main>
        <h1>Ladino — vertical delgada</h1>
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
      <h1>Ladino — vertical delgada</h1>
      <p>
        {session.user.email} · <button onClick={() => void supabase.auth.signOut()}>Salir</button>
      </p>

      <h2>Tus empresas (GET /v1/companies)</h2>
      {companies === null ? (
        <p>cargando…</p>
      ) : companies.length === 0 ? (
        <p>
          Ninguna. Un usuario nuevo no tiene memberships: siémbralo (README) y crea la primera
          empresa abajo.
        </p>
      ) : (
        <ul>
          {companies.map((co) => (
            <li key={co.id}>
              <button onClick={() => void seleccionar(co)}>
                {seleccionada?.id === co.id ? "▶ " : ""}
                {co.legal_name}
              </button>{" "}
              — {co.tax_id} · {co.status} · tenant {co.tenant_id.slice(0, 8)}…
            </li>
          ))}
        </ul>
      )}
      {alcance && <p>{alcance}</p>}

      <h2>Crear empresa (POST /v1/companies, con Idempotency-Key)</h2>
      <input
        placeholder="tenant_id (uuid)"
        value={form.tenant_id}
        onChange={(e) => setForm({ ...form, tenant_id: e.target.value })}
      />
      <input
        placeholder="razón social"
        value={form.legal_name}
        onChange={(e) => setForm({ ...form, legal_name: e.target.value })}
      />
      <input
        placeholder="RIF"
        value={form.tax_id}
        onChange={(e) => setForm({ ...form, tax_id: e.target.value })}
      />
      <button onClick={() => void crear()}>Crear</button>
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
