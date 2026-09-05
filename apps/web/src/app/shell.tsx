import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, NavLink, Outlet, useLocation } from "react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Building2,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  LogOut,
  Moon,
  Search,
  Sun,
} from "lucide-react";
import { supabase } from "../lib.js";
import { cn } from "../ui/cn.js";
import { Button } from "../ui/button.js";
import { Tooltip } from "../ui/tooltip.js";
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "../ui/menu.js";
import { useSesion } from "./session.js";
import { NAV_NEGOCIO, NAV_ADMIN, NAV_EMPEZAR, CRUMBS, rutaInicial, type NavItem } from "./nav.js";
import { CommandPalette } from "./palette.js";
import { esOscuroAhora, setTema, temaActual } from "../theme.js";

/**
 * El shell de los DOS MUNDOS (Fase C): arriba, sin nombre, las pantallas de
 * la persona — objetivos táctiles grandes, siete entradas y ya. Debajo,
 * plegado, «ADMINISTRACIÓN»: la Fase B intacta bajo /admin/*, visible solo
 * para quien tiene permisos técnicos (la visibilidad es cortesía; el permiso
 * real lo exige el servidor en cada endpoint).
 */

const CLAVE_SIDEBAR = "ladino.sidebar";
const CLAVE_TODOS = "ladino.modulos.todos";
const CLAVE_ADMIN_ABIERTO = "ladino.admin.abierto";

export function mostrarTodosLosModulos(): boolean {
  try {
    return localStorage.getItem(CLAVE_TODOS) === "1";
  } catch {
    return false;
  }
}
export function setMostrarTodos(v: boolean): void {
  try {
    localStorage.setItem(CLAVE_TODOS, v ? "1" : "0");
  } catch {
    /* sin persistencia */
  }
}

/**
 * Divulgación progresiva con DATOS, no con un flag: un módulo avanzado aparece
 * si la empresa tiene filas o configuración en él.
 */
export function useModulosActivos(): { compras: boolean; contabilidad: boolean; libros: boolean } {
  const { empresa, llamar } = useSesion();
  const q = useQuery({
    queryKey: ["modulos-activos", empresa.id],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const [proveedores, cuentas, generaciones] = await Promise.all([
        llamar<{ total: number }>("/v1/suppliers?per_page=1").catch(() => ({ total: 0 })),
        llamar<unknown[]>("/v1/accounts").catch(() => []),
        llamar<{ runs: unknown[] }>("/v1/fiscal-books/runs").catch(() => ({ runs: [] })),
      ]);
      const contabilidad = cuentas.length > 0;
      return {
        compras: proveedores.total > 0,
        contabilidad,
        libros: contabilidad || generaciones.runs.length > 0,
      };
    },
  });
  return q.data ?? { compras: false, contabilidad: false, libros: false };
}

/**
 * ¿Este usuario ve el mundo de ADMINISTRACIÓN? Se sondea con dos permisos
 * técnicos reales (contable y fiscal): si el servidor deja pasar cualquiera,
 * el grupo aparece. Sin endpoint de «mis permisos», la sonda ES la verdad.
 */
/* useMundoAdmin fue reemplazado en ADR-0048: antes sondeaba endpoints para
 * adivinar si había mundo técnico; ahora la respuesta es directa — el grupo
 * de administración existe si el ROL abre al menos una de sus entradas. */

/** ¿Falta la puesta a punto? Sin cuentas de dinero, el negocio no ha empezado. */
function useEmpezarPendiente(): boolean {
  const { empresa, llamar } = useSesion();
  const q = useQuery({
    queryKey: ["empezar-pendiente", empresa.id],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await llamar<{ accounts: unknown[] }>("/v1/treasury/accounts").catch(() => null);
      if (r === null) return false; // sin permiso de dinero no se le ofrece el asistente
      return r.accounts.length === 0;
    },
  });
  return q.data ?? false;
}

export function AppShell(): React.JSX.Element {
  const [colapsada, setColapsada] = useState(() => localStorage.getItem(CLAVE_SIDEBAR) === "1");
  const [paleta, setPaleta] = useState(false);
  const [adminAbierto, setAdminAbierto] = useState(
    () => localStorage.getItem(CLAVE_ADMIN_ABIERTO) === "1",
  );
  const activos = useModulosActivos();
  const { puede } = useSesion();
  const empezar = useEmpezarPendiente();
  const [todos, setTodos] = useState(mostrarTodosLosModulos);
  const location = useLocation();
  const enAdmin = location.pathname.startsWith("/admin");

  useEffect(() => setTodos(mostrarTodosLosModulos()), [location.pathname]);
  useEffect(() => {
    localStorage.setItem(CLAVE_SIDEBAR, colapsada ? "1" : "0");
  }, [colapsada]);
  useEffect(() => {
    localStorage.setItem(CLAVE_ADMIN_ABIERTO, adminAbierto ? "1" : "0");
  }, [adminAbierto]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaleta((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const visible = (item: NavItem): boolean => {
    if (item.devOnly && !import.meta.env.DEV) return false;
    // ADR-0048: primero el ROL — sin el permiso, la entrada no existe para
    // este usuario. El toggle de módulos avanzados filtra DESPUÉS: activa
    // módulos de la empresa, no abre puertas que el rol cierra.
    if (item.permiso !== undefined && !puede(item.permiso)) return false;
    if (item.advanced === undefined) return true;
    return todos || activos[item.advanced];
  };

  // El mundo técnico existe si el rol abre al menos una de sus entradas.
  const admin = NAV_ADMIN.some((g) => g.items.some(visible));

  // Dentro de /admin el grupo se muestra abierto aunque estuviera plegado:
  // plegarte el menú de donde estás parado sería esconderte el piso.
  const adminVisible = adminAbierto || enAdmin;

  // La GUARDIA de ruta: si la URL apunta a una entrada que el rol no abre,
  // se aterriza en la ruta inicial del rol. Cortesía coherente con el menú;
  // el servidor rechazaría igual las operaciones de esa pantalla.
  const todasLasEntradas: NavItem[] = [
    NAV_EMPEZAR,
    ...NAV_NEGOCIO,
    ...NAV_ADMIN.flatMap((g) => g.items),
  ];
  const entradaActual = todasLasEntradas.find(
    (i) => location.pathname === i.to || location.pathname.startsWith(`${i.to}/`),
  );
  const sinAcceso =
    (entradaActual !== undefined &&
      entradaActual.permiso !== undefined &&
      !puede(entradaActual.permiso)) ||
    // El Dashboard (/admin, sin entrada propia) es dinero agregado: reportes.
    (location.pathname === "/admin" && !puede("report.export"));
  if (sinAcceso) return <Navigate to={rutaInicial(puede)} replace />;

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className={cn(
          "sticky top-0 flex h-screen shrink-0 flex-col border-r border-border bg-surface",
          "transition-[width] duration-200",
          colapsada ? "w-14" : "w-64",
        )}
      >
        <div
          className={cn("flex items-center gap-2 px-3 py-3", colapsada && "justify-center px-0")}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-[0.9rem] font-semibold text-accent-foreground">
            L
          </span>
          {!colapsada && <span className="truncate font-semibold">Ladino</span>}
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2" aria-label="Navegación principal">
          {/* El grupo SIN nombre: la app. Objetivos táctiles de 44 px. */}
          <div className="mb-1 space-y-0.5">
            {(empezar ? [NAV_EMPEZAR, ...NAV_NEGOCIO] : NAV_NEGOCIO).filter(visible).map((item) => (
              <ItemNav key={item.to} item={item} colapsada={colapsada} grande />
            ))}
          </div>

          {admin && (
            <div className="mt-3 border-t border-border pt-2">
              {!colapsada ? (
                <button
                  className="flex w-full items-center gap-1 px-2 pb-1 pt-1 text-[0.72rem] font-medium uppercase tracking-wider text-faint-foreground hover:text-muted-foreground"
                  onClick={() => setAdminAbierto((v) => !v)}
                  aria-expanded={adminVisible}
                >
                  {adminVisible ? (
                    <ChevronDown className="size-3.5" />
                  ) : (
                    <ChevronRight className="size-3.5" />
                  )}
                  Administración
                </button>
              ) : (
                <div className="my-1 h-px bg-border" />
              )}
              {adminVisible &&
                NAV_ADMIN.map((grupo) => {
                  const items = grupo.items.filter(visible);
                  if (items.length === 0) return null;
                  return (
                    <div key={grupo.label ?? "raiz"} className="mb-1">
                      {grupo.label !== null && !colapsada && (
                        <p className="px-2 pb-0.5 pt-2 text-[0.7rem] font-medium uppercase tracking-wider text-faint-foreground/80">
                          {grupo.label}
                        </p>
                      )}
                      {items.map((item) => (
                        <ItemNav key={item.to} item={item} colapsada={colapsada} />
                      ))}
                    </div>
                  );
                })}
            </div>
          )}
        </nav>
        <div className="border-t border-border p-2">
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-center"
            onClick={() => setColapsada((v) => !v)}
            aria-label={colapsada ? "Expandir menú" : "Colapsar menú"}
          >
            {colapsada ? <ChevronsRight /> : <ChevronsLeft />}
            {!colapsada && "Colapsar"}
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar onBuscar={() => setPaleta(true)} />
        {enAdmin && <Migas />}
        <main className="mx-auto w-full max-w-7xl flex-1 px-4 pb-10 pt-4 md:px-6">
          <Outlet />
        </main>
      </div>

      <CommandPalette open={paleta} onOpenChange={setPaleta} />
    </div>
  );
}

function ItemNav({
  item,
  colapsada,
  grande = false,
}: {
  item: NavItem;
  colapsada: boolean;
  grande?: boolean;
}): React.JSX.Element {
  const Icono = item.icon;
  const enlace = (
    <NavLink
      to={item.to}
      className={({ isActive }) =>
        cn(
          "flex items-center gap-2.5 rounded-md px-2 transition-colors",
          grande ? "min-h-11 py-2 text-[0.95rem]" : "py-1.5 text-[0.9rem]",
          colapsada && "justify-center px-0",
          isActive
            ? "bg-accent-soft font-medium text-accent-soft-foreground"
            : "text-muted-foreground hover:bg-surface-muted hover:text-foreground",
        )
      }
    >
      <Icono className={cn("shrink-0", grande ? "size-4.5" : "size-4")} />
      {!colapsada && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
  return colapsada ? (
    <Tooltip content={item.label} side="right">
      {enlace}
    </Tooltip>
  ) : (
    enlace
  );
}

function TopBar({ onBuscar }: { onBuscar: () => void }): React.JSX.Element {
  const { session, empresa } = useSesion();
  return (
    <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-border bg-surface/95 px-4 backdrop-blur">
      <CompanySwitcher />
      <div className="flex-1" />
      <Button
        variant="secondary"
        size="sm"
        onClick={onBuscar}
        className="w-56 justify-start text-muted-foreground max-md:w-auto"
      >
        <Search />
        <span className="max-md:hidden">Buscar o ir a…</span>
        <kbd className="ml-auto rounded border border-border bg-surface-muted px-1 text-[0.7rem] max-md:hidden">
          Ctrl K
        </kbd>
      </Button>
      <ThemeToggle />
      <Menu>
        <MenuTrigger
          className="flex size-7 items-center justify-center rounded-full bg-surface-muted text-[0.8rem] font-medium uppercase text-muted-foreground hover:bg-border"
          aria-label="Menú de usuario"
        >
          {(session.user.email ?? "?").slice(0, 1)}
        </MenuTrigger>
        <MenuContent>
          <div className="px-2.5 py-1.5">
            <p className="truncate text-[0.85rem] font-medium">{session.user.email}</p>
            <p className="truncate text-[0.78rem] text-muted-foreground">{empresa.legal_name}</p>
          </div>
          <MenuSeparator />
          <MenuItem onClick={() => void supabase.auth.signOut()}>
            <LogOut /> Salir
          </MenuItem>
        </MenuContent>
      </Menu>
    </header>
  );
}

function CompanySwitcher(): React.JSX.Element {
  const { companies, empresa, setEmpresa } = useSesion();
  const [filtro, setFiltro] = useState("");
  const visibles = useMemo(
    () =>
      filtro.trim() === ""
        ? companies
        : companies.filter((c) =>
            `${c.legal_name} ${c.tax_id}`.toLowerCase().includes(filtro.trim().toLowerCase()),
          ),
    [companies, filtro],
  );
  return (
    <Menu>
      <MenuTrigger
        aria-label="Cambiar de empresa"
        className="flex max-w-64 items-center gap-2 rounded-sm px-2 py-1 text-[0.9rem] font-medium hover:bg-surface-muted"
      >
        <Building2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="truncate">{empresa.legal_name}</span>
      </MenuTrigger>
      <MenuContent align="start" className="w-72">
        {companies.length > 5 && (
          <div className="px-2 pb-1.5 pt-1">
            <input
              className="h-7 w-full rounded-sm border border-border bg-surface px-2 text-[0.85rem] outline-none focus:border-accent"
              placeholder="Buscar empresa…"
              value={filtro}
              onChange={(e) => setFiltro(e.target.value)}
            />
          </div>
        )}
        {visibles.map((c) => (
          <MenuItem key={c.id} onClick={() => setEmpresa(c)}>
            <span className="min-w-0 flex-1">
              <span className="block truncate">{c.legal_name}</span>
              <span className="block truncate text-[0.78rem] text-muted-foreground">
                {c.tax_id}
              </span>
            </span>
            {c.id === empresa.id && <Check className="size-4 text-accent" />}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

function ThemeToggle(): React.JSX.Element {
  const [oscuro, setOscuro] = useState(esOscuroAhora);
  return (
    <Button
      variant="ghost"
      size="iconSm"
      aria-label={oscuro ? "Cambiar a tema claro" : "Cambiar a tema oscuro"}
      onClick={() => {
        const siguiente = esOscuroAhora() ? "light" : "dark";
        setTema(siguiente);
        setOscuro(siguiente === "dark");
      }}
      title={`Tema: ${temaActual() === "system" ? "según el sistema" : temaActual()}`}
    >
      {oscuro ? <Sun /> : <Moon />}
    </Button>
  );
}

/** Migas SOLO en /admin: el mundo de la persona no necesita ruta de regreso. */
function Migas(): React.JSX.Element {
  const { pathname } = useLocation();
  const partes = pathname.split("/").filter(Boolean);
  const etiqueta = (r: string, seg: string | undefined): string =>
    CRUMBS[r] ?? (seg !== undefined && /^[0-9a-f-]{20,}$/i.test(seg) ? "Detalle" : (seg ?? ""));
  const rutas = partes.map((_, i) => "/" + partes.slice(0, i + 1).join("/"));
  return (
    <div className="flex h-8 items-center gap-1 border-b border-border bg-background px-4 text-[0.82rem] text-muted-foreground md:px-6">
      <Link to="/inicio" className="hover:text-foreground">
        Inicio
      </Link>
      {rutas.map((r, i) => (
        <span key={r} className="flex items-center gap-1">
          <ChevronRight className="size-3.5 text-faint-foreground" />
          {i === rutas.length - 1 ? (
            <span className="font-medium text-foreground">{etiqueta(r, partes[i])}</span>
          ) : (
            <Link to={r} className="hover:text-foreground">
              {etiqueta(r, partes[i])}
            </Link>
          )}
        </span>
      ))}
    </div>
  );
}
