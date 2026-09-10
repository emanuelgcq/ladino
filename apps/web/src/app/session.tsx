import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Session } from "@supabase/supabase-js";
import { Building2, LogOut } from "lucide-react";
import { api, supabase, LlamadaApiError, type Company } from "../lib.js";
import { Button } from "../ui/button.js";
import { Input, Label } from "../ui/input.js";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "../ui/card.js";
import { LogoLadino } from "../components/LogoLadino.js";
import { Registro } from "../pages/registro/Registro.js";

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

  // El enlace de «recuperar contraseña» abre una sesión de RECUPERACIÓN:
  // antes de dejar pasar a la app se exige la contraseña nueva.
  const [recuperando, setRecuperando] = useState(false);

  useEffect(() => {
    void supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setCargando(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((ev, s) => {
      if (ev === "PASSWORD_RECOVERY") setRecuperando(true);
      setSession(s);
    });
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

  /**
   * EL TOKEN SE RENUEVA SOLO, Y ESO NO ES UN CAMBIO DE USUARIO.
   *
   * supabase-js corre `_recoverAndRefresh()` en cada vuelta a la pestaña y un
   * ticker mientras la pestaña tiene el foco: cuando el token entra en su
   * margen de expiración emite `TOKEN_REFRESHED` con un objeto de sesión NUEVO,
   * y lo mismo llega por BroadcastChannel si hay otra pestaña de Ladino
   * abierta. Con los efectos colgando de la IDENTIDAD de ese objeto, cada
   * renovación volvía a pedir las empresas y —peor— ponía los permisos a
   * `null`, que es la condición de «Cargando permisos…» A PANTALLA COMPLETA.
   * De ahí el «cambio de pestaña y me refresca la página».
   *
   * Los efectos cuelgan ahora del USUARIO y de la EMPRESA. El token vive en una
   * ref para que las llamadas usen siempre el último sin re-disparar nada.
   */
  const sesionRef = useRef<Session | null>(null);
  useEffect(() => {
    sesionRef.current = session;
  }, [session]);

  const userId = session?.user.id ?? null;
  const empresaId = empresa?.id ?? null;

  useEffect(() => {
    const s = sesionRef.current;
    if (s === null) {
      setCompanies(null);
      setEmpresaState(null);
      return;
    }
    void recargar(s);
  }, [userId, recargar]);

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
    const s = sesionRef.current;
    if (s === null || empresaId === null) {
      setPermisos(null);
      return;
    }
    let vigente = true;
    setPermisos(null);
    void api<{ permissions: string[] }>(s, "/v1/me/permissions", { companyId: empresaId })
      .then((r) => {
        if (vigente) setPermisos(new Set(r.permissions));
      })
      .catch(() => {
        if (vigente) setPermisos(new Set());
      });
    return () => {
      vigente = false;
    };
  }, [userId, empresaId]);

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
  if (recuperando) return <NuevaClave onLista={() => setRecuperando(false)} />;
  if (companies === null) return <PantallaCentrada>Cargando empresas…</PantallaCentrada>;
  // Sin ninguna empresa: EL REGISTRO PREMIUM (pantalla completa, como el
  // Login). El formulario chiquito del selector murió con él.
  if (companies.length === 0 && error === "") {
    return (
      <Registro
        token={session.access_token}
        correo={session.user.email ?? ""}
        onSalir={() => void supabase.auth.signOut()}
        onListo={() => void recargar(session)}
      />
    );
  }
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
    <div className="mb-8 flex flex-col items-center gap-3 text-center">
      <span className="relative">
        <LogoLadino alto="h-14" />
        {/* El halo: una sola nota de color sobre el lienzo monocromo. */}
        <span aria-hidden className="absolute -inset-8 -z-10 rounded-full bg-accent/12 blur-2xl" />
      </span>
      <p className="text-[0.82rem] text-muted-foreground">
        Administración y contabilidad para tu negocio
      </p>
    </div>
  );
}

/** Los errores de Supabase llegan en inglés; aquí se traducen a voz de persona. */
function vozDeAuth(mensaje: string): string {
  const m = mensaje.toLowerCase();
  if (m.includes("invalid login credentials")) return "Correo o contraseña incorrectos.";
  if (m.includes("email not confirmed"))
    return "Tu correo todavía no está verificado: busca el mensaje de Ladino en tu bandeja.";
  if (m.includes("user already registered")) return "Ese correo ya tiene cuenta: entra con él.";
  if (m.includes("rate limit") || m.includes("too many"))
    return "Demasiados intentos seguidos. Espera un minuto y prueba otra vez.";
  if (m.includes("password should be")) return "La contraseña necesita al menos 8 caracteres.";
  return mensaje;
}

function Login(): React.JSX.Element {
  const [modo, setModo] = useState<"entrar" | "crear" | "olvide">("entrar");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);
  /** Tras crear cuenta o pedir recuperación: la pantalla de «revisa tu correo». */
  const [correoEnviado, setCorreoEnviado] = useState<"verificacion" | "recuperacion" | null>(null);

  const cambiarModo = (m: "entrar" | "crear" | "olvide") => {
    setModo(m);
    setError("");
    setConfirmacion("");
  };

  async function enviar(): Promise<void> {
    setError("");
    if (modo === "crear") {
      if (password.length < 8) {
        setError("La contraseña necesita al menos 8 caracteres.");
        return;
      }
      if (password !== confirmacion) {
        setError("Las contraseñas no coinciden.");
        return;
      }
    }
    setOcupado(true);
    if (modo === "entrar") {
      const r = await supabase.auth.signInWithPassword({ email, password });
      if (r.error) setError(vozDeAuth(r.error.message));
    } else if (modo === "crear") {
      // Con la verificación de correo activa, signUp NO abre sesión: manda el
      // correo y aquí se enseña «revisa tu bandeja». (En local, sin
      // verificación, la sesión llega directa y el provider sigue solo.)
      const r = await supabase.auth.signUp({
        email,
        password,
        options: { emailRedirectTo: window.location.origin },
      });
      if (r.error) setError(vozDeAuth(r.error.message));
      else if (r.data.session === null) setCorreoEnviado("verificacion");
    } else {
      const r = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin,
      });
      if (r.error) setError(vozDeAuth(r.error.message));
      else setCorreoEnviado("recuperacion");
    }
    setOcupado(false);
  }

  if (correoEnviado !== null) {
    return (
      <PantallaAuth>
        <Card className="shadow-overlay">
          <CardContent className="px-6 pb-6 pt-6 text-center">
            <p className="text-[1.1rem] font-semibold">Revisa tu correo</p>
            <p className="mt-2 text-[0.92rem] text-muted-foreground">
              {correoEnviado === "verificacion"
                ? `Te mandamos un enlace a ${email} para verificar tu cuenta. Ábrelo y sigues aquí mismo.`
                : `Si ${email} tiene cuenta en Ladino, te llegará un enlace para crear una contraseña nueva.`}
            </p>
            <p className="mt-3 text-[0.82rem] text-faint-foreground">
              ¿No llega? Mira en el correo no deseado, o{" "}
              <button
                className="text-accent-soft-foreground hover:underline"
                onClick={() => {
                  setCorreoEnviado(null);
                  cambiarModo(correoEnviado === "verificacion" ? "crear" : "olvide");
                }}
              >
                vuelve a intentarlo
              </button>
              .
            </p>
          </CardContent>
        </Card>
      </PantallaAuth>
    );
  }

  return (
    <PantallaAuth>
      <Card className="shadow-overlay">
        <CardContent className="px-6 pb-6 pt-6">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void enviar();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="login-email">Correo</Label>
              <Input
                id="login-email"
                type="email"
                autoComplete="email"
                placeholder="tu@correo.com"
                className="h-10 px-3 text-[0.95rem]"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
            </div>
            {modo !== "olvide" && (
              <div className="space-y-1.5">
                <Label htmlFor="login-password">Contraseña</Label>
                <Input
                  id="login-password"
                  type="password"
                  autoComplete={modo === "crear" ? "new-password" : "current-password"}
                  placeholder="••••••••"
                  className="h-10 px-3 text-[0.95rem]"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={modo === "crear" ? 8 : undefined}
                />
              </div>
            )}
            {modo === "crear" && (
              <div className="space-y-1.5">
                <Label htmlFor="login-confirmacion">Confirma la contraseña</Label>
                <Input
                  id="login-confirmacion"
                  type="password"
                  autoComplete="new-password"
                  placeholder="••••••••"
                  className="h-10 px-3 text-[0.95rem]"
                  value={confirmacion}
                  onChange={(e) => setConfirmacion(e.target.value)}
                  required
                />
                {confirmacion !== "" && confirmacion !== password && (
                  <p className="text-[0.8rem] text-warning-soft-foreground">
                    Todavía no coinciden.
                  </p>
                )}
              </div>
            )}
            {error && (
              <p
                role="alert"
                className="rounded-md bg-destructive-soft px-3 py-2 text-[0.85rem] text-destructive-soft-foreground"
              >
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={ocupado}
              className="h-10 w-full"
            >
              {ocupado
                ? "Un momento…"
                : modo === "entrar"
                  ? "Entrar"
                  : modo === "crear"
                    ? "Crear mi cuenta"
                    : "Mandarme el enlace"}
            </Button>
          </form>
          {modo === "entrar" && (
            <p className="mt-2 text-center">
              <button
                className="text-[0.82rem] text-faint-foreground hover:text-foreground"
                onClick={() => cambiarModo("olvide")}
              >
                ¿Olvidaste tu contraseña?
              </button>
            </p>
          )}
          <div className="mt-4 border-t border-border pt-4 text-center text-[0.85rem] text-muted-foreground">
            {modo === "entrar" ? (
              <>
                ¿Primera vez?{" "}
                <button
                  className="font-medium text-accent-soft-foreground hover:underline"
                  onClick={() => cambiarModo("crear")}
                >
                  Crea tu cuenta
                </button>
              </>
            ) : (
              <>
                ¿Ya tienes cuenta?{" "}
                <button
                  className="font-medium text-accent-soft-foreground hover:underline"
                  onClick={() => cambiarModo("entrar")}
                >
                  Entra aquí
                </button>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </PantallaAuth>
  );
}

/** El lienzo compartido de las pantallas de autenticación. */
function PantallaAuth({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:44px_44px] opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,black,transparent)] dark:opacity-25"
      />
      <div className="relative w-full max-w-sm">
        <Marca />
        {children}
        <p className="mt-6 text-center text-[0.78rem] text-faint-foreground">
          Hecho para el comercio venezolano — factura, recibo y contabilidad en un solo lugar.
        </p>
      </div>
    </div>
  );
}

/**
 * El enlace de «recuperar contraseña» abre sesión de RECUPERACIÓN: antes de
 * dejar pasar a la app, aquí se fija la contraseña nueva (con confirmación).
 */
function NuevaClave({ onLista }: { onLista: () => void }): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [confirmacion, setConfirmacion] = useState("");
  const [error, setError] = useState("");
  const [ocupado, setOcupado] = useState(false);

  async function guardar(): Promise<void> {
    setError("");
    if (password.length < 8) {
      setError("La contraseña necesita al menos 8 caracteres.");
      return;
    }
    if (password !== confirmacion) {
      setError("Las contraseñas no coinciden.");
      return;
    }
    setOcupado(true);
    const r = await supabase.auth.updateUser({ password });
    setOcupado(false);
    if (r.error) setError(vozDeAuth(r.error.message));
    else onLista();
  }

  return (
    <PantallaAuth>
      <Card className="shadow-overlay">
        <CardContent className="px-6 pb-6 pt-6">
          <p className="text-center text-[1.1rem] font-semibold">Crea tu contraseña nueva</p>
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              void guardar();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="nueva-clave">Contraseña nueva</Label>
              <Input
                id="nueva-clave"
                type="password"
                autoComplete="new-password"
                className="h-10 px-3 text-[0.95rem]"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="nueva-confirmacion">Confírmala</Label>
              <Input
                id="nueva-confirmacion"
                type="password"
                autoComplete="new-password"
                className="h-10 px-3 text-[0.95rem]"
                value={confirmacion}
                onChange={(e) => setConfirmacion(e.target.value)}
                required
              />
            </div>
            {error && (
              <p
                role="alert"
                className="rounded-md bg-destructive-soft px-3 py-2 text-[0.85rem] text-destructive-soft-foreground"
              >
                {error}
              </p>
            )}
            <Button
              type="submit"
              variant="primary"
              size="lg"
              disabled={ocupado}
              className="h-10 w-full"
            >
              {ocupado ? "Guardando…" : "Guardar y entrar"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </PantallaAuth>
  );
}

function SelectorEmpresa({
  companies,
  error,
  onElegir,
  onRecargar,
}: {
  companies: Company[];
  error: string;
  onElegir: (c: Company) => void;
  onRecargar: () => void;
}): React.JSX.Element {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-4">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] bg-[size:44px_44px] opacity-40 [mask-image:radial-gradient(ellipse_60%_50%_at_50%_40%,black,transparent)] dark:opacity-25"
      />
      <div className="relative w-full max-w-md">
        <Marca />
        <Card className="shadow-overlay">
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
              <div className="space-y-2">
                <p role="alert" className="text-[0.85rem] text-destructive-soft-foreground">
                  {error}
                </p>
                <Button variant="secondary" size="sm" onClick={onRecargar}>
                  Reintentar
                </Button>
              </div>
            )}
            {companies.length === 0 ? (
              <CardDescription>
                No se pudieron cargar tus empresas. Revisa tu conexión y reintenta.
              </CardDescription>
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
