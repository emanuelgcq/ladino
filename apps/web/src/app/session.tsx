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
  /**
   * ADR-0048: ¿tiene el usuario este permiso en la empresa activa? Con un
   * array, basta CUALQUIERA (any-of). Es la lista que el servidor resolvió
   * con el MISMO mecanismo que autoriza cada operación: aquí solo decide qué
   * se enseña — esconder es cortesía, el control vive en la API.
   */
  readonly puede: (permiso: string | readonly string[]) => boolean;
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
  const [permisos, setPermisos] = useState<ReadonlySet<string> | null>(null);
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

  // Los permisos del usuario EN la empresa activa (ADR-0048): una llamada por
  // elección de empresa; el menú entero se forma con esta lista. Si la
  // llamada falla, el conjunto queda VACÍO — fallo cerrado: no se enseña lo
  // que no se pudo confirmar (el servidor rechazaría igual).
  useEffect(() => {
    if (!session || !empresa) {
      setPermisos(null);
      return;
    }
    let vigente = true;
    setPermisos(null);
    void api<{ permissions: string[] }>(session, "/v1/me/permissions", { companyId: empresa.id })
      .then((r) => {
        if (vigente) setPermisos(new Set(r.permissions));
      })
      .catch(() => {
        if (vigente) setPermisos(new Set());
      });
    return () => {
      vigente = false;
    };
  }, [session, empresa]);

  const puede = useCallback(
    (permiso: string | readonly string[]): boolean => {
      if (permisos === null) return false;
      const lista = typeof permiso === "string" ? [permiso] : permiso;
      return lista.some((p) => permisos.has(p));
    },
    [permisos],
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
      session && empresa && companies && permisos !== null
        ? { session, companies, empresa, setEmpresa, llamar, puede }
        : null,
    [session, empresa, companies, permisos, setEmpresa, llamar, puede],
  );

  if (cargando) return <PantallaCentrada>Cargando…</PantallaCentrada>;
  if (!session) return <Login />;
  if (companies === null) return <PantallaCentrada>Cargando empresas…</PantallaCentrada>;
  if (empresa !== null && permisos === null) {
    return <PantallaCentrada>Cargando permisos…</PantallaCentrada>;
  }
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
  const [alta, setAlta] = useState({ business_name: "", tax_id: "" });
  const [altaError, setAltaError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  // ADR-0049: FUNDAR el negocio en un acto — tenant, empresa, depósito,
  // roles del fundador y plan contable. Un reintento tras un éxito responde
  // DUPLICATE y recargar la sesión enseña la empresa igual: por eso el catch
  // también recarga.
  async function fundar() {
    setAltaError("");
    setOcupado(true);
    try {
      await api(session, "/v1/onboarding", {
        method: "POST",
        body: JSON.stringify({
          business_name: alta.business_name.trim(),
          ...(alta.tax_id.trim() === "" ? {} : { tax_id: alta.tax_id.trim() }),
        }),
      });
      onRecargar();
    } catch (e) {
      setAltaError(mensajeDe(e));
      onRecargar();
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
                  Bienvenido. Ponle nombre a tu negocio y en un minuto tienes todo listo: tu
                  depósito, tus listas de precios y tu contabilidad armada. El RIF puede esperar —
                  puedes vender con recibos desde hoy y activar la facturación cuando lo tengas.
                </CardDescription>
                <div className="space-y-2">
                  <Label htmlFor="fundar-nombre">¿Cómo se llama tu negocio?</Label>
                  <Input
                    id="fundar-nombre"
                    placeholder="Bodega La Esquina"
                    value={alta.business_name}
                    autoFocus
                    onChange={(e) => setAlta({ ...alta, business_name: e.target.value })}
                  />
                  <Label htmlFor="fundar-rif">RIF (si ya lo tienes)</Label>
                  <Input
                    id="fundar-rif"
                    placeholder="J-12345678-9 — opcional"
                    value={alta.tax_id}
                    onChange={(e) => setAlta({ ...alta, tax_id: e.target.value })}
                  />
                  {altaError && (
                    <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                      {altaError}
                    </p>
                  )}
                  <Button
                    variant="primary"
                    className="w-full"
                    disabled={ocupado || alta.business_name.trim().length < 2}
                    onClick={() => void fundar()}
                  >
                    {ocupado ? "Fundando…" : "Fundar mi negocio"}
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
