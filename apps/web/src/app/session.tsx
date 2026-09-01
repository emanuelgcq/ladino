import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { Building2, LogOut } from "lucide-react";
import { api, supabase, LlamadaApiError, type Company } from "../lib.js";
import { Button } from "../ui/button.js";
import { Input, Label } from "../ui/input.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";

/**
 * Sesión y empresa activa, para todo el árbol.
 *
 * supabase-js SOLO para autenticación (signup, login, refresh): los datos van
 * SIEMPRE por la API con Bearer + X-Company-Id. La empresa elegida se persiste
 * POR USUARIO — dos contadores en la misma máquina no comparten esa elección.
 */
export interface Sesion {
  readonly session: Session;
  readonly companies: Company[];
  readonly empresa: Company;
  readonly setEmpresa: (c: Company) => void;
  /** GET/POST autenticado contra la API, con la empresa activa puesta. */
  readonly llamar: <T>(path: string, init?: RequestInit) => Promise<T>;
}

const Ctx = createContext<Sesion | null>(null);

export function useSesion(): Sesion {
  const v = useContext(Ctx);
  if (v === null) throw new Error("useSesion fuera de <SessionProvider>");
  return v;
}

function mensajeDe(e: unknown): string {
  return e instanceof LlamadaApiError ? `${e.body.code}: ${e.body.message}` : String(e);
}

const claveEmpresa = (userId: string) => `ladino.company.${userId}`;

export function SessionProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [session, setSession] = useState<Session | null>(null);
  const [cargando, setCargando] = useState(true);
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [empresa, setEmpresaState] = useState<Company | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCargando(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_ev, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  const recargar = useCallback(async (s: Session) => {
    setError("");
    try {
      const cs = await api<Company[]>(s, "/v1/companies");
      setCompanies(cs);
      // Restaurar la última empresa elegida por ESTE usuario, si sigue visible.
      const guardada = localStorage.getItem(claveEmpresa(s.user.id));
      const previa = cs.find((c) => c.id === guardada);
      if (previa) setEmpresaState(previa);
      else if (cs.length === 1) setEmpresaState(cs[0] ?? null);
    } catch (e) {
      setCompanies([]);
      setError(mensajeDe(e));
    }
  }, []);

  useEffect(() => {
    if (!session) {
      setCompanies(null);
      setEmpresaState(null);
      return;
    }
    void recargar(session);
  }, [session, recargar]);

  const setEmpresa = useCallback(
    (c: Company) => {
      setEmpresaState(c);
      if (session) localStorage.setItem(claveEmpresa(session.user.id), c.id);
    },
    [session],
  );

  const llamar = useCallback(
    <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      if (!session || !empresa) return Promise.reject(new Error("sin sesión o empresa"));
      return api<T>(session, path, { ...init, companyId: empresa.id });
    },
    [session, empresa],
  );

  const valor = useMemo<Sesion | null>(
    () =>
      session && empresa && companies ? { session, companies, empresa, setEmpresa, llamar } : null,
    [session, empresa, companies, setEmpresa, llamar],
  );

  if (cargando) return <PantallaCentrada>Cargando…</PantallaCentrada>;
  if (!session) return <Login />;
  if (companies === null) return <PantallaCentrada>Cargando empresas…</PantallaCentrada>;
  if (valor === null) {
    return (
      <SelectorEmpresa
        companies={companies}
        error={error}
        onElegir={setEmpresa}
        onRecargar={() => void recargar(session)}
        session={session}
      />
    );
  }
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}

function PantallaCentrada({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-muted-foreground">
      {children}
    </div>
  );
}

function Marca(): React.JSX.Element {
  return (
    <div className="mb-6 flex items-center gap-2">
      <span className="flex size-8 items-center justify-center rounded-md bg-accent font-semibold text-accent-foreground">
        L
      </span>
      <div>
        <p className="text-[1.05rem] font-semibold leading-tight">Ladino</p>
        <p className="text-[0.78rem] text-muted-foreground">Administración y contabilidad</p>
      </div>
    </div>
  );
}

function Login(): React.JSX.Element {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function entrar(modo: "login" | "signup") {
    setError("");
    setOcupado(true);
    const r =
      modo === "login"
        ? await supabase.auth.signInWithPassword({ email, password })
        : await supabase.auth.signUp({ email, password });
    setOcupado(false);
    if (r.error) setError(r.error.message);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-sm">
        <Marca />
        <Card>
          <CardHeader>
            <CardTitle>Entrar</CardTitle>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                void entrar("login");
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="login-email">Correo</Label>
                <Input
                  id="login-email"
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="login-password">Contraseña</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error && (
                <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                  {error}
                </p>
              )}
              <div className="flex gap-2 pt-1">
                <Button type="submit" variant="primary" disabled={ocupado} className="flex-1">
                  Entrar
                </Button>
                <Button
                  variant="secondary"
                  disabled={ocupado}
                  onClick={() => void entrar("signup")}
                >
                  Crear cuenta
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SelectorEmpresa({
  companies,
  error,
  onElegir,
  onRecargar,
  session,
}: {
  companies: Company[];
  error: string;
  onElegir: (c: Company) => void;
  onRecargar: () => void;
  session: Session;
}): React.JSX.Element {
  const [alta, setAlta] = useState({ tenant_id: "", legal_name: "", tax_id: "" });
  const [altaError, setAltaError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function crear() {
    setAltaError("");
    setOcupado(true);
    try {
      await api(session, "/v1/companies", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(alta),
      });
      onRecargar();
    } catch (e) {
      setAltaError(mensajeDe(e));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <div className="w-full max-w-md">
        <Marca />
        <Card>
          <CardHeader>
            <CardTitle>Elige la empresa</CardTitle>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void supabase.auth.signOut()}
              aria-label="Salir"
            >
              <LogOut /> Salir
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {error && (
              <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                {error}
              </p>
            )}
            {companies.length === 0 ? (
              <div className="space-y-3">
                <CardDescription>
                  No tienes empresas visibles. Crea la primera (necesitas el tenant y
                  company.manage).
                </CardDescription>
                <div className="space-y-2">
                  <Input
                    placeholder="tenant_id (uuid)"
                    value={alta.tenant_id}
                    onChange={(e) => setAlta({ ...alta, tenant_id: e.target.value })}
                  />
                  <Input
                    placeholder="Razón social"
                    value={alta.legal_name}
                    onChange={(e) => setAlta({ ...alta, legal_name: e.target.value })}
                  />
                  <Input
                    placeholder="RIF"
                    value={alta.tax_id}
                    onChange={(e) => setAlta({ ...alta, tax_id: e.target.value })}
                  />
                  {altaError && (
                    <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                      {altaError}
                    </p>
                  )}
                  <Button variant="primary" disabled={ocupado} onClick={() => void crear()}>
                    Crear empresa
                  </Button>
                </div>
              </div>
            ) : (
              companies.map((c) => (
                <button
                  key={c.id}
                  onClick={() => onElegir(c)}
                  className="flex w-full items-center gap-3 rounded-md border border-border bg-surface px-3 py-2 text-left transition-colors hover:border-accent hover:bg-accent-soft/40"
                >
                  <Building2 className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.legal_name}</span>
                    <span className="block text-[0.8rem] text-muted-foreground">{c.tax_id}</span>
                  </span>
                </button>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
